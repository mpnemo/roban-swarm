# Show Editor — Design

A standalone, offline, vanilla-JS tool for authoring show files (the JSON
choreography format consumed by `base-controller/choreography/flight_daemon.py`).
Runs locally via `python3 -m http.server`; exports a JSON file the user copies
to the base station.

**Scope:** design tool only. No MAVLink, no telemetry, no base-station
connection. The editor never talks to hardware.

## Source of truth

The schema is defined in Pydantic at
[`base-controller/choreography/show_format.py`](../../base-controller/choreography/show_format.py).
The editor must round-trip: any file it exports must load cleanly via
`ShowFile(**json.load(f))`, and any file that loads there should load here.

Anywhere this doc and the Pydantic file disagree, **the Pydantic file wins.**

## Frame of reference

- Coordinates are NED meters, relative to the lineup origin (captured on-site).
- `n` = north (+), `e` = east (+), `d` = down (+, so **altitude above ground
  is `-d`**).
- `home_lat`, `home_lon`, `home_alt_m` in the show file are informational only.
  The flight daemon overrides them at lineup time. The editor treats them as
  editable metadata but doesn't rely on them for preview.
- Canvas axes: N up, E right. Altitude view: `-d` vertical, `t` horizontal.

## v1 scope (what to build first)

| # | Feature | Included |
|---|---------|----------|
| 1 | File New / Open / Save As; drag-drop JSON onto canvas | yes |
| 2 | Heli add / remove; per-heli `heli_id` (1-99); per-heli `HeliStyle` fields | yes |
| 3 | Top-down 2D canvas (N/E), grid with scale, origin marker, pan + zoom | yes |
| 4 | Click canvas to add waypoint at current scrubber time; drag to move; delete key | yes |
| 5 | Side panel: numeric edit of `t`, `pos.n`, `pos.e`, altitude (`-d`), optional `vel`; "Add hold here (N s)" button | yes |
| 6 | Timeline scrubber (0..`duration_s`), linear interpolation at scrub time | yes |
| 7 | Playback: play / pause / speed (0.25, 0.5, 1, 2, 4); loop | yes |
| 8 | Altitude-over-time view (altitude vs t), click to add / drag to edit | yes |
| 9 | Live validation panel — `validate_timing` + `validate_safety` with jump-to-time links | yes |
| 10 | Speed-graded trajectory polylines (Strava-style color gradient, scale anchored to `max_speed`) | yes |
| 11 | Export: exact shape Pydantic accepts, `hold_s` never emitted (expanded into waypoint pairs) | yes |
| 12 | 2-3 example shows in `examples/` | yes |

### v1 explicitly excludes

- 3D perspective view (Three.js etc.)
- Jerk-limited trajectory preview — v1 uses the same linear interpolation the
  flight daemon uses today for telemetry streaming
- Collision heat map across the whole timeline
- CSV / Blender import
- Formation templates (line / circle / grid)
- Undo / redo beyond simple delete-last (see "deferred" below)

### Explicit non-goals

- No network requests. No CDN. No analytics. No service worker.
- No framework, no bundler, no npm. Native ESM only where helpful.
- No persistence beyond file save. `localStorage` used only for UI prefs
  (zoom level, last-opened filename), never for show content.

## File layout

```
tools/show-editor/
  DESIGN.md                    (this file)
  README.md                    (how to run + JSON ref)
  editor.html                  (single entry point)
  css/
    style.css                  (dark theme, layout)
  js/
    model.js                   (ShowModel — data + validation + I/O)
    validate.js                (validate_timing + validate_safety port)
    canvas.js                  (top-down N/E view: render, pan, zoom, hit test)
    altitude.js                (altitude-over-time view)
    timeline.js                (scrubber + playback state machine)
    app.js                     (glue: DOM wiring, side panels, file I/O)
  examples/
    figure8_single.json        (1 heli, figure-8, ~60s)
    crossing_two.json          (2 helis crossing at center, staggered alt)
    formation_three.json       (3 helis, triangle, synchronized rotate)
  vendor/                      (empty in v1 — reserved for Three.js in v2)
```

### Why a single HTML file

Hand-editable, no build step, opens in a browser tab. Every JS module is a
native ES module loaded via `<script type="module">` from `editor.html`.

