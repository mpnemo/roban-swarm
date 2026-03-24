"""Flight daemon — full field operations lifecycle.

State machine:
    IDLE → LOADED → LINEUP_READY → PREFLIGHT_OK → ARMING → SPOOLING
    → TAKING_OFF → STAGING → RUNNING ⇄ PAUSED → LANDING → DONE

    Any state → RTL (emergency — ArduPilot takes over)
    Any state → IDLE (via stop() — BRAKE all)

The daemon orchestrates: lineup capture (GPS origin), arm/spool/takeoff,
staging to show start positions, show playback at 20Hz, controlled landing
with staggered altitudes, and emergency RTL with altitude separation.
"""

import asyncio
import json
import logging
import math
import time
from enum import Enum
from pathlib import Path
from typing import Callable, Awaitable

from .show_format import ShowFile, HeliTrack, Vec3, LineupData, HeliPhase
from .safety_monitor import SafetyMonitor
from mavlink.command_sender import CommandSender, MODE_BRAKE, MODE_GUIDED, MODE_RTL

log = logging.getLogger("roban.flight")

# --- Constants ---
TICK_HZ = 20
TICK_INTERVAL = 1.0 / TICK_HZ

# Startup
SPOOL_TIME_S = 8.0              # TradiHeli rotor spool-up after arm
TAKEOFF_DELAY_S = 3.0           # Between sequential takeoffs
HOVER_ALT_M = 5.0               # Default takeoff hover altitude
ARM_TIMEOUT_S = 5.0             # Wait for arm confirmation
MODE_TIMEOUT_S = 3.0            # Wait for mode change confirmation

# Staging
STAGING_ARRIVAL_TOL = 1.0       # Meters — close enough to start position

# Landing
RETURN_BASE_ALT_M = 8.0         # Base altitude for return flight
RETURN_ALT_STEP_M = 3.0         # Per-heli altitude step during return
LANDING_DESCENT_RATE = 0.5      # m/s target descent rate
LANDING_DETECT_ALT_M = 0.3      # Below this = landed
LANDING_DETECT_TIME_S = 1.5     # Hysteresis

# RTL
RTL_BASE_ALT_CM = 1500          # 15m base RTL altitude
RTL_STEP_CM = 300               # +3m per heli

# GPS
MIN_RTK_FIX = 5                 # RTK Float minimum for lineup
MIN_GPS_FIX = 3                 # 3D fix minimum for arm
MIN_BATTERY_PCT = 20            # Minimum battery for arm

# NED
M_PER_DEG_LAT = 111319.5


class DaemonState(str, Enum):
    IDLE = "idle"
    LOADED = "loaded"
    LINEUP_READY = "lineup_ready"
    PREFLIGHT_OK = "preflight_ok"
    ARMING = "arming"
    SPOOLING = "spooling"
    TAKING_OFF = "taking_off"
    STAGING = "staging"
    RUNNING = "running"
    PAUSED = "paused"
    LANDING = "landing"
    DONE = "done"
    RTL = "rtl"
    ERROR = "error"


