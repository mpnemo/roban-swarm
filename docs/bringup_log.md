# Bringup Log — Roban Swarm RTK Field Network

This file tracks the actual hardware bring-up progress, decisions made,
issues encountered, and their resolutions. It serves as a persistent
record across Claude sessions.

---

## Session 1 — 2026-02-20 (Repo Creation)

**Goal:** Create the complete Roban Swarm repository from scratch.

### What was done
- Created full repo structure: base-station/, companion/, docs/, test/
- Wrote all install scripts, systemd units, config templates, diagnostic tools
- Wrote all documentation (architecture, wiring, ArduPilot params, ops runbook,
  AP setup checklist, identity mapping, troubleshooting)
- Wrote test checklists (bench, field, soak)
- Initial commit: `17acf0d`

### Session 2 — 2026-02-20 (Architecture Review)

**Goal:** Review and fix field-readiness issues.

### What was done
- Fixed 7 issues found during architecture review:
  1. dnsmasq: added listen-address for 127.0.0.1 and 192.168.50.1
  2. netplan: pointed nameservers at self (192.168.50.1)
  3. nftables: ensured include of drop-in directory
  4. MAVLink: added dedicated command return ports 14660-14669
  5. RTKBase: don't auto-enable (needs serial port + creds first)
  6. Companion: clarified services enabled but not started
  7. README: accuracy wording, LC29H config step, command port docs
- Commit: `b76cfc9`

### Session 3 — 2026-02-21 (Next Steps Plan)

**Goal:** Write deployment plan and fleet validation script.

### What was done
- Created `docs/next_steps_plan.md` — 6-phase plan (Phase 0-6)
- Created `base-station/tools/validate_fleet.sh`
- Commit: `d06598f`

---

## Session 4 — 2026-03-09 (Base Station Hardware Bring-up)

**Goal:** Phase 1 — install and configure the base station mini-PC.

### Hardware identified
- **Base station:** x86 mini-PC running Ubuntu, accessible via WiFi at
  `roban-swarm@192.168.3.119` (home network IP)
- Has both Ethernet (`enp2s0`) and WiFi (`wlp3s0`) interfaces
- WiFi used for SSH access during setup; Ethernet will be the RTK-FIELD LAN

### Steps completed

#### 1. SSH access established
- Connected via `ssh roban-swarm@192.168.3.119`
- Password: configured (see credentials doc)
- Passwordless sudo configured

#### 2. Git + repo cloned
- Installed git: `sudo apt install git -y`
- Attempted `git clone` from GitHub — **failed** (network/DNS issue reaching github.com)
- **Workaround:** SCP'd the entire repo from Mac to base station:
  ```
  scp -r "/Users/mpbin/.../Roban-swarm/"* roban-swarm@192.168.3.119:~/roban-swarm/
  ```
- Verified all files present on base station

#### 3. Base station install script executed
- Ran: `sudo bash -x ./base-station/install.sh`
- Script completed with the following results:

**Networking:**
- Detected LAN NIC: `enp2s0`
- Created `/etc/netplan/01-roban-swarm.yaml` with static IP 192.168.50.1/24
- **Preserved WiFi netplan config** (50-cloud-init.yaml) — critical for
  maintaining SSH access over WiFi during setup
- Disabled cloud-init network rewrites
- Disabled systemd-networkd-wait-online (boot speed improvement)
- Manually added IP: `ip addr add 192.168.50.1/24 dev enp2s0`

**dnsmasq:**
- Installed and configured
- **Issue:** Port 53 conflict with systemd-resolved
- **Resolution:** systemd-resolved was stopped/disabled, dnsmasq restarted
- Status after fix: **active**

**chrony:**
- Installed and configured as NTP server
- Status: **active**

**nftables:**
- Installed and configured
- Firewall rules loaded
- Status: **active**

**mavlink-routerd:**
- Not available via apt — **built from source** on the base station
- Build process: meson setup + ninja build + ninja install
- Build succeeded, binary installed to system path
- mavlink-hub.service unit installed
- Status: **active** (listening on configured ports)

