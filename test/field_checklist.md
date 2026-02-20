# Field Checklist

**Outdoor deployment with clear sky view.**

## Site Setup

- [ ] Select location with clear sky view (minimal obstructions above 15 deg elevation)
- [ ] Set up base station GNSS antenna on stable surface (tripod recommended)
- [ ] Ground plane under base antenna if available
- [ ] Power on base station and AP (see ops_runbook.md for power-on order)

## Base Station GNSS

- [ ] RTKBase shows satellite tracking (> 10 satellites)
- [ ] Survey-in starts (or fixed coordinates load)
- [ ] Survey-in completes (status shows "Fixed" or fixed coords loaded)
  ```bash
  journalctl -u rtkbase -f
  ```
- [ ] NTRIP caster shows mount point available
  ```bash
  ./base-station/tools/show_rtk_clients.sh
  ```

## RTK Quality (per heli)

### Initial Fix
- [ ] Companion connects and receives RTCM
- [ ] GPS shows 3D Fix within 30 seconds
- [ ] GPS shows RTK Float within 1–5 minutes
- [ ] GPS shows RTK Fix within 2–10 minutes
  ```
  GCS → GPS_RAW_INT.fix_type:
    3 = 3D Fix
    5 = RTK Float
    6 = RTK Fix  ← target
  ```

### Fix Quality
- [ ] Horizontal accuracy < 50 mm in RTK Fix
- [ ] Correction age < 5 seconds (check GPS_RTK message if available)
- [ ] Fix is stable (does not toggle between Float and Fix rapidly)

### Multi-Vehicle RTK
- [ ] All powered helis achieve RTK Float or better
- [ ] Baseline distance reasonable (all within a few km of base)
- [ ] No helis stuck in standalone 3D Fix (indicates RTCM not reaching)

## Communication Quality

- [ ] WiFi signal strength acceptable for all companions
  ```bash
  # On companion:
  iwconfig wlan0 2>/dev/null | grep "Signal level"
  # or
  nmcli dev wifi list | grep RTK-FIELD
  ```
- [ ] Telemetry update rate stable in GCS
- [ ] No visible latency in command response
- [ ] Range test: walk to expected operating boundary, verify connectivity

## Environmental Checks

- [ ] Wind conditions acceptable
- [ ] Temperature within hardware operating range
- [ ] No rain/moisture on electronics
- [ ] No RF interference visible (check WiFi channel scan)

## Pre-Flight Final

- [ ] All bench checklist items still passing
- [ ] RTK Fix confirmed on all helis that will fly
- [ ] GCS shows all vehicle positions accurately on map
- [ ] Emergency procedures reviewed (see ops_runbook.md)
- [ ] RTL (Return to Launch) configured as failsafe on all helis

## Field Notes

| Time | Heli | Fix Type | H.Acc (mm) | Notes |
|------|------|----------|------------|-------|
| | | | | |
| | | | | |
| | | | | |
