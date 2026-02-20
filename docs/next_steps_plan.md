# Next Steps Plan — Roban Swarm RTK Field Network

**Status:** Repo is ~95% code-complete. All scripts, configs, systemd units,
docs, and test checklists are written. What remains is hands-on hardware
bring-up, credential provisioning, empirical testing, and operational
hardening.

This plan is ordered by dependency — each phase depends on the previous
one completing. Estimated timeline: **5–7 working days** for a 2-person team
with all hardware on hand.

---

## Phase 0: Pre-Hardware Preparation (Day 0 — half day)

Things to resolve at the desk before touching any hardware.

### 0.1 Confirm Orange Pi Zero WiFi band support

The TP-Link AP1901GP supports dual-band (2.4 / 5 GHz). The Orange Pi
Zero H2+ has **2.4 GHz only** WiFi. The H3 variant may support 5 GHz.

**Action:** Check the actual SoC variant on all 10 companion boards.

| Result | AP Configuration |
|--------|-----------------|
| All boards 2.4 GHz only | AP must broadcast on 2.4 GHz (or dual-band) |
| Some boards support 5 GHz | Use dual-band; accept 2.4 GHz fallback |
| All boards support 5 GHz | Use fixed 5 GHz channel (less interference) |

This decides AP channel strategy before anything gets powered on.

### 0.2 Decide RTKBase deployment method

RTKBase (Stefal/rtkbase) is primarily designed for Raspberry Pi. On
Ubuntu x86 it can run natively or via Docker.

**Options (pick one):**

| Method | Pros | Cons |
|--------|------|------|
| Docker Compose | Isolated, reproducible, easy to update | Requires Docker install, slight overhead |
| Native install | No Docker dependency, lower resource use | May need manual dependency resolution |
| RTKLIB str2str only | Simplest, no RTKBase UI | No web UI for monitoring, manual config |

**Action:** Test RTKBase on the base station hardware:
```bash
# Docker approach (recommended to try first):
sudo apt install docker.io docker-compose
cd /opt/rtkbase
# Follow RTKBase Docker instructions

# OR native approach:
cd /opt/rtkbase
./install.sh  # RTKBase's own installer
```

Once you know which method works, update `base-station/systemd/rtkbase.service`
to match the actual startup command.

### 0.3 Choose and record WiFi passphrase + NTRIP credentials

Pick credentials now so they're consistent across all installs:

```
WiFi SSID:       RTK-FIELD
WiFi passphrase: <generate a strong WPA2 passphrase, 16+ chars>
NTRIP user:      admin  (or custom)
NTRIP password:  <generate a separate strong password>
NTRIP mount:     BASE   (or match RTKBase config)
```

Record these in a **secure offline document** (not in git).
Every companion and the base station need the same NTRIP credentials.

### 0.4 Prepare OS images

- **Base station:** Download Ubuntu Server 22.04 LTS (or 24.04 LTS)
  ISO. Flash to USB drive for install.
- **Companions (×10):** Download Armbian Ubuntu Jammy image for Orange
  Pi Zero. Flash to 10 microSD cards. Consider using `dd` or Balena
  Etcher for batch flashing.

### 0.5 Inventory all hardware

Lay out and physically verify:
- [ ] 1× base station mini-PC (boots, Ethernet works)
- [ ] 1× TP-Link TL-AP1901GP + PoE injector + Ethernet cable
- [ ] 11× LC29H modules + dual-band antennas (10 rover + 1 base)
- [ ] 10× Orange Pi Zero boards + 10× microSD cards + 10× IPEX antennas
- [ ] USB-UART adapters (at least 21: 2 per companion + 1 for base)
- [ ] 10× flight controllers (ArduPilot loaded, TELEM + GPS ports accessible)
- [ ] Power supplies / batteries for bench testing

---

## Phase 1: Base Station Bring-up (Day 1)

### 1.1 Install OS and run provisioning

```bash
# After Ubuntu Server is installed and has internet temporarily:
sudo apt update && sudo apt install git -y
git clone https://github.com/mpnemo/roban-swarm.git
cd roban-swarm
sudo ./base-station/install.sh
```

### 1.2 Verify base network services

```bash
./base-station/tools/status_dump.sh
```

Confirm:
- [ ] Static IP 192.168.50.1 on detected LAN NIC
- [ ] dnsmasq running, listening on :53 and :67
- [ ] chrony running, serving NTP
- [ ] mavlink-hub running, listening on :14550 and :14560–14569
- [ ] nftables rules loaded (check `nft list ruleset`)
- [ ] `/etc/resolv.conf` points to 127.0.0.1

