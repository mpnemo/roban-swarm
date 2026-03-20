"""Fleet management API — HeliID / MAC / IP table CRUD."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from fleet_store import fleet_store

router = APIRouter(tags=["fleet"])


class HeliCreate(BaseModel):
    id: int = Field(..., ge=1, le=99, description="Heli ID (01-99)")
    mac: str = Field(..., pattern=r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")
    name: Optional[str] = None


class HeliUpdate(BaseModel):
    mac: Optional[str] = Field(None, pattern=r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")
    name: Optional[str] = None


class HeliOut(BaseModel):
    id: int
    mac: str
    name: str
    ip: str
    sysid: int
    hub_port: int
    status: str  # "unknown" until vehicle tracker fills it in


@router.get("/fleet", response_model=list[HeliOut])
async def list_fleet():
    return fleet_store.list_all()


@router.post("/fleet", response_model=HeliOut, status_code=201)
async def add_heli(heli: HeliCreate):
    try:
        return fleet_store.add(heli.id, heli.mac, heli.name)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/fleet/{heli_id}", response_model=HeliOut)
async def get_heli(heli_id: int):
    h = fleet_store.get(heli_id)
    if not h:
        raise HTTPException(status_code=404, detail="Heli not found")
    return h


@router.put("/fleet/{heli_id}", response_model=HeliOut)
async def update_heli(heli_id: int, update: HeliUpdate):
    h = fleet_store.update(heli_id, mac=update.mac, name=update.name)
    if not h:
        raise HTTPException(status_code=404, detail="Heli not found")
    return h


@router.delete("/fleet/{heli_id}", status_code=204)
async def delete_heli(heli_id: int):
    if not fleet_store.delete(heli_id):
        raise HTTPException(status_code=404, detail="Heli not found")


@router.post("/fleet/apply")
async def apply_fleet():
    """Regenerate dnsmasq + mavlink-hub configs and restart services."""
    result = fleet_store.apply_configs()
    return {"status": "applied", "details": result}
