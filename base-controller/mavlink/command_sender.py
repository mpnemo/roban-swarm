"""MAVLink command sender — per-heli UDP connections for outbound commands.

Separate from HubClient (which is read-only on TCP 5760). Each heli gets
its own UDP connection to mavlink-hub's per-heli endpoint, ensuring commands
are routed to the correct vehicle only.
"""

import logging
from pymavlink import mavutil
from api._state import get_sysid_offset

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

# Pos + velocity, ignore accel + yaw + yaw_rate (FC auto-faces travel).
TYPE_MASK_POS_VEL = 0b0000_1101_1100_0000  # = 0x0DC0

# Pos + velocity + explicit yaw, ignore accel + yaw_rate. Used when the
# show file provides a waypoint yaw_deg.
TYPE_MASK_POS_VEL_YAW = 0b0000_1001_1100_0000  # = 0x09C0


class CommandSender:
    """Sends MAVLink commands to helis via the shared TCP 5760 connection.

    All commands go through mavlink-hub's TCP port, which routes by target
    sysid. This is more reliable than per-heli UDP (which had routing issues
    with Server-mode endpoints).
    """

    def __init__(self, source_system: int = 250, source_component: int = 190):
        self._source_system = source_system
        self._source_component = source_component
        self._hub_client = None

    def _get_conn(self, heli_id: int = 0):
        """Get the shared TCP connection via hub_client."""
        if self._hub_client and self._hub_client._conn:
            return self._hub_client._conn
        raise RuntimeError("No hub_client connection available")

    def send_position_target(self, heli_id: int,
                              pos_n: float, pos_e: float, pos_d: float,
                              vel_n: float = 0, vel_e: float = 0,
                              vel_d: float = 0,
                              yaw_rad: float | None = None):
        """Send SET_POSITION_TARGET_LOCAL_NED to a heli.

        Position and velocity in NED frame. Acceleration always ignored.
        yaw_rad: if None, yaw is ignored (ArduPilot auto-faces direction
        of travel — default behavior). If a float is provided, it's sent
        as an absolute heading (radians, 0 = north, clockwise positive).
        """
        conn = self._get_conn(heli_id)
        target_system = 10 + heli_id + get_sysid_offset()
        if yaw_rad is None:
            type_mask = TYPE_MASK_POS_VEL
            yaw_val = 0.0
        else:
            type_mask = TYPE_MASK_POS_VEL_YAW
            yaw_val = float(yaw_rad)
        conn.mav.set_position_target_local_ned_send(
            0,                                  # time_boot_ms (0 = autopilot time)
            target_system, 1,                   # target system, component
            mavutil.mavlink.MAV_FRAME_LOCAL_NED,
            type_mask,
            pos_n, pos_e, pos_d,                # position (m)
            vel_n, vel_e, vel_d,                # velocity (m/s)
            0, 0, 0,                            # acceleration (ignored)
            yaw_val, 0,                         # yaw (rad), yaw_rate (ignored)
        )

    def send_set_mode(self, heli_id: int, mode_id: int):
        """Send SET_MODE to switch flight mode (e.g., GUIDED=4, BRAKE=17)."""
        conn = self._get_conn(heli_id)
        target_system = 10 + heli_id + get_sysid_offset()
        conn.mav.set_mode_send(
            target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode_id,
        )
        log.info("Sent SET_MODE %d to Heli%02d", mode_id, heli_id)

    def send_arm(self, heli_id: int, arm: bool = True):
        """Send ARM/DISARM command."""
        conn = self._get_conn(heli_id)
        target_system = 10 + heli_id + get_sysid_offset()
        conn.mav.command_long_send(
            target_system, 1,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0,              # confirmation
            1 if arm else 0,  # param1: 1=arm, 0=disarm
            0, 0, 0, 0, 0, 0,
        )
        log.info("Sent %s to Heli%02d", "ARM" if arm else "DISARM", heli_id)

    def send_disarm(self, heli_id: int):
        """Convenience: disarm a heli."""
        self.send_arm(heli_id, arm=False)

    def send_rtl(self, heli_id: int):
        """Switch heli to RTL mode."""
        self.send_set_mode(heli_id, MODE_RTL)

    def set_rtl_alt(self, heli_id: int, alt_cm: int) -> bool:
        """Set RTL_ALT (cm) for staggered failsafe altitudes. Blocking."""
        return self.set_param(heli_id, "RTL_ALT", float(alt_cm))

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
        target_system = 10 + heli_id + get_sysid_offset()

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
        target_system = 10 + heli_id + get_sysid_offset()

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
        """Cleanup (hub_client connection is managed by hub_client)."""
        log.info("CommandSender closed")
