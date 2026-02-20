# Operations Runbook

## Power-On Order

Follow this sequence for clean startup:

### 1. Base Station (first)
```
1. Power on base station mini-PC
2. Wait for boot (30–60 seconds)
3. Verify: dnsmasq running, static IP assigned
   → ssh into base OR connect monitor
   → run: ./base-station/tools/status_dump.sh
```

### 2. Access Point (second)
```
1. Apply PoE power to AP (or plug in PoE injector)
2. Wait for AP to broadcast SSID "RTK-FIELD" (30–60 seconds)
3. Verify: base station sees AP on Ethernet link
   → ip link show eth0 (should be UP)
```

### 3. Base GNSS (third)
```
1. Connect base GNSS antenna with clear sky view
2. USB-UART cable should already be connected to base station
3. Verify: RTKBase sees receiver, satellite count increasing
   → ./base-station/tools/show_rtk_clients.sh
   → journalctl -u rtkbase --no-pager -n 20
4. Wait for survey-in to complete (or fixed coords to load)
   → Survey-in: 5–15 minutes depending on settings
   → Fixed: immediate if coords file exists
```

### 4. Companions (after base is ready)
```
1. Power on companion boards (battery or bench supply)
2. Each companion auto-connects to WiFi and starts services
3. Verify one at a time initially:
   → ./companion/tools/status_dump.sh
   → Check WiFi connected, IP assigned, services running
4. After first companion verified, power on remaining
```

### 5. GCS (last)
```
1. Connect GCS laptop to RTK-FIELD WiFi (or wired to base)
2. Open Mission Planner or QGroundControl
3. Connect to UDP 192.168.50.1:14550
4. Verify: all powered helis appear with correct SYSIDs
```

## What to Check First

When something isn't working, check in this order:

### Layer 1: Physical / Network
```bash
# On base station:
ip addr show                    # Is 192.168.50.1 assigned?
ping -c 1 192.168.50.101       # Can reach companion?
systemctl status dnsmasq        # DHCP running?

# On companion:
nmcli dev status                # WiFi connected?
ip addr show wlan0              # Got DHCP address?
ping -c 1 192.168.50.1         # Can reach base?
```

### Layer 2: RTCM / GNSS
```bash
# On base station:
systemctl status rtkbase        # RTKBase running?
ss -tlnp | grep 2101            # NTRIP caster listening?
./base-station/tools/show_rtk_clients.sh  # Clients connected?

# On companion:
systemctl status ntrip-client   # str2str running?
journalctl -u ntrip-client -n 20  # Errors? Byte count?
```

### Layer 3: MAVLink
```bash
# On base station:
systemctl status mavlink-hub    # Hub running?
./base-station/tools/show_mavlink_lastseen.sh  # Packets from helis?

# On companion:
systemctl status mavlink-router # Router running?
journalctl -u mavlink-router -n 20  # Errors?
```

### Layer 4: GCS / Application
- Vehicle appears in GCS? → MAVLink working
- Correct SYSID? → Check SYSID_THISMAV
- GPS fix? → Check satellite count, fix type
- RTK Float/Fix? → Check RTCM flow
- Commands work? → Bidirectional routing OK

## Common Failures

### No WiFi Connection (companion)
```bash
nmcli dev wifi list              # Is RTK-FIELD visible?
nmcli con show                   # Is profile configured?
journalctl -u NetworkManager -n 30  # Connection errors?
```
Fixes:
- AP not powered → check PoE
- Wrong passphrase → update /etc/roban-swarm/heli.env
- AP client isolation ON → disable in AP UI
- 5 GHz not supported → switch AP to 2.4 GHz or dual-band

### No DHCP Lease (companion has WiFi but no IP)
```bash
# On companion:
journalctl -u NetworkManager -n 30 | grep DHCP

# On base station:
systemctl status dnsmasq
cat /var/lib/misc/dnsmasq.leases
```
Fixes:
- dnsmasq not running → `sudo systemctl start dnsmasq`
- Wrong interface in dnsmasq config → check /etc/dnsmasq.d/
- AP providing conflicting DHCP → disable AP DHCP in AP UI

### No RTCM (companion connected but no corrections)
```bash
# On companion:
journalctl -u ntrip-client -n 30
# Look for: connection refused, auth failed, zero bytes

# On base station:
ss -tlnp | grep 2101             # Caster listening?
./base-station/tools/show_rtk_clients.sh
```
Fixes:
- RTKBase not running → `sudo systemctl start rtkbase`
- Wrong NTRIP credentials → update heli.env
- Wrong mount point → check RTKBase caster config
- Firewall blocking 2101 → check nftables/ufw rules

### No MAVLink Heartbeat
```bash
# On companion:
journalctl -u mavlink-router -n 30
ls -la /dev/serial/by-id/       # FC serial present?

# On base station:
./base-station/tools/show_mavlink_lastseen.sh
ss -ulnp | grep 1456            # Hub listening?
```
Fixes:
- FC not powered → check power
- Wrong serial port → re-run detect_ports.sh
- Wrong baud rate → verify FC TELEM baud matches config
- Firewall blocking UDP → check nftables/ufw rules

### SYSID Collision (GCS shows merged vehicles)
Symptoms: Two helis appear as one, telemetry jumps between positions,
commands go to wrong vehicle.

Fix: Each heli must have unique SYSID_THISMAV. Check with:
```bash
# In GCS MAVLink inspector, look for HEARTBEAT messages
# Multiple sources with same SYSID = collision
```

## Shutdown Order

Reverse of power-on:

1. Disconnect GCS
2. Power off companions (or disarm + power off)
3. Power off AP
4. Power off base station

## Field Deployment Checklist

Before leaving for the field:

- [ ] All batteries charged (companions, helis, base station UPS if any)
- [ ] All 10 companion MAC addresses recorded in dnsmasq
- [ ] SYSID 11–20 assigned and verified
- [ ] WiFi passphrase set on all companions
- [ ] NTRIP credentials configured
- [ ] Base GNSS antenna + cable packed
- [ ] AP + PoE injector + Ethernet cable packed
- [ ] Laptop with GCS installed + charged
- [ ] This runbook printed or accessible offline

## Emergency Procedures

### Total Network Loss
If all companions lose WiFi simultaneously:
1. Check AP power (PoE)
2. Check AP Ethernet cable connection
3. Helis continue last command / RTL if configured
4. Once AP restored, companions auto-reconnect

### Base Station Crash
1. Companions lose RTCM and MAVLink routing
2. Helis degrade to standalone GPS (no RTK)
3. GCS loses all telemetry
4. Reboot base station; all services auto-start
5. Companions auto-reconnect to NTRIP and MAVLink

### Single Companion Failure
1. One heli goes offline in GCS
2. Other helis unaffected
3. Reboot companion board
4. Services auto-start and reconnect
