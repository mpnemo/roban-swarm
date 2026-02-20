#!/usr/bin/env bash
# Roban Swarm — Show active NTRIP client count
set -euo pipefail

echo "Roban Swarm — RTK / NTRIP Status"
echo "================================="
echo

# Check RTKBase service
echo "RTKBase service:"
rtkbase_status=$(systemctl is-active rtkbase 2>/dev/null || echo "not-found")
echo "  Status: $rtkbase_status"
echo

# Check NTRIP caster port
echo "NTRIP caster (port 2101):"
if ss -tlnp 2>/dev/null | grep -q ":2101"; then
    echo "  Listening: YES"
else
    echo "  Listening: NO — caster not running?"
fi
echo

# Count active NTRIP connections
echo "Active NTRIP clients:"
client_count=$(ss -tnp 2>/dev/null | grep ":2101" | grep -c "ESTAB" || echo "0")
echo "  Connected: $client_count"
echo

# Show individual connections
if [ "$client_count" -gt 0 ]; then
    echo "Client details:"
    ss -tnp 2>/dev/null | grep ":2101" | grep "ESTAB" | while read -r line; do
        peer=$(echo "$line" | awk '{print $5}')
        peer_ip="${peer%:*}"
        # Try to resolve heli ID from IP
        last_octet="${peer_ip##*.}"
        if [ "$last_octet" -ge 101 ] && [ "$last_octet" -le 110 ] 2>/dev/null; then
            heli_num=$((last_octet - 100))
            heli_id=$(printf "Heli%02d" "$heli_num")
        else
            heli_id="unknown"
        fi
        echo "  $peer_ip ($heli_id)"
    done
    echo
fi

# Recent RTKBase logs
echo "Recent RTKBase logs:"
journalctl -u rtkbase --no-pager -n 10 2>/dev/null | sed 's/^/  /' || echo "  (no logs available)"
