"""Roban Swarm Base Controller — FastAPI application."""

import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from api.fleet import router as fleet_router
from api.mode import router as mode_router

_start_time = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # TODO: start MAVLink hub client + vehicle tracker here
    yield
    # TODO: stop MAVLink hub client here


app = FastAPI(
    title="Roban Swarm Controller",
    version="0.1.0",
    lifespan=lifespan,
)

# --- API routers ---
app.include_router(fleet_router, prefix="/api")
app.include_router(mode_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "uptime_s": round(time.time() - _start_time, 1),
        "version": app.version,
    }


# --- Static frontend (must be last — catches all unmatched paths) ---
app.mount("/", StaticFiles(directory="static", html=True), name="static")