#### 4. Install script improvements (uncommitted)
During the actual hardware run, the install script needed several fixes:
- Added `optional: true` and `activation-mode: manual` to netplan LAN config
  (so boot doesn't hang waiting for Ethernet carrier)
- Added `ip addr add` fallback for when cable not connected
- Added WiFi config preservation (don't back up netplan configs that manage WiFi)
- Added cloud-init network disable
- Added systemd-networkd-wait-online disable/mask

These changes are in the working tree as uncommitted modifications to
`base-station/install.sh`.

### Issues encountered

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | git clone from GitHub failed on base station | SCP'd repo from Mac instead | Resolved (workaround) |
| 2 | systemd-resolved holding port 53 | Stopped/disabled resolved, restarted dnsmasq | Resolved |
| 3 | netplan LAN config hangs boot without Ethernet cable | Added `optional: true`, `activation-mode: manual`, fallback `ip addr add` | Fixed in script |
| 4 | Backing up WiFi netplan config drops SSH | Added WiFi config detection/preservation | Fixed in script |
| 5 | mavlink-routerd not in apt repos | Built from source (meson/ninja) | Resolved |

### Network state at end of session
- Base station reachable at `192.168.3.119` (WiFi, home network)
- Base station has `192.168.50.1/24` on `enp2s0` (RTK-FIELD LAN)
- All base services running: dnsmasq, chrony, mavlink-hub, nftables

### Orange Pi Zero — first contact
- An Orange Pi Zero was connected to the network
- It received DHCP address **192.168.50.192** (from the general DHCP pool,
  not yet a reservation)
- SSH as root was attempted: `ssh root@192.168.50.192`
- **This is where the session ended** — companion setup had not yet begun

---

## Session 5 — 2026-03-10 (Base Station Fix + First Companion Install)

**Goal:** Fix base station boot persistence, set up internet forwarding,
install companion software on Orange Pi Zero 2W #1 (Heli01).

### Hardware discovery

The Orange Pi boards are **Zero 2W** (Allwinner H618, 4-core, 1.4GB RAM),
NOT the original Zero (H2+/H3). Key differences:
- SoC: H618 (aarch64) — much more powerful than H2+/H3
- WiFi: Unisoc driver (`unisoc_wifi`), interface name `wlan0`
- OS: Armbian Trixie (Debian 13-based), NOT Ubuntu Jammy
- Network manager: systemd-networkd + netplan (NOT NetworkManager)
- All 10 boards are Zero 2W

### Base station fixes

#### Netplan boot persistence
After reboot, `enp2s0` had no IP assigned because `activation-mode: manual`
was set in the previous session. Removed that line, kept `optional: true`.
Now the static IP 192.168.50.1 survives reboots.

#### Dual DHCP server conflict
The TP-Link AP was serving DHCP at 192.168.50.111 (router mode, not bridge).
Identified by matching BSSID MAC `60:a3:e3:44:ad:13` to the DHCP server IP.
User disabled DHCP on the AP — dnsmasq on base station is now the sole
DHCP server.

#### IP forwarding for OPi internet access
Set up NAT on the base station so companions can reach the internet
through the base station's WiFi uplink (for apt installs and builds):
- `net.ipv4.ip_forward=1`
- nftables NAT masquerade on wlp3s0
- Forward chain in `inet roban_swarm` had `policy drop` — added accept
  rules for enp2s0→wlp3s0 traffic
- `rp_filter` was set to 2 (strict) on all interfaces — set to 0
- **Note:** `ip_forward` and NAT rules do NOT persist across reboots.
  Need to add to install script or sysctl.conf for permanence.

#### Upstream DNS
Added `server=8.8.8.8` and `server=8.8.4.4` to dnsmasq config so
companions can resolve external hostnames through the base station.

### Companion install (Heli01)

#### WiFi & DHCP
- OPi connected to SSID "Robanswarm" (not "RTK-FIELD" as originally planned)
- WiFi configured via netplan/networkd (not NetworkManager)
- WiFi MAC: `c0:64:94:ab:b4:31`
- DHCP reservation added: `c0:64:94:ab:b4:31` → `192.168.50.101` (heli01)

#### Package installs (via apt)
- str2str (rtklib) — installed from Debian repos ✅
- chrony — installed ✅
- socat, jq, curl, net-tools, usbutils — installed ✅
- NetworkManager — installed (but not used; WiFi stays on networkd)

#### mavlink-routerd — built from source
- `git clone` from GitHub failed (Chinese firewall blocks GitHub)
- **Workaround:** Cloned on Mac, SCP'd source to OPi, built locally
- Needed `libsystemd-dev` installed first
- Build: `meson setup build . -Dsystemdsystemunitdir='' && ninja -C build`
- Binary installed to `/usr/bin/mavlink-routerd` ✅

#### Configuration files created
- `/etc/roban-swarm/heli.env` — identity, ports, serial placeholders
- `/etc/mavlink-router/main.conf` — FC serial + UDP endpoints
- `/opt/roban-swarm/watchdog.sh` — service health monitor

#### Systemd services enabled (not started — serial ports are placeholders)
- `ntrip-client.service` — NTRIP client for RTCM corrections
- `mavlink-router.service` — MAVLink FC bridge
- `watchdog.service` — auto-restart monitor
- `roban-clock-sync.service` — NEW: syncs clock from base NTP on boot
  (OPi Zero 2W has no RTC battery, clock resets on power loss)

### Issues encountered

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | netplan `activation-mode: manual` drops IP on reboot | Removed from config, kept `optional: true` | Fixed |
| 2 | AP serving DHCP at .111 (dual DHCP) | Disabled DHCP on AP | Fixed |
| 3 | nftables forward chain `policy drop` blocks NAT | Added accept rules | Fixed (not persisted) |
| 4 | `rp_filter=2` blocks forwarded packets | Set to 0 | Fixed (not persisted) |
| 5 | `ip_forward=0` after reboot | Re-enabled manually | Fixed (not persisted) |
| 6 | apt fails on OPi (IPv6 + firewall) | Force IPv4, set correct clock | Fixed |
| 7 | git clone GitHub blocked (Chinese firewall) | SCP source from Mac | Workaround |
| 8 | OPi clock wrong (no RTC) — apt signature fails | Set time manually + created boot sync service | Fixed |
| 9 | meson can't find `systemd` pkg-config | Install libsystemd-dev, pass `-Dsystemdsystemunitdir=''` | Fixed |

### Items NOT persisted (will be lost on base station reboot)
- `net.ipv4.ip_forward=1` — add to `/etc/sysctl.d/`
- NAT masquerade rule — add to nftables config
- Forward accept rules in roban_swarm — add to firewall.nft
- `rp_filter=0` — add to `/etc/sysctl.d/`
- Upstream DNS servers in dnsmasq — already in config file ✅

---

## Session 6 — 2026-03-11 (Base Persistence + Native UARTs)

**Goal:** Persist base station NAT/forwarding config, switch companion from
USB-UART to native SoC UARTs on the 40-pin header.

### Base station — NAT/sysctl persistence

All settings that were manually applied in Session 5 are now persisted:

- **`/etc/sysctl.d/90-roban-swarm.conf`**: `ip_forward=1`, `rp_filter=0`
- **`/etc/nftables.d/roban-swarm.nft`**: Updated with forward accept rules
  (enp2s0 → wlp3s0) and NAT masquerade table (`ip roban_nat`).
  Added `flush ruleset` at top to prevent duplicate rules on reload.
- **dnsmasq**: Heli01 reservation and upstream DNS already persisted from
  Session 5.
- Cleaned up stale manual nft tables (`inet filter`, `ip nat`) that were
  leftover from ad-hoc setup.
- Repo configs updated: `firewall.nft`, `dnsmasq.conf`, `install.sh`
  (WiFi NIC detection, sysctl.d, sed NIC substitution, removed
  `activation-mode: manual`).

### Companion — native UART discovery

**Key decision:** Use native SoC UARTs on the 40-pin header instead of
USB-UART adapters. More reliable, lower latency, fewer dependencies.

#### OPi Zero 2W 40-pin header UART mapping (from device tree + pinout)

| UART | ttyS | Pins | GPIO | Overlay | Notes |
|------|------|------|------|---------|-------|
| UART0 | ttyS0 | 8/10 | PH0/PH1 | Always on | Was kernel console |
| UART5 | ttyS5 | 11/13 | PH2/PH3 | `uart5` | Newly enabled |
| UART4 | ttyS4 | 7/16 | PI13/PI14 | Needs custom | Available spare |
| UART2 | ttyS2 | 15/22 | PI5/PI6 | `uart2-ph` | Available spare |
| UART3 | ttyS3 | 27/28 | PI10/PI9 | Needs custom | Available spare |

**Selected allocation:**
- **UART0 (ttyS0)** → Flight controller MAVLink (pins 8/10)
- **UART5 (ttyS5)** → LC29H GNSS RTCM corrections (pins 11/13)

Both are adjacent on the header with GND on pin 9 between them.

#### Steps completed on Heli01

1. Enabled UART5 overlay: `overlays=uart5` in `/boot/armbianEnv.txt`
2. Set `console=display` to free UART0 from kernel console
3. Fixed Armbian `boot.cmd` bug: `console=display` was incorrectly handled
   same as `console=both` (still added `console=ttyS0`). Patched and
   recompiled `boot.scr`.
4. Stopped/disabled/masked `serial-getty@ttyS0.service`
5. Updated `/etc/roban-swarm/heli.env`:
   - `FC_SERIAL=/dev/ttyS0`, `FC_BAUD=115200`
   - `GNSS_RTCM_SERIAL=/dev/ttyS5`, `GNSS_RTCM_BAUD=115200`
6. Updated `/etc/mavlink-router/main.conf` with real serial path
7. Verified after reboot: both UART0 and UART5 show correct pinmux,
   ttyS5 registered at MMIO 0x5001400

#### Repo updates for native UARTs

- `companion/install.sh`: Replaced USB-UART detection with native UART
  setup (UART5 overlay, console=display, serial-getty disable, boot.cmd fix)
- Default baud set to 115200 (was 921600 — 115200 safer for 3.3V logic)

### Issues encountered

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | Armbian `boot.cmd` treats `display` same as `both` | Patched with python, recompiled boot.scr | Fixed |
| 2 | serial-getty@ttyS0 holds UART0 open | Stopped, disabled, masked | Fixed |
| 3 | DietPi forum reported UART5 pin conflict | Not reproduced on our Armbian — works fine | N/A |
| 4 | ChatGPT suggested UART4 on pins ChatGPT made up | Verified actual pinout from board diagram | Corrected |
| 5 | BananaPi UART4 overlay has wrong compatible string | Not needed — using UART5 instead | Avoided |

---

## Session 7 — 2026-03-14 (GNSS Baud Fix + NTRIP Caster + GPS Bridge)

**Goal:** Get LC29HEA communicating cleanly with OPi, set up NTRIP caster
on base station, build NMEA→MAVLink GPS bridge.

### LC29HEA baud rate reconfiguration

The LC29HEA-10HZ defaults to **460800 baud**. The Allwinner H618's UART clock
(24 MHz) cannot generate 460800 accurately — integer divisor of 3 gives
500000 actual (8.5% error). Only 115200 works (0.2% error).

**Solution:** Used FTDI FT232RL USB-UART adapter on Mac to connect to
LC29HEA at 460800 and reconfigure it:

1. Connected FTDI to Mac → `/dev/cu.usbserial-A9GNVLDH`
2. Python pyserial confirmed clean NMEA at 460800 from Mac
3. Sent `$PAIR864,0,0,115200*1B` → response `$PAIR001,864,0` (success)
   - Note: `$PQTMCFGUART` gave ERROR,3 — use PAIR commands for LC29HEA
4. Sent `$PQTMSAVEPAR*5A` to save to flash
5. Verified module now outputs clean NMEA at 115200
6. Reconnected LC29HEA to OPi UART5 — clean NMEA confirmed

### Base station GNSS receiver

Connected second LC29H to base station via USB (CH340 adapter):
- Device: `/dev/ttyUSB0`, CH341 driver auto-loaded
- Module outputs **RTCM3 binary** at 115200 baud (0xD3 framed)
- Already configured for base station use (raw observation output)

### NTRIP caster on base station

Compiled RTKLIB str2str from source (v2.4.3-b34) on the base station:
- Downloaded tarball on Mac, SCP'd to base, `make -j4`
- Installed to `/usr/local/bin/str2str`

Created `ntrip-caster.service`:
```
str2str -in serial://ttyUSB0:115200:8:n:1:off \
        -out ntripc://admin:roban@:2101/BASE
```
- Streams RTCM3 from base LC29H to NTRIP caster on port 2101
- Mount point: `BASE`, credentials: `admin`/`roban`
- Verified: OPi successfully pulled 825 bytes of RTCM3 via NTRIP
- Caster logs show ~1316 bps steady throughput

### GPS bridge (NMEA → MAVLink GPS_INPUT)

Built `/opt/roban-swarm/gps-bridge.py`:
- Reads NMEA from `/dev/ttyS5` (LC29HEA)
- Parses `$GNGGA` (position, fix, sats, HDOP) and `$GNRMC` (speed, course)
- Sends MAVLink `GPS_INPUT` (msg 232) via UDP to mavlink-router
- Maps GGA fix quality → MAVLink fix type (4→RTK Fixed, 5→RTK Float)
- Runs at 10 Hz (matching LC29HEA output rate)
- Added local UDP endpoint to mavlink-router: `127.0.0.1:14570`

Dependencies installed on OPi (no pip — extracted wheels directly):
- pymavlink 2.4.43 (pure Python, installed with `--no-deps`)
- pyserial 3.5

### Companion heli.env updated

Set NTRIP credentials: `NTRIP_USER=admin`, `NTRIP_PASS=roban`

### Architecture confirmed

```
Base LC29H → USB → str2str caster :2101 → WiFi → OPi str2str client → UART5 TX → LC29HEA
LC29HEA → UART5 RX → gps-bridge → UDP → mavlink-router → UART0 → FC
Laptop/phone → WiFi → QGC → UDP 14550 → mavlink-hub → all helis
```

ArduPilot FC needs: `GPS_TYPE=14` (MAVLink GPS). RTK processing happens
entirely inside the LC29HEA — ArduPilot just receives the corrected position.

### Services status on Heli01

| Service | Status | Notes |
|---------|--------|-------|
| `mavlink-router` | active | FC UART0 + UDP to base + local gps-bridge |
| `gps-bridge` | active @ 10Hz | NMEA→GPS_INPUT, fix=0 (indoors) |
| `ntrip-client` | stopped | Ready — credentials set, needs `systemctl start` |

### Issues encountered

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | LC29HEA defaults to 460800, H618 can't do it | Reconfigured to 115200 via FTDI + PAIR864 | Fixed |
| 2 | `$PQTMCFGUART` returns ERROR,3 on LC29HEA | Use `$PAIR864,0,0,115200` instead (Airoha PAIR protocol) | Fixed |
| 3 | FTDI keeps disconnecting on Mac | Loose USB cable — replug and retry | Workaround |
| 4 | Shell `printf '$PAIR...'` eats `$` as variable | Use Python for serial commands, not shell | Fixed |
| 5 | No pip on OPi (Python 3.13, minimal install) | Extract .whl directly into dist-packages | Fixed |
| 6 | Base LC29H shows 0 bytes intermittently | Flaky USB cable, retry works | Intermittent |

---

## Current Status (as of 2026-03-14)

### Phase completion

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Pre-hardware | Done | OS images ready, WiFi band confirmed (2.4 GHz Unisoc on Zero 2W) |
| Phase 1: Base station | Done | All services running, NAT/sysctl persisted, NTRIP caster active |
| Phase 2: First companion | ~95% done | All software running, needs FC wiring + outdoor RTK test |
| Phase 3: Scale to 10 | Not started | Need provisioning system (AP mode + web portal) |
| Phase 4: Field RTK | Not started | |
| Phase 5: Soak test | Not started | |
| Phase 6: Hardening | Not started | |

### Immediate next steps
1. Wire FC to header pins 8 (TX) / 10 (RX) / 9 (GND) — UART0
2. Set ArduPilot `GPS_TYPE=14` (MAVLink GPS), `SYSID_THISMAV=11`
3. Start ntrip-client: `systemctl start ntrip-client`
4. Outdoor test: verify RTK fix (sky view needed)
5. Design companion provisioning system for fleet deployment

### Connection details
- **Base station SSH:** `ssh roban-swarm@192.168.3.119` (home WiFi)
- **Base station RTK-FIELD IP:** `192.168.50.1`
- **Orange Pi Zero 2W (Heli01):** `192.168.50.101` (reserved, MAC `c0:64:94:ab:b4:31`)
  - SSH: `sshpass -p 'dopedope' ssh -J roban-swarm@192.168.3.119 root@192.168.50.101`
- **WiFi SSID:** `Robanswarm` (was planned as `RTK-FIELD`)
- **AP:** TP-Link at `192.168.50.111` (DHCP disabled, bridge mode)
- **GitHub repo:** `https://github.com/mpnemo/roban-swarm.git`

### UART wiring reference (OPi Zero 2W 40-pin header)

```
Pin 8  (PH0) = UART0_TX → FC TELEM_RX
Pin 10 (PH1) = UART0_RX ← FC TELEM_TX
Pin 9         = GND      ↔ FC GND

Pin 11 (PH2) = UART5_TX → LC29H RX
Pin 13 (PH3) = UART5_RX ← LC29H TX
Pin 14        = GND      ↔ LC29H GND
Pin 1         = 3.3V     → LC29H VCC (if not separately powered)
```

### Hardware identity table (partial)

| Heli | MAC | Reserved IP | Telemetry | Command | SYSID | Status |
|------|-----|-------------|-----------|---------|-------|--------|
| 01 | `c0:64:94:ab:b4:31` | 192.168.50.101 | 14560 | 14660 | 11 | UARTs configured, needs wiring |
| 02-10 | TBD | .102-.110 | 14561-14569 | 14661-14669 | 12-20 | Not started |
