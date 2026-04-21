"""Show file schema — Pydantic models for drone swarm choreography files.

A show file is a JSON document describing a timed sequence of waypoints
for one or more helicopters, with per-heli flight style parameters that
constrain the trajectory planner (jerk limiting, speed, accel, bank).

See docs/show_file_spec.md for the full specification.
"""

from __future__ import annotations
import time
from enum import Enum
from pydantic import BaseModel, Field
from typing import Optional


class HeliPhase(str, Enum):
    """Per-heli operational phase during flight operations."""
    IDLE = "idle"
    ARMING = "arming"
    SPOOLING = "spooling"
    TAKING_OFF = "taking_off"
    TRAVERSING = "traversing"     # Flying to show start position
    AT_START = "at_start"         # Holding at start position, ready for GO
    RUNNING = "running"           # Show playback active
    RETURNING = "returning"       # Flying back to home position
    DESCENDING = "descending"     # Landing descent
    LANDED = "landed"             # On ground, disarmed
    RTL = "rtl"                   # ArduPilot RTL active
    ERROR = "error"


class LineupData(BaseModel):
    """Captured lineup positions and computed NED origin.

    Created by capture_lineup() — stores the real-world reference frame
    for the show. The origin becomes the NED (0,0,0) point, and each
    heli's GPS position at lineup time becomes its home/RTL position.
    """
    origin_lat: float = Field(description="Computed origin latitude (centroid)")
    origin_lon: float = Field(description="Computed origin longitude (centroid)")
    origin_alt_m: float = Field(description="Computed origin altitude AMSL (m)")
    timestamp: float = Field(default_factory=time.time, description="Capture time (epoch)")
    home_positions: dict[int, Vec3] = Field(
        description="Per-heli home position in NED meters relative to origin. "
                    "Key = heli_id. These are the takeoff/landing/RTL positions.",
    )

    def to_dict(self) -> dict:
        return {
            "origin_lat": self.origin_lat,
            "origin_lon": self.origin_lon,
            "origin_alt_m": self.origin_alt_m,
            "timestamp": self.timestamp,
            "home_positions": {
                hid: {"n": p.n, "e": p.e, "d": p.d}
                for hid, p in self.home_positions.items()
            },
        }


class Vec3(BaseModel):
    """3D position in meters, NED frame relative to home."""
    n: float = Field(description="North (m)")
    e: float = Field(description="East (m)")
    d: float = Field(description="Down (m), negative = up")


class Waypoint(BaseModel):
    """A timed position target for one heli."""
    t: float = Field(ge=0, description="Time from show start (seconds)")
    pos: Vec3 = Field(description="Target position, NED meters from home")
    vel: Optional[Vec3] = Field(
        default=None,
        description="Optional velocity hint (m/s) for smooth passing — "
                    "if omitted, trajectory planner computes from neighbors",
    )
    hold_s: float = Field(
        default=0,
        ge=0,
        description="Hold at this waypoint for N seconds before moving on",
    )


class HeliStyle(BaseModel):
    """Per-heli flight dynamics constraints for the trajectory planner."""
    max_speed: float = Field(default=5.0, gt=0, description="Max ground speed (m/s)")
    max_accel: float = Field(default=2.0, gt=0, description="Max acceleration (m/s²)")
    max_jerk: float = Field(default=5.0, gt=0, description="Max jerk (m/s³)")
    angle_max_deg: float = Field(
        default=30.0, gt=0, le=60,
        description="Max lean angle (degrees) — maps to ArduPilot ANGLE_MAX",
    )
    corner_radius: float = Field(
        default=2.0, ge=0,
        description="Min turning radius (m) — 0 for sharp corners",
    )


class HeliTrack(BaseModel):
    """One helicopter's complete trajectory within the show."""
    heli_id: int = Field(ge=1, le=99, description="Fleet heli ID (1-99)")
    style: HeliStyle = Field(default_factory=HeliStyle)
    waypoints: list[Waypoint] = Field(
        min_length=1,
        description="Ordered list of timed waypoints",
    )


class OpsOverrides(BaseModel):
    """Per-show overrides for daemon operational constants.

    Any field omitted falls back to the daemon's built-in default —
    see flight_daemon.py for current values. These fields affect how
    the daemon runs the show; they are *not* artistic parameters.
    """
    hover_alt_m: Optional[float] = Field(
        default=None, gt=0,
        description="Takeoff + staging cruise altitude. Default 5.0m.",
    )
    spool_time_s: Optional[float] = Field(
        default=None, ge=0,
        description="Rotor spool-up after arm. Default 8.0s.",
    )
    return_base_alt_m: Optional[float] = Field(
        default=None, gt=0,
        description="First heli's return altitude. Default 8.0m.",
    )
    return_alt_step_m: Optional[float] = Field(
        default=None, ge=0,
        description="Per-heli return altitude stagger. Default 3.0m.",
    )
    landing_descent_rate: Optional[float] = Field(
        default=None, gt=0,
        description="Controlled descent rate. Default 1.0 m/s.",
    )


