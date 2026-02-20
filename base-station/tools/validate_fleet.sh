#!/usr/bin/env bash
# Roban Swarm — Pre-deployment fleet validation
# Run on the base station before field deployment to verify all 10
# helis are configured and reachable.
set -euo pipefail

DNSMASQ_CONF="/etc/dnsmasq.d/roban-swarm.conf"
LEASE_FILE="/var/lib/misc/dnsmasq.leases"
PASS=0
FAIL=0
WARN=0

pass() { echo "  [PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $*"; FAIL=$((FAIL + 1)); }
warn() { echo "  [WARN] $*"; WARN=$((WARN + 1)); }

echo "============================================"
echo "  Roban Swarm Fleet Validation"
echo "  $(date)"
echo "============================================"
echo

# --- 1. DHCP Reservations ---
echo "1. DHCP Reservations"
if [ -f "$DNSMASQ_CONF" ]; then
    active_reservations=$(grep -c "^dhcp-host=" "$DNSMASQ_CONF" 2>/dev/null || echo "0")
    if [ "$active_reservations" -ge 10 ]; then
        pass "$active_reservations DHCP reservations configured"
    elif [ "$active_reservations" -gt 0 ]; then
        warn "$active_reservations reservations (need 10)"
    else
        fail "No DHCP reservations configured"
    fi

    # Check for duplicate MACs
    dupes=$(grep "^dhcp-host=" "$DNSMASQ_CONF" | cut -d, -f1 | sort | uniq -d)
    if [ -z "$dupes" ]; then
        pass "No duplicate MAC addresses"
    else
        fail "Duplicate MACs found: $dupes"
    fi

    # Check for duplicate IPs
    ip_dupes=$(grep "^dhcp-host=" "$DNSMASQ_CONF" | cut -d, -f2 | sort | uniq -d)
    if [ -z "$ip_dupes" ]; then
        pass "No duplicate IP reservations"
    else
        fail "Duplicate IPs found: $ip_dupes"
    fi
else
    fail "dnsmasq config not found: $DNSMASQ_CONF"
fi
echo

# --- 2. Base Services ---
echo "2. Base Station Services"
for svc in dnsmasq mavlink-hub chrony; do
    if systemctl is-active "$svc" &>/dev/null; then
        pass "$svc is running"
    else
        fail "$svc is NOT running"
    fi
done

# RTKBase may not be enabled yet
if systemctl is-active rtkbase &>/dev/null; then
    pass "rtkbase is running"
else
    warn "rtkbase is not running (enable after configuring)"
fi
echo

# --- 3. NTRIP Caster ---
echo "3. NTRIP Caster"
if ss -tlnp 2>/dev/null | grep -q ":2101"; then
    pass "NTRIP caster listening on port 2101"
else
    fail "NTRIP caster NOT listening on port 2101"
fi
echo

# --- 4. MAVLink Hub Ports ---
echo "4. MAVLink Hub Ports"
hub_ports_ok=true
for port in 14550 14560 14561 14562 14563 14564 14565 14566 14567 14568 14569; do
    if ss -ulnp 2>/dev/null | grep -q ":${port}"; then
        : # ok
    else
        fail "MAVLink hub not listening on UDP $port"
        hub_ports_ok=false
    fi
done
if $hub_ports_ok; then
    pass "All MAVLink hub ports listening (14550, 14560-14569)"
fi
echo

# --- 5. Companion Reachability ---
echo "5. Companion Reachability (ping)"
reachable=0
for i in $(seq 1 10); do
    ip="192.168.50.$((100 + i))"
    heli=$(printf "H%02d" "$i")
    if ping -c 1 -W 2 "$ip" &>/dev/null; then
        pass "$heli ($ip) reachable"
        reachable=$((reachable + 1))
    else
        warn "$heli ($ip) not reachable (may not be powered)"
    fi
done
echo "  $reachable/10 companions reachable"
echo

# --- 6. DHCP Lease Check ---
echo "6. Active DHCP Leases"
if [ -f "$LEASE_FILE" ] && [ -s "$LEASE_FILE" ]; then
    lease_count=$(wc -l < "$LEASE_FILE")
    pass "$lease_count active DHCP leases"
    # Show heli-range leases
    while read -r _ts mac ip hostname _cid; do
        last_octet="${ip##*.}"
        if [ "$last_octet" -ge 101 ] && [ "$last_octet" -le 110 ] 2>/dev/null; then
            heli_num=$((last_octet - 100))
            heli_id=$(printf "H%02d" "$heli_num")
            echo "    $heli_id: $ip ($mac) $hostname"
        fi
    done < "$LEASE_FILE"
else
    warn "No active DHCP leases (companions may not be powered)"
fi
echo

# --- 7. MAVLink Activity ---
echo "7. MAVLink Activity"
active_helis=0
for i in $(seq 0 9); do
    port=$((14560 + i))
    heli_id=$(printf "H%02d" "$((i + 1))")
    if ss -unp 2>/dev/null | grep -q ":${port}"; then
        active_helis=$((active_helis + 1))
    fi
done
if [ "$active_helis" -gt 0 ]; then
    pass "$active_helis/10 helis sending MAVLink data"
else
    warn "No MAVLink data detected (companions/FCs may not be powered)"
fi
echo

# --- Summary ---
echo "============================================"
echo "  Fleet Validation Summary"
echo "  PASS: $PASS  FAIL: $FAIL  WARN: $WARN"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
    echo
    echo "  *** FAILURES DETECTED ***"
    echo "  Fix all FAIL items before field deployment."
    exit 1
elif [ "$WARN" -gt 0 ]; then
    echo
    echo "  Warnings present — review before deployment."
    echo "  (Warnings for unpowered companions are expected during setup.)"
    exit 0
else
    echo
    echo "  Fleet validated. Ready for field deployment."
    exit 0
fi