class FlightDaemon:
    """Manages the complete flight operations lifecycle."""

    def __init__(self, tracker=None,
                 command_sender: CommandSender | None = None,
                 safety_monitor: SafetyMonitor | None = None,
                 on_event: Callable[[dict], Awaitable[None]] | None = None):
        self._tracker = tracker
        self._sender = command_sender
        self._safety = safety_monitor
        self._on_event = on_event

        self._show: ShowFile | None = None
        self._lineup: LineupData | None = None
        self._state = DaemonState.IDLE
        self._task: asyncio.Task | None = None
        self._start_time: float = 0.0
        self._pause_elapsed: float = 0.0
        self._tick_count: int = 0

        # Per-heli phase tracking for dashboard
        self._heli_phases: dict[int, HeliPhase] = {}

    # --- Properties ---

    @property
    def state(self) -> DaemonState:
        return self._state

    @property
    def show(self) -> ShowFile | None:
        return self._show

    @property
    def lineup(self) -> LineupData | None:
        return self._lineup

    @property
    def elapsed_s(self) -> float:
        if self._state == DaemonState.RUNNING:
            return time.monotonic() - self._start_time
        if self._state == DaemonState.PAUSED:
            return self._pause_elapsed
        return 0.0

    @property
    def heli_phases(self) -> dict[int, str]:
        return {hid: p.value for hid, p in self._heli_phases.items()}

    # ================================================================
    # LIFECYCLE: Load → Lineup → Preflight → Launch → Go → Land
    # ================================================================

    def load(self, path: str | Path) -> list[str]:
        """Load a show file from disk."""
        data = json.loads(Path(path).read_text())
        show = ShowFile(**data)
        return self.load_show(show)

    def load_show(self, show: ShowFile) -> list[str]:
        """Load and validate a show. Returns errors (empty=ok)."""
        errors = show.validate_timing()
        if errors:
            self._state = DaemonState.ERROR
            return errors
        self._show = show
        self._lineup = None  # Reset lineup when new show loaded
        self._state = DaemonState.LOADED
        self._heli_phases = {t.heli_id: HeliPhase.IDLE for t in show.tracks}
        if self._safety:
            self._safety.clear()
        log.info("Show '%s' loaded: %d tracks, %.1fs",
                 show.name, len(show.tracks), show.duration_s)
        asyncio.ensure_future(self._emit_status())
        return []

    async def capture_lineup(self) -> dict:
        """Capture GPS positions of all show helis and compute NED origin.

        Returns {"ok": bool, "lineup": {...}, "errors": [...]}
        """
        if not self._show:
            return {"ok": False, "errors": ["No show loaded"]}
        if not self._tracker:
            return {"ok": False, "errors": ["No vehicle tracker"]}

        errors = []
        positions = {}  # heli_id → (lat, lon, alt)

        for track in self._show.tracks:
            sysid = 10 + track.heli_id
            v = self._tracker.get(sysid)
            if v is None:
                errors.append(f"Heli{track.heli_id:02d}: not seen")
                continue
            if not v["online"]:
                errors.append(f"Heli{track.heli_id:02d}: offline")
                continue
            fix = v.get("gps_fix", 0)
            if fix < MIN_RTK_FIX:
                fix_names = {0: "NoFix", 1: "NoFix", 2: "2D", 3: "3D", 4: "DGPS", 5: "Float", 6: "RTK"}
                errors.append(f"Heli{track.heli_id:02d}: GPS {fix_names.get(fix, fix)} (need RTK Float+)")
                continue
            lat, lon = v["lat"], v["lon"]
            if abs(lat) < 0.001 and abs(lon) < 0.001:
                errors.append(f"Heli{track.heli_id:02d}: GPS position invalid (0,0)")
                continue
            positions[track.heli_id] = (lat, lon, v.get("alt_m", 0))

        if errors:
            return {"ok": False, "errors": errors}

        # Compute origin as centroid
        lats = [p[0] for p in positions.values()]
        lons = [p[1] for p in positions.values()]
        alts = [p[2] for p in positions.values()]
        origin_lat = sum(lats) / len(lats)
        origin_lon = sum(lons) / len(lons)
        origin_alt = sum(alts) / len(alts)

        # Convert each position to NED relative to origin
        home_positions = {}
        for heli_id, (lat, lon, alt) in positions.items():
            n, e, d = self._gps_to_ned_static(lat, lon, alt, origin_lat, origin_lon, origin_alt)
            home_positions[heli_id] = Vec3(n=round(n, 3), e=round(e, 3), d=round(d, 3))

        self._lineup = LineupData(
            origin_lat=origin_lat,
            origin_lon=origin_lon,
            origin_alt_m=origin_alt,
            home_positions=home_positions,
        )

        # Override show's home with computed origin
        self._show.home_lat = origin_lat
        self._show.home_lon = origin_lon
        self._show.home_alt_m = origin_alt

        self._state = DaemonState.LINEUP_READY
        log.info("Lineup captured: origin=%.7f,%.7f alt=%.1fm, %d helis",
                 origin_lat, origin_lon, origin_alt, len(home_positions))

        await self._emit_event({
            "type": "lineup_captured",
            "lineup": self._lineup.to_dict(),
        })
        await self._emit_status()

        return {"ok": True, "lineup": self._lineup.to_dict(), "errors": []}

    async def preflight(self) -> list[dict]:
        """Run preflight checks including RTL_ALT verification.

        Returns list of {"heli_id": int, "ok": bool, "detail": str, "fixes": [...]}
        """
        if self._state not in (DaemonState.LINEUP_READY, DaemonState.PREFLIGHT_OK):
            return [{"heli_id": 0, "ok": False, "detail": f"Cannot preflight in state {self._state}"}]
        if not self._show or not self._lineup:
            return [{"heli_id": 0, "ok": False, "detail": "Show or lineup not ready"}]

        checks = []
        all_ok = True
        heli_ids = sorted(self._show.get_heli_ids())

        for idx, heli_id in enumerate(heli_ids):
            sysid = 10 + heli_id
            v = self._tracker.get(sysid) if self._tracker else None
            issues = []
            fixes = []

            if v is None:
                checks.append({"heli_id": heli_id, "ok": False,
                               "detail": "Not seen", "fixes": []})
                all_ok = False
                continue

            if not v["online"]:
                issues.append("OFFLINE")

            # GPS check
            fix = v.get("gps_fix", 0)
            if fix < MIN_GPS_FIX:
                issues.append(f"GPS fix={fix} (need ≥3)")
            elif fix < MIN_RTK_FIX:
                issues.append(f"GPS {fix} (recommend RTK Float+)")

            # Battery
            batt = v.get("battery_pct")
            if batt is not None and batt < MIN_BATTERY_PCT:
                issues.append(f"Battery {batt}% (need ≥{MIN_BATTERY_PCT}%)")

            # Check RTL_ALT — must be staggered
            expected_rtl_alt = RTL_BASE_ALT_CM + (idx * RTL_STEP_CM)
            if self._sender:
                actual_rtl = await asyncio.to_thread(
                    self._sender.read_param, heli_id, "RTL_ALT"
                )
                if actual_rtl is None:
                    issues.append("RTL_ALT: no response")
                elif int(actual_rtl) != expected_rtl_alt:
                    issues.append(f"RTL_ALT={int(actual_rtl)} (expect {expected_rtl_alt})")
                    fixes.append(("RTL_ALT", expected_rtl_alt))

            if issues:
                checks.append({"heli_id": heli_id, "ok": False,
                               "detail": "; ".join(issues), "fixes": fixes})
                all_ok = False
            else:
                checks.append({"heli_id": heli_id, "ok": True,
                               "detail": "Ready", "fixes": []})

        if all_ok:
            self._state = DaemonState.PREFLIGHT_OK
            log.info("Preflight OK — all %d helis ready", len(heli_ids))
        else:
            log.warning("Preflight issues — %d failures",
                        sum(1 for c in checks if not c["ok"]))

        await self._emit_event({"type": "preflight_result", "checks": checks})
        await self._emit_status()
        return checks

    async def fix_preflight(self) -> list[dict]:
        """Auto-fix preflight issues (set RTL_ALT, etc.)."""
        if not self._show or not self._sender:
            return [{"heli_id": 0, "ok": False, "detail": "Not ready"}]

        heli_ids = sorted(self._show.get_heli_ids())
        results = []

        for idx, heli_id in enumerate(heli_ids):
            expected_rtl_alt = RTL_BASE_ALT_CM + (idx * RTL_STEP_CM)
            ok = await asyncio.to_thread(
                self._sender.set_rtl_alt, heli_id, expected_rtl_alt
            )
            results.append({
                "heli_id": heli_id,
                "param": "RTL_ALT",
                "value": expected_rtl_alt,
                "ok": ok,
            })
            log.info("Set RTL_ALT=%d on Heli%02d: %s",
                     expected_rtl_alt, heli_id, "OK" if ok else "FAIL")

        return results

    # ================================================================
    # LAUNCH: Automated arm → spool → takeoff → stage sequence
    # ================================================================

    async def launch(self):
        """Full automated launch: arm → spool → takeoff → stage → hold."""
        if self._state != DaemonState.PREFLIGHT_OK:
            raise RuntimeError(f"Cannot launch in state {self._state}")
        self._task = asyncio.create_task(self._launch_sequence())
        await self._emit_status()

    async def _launch_sequence(self):
        """Automated launch sequence."""
        try:
            heli_ids = sorted(self._show.get_heli_ids())

            # --- Phase 1: ARM ---
            self._state = DaemonState.ARMING
            await self._emit_status()

            for heli_id in heli_ids:
                self._heli_phases[heli_id] = HeliPhase.ARMING
                await self._emit_phase_progress()

                # Set GUIDED mode
                self._sender.send_set_mode(heli_id, MODE_GUIDED)
                if not await self._wait_for_mode(heli_id, "GUIDED", MODE_TIMEOUT_S):
                    raise RuntimeError(f"Heli{heli_id:02d}: failed to enter GUIDED mode")

                # ARM
                self._sender.send_arm(heli_id, arm=True)
                if not await self._wait_for_armed(heli_id, True, ARM_TIMEOUT_S):
                    # Disarm any already-armed helis
                    for prev in heli_ids:
                        if prev == heli_id:
                            break
                        self._sender.send_disarm(prev)
                    raise RuntimeError(f"Heli{heli_id:02d}: failed to arm")

                log.info("Heli%02d armed", heli_id)

            # --- Phase 2: SPOOL ---
            self._state = DaemonState.SPOOLING
            for heli_id in heli_ids:
                self._heli_phases[heli_id] = HeliPhase.SPOOLING
            await self._emit_phase_progress()
            log.info("Spooling up (%.0fs)...", SPOOL_TIME_S)
            await asyncio.sleep(SPOOL_TIME_S)

            # --- Phase 3: TAKEOFF ---
            self._state = DaemonState.TAKING_OFF
            await self._emit_status()
            await self._sequential_takeoff(heli_ids)

            # --- Phase 4: STAGE ---
            self._state = DaemonState.STAGING
            await self._emit_status()
            await self._fly_to_start_positions(heli_ids)

            # Hold at start positions — wait for GO
            for heli_id in heli_ids:
                self._heli_phases[heli_id] = HeliPhase.AT_START
            await self._emit_phase_progress()
            log.info("All helis at start positions — waiting for GO")
            await self._emit_status()

        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._state = DaemonState.ERROR
            log.error("Launch failed: %s", e)
            await self._emit_event({"type": "show_error", "message": str(e)})
            await self._emit_status()

    async def _sequential_takeoff(self, heli_ids: list[int]):
        """Sequential takeoff to hover altitude above home positions."""
        for heli_id in heli_ids:
            if self._state != DaemonState.TAKING_OFF:
                return
            self._heli_phases[heli_id] = HeliPhase.TAKING_OFF
            await self._emit_phase_progress()

            home = self._lineup.home_positions[heli_id]
            target_d = -(HOVER_ALT_M)  # NED: negative = up

            log.info("Heli%02d taking off to %.1fm", heli_id, HOVER_ALT_M)

            # Stream position target until at altitude
            deadline = time.monotonic() + 30  # 30s max for takeoff
            while self._state == DaemonState.TAKING_OFF:
                await self._send_safe(heli_id, home.n, home.e, target_d)

                # Check altitude from telemetry
                v = self._tracker.get(10 + heli_id) if self._tracker else None
                if v and v.get("relative_alt_m", 0) >= (HOVER_ALT_M - 1.0):
                    log.info("Heli%02d at hover altitude", heli_id)
                    break

                if time.monotonic() > deadline:
                    raise RuntimeError(f"Heli{heli_id:02d}: takeoff timeout")

                await asyncio.sleep(TICK_INTERVAL)

            # Delay before next heli
            if heli_id != heli_ids[-1]:
                await asyncio.sleep(TAKEOFF_DELAY_S)

    async def _fly_to_start_positions(self, heli_ids: list[int]):
        """Fly all helis from hover to their show start positions."""
        targets = {}
        for heli_id in heli_ids:
            track = next(t for t in self._show.tracks if t.heli_id == heli_id)
            wp0 = track.waypoints[0]
            targets[heli_id] = wp0.pos
            self._heli_phases[heli_id] = HeliPhase.TRAVERSING

        await self._emit_phase_progress()

        # Fly all simultaneously
        deadline = time.monotonic() + 60  # 60s max for staging
        while self._state == DaemonState.STAGING:
            all_arrived = True
            for heli_id in heli_ids:
                t = targets[heli_id]
                await self._send_safe(heli_id, t.n, t.e, t.d)

                v = self._tracker.get(10 + heli_id) if self._tracker else None
                if v:
                    cn, ce, cd = self._gps_to_ned(v["lat"], v["lon"], v.get("alt_m", 0))
                    dist = math.sqrt((cn - t.n)**2 + (ce - t.e)**2 + (cd - t.d)**2)
                    if dist > STAGING_ARRIVAL_TOL:
                        all_arrived = False

            if all_arrived:
                break
            if time.monotonic() > deadline:
                log.warning("Staging timeout — proceeding anyway")
                break

            await asyncio.sleep(TICK_INTERVAL)

    # ================================================================
    # SHOW PLAYBACK
    # ================================================================

    async def go(self):
        """Start show playback from staging hold."""
        if self._state != DaemonState.STAGING:
            raise RuntimeError(f"Cannot start in state {self._state}")
        self._state = DaemonState.RUNNING
        self._start_time = time.monotonic()
        self._tick_count = 0
        for heli_id in self._heli_phases:
            self._heli_phases[heli_id] = HeliPhase.RUNNING
        self._task = asyncio.create_task(self._playback_then_land())
        log.info("Show STARTED")
        await self._emit_status()

    async def _playback_then_land(self):
        """Run show, then auto-transition to landing."""
        try:
            await self._playback_loop()
            if self._state == DaemonState.DONE:
                # Auto-land after show completes
                await self.land()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._state = DaemonState.ERROR
            log.error("Playback error: %s", e, exc_info=True)
            await self._emit_event({"type": "show_error", "message": str(e)})

    async def _playback_loop(self):
        """Main playback loop at 20Hz."""
        next_tick = time.monotonic()

        while self._state == DaemonState.RUNNING:
            t = self.elapsed_s

            if t >= self._show.duration_s:
                self._state = DaemonState.DONE
                log.info("Show COMPLETE (%.1fs)", t)
                await self._emit_status()
                break

            for track in self._show.tracks:
                target = self._interpolate(track, t)
                if target:
                    await self._send_target(track.heli_id, target)

            self._tick_count += 1
            if self._tick_count % TICK_HZ == 0:
                await self._emit_status()

            next_tick += TICK_INTERVAL
            sleep_time = next_tick - time.monotonic()
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)
            else:
                next_tick = time.monotonic()

    async def pause(self):
        if self._state != DaemonState.RUNNING:
            return
        self._pause_elapsed = time.monotonic() - self._start_time
        self._state = DaemonState.PAUSED
        log.info("Show PAUSED at %.1fs", self._pause_elapsed)
        await self._emit_status()

    async def resume(self):
        if self._state != DaemonState.PAUSED:
            return
        self._start_time = time.monotonic() - self._pause_elapsed
        self._state = DaemonState.RUNNING
        log.info("Show RESUMED")
        await self._emit_status()

    # ================================================================
    # LANDING
    # ================================================================

    async def land(self):
        """Controlled return to home + sequential landing."""
        if self._state not in (DaemonState.RUNNING, DaemonState.PAUSED,
                                DaemonState.DONE, DaemonState.STAGING):
            raise RuntimeError(f"Cannot land in state {self._state}")

        # Cancel any running task
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        self._state = DaemonState.LANDING
        self._task = asyncio.create_task(self._landing_sequence())
        await self._emit_status()

    async def _landing_sequence(self):
        """Return to home with staggered altitudes, then sequential landing."""
        try:
            if not self._lineup or not self._show:
                return

            heli_ids = sorted(self._show.get_heli_ids())

            # Phase 1: Return to home at staggered altitudes
            log.info("Landing phase 1: return to home positions")
            for idx, heli_id in enumerate(heli_ids):
                self._heli_phases[heli_id] = HeliPhase.RETURNING
            await self._emit_phase_progress()

            return_alts = {}
            for idx, heli_id in enumerate(heli_ids):
                return_alts[heli_id] = -(RETURN_BASE_ALT_M + idx * RETURN_ALT_STEP_M)

            # Fly all simultaneously to home positions at staggered altitudes
            deadline = time.monotonic() + 60
            while self._state == DaemonState.LANDING:
                all_home = True
                for heli_id in heli_ids:
                    home = self._lineup.home_positions[heli_id]
                    await self._send_safe(heli_id, home.n, home.e, return_alts[heli_id])

                    v = self._tracker.get(10 + heli_id) if self._tracker else None
                    if v:
                        cn, ce, _ = self._gps_to_ned(v["lat"], v["lon"], v.get("alt_m", 0))
                        horiz = math.sqrt((cn - home.n)**2 + (ce - home.e)**2)
                        if horiz > 2.0:
                            all_home = False

                if all_home:
                    break
                if time.monotonic() > deadline:
                    log.warning("Return timeout — proceeding to landing")
                    break
                await asyncio.sleep(TICK_INTERVAL)

            # Phase 2: Sequential landing (highest altitude first = last index first)
            log.info("Landing phase 2: sequential descent")
            for idx in reversed(range(len(heli_ids))):
                heli_id = heli_ids[idx]
                if self._state != DaemonState.LANDING:
                    break

                self._heli_phases[heli_id] = HeliPhase.DESCENDING
                await self._emit_phase_progress()

                home = self._lineup.home_positions[heli_id]
                log.info("Heli%02d descending to ground", heli_id)

                # Gradual descent
                landed_since = None
                target_d = return_alts[heli_id]
                deadline = time.monotonic() + 45

                while self._state == DaemonState.LANDING:
                    # Slowly lower target altitude
                    target_d += LANDING_DESCENT_RATE * TICK_INTERVAL
                    if target_d > 0:
                        target_d = 0  # Don't command below ground

                    await self._send_safe(heli_id, home.n, home.e, target_d)

                    # Check if landed
                    v = self._tracker.get(10 + heli_id) if self._tracker else None
                    if v:
                        rel_alt = v.get("relative_alt_m", 10)
                        if rel_alt < LANDING_DETECT_ALT_M:
                            if landed_since is None:
                                landed_since = time.monotonic()
                            elif time.monotonic() - landed_since >= LANDING_DETECT_TIME_S:
                                # Landed — disarm
                                self._sender.send_disarm(heli_id)
                                self._heli_phases[heli_id] = HeliPhase.LANDED
                                log.info("Heli%02d LANDED and disarmed", heli_id)
                                await self._emit_phase_progress()
                                break
                        else:
                            landed_since = None

                    if time.monotonic() > deadline:
                        log.warning("Heli%02d landing timeout — disarming", heli_id)
                        self._sender.send_disarm(heli_id)
                        self._heli_phases[heli_id] = HeliPhase.LANDED
                        break

                    await asyncio.sleep(TICK_INTERVAL)

                # Continue holding other helis at their return altitude
                for other_id in heli_ids:
                    if other_id != heli_id and self._heli_phases.get(other_id) != HeliPhase.LANDED:
                        other_home = self._lineup.home_positions[other_id]
                        await self._send_safe(other_id, other_home.n, other_home.e,
                                              return_alts[other_id])

            self._state = DaemonState.DONE
            log.info("All helis landed — show complete")
            await self._emit_status()

        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._state = DaemonState.ERROR
            log.error("Landing error: %s", e, exc_info=True)
            await self._emit_event({"type": "show_error", "message": str(e)})

    # ================================================================
    # EMERGENCY
    # ================================================================

    async def rtl_all(self):
        """Emergency RTL — set staggered RTL_ALT, switch all to RTL mode."""
        if not self._show or not self._sender:
            return

        # Cancel any running task
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        heli_ids = sorted(self._show.get_heli_ids())

        for idx, heli_id in enumerate(heli_ids):
            alt_cm = RTL_BASE_ALT_CM + (idx * RTL_STEP_CM)
            # Set staggered RTL altitude (blocking — run in thread)
            await asyncio.to_thread(self._sender.set_rtl_alt, heli_id, alt_cm)
            # Switch to RTL
            self._sender.send_rtl(heli_id)
            self._heli_phases[heli_id] = HeliPhase.RTL
            log.warning("Heli%02d → RTL at %dm", heli_id, alt_cm // 100)

        self._state = DaemonState.RTL
        log.warning("RTL ALL — ArduPilot in control")
        await self._emit_event({"type": "rtl_triggered", "heli_ids": heli_ids})
        await self._emit_status()

    async def stop(self):
        """Emergency stop — BRAKE all helis."""
        prev = self._state
        self._state = DaemonState.IDLE

        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        if self._show and self._sender:
            for track in self._show.tracks:
                try:
                    self._sender.send_set_mode(track.heli_id, MODE_BRAKE)
                except Exception as e:
                    log.error("Failed to BRAKE Heli%02d: %s", track.heli_id, e)

        if self._safety:
            self._safety.clear()

        self._heli_phases = {hid: HeliPhase.IDLE for hid in self._heli_phases}
        log.warning("STOP from state %s — all helis BRAKE", prev)
        await self._emit_status()

    # ================================================================
    # HELPERS
    # ================================================================

    async def _wait_for_armed(self, heli_id: int, armed: bool, timeout: float) -> bool:
        """Wait for arm/disarm confirmation from telemetry."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            v = self._tracker.get(10 + heli_id) if self._tracker else None
            if v and v.get("armed") == armed:
                return True
            await asyncio.sleep(0.2)
        return False

    async def _wait_for_mode(self, heli_id: int, mode_name: str, timeout: float) -> bool:
        """Wait for flight mode confirmation from telemetry."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            v = self._tracker.get(10 + heli_id) if self._tracker else None
            if v and v.get("flight_mode") == mode_name:
                return True
            await asyncio.sleep(0.2)
        return False

    async def _send_target(self, heli_id: int, target: dict):
        """Send interpolated target through safety monitor."""
        pos, vel = target["pos"], target["vel"]
        if self._safety:
            await self._safety.check_and_send(
                heli_id, pos.n, pos.e, pos.d, vel.n, vel.e, vel.d)
        elif self._sender:
            self._sender.send_position_target(
                heli_id, pos.n, pos.e, pos.d, vel.n, vel.e, vel.d)

    async def _send_safe(self, heli_id: int,
                          n: float, e: float, d: float,
                          vn: float = 0, ve: float = 0, vd: float = 0):
        """Send position target through safety monitor."""
        if self._safety:
            await self._safety.check_and_send(heli_id, n, e, d, vn, ve, vd)
        elif self._sender:
            self._sender.send_position_target(heli_id, n, e, d, vn, ve, vd)

    def _interpolate(self, track: HeliTrack, t: float) -> dict | None:
        """Linear interpolation between waypoints."""
        wps = track.waypoints
        if t <= wps[0].t:
            return {"pos": wps[0].pos, "vel": Vec3(n=0, e=0, d=0)}

        for i in range(len(wps) - 1):
            if wps[i].t <= t <= wps[i + 1].t:
                if wps[i].hold_s > 0 and t <= wps[i].t + wps[i].hold_s:
                    return {"pos": wps[i].pos, "vel": Vec3(n=0, e=0, d=0)}
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

        return {"pos": wps[-1].pos, "vel": Vec3(n=0, e=0, d=0)}

    def _gps_to_ned(self, lat: float, lon: float, alt_m: float
                     ) -> tuple[float, float, float]:
        """Convert GPS to NED relative to show home (lineup origin)."""
        if not self._show:
            return 0, 0, 0
        return self._gps_to_ned_static(
            lat, lon, alt_m,
            self._show.home_lat, self._show.home_lon, self._show.home_alt_m,
        )

    @staticmethod
    def _gps_to_ned_static(lat, lon, alt, ref_lat, ref_lon, ref_alt):
        n = (lat - ref_lat) * M_PER_DEG_LAT
        e = (lon - ref_lon) * M_PER_DEG_LAT * math.cos(math.radians(ref_lat))
        d = -(alt - ref_alt)
        return n, e, d

    # --- Events ---

    async def _emit_status(self):
        await self._emit_event({
            "type": "show_status",
            "state": self._state.value,
            "elapsed_s": round(self.elapsed_s, 1),
            "duration_s": self._show.duration_s if self._show else 0,
            "show_name": self._show.name if self._show else None,
            "heli_phases": self.heli_phases,
        })

    async def _emit_phase_progress(self):
        await self._emit_event({
            "type": "phase_progress",
            "state": self._state.value,
            "heli_phases": self.heli_phases,
        })

    async def _emit_event(self, event: dict):
        if self._on_event:
            try:
                await self._on_event(event)
            except Exception as e:
                log.debug("Event broadcast failed: %s", e)
