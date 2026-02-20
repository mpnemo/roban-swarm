# Troubleshooting Guide

## Quick Diagnostic Commands

### Base Station
```bash
./base-station/tools/status_dump.sh       # Full status overview
./base-station/tools/list_clients.sh      # DHCP leases
./base-station/tools/show_mavlink_lastseen.sh  # MAVLink activity
./base-station/tools/show_rtk_clients.sh  # NTRIP clients
```

### Companion
```bash
./companion/tools/status_dump.sh          # Full status overview
./companion/tools/detect_ports.sh         # Serial port detection
./companion/tools/bench_smoketest.sh      # Pre-flight checks
```

---

## WiFi Issues

### Companion can't see SSID "RTK-FIELD"

**Symptoms:** `nmcli dev wifi list` shows no RTK-FIELD network.

**Checks:**
1. Is the AP powered? Check PoE injector LED.
2. Is the AP configured? SSID might not be set yet.
3. Is the correct band enabled?
   - Orange Pi Zero (H2+/H3) may only support 2.4 GHz
   - If AP is 5 GHz only, companions can't see it
4. Is the companion WiFi interface up?
   ```bash
   ip link show wlan0
   nmcli radio wifi
   ```

**Fixes:**
- Enable 2.4 GHz on AP (or both bands)
- `nmcli radio wifi on` if WiFi is disabled
- Check IPEX antenna is connected to companion board

### Companion sees SSID but won't connect

**Symptoms:** WiFi scan works, but association fails.

**Checks:**
```bash
journalctl -u NetworkManager -n 50 --no-pager | grep -i wifi
nmcli con show RTK-FIELD
```

**Common causes:**
- Wrong WPA2 passphrase → update in heli.env and NetworkManager profile
- AP at maximum client limit → check AP UI
- MAC filtering enabled on AP → disable or add MAC to whitelist

### Connected to WiFi but no IP address

**Symptoms:** wlan0 shows "connected" but no IPv4 address.

**Checks:**
```bash
# On companion:
journalctl -u NetworkManager -n 30 | grep -i dhcp

# On base station:
systemctl status dnsmasq
ss -ulnp | grep :67
```

**Fixes:**
- dnsmasq not running → `sudo systemctl start dnsmasq`
- dnsmasq not listening on correct interface → check config
- AP is providing DHCP (conflict) → disable AP DHCP in AP UI
- DHCP range exhausted → check `cat /var/lib/misc/dnsmasq.leases`

### Has IP but can't reach base station

**Symptoms:** Companion has 192.168.50.x address but `ping 192.168.50.1` fails.

**Checks:**
```bash
ip route show                  # Is gateway correct?
ip addr show wlan0             # Is IP in correct subnet?
```

**Fixes:**
- Client isolation is ON in AP → **disable it** (see ap_setup_checklist.md)
- Base station firewall blocking ICMP → check nftables/ufw
- Wrong subnet → check dnsmasq DHCP range matches base station IP

---

## RTCM / RTK Issues

### No RTCM bytes flowing (str2str shows 0 bytes)

**Symptoms:** `journalctl -u ntrip-client` shows connection errors or
zero byte count.

**Checks:**
```bash
# On companion:
systemctl status ntrip-client
journalctl -u ntrip-client -n 30

# On base station:
systemctl status rtkbase
ss -tlnp | grep 2101
curl -s http://192.168.50.1:2101/  # Should show NTRIP source table
```

**Common causes:**
- RTKBase not running or not generating RTCM
- Wrong NTRIP credentials (user/pass in heli.env)
- Wrong mount point name
- Firewall blocking port 2101 on base station
- Base GNSS receiver not connected or no satellite fix

**Fixes:**
- Restart RTKBase: `sudo systemctl restart rtkbase`
- Check credentials match between base caster config and companion env
- Check mount point name in RTKBase UI/config
- Open firewall: check nftables rules for port 2101

### RTCM flowing but no RTK fix

**Symptoms:** str2str shows bytes increasing, but GPS stays at "3D Fix"
(not Float or Fix).

**Checks:**
- Is RTCM reaching the LC29H? Check serial wiring.
- Is LC29H RTCM UART baud correct? Default 115200.
- Does LC29H have enough satellites? Need ≥5 common with base.
- Is base station position accurate? Survey-in must complete.
- Is the baseline too long? (should be < 10 km for RTK)

**Fixes:**
- Verify wiring: TX from companion → RX on LC29H RTCM input
- Check baud rate matches between str2str output and LC29H config
- Wait for more satellites (need clear sky view)
- Ensure survey-in completed on base (check RTKBase status)

