# Roban Swarm — Show Editor

Standalone, offline, vanilla-JS tool for authoring show JSON files consumed
by `base-controller/choreography/flight_daemon.py`.

No build step. No npm. No bundler. No network. Open `editor.html` via any
local static server and it works.

## Running

From the repository root:

```bash
cd tools/show-editor
python3 -m http.server 8000
```

Then open `http://localhost:8000/editor.html` in a browser.

(Or any static server — the editor does not need a backend.)

## Views

Top-of-canvas tabs switch between **Top-down** (2D N/E grid, click-to-add
+ drag) and **3D** (orbit camera, vendored Three.js). The **altitude**
view stays pinned below in both modes.

The **Smooth preview** toggle in the header overlays a dashed Catmull-Rom
spline through each track's waypoints — on top-down, altitude, and 3D
all at once. It's a planning aid only: the flight daemon streams **linear**
interpolated targets between waypoints, so the solid colored polylines
are what helis actually fly. The dashed curve helps you see the intended
shape and judge whether you've placed enough waypoints to approximate it.

## Editing basics

- **Load an example** from the dropdown in the header, or **Open** a JSON
  file, or **drag-drop** a JSON onto the window.
- **Click** an empty canvas area with a heli selected to add a waypoint at
  the current scrubber time. Altitude inherits from the interpolated
  position, so a top-down click never moves a heli up or down.
- **Drag** a waypoint dot to reposition it (N/E on the top-down view;
  t + altitude on the altitude view).
- **Delete** / **Backspace** removes the selected waypoint.
- **Shift-drag** or middle-drag or right-drag pans the top-down canvas.
  The mouse wheel zooms.
- **Space** toggles playback. Arrow keys scrub ±1 s (shift ±0.1 s).
  Home / End jump to the ends.
- **1–9** select helis by `heli_id`.
- **Ctrl/Cmd + S / O / N** save / open / new.

## Coordinate system

- **NED, metric.** `n` = north (+), `e` = east (+), `d` = down (+, so
  altitude above ground is `-d`).
- The editor shows altitude as **+ AGL** (positive up, 0 at takeoff). The
  JSON file preserves the NED `d` convention so it round-trips with
  `show_format.py`.
- Coordinates in the show file are relative to the lineup origin, which
  the flight daemon captures on-site from live GPS at `capture_lineup()`.
  The `home_lat / home_lon / home_alt_m` fields in the show file are
  informational — the daemon overrides them at lineup.

## `hold_s` handling

The Pydantic schema supports a `hold_s` field on each waypoint — a dwell
time at the waypoint before moving on. The editor does **not** carry
`hold_s` internally; it expands each `hold_s > 0` on load into a pair of
waypoints at the same `(n, e, d)` (one at `t`, one at `t + hold_s`). On
save, `hold_s` is never emitted — holds always appear as paired waypoints.

Why: linear interpolation becomes the only interpretation of a waypoint
track. The editor's preview, the in-editor validator, and the flight
daemon's position-target stream all agree by construction. See
[DESIGN.md](DESIGN.md) decision 6 for the full reasoning.

Hand-written show files that use `hold_s` still work — both on the daemon
and on load into this editor. You just won't get `hold_s` back if you
re-save.

## Schema reference

The authoritative schema is the Pydantic model at
[`base-controller/choreography/show_format.py`](../../base-controller/choreography/show_format.py).
Anywhere this README and that file disagree, the Pydantic file wins.

Short version:

```jsonc
{
  "name": "…",
  "version": 1,
  "home_lat": 0,              // informational; daemon captures real value
  "home_lon": 0,
  "home_alt_m": 0,
  "duration_s": 60,           // > 0; >= max waypoint t
  "tracks": [                 // >= 1
    {
      "heli_id": 1,           // 1..99, unique
      "style": {              // flight dynamics for the planner
        "max_speed": 5.0,     // m/s
        "max_accel": 2.0,     // m/s²
        "max_jerk":  5.0,     // m/s³
        "angle_max_deg": 30,  // 0 < angle <= 60 (max lean / bank)
        "corner_radius": 2.0  // m (>= 0)
      },
      "waypoints": [          // >= 1, ordered by t ascending
        { "t": 0, "pos": { "n": 0, "e": 0, "d": -5 } },
        { "t": 10, "pos": { "n": 5, "e": 0, "d": -5 },
          "vel": { "n": 0, "e": 0, "d": 0 } },
        { "t": 20, "pos": { "n": 5, "e": 0, "d": -5 } }
      ]
    }
  ]
}
```

## Validating a file externally

The in-editor validator ports `validate_timing` and `validate_safety` from
the Pydantic model. If you want a second opinion from the Python side:

```bash
cd base-controller
python3 -c "
import json
from choreography.show_format import ShowFile
with open('path/to/show.json') as f:
    show = ShowFile(**json.load(f))
print('timing:', show.validate_timing() or 'ok')
print('safety:', show.validate_safety() or 'ok')
"
```

Any show the editor exports should load cleanly via `ShowFile(**data)`.

## Files

```
tools/show-editor/
  editor.html                 single page entry point
  README.md                   this file
  DESIGN.md                   scope, decisions, rationale
  css/style.css               dark theme
  js/
    model.js                  show data + event bus + JSON I/O
    validate.js               timing + safety checks
    canvas.js                 top-down N/E view
    altitude.js               altitude-over-time view
    view3d.js                 3D view (uses vendored Three.js)
    timeline.js               scrubber + playback
    sidepanel.js              show / heli / waypoint edit tree
    smoothing.js              Catmull-Rom helper for smooth-preview overlay
    colors.js                 heli palette + speed gradient
    app.js                    DOM wiring, keyboard shortcuts
  examples/
    figure8_single.json       one heli, figure-8 (uses hold_s)
    crossing_two.json         two helis crossing at staggered alts
    formation_three.json      three helis rotating a triangle
    helix_eight.json          eight helis, counter-rotating helix
  vendor/
    three.module.js           Three.js r160 (MIT) — vendored, no network
    three-addons/             OrbitControls etc. for the 3D view
```

## What's not in v1

See the "v2 candidates" section of [DESIGN.md](DESIGN.md) — notable
remaining items include a terrain / map overlay, a jerk-limited
trajectory preview that matches what helis actually fly, collision heat
maps, and an operator-registration stub for future KYC requirements.

The 3D view and smooth-preview overlay listed in DESIGN.md as v2
candidates have been **pulled forward** into this v1 build.
