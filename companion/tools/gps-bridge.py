#!/usr/bin/env python3
"""
Roban Swarm GPS Bridge — reads NMEA from LC29HEA on UART5,
sends MAVLink GPS_INPUT directly to the FC serial port (UART0).

GPS_INPUT is written directly to /dev/ttyS0 (FC UART) instead of going
through mavlink-router's UDP endpoint.  This prevents the base station's
mavlink-hub from forwarding GPS_INPUT to OTHER helis and polluting their
FC's GPS solution.

Also fetches RTCM3 corrections from the base station NTRIP caster
and writes them to the GNSS serial port (LC29HEA accepts RTCM on its RX line).

Uses raw os.read() instead of pyserial readline() to work around H618 UART
driver quirk where poll() reports readiness but read() returns 0 bytes,
causing pyserial to raise SerialException.
"""

import os
import sys
import time
import socket
import base64
import threading
import select
import serial
from pymavlink.dialects.v20 import ardupilotmega as mavlink2

# Config from environment or defaults
GNSS_SERIAL = os.environ.get("GNSS_RTCM_SERIAL", "/dev/ttyS5")
GNSS_BAUD = int(os.environ.get("GNSS_RTCM_BAUD", "115200"))
FC_SERIAL = os.environ.get("FC_SERIAL", "/dev/ttyS0")
FC_BAUD = int(os.environ.get("FC_BAUD", "115200"))
SYSTEM_ID = int(os.environ.get("MAV_SYSID", "1"))
COMPONENT_ID = int(os.environ.get("MAV_COMPID", "240"))  # MAV_COMP_ID_GPS

# NTRIP config
NTRIP_ENABLED = os.environ.get("NTRIP_ENABLED", "1") == "1"
NTRIP_HOST = os.environ.get("BASE_IP", "192.168.50.1")
NTRIP_PORT = int(os.environ.get("NTRIP_PORT", "2101"))
NTRIP_MOUNT = os.environ.get("NTRIP_MOUNT", "BASE")
NTRIP_USER = os.environ.get("NTRIP_USER", "admin")
NTRIP_PASS = os.environ.get("NTRIP_PASS", "roban")

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
            "fix_raw": fix_qual,
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


def build_gga_sentence(gga):
    """Build a GGA sentence from parsed data to send to NTRIP caster."""
    if gga is None or gga["lat"] == 0.0:
        return None

    lat = abs(gga["lat"])
    lat_deg = int(lat)
    lat_min = (lat - lat_deg) * 60.0
    lat_hemi = "N" if gga["lat"] >= 0 else "S"

    lon = abs(gga["lon"])
    lon_deg = int(lon)
    lon_min = (lon - lon_deg) * 60.0
    lon_hemi = "E" if gga["lon"] >= 0 else "W"

    body = (
        f"GPGGA,{gga['time']},"
        f"{lat_deg:02d}{lat_min:07.4f},{lat_hemi},"
        f"{lon_deg:03d}{lon_min:07.4f},{lon_hemi},"
        f"{gga['fix_raw']},{gga['sats']:02d},{gga['hdop']:.1f},"
        f"{gga['alt']:.1f},M,0.0,M,,"
    )
    cksum = 0
    for c in body:
        cksum ^= ord(c)
    return f"${body}*{cksum:02X}\r\n"


