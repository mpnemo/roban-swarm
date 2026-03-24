"""Base station status API — NTRIP caster + base GNSS info."""

import asyncio
import logging
import re
import subprocess
import urllib.request
from fastapi import APIRouter

router = APIRouter(tags=["base"])
log = logging.getLogger("roban.base")

# Cache to avoid hammering serial/processes every request
_cache = {"data": None, "ts": 0}
CACHE_TTL = 3  # seconds


def _get_ntrip_status() -> dict:
    """Check if NTRIP caster (str2str) is running and get connected clients."""
    try:
        r = subprocess.run(
            ["systemctl", "is-active", "ntrip-caster"],
            capture_output=True, text=True, timeout=3,
        )
        active = r.stdout.strip() == "active"
    except Exception:
        active = False

    clients = 0
    if active:
        # Check NTRIP source table for connected clients
        try:
            resp = urllib.request.urlopen("http://127.0.0.1:2101/", timeout=2)
            body = resp.read().decode(errors="replace")
            # Count STR lines (each is a mount point)
            clients = body.count("STR;")
        except Exception:
            pass

    return {
        "ntrip_active": active,
        "ntrip_port": 2101,
        "ntrip_mount": "BASE",
    }


def _get_str2str_stats() -> dict:
    """Parse str2str log output for throughput and client count.

    str2str logs lines like:
    2026/03/23 09:28:33 [CC---]   13556568 B    5453 bps (0) /dev/ttyUSB0 (1) 4 clients
    """
    result = {
        "bytes_total": 0,
        "bps": 0,
        "clients": 0,
    }
    try:
        r = subprocess.run(
            ["journalctl", "-u", "ntrip-caster", "--no-pager", "-n", "1"],
            capture_output=True, text=True, timeout=3,
        )
        line = r.stdout.strip().split("\n")[-1] if r.stdout.strip() else ""
        # Parse: "13556568 B    5453 bps ... 4 clients"
        m = re.search(r"(\d+)\s+B\s+(\d+)\s+bps.*?(\d+)\s+clients?", line)
        if m:
            result["bytes_total"] = int(m.group(1))
            result["bps"] = int(m.group(2))
            result["clients"] = int(m.group(3))
    except Exception:
        pass
    return result


def _parse_gga(sentence: str) -> dict:
    """Parse a GGA NMEA sentence for fix info."""
    result = {
        "fix_type": 0,
        "fix_label": "No Fix",
        "lat": 0.0,
        "lon": 0.0,
        "alt_m": 0.0,
        "satellites": 0,
        "hdop": None,
    }

    parts = sentence.split(",")
    if len(parts) < 15:
        return result

    try:
        # Fix quality: 0=invalid, 1=GPS, 2=DGPS, 4=RTK, 5=Float
        fix_q = int(parts[6]) if parts[6] else 0
        fix_labels = {0: "No Fix", 1: "GPS", 2: "DGPS", 4: "RTK", 5: "Float"}
        result["fix_type"] = fix_q
        result["fix_label"] = fix_labels.get(fix_q, f"Fix {fix_q}")

        # Satellites
        result["satellites"] = int(parts[7]) if parts[7] else 0

        # HDOP
        result["hdop"] = float(parts[8]) if parts[8] else None

        # Latitude
        if parts[2] and parts[3]:
            lat_raw = float(parts[2])
            lat_deg = int(lat_raw / 100)
            lat_min = lat_raw - lat_deg * 100
            lat = lat_deg + lat_min / 60.0
            if parts[3] == "S":
                lat = -lat
            result["lat"] = round(lat, 7)

        # Longitude
        if parts[4] and parts[5]:
            lon_raw = float(parts[4])
            lon_deg = int(lon_raw / 100)
            lon_min = lon_raw - lon_deg * 100
            lon = lon_deg + lon_min / 60.0
            if parts[5] == "W":
                lon = -lon
            result["lon"] = round(lon, 7)

        # Altitude
        if parts[9]:
            result["alt_m"] = float(parts[9])

    except (ValueError, IndexError):
        pass

    return result


@router.get("/base/status")
async def base_status():
    """Get base station GNSS + NTRIP caster status."""
    import time
    now = time.monotonic()

    # Use cache if fresh
    if _cache["data"] and (now - _cache["ts"]) < CACHE_TTL:
        return _cache["data"]

    loop = asyncio.get_running_loop()
    ntrip = await loop.run_in_executor(None, _get_ntrip_status)
    stats = await loop.run_in_executor(None, _get_str2str_stats)

    data = {
        **ntrip,
        "rtcm_bps": stats["bps"],
        "rtcm_bytes_total": stats["bytes_total"],
        "ntrip_clients": stats["clients"],
    }

    _cache["data"] = data
    _cache["ts"] = now
    return data
