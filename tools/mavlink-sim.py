#!/usr/bin/env python3
"""Lightweight MAVLink heli simulator — replaces ArduPilot SITL for testing.

Simulates N helis with sysid offset +100 (real 11→sim 111, real 12→sim 112).
Each simulated heli:
- Sends HEARTBEAT at 1Hz
- Sends GPS_RAW_INT at 4Hz (with simulated RTK fix)
- Sends ATTITUDE at 10Hz
- Sends VFR_HUD at 4Hz
- Sends SYS_STATUS at 1Hz
- Sends GLOBAL_POSITION_INT at 4Hz
- Responds to SET_MODE, ARM/DISARM, SET_POSITION_TARGET_LOCAL_NED
- Simulates movement toward position targets at configurable speed

Connects to mavlink-hub via TCP 5760 (same as real helis).

Usage:
    python3 mavlink-sim.py [--helis 2] [--hub 127.0.0.1:5760]
"""

import argparse
import math
import socket
import struct
import sys
import threading
import time

from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as apm

# --- Configuration ---
SYSID_OFFSET = 100        # sim sysid = 10 + heli_id + 100
HOME_LAT = 23.1611        # degrees
HOME_LON = 113.8822       # degrees
HOME_ALT = 45.0           # meters AMSL
HELI_SPACING_M = 3.0      # meters between helis at startup
MAX_SPEED = 3.0            # m/s max simulated movement speed
TICK_HZ = 50               # internal sim rate


