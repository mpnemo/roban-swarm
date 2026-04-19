"""Per-heli GPS toggle, control mode toggle, fleet-wide toggles, and FC reboot."""

import asyncio
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from pymavlink import mavutil

from fleet_store import fleet_store
from api._state import get_tracker, get_sysid_offset

router = APIRouter(tags=["toggles"])
log = logging.getLogger("roban.toggles")


def _get_sender():
    import main
    return main._sender


# ---------------------------------------------------------------------------
# Parameter sets
# ---------------------------------------------------------------------------

GPS_RTK_PARAMS = {
    "GPS1_TYPE": 14,
    "GPS_AUTO_CONFIG": 0,
    "SERIAL3_PROTOCOL": -1,
}

GPS_DIRECT_PARAMS = {
    "GPS1_TYPE": 1,
    "GPS_AUTO_CONFIG": 1,
    "SERIAL3_PROTOCOL": 5,
    "SERIAL3_BAUD": 230,
}

CONTROL_SWARM_PARAMS = {
    "FS_GCS_ENABLE": 1,
    "FS_THR_ENABLE": 0,
    "RC8_OPTION": 0,
}

CONTROL_RC_PARAMS = {
    "FS_GCS_ENABLE": 0,
    "FS_THR_ENABLE": 1,
    "RC8_OPTION": 32,
}

# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ToggleGPSRequest(BaseModel):
    mode: str  # "rtk" or "direct"


class ToggleControlRequest(BaseModel):
    mode: str  # "swarm" or "rc"


class ToggleAllRequest(BaseModel):
    mode: str  # "swarm" or "rc"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_heli(heli_id: int):
    h = fleet_store.get(heli_id)
    if not h:
        raise HTTPException(status_code=404, detail="Heli not found")
    return h


def _require_sender():
    sender = _get_sender()
    if not sender:
        raise HTTPException(status_code=503, detail="Command sender not ready")
    return sender


async def _set_params(sender, heli_id: int, params: dict) -> list[str]:
    """Set a dict of params via executor. Returns list of param names set."""
    loop = asyncio.get_running_loop()
    set_names = []
    for param, value in params.items():
        ok = await loop.run_in_executor(
            None, sender.set_param, heli_id, param, float(value),
        )
        if not ok:
            raise HTTPException(
                status_code=504, detail=f"No ACK for {param}",
            )
        set_names.append(param)
    return set_names


async def _read_param(sender, heli_id: int, param: str):
    """Read a single param via executor. Returns value or None."""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, sender.read_param, heli_id, param,
    )
    return result


