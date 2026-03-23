"""Show file schema — Pydantic models for drone swarm choreography files.

A show file is a JSON document describing a timed sequence of waypoints
for one or more helicopters, with per-heli flight style parameters that
constrain the trajectory planner (jerk limiting, speed, accel, bank).

See docs/show_file_spec.md for the full specification.
"""

from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional


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


class ShowFile(BaseModel):
    """Top-level show file — contains metadata + all heli tracks."""
    name: str = Field(description="Show name")
    version: int = Field(default=1, description="Schema version")
    home_lat: float = Field(description="Home latitude (decimal degrees)")
    home_lon: float = Field(description="Home longitude (decimal degrees)")
    home_alt_m: float = Field(default=0, description="Home altitude AMSL (m)")
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
