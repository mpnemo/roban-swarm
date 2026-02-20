# Soak Test

**2–4 hour continuous run to validate reliability.**

## Objective

Verify that all services remain stable over an extended period with no
manual intervention required. Identify intermittent failures, memory
leaks, reconnect issues, and thermal problems.

## Setup

- Base station + AP running
- All 10 companions powered and connected (or as many as available)
- FC powered on each heli (props off for bench soak)
- GCS connected and logging

## Monitoring

### Start Monitoring
```bash
# On base station, log status every 5 minutes:
while true; do
    echo "=== $(date) ===" >> /tmp/soak_base.log
    ./base-station/tools/status_dump.sh >> /tmp/soak_base.log 2>&1
    sleep 300
done &
echo "Base monitoring PID: $!"

# On each companion:
while true; do
    echo "=== $(date) ===" >> /tmp/soak_companion.log
    ./companion/tools/status_dump.sh >> /tmp/soak_companion.log 2>&1
    sleep 300
done &
echo "Companion monitoring PID: $!"
```

## Acceptance Criteria

### Service Stability (must pass)
- [ ] No service crashes over 2 hours
- [ ] All services remain active (ntrip-client, mavlink-router, dnsmasq, mavlink-hub, rtkbase)
- [ ] No systemd restart loops (check `systemctl show -p NRestarts <service>`)

### Network Stability (must pass)
- [ ] All companions maintain WiFi connection for full duration
- [ ] DHCP leases renewed without disruption
- [ ] No IP address conflicts

### RTCM Stability (must pass)
- [ ] RTCM bytes continuously increasing on all companions
- [ ] No prolonged NTRIP disconnections (> 30 seconds)
- [ ] RTK Fix maintained (occasional Float acceptable, standalone is not)

### MAVLink Stability (must pass)
- [ ] MAVLink heartbeats continuous from all helis
- [ ] No data gaps > 5 seconds in GCS
- [ ] GCS shows all vehicles for full duration

### Reconnect Tests

#### AP Power Cycle
1. [ ] Power off AP for 30 seconds
2. [ ] Power on AP
3. [ ] All companions reconnect within 60 seconds
4. [ ] NTRIP and MAVLink resume within 90 seconds

#### Base Station Reboot
1. [ ] Reboot base station: `sudo reboot`
2. [ ] Base station services start automatically
3. [ ] Companions reconnect and resume
4. [ ] Time to full recovery: _____ seconds

#### Single Companion Reboot
1. [ ] Reboot one companion
2. [ ] Services start automatically
3. [ ] WiFi connects, DHCP received
4. [ ] NTRIP and MAVLink resume
5. [ ] Other companions unaffected
6. [ ] Time to recovery: _____ seconds

### Thermal (recommended)
- [ ] Base station CPU temperature stable (not throttling)
- [ ] Companion CPU temperature stable
  ```bash
  cat /sys/class/thermal/thermal_zone0/temp
  # Divide by 1000 for Celsius
  ```
- [ ] No thermal shutdowns

### Memory (recommended)
- [ ] No significant memory growth over 2 hours
  ```bash
  free -h
  ```
- [ ] No OOM kills in dmesg

## Results Template

| Metric | Start | 1h | 2h | 3h | 4h |
|--------|-------|-----|-----|-----|-----|
| Companions connected | /10 | /10 | /10 | /10 | /10 |
| RTK Fix count | /10 | /10 | /10 | /10 | /10 |
| Service restarts (total) | 0 | | | | |
| WiFi disconnections | 0 | | | | |
| Base CPU temp (C) | | | | | |
| Companion CPU temp (C) | | | | | |
| Base memory used (MB) | | | | | |
| Notes | | | | | |

## Sign-off

- [ ] All "must pass" criteria met
- [ ] Reconnect tests completed
- [ ] Results recorded above
- [ ] System approved for field deployment

Tester: _____________  Date: _____________
