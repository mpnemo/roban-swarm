# Show Editor — Status & Next Steps

Standalone vanilla-JS tool for authoring choreography JSON files consumed
by `base-controller/choreography/flight_daemon.py`. Lives at
`tools/show-editor/`. Runs locally via `python3 -m http.server`, no build
step. See [`tools/show-editor/README.md`](../tools/show-editor/README.md)
for usage and [`tools/show-editor/DESIGN.md`](../tools/show-editor/DESIGN.md)
for the design rationale.

This file is a session-handoff: where we are, what's done, what's next.

## Quick start

```bash
cd tools/show-editor
python3 -m http.server 8000
# open http://localhost:8000/editor.html
```

Load `examples/helix_eight.json` to see all features at once.

## What's done (v1)

### Editor

- **Three views** with live cross-update:
  - Top-down N/E canvas with grid, pan, zoom, click-to-add waypoint, drag.
  - Altitude-over-time view (positive AGL). Click + drag waypoints in t/alt.
  - 3D view via vendored Three.js r160 + OrbitControls (no CDN, ~684 KB
    in `tools/show-editor/vendor/`).
- **Timeline scrubber** with playback (0.25/0.5/1/2/4×), per-heli
  waypoint ticks, intro/outro bands, conflict ticks (red glow). Loops the
  full extended timeline including intro and outro.
- **Side panel edit tree:** show meta · helis · per-heli style · waypoint
  list · selected waypoint detail · lineup · sequencing · ops overrides.
- **Smooth-preview overlay** (Catmull-Rom dashed) on all three views. The
  flight daemon streams linear-interpolated targets — the dashed curve
  shows intended shape only.
- **Validation panel** in the side pane:
  - `validate_timing` (port of Python).
  - `validate_safety` (port of Python — pairwise within waypoint times).
  - `validate_lifecycle_safety` (sampled across intro + outro).
  - Each issue is a clickable jump-to-time entry.
- **Visual proximity warnings** when any pair is within 3 m at the
  current scrubber time:
  - Red dashed line between the pair on the top-down canvas.
  - Red dashed ring at threshold radius around each conflicting heli.
  - Translucent red wireframe sphere around 3D markers.
  - Faint red bands on the altitude view at conflict times.
  - Red glowing ticks on the scrubber so playback visibly passes them.
- **Lineup editor:** per-heli ground positions with tolerance circles,
  drag-to-place on canvas, auto-arrange templates (line / grid / circle /
  arc) via `templates…` button.
- **Show offset** (G54-style): `show_offset.{n,e,d}` in the header
  shifts every waypoint without editing them individually.
- **Sequencing staggers:** `startup_stagger_s`, `takeoff_stagger_s`,
  `landing_stagger_s` — both rendered in the lifecycle preview AND
  honored by the daemon.
- **Ops overrides:** per-show overrides for daemon constants
  (`hover_alt_m`, `hover_alt_step_m`, `spool_time_s`, `return_base_alt_m`,
  `return_alt_step_m`, `landing_descent_rate`).
- **Yaw support:** per-waypoint `yaw_mode` (`auto` / `absolute`) +
  `yaw_deg`. White arrows on canvas + 3D show absolute headings. Daemon
  sends explicit yaw via `MAV_CMD_DO_REPOSITION` when `absolute`.

### Daemon (matching changes)

In `base-controller/choreography/flight_daemon.py` and
`base-controller/choreography/show_format.py`:

- **`show_offset`** applied at load (one loop in `load_show`).
- **`sequencing.startup_stagger_s`** between sequential arms.
- **`sequencing.takeoff_stagger_s`** between heli lift-offs in
  `_parallel_takeoff` (still the same function name; now staggered when
  set).
- **`sequencing.landing_stagger_s`** between heli descent starts in
  `_landing_sequence`.
- **`hover_alt_step_m`** stacks heli `i` at `hover_alt_m + i * step` for
  takeoff and horizontal traverse — same pattern as the existing outro
  return stack. **Default 3 m, always-on.** Set to 0 in ops to revert
  to flat parallel hover.
- **`yaw_deg` / `yaw_mode="absolute"`** flows to ArduPilot via
  `MAV_CMD_DO_REPOSITION` so explicit headings (e.g., rotate-in-place
  showcases) are honored.

### Examples

`tools/show-editor/examples/`:
- `figure8_single.json` — one heli, uses `hold_s` to exercise expansion.
- `crossing_two.json` — two helis crossing at staggered alt.
- `formation_three.json` — three helis rotating a triangle.
- `helix_eight.json` — eight helis, counter-rotating helix; exercises
  every editor feature (intro/outro stack, smooth, proximity).

## Known good runtime path

