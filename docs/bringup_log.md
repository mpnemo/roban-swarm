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

## Current Status (as of 2026-03-10)

### Phase completion

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Pre-hardware | Done | OS images ready, WiFi band confirmed (2.4 GHz Unisoc on Zero 2W) |
| Phase 1: Base station | ~95% done | All services running, netplan fixed, needs sysctl/NAT persistence |
| Phase 2: First companion | ~60% done | Software installed on Heli01, DHCP reserved, needs serial ports + NTRIP creds |
| Phase 3: Scale to 10 | Not started | |
| Phase 4: Field RTK | Not started | |
| Phase 5: Soak test | Not started | |
| Phase 6: Hardening | Not started | |

### Immediate next steps
1. Persist base station NAT/forwarding/sysctl settings for reboots
2. Connect USB-UART adapters (FC + GNSS) to OPi and identify serial ports
3. Update `/etc/roban-swarm/heli.env` and mavlink-router config with real serial paths
4. Configure NTRIP credentials
5. Start services: `systemctl start ntrip-client mavlink-router`
6. Connect base GNSS receiver, configure RTKBase
7. Run bench smoketest

### Connection details
- **Base station SSH:** `ssh roban-swarm@192.168.3.119` (home WiFi)
- **Base station RTK-FIELD IP:** `192.168.50.1`
- **Orange Pi Zero 2W (Heli01):** `192.168.50.101` (reserved, MAC `c0:64:94:ab:b4:31`)
  - Current IP may be .108 until DHCP renews; reboot to get .101
  - SSH: `sshpass -p 'dopedope' ssh -J roban-swarm@192.168.3.119 root@192.168.50.101`
- **WiFi SSID:** `Robanswarm` (was planned as `RTK-FIELD`)
- **AP:** TP-Link at `192.168.50.111` (DHCP disabled, bridge mode)
- **GitHub repo:** `https://github.com/mpnemo/roban-swarm.git`

### Hardware identity table (partial)

| Heli | MAC | Reserved IP | Telemetry | Command | SYSID | Status |
|------|-----|-------------|-----------|---------|-------|--------|
| 01 | `c0:64:94:ab:b4:31` | 192.168.50.101 | 14560 | 14660 | 11 | Software installed |
| 02-10 | TBD | .102-.110 | 14561-14569 | 14661-14669 | 12-20 | Not started |
