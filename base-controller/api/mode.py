"""Mode switching API — Config vs Production, Real vs Sim."""

import logging
import subprocess
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from ._state import set_sim_mode, is_sim_mode

router = APIRouter(tags=["mode"])
log = logging.getLogger("roban.api.mode")

# In-memory mode state (single base station, no persistence needed)
_current_mode = "config"
_selected_heli: Optional[int] = None


class ConfigRequest(BaseModel):
    heli: int


class ModeResponse(BaseModel):
    mode: str
    selected_heli: Optional[int] = None
    sim_mode: bool = False


@router.get("/mode")
async def get_mode():
    return {
        "mode": _current_mode,
        "selected_heli": _selected_heli,
        "sim_mode": is_sim_mode(),
    }


@router.post("/mode/config", response_model=ModeResponse)
async def set_config_mode(req: ConfigRequest):
    global _current_mode, _selected_heli
    _current_mode = "config"
    _selected_heli = req.heli
    # TODO: reconfigure GCS bridge to forward only this heli's sysid
    return ModeResponse(mode=_current_mode, selected_heli=_selected_heli)


@router.post("/mode/production", response_model=ModeResponse)
async def set_production_mode():
    global _current_mode, _selected_heli
    _current_mode = "production"
    _selected_heli = None
    # TODO: stop GCS forwarding, enable swarm controller
    return {"mode": _current_mode, "selected_heli": _selected_heli, "sim_mode": is_sim_mode()}


SIM_LOG = "/tmp/mavlink-sim.log"


def _start_sim():
    """Start the simulator process, handling log permissions."""
    import os
    # Ensure log file is writable by us
    try:
        with open(SIM_LOG, "a"):
            pass
        os.chmod(SIM_LOG, 0o666)
    except Exception:
        pass
    subprocess.Popen(
        ["/opt/roban-swarm/venv/bin/python3", "-u", "/opt/roban-swarm/mavlink-sim.py", "--helis", "2"],
        stdout=open(SIM_LOG, "w"),
        stderr=subprocess.STDOUT,
    )


@router.post("/mode/sim")
async def enable_sim_mode():
    """Switch to simulation mode — flight daemon targets sim sysids (+100)."""
    set_sim_mode(True)
    try:
        _start_sim()
        log.info("SIM mode enabled — simulator started")
    except Exception as e:
        log.warning("SIM mode enabled but simulator failed to start: %s", e)
    return {"mode": _current_mode, "sim_mode": True, "detail": "Sim mode active — sysid offset +100"}


@router.post("/mode/real")
async def disable_sim_mode():
    """Switch to real mode — flight daemon targets real sysids."""
    set_sim_mode(False)
    # Stop the simulator
    try:
        subprocess.run(["pkill", "-f", "mavlink-sim.py"], capture_output=True, timeout=5)
        log.info("SIM mode disabled — simulator stopped")
    except Exception:
        pass
    return {"mode": _current_mode, "sim_mode": False, "detail": "Real mode active"}


@router.post("/mode/sim/reset")
async def reset_sim():
    """Kill and restart the simulator — resets sim helis to ground state."""
    try:
        subprocess.run(["pkill", "-f", "mavlink-sim.py"], capture_output=True, timeout=5)
    except Exception:
        pass

    import asyncio
    await asyncio.sleep(2)

    try:
        _start_sim()
        log.info("SIM helis reset — simulator restarted")
        return {"ok": True, "detail": "Simulator restarted"}
    except Exception as e:
        log.error("SIM reset failed: %s", e)
        return {"ok": False, "error": str(e)}
