"""Async MAVLink client — connects to mavlink-hub TCP 5760, dispatches messages."""

import asyncio
import logging
import threading
import time
from pymavlink import mavutil

log = logging.getLogger("roban.mavlink")

# Messages we care about
_WANTED = {
    "HEARTBEAT", "GPS_RAW_INT", "SYS_STATUS", "ATTITUDE",
    "GLOBAL_POSITION_INT", "VFR_HUD", "BATTERY_STATUS",
}


class HubClient:
    """Reads MAVLink from mavlink-hub and feeds parsed messages to a callback.

    Runs in a dedicated background thread (pymavlink is blocking) and posts
    results back to the asyncio event loop via call_soon_threadsafe.
    """

    def __init__(self, hub_addr: str = "127.0.0.1:5760",
                 on_message=None):
        self._hub_addr = hub_addr
        self._on_message = on_message  # async callable(sysid, msg_type, fields)
        self._conn = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._running = False

    async def start(self):
        self._running = True
        self._loop = asyncio.get_running_loop()
        self._thread = threading.Thread(
            target=self._read_thread, daemon=True, name="mavlink-hub"
        )
        self._thread.start()
        log.info("HubClient starting — target %s", self._hub_addr)

    async def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
        log.info("HubClient stopped")

    def _read_thread(self):
        """Blocking read loop — runs in a dedicated thread."""
        while self._running:
            try:
                self._connect_and_read()
            except Exception as e:
                log.warning("HubClient connection lost: %s — retrying in 3s", e)
            if self._running:
                time.sleep(3)

    def _connect_and_read(self):
        """Connect to mavlink-hub and read messages."""
        self._conn = mavutil.mavlink_connection(
            f"tcp:{self._hub_addr}", source_system=250, source_component=191,
            retries=1, timeout=5,
        )
        log.info("Connected to mavlink-hub at %s", self._hub_addr)

        null_count = 0
        while self._running:
            try:
                msg = self._conn.recv_match(blocking=True, timeout=2.0)
            except Exception as e:
                log.warning("recv_match error: %s", e)
                break

            if msg is None:
                null_count += 1
                # If we get many consecutive nulls, connection is probably dead
                if null_count > 10:
                    log.warning("Too many empty reads — reconnecting")
                    break
                continue

            null_count = 0
            msg_type = msg.get_type()
            if msg_type == "BAD_DATA" or msg_type not in _WANTED:
                continue

            sysid = msg.get_srcSystem()
            fields = self._extract(msg_type, msg)
            if fields and self._on_message and self._loop:
                # Schedule the async callback on the event loop
                self._loop.call_soon_threadsafe(
                    asyncio.ensure_future,
                    self._on_message(sysid, msg_type, fields),
                )

        # Clean up connection
        try:
            self._conn.close()
        except Exception:
            pass

    @staticmethod
    def _extract(msg_type: str, msg) -> dict | None:
        """Pull the fields we need from each message type."""
        if msg_type == "HEARTBEAT":
            from pymavlink.dialects.v20 import ardupilotmega as apm
            return {
                "armed": bool(msg.base_mode & apm.MAV_MODE_FLAG_SAFETY_ARMED),
                "flight_mode": msg.custom_mode,
                "mav_type": msg.type,
                "system_status": msg.system_status,
            }
        if msg_type == "GPS_RAW_INT":
            return {
                "fix_type": msg.fix_type,
                "lat": msg.lat / 1e7,
                "lon": msg.lon / 1e7,
                "alt_m": msg.alt / 1e3,
                "satellites": msg.satellites_visible,
                "hdop": msg.eph / 100.0 if msg.eph != 65535 else None,
            }
        if msg_type == "SYS_STATUS":
            return {
                "battery_mv": msg.voltage_battery,
                "battery_pct": msg.battery_remaining if msg.battery_remaining >= 0 else None,
                "sensors_present": msg.onboard_control_sensors_present,
                "sensors_health": msg.onboard_control_sensors_health,
            }
        if msg_type == "ATTITUDE":
            return {
                "roll_deg": round(msg.roll * 57.2958, 1),
                "pitch_deg": round(msg.pitch * 57.2958, 1),
                "yaw_deg": round(msg.yaw * 57.2958, 1),
            }
        if msg_type == "GLOBAL_POSITION_INT":
            return {
                "lat": msg.lat / 1e7,
                "lon": msg.lon / 1e7,
                "alt_m": msg.alt / 1e3,
                "relative_alt_m": msg.relative_alt / 1e3,
                "heading_deg": msg.hdg / 100.0 if msg.hdg != 65535 else None,
            }
        if msg_type == "VFR_HUD":
            return {
                "airspeed": msg.airspeed,
                "groundspeed": msg.groundspeed,
                "heading_deg": msg.heading,
                "throttle_pct": msg.throttle,
                "climb_rate": msg.climb,
            }
        if msg_type == "BATTERY_STATUS":
            return {
                "battery_pct": msg.battery_remaining if msg.battery_remaining >= 0 else None,
                "battery_mv": msg.voltages[0] if msg.voltages[0] != 65535 else None,
                "current_ma": msg.current_battery if msg.current_battery >= 0 else None,
            }
        return None