class SimHeli:
    """One simulated helicopter."""

    def __init__(self, heli_id: int, conn):
        self.heli_id = heli_id
        self.sysid = 10 + heli_id + SYSID_OFFSET  # e.g., 111, 112
        self.conn = conn

        # State
        self.armed = False
        self.mode = 0  # STABILIZE
        self.mode_name = "STABILIZE"

        # Position (lat/lon/alt)
        offset_e = (heli_id - 1) * HELI_SPACING_M
        self.lat = HOME_LAT
        self.lon = HOME_LON + offset_e / (111319.5 * math.cos(math.radians(HOME_LAT)))
        self.alt = HOME_ALT
        self.relative_alt = 0.0

        # NED position relative to home (for target tracking)
        self.pos_n = 0.0
        self.pos_e = offset_e
        self.pos_d = 0.0  # on ground

        # Attitude
        self.roll = 0.0
        self.pitch = 0.0
        self.yaw = math.radians(heli_id * 30)  # spread headings

        # Velocity
        self.vn = 0.0
        self.ve = 0.0
        self.vd = 0.0
        self.groundspeed = 0.0

        # Target (from SET_POSITION_TARGET)
        self.target_n = self.pos_n
        self.target_e = self.pos_e
        self.target_d = self.pos_d
        self.has_target = False

        # Counters
        self.boot_ms = 0

    def update(self, dt: float):
        """Advance simulation by dt seconds."""
        self.boot_ms += int(dt * 1000)

        if not self.armed or self.mode != 4:  # Only move in GUIDED
            self.vn = self.ve = self.vd = 0.0
            self.groundspeed = 0.0
            return

        if not self.has_target:
            return

        # Move toward target
        dn = self.target_n - self.pos_n
        de = self.target_e - self.pos_e
        dd = self.target_d - self.pos_d
        dist = math.sqrt(dn*dn + de*de + dd*dd)

        if dist < 0.05:
            self.vn = self.ve = self.vd = 0.0
            self.groundspeed = 0.0
            return

        speed = min(MAX_SPEED, dist / 0.5)  # slow down near target
        scale = speed / dist
        self.vn = dn * scale
        self.ve = de * scale
        self.vd = dd * scale

        self.pos_n += self.vn * dt
        self.pos_e += self.ve * dt
        self.pos_d += self.vd * dt

        # Update lat/lon from NED
        self.lat = HOME_LAT + self.pos_n / 111319.5
        self.lon = HOME_LON + self.pos_e / (111319.5 * math.cos(math.radians(HOME_LAT)))
        self.alt = HOME_ALT - self.pos_d
        self.relative_alt = -self.pos_d

        # Groundspeed
        self.groundspeed = math.sqrt(self.vn**2 + self.ve**2)

        # Simulate attitude from velocity
        if self.groundspeed > 0.1:
            self.yaw = math.atan2(self.ve, self.vn)
            self.pitch = -math.atan2(self.groundspeed * 0.15, 9.81)  # slight forward lean
            self.roll = 0.0

    def set_target(self, n: float, e: float, d: float):
        self.target_n = n
        self.target_e = e
        self.target_d = d
        self.has_target = True

    def set_mode(self, mode: int):
        modes = {0: "STABILIZE", 4: "GUIDED", 5: "LOITER", 6: "RTL", 17: "BRAKE"}
        self.mode = mode
        self.mode_name = modes.get(mode, f"MODE_{mode}")

        # RTL: fly back to home
        if mode == 6:
            self.target_n = 0.0
            self.target_e = (self.heli_id - 1) * HELI_SPACING_M
            self.target_d = -15.0 - (self.heli_id - 1) * 3.0  # staggered RTL alt
            self.has_target = True

        # BRAKE: stop moving
        if mode == 17:
            self.has_target = False
            self.vn = self.ve = self.vd = 0.0

    def arm(self, do_arm: bool):
        self.armed = do_arm
        if not do_arm:
            self.has_target = False
            self.vn = self.ve = self.vd = 0.0

    # --- MAVLink message senders ---

    def send_heartbeat(self):
        self.conn.mav.heartbeat_send(
            apm.MAV_TYPE_HELICOPTER,
            apm.MAV_AUTOPILOT_ARDUPILOTMEGA,
            (apm.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED |
             (apm.MAV_MODE_FLAG_SAFETY_ARMED if self.armed else 0)),
            self.mode,
            apm.MAV_STATE_ACTIVE if self.armed else apm.MAV_STATE_STANDBY,
        )

    def send_gps_raw_int(self):
        fix = 6 if self.armed else 5  # RTK Fixed when armed, Float when not
        self.conn.mav.gps_raw_int_send(
            self.boot_ms * 1000,  # time_usec
            fix,                   # fix_type: 6=RTK
            int(self.lat * 1e7),
            int(self.lon * 1e7),
            int(self.alt * 1000),
            50,                    # eph (hdop*100) = 0.5
            50,                    # epv
            int(self.groundspeed * 100),
            int(math.degrees(self.yaw) * 100) % 36000,
            40,                    # satellites
        )

    def send_attitude(self):
        self.conn.mav.attitude_send(
            self.boot_ms,
            self.roll, self.pitch, self.yaw,
            0, 0, 0,  # rollspeed, pitchspeed, yawspeed
        )

    def send_global_position_int(self):
        self.conn.mav.global_position_int_send(
            self.boot_ms,
            int(self.lat * 1e7),
            int(self.lon * 1e7),
            int(self.alt * 1000),
            int(self.relative_alt * 1000),
            int(self.vn * 100),
            int(self.ve * 100),
            int(self.vd * 100),
            int(math.degrees(self.yaw) * 100) % 36000,
        )

    def send_vfr_hud(self):
        self.conn.mav.vfr_hud_send(
            self.groundspeed,      # airspeed
            self.groundspeed,      # groundspeed
            int(math.degrees(self.yaw)) % 360,
            0,                     # throttle
            self.relative_alt,     # alt
            -self.vd,              # climb
        )

    def send_sys_status(self):
        sensors = (apm.MAV_SYS_STATUS_SENSOR_GPS |
                   apm.MAV_SYS_STATUS_SENSOR_3D_GYRO |
                   apm.MAV_SYS_STATUS_SENSOR_3D_ACCEL)
        self.conn.mav.sys_status_send(
            sensors, sensors, sensors,
            0,      # load
            12600,  # voltage_battery (mV) = 12.6V
            -1,     # current
            85,     # battery_remaining %
            0, 0, 0, 0, 0, 0,
        )

    def send_autopilot_version(self):
        # 4.6.3 = (4<<24)|(6<<16)|(3<<8)|255
        sw_version = (4 << 24) | (6 << 16) | (3 << 8) | 255
        self.conn.mav.autopilot_version_send(
            apm.MAV_PROTOCOL_CAPABILITY_SET_POSITION_TARGET_LOCAL_NED,
            sw_version,  # flight_sw_version
            0,           # middleware_sw_version
            0,           # os_sw_version
            0,           # board_version
            b'\x00' * 8, b'\x00' * 8, b'\x00' * 8,  # flight/middleware/os custom
            0, 0,        # vendor/product id
            0,           # uid
            b'\x00' * 18,  # uid2
        )