## Data model (JavaScript)

The JS model mirrors the Pydantic schema 1:1. Expressed as JSDoc so the shape
is visible to anyone reading the code, no TypeScript toolchain needed.

```js
/** @typedef {{n:number, e:number, d:number}} Vec3 */

/** @typedef {{
 *   t: number,               // seconds from show start, >= 0
 *   pos: Vec3,
 *   vel?: Vec3,              // optional velocity hint
 * }} Waypoint */
// Note: hold_s is never carried in the in-memory model. On load, any
// hold_s > 0 is expanded into a paired waypoint (same pos, t + hold_s).
// On save, hold_s is never emitted.

/** @typedef {{
 *   max_speed: number,       // m/s, > 0, default 5.0
 *   max_accel: number,       // m/s^2, > 0, default 2.0
 *   max_jerk: number,        // m/s^3, > 0, default 5.0
 *   angle_max_deg: number,   // > 0, <= 60, default 30
 *   corner_radius: number,   // >= 0, default 2.0
 * }} HeliStyle */

/** @typedef {{
 *   heli_id: number,         // 1..99
 *   style: HeliStyle,
 *   waypoints: Waypoint[],   // min length 1, ordered by t ascending
 * }} HeliTrack */

/** @typedef {{
 *   name: string,
 *   version: 1,
 *   home_lat: number,
 *   home_lon: number,
 *   home_alt_m: number,      // default 0
 *   duration_s: number,      // > 0, >= max wp.t
 *   tracks: HeliTrack[],     // min length 1
 * }} ShowFile */
```

`model.js` owns:
- A single mutable `ShowFile` instance (`state.show`).
- `state.selection = { heliId: number|null, waypointIdx: number|null }`.
- `newShow()`, `loadJson(text)`, `toJson()` that stringifies to the exact
  Pydantic shape (omit `vel` when null, omit `hold_s` when 0, omit default
  style fields? → **keep all style fields explicit** — round-trip is safer).
- Defaults applied on load: any missing `style`, `version`, `home_alt_m` get
  the Pydantic defaults.
- Event emitter (`on(event, fn)`) for views to re-render on change. Events:
  `show-changed`, `selection-changed`, `time-changed`.

No DOM in `model.js`. Canvas, altitude, timeline, and app listen to its events.

## Validation

`validate.js` is a direct port of `validate_timing` and `validate_safety` from
`show_format.py`, in the same style (list of error strings / warning strings
returned). A light extension:

- Each error/warning carries an optional `{heli_id, t}` so the UI can render
  it as a clickable "jump to t=12.5s, select Heli01" link.
- Re-validated on every model change. Debounced at 100 ms to avoid thrashing.

**Interpolation:** plain linear, everywhere. Because the editor expands
`hold_s` into waypoint pairs on load and never emits the field (see
decision 6), the validator and the canvas preview agree by construction —
both use the same `lerp(wp_i, wp_{i+1}, frac)` as `ShowFile._pos_at`. On
load, a validator error is raised if any `hold_s` window would overlap
the next waypoint (`t + hold_s >= wps[i+1].t`).

## Interactions

### Top-down canvas (N up, E right)

- Pan: middle-drag or shift-drag.
- Zoom: wheel, anchored at mouse cursor. Clamped [0.05, 20] m/pixel.
- Grid: 1 m lines up to a ×10 threshold, then 10 m lines, etc. Label every
  5th line.
- Origin marker: crosshair at (0, 0) with small "N / E" label.
- Each heli rendered as:
  - Waypoint dots connected by polyline. Polyline is **color-graded by
    instantaneous speed** — sampled along the segment from the linear
    interpolation, anchored to that heli's `max_speed`. Blue (stopped) →
    green → yellow → red (at `max_speed`). Over-speed segments pulse red.
    Hold pairs (same `(n,e,d)` at different `t`) render as a single
    enlarged dot with a small clock glyph.
  - A triangle marker at the interpolated position for the current scrubber
    time, pointing in the direction of instantaneous velocity (from
    neighboring waypoints).
  - Selected waypoint: filled with accent color, outlined.
