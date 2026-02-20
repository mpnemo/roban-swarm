# Identity Mapping

## Overview

Every helicopter has a deterministic identity chain. This mapping must
be established **before** field deployment.

```
Companion MAC address
    → DHCP reservation (dnsmasq)
        → Fixed IP address
            → UDP port (MAVLink)
                → ArduPilot SYSID_THISMAV
```

If any link in this chain is wrong or duplicated, multi-vehicle
operations break: GCS merges telemetry, commands go to wrong vehicles,
or vehicles become unreachable.

## Master Identity Table

Fill in MAC addresses as companions are provisioned. All other fields
are derived.

| Heli ID | Companion MAC | Reserved IP | UDP Port | SYSID | Status |
|---------|--------------|-------------|----------|-------|--------|
| Heli01 | `__:__:__:__:__:__` | 192.168.50.101 | 14560 | 11 | [ ] Verified |
| Heli02 | `__:__:__:__:__:__` | 192.168.50.102 | 14561 | 12 | [ ] Verified |
| Heli03 | `__:__:__:__:__:__` | 192.168.50.103 | 14562 | 13 | [ ] Verified |
| Heli04 | `__:__:__:__:__:__` | 192.168.50.104 | 14563 | 14 | [ ] Verified |
| Heli05 | `__:__:__:__:__:__` | 192.168.50.105 | 14564 | 15 | [ ] Verified |
| Heli06 | `__:__:__:__:__:__` | 192.168.50.106 | 14565 | 16 | [ ] Verified |
| Heli07 | `__:__:__:__:__:__` | 192.168.50.107 | 14566 | 17 | [ ] Verified |
| Heli08 | `__:__:__:__:__:__` | 192.168.50.108 | 14567 | 18 | [ ] Verified |
| Heli09 | `__:__:__:__:__:__` | 192.168.50.109 | 14568 | 19 | [ ] Verified |
| Heli10 | `__:__:__:__:__:__` | 192.168.50.110 | 14569 | 20 | [ ] Verified |

## Derivation Rules

Given a Heli ID `NN` (01–10):

```
IP address:    192.168.50.(100 + NN)
UDP port:      14559 + NN     (i.e., 14560 for NN=01)
SYSID:         10 + NN        (i.e., 11 for NN=01)
```

## Procedure: Recording MAC Addresses

### Step 1: Boot companion and get MAC

```bash
# On each companion (Orange Pi Zero):
ip link show wlan0 | grep ether
# Example output: link/ether aa:bb:cc:dd:ee:ff
```

Or remotely from the base station after companion connects:

```bash
# On base station:
cat /var/lib/misc/dnsmasq.leases
# Shows: timestamp MAC IP hostname clientid
```

### Step 2: Label the companion

Physically label each Orange Pi Zero with its Heli ID (e.g., sticker
"H01"). The MAC is burned in and doesn't change.

### Step 3: Add DHCP reservation

Edit `/etc/dnsmasq.d/roban-swarm.conf` on the base station:

```
dhcp-host=aa:bb:cc:dd:ee:ff,192.168.50.101,heli01
dhcp-host=aa:bb:cc:dd:ee:11,192.168.50.102,heli02
# ... for all 10
```

Then restart dnsmasq:
```bash
sudo systemctl restart dnsmasq
```

### Step 4: Run install on companion

```bash
sudo ./companion/install.sh --heli-id 01
```

This configures the companion's services with the correct UDP port
and other derived values.

### Step 5: Set ArduPilot SYSID

In GCS or via MAVProxy:
```
param set SYSID_THISMAV 11
```

### Step 6: Verify end-to-end

```bash
# On base station:
./base-station/tools/list_clients.sh
# Should show Heli01 at 192.168.50.101

./base-station/tools/show_mavlink_lastseen.sh
# Should show packets on port 14560

# In GCS:
# Vehicle with SYSID 11 should appear
```

## Uniqueness Enforcement

### Check for duplicate SYSIDs

In GCS, open the MAVLink inspector. Look at HEARTBEAT messages. If two
different source IPs produce HEARTBEATs with the same SYSID, you have
a collision. Fix immediately.

### Check for duplicate MACs

```bash
# On base station:
cat /var/lib/misc/dnsmasq.leases | awk '{print $2}' | sort | uniq -d
# Should produce no output (no duplicate MACs)
```

### Check for duplicate IPs

```bash
# On base station:
cat /var/lib/misc/dnsmasq.leases | awk '{print $3}' | sort | uniq -d
# Should produce no output
```

## Replacing a Companion Board

If an Orange Pi Zero fails and is replaced:

1. Record new board's MAC address
2. Update dnsmasq reservation (replace old MAC, keep same IP)
3. Run `companion/install.sh --heli-id NN` on new board
4. Verify end-to-end
5. Update this identity table
