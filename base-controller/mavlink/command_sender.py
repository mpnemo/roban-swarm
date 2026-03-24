"""MAVLink command sender — per-heli UDP connections for outbound commands.

Separate from HubClient (which is read-only on TCP 5760). Each heli gets
its own UDP connection to mavlink-hub's per-heli endpoint, ensuring commands
are routed to the correct vehicle only.
"""

import logging
from pymavlink import mavutil

log = logging.getLogger("roban.command")

# ArduCopter flight mode IDs
MODE_STABILIZE = 0
MODE_GUIDED = 4
MODE_LOITER = 5
MODE_RTL = 6
MODE_BRAKE = 17
MODE_POSHOLD = 16

# SET_POSITION_TARGET_LOCAL_NED type_mask:
#   bit 0-2: ignore x/y/z position (0 = use)
#   bit 3-5: ignore vx/vy/vz velocity (0 = use)
#   bit 6-8: ignore ax/ay/az accel (1 = ignore)
#   bit 9:   force set (0)
#   bit 10:  ignore yaw (1 = ignore)
#   bit 11:  ignore yaw_rate (1 = ignore)
# We use position + velocity, ignore accel + yaw:
TYPE_MASK_POS_VEL = (
    0b0000_1101_1100_0000  # = 0x0DC0
)


class CommandSender:
    """Manages per-heli outbound MAVLink connections via UDP.

    Each heli's mavlink-hub endpoint is at UDP port 14559 + heli_id.
    Connections are lazy-created and reused for the session lifetime.
    """

    def __init__(self, source_system: int = 250, source_component: int = 190):
        self._source_system = source_system
        self._source_component = source_component
        self._connections: dict[int, mavutil.mavlink_connection] = {}

    def _get_conn(self, heli_id: int):
        """Get or create a UDP connection for a heli."""
        if heli_id not in self._connections:
            port = 14559 + heli_id
            conn = mavutil.mavlink_connection(
                f"udpout:127.0.0.1:{port}",
                source_system=self._source_system,
                source_component=self._source_component,
            )
            self._connections[heli_id] = conn
            log.info("Created UDP connection for Heli%02d → 127.0.0.1:%d",
                     heli_id, port)
        return self._connections[heli_id]

    def send_position_target(self, heli_id: int,
                              pos_n: float, pos_e: float, pos_d: float,
                              vel_n: float = 0, vel_e: float = 0,
                              vel_d: float = 0):
        """Send SET_POSITION_TARGET_LOCAL_NED to a heli.

        Position and velocity in NED frame. Acceleration and yaw are ignored
        (ArduPilot auto-faces direction of travel).
        """
        conn = self._get_conn(heli_id)
        target_system = 10 + heli_id
        conn.mav.set_position_target_local_ned_send(
            0,                                  # time_boot_ms (0 = autopilot time)
            target_system, 1,                   # target system, component
            mavutil.mavlink.MAV_FRAME_LOCAL_NED,
            TYPE_MASK_POS_VEL,
            pos_n, pos_e, pos_d,                # position (m)
            vel_n, vel_e, vel_d,                # velocity (m/s)
            0, 0, 0,                            # acceleration (ignored)
            0, 0,                               # yaw, yaw_rate (ignored)
        )

    def send_set_mode(self, heli_id: int, mode_id: int):
        """Send SET_MODE to switch flight mode (e.g., GUIDED=4, BRAKE=17)."""
        conn = self._get_conn(heli_id)
        target_system = 10 + heli_id
        conn.mav.set_mode_send(
            target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode_id,
        )
        log.info("Sent SET_MODE %d to Heli%02d", mode_id, heli_id)

    def send_arm(self, heli_id: int, arm: bool = True):
        """Send ARM/DISARM command."""
        conn = self._get_conn(heli_id)
        target_system = 10 + heli_id
        conn.mav.command_long_send(
            target_system, 1,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0,              # confirmation
            1 if arm else 0,  # param1: 1=arm, 0=disarm
            0, 0, 0, 0, 0, 0,
        )
        log.info("Sent %s to Heli%02d", "ARM" if arm else "DISARM", heli_id)

    def set_hub_client(self, hub_client):
        """Register the HubClient so we can use its TCP connection for param ops."""
        self._hub_client = hub_client

    def read_param(self, heli_id: int, param_name: str,
                   timeout: float = 3.0) -> float | None:
        """Read a single parameter from a heli's FC. Blocking — use in executor.

        Uses the HubClient's TCP connection (which is already reading all
        MAVLink traffic) to send the request. PARAM_VALUE responses are
        captured via the hub_client's pending_params dict.
        """
        if not hasattr(self, "_hub_client") or not self._hub_client:
            log.warning("No hub_client — cannot read params")
            return None

        hub = self._hub_client
        target_system = 10 + heli_id

        # Register that we're waiting for this param
        key = (target_system, param_name)
        hub.pending_params[key] = None

        # Send request via the hub_client's connection
        param_id = param_name.encode("ascii").ljust(16, b"\x00")
        try:
            hub._conn.mav.param_request_read_send(
                target_system, 1, param_id, -1,
            )
        except Exception as e:
            log.warning("Failed to send param request: %s", e)
            hub.pending_params.pop(key, None)
            return None

        # Wait for response (hub_client's read thread will fill it in)
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            val = hub.pending_params.get(key)
            if val is not None:
                hub.pending_params.pop(key, None)
                return val
            time.sleep(0.1)

        hub.pending_params.pop(key, None)
        return None

    def set_param(self, heli_id: int, param_name: str, value: float,
                  param_type: int = 9) -> bool:
        """Set a parameter on a heli's FC. Returns True if ACK received."""
        if not hasattr(self, "_hub_client") or not self._hub_client:
            log.warning("No hub_client — cannot set params")
            return False

        hub = self._hub_client
        target_system = 10 + heli_id

        key = (target_system, param_name)
        hub.pending_params[key] = None

        param_id = param_name.encode("ascii").ljust(16, b"\x00")
        try:
            hub._conn.mav.param_set_send(
                target_system, 1, param_id, value, param_type,
            )
        except Exception as e:
            log.warning("Failed to send param set: %s", e)
            hub.pending_params.pop(key, None)
            return False

        import time
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            val = hub.pending_params.get(key)
            if val is not None:
                hub.pending_params.pop(key, None)
                log.info("Param %s set to %.0f on Heli%02d (confirmed: %.0f)",
                         param_name, value, heli_id, val)
                return True
            time.sleep(0.1)

        hub.pending_params.pop(key, None)
        log.warning("Param %s set to %.0f on Heli%02d — NO ACK",
                    param_name, value, heli_id)
        return False

    def read_params_batch(self, heli_id: int,
                          param_names: list[str]) -> dict[str, float | None]:
        """Read multiple params. Returns {name: value} dict."""
        result = {}
        for name in param_names:
            result[name] = self.read_param(heli_id, name)
        return result

    def close_all(self):
        """Close all connections."""
        for heli_id, conn in self._connections.items():
            try:
                conn.close()
            except Exception:
                pass
        self._connections.clear()
        if hasattr(self, "_tcp_conn") and self._tcp_conn:
            try:
                self._tcp_conn.close()
            except Exception:
                pass
            self._tcp_conn = None
        log.info("All command connections closed")
