#!/usr/bin/env bash
# Roban Swarm — List DHCP clients and associated heli IDs
set -euo pipefail

LEASE_FILE="/var/lib/misc/dnsmasq.leases"
DNSMASQ_CONF="/etc/dnsmasq.d/roban-swarm.conf"

echo "Roban Swarm — DHCP Client List"
echo "==============================="
echo

if [ ! -f "$LEASE_FILE" ]; then
    echo "ERROR: Lease file not found: $LEASE_FILE"
    echo "Is dnsmasq running?"
    exit 1
fi

if [ ! -s "$LEASE_FILE" ]; then
    echo "No active DHCP leases."
    exit 0
fi

printf "%-6s %-18s %-16s %-12s %-8s\n" "Heli" "MAC" "IP" "Hostname" "Port"
printf "%-6s %-18s %-16s %-12s %-8s\n" "----" "------------------" "----------------" "------------" "--------"

while read -r _ts mac ip hostname _cid; do
    # Derive heli ID from IP if in reservation range
    last_octet="${ip##*.}"
    if [ "$last_octet" -ge 101 ] && [ "$last_octet" -le 110 ] 2>/dev/null; then
        heli_num=$((last_octet - 100))
        heli_id=$(printf "H%02d" "$heli_num")
        udp_port=$((14559 + heli_num))
    else
        heli_id="--"
        udp_port="--"
    fi
    printf "%-6s %-18s %-16s %-12s %-8s\n" "$heli_id" "$mac" "$ip" "$hostname" "$udp_port"
done < "$LEASE_FILE"

echo
total=$(wc -l < "$LEASE_FILE")
echo "Total active leases: $total"