async def _send_reboot(sender, heli_id: int):
    """Send MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN (param1=1) to reboot the FC."""
    conn = sender._get_conn(heli_id)
    target_system = 10 + heli_id + get_sysid_offset()
    conn.mav.command_long_send(
        target_system, 1,
        mavutil.mavlink.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN,
        0, 1, 0, 0, 0, 0, 0, 0,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/fleet/{heli_id}/toggle/gps")
async def toggle_gps(heli_id: int, req: ToggleGPSRequest):
    """Toggle GPS mode between RTK (MAVLink GPS_INPUT) and direct (serial)."""
    _require_heli(heli_id)
    sender = _require_sender()

    if req.mode == "rtk":
        params = GPS_RTK_PARAMS
    elif req.mode == "direct":
        params = GPS_DIRECT_PARAMS
    else:
        raise HTTPException(status_code=400, detail="mode must be 'rtk' or 'direct'")

    set_names = await _set_params(sender, heli_id, params)
    await _send_reboot(sender, heli_id)

    log.info("heli%d GPS → %s, rebooting", heli_id, req.mode)
    return {"ok": True, "mode": req.mode, "rebooting": True, "params_set": set_names}


@router.post("/fleet/{heli_id}/toggle/control")
async def toggle_control(heli_id: int, req: ToggleControlRequest):
    """Toggle control mode between swarm (GCS failsafe) and RC (throttle failsafe)."""
    _require_heli(heli_id)
    sender = _require_sender()

    if req.mode == "swarm":
        # Verify GPS is in RTK mode first
        gps_type = await _read_param(sender, heli_id, "GPS1_TYPE")
        if gps_type is None or int(gps_type) != 14:
            raise HTTPException(
                status_code=409,
                detail="Cannot enable swarm without RTK GPS",
            )
        params = CONTROL_SWARM_PARAMS
    elif req.mode == "rc":
        params = CONTROL_RC_PARAMS
    else:
        raise HTTPException(status_code=400, detail="mode must be 'swarm' or 'rc'")

    set_names = await _set_params(sender, heli_id, params)

    log.info("heli%d control → %s", heli_id, req.mode)
    return {"ok": True, "mode": req.mode, "params_set": set_names}


@router.post("/fleet/toggle/all")
async def toggle_all(req: ToggleAllRequest):
    """Toggle all helis between swarm and RC mode."""
    sender = _require_sender()
    helis = fleet_store.list_all()

    if req.mode not in ("swarm", "rc"):
        raise HTTPException(status_code=400, detail="mode must be 'swarm' or 'rc'")

    results = []

    for h in helis:
        hid = h["id"]
        entry = {"heli_id": hid, "name": h["name"]}
        try:
            if req.mode == "swarm":
                # GPS → RTK, reboot, wait, then control → swarm
                await _set_params(sender, hid, GPS_RTK_PARAMS)
                await _send_reboot(sender, hid)
                log.info("heli%d GPS → rtk, rebooting — waiting 8s", hid)
                await asyncio.sleep(8)
                await _set_params(sender, hid, CONTROL_SWARM_PARAMS)
                entry["status"] = "ok"
                entry["gps"] = "rtk"
                entry["control"] = "swarm"
            else:  # rc
                # Control → RC first, then GPS → direct, reboot
                await _set_params(sender, hid, CONTROL_RC_PARAMS)
                await _set_params(sender, hid, GPS_DIRECT_PARAMS)
                await _send_reboot(sender, hid)
                entry["status"] = "ok"
                entry["gps"] = "direct"
                entry["control"] = "rc"
        except HTTPException as exc:
            entry["status"] = "error"
            entry["detail"] = exc.detail
        except Exception as exc:
            entry["status"] = "error"
            entry["detail"] = str(exc)

        results.append(entry)

    log.info("fleet toggle → %s: %d helis", req.mode, len(results))
    return {"ok": True, "mode": req.mode, "results": results}


@router.post("/fleet/{heli_id}/reboot")
async def reboot_fc(heli_id: int):
    """Send FC reboot command (MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN)."""
    _require_heli(heli_id)
    sender = _require_sender()

    await _send_reboot(sender, heli_id)

    log.info("heli%d reboot command sent", heli_id)
    return {"ok": True, "detail": "Reboot command sent"}


@router.get("/fleet/{heli_id}/toggle/status")
async def toggle_status(heli_id: int):
    """Read current GPS and control mode from FC parameters."""
    _require_heli(heli_id)
    sender = _require_sender()

    gps_type = await _read_param(sender, heli_id, "GPS1_TYPE")
    fs_gcs = await _read_param(sender, heli_id, "FS_GCS_ENABLE")
    rc8_opt = await _read_param(sender, heli_id, "RC8_OPTION")

    # Determine GPS mode
    if gps_type is not None and int(gps_type) == 14:
        gps_mode = "rtk"
    elif gps_type is not None and int(gps_type) == 1:
        gps_mode = "direct"
    else:
        gps_mode = "unknown"

    # Determine control mode
    if (fs_gcs is not None and int(fs_gcs) == 1
            and rc8_opt is not None and int(rc8_opt) == 0):
        control_mode = "swarm"
    elif (fs_gcs is not None and int(fs_gcs) == 0
            and rc8_opt is not None and int(rc8_opt) == 32):
        control_mode = "rc"
    else:
        control_mode = "unknown"

    return {
        "heli_id": heli_id,
        "gps_mode": gps_mode,
        "control_mode": control_mode,
        "raw": {
            "GPS1_TYPE": int(gps_type) if gps_type is not None else None,
            "FS_GCS_ENABLE": int(fs_gcs) if fs_gcs is not None else None,
            "RC8_OPTION": int(rc8_opt) if rc8_opt is not None else None,
        },
    }
