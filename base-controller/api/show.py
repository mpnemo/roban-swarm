"""Show lifecycle API — upload, arm, go, pause, resume, stop."""

from fastapi import APIRouter, HTTPException

from choreography.show_format import ShowFile

router = APIRouter(tags=["show"])


def _get_daemon():
    """Get the flight daemon instance from the module-level reference."""
    from api._state import get_daemon
    return get_daemon()


@router.post("/show/upload")
async def upload_show(show: ShowFile):
    """Upload and validate a show file (JSON body)."""
    daemon = _get_daemon()
    errors = daemon.load_show(show)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    return {
        "status": "loaded",
        "name": show.name,
        "tracks": len(show.tracks),
        "duration_s": show.duration_s,
        "heli_ids": [t.heli_id for t in show.tracks],
    }


@router.get("/show/status")
async def show_status():
    """Get current show/daemon state."""
    daemon = _get_daemon()
    return {
        "state": daemon.state.value,
        "elapsed_s": round(daemon.elapsed_s, 1),
        "show_name": daemon.show.name if daemon.show else None,
        "duration_s": daemon.show.duration_s if daemon.show else 0,
        "tracks": len(daemon.show.tracks) if daemon.show else 0,
    }


@router.post("/show/arm")
async def arm_show():
    """Run pre-flight checks. Returns per-heli readiness report."""
    daemon = _get_daemon()
    checks = await daemon.arm()
    armed = all(c["ok"] for c in checks) if checks else False
    return {
        "armed": armed,
        "state": daemon.state.value,
        "checks": checks,
    }


@router.post("/show/go")
async def go_show():
    """Start the show (staging → playback)."""
    daemon = _get_daemon()
    try:
        await daemon.go()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"status": "started", "state": daemon.state.value}


@router.post("/show/pause")
async def pause_show():
    """Pause playback — helis hold position."""
    daemon = _get_daemon()
    await daemon.pause()
    return {"status": "paused", "state": daemon.state.value}


@router.post("/show/resume")
async def resume_show():
    """Resume from pause."""
    daemon = _get_daemon()
    await daemon.resume()
    return {"status": "resumed", "state": daemon.state.value}


@router.post("/show/stop")
async def stop_show():
    """Emergency stop — BRAKE all helis."""
    daemon = _get_daemon()
    await daemon.stop()
    return {"status": "stopped", "state": daemon.state.value}
