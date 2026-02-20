#!/usr/bin/env bash
# Roban Swarm — Show last MAVLink packet time per heli port
set -euo pipefail

echo "Roban Swarm — MAVLink Last Seen"
echo "================================"
echo

printf "%-6s %-8s %-12s %-10s\n" "Heli" "Port" "Status" "Packets"
printf "%-6s %-8s %-12s %-10s\n" "----" "------" "----------" "--------"

for i in $(seq 0 9); do
    heli_num=$((i + 1))
    heli_id=$(printf "H%02d" "$heli_num")
    port=$((14560 + i))

    # Check if port has active connections using ss
    conn_info=$(ss -unp 2>/dev/null | grep ":${port}" || true)

    if [ -n "$conn_info" ]; then
        # Count recv-q packets as activity indicator
        recv_q=$(echo "$conn_info" | awk '{sum += $2} END {print sum+0}')
        status="ACTIVE"
    else
        recv_q="0"
        # Check if port is at least listening
        if ss -ulnp 2>/dev/null | grep -q ":${port}"; then
            status="LISTENING"
        else
            status="DOWN"
        fi
    fi

    printf "%-6s %-8s %-12s %-10s\n" "$heli_id" "$port" "$status" "$recv_q"
done

echo
echo "Hub service:"
systemctl is-active mavlink-hub 2>/dev/null || echo "  mavlink-hub not running"

# Show GCS endpoint status
echo
echo "GCS endpoint (14550):"
gcs_info=$(ss -unp 2>/dev/null | grep ":14550" || true)
if [ -n "$gcs_info" ]; then
    echo "  ACTIVE — GCS connected"
else
    if ss -ulnp 2>/dev/null | grep -q ":14550"; then
        echo "  LISTENING — waiting for GCS"
    else
        echo "  DOWN — hub not running?"
    fi
fi
