"""Show management + flight operations API."""

import logging
from fastapi import APIRouter, HTTPException

from ._state import get_daemon

router = APIRouter(tags=["show"])
log = logging.getLogger("roban.api.show")


@router.post("/show/upload")
async def upload_show(body: dict):
    """Upload and validate a show file (JSON body)."""
    from choreography.show_format import ShowFile
    try:
        show = ShowFile(**body)
    except Exception as e:
        raise HTTPException(400, detail=str(e))

    daemon = get_daemon()
    errors = daemon.load_show(show)
    if errors:
        raise HTTPException(422, detail={"errors": errors})

    safety_warnings = show.validate_safety()
    return {
        "status": "loaded",
        "name": show.name,
        "tracks": len(show.tracks),
        "duration_s": show.duration_s,
        "heli_ids": show.get_heli_ids(),
        "safety_warnings": safety_warnings,
    }


@router.get("/show/status")
async def show_status():
    """Current show + operations status."""
    daemon = get_daemon()
    return {
        "state": daemon.state.value,
        "elapsed_s": round(daemon.elapsed_s, 1),
        "show_name": daemon.show.name if daemon.show else None,
        "duration_s": daemon.show.duration_s if daemon.show else 0,
        "tracks": len(daemon.show.tracks) if daemon.show else 0,
        "heli_phases": daemon.heli_phases,
        "lineup": daemon.lineup.to_dict() if daemon.lineup else None,
    }


@router.post("/show/lineup")
async def capture_lineup():
    """Capture GPS positions of all show helis, compute NED origin."""
    daemon = get_daemon()
    result = await daemon.capture_lineup()
    if not result["ok"]:
        raise HTTPException(422, detail={"errors": result["errors"]})
    return result


@router.get("/show/lineup")
async def get_lineup():
    """Get current lineup data."""
    daemon = get_daemon()
    if not daemon.lineup:
        return {"lineup": None}
    return {"lineup": daemon.lineup.to_dict()}


@router.post("/show/preflight")
async def preflight_check():
    """Run preflight checks (GPS, battery, RTL_ALT, etc.)."""
    daemon = get_daemon()
    checks = await daemon.preflight()
    all_ok = all(c["ok"] for c in checks)
    return {
        "ok": all_ok,
        "state": daemon.state.value,
        "checks": checks,
    }


@router.post("/show/preflight/fix")
async def fix_preflight():
    """Auto-fix preflight issues (set RTL_ALT, etc.)."""
    daemon = get_daemon()
    results = await daemon.fix_preflight()
    return {"results": results}


@router.post("/show/launch")
async def launch():
    """Full automated launch: arm → spool → takeoff → stage → hold."""
    daemon = get_daemon()
    try:
        await daemon.launch()
    except RuntimeError as e:
        raise HTTPException(409, detail=str(e))
    return {"status": "launching", "state": daemon.state.value}


@router.post("/show/go")
async def go():
    """Start show playback (from staging hold)."""
    daemon = get_daemon()
    try:
        await daemon.go()
    except RuntimeError as e:
        raise HTTPException(409, detail=str(e))
    return {"status": "running", "state": daemon.state.value}


@router.post("/show/pause")
async def pause():
    daemon = get_daemon()
    await daemon.pause()
    return {"status": "paused", "state": daemon.state.value}


@router.post("/show/resume")
async def resume():
    daemon = get_daemon()
    await daemon.resume()
    return {"status": "resumed", "state": daemon.state.value}


@router.post("/show/land")
async def land():
    """Controlled return to home + sequential landing."""
    daemon = get_daemon()
    try:
        await daemon.land()
    except RuntimeError as e:
        raise HTTPException(409, detail=str(e))
    return {"status": "landing", "state": daemon.state.value}


@router.post("/show/rtl")
async def rtl_all():
    """Emergency RTL — staggered altitudes, ArduPilot takes over."""
    daemon = get_daemon()
    await daemon.rtl_all()
    return {"status": "rtl", "state": daemon.state.value}


@router.post("/show/stop")
async def stop():
    """Emergency stop — BRAKE all helis."""
    daemon = get_daemon()
    await daemon.stop()
    return {"status": "stopped", "state": daemon.state.value}