### 1.3 Configure AP (manual — web UI)

Follow `docs/ap_setup_checklist.md` exactly:

1. Connect laptop to AP via Ethernet
2. Access web UI (default IP on label, usually 192.168.0.254)
3. Set AP/Bridge mode (NOT router)
4. SSID: `RTK-FIELD`, WPA2-PSK, passphrase from step 0.3
5. **Disable client isolation** — CRITICAL
6. **Disable AP DHCP** — base station handles DHCP
7. Set fixed channel (per band decision from step 0.1)
8. Set management IP to 192.168.50.250 (in-band for field access)
9. Max TX power

**Verification:**
```bash
# From base station (after AP is connected via Ethernet):
ip link show eth0   # should be UP
# From a laptop connected to RTK-FIELD WiFi:
ping 192.168.50.1   # must succeed — confirms no client isolation
```

### 1.4 Connect base GNSS receiver

1. Connect LC29H (base unit) via USB-UART to base station
2. Identify serial port:
   ```bash
   ls -la /dev/serial/by-id/
   ```
3. Edit `/etc/roban-swarm/rtkbase.env`:
   - Set `BASE_GNSS_SERIAL=/dev/serial/by-id/<actual_device>`
   - Set `NTRIP_PASS` from step 0.3
4. Start RTKBase:
   ```bash
   sudo systemctl enable --now rtkbase
   journalctl -u rtkbase -f
   ```
5. Place antenna with clear sky view
6. Wait for survey-in (5–15 minutes)
7. Once survey-in completes, verify NTRIP caster:
   ```bash
   ./base-station/tools/show_rtk_clients.sh
   curl http://192.168.50.1:2101/   # should show source table
   ```
8. **Save fixed coordinates:** After survey-in, record lat/lon/height
   to `/etc/roban-swarm/base_coords.conf` so next boot skips survey-in.

---

## Phase 2: First Companion Integration (Day 2)

### 2.1 Flash and install Heli 01

```bash
# After Armbian boots on Orange Pi Zero:
sudo apt update && sudo apt install git -y
git clone https://github.com/mpnemo/roban-swarm.git
cd roban-swarm
sudo ./companion/install.sh --heli-id 01
```

### 2.2 Record MAC and add DHCP reservation

```bash
# On companion:
ip link show wlan0 | grep ether
# Example: link/ether aa:bb:cc:dd:ee:ff

# On base station — edit dnsmasq config:
sudo nano /etc/dnsmasq.d/roban-swarm.conf
# Uncomment and update line:
# dhcp-host=aa:bb:cc:dd:ee:ff,192.168.50.101,heli01

sudo systemctl restart dnsmasq
```

### 2.3 Set WiFi passphrase

```bash
# On companion:
sudo nmcli connection modify RTK-FIELD wifi-security.psk 'YOUR_PASSPHRASE'
sudo nmcli connection up RTK-FIELD
```

Verify: companion gets IP 192.168.50.101.

### 2.4 Connect USB-UART adapters and identify serial ports

1. Plug FC USB-UART adapter into companion — note the new device in
   `/dev/serial/by-id/`
2. Plug GNSS USB-UART adapter — note the second new device
3. Run `./companion/tools/detect_ports.sh`
4. Edit `/etc/roban-swarm/heli.env`:
   ```
   FC_SERIAL=/dev/serial/by-id/<actual_fc_device>
   GNSS_RTCM_SERIAL=/dev/serial/by-id/<actual_gnss_device>
   NTRIP_PASS=<from step 0.3>
   ```
5. Regenerate mavlink-router config:
   ```bash
   sudo ./companion/tools/set_heli_id.sh 01
   ```

### 2.5 Start services and verify RTCM

```bash
sudo systemctl start ntrip-client mavlink-router
journalctl -u ntrip-client -f
# Should see bytes received from NTRIP server
```

### 2.6 Power FC and verify MAVLink

1. Power flight controller (PROPS OFF!)
2. On base station:
   ```bash
   ./base-station/tools/show_mavlink_lastseen.sh
   # Port 14560 should show ACTIVE
   ```
3. Open GCS (Mission Planner or QGC) connected to UDP 192.168.50.1:14550
4. Confirm: vehicle appears with SYSID 11

### 2.7 Determine LC29H GPS_TYPE

This is empirical — try in order:

| GPS_TYPE | Protocol | Try first? |
|----------|----------|-----------|
| 2 | u-blox (UBX) | Yes — LC29H supports UBX |
| 5 | NMEA | Second — widely supported |
| 26 | Unicore | Third — if others fail |

