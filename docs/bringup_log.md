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

## Session 8 — 2026-03-16 (Companion Provisioning System)

**Goal:** Build AP-mode captive portal so each OPi can be provisioned on
first boot without needing to edit ext4 SD cards from a PC.

### What was built

#### Provisioning flow
1. OPi boots → `roban-provision.service` checks `/etc/roban-swarm/provisioned`
2. **Not provisioned →** setup mode:
   - Stops operational services (mavlink-router, ntrip-client, gps-bridge)
   - Switches `wlan0` to AP mode via hostapd (`RobanHeli-SETUP` / `robansetup`)
   - Starts dnsmasq for DHCP (192.168.4.10-50) + DNS wildcard → captive portal
   - Serves web form on port 80 (pure stdlib http.server)
   - User connects phone/laptop → selects Heli ID, enters WiFi SSID/password
   - On submit: writes `heli.env`, netplan WiFi config, mavlink-router config,
     marks provisioned, reboots into normal mode
3. **Already provisioned →** service exits immediately, normal boot continues

#### Files created
- `companion/tools/roban-provision.py` — Python stdlib web server + captive portal
- `companion/config/hostapd-setup.conf` — AP mode config (WPA2, channel 6)
- `companion/config/dnsmasq-setup.conf` — DHCP pool + DNS wildcard redirect
- `companion/systemd/roban-provision.service` — boot-time provisioning check

#### install.sh rewrite
- `--heli-id` now **optional**: if omitted, installs provisioning service for
  first-boot setup; if given, provisions immediately (no captive portal)
- Added `hostapd` and `dnsmasq` to apt packages (system services disabled,
  managed by provisioning script)
- Added `gps-bridge.py` install + `gps-bridge.service` enable
- Renamed watchdog service to `roban-watchdog` (avoid conflict with system watchdog)
- Updated service dependencies: `networkd` instead of `NetworkManager`
- Preset defaults: NTRIP password `roban`, WiFi SSID `Robanswarm`,
  serial ports `ttyS0`/`ttyS5` @ 115200
- Summary now shows root credentials (`root` / `dopedope`) for HDMI debug

#### Other fixes
- `ntrip-client.service` and `mavlink-router.service`: replaced
  `NetworkManager-wait-online.service` with `systemd-networkd-wait-online.service`

### Testing on Heli01

Deployed to Heli01, factory-reset (`rm /etc/roban-swarm/provisioned`), rebooted.

