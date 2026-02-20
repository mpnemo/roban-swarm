#!/usr/bin/env bash
# Roban Swarm — Base station full status dump
set -euo pipefail

echo "============================================"
echo "  Roban Swarm Base Station Status"
echo "  $(date)"
echo "============================================"
echo

# Network
echo "--- Network ---"
ip -4 addr show scope global 2>/dev/null || echo "  (no global addresses)"
echo
echo "Default route:"
ip route show default 2>/dev/null || echo "  (no default route — expected for isolated network)"
echo

# DHCP leases
echo "--- DHCP Leases ---"
if [ -f /var/lib/misc/dnsmasq.leases ]; then
    if [ -s /var/lib/misc/dnsmasq.leases ]; then
        printf "  %-18s %-16s %s\n" "MAC" "IP" "Hostname"
        while read -r _ts mac ip hostname _cid; do
            printf "  %-18s %-16s %s\n" "$mac" "$ip" "$hostname"
        done < /var/lib/misc/dnsmasq.leases
    else
        echo "  (no active leases)"
    fi
else
    echo "  (lease file not found)"
fi
echo

# Listening ports
echo "--- Listening Ports ---"
ss -tlnp 2>/dev/null | grep -E '(2101|53|22)' || true
ss -ulnp 2>/dev/null | grep -E '(14550|1456[0-9]|67|123|53)' || true
echo

# Services
echo "--- Service Status ---"
for svc in dnsmasq mavlink-hub rtkbase chrony; do
    status=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
    printf "  %-20s active=%-12s enabled=%s\n" "$svc" "$status" "$enabled"
done
echo

# Recent logs (last 5 lines per service)
echo "--- Recent Logs ---"
for svc in dnsmasq mavlink-hub rtkbase; do
    echo "  [$svc]"
    journalctl -u "$svc" --no-pager -n 5 2>/dev/null | sed 's/^/    /' || echo "    (no logs)"
    echo
done

# Firewall
echo "--- Firewall ---"
if command -v nft &>/dev/null; then
    nft list ruleset 2>/dev/null | head -30 || echo "  (nft not configured)"
elif command -v ufw &>/dev/null; then
    ufw status 2>/dev/null || echo "  (ufw not configured)"
else
    echo "  (no firewall tool found)"
fi
echo

echo "============================================"
echo "  Status dump complete"
echo "============================================"
