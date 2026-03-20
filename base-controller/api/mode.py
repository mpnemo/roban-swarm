"""Mode switching API — Config vs Production."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

router = APIRouter(tags=["mode"])

# In-memory mode state (single base station, no persistence needed)
_current_mode = "config"
_selected_heli: Optional[int] = None


class ConfigRequest(BaseModel):
    heli: int


class ModeResponse(BaseModel):
    mode: str
    selected_heli: Optional[int] = None


@router.get("/mode", response_model=ModeResponse)
async def get_mode():
    return ModeResponse(mode=_current_mode, selected_heli=_selected_heli)


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
    return ModeResponse(mode=_current_mode, selected_heli=_selected_heli)
