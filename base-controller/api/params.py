"""FC parameter check + set API — verify and correct ArduPilot params per heli."""

import asyncio
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from fleet_store import fleet_store, _compute_fields
from api._state import get_tracker, get_daemon

router = APIRouter(tags=["params"])
log = logging.getLogger("roban.params")

# Expected ArduPilot parameters per heli
# SYSID_THISMAV is computed as 10 + heli_id
EXPECTED_PARAMS = {
    "GPS1_TYPE": 14,
    "GPS_AUTO_CONFIG": 0,
    "SERIAL2_PROTOCOL": 2,
    "SERIAL2_BAUD": 115,  # 115 = 115200 (ArduPilot uses baud/1000)
    # Failsafe params — critical for flight safety
    "FS_GCS_ENABLE": 1,       # RTL on GCS heartbeat loss (OPi/WiFi dies)
    "FS_THR_ENABLE": 1,       # RTL on RC/throttle loss
    "BATT_FS_LOW_ACT": 2,     # RTL on low battery
}


def _get_sender():
    """Get the CommandSender singleton (created in main.py lifespan)."""
    from api._state import _tracker  # access the module-level state
    import main
    return main._sender


class ParamSetRequest(BaseModel):
    param: str
    value: float


@router.get("/fleet/{heli_id}/params")
async def read_params(heli_id: int):
    """Read and check critical FC parameters for a heli.

    Returns expected vs actual values with ok/mismatch status.
    """
    h = fleet_store.get(heli_id)
    if not h:
        raise HTTPException(status_code=404, detail="Heli not found")

    sender = _get_sender()
    if not sender:
        raise HTTPException(status_code=503, detail="Command sender not ready")

    # Expected SYSID for this heli
    expected_sysid = 10 + heli_id
    check_params = {**EXPECTED_PARAMS, "SYSID_THISMAV": expected_sysid}

    loop = asyncio.get_running_loop()

    # Read all params (blocking calls — run in executor)
    actual = await loop.run_in_executor(
        None,
        sender.read_params_batch, heli_id,
        list(check_params.keys()),
    )

    results = []
    all_ok = True
    for param, expected in check_params.items():
        actual_val = actual.get(param)
        ok = actual_val is not None and int(actual_val) == int(expected)
        if not ok:
            all_ok = False
        results.append({
            "param": param,
            "expected": expected,
            "actual": int(actual_val) if actual_val is not None else None,
            "ok": ok,
        })

    return {
        "heli_id": heli_id,
        "sysid": expected_sysid,
        "ip": h["ip"],
        "name": h["name"],
        "all_ok": all_ok,
        "params": results,
    }


@router.post("/fleet/{heli_id}/params")
async def set_param(heli_id: int, req: ParamSetRequest):
    """Set a single FC parameter on a heli."""
    h = fleet_store.get(heli_id)
    if not h:
        raise HTTPException(status_code=404, detail="Heli not found")

    sender = _get_sender()
    if not sender:
        raise HTTPException(status_code=503, detail="Command sender not ready")

    loop = asyncio.get_running_loop()
    ok = await loop.run_in_executor(
        None, sender.set_param, heli_id, req.param, req.value,
    )

    if ok:
        return {"status": "ok", "param": req.param, "value": req.value}
    else:
        raise HTTPException(status_code=504, detail=f"No ACK for {req.param}")


@router.post("/fleet/{heli_id}/params/fix")
async def fix_all_params(heli_id: int):
    """Set all mismatched params to expected values."""
    h = fleet_store.get(heli_id)
    if not h:
        raise HTTPException(status_code=404, detail="Heli not found")

    sender = _get_sender()
    if not sender:
        raise HTTPException(status_code=503, detail="Command sender not ready")

    expected_sysid = 10 + heli_id
    check_params = {**EXPECTED_PARAMS, "SYSID_THISMAV": expected_sysid}

    loop = asyncio.get_running_loop()

    # Read current values
    actual = await loop.run_in_executor(
        None, sender.read_params_batch, heli_id, list(check_params.keys()),
    )

    # Set only mismatched params
    results = []
    for param, expected in check_params.items():
        actual_val = actual.get(param)
        if actual_val is not None and int(actual_val) == int(expected):
            results.append({"param": param, "status": "ok", "value": expected})
            continue
        ok = await loop.run_in_executor(
            None, sender.set_param, heli_id, param, float(expected),
        )
        results.append({
            "param": param,
            "status": "set" if ok else "failed",
            "value": expected,
        })

    return {"heli_id": heli_id, "results": results}


@router.get("/fleet/params/summary")
async def params_summary():
    """Quick summary: which helis have param mismatches.

    Returns a lightweight list for dashboard badges (no actual param reads —
    uses cached tracker data for SYSID check, rest is async on-demand).
    """
    tracker = get_tracker()
    helis = fleet_store.list_all()
    summary = []

    for h in helis:
        expected_sysid = h["sysid"]  # 10 + heli_id
        v = tracker.get(expected_sysid) if tracker else None

        if v is None:
            # Not seen — might be wrong sysid
            summary.append({
                "heli_id": h["id"],
                "name": h["name"],
                "ip": h["ip"],
                "expected_sysid": expected_sysid,
                "online": False,
                "sysid_ok": False,
                "needs_check": True,
            })
        else:
            summary.append({
                "heli_id": h["id"],
                "name": h["name"],
                "ip": h["ip"],
                "expected_sysid": expected_sysid,
                "online": v["online"],
                "sysid_ok": True,
                "needs_check": False,  # Can do full check on demand
            })

    return summary