class NtripClient(threading.Thread):
    """Background thread that connects to an NTRIP caster and writes
    RTCM3 correction data to the GNSS serial port."""

    def __init__(self, ser, gga_ref):
        super().__init__(daemon=True)
        self.ser = ser  # shared serial.Serial object
        self.gga_ref = gga_ref  # mutable list [gga_dict_or_None]
        self.rtcm_bytes = 0
        self.running = True
        self._lock = threading.Lock()

    def run(self):
        print(f"ntrip: connecting to {NTRIP_HOST}:{NTRIP_PORT}/{NTRIP_MOUNT}")
        while self.running:
            try:
                self._connect_and_stream()
            except Exception as e:
                print(f"ntrip: error: {e}", file=sys.stderr)
            if self.running:
                print("ntrip: reconnecting in 10s...")
                time.sleep(10)

    def _connect_and_stream(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(30)
        sock.connect((NTRIP_HOST, NTRIP_PORT))

        # Build NTRIP v1 request
        auth = base64.b64encode(
            f"{NTRIP_USER}:{NTRIP_PASS}".encode()
        ).decode()
        request = (
            f"GET /{NTRIP_MOUNT} HTTP/1.0\r\n"
            f"User-Agent: NTRIP RobanSwarmBridge/1.0\r\n"
            f"Authorization: Basic {auth}\r\n"
            f"\r\n"
        )
        sock.sendall(request.encode())

        # Read response header
        # str2str caster sends "ICY 200 OK\r\n" (no double CRLF),
        # standard NTRIP sends "ICY 200 OK\r\n\r\n" or "HTTP/1.1 200 OK\r\n...\r\n\r\n"
        header = b""
        while True:
            chunk = sock.recv(1024)
            if not chunk:
                raise ConnectionError("NTRIP: no response from caster")
            header += chunk
            # Check for both formats
            if b"\r\n\r\n" in header or b"ICY 200 OK\r\n" in header:
                break
            if len(header) > 4096:
                break

        header_str = header.decode(errors="ignore")
        if "ICY 200 OK" not in header_str and "200 OK" not in header_str:
            raise ConnectionError(f"NTRIP: bad response: {header_str[:200]}")

        print(f"ntrip: connected to {NTRIP_MOUNT}")

        # Any data after the header is already RTCM
        if b"\r\n\r\n" in header:
            remainder = header.split(b"\r\n\r\n", 1)[1]
        elif b"ICY 200 OK\r\n" in header:
            remainder = header.split(b"ICY 200 OK\r\n", 1)[1]
        else:
            remainder = b""
        if remainder:
            self._write_rtcm(remainder)

        # Send initial GGA if available
        self._send_gga(sock)

        last_gga_time = time.time()
        sock.settimeout(60)

        while self.running:
            try:
                data = sock.recv(4096)
                if not data:
                    raise ConnectionError("NTRIP: caster closed connection")
                self._write_rtcm(data)

                # Send GGA every 30 seconds
                now = time.time()
                if now - last_gga_time >= 30:
                    self._send_gga(sock)
                    last_gga_time = now

            except socket.timeout:
                # Send GGA as keepalive
                self._send_gga(sock)
                last_gga_time = time.time()

        sock.close()

    def _write_rtcm(self, data):
        """Write RTCM data to the serial port (thread-safe)."""
        with self._lock:
            try:
                self.ser.write(data)
                self.rtcm_bytes += len(data)
            except serial.SerialException as e:
                print(f"ntrip: serial write error: {e}", file=sys.stderr)

    def _send_gga(self, sock):
        """Send current position as GGA to the caster."""
        gga = self.gga_ref[0]
        sentence = build_gga_sentence(gga)
        if sentence:
            try:
                sock.sendall(sentence.encode())
            except Exception:
                pass

    def stop(self):
        self.running = False


def main():
    print(f"gps-bridge: GNSS={GNSS_SERIAL}@{GNSS_BAUD} → FC={FC_SERIAL}@{FC_BAUD}")

    # Open serial port — single owner for both NMEA read and RTCM write
    gnss = serial.Serial(GNSS_SERIAL, GNSS_BAUD, timeout=0)
    fd = gnss.fileno()

    # Open FC serial port for direct GPS_INPUT writes.
    # mavlink-router also opens /dev/ttyS0 — Linux allows multiple processes
    # to open the same UART. GPS_INPUT frames are small (~75 bytes) and
    # written atomically, so interleaving with mavlink-router is safe at
    # 115200 baud.  This avoids GPS_INPUT going through mavlink-router → base
    # hub → other helis (cross-contamination bug).
    fc_ser = serial.Serial(FC_SERIAL, FC_BAUD, timeout=0)

    # Create a MAVLink encoder that writes directly to FC serial port
    mav_encoder = mavlink2.MAVLink(fc_ser, srcSystem=SYSTEM_ID, srcComponent=COMPONENT_ID)

    gga = None
    rmc = None
    msg_count = 0
    last_stats = time.time()
    buf = b""
    empty_reads = 0

    # Shared GGA reference for NTRIP thread
    gga_ref = [None]

    # Start NTRIP client thread if enabled
    ntrip = None
    if NTRIP_ENABLED:
        ntrip = NtripClient(gnss, gga_ref)
        ntrip.start()
        print("gps-bridge: NTRIP client thread started")
    else:
        print("gps-bridge: NTRIP disabled (set NTRIP_ENABLED=1 to enable)")

    print("gps-bridge: running")

    while True:
        try:
            # Use select() to wait for data, then raw os.read()
            # This avoids pyserial's readline() which raises SerialException
            # on H618 when poll reports ready but read returns 0 bytes.
            readable, _, _ = select.select([fd], [], [], 1.0)
            if not readable:
                continue

            try:
                chunk = os.read(fd, 4096)
            except OSError:
                # H618 UART driver sometimes returns 0 on ready fd — ignore
                empty_reads += 1
                continue

            if not chunk:
                empty_reads += 1
                continue

            buf += chunk

            # Process complete lines from buffer
            while b"\n" in buf:
                line_bytes, buf = buf.split(b"\n", 1)
                line = line_bytes.decode("ascii", errors="ignore").strip()

                if not line.startswith("$"):
                    continue
                if not nmea_checksum_ok(line):
                    continue

                fields = line.split("*")[0].split(",")
                sentence = fields[0]

                if sentence in ("$GNGGA", "$GPGGA"):
                    gga = parse_gga(fields)
                    # Update shared reference for NTRIP thread
                    gga_ref[0] = gga

                elif sentence in ("$GNRMC", "$GPRMC"):
                    rmc = parse_rmc(fields)

                    # Send GPS_INPUT on each RMC (comes after GGA in each cycle)
                    if gga is not None:
                        speed_ms = (rmc["speed_knots"] * 0.514444) if rmc else 0.0
                        course = rmc["course"] if rmc else 0.0

                        # ignore_flags: ignore vn/ve/vd, speed_accuracy, vert_accuracy
                        ignore = 0b1111001

                        mav_encoder.gps_input_send(
                            int(time.time() * 1e6),  # time_usec
                            0,                        # gps_id
                            ignore,                   # ignore_flags
                            0,                        # time_week_ms
                            0,                        # time_week
                            gga["fix"],               # fix_type
                            int(gga["lat"] * 1e7),    # lat (degE7)
                            int(gga["lon"] * 1e7),    # lon (degE7)
                            gga["alt"],               # alt (m MSL)
                            gga["hdop"],              # hdop
                            99.99,                    # vdop
                            0.0,                      # vn
                            0.0,                      # ve
                            0.0,                      # vd
                            0.0,                      # speed_accuracy
                            gga["hdop"] * 2.0,        # horiz_accuracy
                            0.0,                      # vert_accuracy
                            gga["sats"],              # satellites_visible
                            int(course * 100),        # yaw (cdeg)
                        )

                        msg_count += 1

            # Prevent buffer from growing unbounded (drop non-NMEA binary)
            if len(buf) > 8192:
                buf = buf[-4096:]

            # Print stats every 10 seconds
            now = time.time()
            if now - last_stats >= 10.0:
                rate = msg_count / (now - last_stats)
                rtcm_kb = ntrip.rtcm_bytes / 1024.0 if ntrip else 0
                fix_names = {0: "NoFix", 3: "3D", 4: "DGPS",
                             5: "Float", 6: "RTK"}
                if gga:
                    fix_str = fix_names.get(gga["fix"], f"?{gga['fix']}")
                    print(
                        f"gps-bridge: fix={fix_str} sats={gga['sats']} "
                        f"lat={gga['lat']:.7f} lon={gga['lon']:.7f} "
                        f"alt={gga['alt']:.1f}m hdop={gga['hdop']:.1f} "
                        f"rate={rate:.1f}Hz"
                        + (f" rtcm={rtcm_kb:.1f}KB" if ntrip else "")
                        + (f" empty={empty_reads}" if empty_reads else "")
                    )
                else:
                    print(f"gps-bridge: no GGA yet, rate={rate:.1f}Hz")
                msg_count = 0
                empty_reads = 0
                last_stats = now

        except KeyboardInterrupt:
            break

    if ntrip:
        ntrip.stop()
    gnss.close()
    fc_ser.close()
    print("gps-bridge: stopped")


if __name__ == "__main__":
    main()