### RTK Float but not Fix

**Symptoms:** GPS shows RTK Float, never reaches Fix.

**Causes:**
- Insufficient observation time (wait 1–5 minutes)
- Marginal sky view (partial obstruction)
- Long baseline to base station
- Multipath (reflections from buildings/metal)
- RTCM message interval too slow

**Fixes:**
- Move to better sky view
- Wait longer (Fix can take 1–10 minutes)
- Check base station is generating all required RTCM messages
  (1004/1005/1012 minimum for dual-constellation)

---

## MAVLink Issues

### No heartbeat from FC

**Symptoms:** Base station tools show no packets on heli's UDP port.

**Checks:**
```bash
# On companion:
systemctl status mavlink-router
journalctl -u mavlink-router -n 30
ls -la /dev/serial/by-id/        # Is FC serial device present?

# On base station:
./base-station/tools/show_mavlink_lastseen.sh
ss -ulnp | grep 1456
```

**Common causes:**
- FC not powered
- Wrong serial port in mavlink-routerd config
- Wrong baud rate (FC TELEM baud ≠ config)
- Serial cable disconnected or wiring error
- mavlink-routerd not running

**Fixes:**
- Power the FC
- Re-run `./companion/tools/detect_ports.sh` to find correct port
- Match baud rate to FC TELEM setting (usually 921600)
- Check wiring (TX/RX crossover)

### GCS doesn't see vehicle

**Symptoms:** GCS connected to UDP 14550 but no vehicle appears.

**Checks:**
```bash
# On base station:
systemctl status mavlink-hub
./base-station/tools/show_mavlink_lastseen.sh
ss -ulnp | grep 14550
```

**Fixes:**
- Start mavlink hub: `sudo systemctl start mavlink-hub`
- GCS connecting to wrong port → use 14550
- Firewall blocking 14550 → check rules
- No companions sending data → check companion mavlink-router

### GCS sees vehicle but commands don't work

**Symptoms:** Telemetry visible in GCS, but arm/disarm/mode changes
have no effect.

**Causes:**
- Unidirectional routing (hub not forwarding commands back)
- SYSID collision (command goes to wrong vehicle)
- FC is rejecting commands (arming checks, pre-arm failures)

**Fixes:**
- Verify mavlink-routerd hub config has bidirectional endpoints
- Check SYSID uniqueness (see identity_mapping.md)
- Check FC pre-arm messages in GCS HUD

### SYSID Collision

**Symptoms:** Two vehicles appear as one in GCS. Position jumps
erratically. Commands go to wrong vehicle.

**Diagnosis:**
```
In GCS MAVLink Inspector → HEARTBEAT
Look for: multiple source IPs with same system_id
```

**Fix:** Change SYSID_THISMAV on the conflicting FC. Each heli must
have a unique SYSID (11–20).

---

## Serial Port Issues

### /dev/serial/by-id/ is empty

**Symptoms:** No symlinks in /dev/serial/by-id/.

**Causes:**
- No USB-UART adapters connected
- Using onboard UART (doesn't appear in by-id)
- udev rules not loaded

**Fixes:**
- For USB-UART adapters: unplug and replug, check `dmesg | tail`
- For onboard UARTs: use `/dev/ttyS*` names (less stable but functional)
- Run `./companion/tools/detect_ports.sh` to find available ports

### Serial port name changed after reboot

**Symptoms:** mavlink-routerd or str2str fails to open serial port.

**Cause:** Using `/dev/ttyUSB0` which can change if multiple USB
devices are present and enumerate in different order.

**Fix:** Use `/dev/serial/by-id/` symlinks. If not available:
- Create custom udev rules to assign stable names
- Or use `detect_ports.sh` on each boot to update config

---

## Service Recovery

### Service keeps crashing (restart loop)

```bash
systemctl status <service-name>
journalctl -u <service-name> -n 50 --no-pager
```

**Common causes:**
- Configuration error (bad port, wrong IP, missing env file)
- Serial device not present
- Network not ready when service starts (add After=network-online.target)

### Restart all services (companion)

```bash
sudo systemctl restart ntrip-client mavlink-router
```

### Restart all services (base station)

```bash
sudo systemctl restart dnsmasq rtkbase mavlink-hub
```

### Full diagnostic dump

```bash
# Save to file for remote analysis:
./base-station/tools/status_dump.sh > /tmp/base_diag_$(date +%Y%m%d_%H%M%S).txt
# or
./companion/tools/status_dump.sh > /tmp/comp_diag_$(date +%Y%m%d_%H%M%S).txt
```
