# Phase 2β — Base Station Foundation Plan

**Status:** IN PROGRESS — Steps 1-2, 4-6 done (FastAPI + fleet API + web UI deployed)
**Depends on:** Phase 2 complete (outdoor RTK test outstanding)
**Blocks:** Phase 3 (scale to 10)

This phase builds the software foundation on the base station so we don't
have to rework it later when scaling to 10-50+ vehicles and adding
choreographed flight.

---

## Sequencing

```
Phase 2  (first companion)     — ~98% done, outdoor RTK test outstanding
Phase 2β (foundation)          — THIS PLAN
Phase 3  (scale to 10)         — flash images + provision 9 boards
Phase 4  (field RTK)           — outdoor validation
Phase 5  (soak test)           — stability
Phase 6  (hardening)           — failsafes, docs, spares
```

---

## 2β.1 — Two-Mode Routing (Config vs Production)

### Problem
Right now, mavlink-router hub forwards everything to a single GCS UDP
endpoint. We need two distinct operating modes:

### Config Mode
- Route **one heli at a time** to a GCS (Mission Planner / QGC) via
  TCP 5760 or UDP 14550
- Used for: parameter tuning, calibration, PID setup, firmware upload
- The operator selects which heli to work on
- All other helis still report telemetry to the base station but are
  NOT forwarded to the GCS (avoids flooding)

### Production Mode
- Base station swarm controller connects to all helis
- No GCS forwarding — the swarm controller IS the GCS
- Commands (SET_POSITION_TARGET_LOCAL_NED) sent per-vehicle via sysid
- Telemetry from all vehicles consumed by the swarm controller

### Implementation
- Mode switching via a **web API** (not systemd restarts)
- The mavlink-router hub stays running in both modes — it's a dumb router
- A Python service (`roban-base-controller`) sits between the hub and the
  GCS/swarm logic, doing sysid filtering and mode switching
- In CONFIG mode: filter hub traffic, forward only selected heli's sysid
  to the GCS WebSocket/UDP
- In PRODUCTION mode: consume all traffic, accept choreography commands

### API

```
GET  /api/mode                          → { "mode": "config", "selected_heli": 3 }
POST /api/mode/config   { "heli": 3 }  → routes heli03 to GCS
POST /api/mode/production               → stops GCS routing, enables swarm control
```

---

## 2β.2 — HeliID / IP / MAC Assignment Table

### Problem
Currently, HeliID-to-IP mapping is hardcoded in dnsmasq config files.
Adding/removing helis requires SSH + manual editing.

### Solution
A web interface to manage the fleet identity table:

| Field | Source | Example |
|-------|--------|---------|
| HeliID | User-assigned (01-99) | 01 |
| MAC | Auto-discovered or manual | c0:64:94:ab:b4:31 |
| IP | Computed: 192.168.50.(100+ID) | 192.168.50.101 |
| SysID | Computed: ID + 10 | 11 |
| Hub Port | Computed: 14559 + ID | 14560 |
| Status | Live from heartbeat | online/offline |

### Implementation
- REST API: `GET/POST/DELETE /api/fleet`
- Backend writes dnsmasq config + mavlink-router hub config
- Can trigger dnsmasq reload and hub restart via API
- Supports up to 255 vehicles (MAVLink sysid limit)
- Auto-discovery: listen for new MACs on the network, suggest adding them

---

## 2β.3 — Web Interface (Roban Base Control)

### Architecture
Pure web app served from the base station at `http://192.168.50.1:8080`.
Accessible from any device on the Robanswarm WiFi — phone, tablet, laptop.
No install needed.

### Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Backend | Python FastAPI | Already using pymavlink, lightweight, async |
| Frontend | Vanilla JS or Vue 3 | Simple, no build step needed for basic UI |
| Real-time | WebSocket | Vehicle status updates, mode switching |
| 3D viz | Three.js | Flight path visualization, choreography preview |
| Maps | MapLibre GL + PMTiles | Offline map tiles for field use |
| Offline maps | Pre-downloaded PMTiles | ~50-200 MB for operating area |

### Pages

1. **Dashboard** — fleet overview: all helis online/offline, battery,
   GPS fix, current mode (config/production)
2. **Fleet Manager** — HeliID/IP/MAC table, add/remove/edit
3. **Config Console** — select a heli, route to GCS, show live params
4. **Choreography** (future) — 3D spline editor, timeline, preview
5. **Map View** (future) — real-time vehicle positions on map

### Phase 2β scope
Build pages 1-3 only. Pages 4-5 are future phases.

### Offline Map Strategy
1. Pre-download operating area tiles using Protomaps/OpenMapTiles
2. Store as PMTiles file on base station (~50-200 MB)
3. Serve via FastAPI static files
4. MapLibre loads from `http://192.168.50.1:8080/tiles/area.pmtiles`

---

## 2β.4 — Swarm Controller Foundation

### Flight Control Method
**GUIDED mode** with `SET_POSITION_TARGET_LOCAL_NED` (MAVLink msg 84).

DO NOT use ALT_HOLD — it expects RC stick input, not MAVLink commands.
GUIDED mode accepts position + velocity + acceleration setpoints.
ArduPilot's internal PID/EKF handles stabilization.

### Spline Trajectory Streaming
The base station pre-computes 3D spline paths (cubic Hermite or
Catmull-Rom, parameterized by time). At runtime:

1. Evaluate spline at 10-20 Hz per vehicle: `P(t), V(t), A(t)`
2. Pack into `SET_POSITION_TARGET_LOCAL_NED` with type_mask `0x0C00`
   (position + velocity + acceleration)
3. Send to the vehicle's sysid via pymavlink through the hub
4. FC tracks the setpoint using its internal position controller