- Left-click on empty space (with a heli selected): add waypoint at the
  cursor position with `t = scrubber time`, `d = interpolated d` (from
  neighboring wps, so a click on the top-down view doesn't change altitude).
- Left-click + drag on a waypoint: move in N/E; `d` and `t` unchanged.
- Shift-click on a waypoint: toggle multi-select (v1: single-select only,
  wire the event but leave multi as a v2 hook).
- Delete / Backspace: remove selected waypoint. If it's the only waypoint
  on a heli, the heli must still have ≥1 waypoint — prompt to delete the
  whole heli instead.

### Altitude view

Horizontal axis = time (0..`duration_s`). Vertical = **altitude in meters
AGL** (positive up, 0 at takeoff ground). Under the hood this is `-d`;
the UI never exposes the sign flip. Waypoints shown as dots on each
heli's polyline; polyline color-graded by speed (same scale as the
top-down view).

- Click on empty space (with a heli selected): add waypoint at that `t` with
  `pos.n, pos.e` interpolated from neighbors and `pos.d = -clicked_altitude`
  (ground click → `d=0` → altitude 0).
- Drag waypoint: edit both `t` and altitude simultaneously. Clamp `t` into
  [neighbor-left.t, neighbor-right.t] to preserve ordering. Visually snap
  at 0.1 s. Altitude clamped at 0 (no burying the heli).

### Timeline

- Scrubber bar across the bottom. Thumb = current time. Ticks at every
  integer second; labels at every 5 s (or 10 s depending on duration).
- Play / pause button, speed dropdown (0.25, 0.5, 1, 2, 4 ×).
- Playback drives `state.time` via `requestAnimationFrame`. At end of
  duration, loop back to 0.
- Keyboard: space = play/pause, ← / → = ±1 s, shift ← / → = ±0.1 s.

### Side panels

Layout: top-down canvas takes the main area. Right panel shows the tree:
- **Show** (name, home lat/lon/alt, duration)
  - **Heli 1** (heli_id, style fields)
    - Waypoint 0 (t, n, e, alt=`-d`, vel?) + [Add hold here (N s)] button
    - Waypoint 1 ...
  - **Heli 2** ...
- "+ Add heli" / "+ Add waypoint" buttons.

Selecting a node focuses its numeric fields. Editing a field updates the
model and re-renders. Invalid values (negative t, heli_id > 99) are rejected
on blur with a red border + tooltip.

Altitude view sits below the top-down canvas, half the height. Timeline
sits at the bottom, full width. Validation panel collapses on the left
(fixed width ~280 px) or toggles on a button — final layout TBD during
build, whichever keeps the canvas largest.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| space | play / pause |
| ← / → | time ±1 s (shift: ±0.1 s) |
| delete / backspace | remove selected waypoint |
| ctrl/cmd+s | save as |
| ctrl/cmd+o | open |
| ctrl/cmd+n | new |
| 1..9 | select heli by ID (when not editing a field) |

## File I/O

- **New:** prompts for show name + duration, creates one heli (id=1) with a
  single waypoint at `t=0, n=0, e=0, d=-5` (5 m up).
- **Open:** file picker → reads JSON → runs it through `ShowFile` JS loader
  (which validates and applies defaults) → loads into model. Errors shown
  in the validation panel; the old show is kept on failure.
- **Save As:** uses `<a download>` with a blob URL. Filename defaults to
  `<slug(name)>.json`.
- **Drag-drop:** dropping a `.json` file onto the editor window triggers the
  same path as Open.

### Export guarantees

`model.toJson()` produces a JSON document where:

- All required Pydantic fields are present.
- `version` is always `1`.
- `style` is always a full object (no relying on defaults).
- `vel` is omitted when unset. `hold_s` is never emitted (holds are always
  expressed as a paired waypoint — see decision 6).
- Waypoint order matches display order (already sorted by `t` ascending).
- Numbers are rounded to a reasonable precision (positions to 3 decimals,
  time to 2 decimals) — matches what the Python code writes.

A README section explains how to validate externally:

```bash
cd base-controller
python3 -c "import json; from choreography.show_format import ShowFile; \
  ShowFile(**json.load(open('path/to/show.json')))"
```

## Styling

Dark theme, matching the dashboard colors roughly:

```
--bg:       #1a1a2e
--bg-panel: #252538
--fg:       #e0e0e0
--fg-dim:   #888
--accent:   #e94560   (selection, active tool)
--ok:       #00c851
--info:     #33b5e5
--warn:     #ff4444
```

