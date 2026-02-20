#!/usr/bin/env bash
# Roban Swarm — Reconfigure heli ID on an already-installed companion
# Usage: sudo ./set_heli_id.sh <01-10>
set -euo pipefail

ENV_FILE="/etc/roban-swarm/heli.env"
MAVLINK_CONF="/etc/mavlink-router/main.conf"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: Must run as root (sudo)." >&2
    exit 1
fi

if [ $# -ne 1 ]; then
    echo "Usage: $0 <heli-id>"
    echo "  heli-id: 01 through 10"
    exit 1
fi

HELI_ID="$1"

# Validate heli ID
if ! echo "$HELI_ID" | grep -qE '^(0[1-9]|10)$'; then
    echo "ERROR: Heli ID must be 01 through 10. Got: $HELI_ID" >&2
    exit 1
fi

HELI_NUM=$((10#$HELI_ID))
UDP_PORT=$((14559 + HELI_NUM))
EXPECTED_IP="192.168.50.$((100 + HELI_NUM))"
SYSID=$((10 + HELI_NUM))

echo "Reconfiguring companion for Heli $HELI_ID"
echo "  UDP port:    $UDP_PORT"
echo "  Expected IP: $EXPECTED_IP"
echo "  SYSID:       $SYSID"
echo

# Update heli.env
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Run install.sh first." >&2
    exit 1
fi

# Update HELI_ID
sed -i "s/^HELI_ID=.*/HELI_ID=$HELI_ID/" "$ENV_FILE"

# Update UDP_PORT
sed -i "s/^UDP_PORT=.*/UDP_PORT=$UDP_PORT/" "$ENV_FILE"

echo "Updated $ENV_FILE"

# Update mavlink-router config
if [ -f "$MAVLINK_CONF" ]; then
    sed -i "s/^Port = .*/Port = $UDP_PORT/" "$MAVLINK_CONF"
    echo "Updated $MAVLINK_CONF (Port = $UDP_PORT)"
fi

# Restart services
echo "Restarting services..."
systemctl restart mavlink-router 2>/dev/null || echo "  mavlink-router restart failed"
systemctl restart ntrip-client 2>/dev/null || echo "  ntrip-client restart failed"

echo
echo "Done. Heli ID is now $HELI_ID."
echo
echo "Reminder:"
echo "  - Update DHCP reservation on base station for this MAC"
echo "  - Set SYSID_THISMAV=$SYSID on the flight controller"
echo "  - Verify with: ./companion/tools/bench_smoketest.sh"
