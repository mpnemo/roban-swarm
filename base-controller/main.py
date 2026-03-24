"""Roban Swarm Base Controller — FastAPI application."""

import asyncio
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from api.fleet import router as fleet_router
from api.mode import router as mode_router
from api.show import router as show_router
from api.base import router as base_router
from api.params import router as params_router
from api._state import set_daemon, set_tracker
from mavlink.vehicle_tracker import VehicleTracker
from mavlink.command_sender import CommandSender
from choreography.safety_monitor import SafetyMonitor
from choreography.flight_daemon import FlightDaemon

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)-20s %(levelname)s  %(message)s",
)
log = logging.getLogger("roban.main")

_start_time = time.time()

# --- WebSocket manager ---
_ws_clients: set[WebSocket] = set()


async def _ws_broadcast(payload: dict):
    """Send a JSON payload to all connected WebSocket clients."""
    dead = []
    for ws in _ws_clients:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


# --- Singletons ---
_tracker: VehicleTracker | None = None
_sender: CommandSender | None = None
_daemon: FlightDaemon | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    global _tracker, _sender, _daemon

    # MAVLink telemetry (read path)
    _tracker = VehicleTracker(
        hub_addr="127.0.0.1:5760",
        on_update=_ws_broadcast,
    )
    await _tracker.start()
    set_tracker(_tracker)

    # MAVLink commands (write path)
    _sender = CommandSender()
    _sender.set_hub_client(_tracker._hub)  # Share TCP connection for param read/write

    # Safety monitor (collision avoidance + geofence)
    _safety = SafetyMonitor(
        command_sender=_sender,
        min_separation_m=3.0,
        max_radius_m=100.0,
        max_alt_m=50.0,
        on_event=_ws_broadcast,
    )

    # Flight daemon (show playback)
    _daemon = FlightDaemon(
        tracker=_tracker,
        command_sender=_sender,
        safety_monitor=_safety,
        on_event=_ws_broadcast,
    )
    set_daemon(_daemon)

    log.info("Base controller v%s started", app.version)
    yield

    # Shutdown
    if _daemon and _daemon.state.value not in ("idle", "done", "error"):
        await _daemon.stop()
    _sender.close_all()
    await _tracker.stop()
    log.info("Base controller stopped")


app = FastAPI(
    title="Roban Swarm Controller",
    version="0.3.0",
    lifespan=lifespan,
)

# --- API routers ---
app.include_router(fleet_router, prefix="/api")
app.include_router(mode_router, prefix="/api")
app.include_router(show_router, prefix="/api")
app.include_router(base_router, prefix="/api")
app.include_router(params_router, prefix="/api")


@app.get("/api/health")
async def health():
    vehicles = _tracker.get_all() if _tracker else []
    return {
        "status": "ok",
        "uptime_s": round(time.time() - _start_time, 1),
        "version": app.version,
        "vehicles_online": sum(1 for v in vehicles if v["online"]),
        "vehicles_total": len(vehicles),
        "show_state": _daemon.state.value if _daemon else "idle",
    }


@app.get("/api/vehicles")
async def list_vehicles():
    """Live telemetry snapshot for all tracked vehicles."""
    if not _tracker:
        return []
    return _tracker.get_all()


@app.websocket("/ws/telemetry")
async def ws_telemetry(websocket: WebSocket):
    """WebSocket endpoint — streams vehicle_update + show events to the browser."""
    await websocket.accept()
    _ws_clients.add(websocket)
    log.info("WebSocket client connected (%d total)", len(_ws_clients))
    try:
        # Send current state snapshot on connect
        if _tracker:
            for v in _tracker.get_all():
                await websocket.send_json({"type": "vehicle_update", "vehicle": v})
        # Send current show status
        if _daemon and _daemon.show:
            await websocket.send_json({
                "type": "show_status",
                "state": _daemon.state.value,
                "elapsed_s": round(_daemon.elapsed_s, 1),
                "duration_s": _daemon.show.duration_s,
                "show_name": _daemon.show.name,
            })
        # Keep alive — wait for client disconnect
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(websocket)
        log.info("WebSocket client disconnected (%d remaining)", len(_ws_clients))


# --- Static frontend (must be last — catches all unmatched paths) ---
app.mount("/", StaticFiles(directory="static", html=True), name="static")