Per-heli color palette: 10 visually distinct hues, stable by `heli_id`
(id=1 always cyan, id=2 always magenta, etc.). A fixed lookup table in
`app.js` — no HSL derivation (prevents two IDs landing on similar hues).

Font: system UI stack. Monospace only for numeric fields.

## Non-obvious decisions

- **One waypoint minimum** (per Pydantic). The editor enforces this: you
  can't delete the last waypoint on a heli; the UI prompts to delete the
  heli instead.
- **`d` is stored negative** (NED), edited everywhere as **positive AGL
  altitude**. Side-panel field label reads `alt (m)`. Altitude view's
  vertical axis is AGL meters. Internal model keeps `d` to stay aligned
  with the Pydantic schema — the sign flip is purely at the UI boundary.
- **Validation runs on the full show** (not per-heli) because `validate_safety`
  is pairwise. Debounced to 100 ms.
- **No autosave.** The user explicitly prefers artifacts that don't change
  under them. Unsaved-change indicator (`*` in title bar) is enough.
- **`hold_s` is never in the in-memory model.** Expanded on load, re-
  expressed as waypoint pairs on save. Linear interp everywhere, validator
  and preview agree by construction. See decision 6.
- **`vel` hint stays optional.** If the user never touches it, it stays
  absent in the JSON. Editing any of `vel.n/e/d` materializes the object.
- **Speed gradient is a render-only detail**, not model state. Computed
  from neighboring waypoints on the fly, scaled to each heli's `max_speed`.

## Follow-ups queued for later sessions

### Runtime telemetry-based pairwise watchdog (option C, deferred)

Editor-side and daemon-side design-time collision safety now cover each
other:
- Editor: `validateLifecycleSafety` + the visual proximity system
  (red bubbles in canvas/3D, red ticks on the scrubber) surface any
  within-3m condition across intro/show/outro at design time.
- Daemon: altitude-stacked intro (heli `i` at `hover_alt_m + i *
  hover_alt_step_m`) and altitude-stacked outro (heli `i` at
  `return_base_alt_m + i * return_alt_step_m`) make those phases
  safe by construction — paths that cross horizontally are
  separated vertically.

What's still missing: a **runtime** pairwise distance watchdog.
`safety_monitor.py` today checks pairwise distance only against
**commanded targets**, which during the staging traverse are each
heli's final `wp0` — always far apart even when paths cross.
There's no monitor using live GPS telemetry to detect actual mid-air
proximity.

