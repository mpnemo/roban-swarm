"""Safety monitor — collision avoidance and geofence enforcement.

Sits between the flight daemon and the command sender. Every position
target passes through here before being sent to a heli. Checks:
  1. Pairwise separation between all helis (min distance)
  2. Geofence (max radius + max altitude from show home)

On violation: the offending heli is HELD at its last safe position.
Other helis continue unaffected (no cascade panic stop).
"""

import logging
import math
import time
from typing import Callable, Awaitable

from mavlink.command_sender import CommandSender

log = logging.getLogger("roban.safety")


class SafetyMonitor:
    """Validates all position targets before they are sent to helis.

    Usage:
        monitor = SafetyMonitor(sender, on_event=ws_broadcast)
        sent = await monitor.check_and_send(heli_id, n, e, d, vn, ve, vd)
    """

    def __init__(self, command_sender: CommandSender,
                 min_separation_m: float = 3.0,
                 max_radius_m: float = 100.0,
                 max_alt_m: float = 50.0,
                 on_event: Callable[[dict], Awaitable[None]] | None = None):
        self._sender = command_sender
        self._min_sep = min_separation_m
        self._max_radius = max_radius_m
        self._max_alt = max_alt_m
        self._on_event = on_event

        # Last commanded position per heli (NED meters)
        self._positions: dict[int, tuple[float, float, float]] = {}
        # Helis currently held due to safety violation
        self._held: set[int] = set()
        # Rate-limit violation events (one per heli per 2s)
        self._last_violation: dict[int, float] = {}

    @property
    def held_helis(self) -> set[int]:
        """Set of heli IDs currently held by safety monitor."""
        return self._held.copy()

    @property
    def positions(self) -> dict[int, tuple[float, float, float]]:
        """Current commanded positions (NED)."""
        return self._positions.copy()

    async def check_and_send(self, heli_id: int,
                              pos_n: float, pos_e: float, pos_d: float,
                              vel_n: float = 0, vel_e: float = 0,
                              vel_d: float = 0) -> bool:
        """Validate target position and send if safe.

        Returns True if the command was sent, False if blocked.
        """
        # --- Geofence check ---
        horiz_dist = math.sqrt(pos_n ** 2 + pos_e ** 2)
        alt_above_home = -pos_d  # NED: negative D = above home

        if horiz_dist > self._max_radius:
            await self._violation(
                heli_id,
                f"Geofence: horizontal {horiz_dist:.1f}m > {self._max_radius}m",
            )
            return False

        if alt_above_home > self._max_alt:
            await self._violation(
                heli_id,
                f"Geofence: altitude {alt_above_home:.1f}m > {self._max_alt}m",
            )
            return False

        if alt_above_home < -1.0:  # More than 1m below home = underground
            await self._violation(
                heli_id,
                f"Geofence: altitude {alt_above_home:.1f}m below home",
            )
            return False

        # --- Pairwise separation check ---
        for other_id, (on, oe, od) in self._positions.items():
            if other_id == heli_id:
                continue
            dist = math.sqrt(
                (pos_n - on) ** 2 + (pos_e - oe) ** 2 + (pos_d - od) ** 2
            )
            if dist < self._min_sep:
                self._held.add(heli_id)
                await self._violation(
                    heli_id,
                    f"Too close to Heli{other_id:02d}: {dist:.1f}m < {self._min_sep}m",
                    separation_m=dist,
                )
                return False

        # --- Safe — send command and update records ---
        self._held.discard(heli_id)
        self._positions[heli_id] = (pos_n, pos_e, pos_d)
        self._sender.send_position_target(
            heli_id, pos_n, pos_e, pos_d, vel_n, vel_e, vel_d,
        )
        return True

    async def _violation(self, heli_id: int, detail: str,
                          separation_m: float | None = None):
        """Log and emit a safety violation event (rate-limited)."""
        now = time.monotonic()
        last = self._last_violation.get(heli_id, 0)
        if now - last < 2.0:
            return  # Rate-limit: max one event per heli per 2s

        self._last_violation[heli_id] = now
        log.warning("SAFETY: Heli%02d — %s", heli_id, detail)

        if self._on_event:
            event = {
                "type": "safety_violation",
                "heli_id": heli_id,
                "detail": detail,
                "action": "hold",
            }
            if separation_m is not None:
                event["separation_m"] = round(separation_m, 2)
            await self._on_event(event)

    def update_position_from_telemetry(self, heli_id: int,
                                        pos_n: float, pos_e: float,
                                        pos_d: float):
        """Update a heli's position from live telemetry (for helis not
        currently being commanded by the flight daemon)."""
        if heli_id not in self._positions:
            self._positions[heli_id] = (pos_n, pos_e, pos_d)

    def clear(self):
        """Reset all state (called when show is unloaded)."""
        self._positions.clear()
        self._held.clear()
        self._last_violation.clear()