In GCS:
```
param set GPS_TYPE 2
# Reboot FC, wait 30 seconds
# Check GPS_RAW_INT — satellites visible? Fix?
# If no fix after 2 minutes, try next GPS_TYPE
```

**Record the working GPS_TYPE value** — all 10 helis will use the same.

### 2.8 Set ArduPilot parameters

```
param set SYSID_THISMAV 11
param set SERIALx_PROTOCOL 2      # MAVLink 2 on TELEM port
param set SERIALx_BAUD 921        # 921600 on TELEM port
param set SERIALy_PROTOCOL 5      # GPS on GPS port
param set SERIALy_BAUD 115        # 115200 on GPS port
param set GPS_TYPE <working value from 2.7>
```

### 2.9 Verify RTK fix

With base GNSS antenna and companion GNSS antenna both with clear sky:

1. Check GCS GPS status: should show 3D Fix initially
2. Wait 1–5 minutes for RTK Float
3. Wait 2–10 minutes for RTK Fix
4. Verify horizontal accuracy < 50 mm in GPS_RAW_INT.h_acc

### 2.10 Test bidirectional commands

From GCS:
- [ ] Send arm command → FC arms (or shows pre-arm failure message)
- [ ] Send disarm command → FC disarms
- [ ] Change flight mode → FC mode changes

If commands don't reach FC, check:
- mavlink-hub config has `heli01_cmd` endpoint pointing to 192.168.50.101:14660
- companion mavlink-router has `from_base` Server on port 14660
- no firewall blocking

### 2.11 Run automated smoketest

```bash
./companion/tools/bench_smoketest.sh
# All checks must PASS
```

---

## Phase 3: Scale to 10 Helis (Days 3–4)

### 3.1 Batch flash remaining 9 companions

Flash Armbian to 9 microSD cards. Boot each one and repeat steps 2.1–2.5.

**Efficiency tip:** Create a checklist sheet and work through all 9
sequentially. The steps per companion should take 15–20 minutes once
you have the rhythm.

### 3.2 Record all MAC addresses

As each companion boots, record its WiFi MAC and add to dnsmasq.

After all 10 are recorded:
```bash
# On base station — verify no duplicates:
grep "dhcp-host" /etc/dnsmasq.d/roban-swarm.conf | grep -v "^#"
sudo systemctl restart dnsmasq
```

### 3.3 Fill in master identity table

Update `docs/identity_mapping.md` with actual MAC addresses.
This is your **deployment manifest** — print it and keep a copy offline.

| Heli ID | Companion MAC | Reserved IP | UDP Port | CMD Port | SYSID |
|---------|--------------|-------------|----------|----------|-------|
| Heli01 | `actual:mac:here` | 192.168.50.101 | 14560 | 14660 | 11 |
| Heli02 | `actual:mac:here` | 192.168.50.102 | 14561 | 14661 | 12 |
| ... | ... | ... | ... | ... | ... |
| Heli10 | `actual:mac:here` | 192.168.50.110 | 14569 | 14669 | 20 |

### 3.4 Set SYSID on all 10 FCs

Use GCS or MAVProxy to set `SYSID_THISMAV` on each FC (11–20).
Set `GPS_TYPE` to the value determined in step 2.7 on all FCs.

### 3.5 Multi-vehicle GCS test

1. Power all 10 companions and FCs (props off)
2. Connect GCS to UDP 192.168.50.1:14550
3. Verify:
   - [ ] All 10 vehicles appear in vehicle selector
   - [ ] Each has correct and unique SYSID (11–20)
   - [ ] No telemetry merging (positions are distinct)
   - [ ] Command to Heli01 only affects Heli01
   - [ ] Command to Heli10 only affects Heli10

### 3.6 Validate pre-deployment script (recommended addition)

Write a quick validation script for the base station that checks:
```bash
#!/usr/bin/env bash
# validate_fleet.sh — run on base station before field deployment
echo "Checking DHCP reservations..."
active=$(grep -c "^dhcp-host=" /etc/dnsmasq.d/roban-swarm.conf)
echo "  $active reservations configured (need 10)"

echo "Checking for duplicate MACs..."
grep "^dhcp-host=" /etc/dnsmasq.d/roban-swarm.conf | cut -d, -f1 | sort | uniq -d
# Should produce no output

echo "Checking DHCP leases..."
cat /var/lib/misc/dnsmasq.leases | wc -l

echo "Checking MAVLink ports..."
./base-station/tools/show_mavlink_lastseen.sh
```

---

