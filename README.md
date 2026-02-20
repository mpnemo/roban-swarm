# Roban Swarm RTK Field Network

**Field-deployable RTK + WiFi MAVLink network for 10 ArduPilot helicopters.**

One base station provides centimetre-accurate GNSS corrections and a
bidirectional MAVLink hub to ten companion computers, each mounted on a
helicopter. A single GCS operator sees and commands every vehicle from the
base-station network.

```
                        ┌────────────────────┐
                        │   TP-Link AP1901GP  │  outdoor WiFi (bridge)
                        │  SSID: RTK-FIELD    │
                        └────────┬───────────┘
                                 │ Ethernet (PoE)
                        ┌────────┴───────────┐
                        │   Base Station      │  x86 mini-PC
                        │   192.168.50.1      │
                        │                     │
                        │  dnsmasq (DHCP/DNS) │
                        │  RTKBase  (NTRIP)   │
                        │  mavlink-routerd    │
                        │  chrony (NTP)       │
                        └────────┬───────────┘
                                 │  192.168.50.0/24
          ┌──────────┬───────────┼───────────┬──────────┐
          │          │           │           │          │
     ┌────┴────┐┌────┴────┐┌────┴────┐ ... (×10 helis)
     │ Heli 01 ││ Heli 02 ││ Heli 03 │
     │ OPi Zero││ OPi Zero││ OPi Zero│
     │ .50.101 ││ .50.102 ││ .50.103 │
     │ :14560  ││ :14561  ││ :14562  │
     └─────────┘└─────────┘└─────────┘
```

---

## Table of Contents