class MavlinkSim:
    """Manages multiple simulated helis on a single MAVLink connection."""

    def __init__(self, hub_addr: str, num_helis: int):
        self.hub_addr = hub_addr
        self.num_helis = num_helis
        self.helis: dict[int, SimHeli] = {}
        self.conn = None
        self.running = False

    def start(self):
        print(f"Connecting to mavlink-hub at {self.hub_addr}...")
        self.conn = mavutil.mavlink_connection(
            f"tcp:{self.hub_addr}",
            source_system=111,  # Will be overridden per-message
            source_component=1,
        )
        print("Connected.")

        # Create helis
        for i in range(1, self.num_helis + 1):
            heli = SimHeli(i, self.conn)
            self.helis[heli.sysid] = heli
            print(f"  Heli{i:02d}: sysid={heli.sysid}, "
                  f"pos=({heli.lat:.7f}, {heli.lon:.7f})")

        self.running = True

        # Start receive thread
        rx_thread = threading.Thread(target=self._receive_loop, daemon=True)
        rx_thread.start()

        # Main sim loop
        self._sim_loop()

    def _sim_loop(self):
        """Main simulation loop — update physics + send telemetry."""
        dt = 1.0 / TICK_HZ
        tick = 0

        while self.running:
            t0 = time.monotonic()

            for heli in self.helis.values():
                heli.update(dt)

                # Set source system for this heli's messages
                self.conn.mav.srcSystem = heli.sysid

                # Heartbeat at 1Hz
                if tick % TICK_HZ == 0:
                    heli.send_heartbeat()
                    heli.send_sys_status()

                # GPS at 4Hz
                if tick % (TICK_HZ // 4) == 0:
                    heli.send_gps_raw_int()
                    heli.send_global_position_int()
                    heli.send_vfr_hud()

                # Attitude at 10Hz
                if tick % (TICK_HZ // 10) == 0:
                    heli.send_attitude()

            tick += 1

            # Sleep to maintain tick rate
            elapsed = time.monotonic() - t0
            sleep_time = dt - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    def _receive_loop(self):
        """Receive and handle incoming MAVLink commands."""
        while self.running:
            try:
                msg = self.conn.recv_match(blocking=True, timeout=1.0)
                if msg is None:
                    continue

                msg_type = msg.get_type()
                target = getattr(msg, 'target_system', 0)

                if msg_type == "BAD_DATA":
                    continue

                # Find target heli
                heli = self.helis.get(target)
                if heli is None:
                    continue

                if msg_type == "SET_MODE":
                    heli.set_mode(msg.custom_mode)
                    print(f"  Heli{heli.heli_id}: SET_MODE → {heli.mode_name}")

                elif msg_type == "COMMAND_LONG":
                    if msg.command == apm.MAV_CMD_COMPONENT_ARM_DISARM:
                        do_arm = msg.param1 > 0.5
                        heli.arm(do_arm)
                        print(f"  Heli{heli.heli_id}: {'ARMED' if do_arm else 'DISARMED'}")
                        # Send ACK
                        self.conn.mav.srcSystem = heli.sysid
                        self.conn.mav.command_ack_send(
                            msg.command, apm.MAV_RESULT_ACCEPTED)

                    elif msg.command == apm.MAV_CMD_REQUEST_MESSAGE:
                        msg_id = int(msg.param1)
                        if msg_id == 148:  # AUTOPILOT_VERSION
                            self.conn.mav.srcSystem = heli.sysid
                            heli.send_autopilot_version()

                elif msg_type == "SET_POSITION_TARGET_LOCAL_NED":
                    heli.set_target(msg.x, msg.y, msg.z)

                elif msg_type == "PARAM_REQUEST_READ":
                    pname = msg.param_id.rstrip('\x00') if isinstance(msg.param_id, str) \
                        else msg.param_id.decode().rstrip('\x00')
                    # Return simulated param values
                    params = {
                        "GPS1_TYPE": 14,
                        "GPS_AUTO_CONFIG": 0,
                        "SERIAL2_BAUD": 115,
                        "SERIAL2_PROTOCOL": 2,
                        "SYSID_THISMAV": float(heli.sysid),
                        "ARMING_CHECK": 0,
                        "RTL_ALT": 1500 + (heli.heli_id - 1) * 300,
                        "H_COL_ANG_MIN": -2,
                        "H_COL_ANG_MAX": 12,
                    }
                    val = params.get(pname, 0.0)
                    self.conn.mav.srcSystem = heli.sysid
                    self.conn.mav.param_value_send(
                        pname.encode().ljust(16, b'\x00'),
                        float(val), 9, 0, 0,
                    )

                elif msg_type == "PARAM_SET":
                    pname = msg.param_id.rstrip('\x00') if isinstance(msg.param_id, str) \
                        else msg.param_id.decode().rstrip('\x00')
                    # ACK with the set value
                    self.conn.mav.srcSystem = heli.sysid
                    self.conn.mav.param_value_send(
                        msg.param_id if isinstance(msg.param_id, bytes)
                        else msg.param_id.encode().ljust(16, b'\x00'),
                        msg.param_value, msg.param_type, 0, 0,
                    )
                    print(f"  Heli{heli.heli_id}: PARAM_SET {pname}={msg.param_value}")

                elif msg_type == "REQUEST_DATA_STREAM":
                    pass  # We already send at fixed rates

            except Exception as e:
                if self.running:
                    print(f"  RX error: {e}")
                    time.sleep(0.5)

    def stop(self):
        self.running = False
        if self.conn:
            self.conn.close()


def main():
    parser = argparse.ArgumentParser(description="Roban Swarm MAVLink Simulator")
    parser.add_argument("--helis", type=int, default=2, help="Number of helis (default: 2)")
    parser.add_argument("--hub", default="127.0.0.1:5760", help="mavlink-hub address (default: 127.0.0.1:5760)")
    args = parser.parse_args()

    print(f"=== Roban Swarm MAVLink Simulator ===")
    print(f"Helis: {args.helis}, SysID offset: +{SYSID_OFFSET}")
    print(f"Hub: {args.hub}")
    print(f"Home: {HOME_LAT}, {HOME_LON}, alt {HOME_ALT}m")
    print()

    sim = MavlinkSim(args.hub, args.helis)
    try:
        sim.start()
    except KeyboardInterrupt:
        print("\nShutting down...")
        sim.stop()


if __name__ == "__main__":
    main()