## Phase 4: Field RTK Validation (Day 5)

### 4.1 Select test site

- Clear sky view (no buildings/trees above 15° elevation)
- Open area matching operational environment
- Power available (generator, battery pack, or vehicle inverter)

### 4.2 Deploy in power-on order

Per `docs/ops_runbook.md`:
1. Base station → wait 60s
2. AP (PoE) → wait 60s, confirm SSID visible
3. Base GNSS antenna (clear sky, stable mount)
4. Wait for survey-in or fixed coords load
5. Companions (all 10) → props off
6. GCS (last)

### 4.3 Run field checklist

Follow `test/field_checklist.md`:
- [ ] Base GNSS tracking > 10 satellites
- [ ] Survey-in complete (or fixed coords loaded)
- [ ] All 10 companions WiFi connected
- [ ] All 10 showing RTCM bytes increasing
- [ ] All 10 achieve RTK Float within 5 minutes
- [ ] Most achieve RTK Fix within 10 minutes
- [ ] Horizontal accuracy < 50 mm on RTK Fix
- [ ] WiFi signal adequate at operating boundary

### 4.4 Range test

Walk a companion (or the GCS laptop) to the edge of expected operating
area. Verify:
- WiFi stays connected
- Telemetry updates remain smooth
- RTK Fix maintained
- Command latency acceptable

---

## Phase 5: Soak Testing (Day 5–6, 2–4 hours)

### 5.1 Set up monitoring

```bash
# On base station:
while true; do
    echo "=== $(date) ===" >> /tmp/soak_base.log
    ./base-station/tools/status_dump.sh >> /tmp/soak_base.log 2>&1
    sleep 300
done &

# On each companion (or a sample):
while true; do
    echo "=== $(date) ===" >> /tmp/soak_comp.log
    ./companion/tools/status_dump.sh >> /tmp/soak_comp.log 2>&1
    sleep 300
done &
```

### 5.2 Let it run 2–4 hours

Walk away. Monitor GCS occasionally. Record results in `test/soak_test.md`.

### 5.3 Run reconnect tests

Per `test/soak_test.md`:

1. **AP power cycle:** Unplug PoE for 30 seconds → plug back in
   - Expected: all companions reconnect within 60 seconds
   - Record actual time: _____ seconds

2. **Base station reboot:** `sudo reboot` on base
   - Expected: all services auto-start, companions reconnect
   - Record recovery time: _____ seconds

3. **Single companion reboot:** Reboot one companion
   - Expected: that companion recovers, others unaffected
   - Record recovery time: _____ seconds

### 5.4 Review soak results

All "must pass" criteria from `test/soak_test.md`:
- [ ] No service crashes over 2 hours
- [ ] All companions maintained WiFi
- [ ] RTCM bytes continuous (no gaps > 30s)
- [ ] MAVLink heartbeats continuous (no gaps > 5s)
- [ ] Reconnect tests all passed

---

## Phase 6: Operational Hardening (Day 6–7)

### 6.1 Document findings

Update docs with actual values discovered during bring-up:

- **docs/wiring.md:** Fill in actual pin numbers, connector types,
  voltage levels observed
- **docs/ardupilot_params.md:** Record the working GPS_TYPE value,
  actual serial port numbers on your FCs
- **docs/identity_mapping.md:** Complete with real MAC addresses
- **docs/ops_runbook.md:** Update recovery times from soak test

### 6.2 Harden base coordinates persistence

After survey-in, ensure the coordinates are persisted:
```bash
# Save to base_coords.conf:
echo "LAT=xx.xxxxxxxx" > /etc/roban-swarm/base_coords.conf
echo "LON=yy.yyyyyyyy" >> /etc/roban-swarm/base_coords.conf
echo "HEIGHT=zz.zzz" >> /etc/roban-swarm/base_coords.conf
```

Configure RTKBase to load these on boot instead of re-surveying.

### 6.3 Configure ArduPilot failsafes

On every FC, set:
```
FS_THR_ENABLE = 1         # throttle failsafe
FS_GCS_ENABLE = 1         # GCS failsafe (RTL on GCS loss)
RTL_ALT = <safe altitude>
FENCE_ENABLE = 1          # geofence (recommended)
```

### 6.4 Prepare spare companion kit

Flash 1–2 spare Orange Pi Zeros with Armbian. Don't run install.sh yet
(MAC unknown). Label them "SPARE". If a companion fails in the field:

1. Boot spare, run `install.sh --heli-id NN`
2. Record new MAC, update dnsmasq on base
3. Configure WiFi + serial ports
4. Resume operations