class Sequencing(BaseModel):
    """Per-show staggering of startup / takeoff / landing.

    Default 0 everywhere = current parallel behavior. Non-zero values
    insert per-heli delays in the respective phases of
    flight_daemon._launch_sequence / _landing_sequence.
    """
    startup_stagger_s: float = Field(
        default=0.0, ge=0,
        description="Delay between arm+spool cycles. Reduces peak rotor "
                    "noise and gives the operator time to watch each "
                    "heli come up individually.",
    )
    takeoff_stagger_s: float = Field(
        default=0.0, ge=0,
        description="Delay between lift-offs. Important when lineup "
                    "spacing is tight — parallel climb can put helis "
                    "close at hover altitude.",
    )
    landing_stagger_s: float = Field(
        default=0.0, ge=0,
        description="Delay between descent starts. Helis hold at their "
                    "staggered return altitude until it's their turn "
                    "to descend — only one heli is active in the "
                    "descent lane at a time.",
    )


class LineupSpec(BaseModel):
    """Planned ground placement of each heli before takeoff.

    Informational only from the daemon's perspective — the real lineup
    is captured from live GPS in `capture_lineup()`. The editor uses
    this block to preview the intro/outro phases (takeoff, staging,
    return, descent) and validate safety across the full lifecycle.
    """
    positions: dict[int, Vec3] = Field(
        description="Per-heli planned ground position in NED meters "
                    "(d should be 0 — on the ground). Key = heli_id.",
    )
    tolerance_m: float = Field(
        default=1.0, ge=0,
        description="Physical placement uncertainty radius per heli. "
                    "Used by the editor's variance-aware safety check.",
    )


class ShowFile(BaseModel):
    """Top-level show file — contains metadata + all heli tracks."""
    name: str = Field(description="Show name")
    version: int = Field(default=1, description="Schema version")
    home_lat: float = Field(description="Home latitude (decimal degrees)")
    home_lon: float = Field(description="Home longitude (decimal degrees)")
    home_alt_m: float = Field(default=0, description="Home altitude AMSL (m)")
    show_offset: Optional[Vec3] = Field(
        default=None,
        description="G54-style offset applied to every waypoint at load "
                    "time. Lets a show be designed centered on (0,0,0) and "
                    "translated in space without editing every waypoint. "
                    "Daemon adds this to each wp.pos in `load_show`.",
    )
    sequencing: Optional[Sequencing] = Field(
        default=None,
        description="Staggered startup / takeoff / landing. Default 0 = "
                    "parallel (current behavior).",
    )
    ops: Optional[OpsOverrides] = Field(
        default=None,
        description="Per-show overrides for daemon operational constants "
                    "(hover altitude, spool time, return altitude stagger, "
                    "descent rate). Any field omitted uses daemon defaults.",
    )
    lineup: Optional[LineupSpec] = Field(
        default=None,
        description="Planned lineup + placement tolerance. Optional; daemon "
                    "captures live lineup from GPS at flight time.",
    )
    duration_s: float = Field(
        gt=0,
        description="Total show duration (seconds) — must be ≥ last waypoint time",
    )
    tracks: list[HeliTrack] = Field(
        min_length=1,
        description="One track per participating heli",
    )

    def validate_timing(self) -> list[str]:
        """Check that all waypoints are within duration and ordered."""
        errors = []
        for track in self.tracks:
            for i, wp in enumerate(track.waypoints):
                if wp.t > self.duration_s:
                    errors.append(
                        f"heli {track.heli_id} wp[{i}] t={wp.t}s exceeds "
                        f"duration {self.duration_s}s"
                    )
                if i > 0 and wp.t < track.waypoints[i - 1].t:
                    errors.append(
                        f"heli {track.heli_id} wp[{i}] t={wp.t}s is before "
                        f"wp[{i-1}] t={track.waypoints[i-1].t}s"
                    )
        return errors

    def get_heli_ids(self) -> list[int]:
        """List all heli IDs in this show."""
        return [t.heli_id for t in self.tracks]

    def validate_safety(self, min_separation_m: float = 3.0) -> list[str]:
        """Static check: verify no two tracks have waypoints too close at shared times."""
        import math
        warnings = []
        for i, t1 in enumerate(self.tracks):
            for t2 in self.tracks[i + 1:]:
                # Check at each waypoint time from both tracks
                times = sorted(set(
                    [w.t for w in t1.waypoints] + [w.t for w in t2.waypoints]
                ))
                for t in times:
                    p1 = self._pos_at(t1, t)
                    p2 = self._pos_at(t2, t)
                    if p1 and p2:
                        dist = math.sqrt(
                            (p1.n - p2.n) ** 2 +
                            (p1.e - p2.e) ** 2 +
                            (p1.d - p2.d) ** 2
                        )
                        if dist < min_separation_m:
                            warnings.append(
                                f"Heli{t1.heli_id} and Heli{t2.heli_id} "
                                f"within {dist:.1f}m at t={t:.1f}s"
                            )
        return warnings

    @staticmethod
    def _pos_at(track: 'HeliTrack', t: float) -> 'Vec3 | None':
        """Get interpolated position of a track at time t."""
        wps = track.waypoints
        if not wps:
            return None
        if t <= wps[0].t:
            return wps[0].pos
        for i in range(len(wps) - 1):
            if wps[i].t <= t <= wps[i + 1].t:
                dt = wps[i + 1].t - wps[i].t
                if dt <= 0:
                    return wps[i + 1].pos
                frac = (t - wps[i].t) / dt
                p0, p1 = wps[i].pos, wps[i + 1].pos
                return Vec3(
                    n=p0.n + (p1.n - p0.n) * frac,
                    e=p0.e + (p1.e - p0.e) * frac,
                    d=p0.d + (p1.d - p0.d) * frac,
                )
        return wps[-1].pos