### Why Not Pre-Upload (Skybrush-style)?
Pre-upload trajectories to each FC's SD card works for drone shows
(Skybrush has done 5000+ drones). But real-time streaming gives us:
- Mid-flight path modification
- Reactive choreography (respond to wind, obstacles, formation changes)
- No firmware fork needed (Skybrush requires custom ArduCopter build)

If we scale beyond ~30 vehicles and WiFi becomes a concern, we can
switch to pre-upload later. The spline math is the same either way.

### Bandwidth Budget (confirmed by analysis)

| Direction | Per Vehicle | 10 Helis | 50 Helis |
|-----------|-----------|----------|----------|
| Commands @ 20 Hz | 1.4 KB/s | 14 KB/s | 68 KB/s |
| Telemetry back | 0.6 KB/s | 6 KB/s | 29 KB/s |
| **Total** | **2 KB/s** | **20 KB/s** | **97 KB/s** |

WiFi capacity: 5-15 MB/s. At 50 vehicles we use ~1% of WiFi.
UART bottleneck (115200): 11.5 KB/s per vehicle, we use ~2 KB/s (17%).
**Everything fits comfortably.**

### Minimum Telemetry for Production Mode

| Message | Rate | Purpose |
|---------|------|---------|
| HEARTBEAT | 1 Hz | Connection status |
| GLOBAL_POSITION_INT | 5 Hz | Position tracking |
| ATTITUDE | 5 Hz | Orientation feedback |
| SYS_STATUS | 1 Hz | Battery monitoring |
| GPS_RAW_INT | 2 Hz | Fix quality / RTK status |

Set via ArduPilot `SR0_*` parameters on each FC:
```
SR0_POSITION  = 5
SR0_EXT_STAT  = 2
SR0_EXTRA1    = 5
SR0_EXTRA2    = 1
SR0_EXTRA3    = 0
SR0_RAW_SENS  = 0
SR0_RC_CHAN   = 0
```

### SysID Scheme

| Entity | SysID | Notes |
|--------|-------|-------|
| Base GCS | 255 | Standard GCS ID |
| Swarm controller | 254 | Choreography software |
| Heli 01 | 11 | HeliID + 10 |
| Heli 02 | 12 | HeliID + 10 |
| ... | ... | ... |
| Heli 50 | 60 | Max practical fleet |

---

## 2β.5 — Base Station Service Architecture

### Services on base station after Phase 2β

| Service | Port | Purpose |
|---------|------|---------|
| mavlink-router hub | UDP 14560-14569, TCP 5760 | MAVLink packet routing |
| ntrip-caster (str2str) | TCP 2101 | RTCM corrections |
| dnsmasq | UDP 53/67 | DNS + DHCP |
| chrony | UDP 123 | NTP time sync |
| roban-base-controller | TCP 8080 | Web UI + API + swarm control |
| nftables | — | Firewall |

### New service: roban-base-controller

```
/opt/roban-swarm/base-controller/
├── main.py                 # FastAPI app entry point
├── api/
│   ├── fleet.py            # HeliID/IP/MAC CRUD
│   ├── mode.py             # Config/Production mode switching
│   └── telemetry.py        # WebSocket telemetry stream
├── mavlink/
│   ├── hub_client.py       # Connect to mavlink-router hub
│   ├── sysid_filter.py     # Per-vehicle message filtering
│   └── commander.py        # Send commands to vehicles
├── choreography/           # Future: spline engine
│   ├── spline.py
│   └── timeline.py
├── static/                 # Web frontend files
│   ├── index.html
│   ├── dashboard.js
│   ├── fleet.js
│   └── config.js
├── tiles/                  # Offline map tiles (PMTiles)
└── requirements.txt        # fastapi, uvicorn, pymavlink
```

### systemd service

```ini
[Unit]
Description=Roban Base Controller (Web UI + Swarm Control)
After=mavlink-hub.service
Wants=mavlink-hub.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8080
WorkingDirectory=/opt/roban-swarm/base-controller
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 2β.6 — Implementation Order

1. **FastAPI skeleton** — `main.py` with health endpoint, systemd service
2. **Fleet API** — CRUD for HeliID/MAC/IP table, writes dnsmasq config
3. **MAVLink client** — connect to hub, parse heartbeats, track online status
4. **Dashboard page** — fleet overview with live status via WebSocket
5. **Mode switching API** — config/production toggle
6. **Config console page** — select heli, route to GCS, show params
7. **Firewall rule** — open TCP 8080

### Not in Phase 2β (future phases)
- Choreography editor (3D spline UI)
- Map view with real-time positions
- Offline tile download tool
- Mobile app wrapper (Tauri/Capacitor)

---

## Decision Log

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Flight control mode | GUIDED + SET_POSITION_TARGET | ALT_HOLD, AUTO waypoints | GUIDED accepts MAVLink pos/vel/accel; ALT_HOLD only takes RC input |
| Trajectory method | Real-time streaming | Pre-upload (Skybrush) | Flexible, no firmware fork, can modify mid-flight |
| Web framework | FastAPI (Python) | Node.js, Tauri | Already using pymavlink; FastAPI is async + lightweight |
| Frontend | Pure web app | Tauri desktop, Electron | Works on any device, no install, offline by design |
| 3D visualization | Three.js | CesiumJS, deck.gl | Lightweight, huge ecosystem, works offline |
| Maps | MapLibre + PMTiles | Leaflet, Google Maps | Offline-capable, vector tiles, field-ready |
| Mode switching | Web API (software) | systemd service toggle | No restart needed, instant switching |
| Scaling approach | Per-port (10), single-port+sysid (50+) | All single-port | Per-port is simpler and more debuggable at 10 |