### 6.5 Create field deployment bag checklist

Print and laminate:
- [ ] Base station + power cable
- [ ] AP + PoE injector + Ethernet cable
- [ ] Base GNSS antenna + cable + tripod/mount
- [ ] 10× companion boards (labeled H01–H10) + power cables
- [ ] 10× IPEX WiFi antennas
- [ ] Spare companion (1–2)
- [ ] Spare USB-UART adapters (2–3)
- [ ] Spare microSD cards (2)
- [ ] Laptop with GCS (charged) + charger
- [ ] Printed identity mapping table
- [ ] Printed ops runbook + checklists
- [ ] Multimeter (for voltage checks)
- [ ] Network cable tester
- [ ] Cable ties, electrical tape, labels

### 6.6 Back up the repo state

After all configurations are validated:
```bash
cd roban-swarm
git add -A
git commit -m "Post-validation: real MAC addresses, tested configs"
git push
```

Keep a tagged release:
```bash
git tag -a v1.0-field-ready -m "Validated for field deployment"
git push origin v1.0-field-ready
```

---

## Future Improvements (Post-Deployment)

These are **not blockers** for initial deployment but would improve the
system for ongoing operations.

### Short-term (weeks)

- **Automated MAC validation script** on base station — verify all 10
  MACs are present and unique before allowing field deployment
- **Per-vehicle .tlog logging** on base station — write MAVLink logs
  per vehicle for post-flight analysis
- **RTKBase Docker Compose** file in the repo if Docker is the chosen
  deployment method
- **Bulk provisioning script** — loop over heli IDs 01–10 with a
  single command for fresh SD card batch setup

### Medium-term (months)

- **Monitoring dashboard** — simple web page on base station showing
  fleet status (all 10 helis, RTCM, MAVLink, GPS fix)
- **Auto-recovery watchdog improvement** — detect "base station
  unreachable" vs "service crash" and handle differently
- **Backup GCS endpoint** — add port 14570 for a second GCS connection
- **OTA configuration updates** — push heli.env changes from base
  station to companions via SSH/SCP

### Long-term (future projects)

- **Split repos** — if base-station and companion diverge significantly,
  keep this as umbrella integration repo and mirror subtrees
- **Network boot** — PXE/netboot companions from base station instead
  of microSD cards (eliminates SD card failure mode)
- **Mesh networking** — if WiFi range is insufficient, evaluate
  802.11s mesh or relay nodes

---

## Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| 1 | AP client isolation left ON | All companions can't reach base | Medium | Verify in AP UI + ping test from companion to base |
| 2 | SYSID collision (two helis same ID) | GCS merges telemetry, commands mis-routed | Medium | Automated check in GCS before flight |
| 3 | WiFi band mismatch | Companions can't see AP | Low | Pre-check in Phase 0 |
| 4 | RTKBase won't start on x86 | No RTCM corrections | Medium | Have Docker fallback ready; worst case use raw str2str |
| 5 | LC29H GPS_TYPE unknown | No GPS fix in ArduPilot | Medium | Empirical test in Phase 2; document result |
| 6 | Serial port names change | Services fail after reboot | Low | Already using /dev/serial/by-id/ |
| 7 | Survey-in too slow or fails | Delayed deployment | Low | Pre-survey at known location; persist coords |
| 8 | 10 simultaneous NTRIP clients overload | RTCM drops | Low | RTKBase/str2str handles 10 easily; monitor in soak test |
| 9 | SD card failure on companion | One heli offline | Medium | Carry spares; 5-min recovery with spare board |
| 10 | Power loss to AP | All helis lose comms | Medium | Configure RTL failsafe; UPS on AP if critical |

---

## Timeline Summary

| Day | Activity | Deliverable |
|-----|----------|-------------|
| 0 | Pre-hardware prep (WiFi band, RTKBase method, credentials, OS images) | Decision log |
| 1 | Base station install + AP config + base GNSS | Working base with NTRIP caster |
| 2 | First companion (Heli01) end-to-end | One heli: WiFi → RTCM → MAVLink → GCS → RTK Fix |
| 3–4 | Remaining 9 companions | All 10 helis verified in GCS |
| 5 | Field RTK validation + soak test start | RTK Fix on all helis outdoors |
| 5–6 | Soak test completion (2–4h) | Stability confirmed |
| 6–7 | Operational hardening, docs update, failsafes, spares | v1.0-field-ready tag |

---

*This plan should be reviewed and updated as each phase completes.
Actual timings will depend on hardware availability and any issues
discovered during bring-up.*