#### hostapd failure — switched to wpa_supplicant AP mode
The Unisoc WiFi driver on OPi Zero 2W does **not** support hostapd's nl80211
AP interface ("Could not connect to kernel driver", "Failed to set beacon
parameters"). AP mode IS listed in `iw list` capabilities, but hostapd
can't use it.

**Fix:** Replaced hostapd with `wpa_supplicant` in AP mode (`mode=2`):
1. Set interface type to `__ap` via `iw dev wlan0 set type __ap` (required
   before wpa_supplicant can start AP)
2. Write `/tmp/roban-ap.conf` with `mode=2`, `frequency=2437`
3. Run `wpa_supplicant -B -i wlan0 -c /tmp/roban-ap.conf`
4. Start dnsmasq for DHCP + DNS wildcard

SSID `RobanHeli-SETUP` visible and connectable from phone. Captive portal
web form loaded at `http://192.168.4.1`, form submitted successfully.

After provisioning submit, OPi rebooted into normal client mode, connected
to Robanswarm WiFi, and was reachable via SSH at 192.168.50.101.

#### Files updated
- `roban-provision.py`: `start_ap_mode()` uses wpa_supplicant instead of
  hostapd; `stop_ap_mode()` restores managed mode via `iw`; kills stale
  dnsmasq before starting; stops NetworkManager during setup
- `install.sh`: removed `hostapd` from apt packages, removed hostapd config
  copy and service disable

#### hostapd-setup.conf retained in repo
Kept for reference but no longer deployed or used.

### Factory reset
Delete `/etc/roban-swarm/provisioned` and reboot → back to setup mode.

### Phase 3 workflow (scale to 10)
1. Flash production SD image (with install.sh already run, no `provisioned` flag)
2. Boot OPi → it creates AP `RobanHeli-SETUP`
3. Connect phone → fill form (Heli ID, WiFi SSID/pass)
4. OPi saves config + reboots into normal WiFi client mode
5. Repeat for all 10 boards

---

## Session 9 — 2026-03-17 (FC Link + MAVLink Routing Fix)

**Goal:** Wire FC to OPi, connect Mission Planner via WiFi, fix packet loss.

### FC wiring verified
- Wired FC TELEM port to OPi header: pin 8 (TX) → FC RX, pin 10 (RX) ← FC TX, pin 9 GND
- Raw UART0 test: **235 MAVLink v2 frames in 5s, zero junk bytes, 47 msg/s**
- FC sysid=11, compid=1, all standard messages (HEARTBEAT, ATTITUDE, GPS_RAW_INT, etc.)
- `GPS_TYPE` already set to 14 (MAVLink GPS) ✅

### Mission Planner connected
- Connected Windows laptop (192.168.50.159) to `Robanswarm` WiFi
- Mission Planner connected via UDP 14550 to base station hub
- FC appeared as sysid 11, DISARMED, telemetry flowing

### Critical bug found: MAVLink routing loop
**Symptom:** 50-80% packet loss in Mission Planner, MAVFTP parameter download
failing, SSH to base station dying when MP connected.

**Root cause:** Separate in/out UDP ports per heli created an **exponential
routing loop**:
1. OPi receives FC msg (sysid=11) on UART → sends to `to_base` (port 14560)
2. Base hub receives on `heli01_in` (14560) → forwards to ALL endpoints
   including `heli01_cmd` (port 14660)
3. OPi receives sysid=11 back on `from_base` (14660) → `from_base ≠ to_base`
   so mavlink-router forwards it to `to_base` (14560) again
4. Goto 2 — infinite loop

**Measured:** 7,200 UDP packets/sec on port 14560 (expected: ~65 msg/s from FC).
This flooded WiFi, saturated the hub, and killed SSH.

**Fix:** Replaced separate in/out endpoints with a **single bidirectional
endpoint** on both the companion and base station:

Companion config (before):
```
[UdpEndpoint to_base]       # OUT
Mode = Normal
Address = 192.168.50.1
Port = 14560

[UdpEndpoint from_base]     # IN — creates loop!
Mode = Server
Address = 0.0.0.0
Port = 14660
```

Companion config (after):
```
[UdpEndpoint base]          # single bidirectional
Mode = Normal
Address = 192.168.50.1
Port = 14560
```

Base hub config (before):
```
[UdpEndpoint heli01_in]     # receives from heli
Mode = Server
Port = 14560

[UdpEndpoint heli01_cmd]    # sends back to heli — creates loop!
Mode = Normal
Address = 192.168.50.101
Port = 14660
```

Base hub config (after):
```
[UdpEndpoint heli01]        # single bidirectional Server
Mode = Server
Port = 14560
```

**Result after fix:** 38 pkt/s on port 14560 (normal), SSH works while MP
connected, telemetry smooth.

### TCP endpoint added
Enabled `TcpServerPort = 5760` on base station hub for reliable GCS connections.
Added TCP 5760 to nftables firewall (inserted BEFORE drop rule — ordering matters).
Mission Planner can connect via `tcp:192.168.50.1:5760` for reliable MAVFTP.

### Bandwidth analysis (research)
- 10 helis at default 4 Hz stream rates = ~40 KB/s total — WiFi handles MB/s
- WiFi signal excellent: -29 dBm, 0% ping loss, 2-7ms latency
- WiFi is NEVER the bottleneck; 115200 UART is per-vehicle bottleneck
- Architecture (OPi companion → UDP → base hub → GCS) matches commercial swarms

### GPS bridge status
- gps-bridge running, had 3D fix with 5 sats (23.16°N, 113.88°E — Guangzhou)
- Indoors drops to 0 sats (expected)
- NTRIP client ready but stopped (outdoor test needed for RTK)

### Provisioning system tested (Session 8 follow-up)
- Captive portal form worked from phone
- Entering wrong WiFi password required re-provisioning (factory reset + reboot)
- Unisoc WiFi driver does NOT support hostapd — wpa_supplicant AP mode works
- Root password `dopedope` confirmed for HDMI debug access

### Files updated
- `companion/tools/roban-provision.py`: single `base` endpoint (no `from_base`)
- `companion/install.sh`: single `base` endpoint, removed `CMD_PORT`
- `base-station/config/mavlink-routerd.conf`: single Server endpoint per heli,
  `TcpServerPort = 5760`, removed `_cmd` endpoints
- `base-station/config/firewall.nft`: added `tcp dport 5760 accept`
- `base-station/install.sh`: updated summary output

### Issues encountered

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | Separate in/out UDP ports create routing loop | Single bidirectional endpoint per heli | Fixed |
| 2 | 7200 pkt/s flood kills SSH + Mission Planner | Loop fix reduced to normal 38 pkt/s | Fixed |
| 3 | MAVFTP param download fails over lossy UDP | TCP 5760 added for reliable GCS connections | Fixed |
| 4 | nftables rule added after `drop` rule | Must use `insert position` before drop | Fixed |
| 5 | Wrong WiFi password in provisioning form | Factory reset + re-provision | User error |
| 6 | hostapd fails on Unisoc WiFi driver | Use wpa_supplicant mode=2 with `iw set type __ap` | Fixed (Session 8) |

---

## Current Status (as of 2026-03-20)

### Phase completion

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Pre-hardware | Done | OS images ready, WiFi band confirmed (2.4 GHz Unisoc on Zero 2W) |
| Phase 1: Base station | Done | All services running, NAT/sysctl persisted, NTRIP caster active |
| Phase 2: First companion | **DONE** | Full chain verified: GPS_INPUT→FC, RTK fix, 42 sats, hdop=0.5. Outdoor test nice-to-have (needs battery gear) |
| Phase 2β: Foundation | **NOT STARTED** | Web UI, fleet management, swarm controller foundation |
| Phase 3: Scale to 10 | In progress | Provisioning system built and tested on Heli01 |
| Phase 4: Field RTK | Not started | |
| Phase 5: Soak test | Not started | |
| Phase 6: Hardening | Not started | |

### Immediate next steps
1. ~~Test provisioning on Heli01~~ — **Done** (Session 8)
2. ~~Wire FC to header pins~~ — **Done** (Session 9, clean MAVLink v2 at 47 msg/s)
3. ~~Set ArduPilot GPS_TYPE=14~~ — **Done** (already set, confirmed via pymavlink)
4. ~~Fix MAVLink routing loop~~ — **Done** (Session 9, single bidirectional endpoints)
5. ~~Start NTRIP + verify RTK~~ — **Done** (Session 10, RTK fix confirmed indoors)
6. ~~Custom firmware with AP_GPS_MAV~~ — **Done** (Session 10, 4.6.3 + AP_GPS_MAV_ENABLED)
7. Phase 2β: Build base station web UI + fleet management
8. Phase 3: Provision second heli, then scale to 10

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

| Heli | MAC | Reserved IP | Port | SYSID | Status |
|------|-----|-------------|------|-------|--------|
| 01 | `c0:64:94:ab:b4:31` | 192.168.50.101 | 14560 | 11 | FC wired, AP 4.6.3+GPS_MAV, GPS_INPUT→FC, RTK fix=42sats ✅ |
| 02-10 | TBD | .102-.110 | 14561-14569 | 12-20 | Not started |

---

## Session 10 — 2026-03-18 (NTRIP Integration + Serial Fix)

### Serial Port Contention — Root Cause & Fix

**Problem:** gps-bridge.py (reading NMEA) and str2str ntrip-client (writing RTCM)
both opened `/dev/ttyS5`. Even after stopping str2str, gps-bridge continued
reporting "device reports readiness to read but returned no data" at ~1 error/s,
dropping NMEA throughput from 10Hz to 0.5Hz.

**Root cause (two issues):**

1. **H618 UART driver quirk:** pyserial's `readline()` internally uses `read(1)`,
   which triggers a race with the H618 UART driver where `poll()` reports
   readiness but the subsequent `read()` returns 0 bytes. pyserial treats this
   as a `SerialException`.

2. **Serial port contention:** Two processes (str2str + gps-bridge) opening
   the same serial port simultaneously caused kernel-level buffer conflicts.

**Fix:** Merged NTRIP client into gps-bridge.py (single process owns the port):

- Added `NtripClient` thread that connects to the base station NTRIP caster
  via raw TCP socket, receives RTCM3 data, and writes it to the serial port
  using a thread lock
- Replaced pyserial `readline()` with `select()` + `os.read()` + manual line
  buffering — handles H618's empty reads gracefully (just counts them, no error)
- Eliminated str2str dependency on companion entirely
- ntrip-client.service disabled and removed from install.sh

**Result:**
```
gps-bridge: fix=RTK sats=40 lat=23.1610422 lon=113.8821468 alt=47.1m hdop=0.6 rate=9.8Hz rtcm=24.3KB empty=3
```
- 9.8Hz NMEA reading (was 0.5Hz with errors)
- RTK fix with 40 satellites, HDOP 0.6
- RTCM corrections flowing at ~1.8 kbps
- Only 2-4 empty reads per 10s (harmless, handled silently)

### NTRIP Caster Protocol Quirk

str2str's NTRIP caster responds with `ICY 200 OK\r\n` (single CRLF), not
the standard `ICY 200 OK\r\n\r\n` (double CRLF). The initial NtripClient
implementation waited for `\r\n\r\n` and hung forever. Fixed by checking for
both patterns.

### Files Changed

- `companion/tools/gps-bridge.py` — complete rewrite:
  - Added NtripClient thread (RTCM fetch + serial write)
  - Switched serial reading from pyserial readline() to select()+os.read()
  - Added RTCM byte counter to stats output
  - Fix type now printed as name (RTK/Float/3D) instead of number
- `companion/install.sh` — removed ntrip-client references
- `companion/systemd/ntrip-client.service` — no longer used (kept in repo for reference)

### Data Flow (Updated)

```
Base LC29H → USB → str2str ntripc://:2101/BASE → WiFi →
  → gps-bridge.py NtripClient thread → serial write → LC29HEA RTCM input
LC29HEA NMEA output → serial read → gps-bridge.py → UDP :14570 → mavlink-router → UART0 → FC
```

Single process (gps-bridge.py) owns `/dev/ttyS5` for both read (NMEA) and write (RTCM).

---

## Session 10 — 2026-03-20 (Firmware Fix + GPS_INPUT Verified)

**Goal:** Debug why the FC ignores GPS_INPUT messages despite GPS1_TYPE=14.

### Root Cause: AP_GPS_MAV Not Compiled In

The QioTekAdeptF407 has 1MB flash. ArduPilot **disables `AP_GPS_MAV_ENABLED`**
by default on boards with <2MB flash to save space. The parameter GPS1_TYPE=14
can be *set* and *saved*, but the firmware has **no code to create the
AP_GPS_MAV driver**, so GPS_INPUT messages (msg 232) are silently dropped.

Symptoms observed:
- GPS_RAW_INT always fix=0 sats=0 lat=0 despite sending GPS_INPUT
- SYS_STATUS GPS sensor bit: present=False, enabled=False, health=False
- "EKF3 waiting for GPS config data" repeated indefinitely
- "Sending unknown message (44)" (cosmetic bug — CAMERA_FOV_STATUS, harmless)
- No error or NAK for GPS_INPUT — completely silent failure

### Debugging Steps

1. Confirmed GPS1_TYPE=14, GPS_AUTO_CONFIG=0 saved and persisted across reboots
2. Sent 50-99 GPS_INPUT messages directly over serial — zero effect on GPS_RAW_INT
3. Verified MAVLink v2 encoding correct (msg ID 232, 63-byte payload, 0xFD header)
4. Verified SERIAL2_PROTOCOL=2 (MAVLink2), baud=115200 — FC communicates fine for
   heartbeats, params, commands
5. Tried full param reset + fresh GPS1_TYPE=14 — still no GPS driver created
6. Tried setting SERIAL3_PROTOCOL=-1 (disable GPS serial) — no change
7. Attempted MAVFTP to pull `@SYS/features.txt` — file empty on custom build
8. Confirmed via SYS_STATUS that GPS sensor never shows `present=True`

### Resolution: Custom Firmware Build

Built custom ArduPilot 4.6.3 (ArduHeli) for QioTekAdeptF407 with
`AP_GPS_MAV_ENABLED 1` added to the board's hwdef.dat. Key details:

- Source repo: `roban-heli-ap` (user's custom build environment)
- File flashed: `arducopter-heli-4.6.3_with_bl.hex` (dated Mar 19 07:14)
- **CRITICAL:** An older hex file with the same 4.6.3 version number
  (dated Mar 18 17:19, without GPS_MAV) existed in the same directory.
  The AP version number alone cannot distinguish them — always check
  the file timestamp.
- Had to reflash via USB after initially uploading the wrong (stale) hex

### Verification After Correct Flash

```
FC sysid=11  AP 4.6.3
GPS PRESENT!
GPS_RAW: fix=3 sats=12 lat=22.54310
```

GPS_INPUT messages now accepted immediately. FC reports GPS present, 3D fix,
satellite count and position matching the sent data.

### Full Chain Confirmed

After restarting mavlink-router and gps-bridge services:
```
gps-bridge: fix=RTK sats=42 lat=23.1610579 lon=113.8821422 alt=35.3m hdop=0.5 rate=9.7Hz rtcm=12.9KB
```

Complete data flow working end-to-end:
```
Base LC29H → str2str NTRIP caster → WiFi → gps-bridge NTRIP thread → LC29HEA
LC29HEA → NMEA → gps-bridge → GPS_INPUT → mavlink-router → FC
FC: GPS PRESENT, fix=RTK, 42 sats, hdop=0.5
```

### Params Set on FC

- `GPS1_TYPE = 14` (MAVLink GPS) — requires AP_GPS_MAV_ENABLED in firmware
- `GPS_AUTO_CONFIG = 0` — must be 0 for MAVLink GPS (no serial GPS to configure)
- `SYSID_THISMAV = 11`
- `SERIAL2_PROTOCOL = 2` (MAVLink2 on TELEM port to OPi)

### Lessons Learned

1. **AP_GPS_MAV is disabled on 1MB boards by default** — always verify with
   a custom build if using GPS_TYPE=14 on F407/similar boards
2. **Silent failure** — ArduPilot stores GPS_TYPE=14 without error even when
   the MAVLink GPS driver is compiled out. No warning in STATUSTEXT.
3. **Same version, different firmware** — custom builds with/without a feature
   can share the same version number. Track by file timestamp or git hash.
4. **features.txt may be empty** on custom builds — not a reliable way to
   verify features. Use SYS_STATUS GPS present bit as the definitive check.

### Files Changed

- No code changes in this session — firmware-only fix on the FC side

---

## Session 11 — 2026-03-20 (Phase 2β: Base Controller + MAVLink Telemetry)

**Goal:** Build the base station web controller — FastAPI app, fleet management,
MAVLink telemetry pipeline, show file format, and flight daemon skeleton.

### What was done

**Steps 1-2, 4-6 (prior):** FastAPI skeleton + fleet API + web UI
- Created `base-controller/` with FastAPI app at `:8080`
- Fleet CRUD API (`/api/fleet`) with JSON persistence + dnsmasq/mavlink-hub config gen
- Mode switching API (`/api/mode`) — config vs production mode
- Web dashboard with dark theme: fleet overview cards, fleet manager, config console
- WebSocket client infrastructure (auto-reconnect, message routing)
- systemd service `roban-controller.service` running on base station

**Step 3: MAVLink telemetry client**
- `mavlink/hub_client.py` — async MAVLink TCP client connecting to mavlink-hub `:5760`
  - Runs pymavlink in thread executor, posts to asyncio event loop
  - Parses: HEARTBEAT, GPS_RAW_INT, SYS_STATUS, ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD, BATTERY_STATUS
  - Auto-reconnect on connection loss (3s backoff)
- `mavlink/vehicle_tracker.py` — per-vehicle state aggregation
  - VehicleState: armed, flight_mode, GPS fix/sats/hdop, battery, attitude, speed
  - Online/offline detection via heartbeat watchdog (5s timeout)
  - ArduCopter/Heli flight mode map (STABILIZE through AUTOROTATE)
  - Broadcasts `vehicle_update` events to WebSocket clients
- `main.py` updated:
  - WebSocket endpoint `/ws/telemetry` — accepts clients, sends state snapshot on connect
  - VehicleTracker started/stopped in FastAPI lifespan
  - `/api/vehicles` endpoint for REST polling of live telemetry
  - `/api/health` now includes `vehicles_online` / `vehicles_total`
  - Version bumped to 0.2.0

**Step 7: Show file format + flight daemon skeleton**
- `choreography/show_format.py` — Pydantic models for show file schema v1:
  - ShowFile (metadata + tracks), HeliTrack (style + waypoints), HeliStyle, Waypoint, Vec3
  - NED coordinate frame, per-heli flight constraints (max_speed/accel/jerk, angle_max, corner_radius)
  - Timing validation (monotonic, within duration)
- `choreography/flight_daemon.py` — flight daemon skeleton:
  - State machine: IDLE → LOADED → ARMED → RUNNING → DONE
  - Pre-flight checks: all helis online, GPS fix ≥ 3D
  - Linear interpolation between waypoints (20 Hz loop)
  - Hold support at waypoints
  - Pause/resume/emergency stop
  - `_send_target()` stubbed — will send SET_POSITION_TARGET_LOCAL_NED via mavlink-hub
- `docs/show_file_spec.md` — full specification document
- `docs/example_show.json` — sample show file (hover test for Heli01)

### Architecture Notes

- HubClient uses `run_in_executor` for pymavlink blocking calls — no thread contention
- VehicleTracker filters sysid >= 250 (GCS/internal traffic)
- WebSocket broadcasts every MAVLink update — frontend already handles `vehicle_update` events
- Flight daemon is a "CNC G-code executor" pattern: show file → interpolated targets at 20 Hz
- Linear interpolation is placeholder — will upgrade to jerk-limited (Ruckig) in Phase 3+

### Files Changed

- `base-controller/main.py` — WebSocket endpoint, VehicleTracker integration, /api/vehicles
- `base-controller/mavlink/hub_client.py` — NEW: async MAVLink TCP client
- `base-controller/mavlink/vehicle_tracker.py` — NEW: vehicle state tracker
- `base-controller/choreography/show_format.py` — NEW: Pydantic show file schema
- `base-controller/choreography/flight_daemon.py` — NEW: flight daemon skeleton
- `base-controller/docs/show_file_spec.md` — NEW: show file specification
- `base-controller/docs/example_show.json` — NEW: example show file

### Phase 2β Status

| Step | Status | Description |
|------|--------|-------------|
| 1. FastAPI skeleton | **DONE** | App structure, routing, systemd |
| 2. Fleet identity API | **DONE** | CRUD, dnsmasq/mavlink-hub config gen |
| 3. MAVLink telemetry | **DONE** | Hub client, vehicle tracker, WebSocket |
| 4. Web dashboard | **DONE** | Dark theme, heli cards, live updates |
| 5. Fleet manager UI | **DONE** | Add/remove helis, apply config |
| 6. Config console UI | **DONE** | Mode switching, GCS bridge setup |
| 7. Show format + daemon | **DONE** | Schema v1, flight daemon skeleton |

**Phase 2β is COMPLETE.** Next: Phase 3 (scale to 2→10 helis).

---

## Session 12 — 2026-03-25 (Phase 3: Heli02 + Golden Image + Flight Ops)

**Goal:** Scale to 2 helis, build golden SD image, complete flight operations system.

### Golden SD Image

Created production image for cloning:
1. `dd if=/dev/rdisk4 of=roban-heli-golden.raw bs=4m` — 59GB raw image from Heli01 SD card
2. PiShrink via Docker (Mac): 59GB → 3.7GB compressed image
3. Stored as `images/roban-heli-golden.img` (not in git — too large)
4. Flash to ≥32GB SD cards, Armbian auto-expands on first boot

### Heli02 Provisioned

- Flashed golden image to new SD card, booted OPi Zero 2W
- WiFi password was wrong in golden image (`dopedope` instead of `Robanswarm`) — patched
- Auto-provisioned via captive portal → assigned heli_id=2, SYSID=12
- DHCP reservation: `192.168.50.102`, MAC registered in fleet controller
- SSH: `sshpass -p 'dopedope' ssh -J roban-swarm@192.168.3.119 root@192.168.50.102`

### Heli02 LC29HEA Baud Fix

LC29HEA on Heli02 still at factory 460800 (H618 can't do this baud — 8.5% error).
- Connected LC29HEA via USB to base station temporarily
- Sent `$PAIR864,0,0,115200*1B` at 460800 to switch baud
- Sent `$PQTMSAVEPAR*5A` at 115200 to persist
- Power cycled, verified 115200 output on OPi UART5

### Heli02 FC Setup

- FC SERIAL2_BAUD was 57 (57600) — fixed to 111 (115200) to match mavlink-router
- Set GPS1_TYPE=14, GPS_AUTO_CONFIG=0, SYSID_THISMAV=12
- Set H_COL_ANG_MIN=-2, H_COL_ANG_MAX=12 (clear pre-arm)
- Set ARMING_CHECK=0 (testing only — no compass/accel cal yet)
- Both Heli01 and Heli02 showing on dashboard with telemetry ✅

### FC Parameter Check/Fix Button

Added param verification to fleet dashboard:
- Checks GPS1_TYPE, GPS_AUTO_CONFIG, SERIAL2_BAUD, SERIAL2_PROTOCOL, SYSID_THISMAV
- "Check Params" and "Fix Params" buttons per heli on fleet page
- Auto-fix writes correct values and reboots FC

### Telemetry Auto-Request Fix

Dashboard only showed data when Mission Planner was connected — FC doesn't auto-stream.
- Fixed: hub_client.py now sends REQUEST_DATA_STREAM (all streams @ 4Hz) to each
  new FC on first heartbeat detection
- Also requests AUTOPILOT_VERSION for firmware version display on dashboard

---

## Session 13 — 2026-03-27 (Flight Operations + SIM Mode + i18n)

**Goal:** Complete flight operations system, SIM mode, internationalization.

### Flight Daemon — Complete Rewrite

Replaced skeleton with full field-ready flight operations:

**State machine:**
IDLE → LOADED → LINEUP_READY → PREFLIGHT_OK → ARMING → SPOOLING → TAKING_OFF → STAGING → RUNNING ⇄ PAUSED → LANDING → DONE

**Lineup capture** (`capture_lineup()`):
- Reads GPS position from all helis via vehicle_tracker
- Requires RTK Float minimum (fix ≥ 5) for accuracy
- Computes centroid as NED origin (home_lat, home_lon, home_alt)
- Stores per-heli home positions as NED offsets from origin

**Preflight checks:**
- GPS fix ≥ 3D, battery ≥ 20%, heli online
- RTL_ALT staggered per heli: 1500cm + (index × 300cm) — verified and auto-fixed
- Failsafe params: FS_GCS_ENABLE=1, FS_THR_ENABLE=1, BATT_FS_LOW_ACT=2
- NTRIP caster health check (real mode only)
- All checks are hard gates — must pass before arming allowed

**Launch sequence** (`launch()`):
1. Switch all helis to GUIDED mode
2. ARM all helis (15s timeout, retry every 3s)
3. Wait 8s spool time (TradiHeli rotor spin-up)
4. Parallel takeoff — all helis climb to HOVER_ALT_M (5m) simultaneously
5. Horizontal traverse — fly to show start positions at hover altitude
6. Descend to actual start altitude
7. Hold and wait for GO command

**Show playback:**
- 20Hz SET_POSITION_TARGET_LOCAL_NED loop with linear interpolation
- Safety monitor checks every tick (3m min separation, 100m geofence, 50m alt limit)
- Pause/resume support

**Landing sequence:**
- Staggered return: each heli climbs to unique altitude (8m + 3m per heli index)
- Horizontal return to home positions at staggered altitudes
- Parallel descent at 1.0 m/s
- Auto-disarm when altitude < 0.3m for 1.5s

**RTL failsafe:**
- Sets RTL_ALT per heli (staggered for collision-free failsafe)
- Switches all helis to RTL mode simultaneously

### In-Flight Safety Monitoring

Added to flight_daemon.py:
- **Heartbeat watchdog:** Pauses show if any heli offline >5s, RTL ALL if offline >15s
- **RTK quality monitor:** Warns if fix drops below RTK Float, RTL ALL if below 3D fix
- **NTRIP health:** Warns if no RTCM bytes for >15s (GPS will degrade to standalone)
- Background `_monitor_task` runs parallel to show playback loop

### Command Routing Fix

CommandSender originally used per-heli UDP — didn't work because mavlink-hub Server
endpoints don't route responses. Switched all commands to TCP 5760 (shared connection
via hub_client). ARM, mode change, param read/write all work reliably now.

### SIM Mode

- Toggle on dashboard switches between SIM and REAL mode
- SIM starts `tools/mavlink-sim.py` — Python MAVLink simulator
  - Per-heli TCP connections to mavlink-hub TCP 5760
  - Sends HEARTBEAT, GPS_RAW_INT, ATTITUDE, VFR_HUD, SYS_STATUS, BATTERY_STATUS
  - Responds to ARM/DISARM, SET_MODE, SET_POSITION_TARGET (simulates movement)
  - 2 sim helis at sysid 111, 112 (real +100 offset)
  - 5m spacing between helis (> 3m safety minimum)
- "Reset SIM" button restarts simulator after stop/RTL
- SIM banner on dashboard when active

### Show UI

- Operations toolbar: Upload → Lineup → Preflight → Launch → GO → Land
- Button color states: green (active), yellow (waiting), blinking yellow-green (ready)
- Per-heli telemetry cards with position/speed/altitude during show
- 2D NED canvas map with moving heli symbols, grid lines, scale bar
- WebSocket `show_event` messages for state transitions

### Internationalization (i18n)

Added 4-language support: English, German, Spanish, Chinese
- `static/js/lang.js` — translation dictionary + `I18N.t(key)` function
- Language selector dropdown in page header
- All UI labels, button text, phase names, log messages, confirmation dialogs translated
- `data-i18n` attributes on HTML elements for automatic translation on language switch

### Staging Sequence Fix

User reported helis were climbing and moving laterally at the same time during staging.
Split `_fly_to_start_positions()` into two phases:
1. Horizontal traverse at hover altitude (no altitude change)
2. Descend to actual start altitude once positioned over target

### Issues Encountered

| # | Issue | Resolution | Status |
|---|-------|-----------|--------|
| 1 | ARM via UDP doesn't work | Use TCP 5760 shared connection via hub_client | Fixed |
| 2 | ARM timeout 5s too short | Increased to 15s with 3s retry | Fixed |
| 3 | FC doesn't auto-stream telemetry | REQUEST_DATA_STREAM on first heartbeat | Fixed |
| 4 | SITL binary crashes on base station | Wrote Python MAVLink simulator instead | Fixed |
| 5 | Sim helis offline (TCP conflict) | Per-heli TCP connections to mavlink-hub | Fixed |
| 6 | Permission denied on /tmp/mavlink-sim.log | Fixed log path permissions in mode.py | Fixed |
| 7 | Safety violation at 3m spacing | Increased HELI_SPACING_M from 3.0 to 5.0 | Fixed |
| 8 | Return-to-home timeout too tight | 10s timeout, 5m tolerance | Fixed |
| 9 | Helis climb+move simultaneously | Split staging: climb first, traverse, descend | Fixed |
| 10 | Landing descent too slow (0.5 m/s) | Increased to 1.0 m/s | Fixed |
| 11 | Phase labels not translated | Added i18n keys for all HeliPhase values | Fixed |

---

## Session 14 — 2026-03-30 (Safety Interlocks + Preflight Hardening)

**Goal:** Add comprehensive safety interlocks for field readiness.

### Expanded Preflight Checks

Added hard gates that must ALL pass before arming is allowed:
- **Failsafe params:** FS_GCS_ENABLE=1, FS_THR_ENABLE=1, BATT_FS_LOW_ACT=2
  - These ensure ArduPilot triggers RTL on GCS loss, throttle loss, or low battery
  - Auto-fixable from preflight UI
- **RTL_ALT staggered:** Each heli gets unique return altitude (1500cm + index×300cm)
  - Prevents collision during failsafe RTL
- **NTRIP caster health:** Verifies RTCM corrections are flowing before arm (real mode)

### In-Flight Monitoring (background task)

New `_monitor_task` runs parallel to show playback:
- **Heartbeat watchdog:** Pause show if heli offline >5s; RTL ALL if >15s
- **RTK quality monitor:** Warn if fix drops below Float; RTL ALL if below 3D fix
- **NTRIP stale detection:** Warn if no RTCM for >15s (GPS degrades to standalone)

### Failsafe Chain Analysis

What happens in each failure scenario:
1. **WiFi lost (OPi → base):** mavlink-router on OPi loses base endpoint, FC continues
   flying last target. FS_GCS_ENABLE=1 on FC triggers RTL after GCS timeout (default 5s).
   Staggered RTL_ALT prevents collision.
2. **OPi dies (power/crash):** No more SET_POSITION_TARGET to FC. FC GCS failsafe
   triggers RTL. Same as WiFi loss from FC perspective.
3. **NTRIP lost (base caster down):** LC29HEA degrades from RTK to standalone GPS
   (~2m accuracy). In-flight monitor warns. If fix drops below 3D → RTL ALL.
4. **RTK fix lost (sky obstruction):** Same as NTRIP loss — monitor watches GPS fix
   quality continuously.
5. **Base station dies:** All helis lose GCS heartbeat → FS_GCS_ENABLE triggers RTL
   on each FC independently. Staggered RTL_ALT prevents collision.

### Files Changed

- `base-controller/choreography/flight_daemon.py` — expanded preflight, in-flight monitor
- `base-controller/api/params.py` — added failsafe params to check list
- `base-controller/static/js/show.js` — preflight result display for new checks
- `base-controller/static/js/lang.js` — translations for new check messages
- `base-controller/static/index.html` — minor layout updates
- `base-controller/static/js/dashboard.js` — telemetry card updates

---

## Current Status (as of 2026-03-30)

### Phase Completion

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Pre-hardware | Done | |
| Phase 1: Base station | Done | All services persisted |
| Phase 2: First companion | Done | RTK fix verified, custom firmware |
| Phase 2β: Foundation | **Done** | Controller v0.2.0 at :8080 |
| Phase 3: Scale to 2→10 | **In progress** | 2 helis working, 8 boards ready to flash |
| Phase 4: Field RTK | Not started | |
| Phase 5: Soak test | Not started | |
| Phase 6: Hardening | Not started | |

### What's Working

- 2 helis (Heli01 + Heli02) with RTK GPS, FC MAVLink, auto-provisioned
- Web dashboard with live telemetry, 4-language UI, SIM/REAL mode
- Full flight operations: lineup → preflight → launch → show → land → RTL
- Safety: collision avoidance, geofence, heartbeat watchdog, RTK monitor
- Preflight: failsafe params, RTL_ALT stagger, NTRIP health, GPS fix, battery
- SIM mode with Python MAVLink simulator for desk testing

### Immediate Next Steps

1. **Field test** full show cycle on real hardware (2 helis, props off)
2. Flash golden image to remaining 8 boards → provision → test at scale
3. Trajectory planner upgrade: linear interp → jerk-limited S-curves
4. Production hardening: watchdogs, auto-recovery, logging, post-flight reports
