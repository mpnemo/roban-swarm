"""Flight daemon — reads a show file and streams SET_POSITION_TARGET_LOCAL_NED.

This is the "CNC G-code executor" for the swarm: it interpolates between
waypoints and sends position+velocity targets to each heli at 20 Hz via
the safety monitor → command sender pipeline.

Lifecycle:
    load(show)    → LOADED
    arm()         → ARMED   (pre-flight checks: GPS, mode, battery)
    go()          → STAGING (sequential takeoff, fly to start positions)
                  → RUNNING (streaming show targets at 20 Hz)
    pause()       → PAUSED  (hold position)
    resume()      → RUNNING
    stop()        → IDLE    (BRAKE all helis, emergency stop)
"""

import asyncio
import json
import logging
import math
import time
from enum import Enum
from pathlib import Path
from typing import Callable, Awaitable

from .show_format import ShowFile, HeliTrack, Vec3
from .safety_monitor import SafetyMonitor
from mavlink.command_sender import CommandSender, MODE_BRAKE, MODE_GUIDED

log = logging.getLogger("roban.flight")

# --- Constants ---
TICK_HZ = 20
TICK_INTERVAL = 1.0 / TICK_HZ
STAGING_ALT_MARGIN = 3.0       # Extra meters above first waypoint for staging
STAGING_ARRIVAL_TOL = 0.5      # Meters — close enough to start position
STAGING_TAKEOFF_DELAY = 2.0    # Seconds between sequential takeoffs
MIN_BATTERY_PCT = 30           # Minimum battery for arm check
MIN_GPS_FIX = 3                # 3D fix minimum (RTK=5/6 is warning if missing)

# Flat-earth conversion constants
M_PER_DEG_LAT = 111319.5


class DaemonState(str, Enum):
    IDLE = "idle"
    LOADED = "loaded"
    ARMED = "armed"
    STAGING = "staging"
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"
    ERROR = "error"


