# Wiring Guide

## Overview

Each helicopter has three serial connections managed by the companion
(Orange Pi Zero):

1. **FC TELEM** — MAVLink telemetry/commands between FC and companion
2. **GNSS RTCM** — RTCM3 corrections from companion to LC29H receiver
3. **GNSS → FC** — NMEA/UBX position from LC29H to FC GPS port

Connection 3 is direct (LC29H to FC) and does not pass through the companion.

## Wiring Diagram

```
Orange Pi Zero
┌──────────────────────────┐
│                          │
│  UART1 (TX/RX)  ────────┼──── FC TELEM port (TX/RX) [MAVLink]
│  or USB-UART adapter     │
│                          │
│  UART2 (TX only) ───────┼──── LC29H RTCM input (RX)  [RTCM3]
│  or USB-UART adapter     │
│                          │
│  WiFi (wlan0) ──────────┼──── RTK-FIELD AP (wireless)
│  IPEX4 → ext antenna     │
│                          │
└──────────────────────────┘

LC29H Module
┌──────────────────────────┐
│                          │
│  RTCM UART (RX) ────────┼──── From companion UART2 (corrections)
│                          │
│  NMEA/UBX UART (TX/RX) ─┼──── FC GPS port (direct, not via companion)
│                          │
│  Antenna ────────────────┼──── Dual-band L1/L5 active antenna
│                          │
│  VCC ────────────────────┼──── 3.3V (check module spec!)
│  GND ────────────────────┼──── Ground
│                          │
└──────────────────────────┘

Flight Controller
┌──────────────────────────┐
│                          │
│  TELEM port (TX/RX) ────┼──── Companion UART1 [MAVLink]
│                          │
│  GPS port (TX/RX) ──────┼──── LC29H NMEA/UBX [direct]
│                          │
└──────────────────────────┘
```

## Pin Mapping Table

Fill in actual pin numbers and connector types for your specific hardware.

### Orange Pi Zero UART Pins

| Signal | GPIO | Physical Pin | Notes |
|--------|------|-------------|-------|
| UART1 TX | `___` | `___` | To FC TELEM RX |
| UART1 RX | `___` | `___` | From FC TELEM TX |
| UART2 TX | `___` | `___` | To LC29H RTCM RX |
| GND | — | `___` | Common ground |

**Alternative:** Use USB-UART adapters (CP2102/CH340) instead of
onboard UARTs. This gives stable `/dev/serial/by-id/` naming and
avoids GPIO conflicts.

### LC29H Module Pins

| Signal | Pin | Notes |
|--------|-----|-------|
| VCC | `___` | 3.3V — check module datasheet |
| GND | `___` | Common ground |
| RTCM RX | `___` | From companion (corrections input) |
| RTCM TX | `___` | Not connected (or for debug) |
| NMEA TX | `___` | To FC GPS RX |
| NMEA RX | `___` | From FC GPS TX (for config commands) |
| ANT | `___` | Active antenna (check bias-T) |

### Flight Controller Ports

| Port | TX Pin | RX Pin | Baud | Protocol |
|------|--------|--------|------|----------|
| TELEM (to companion) | `___` | `___` | 921600 | MAVLink 2 |
| GPS (from LC29H) | `___` | `___` | 115200 | NMEA or UBX (confirm) |

## Baud Rates

| Link | Default Baud | Notes |
|------|-------------|-------|
| FC TELEM ↔ Companion | 921600 | Standard ArduPilot MAVLink baud |
| LC29H RTCM input | 115200 | Verify in LC29H datasheet |
| LC29H NMEA output → FC | 115200 | Match FC GPS port config |
| Base GNSS USB-UART | 115200 | Or 230400 if base receiver supports |

## Voltage Levels

**Critical:** Verify voltage levels before connecting.

| Device | Logic Level | Notes |
|--------|------------|-------|
| Orange Pi Zero GPIO | 3.3V | Do NOT connect 5V signals |
| LC29H | 3.3V | Standard for Quectel modules |
| Flight Controller | 3.3V or 5V | Check FC datasheet — may need level shifter |
| USB-UART adapter | 3.3V or 5V | Ensure set to 3.3V if using with OPi/LC29H |

If FC TELEM is 5V and OPi is 3.3V, use a level shifter or the
USB-UART adapter approach (which handles levels internally).

## Verification Steps

After wiring, verify each link:

1. **FC TELEM ↔ Companion:**
   ```bash
   # On companion:
   mavlink-routerd -e 127.0.0.1:14550 /dev/serial/by-id/FC_TELEM:921600
   # Open GCS on companion localhost — should see heartbeats
   ```

2. **RTCM → LC29H:**
   ```bash
   # On companion, test with str2str:
   str2str -in ntrip://user:pass@192.168.50.1:2101/BASE \
           -out serial:///dev/serial/by-id/GNSS_RTCM:115200
   # Check str2str output for byte count increasing
   ```

3. **LC29H → FC GPS:**
   - In GCS, check GPS_RAW_INT message
   - Satellites visible > 0 confirms NMEA link
   - RTK status changes to Float/Fix confirms RTCM link

## Ground Plane and Antenna Notes

- LC29H antennas need **clear sky view** — mount on top of heli frame
- Ground plane under antenna improves reception (metal plate ≥ 70 mm)
- IPEX4 WiFi antenna on companion should be oriented vertically
- Keep GNSS antenna cable short; avoid routing near ESCs or power wires