`helix_eight.json` reload → load example. You should see:

- Top-down: 8 lineup squares south of origin, intro dashed paths fanning
  out, the helix during 0–60 s, outro returning home with staggered
  altitudes 8 / 11 / 14 / 17 / 20 / 23 / 26 / 29 m.
- 3D: same picture in perspective; obvious altitude staircase during
  intro and outro.
- Validation panel: timing OK, ~1 safety warn (heli 6/7 within ~2.x m
  during intro mid-traverse — mitigated by altitude stacking from
  task B; it's the residual horizontal proximity, not a collision).
- Scrubber: red glow at the residual proximity time(s).

## What's queued for next session

### High-leverage, ready to pick up

1. **Runtime telemetry-based pairwise watchdog (option C)**
   See [`tools/show-editor/DESIGN.md`](../tools/show-editor/DESIGN.md) →
   "Follow-ups queued for later sessions."
   - Add a periodic task in `FlightDaemon._inflight_monitor` that reads
     live GPS positions from `VehicleTracker`, computes pairwise 3D
     distance, and on sub-2 m violations sends `BRAKE` to both helis +
     emits a `safety_warning` event.
   - Threshold needs hysteresis to avoid RTK-float-drift false positives
     (suggest fire on `< 2 m for > 1 s`).
   - Reaction TBD: BRAKE may not separate a closing pair; consider a
     staggered altitude nudge instead.
   - Cost: ~40 lines + real-flight tuning. Defer until A + B have soak
     time and we know what thresholds work.

2. **Auto-lineup template** (editor-only ergonomics)
   - Given the show's wp0 positions, generate a lineup where each heli's
     lineup → wp0 radial doesn't cross anyone else's. Variant of the
     existing template menu.
   - Avoids relying on altitude stacking to clean up cross-paths.

3. **Variance simulation for lineup tolerance**
   - Today the lineup tolerance circle is purely informational. Could
     Monte-Carlo or worst-case sample lineups within tolerance and
     re-run safety to flag shows that are safe-with-perfect-placement
     but unsafe-under-realistic-error.

### Nice-to-have, lower priority

4. **Field-aware validation:** read from RTK-FIELD geofence params
   (max radius / max alt) into the editor; warn if any waypoint or
   intro/outro position exits.
5. **Collision heat-map overlay** — sample (heli_i, heli_j) pairs at
   10 Hz across the full extended timeline, paint regions in 3D where
   density > N pairs.
6. **CSV import** — Blender / Houdini choreography export → editor.
7. **Multi-heli formation generators** at a given time (line / circle /
   wave) — like the lineup templates but for waypoints.
8. **Operator-registration / KYC stub** — `localStorage` slot already
   reserved; build the form when legal scope is known.
9. **Undo/redo stack** in the editor.
10. **Map / terrain overlay** (Mission-Planner-style raster tiles
    aligned to home_lat/lon). Stub already in `canvas.js`.

### Architecture / housekeeping

- **DESIGN.md** at `tools/show-editor/DESIGN.md` is still authoritative
  for editor scope and decisions. Keep it in sync when feature scope
  changes.
- **The Pydantic schema** at `base-controller/choreography/show_format.py`
  is the **only** source of truth for the show file format. Editor
  must round-trip through it. Any new field needs both Python and JS
  loader updates.
- **Vendored Three.js** is at `tools/show-editor/vendor/three.module.js`
  (r160, MIT). When upgrading: re-vendor, retest 3D view, OrbitControls
  is at `vendor/three-addons/controls/OrbitControls.js`.

## Recent session log

`show-editor` branch, commits ahead of `main` at merge time:

```
024d2f0 Queue option C for later: runtime pairwise watchdog
641b52a Show editor B: altitude-stacked intro
316d163 Show editor A: visual proximity warnings
7b6b3aa Fix view3d.js TDZ: inner 'off' shadowed show_offset
406b97a Fix stray backtick in sidepanel.js
… plus 5 task commits (lineup, show_offset, sequencing, ops, yaw)
… plus 3D view + Catmull-Rom smooth + helix example
… plus 8 v1 chunks (model, canvas, sidepanel, timeline, altitude,
                     validation, file I/O, README)
… plus 2 design-doc commits
```

Branch contained 24 commits at merge time. Always built with
`python3 -m http.server`, no npm/bundler.

## Where to start next session

1. Read this file.
2. Read `tools/show-editor/DESIGN.md` "Follow-ups queued for later
   sessions" section.
3. Pick task C (runtime pairwise watchdog) or one of the
   nice-to-haves above.
4. Branch off `main`: `git checkout -b show-editor-N` where N is the
   next number, do work, push, do not merge until reviewed.