class FlightDaemon:
    """Manages show playback for the swarm."""

    def __init__(self, tracker=None,
                 command_sender: CommandSender | None = None,
                 safety_monitor: SafetyMonitor | None = None,
                 on_event: Callable[[dict], Awaitable[None]] | None = None):
        self._tracker = tracker
        self._sender = command_sender
        self._safety = safety_monitor
        self._on_event = on_event

        self._show: ShowFile | None = None
        self._state = DaemonState.IDLE
        self._task: asyncio.Task | None = None
        self._start_time: float = 0.0
        self._pause_elapsed: float = 0.0
        self._tick_count: int = 0

    # --- Properties ---

    @property
    def state(self) -> DaemonState:
        return self._state

    @property
    def show(self) -> ShowFile | None:
        return self._show

    @property
    def elapsed_s(self) -> float:
        if self._state == DaemonState.RUNNING:
            return time.monotonic() - self._start_time
        if self._state == DaemonState.PAUSED:
            return self._pause_elapsed
        return 0.0

    # --- Lifecycle ---

    def load(self, path: str | Path) -> list[str]:
        """Load and validate a show file from disk."""
        data = json.loads(Path(path).read_text())
        show = ShowFile(**data)
        return self.load_show(show)

    def load_show(self, show: ShowFile) -> list[str]:
        """Load and validate an already-parsed show. Returns errors (empty=ok)."""
        errors = show.validate_timing()
        if errors:
            self._state = DaemonState.ERROR
            return errors
        self._show = show
        self._state = DaemonState.LOADED
        if self._safety:
            self._safety.clear()
        log.info("Show '%s' loaded: %d tracks, %.1fs duration",
                 show.name, len(show.tracks), show.duration_s)
        asyncio.ensure_future(self._emit_status())
        return []

    async def arm(self) -> list[dict]:
        """Pre-flight checks. Returns list of per-heli check results.

        Each result: {"heli_id": int, "ok": bool, "detail": str}
        """
        if self._state not in (DaemonState.LOADED, DaemonState.DONE):
            return [{"heli_id": 0, "ok": False,
                     "detail": f"Cannot arm in state {self._state}"}]
        if not self._show:
            return [{"heli_id": 0, "ok": False, "detail": "No show loaded"}]

        checks = []
        all_ok = True

        for track in self._show.tracks:
            sysid = 10 + track.heli_id
            heli_label = f"Heli{track.heli_id:02d}"

            if not self._tracker:
                checks.append({"heli_id": track.heli_id, "ok": False,
                               "detail": "No vehicle tracker"})
                all_ok = False
                continue

            v = self._tracker.get(sysid)
            if v is None:
                checks.append({"heli_id": track.heli_id, "ok": False,
                               "detail": "Not seen by telemetry"})
                all_ok = False
                continue

            issues = []

            # Online check
            if not v["online"]:
                issues.append("OFFLINE")

            # GPS fix check
            fix = v.get("gps_fix", 0)
            if fix < MIN_GPS_FIX:
                issues.append(f"No GPS fix (fix={fix})")
            elif fix < 5:
                # 3D fix but not RTK — warning, not blocker
                checks.append({"heli_id": track.heli_id, "ok": True,
                               "detail": f"Ready (GPS 3D, no RTK)"})

            # Flight mode check
            mode = v.get("flight_mode", "UNKNOWN")
            if mode != "GUIDED":
                issues.append(f"Not in GUIDED mode ({mode})")

            # Battery check
            batt = v.get("battery_pct")
            if batt is not None and batt < MIN_BATTERY_PCT:
                issues.append(f"Battery low ({batt}%)")

            if issues:
                checks.append({"heli_id": track.heli_id, "ok": False,
                               "detail": "; ".join(issues)})
                all_ok = False
            elif not any(c["heli_id"] == track.heli_id for c in checks):
                checks.append({"heli_id": track.heli_id, "ok": True,
                               "detail": "Ready"})

        if all_ok:
            self._state = DaemonState.ARMED
            log.info("Show armed — all %d helis ready", len(self._show.tracks))
        else:
            log.warning("Show arm failed — %d issues",
                        sum(1 for c in checks if not c["ok"]))

        # Broadcast readiness
        await self._emit_event({
            "type": "show_readiness",
            "checks": checks,
        })
        await self._emit_status()
        return checks

    async def go(self):
        """Start show: staging phase then playback."""
        if self._state != DaemonState.ARMED:
            raise RuntimeError(f"Cannot start in state {self._state}")
        self._state = DaemonState.STAGING
        self._task = asyncio.create_task(self._staging_then_playback())
        log.info("Show GO — entering staging phase")
        await self._emit_status()

    async def pause(self):
        """Pause playback — all helis hold current position."""
        if self._state != DaemonState.RUNNING:
            return
        self._pause_elapsed = time.monotonic() - self._start_time
        self._state = DaemonState.PAUSED
        log.info("Show PAUSED at %.1fs", self._pause_elapsed)
        await self._emit_status()

    async def resume(self):
        """Resume from pause."""
        if self._state != DaemonState.PAUSED:
            return
        self._start_time = time.monotonic() - self._pause_elapsed
        self._state = DaemonState.RUNNING
        log.info("Show RESUMED at %.1fs", self._pause_elapsed)
        await self._emit_status()

    async def stop(self):
        """Emergency stop — cancel playback, BRAKE all helis."""
        prev = self._state
        self._state = DaemonState.IDLE

        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        # Send BRAKE to all helis in the show
        if self._show and self._sender:
            for track in self._show.tracks:
                try:
                    self._sender.send_set_mode(track.heli_id, MODE_BRAKE)
                except Exception as e:
                    log.error("Failed to BRAKE Heli%02d: %s",
                              track.heli_id, e)

        if self._safety:
            self._safety.clear()

        log.warning("Show STOPPED from state %s", prev)
        await self._emit_status()

    # --- Staging ---

    async def _staging_then_playback(self):
        """Sequential takeoff → fly to start positions → run show."""
        try:
            await self._run_staging()
            if self._state != DaemonState.STAGING:
                return  # Cancelled or error
            self._state = DaemonState.RUNNING
            self._start_time = time.monotonic()
            self._tick_count = 0
            log.info("Staging complete — show RUNNING")
            await self._emit_status()
            await self._playback_loop()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._state = DaemonState.ERROR
            log.error("Flight daemon error: %s", e, exc_info=True)
            await self._emit_event({
                "type": "show_error",
                "message": str(e),
            })

    async def _run_staging(self):
        """Fly each heli from its current GPS position to its first waypoint.

        Sequential takeoff: one heli at a time, takeoff to staging altitude,
        then horizontal traverse to start position.
        """
        if not self._show or not self._tracker:
            return

        staging_targets: dict[int, dict] = {}  # heli_id → {start_ned, current_phase}

        for track in self._show.tracks:
            sysid = 10 + track.heli_id
            v = self._tracker.get(sysid)
            if not v:
                continue

            # Convert heli's current GPS to NED relative to show home
            current_n, current_e, current_d = self._gps_to_ned(
                v["lat"], v["lon"], v.get("alt_m", self._show.home_alt_m),
            )

            # Target: first waypoint position
            wp0 = track.waypoints[0]
            staging_alt_d = wp0.pos.d - STAGING_ALT_MARGIN  # Higher (more negative D)

            staging_targets[track.heli_id] = {
                "start_n": current_n, "start_e": current_e, "start_d": current_d,
                "target_n": wp0.pos.n, "target_e": wp0.pos.e, "target_d": wp0.pos.d,
                "staging_alt_d": staging_alt_d,
                "phase": "takeoff",  # takeoff → traverse → descend → done
                "arrived": False,
            }

        if not staging_targets:
            return

        # Sequential takeoff: process helis one at a time
        heli_order = sorted(staging_targets.keys())
        active_helis: set[int] = set()
        next_takeoff_idx = 0
        last_takeoff_time = 0.0

        while self._state == DaemonState.STAGING:
            now = time.monotonic()

            # Start next heli if enough time has passed
            if (next_takeoff_idx < len(heli_order) and
                    now - last_takeoff_time >= STAGING_TAKEOFF_DELAY):
                heli_id = heli_order[next_takeoff_idx]
                active_helis.add(heli_id)
                log.info("Staging: Heli%02d starting takeoff", heli_id)
                next_takeoff_idx += 1
                last_takeoff_time = now

            # Update each active heli
            all_arrived = True
            for heli_id in active_helis:
                st = staging_targets[heli_id]
                if st["arrived"]:
                    # Hold at target
                    await self._send_safe(
                        heli_id, st["target_n"], st["target_e"], st["target_d"],
                    )
                    continue

                all_arrived = False

                if st["phase"] == "takeoff":
                    # Climb to staging altitude above current position
                    await self._send_safe(
                        heli_id, st["start_n"], st["start_e"], st["staging_alt_d"],
                    )
                    # Check if at altitude
                    sysid = 10 + heli_id
                    v = self._tracker.get(sysid)
                    if v:
                        cn, ce, cd = self._gps_to_ned(
                            v["lat"], v["lon"], v.get("alt_m", 0))
                        if abs(cd - st["staging_alt_d"]) < STAGING_ARRIVAL_TOL:
                            st["phase"] = "traverse"
                            log.info("Staging: Heli%02d at altitude, traversing",
                                     heli_id)

                elif st["phase"] == "traverse":
                    # Fly horizontally to target position at staging altitude
                    await self._send_safe(
                        heli_id, st["target_n"], st["target_e"],
                        st["staging_alt_d"],
                    )
                    sysid = 10 + heli_id
                    v = self._tracker.get(sysid)
                    if v:
                        cn, ce, cd = self._gps_to_ned(
                            v["lat"], v["lon"], v.get("alt_m", 0))
                        horiz = math.sqrt(
                            (cn - st["target_n"]) ** 2 +
                            (ce - st["target_e"]) ** 2
                        )
                        if horiz < STAGING_ARRIVAL_TOL:
                            st["phase"] = "descend"
                            log.info("Staging: Heli%02d at position, descending",
                                     heli_id)

                elif st["phase"] == "descend":
                    # Descend to actual first waypoint altitude
                    await self._send_safe(
                        heli_id, st["target_n"], st["target_e"], st["target_d"],
                    )
                    sysid = 10 + heli_id
                    v = self._tracker.get(sysid)
                    if v:
                        cn, ce, cd = self._gps_to_ned(
                            v["lat"], v["lon"], v.get("alt_m", 0))
                        dist = math.sqrt(
                            (cn - st["target_n"]) ** 2 +
                            (ce - st["target_e"]) ** 2 +
                            (cd - st["target_d"]) ** 2
                        )
                        if dist < STAGING_ARRIVAL_TOL:
                            st["arrived"] = True
                            log.info("Staging: Heli%02d arrived at start position",
                                     heli_id)

            # Check if all helis have arrived
            if (next_takeoff_idx >= len(heli_order) and all_arrived and
                    all(staging_targets[h]["arrived"] for h in heli_order)):
                log.info("Staging complete — all helis in position")
                break

            # Status update every 1s
            if int(now * TICK_HZ) % TICK_HZ == 0:
                await self._emit_status()

            await asyncio.sleep(TICK_INTERVAL)

    # --- Playback ---

    async def _playback_loop(self):
        """Main playback loop — interpolate and stream targets at 20 Hz."""
        try:
            next_tick = time.monotonic()

            while self._state == DaemonState.RUNNING:
                t = self.elapsed_s

                if t >= self._show.duration_s:
                    self._state = DaemonState.DONE
                    log.info("Show COMPLETE (%.1fs)", t)
                    await self._emit_status()
                    break

                # Interpolate and send targets for all tracks
                for track in self._show.tracks:
                    target = self._interpolate(track, t)
                    if target:
                        await self._send_target(track.heli_id, target)

                # Periodic status (every 1s)
                self._tick_count += 1
                if self._tick_count % TICK_HZ == 0:
                    await self._emit_status()

                    # Check for offline helis during show
                    for track in self._show.tracks:
                        sysid = 10 + track.heli_id
                        v = self._tracker.get(sysid) if self._tracker else None
                        if v and not v["online"]:
                            await self._emit_event({
                                "type": "show_error",
                                "message": f"Heli{track.heli_id:02d} went OFFLINE during show",
                            })

                # Fixed-rate timing (no drift)
                next_tick += TICK_INTERVAL
                sleep_time = next_tick - time.monotonic()
                if sleep_time > 0:
                    await asyncio.sleep(sleep_time)
                else:
                    next_tick = time.monotonic()  # Reset if we fell behind

        except asyncio.CancelledError:
            pass

    async def _send_target(self, heli_id: int, target: dict):
        """Send interpolated target through the safety monitor."""
        pos = target["pos"]
        vel = target["vel"]

        if self._safety:
            sent = await self._safety.check_and_send(
                heli_id,
                pos.n, pos.e, pos.d,
                vel.n, vel.e, vel.d,
            )
            if not sent:
                log.debug("Heli%02d target blocked by safety", heli_id)
        elif self._sender:
            # No safety monitor — send directly (testing only)
            self._sender.send_position_target(
                heli_id, pos.n, pos.e, pos.d, vel.n, vel.e, vel.d,
            )

    async def _send_safe(self, heli_id: int,
                          n: float, e: float, d: float,
                          vn: float = 0, ve: float = 0, vd: float = 0):
        """Send a position target through safety monitor (staging helper)."""
        if self._safety:
            await self._safety.check_and_send(heli_id, n, e, d, vn, ve, vd)
        elif self._sender:
            self._sender.send_position_target(heli_id, n, e, d, vn, ve, vd)

    # --- Interpolation ---

    def _interpolate(self, track: HeliTrack, t: float) -> dict | None:
        """Linear interpolation between surrounding waypoints.

        TODO: Replace with jerk-limited trajectory (Ruckig) or CatmullRom spline.
        """
        wps = track.waypoints

        # Before first waypoint — hold at first position
        if t <= wps[0].t:
            return {"pos": wps[0].pos, "vel": Vec3(n=0, e=0, d=0)}

        for i in range(len(wps) - 1):
            if wps[i].t <= t <= wps[i + 1].t:
                # Handle hold time
                if wps[i].hold_s > 0 and t <= wps[i].t + wps[i].hold_s:
                    return {"pos": wps[i].pos, "vel": Vec3(n=0, e=0, d=0)}

                # Linear interpolation
                dt = wps[i + 1].t - wps[i].t
                if dt <= 0:
                    return {"pos": wps[i + 1].pos, "vel": Vec3(n=0, e=0, d=0)}
                frac = (t - wps[i].t) / dt
                p0, p1 = wps[i].pos, wps[i + 1].pos
                pos = Vec3(
                    n=p0.n + (p1.n - p0.n) * frac,
                    e=p0.e + (p1.e - p0.e) * frac,
                    d=p0.d + (p1.d - p0.d) * frac,
                )
                vel = Vec3(
                    n=(p1.n - p0.n) / dt,
                    e=(p1.e - p0.e) / dt,
                    d=(p1.d - p0.d) / dt,
                )
                return {"pos": pos, "vel": vel}

        # Past last waypoint — hold final position
        return {"pos": wps[-1].pos, "vel": Vec3(n=0, e=0, d=0)}

    # --- GPS / NED conversion ---

    def _gps_to_ned(self, lat: float, lon: float, alt_m: float
                     ) -> tuple[float, float, float]:
        """Convert GPS coordinates to NED meters relative to show home.

        Uses flat-earth approximation (adequate for <500m radius).
        """
        if not self._show:
            return 0, 0, 0
        d_lat = lat - self._show.home_lat
        d_lon = lon - self._show.home_lon
        n = d_lat * M_PER_DEG_LAT
        e = d_lon * M_PER_DEG_LAT * math.cos(math.radians(self._show.home_lat))
        d = -(alt_m - self._show.home_alt_m)  # NED: down is positive
        return n, e, d

    # --- Events ---

    async def _emit_status(self):
        """Broadcast current show status to WebSocket clients."""
        await self._emit_event({
            "type": "show_status",
            "state": self._state.value,
            "elapsed_s": round(self.elapsed_s, 1),
            "duration_s": self._show.duration_s if self._show else 0,
            "show_name": self._show.name if self._show else None,
        })

    async def _emit_event(self, event: dict):
        """Send an event to WebSocket broadcast."""
        if self._on_event:
            try:
                await self._on_event(event)
            except Exception as e:
                log.debug("Event broadcast failed: %s", e)
