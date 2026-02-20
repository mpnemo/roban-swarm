# Architecture

## System Overview

The Roban Swarm field network consists of three layers:

1. **Infrastructure layer** — WiFi AP + base station providing network,
   GNSS corrections, and MAVLink routing
2. **Companion layer** — one Orange Pi Zero per helicopter, bridging FC
   serial to network services
3. **Vehicle layer** — ArduPilot flight controllers with LC29H GNSS
   receivers

## Physical Topology

```
                    ┌─────────────────────────┐
                    │   TP-Link TL-AP1901GP    │
                    │   Outdoor WiFi AP        │
                    │   SSID: RTK-FIELD        │
                    │   Bridge mode (no DHCP)  │
                    │   Client isolation: OFF  │
                    │   Fixed channel (5 GHz)  │
                    └───────────┬─────────────┘
                                │ Ethernet (PoE)
                    ┌───────────┴─────────────┐
                    │     BASE STATION         │
                    │     x86 mini-PC          │
                    │     192.168.50.1         │
                    │                          │
                    │  ┌─────────────────────┐ │
                    │  │ eth0 (LAN)          │ │
                    │  │ static 192.168.50.1 │ │
                    │  └─────────────────────┘ │
                    │                          │
                    │  ┌─────────────────────┐ │
                    │  │ USB-UART            │ │
                    │  │ → Base GNSS (LC29H) │ │
                    │  └─────────────────────┘ │
                    └──────────────────────────┘
                                │
            WiFi 192.168.50.0/24 (via AP bridge)
                                │
         ┌──────────┬───────────┼───────────┬──────────┐
         │          │           │           │          │
    ┌────┴────┐┌────┴────┐┌────┴────┐     ...    ┌────┴────┐
    │ OPi     ││ OPi     ││ OPi     │            │ OPi     │
    │ Heli01  ││ Heli02  ││ Heli03  │            │ Heli10  │
    │ .50.101 ││ .50.102 ││ .50.103 │            │ .50.110 │
    └────┬────┘└────┬────┘└────┬────┘            └────┬────┘
         │          │           │                      │
    ┌────┴────┐┌────┴────┐┌────┴────┐            ┌────┴────┐
    │ FC + GPS││ FC + GPS││ FC + GPS│            │ FC + GPS│
    │ SYSID=11││ SYSID=12││ SYSID=13│            │ SYSID=20│
    └─────────┘└─────────┘└─────────┘            └─────────┘
```

## Service Map — Base Station

| Service | Port/Interface | Purpose |
|---------|---------------|---------|
| dnsmasq | 53/udp, 67/udp | DHCP + DNS for all companions |
| RTKBase | 2101/tcp | NTRIP caster — serves RTCM3 corrections |
| mavlink-routerd | 14560–14569/udp (telem in), 14660–14669/udp (cmd out), 14550/udp (GCS) | Bidirectional MAVLink hub |
| chrony | 123/udp | NTP time server |
| sshd | 22/tcp | Administration |

## Service Map — Companion (per heli)

| Service | Interface | Purpose |
|---------|----------|---------|
| NetworkManager | wlan0 → RTK-FIELD | WiFi connectivity |
| str2str (RTKLIB) | NTRIP in → serial out | RTCM3 to LC29H UART |
| mavlink-routerd | serial in ↔ UDP out | FC telemetry + commands |
| watchdog (optional) | monitors heartbeats | Auto-restart on failure |

## Data Flow Detail

### RTCM3 Correction Flow

```
Base LC29H (or u-blox)
    │
    │ USB-UART serial
    ▼
RTKBase
    │ Generates RTCM3 messages
    │ NTRIP caster on :2101
    ▼
str2str (on companion)
    │ NTRIP client connects to base:2101
    │ Receives RTCM3 stream
    ▼
LC29H RTCM UART (rover)
    │ Corrections applied internally
    │ by GNSS receiver firmware
    ▼
LC29H NMEA/UBX output → FC GPS port
    │ Position now RTK Float or Fix
    ▼
ArduPilot EKF
```

Key: RTCM goes **directly to the GNSS receiver**, not through ArduPilot.

### MAVLink Telemetry + Command Flow

```
ArduPilot FC
    │ TELEM UART (921600 baud)
    ▼
mavlink-routerd (companion)
    │ Serial endpoint
    │ ↕ bidirectional
    │ UDP endpoint → base:1456X
    ▼
mavlink-routerd hub (base station)
    │ Receives telemetry on 14560–14569
    │ Aggregates all streams
    │ ↕ bidirectional
    │ GCS endpoint → :14550
    ▼
GCS (Mission Planner / QGroundControl)
    │ Sends commands (arm, mode, mission)
    ▼
mavlink-routerd hub
    │ Sends commands to companion_IP:14660–14669
    ▼
Correct companion (Server :1466X) → FC
```

### Port Assignment

```
Base station (telemetry in):     Companion (command in):
  UDP 14560 ← Heli01 (SYS 11)     UDP 14660 on .50.101
  UDP 14561 ← Heli02 (SYS 12)     UDP 14661 on .50.102
  UDP 14562 ← Heli03 (SYS 13)     UDP 14662 on .50.103
  ...                               ...
  UDP 14569 ← Heli10 (SYS 20)     UDP 14669 on .50.110

  UDP 14550 ↔ GCS (bidirectional)
```

## Security Model

This is a **closed field network** — no internet uplink by default.

- WiFi: WPA2-PSK (passphrase not stored in git)
- No public-facing services
- SSH key-based auth recommended for base station
- NTRIP credentials are local (user/pass in env files, not in git)

## Failure Modes

| Failure | Effect | Recovery |
|---------|--------|----------|
| AP power loss | All companions lose WiFi | Automatic reconnect on AP restore |
| Base station reboot | NTRIP + MAVLink interrupted | Services auto-start; str2str reconnects |
| Companion reboot | Single heli offline | Services auto-start; GCS sees heli return |
| GNSS signal loss (base) | RTCM stops; rovers degrade to standalone | Automatic when sky view restored |
| WiFi interference | Packet loss, latency | Fixed channel + 5 GHz mitigates |
