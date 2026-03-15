#!/usr/bin/env python3
"""
Roban Swarm GPS Bridge — reads NMEA from LC29HEA on UART5,
sends MAVLink GPS_INPUT to mavlink-router via UDP.
"""

import os
import sys
import time
import serial
from pymavlink import mavutil

# Config from environment or defaults
GNSS_SERIAL = os.environ.get("GNSS_RTCM_SERIAL", "/dev/ttyS5")
GNSS_BAUD = int(os.environ.get("GNSS_RTCM_BAUD", "115200"))
MAV_TARGET = os.environ.get("MAV_TARGET", "udpout:127.0.0.1:14570")
SYSTEM_ID = int(os.environ.get("MAV_SYSID", "1"))
COMPONENT_ID = int(os.environ.get("MAV_COMPID", "240"))  # MAV_COMP_ID_GPS

# GGA fix quality → MAVLink fix_type
GGA_FIX_MAP = {
    0: 0,  # invalid → no fix
    1: 3,  # GPS → 3D
    2: 4,  # DGPS
    4: 6,  # RTK fixed
    5: 5,  # RTK float
    6: 3,  # estimated (dead reckoning)
}


def parse_latlon(raw, hemi):
    """Parse NMEA ddmm.mmmm / dddmm.mmmm to degrees."""
    if not raw:
        return 0.0
    dot = raw.index(".")
    deg = int(raw[: dot - 2])
    minutes = float(raw[dot - 2 :])
    val = deg + minutes / 60.0
    if hemi in ("S", "W"):
        val = -val
    return val


def parse_gga(fields):
    """Parse $GNGGA fields into a dict."""
    try:
        fix_qual = int(fields[6]) if fields[6] else 0
        return {
            "time": fields[1],
            "lat": parse_latlon(fields[2], fields[3]),
            "lon": parse_latlon(fields[4], fields[5]),
            "fix": GGA_FIX_MAP.get(fix_qual, 0),
            "sats": int(fields[7]) if fields[7] else 0,
            "hdop": float(fields[8]) if fields[8] else 99.99,
            "alt": float(fields[9]) if fields[9] else 0.0,
        }
    except (ValueError, IndexError):
        return None


def parse_rmc(fields):
    """Parse $GNRMC fields into a dict."""
    try:
        return {
            "time": fields[1],
            "status": fields[2],
            "speed_knots": float(fields[7]) if fields[7] else 0.0,
            "course": float(fields[8]) if fields[8] else 0.0,
        }
    except (ValueError, IndexError):
        return None


def nmea_checksum_ok(line):
    """Verify NMEA checksum."""
    if "*" not in line:
        return False
    body, cksum = line.rsplit("*", 1)
    body = body.lstrip("$")
    calc = 0
    for c in body:
        calc ^= ord(c)
    try:
        return calc == int(cksum[:2], 16)
    except ValueError:
        return False


def main():
    print(f"gps-bridge: GNSS={GNSS_SERIAL}@{GNSS_BAUD} → {MAV_TARGET}")

    # Open serial port for NMEA reading
    gnss = serial.Serial(GNSS_SERIAL, GNSS_BAUD, timeout=1)

    # Open MAVLink UDP connection to mavlink-router
    mav = mavutil.mavlink_connection(
        MAV_TARGET,
        source_system=SYSTEM_ID,
        source_component=COMPONENT_ID,
    )

    gga = None
    rmc = None
    msg_count = 0
    last_stats = time.time()

    print("gps-bridge: running")

    while True:
        try:
            raw = gnss.readline()
            if not raw:
                continue

            line = raw.decode("ascii", errors="ignore").strip()
            if not line.startswith("$"):
                continue
            if not nmea_checksum_ok(line):
                continue

            fields = line.split("*")[0].split(",")
            sentence = fields[0]

            if sentence in ("$GNGGA", "$GPGGA"):
                gga = parse_gga(fields)

            elif sentence in ("$GNRMC", "$GPRMC"):
                rmc = parse_rmc(fields)

                # Send GPS_INPUT on each RMC (comes after GGA in each cycle)
                if gga is not None:
                    speed_ms = (rmc["speed_knots"] * 0.514444) if rmc else 0.0
                    course = rmc["course"] if rmc else 0.0

                    # ignore_flags: ignore vn/ve/vd, speed_accuracy, vert_accuracy
                    # bit 0: vn, 1: ve, 2: vd, 3: speed_acc, 4: horiz_acc,
                    #     5: vert_acc, 6: yaw
                    ignore = 0b1111001  # ignore vn,ve,vd, speed_acc, vert_acc, yaw

                    mav.mav.gps_input_send(
                        int(time.time() * 1e6),  # time_usec
                        0,                        # gps_id
                        ignore,                   # ignore_flags
                        0,                        # time_week_ms (ignored by AP if 0)
                        0,                        # time_week (ignored by AP if 0)
                        gga["fix"],               # fix_type
                        int(gga["lat"] * 1e7),    # lat (degE7)
                        int(gga["lon"] * 1e7),    # lon (degE7)
                        gga["alt"],               # alt (m MSL)
                        gga["hdop"],              # hdop
                        99.99,                    # vdop (not in GGA)
                        0.0,                      # vn (m/s)
                        0.0,                      # ve (m/s)
                        0.0,                      # vd (m/s)
                        0.0,                      # speed_accuracy
                        gga["hdop"] * 2.0,        # horiz_accuracy (rough est)
                        0.0,                      # vert_accuracy
                        gga["sats"],              # satellites_visible
                        int(course * 100),        # yaw (cdeg) — ignored
                    )

                    msg_count += 1

                    # Print stats every 10 seconds
                    now = time.time()
                    if now - last_stats >= 10.0:
                        rate = msg_count / (now - last_stats)
                        print(
                            f"gps-bridge: fix={gga['fix']} sats={gga['sats']} "
                            f"lat={gga['lat']:.7f} lon={gga['lon']:.7f} "
                            f"alt={gga['alt']:.1f}m hdop={gga['hdop']:.1f} "
                            f"rate={rate:.1f}Hz"
                        )
                        msg_count = 0
                        last_stats = now

        except serial.SerialException as e:
            print(f"gps-bridge: serial error: {e}", file=sys.stderr)
            time.sleep(1)
        except KeyboardInterrupt:
            break

    gnss.close()
    print("gps-bridge: stopped")


if __name__ == "__main__":
    main()