1. [Hardware Inventory](#hardware-inventory)
2. [Architecture Overview](#architecture-overview)
3. [OS Choices](#os-choices)
4. [Network Plan](#network-plan)
5. [Identity & Addressing](#identity--addressing)
6. [RTCM / RTK Design](#rtcm--rtk-design)
7. [MAVLink Routing Design](#mavlink-routing-design)
8. [Implementation Phases](#implementation-phases)
9. [Review Findings / Critical Tighten-ups](#review-findings--critical-tighten-ups)
10. [How to Run](#how-to-run)
11. [Repo Layout](#repo-layout)
12. [Deliverables](#deliverables)

---

## Hardware Inventory

### Purchased / On Hand

| Item | Model / Spec | Qty | Notes |
|------|-------------|-----|-------|
| Outdoor AP | TP-Link TL-AP1901GP | 1 | Dual-band 2.4/5 GHz, 802.11ac, outdoor enclosure, PoE powered |
| Base compute | x86 mini-PC (Intel N100 class) | 1 | 8 GB RAM, Ubuntu Server, SSD |
| GNSS modules | Quectel LC29H (RTK, dual-band L1/L5) | 11 | 10 rover + 1 base (confirm base unit) |
| GNSS antennas | Dual-band L1/L5 active antennas | 11 | Match connector to LC29H breakout |
| Companions | Orange Pi Zero (H2+/H3) | 10 | ARM SoC, onboard WiFi + IPEX connector |
| WiFi pigtails | IPEX4/MHF4 to RP-SMA | 10 | External antenna for Orange Pi Zero |
| USB-UART | CP2102 / CH340 USB-UART adapters | as needed | Base GNSS serial connection |
| Flight controllers | ArduPilot-compatible FC | 10 | One per heli; TELEM + GPS UART exposed |
| PoE injector/switch | Gigabit PoE | 1 | Powers AP; base station Ethernet uplink |

### Verify on Device / UI

- [ ] AP DHCP behaviour in bridge/AP mode (we default to dnsmasq on base)
- [ ] AP client isolation setting — **must be OFF**
- [ ] AP fixed channel selection (5 GHz preferred for less interference)
- [ ] LC29H UART pinout and voltage levels (3.3 V vs 5 V)
- [ ] LC29H RTCM input baud rate (default assumed 115200)
- [ ] FC TELEM port baud rate (default assumed 921600)
- [ ] Orange Pi Zero UART availability and /dev names

---

## Architecture Overview

See [docs/architecture.md](docs/architecture.md) for the full diagram and
service-level description.

### Data Flows

**RTCM correction flow** (base → rovers):
```
Base GNSS receiver
    │ USB-UART serial
    ▼
RTKBase (survey-in / fixed coords)
    │ NTRIP caster :2101
    ▼
str2str (on each companion)
    │ NTRIP client
    ▼
LC29H RTCM UART (serial)
    │ corrections applied internally
    ▼
LC29H NMEA/UBX → FC GPS port
```

RTCM goes **directly** into the LC29H receiver via serial. ArduPilot does
**not** need MAVLink GPS_RTCM_DATA injection — the receiver handles
corrections internally and outputs a corrected position to the FC.

**MAVLink telemetry flow** (bidirectional):
```
FC TELEM UART
    │ serial (921600 baud)
    ▼
mavlink-routerd (companion)
    │ UDP to base:1456X
    ▼
mavlink-routerd hub (base station)
    │ aggregates all 10 helis
    ▼
GCS endpoint UDP :14550
    │ bidirectional: commands flow back
    ▼
mavlink-routerd hub → per-heli UDP → companion → FC
```

The base-station MAVLink hub is a **bidirectional router**, not a telemetry
sink. Commands from GCS are routed back to the correct heli by MAVLink
SYSID.

---

## OS Choices

| Role | OS | Reason |
|------|----|--------|
| Base station | Ubuntu Server 22.04 LTS (or 24.04 LTS) | Stable, x86, full apt ecosystem, systemd, netplan |
| Companion | Armbian Ubuntu Jammy (22.04 base) | Official Orange Pi Zero support, NetworkManager, systemd |

Both share: systemd service management, apt packaging, journald logging,
standard network tooling (ip, ss, nmcli/netplan).

---

## Network Plan

```
Subnet:          192.168.50.0/24
Base station:    192.168.50.1 (static, LAN NIC)
DHCP range:      192.168.50.100 – 192.168.50.199 (dnsmasq)
Reservations:    192.168.50.101 – 192.168.50.110 (Heli01–Heli10)
NTRIP caster:    192.168.50.1:2101/tcp
MAVLink inbound: 192.168.50.1:14560–14569/udp (one port per heli)
MAVLink GCS:     192.168.50.1:14550/udp (bidirectional)
NTP:             192.168.50.1:123/udp (chrony)
DNS:             192.168.50.1:53 (dnsmasq)
```

**DHCP is served by the base station (dnsmasq).** The TP-Link AP operates in
bridge/AP mode only — do not rely on AP-provided DHCP unless explicitly
verified and tested. This is a deliberate default to avoid split-brain DHCP.

**AP requirements:**
- Client isolation: **OFF** (companions must reach base IP directly)
- Fixed channel: 5 GHz band preferred (less interference outdoors)
- SSID: `RTK-FIELD` (WPA2-PSK)

---

## Identity & Addressing

Every helicopter gets a deterministic identity chain:

```
MAC address → DHCP reservation → IP address → UDP port → SYSID
```

| Heli ID | Companion MAC | Reserved IP | UDP Port | SYSID_THISMAV |
|---------|--------------|-------------|----------|---------------|
| Heli01 | `XX:XX:XX:XX:XX:01` | 192.168.50.101 | 14560 | 11 |
| Heli02 | `XX:XX:XX:XX:XX:02` | 192.168.50.102 | 14561 | 12 |
| Heli03 | `XX:XX:XX:XX:XX:03` | 192.168.50.103 | 14562 | 13 |
| Heli04 | `XX:XX:XX:XX:XX:04` | 192.168.50.104 | 14563 | 14 |
| Heli05 | `XX:XX:XX:XX:XX:05` | 192.168.50.105 | 14564 | 15 |
| Heli06 | `XX:XX:XX:XX:XX:06` | 192.168.50.106 | 14565 | 16 |
| Heli07 | `XX:XX:XX:XX:XX:07` | 192.168.50.107 | 14566 | 17 |
| Heli08 | `XX:XX:XX:XX:XX:08` | 192.168.50.108 | 14567 | 18 |
| Heli09 | `XX:XX:XX:XX:XX:09` | 192.168.50.109 | 14568 | 19 |
| Heli10 | `XX:XX:XX:XX:XX:10` | 192.168.50.110 | 14569 | 20 |

**Rules:**
- MAC addresses must be recorded per companion and entered into dnsmasq
  reservations **before** field deployment.
- SYSID_THISMAV must be unique per helicopter (11–20). Duplicate SYSIDs
  cause GCS to merge telemetry streams, breaking multi-vehicle ops.
- The base-station hub routes by SYSID — if two helis share a SYSID,
  commands will be mis-routed.

See [docs/identity_mapping.md](docs/identity_mapping.md) for the full
procedure and template.

---

## RTCM / RTK Design

### Base Station GNSS

- **Software:** RTKBase (native install or Docker)
- **Survey-in:** Run on first deployment or when base is moved to a new
  location. Takes 5–15 minutes depending on configured accuracy.
- **Fixed coordinates:** Once survey-in completes, persist the base
  coordinates to disk (`/etc/roban-swarm/base_coords.conf`). On subsequent
  boots at the same location, reuse stored coordinates — skip survey-in.
- **Rule:** Survey-in only when moved. Persist when stationary.

### Rover GNSS (per heli)

- LC29H receives RTCM3 corrections via its dedicated UART (not through
  ArduPilot MAVLink).
- `str2str` (RTKLIB) runs on the companion as an NTRIP client:
  ```
  str2str -in ntrip://user:pass@192.168.50.1:2101/BASE \
          -out serial:///dev/serial/by-id/GNSS_RTCM:115200
  ```
- The LC29H applies corrections internally and outputs corrected
  NMEA/UBX to the FC GPS port.
- ArduPilot sees RTK Float/Fix status in GPS_RAW_INT.

### Why Direct RTCM Injection?

ArduPilot supports MAVLink GPS_RTCM_DATA injection, but it adds
complexity (fragmentation, message routing, GPS_INJECT_TO parameter).
Direct serial RTCM to the LC29H is simpler, lower latency, and
requires no ArduPilot configuration for corrections.

---

## MAVLink Routing Design

### Companion (per heli)

`mavlink-routerd` connects:
- **Serial endpoint:** FC TELEM UART (e.g., `/dev/serial/by-id/FC_TELEM`)
  at 921600 baud
- **UDP endpoint:** `192.168.50.1:1456X` (X = heli index, 0–9)

Configuration is generated from `heli.env` during install.

### Base Station Hub

`mavlink-routerd` listens on:
- **UDP ports 14560–14569** (one per heli, inbound)
- **UDP port 14550** (GCS endpoint, bidirectional)

The hub:
1. Receives telemetry from all 10 helis.
2. Forwards all telemetry to GCS on :14550.
3. Receives commands from GCS on :14550.
4. Routes commands back to the correct heli based on target SYSID
   (MAVLink addressing).

This is a **full bidirectional router**, not a unidirectional aggregator.

### Optional Extensions

- Per-vehicle GCS endpoints (e.g., 14570–14579) for dedicated single-heli
  GCS connections.
- Logging endpoints (write .tlog per vehicle on base station).

---

## Implementation Phases

### Phase 1: Bench Bring-up
- [ ] Flash base station OS, run `base-station/install.sh`
- [ ] Verify dnsmasq DHCP, static IP, firewall rules
- [ ] Flash one companion OS, run `companion/install.sh --heli-id 01`
- [ ] Verify WiFi association, DHCP reservation, IP assignment

### Phase 2: Base Station Services
- [ ] Connect base GNSS receiver, start RTKBase
- [ ] Run survey-in, verify RTCM generation
- [ ] Start NTRIP caster, verify port 2101 accessible
- [ ] Start mavlink-routerd hub, verify port 14550 listening

### Phase 3: Single Companion Integration
- [ ] Verify str2str receives RTCM bytes from base
- [ ] Verify RTCM delivered to LC29H serial
- [ ] Connect FC TELEM, verify MAVLink heartbeat at base
- [ ] Open GCS (Mission Planner / QGC), confirm vehicle telemetry
- [ ] Send command from GCS, verify FC receives it

### Phase 4: ArduPilot Parameter Setup
- [ ] Set SYSID_THISMAV = 11 on first heli
- [ ] Configure GPS port for LC29H (baud, protocol)
- [ ] Verify RTK Float → Fix in GCS
- [ ] Document parameter set in `docs/ardupilot_params.md`

### Phase 5: Scale to 10 Helis
- [ ] Flash and install remaining 9 companions
- [ ] Record all MAC addresses, update dnsmasq reservations
- [ ] Assign SYSID 12–20
- [ ] Verify all 10 appear in GCS simultaneously
- [ ] Verify commands route to correct vehicles

### Phase 6: Robustness & Soak Testing
- [ ] 2–4 hour soak test (see `test/soak_test.md`)
- [ ] AP power cycle recovery test
- [ ] Companion reboot recovery test
- [ ] WiFi range/signal quality assessment
- [ ] Document any service restart behaviour

### Acceptance Criteria (Bench, Before Flight)

**Mandatory bench smoketest — props off:**
1. Companion joins WiFi and receives DHCP reservation IP
2. `str2str` shows RTCM bytes increasing (check with `status_dump.sh`)
3. Base station sees MAVLink heartbeat on expected UDP port
4. GCS shows vehicle with correct SYSID
5. GCS can arm/disarm (or send other command) and FC responds
6. Repeat for all 10 helis simultaneously

---

## Review Findings / Critical Tighten-ups

These points were identified during architecture review and are
**mandatory design constraints**:

1. **DHCP default to base station (dnsmasq).** The AP operates in
   bridge mode only. Do not configure or rely on AP DHCP unless you have
   explicitly verified it works in the AP's operating mode and tested
   with all 10 clients.

2. **Deterministic identity mapping.** The chain
   `MAC → DHCP reservation → IP → UDP port → SYSID` must be established
   before field deployment. Without it, multi-vehicle operations break
   (wrong commands to wrong helis, merged telemetry in GCS).

3. **Base station MAVLink hub is bidirectional.** It must route GCS
   commands back to the correct heli, not just aggregate telemetry.
   `mavlink-routerd` supports this natively.

4. **RTCM injected to LC29H directly.** Corrections go via serial UART
   to the GNSS receiver. ArduPilot does not need MAVLink RTCM injection
   (GPS_RTCM_DATA). This simplifies configuration and reduces latency.

5. **Persist fixed base coordinates.** Survey-in only when the base is
   physically moved. On reboot at the same location, load stored
   coordinates from disk. Re-surveying every boot wastes time and
   introduces position jitter.

6. **Stable serial device naming.** Use `/dev/serial/by-id/` symlinks,
   not hardcoded `/dev/ttyS*` or `/dev/ttyUSB*`. Hardcoded names change
   with USB enumeration order.

7. **AP client isolation must be OFF.** Verify in the AP's web UI.
   With client isolation enabled, companions cannot reach the base
   station IP (all traffic is blocked between wireless clients and the
   wired network may be affected depending on AP implementation).
   Use a fixed channel (5 GHz preferred) for stable outdoor operation.

---

## How to Run

### Base Station

```bash
# On base station (x86 Ubuntu Server):
git clone https://github.com/mpnemo/roban-swarm.git
cd roban-swarm
sudo ./base-station/install.sh

# After install, verify:
./base-station/tools/status_dump.sh
```

### Companion (per heli)

```bash
# On companion (Orange Pi Zero, Armbian):
git clone https://github.com/mpnemo/roban-swarm.git
cd roban-swarm
sudo ./companion/install.sh --heli-id 01

# After install, verify:
./companion/tools/status_dump.sh
```

### Credentials Setup

WiFi and NTRIP credentials are **not** stored in git. After install:

```bash
# On companion — edit the environment file:
sudo nano /etc/roban-swarm/heli.env
# Set: WIFI_PASSPHRASE, NTRIP_USER, NTRIP_PASS

# On base station — edit RTKBase config:
sudo nano /etc/roban-swarm/rtkbase.env
# Set: NTRIP credentials, base GNSS serial port
```

### Diagnostics

```bash
# Base station:
./base-station/tools/status_dump.sh     # full system status
./base-station/tools/list_clients.sh    # DHCP leases + heli IDs
./base-station/tools/show_mavlink_lastseen.sh  # MAVLink per heli
./base-station/tools/show_rtk_clients.sh       # NTRIP client count

# Companion:
./companion/tools/status_dump.sh        # WiFi, services, bytes
./companion/tools/detect_ports.sh       # serial port detection
./companion/tools/bench_smoketest.sh    # pre-flight checks
./companion/tools/set_heli_id.sh XX     # reconfigure heli ID
```

---

## Repo Layout

```
roban-swarm/
├── README.md                          # This file
├── docs/
│   ├── architecture.md                # Full architecture + diagrams
│   ├── wiring.md                      # UART wiring + pinouts
│   ├── ardupilot_params.md            # ArduPilot parameter guide
│   ├── ops_runbook.md                 # Field operations runbook
│   ├── ap_setup_checklist.md          # AP configuration checklist
│   ├── identity_mapping.md            # MAC/IP/SYSID mapping procedure
│   └── troubleshooting.md            # Common issues + fixes
├── base-station/
│   ├── install.sh                     # Base station provisioning
│   ├── config/
│   │   ├── netplan.yaml               # Static IP configuration
│   │   ├── dnsmasq.conf               # DHCP + DNS
│   │   ├── rtkbase.env                # RTKBase environment
│   │   ├── mavlink-routerd.conf       # MAVLink hub config
│   │   └── firewall.nft               # nftables rules
│   ├── systemd/
│   │   ├── dnsmasq.service.d/override.conf
│   │   ├── mavlink-hub.service
│   │   ├── rtkbase.service
│   │   └── chrony.service.d/override.conf
│   └── tools/
│       ├── status_dump.sh
│       ├── list_clients.sh
│       ├── show_mavlink_lastseen.sh
│       └── show_rtk_clients.sh
├── companion/
│   ├── install.sh                     # Companion provisioning
│   ├── config/
│   │   ├── wifi.nmconnection          # NetworkManager WiFi profile
│   │   ├── str2str_template.conf      # NTRIP client template
│   │   ├── mavlink-routerd.conf       # MAVLink router config
│   │   └── heli.env.example           # Environment template
│   ├── systemd/
│   │   ├── ntrip-client.service
│   │   ├── mavlink-router.service
│   │   └── watchdog.service
│   └── tools/
│       ├── detect_ports.sh
│       ├── status_dump.sh
│       ├── bench_smoketest.sh
│       └── set_heli_id.sh
└── test/
    ├── bench_checklist.md
    ├── field_checklist.md
    └── soak_test.md
```

---

## Deliverables

- [x] GitHub repo with full folder structure
- [x] Comprehensive README (this file)
- [x] Working install scripts (base + companion)
- [x] Systemd service units for all services
- [x] Configuration templates with documented placeholders
- [x] Diagnostic/status tools
- [x] Documentation: architecture, wiring, ArduPilot params, ops runbook,
      AP setup, identity mapping, troubleshooting
- [x] Test checklists: bench, field, soak

---

## License

This project is provided as-is for the Roban Swarm team. No warranty
expressed or implied.