When we need it (field soak, SIM → real transition, or if the stack
ever gains a mode that doesn't use altitude-stacking for intro/outro):

- Add a periodic task in `FlightDaemon._inflight_monitor` that reads
  live GPS positions from `VehicleTracker`, computes pairwise 3D
  distances, and on sub-2m violations sends `BRAKE` to both helis
  and emits a `safety_warning` event.
- Threshold needs tuning so RTK float drift doesn't trigger false
  positives. Probably hysteresis — fire on `< 2m for > 1s`.
- Consider whether BRAKE or a staggered altitude nudge is the right
  reaction; BRAKE on a closing pair may not separate them.

Cost estimate: ~40 lines in `safety_monitor.py` + plumbing, plus
real-flight tuning.

## v2 candidates (not in v1)

- **Terrain / map overlay** (Mission-Planner-style): raster tile layer or
  vector geojson aligned to `home_lat/lon`, so users can draw trajectories
  around buildings, trees, and no-fly zones. A stub transparent layer in
  `canvas.js` is provisioned in v1 so this can land without restructuring.
- **Operator registration / KYC:** form on first launch captures name,
  operator license, agreed T&Cs, stored in a reserved `localStorage` key.
  The base station / OPi will later require this before loading a show —
  legal/traceability. v1 reserves the key name, implements nothing.
- 3D perspective view using Three.js (vendored).
- Jerk-limited trajectory preview — port the minimum-jerk planner from the
  flight daemon so the animation matches what helis actually fly, not the
  linear idealization.
- Collision heat map (sample 10 Hz across all pairs, paint dense regions).
- CSV import (columns: `heli_id, t, n, e, d, vn, ve, vd` — hold expressed
  as repeated rows, same as the JSON format).
- Blender export plug-in format.
- Multi-heli formation generators (line, circle, grid) with one-click
  insert at current time.
- Undo / redo stack.
- Co-edit multiple waypoints (move N helis by the same delta).
- Live RTCM health preview hitting the base station — **out of scope per
  the original brief** (local tool only), but flagged in case the user
  later wants it.

## Resolved decisions

1. **Altitude display:** UI shows altitude as **+AGL** (positive meters above
   ground, 0 at takeoff). JSON keeps `d` negative per NED convention. Side-
   panel label reads `alt (m)`.
2. **Units:** m / kg / s throughout. No imperial. Trajectory polylines on both
   the top-down and altitude views are **color-graded by instantaneous
   speed** (Strava-style — slow = cool, fast = warm) so the editor surfaces
   speed visually without a separate chart. Color scale anchored to the
   heli's `max_speed` style value so per-heli hot = "at the style limit."
3. **Angle convention:** anywhere a compass heading or direction is displayed
   (future: staging heading, preview arrows, etc.), use **0–360° compass
   format** (0 = N, 90 = E). `angle_max_deg` is a *lean-angle constraint*,
   not a heading — it stays 0–60 in the style panel, labeled clearly as
   "max lean / bank (°)" to avoid confusion.
4. **`home_lat / home_lon`:** treated as optional metadata. The flight daemon
   **overrides these at lineup**, so the editor does not rely on them for
   preview or safety. They're editable in the side panel for the sake of
   users who want to scaffold a show before going to the field, but empty
   (0/0) is valid and expected. A **terrain / map overlay hook** is
   provisioned for v2 (Mission-Planner-style: load a raster or vector map
   layer aligned to home, so users can draw trajectories around buildings,
   trees, and no-fly zones). v1 leaves a stub `canvas.js` layer for this —
   no rendering yet.
5. **`localStorage`:** used for UI preferences only (zoom, pan, last-opened
   filename, last-used per-heli colors if overridden). **Never** for show
   content. Also provisioned (stub only, no logic): a `registration` key
   where a future build will store operator KYC info — name, operator
   license, agreed T&Cs — which the base station/OPi will later require
   before loading a show. v1 reads/writes nothing to this key; it's just a
   reserved name so a later feature can land without migration.
6. **`hold_s` — Option A (editor expands, never emits):**
   - On **load**, any waypoint with `hold_s > 0` is expanded to two
     waypoints at the same `(n, e, d)`: one at `t`, one at `t + hold_s`.
     The loaded model never carries a non-zero `hold_s`.
   - On **save**, the editor never writes a `hold_s` field. Held points
     always appear as paired waypoints in the JSON.
   - Validator rule: when expanding, the new pair's end time must be
     strictly less than the next waypoint's `t` — otherwise the load errors
     out with "heli X wp\[i\] hold overlaps wp\[i+1\]" and the user fixes
     the source file.
   - Benefit: linear interpolation becomes the only interpretation. Canvas
     animation and safety validator agree by construction, no hold-aware/
     hold-unaware split. The daemon's `_interpolate` hold bug (position
     jump at end of hold — see `flight_daemon.py:1067`) stops mattering
     for editor-authored files, since they never use `hold_s`.
   - UX: the side panel keeps a **"Add hold here (N seconds)"** button on
     a selected waypoint. Clicking it inserts the paired waypoint at the
     same position, with `t = selected.t + N`. User sees two dots on the
     canvas at the same `(n, e)`, at different `t`, and can drag either
     independently.
   - Schema / Pydantic / daemon are **untouched** — hand-written files with
     `hold_s` still work on the daemon. Only the editor opts out.

## Build order

Once this design is approved, the v1 build is committed in logical chunks:

1. `model.js` + `validate.js` + example JSONs — exercised via a minimal
   `editor.html` that just loads a file and dumps the parsed model.
2. Canvas: top-down render + pan/zoom, no interaction yet.
3. Canvas: click-to-add, drag, delete; side panel tied to selection.
4. Timeline + scrubber + playback (still no altitude view).
5. Altitude view.
6. Validation panel + jump-to-time.
7. File I/O (Open / Save As / drag-drop).
8. Examples directory + README.

Each chunk is its own commit. Nothing merges to `main` — user reviews on
the branch when v1 is complete.
