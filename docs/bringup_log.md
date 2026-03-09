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

## Current Status (as of 2026-03-09)

### Phase completion

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Pre-hardware | Partially done | OS installed, credentials set, WiFi band TBD |
| Phase 1: Base station | ~90% done | All services running, install.sh needs commit, RTKBase/GNSS not yet configured |
| Phase 2: First companion | Not started | OPi Zero powered on and got DHCP, but no companion install yet |
| Phase 3: Scale to 10 | Not started | |
| Phase 4: Field RTK | Not started | |
| Phase 5: Soak test | Not started | |
| Phase 6: Hardening | Not started | |

### Immediate next steps
1. Commit the install.sh fixes to git
2. SSH into Orange Pi Zero at 192.168.50.192 (or re-discover its IP)
3. Run `companion/install.sh --heli-id 01` on the OPi
4. Record OPi WiFi MAC, add DHCP reservation on base
5. Configure WiFi passphrase for RTK-FIELD
6. Connect USB-UART adapters (FC + GNSS) and identify serial ports

### Connection details
- **Base station SSH:** `ssh roban-swarm@192.168.3.119` (home WiFi)
- **Base station RTK-FIELD IP:** `192.168.50.1`
- **Orange Pi Zero (last known):** `192.168.50.192` (DHCP, may change)
- **GitHub repo:** `https://github.com/mpnemo/roban-swarm.git`
