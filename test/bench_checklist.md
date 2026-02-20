# Bench Checklist

**Mandatory before any flight. Props OFF.**

## Prerequisites
- Base station running with all services active
- AP powered and broadcasting RTK-FIELD
- At least one companion installed and configured
- FC powered (props removed!)

## Per-Companion Checks

Run for each helicopter companion:

### 1. WiFi Association
- [ ] Companion joins RTK-FIELD WiFi network
- [ ] Companion receives correct DHCP reservation IP
  ```bash
  # On companion:
  ip addr show wlan0
  # Expected: 192.168.50.10X (X = heli number)
  ```

### 2. Base Station Reachability
- [ ] Companion can ping base station
  ```bash
  ping -c 3 192.168.50.1
  ```

### 3. RTCM Data Flow
- [ ] ntrip-client service is running
  ```bash
  systemctl status ntrip-client
  ```
- [ ] RTCM bytes increasing (wait 10 seconds between checks)
  ```bash
  journalctl -u ntrip-client -f
  # Look for byte count or data transfer indication
  ```

### 4. MAVLink Heartbeat
- [ ] mavlink-router service is running
  ```bash
  systemctl status mavlink-router
  ```
- [ ] Base station sees heartbeat on expected UDP port
  ```bash
  # On base station:
  ./base-station/tools/show_mavlink_lastseen.sh
  ```

### 5. GCS Verification
- [ ] GCS (connected to base:14550) shows vehicle
- [ ] Vehicle SYSID is correct (11–20 per assignment)
- [ ] Telemetry data is live (attitude, GPS, battery)

### 6. Command Path (bidirectional)
- [ ] From GCS, send arm command → FC arms (or shows pre-arm failure, which still confirms command receipt)
- [ ] From GCS, send disarm command → FC disarms
- [ ] Mode change from GCS is reflected on FC

### 7. GPS / RTK Status
- [ ] GPS shows satellites (> 0)
- [ ] Fix type progresses: 3D Fix → RTK Float → RTK Fix
- [ ] Horizontal accuracy improves (check GPS_RAW_INT.h_acc)

## Multi-Vehicle Check (when all 10 are set up)

- [ ] All 10 companions connected to WiFi simultaneously
- [ ] All 10 appear in GCS with unique SYSIDs
- [ ] No SYSID collisions (each vehicle is distinct)
- [ ] Commands to Heli01 only affect Heli01 (not others)
- [ ] All 10 show RTCM bytes flowing

## Automated Smoketest

Run on each companion:
```bash
./companion/tools/bench_smoketest.sh
```
All checks must PASS before flight.

## Sign-off

| Heli | WiFi | DHCP IP | RTCM | MAVLink | SYSID | GCS | Tester | Date |
|------|------|---------|------|---------|-------|-----|--------|------|
| H01 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H02 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H03 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H04 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H05 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H06 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H07 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H08 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H09 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
| H10 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | | |
