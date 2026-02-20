# ArduPilot Parameter Guide

## Critical Parameters Per Heli

### SYSID_THISMAV — Vehicle Identity

Each helicopter **must** have a unique `SYSID_THISMAV`. Duplicate SYSIDs
cause GCS to merge telemetry streams and mis-route commands.

| Heli | SYSID_THISMAV |
|------|---------------|
| Heli01 | 11 |
| Heli02 | 12 |
| Heli03 | 13 |
| Heli04 | 14 |
| Heli05 | 15 |
| Heli06 | 16 |
| Heli07 | 17 |
| Heli08 | 18 |
| Heli09 | 19 |
| Heli10 | 20 |

**Range 11–20** is used to avoid conflicts with default SYSID=1 and
common GCS component IDs (typically 255).

Set via GCS parameter editor or MAVLink command:
```
param set SYSID_THISMAV 11
```

### GPS Port Configuration

The LC29H connects to the FC's GPS serial port. Configure the
corresponding SERIALx parameters.

Identify which serial port is your GPS port (varies by FC):

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SERIALx_PROTOCOL` | 5 (GPS) | x = serial port number for GPS |
| `SERIALx_BAUD` | 115 (115200) | Match LC29H output baud rate |
| `GPS_TYPE` | 2 (u-blox) or 5 (NMEA) | Depends on LC29H output mode |
| `GPS_TYPE` | 26 (Unicore) | Try if u-blox/NMEA don't work — LC29H may need specific driver |

**Determine GPS_TYPE empirically:**
1. Set `GPS_TYPE = 2` (u-blox) first — LC29H supports UBX protocol
2. If no fix, try `GPS_TYPE = 5` (NMEA)
3. Check ArduPilot docs for LC29H-specific driver support

### TELEM Port Configuration

The companion connects to a TELEM serial port for MAVLink.

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SERIALx_PROTOCOL` | 2 (MAVLink 2) | x = serial port number for TELEM |
| `SERIALx_BAUD` | 921 (921600) | High baud for low latency |

### Stream Rates (optional tuning)

If bandwidth is constrained with 10 helis, reduce stream rates:

| Parameter | Default | Reduced | Notes |
|-----------|---------|---------|-------|
| `SR1_EXTRA1` | 4 | 2 | Attitude |
| `SR1_EXTRA2` | 4 | 2 | VFR_HUD |
| `SR1_EXTRA3` | 2 | 1 | AHRS, battery |
| `SR1_POSITION` | 2 | 2 | GPS position |
| `SR1_RAW_SENS` | 2 | 1 | Raw sensors |
| `SR1_RC_CHAN` | 2 | 1 | RC channels |

Adjust `SR1_*` to match your TELEM port number.

## RTK Status Verification

Once RTCM corrections are flowing to the LC29H, check RTK status in GCS:

### In MAVLink Messages

- **GPS_RAW_INT.fix_type:**
  - 3 = 3D Fix (no RTK)
  - 4 = DGPS
  - 5 = RTK Float
  - 6 = RTK Fix ← target

- **GPS_RAW_INT.h_acc:** Horizontal accuracy in mm
  - Standalone: ~1500 mm (1.5 m)
  - RTK Float: ~200–500 mm
  - RTK Fix: ~10–20 mm

### In Mission Planner

- HUD shows "RTK Fix" or "RTK Float" next to GPS icon
- "3D Fix" with high hdop means corrections are not reaching the receiver

### In QGroundControl

- GPS indicator shows fix type
- Check "Analyze" → "MAVLink Inspector" → GPS_RAW_INT

## Parameters NOT Needed

Because RTCM goes directly to the LC29H (not via MAVLink injection),
these parameters are **not required**:

| Parameter | Why Not Needed |
|-----------|---------------|
| `GPS_INJECT_TO` | Not using MAVLink RTCM injection |
| `GPS_RTCM_DATA` | RTCM goes directly to receiver UART |
| `GPS_AUTO_CONFIG` | LC29H is pre-configured externally |

## Pre-Flight Parameter Checklist

For each helicopter, verify:

- [ ] `SYSID_THISMAV` = unique value (11–20)
- [ ] `SERIALx_PROTOCOL` = 2 (MAVLink 2) on TELEM port
- [ ] `SERIALx_BAUD` = 921 on TELEM port
- [ ] `SERIALy_PROTOCOL` = 5 (GPS) on GPS port
- [ ] `SERIALy_BAUD` = 115 on GPS port
- [ ] `GPS_TYPE` = appropriate for LC29H (test: 2, 5, or 26)
- [ ] GCS shows correct SYSID in vehicle selector
- [ ] GPS shows satellites and fix type progresses to RTK Float/Fix
- [ ] Arming and disarming works from GCS (commands reach FC)
