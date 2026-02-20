#!/usr/bin/env bash
# Roban Swarm — Companion full status dump
set -euo pipefail

ENV_FILE="/etc/roban-swarm/heli.env"

echo "============================================"
echo "  Roban Swarm Companion Status"
echo "  $(date)"
echo "============================================"
echo

# Load heli env if available
if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
    echo "Heli ID: ${HELI_ID:-unknown}"
    echo "Base IP: ${BASE_IP:-unknown}"
    echo "UDP Port: ${UDP_PORT:-unknown}"
else
    echo "WARNING: $ENV_FILE not found — companion not configured"
fi
echo

# WiFi status
echo "--- WiFi ---"
if command -v nmcli &>/dev/null; then
    nmcli -t -f DEVICE,STATE,CONNECTION dev status 2>/dev/null | grep wlan | sed 's/^/  /'
    echo
    # Show IP
    ip -4 addr show wlan0 2>/dev/null | grep "inet " | sed 's/^/  /' || echo "  (no IP on wlan0)"
else
    ip link show wlan0 2>/dev/null | head -2 | sed 's/^/  /' || echo "  (wlan0 not found)"
fi
echo

# Connectivity
echo "--- Connectivity ---"
if [ -n "${BASE_IP:-}" ]; then
    if ping -c 1 -W 2 "$BASE_IP" &>/dev/null; then
        echo "  Base station ($BASE_IP): REACHABLE"
    else
        echo "  Base station ($BASE_IP): UNREACHABLE"
    fi
else
    echo "  (BASE_IP not set)"
fi
echo

# Serial ports
echo "--- Serial Ports ---"
echo "  FC_SERIAL: ${FC_SERIAL:-not set}"
if [ -n "${FC_SERIAL:-}" ] && [ -e "${FC_SERIAL:-}" ]; then
    echo "    Status: EXISTS"
else
    echo "    Status: NOT FOUND"
fi
echo "  GNSS_RTCM_SERIAL: ${GNSS_RTCM_SERIAL:-not set}"
if [ -n "${GNSS_RTCM_SERIAL:-}" ] && [ -e "${GNSS_RTCM_SERIAL:-}" ]; then
    echo "    Status: EXISTS"
else
    echo "    Status: NOT FOUND"
fi
echo

# Services
echo "--- Services ---"
for svc in ntrip-client mavlink-router watchdog; do
    status=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
    printf "  %-20s active=%-12s enabled=%s\n" "$svc" "$status" "$enabled"
done
echo

# NTRIP client stats
echo "--- NTRIP Client (str2str) ---"
if systemctl is-active ntrip-client &>/dev/null; then
    echo "  Status: running"
    journalctl -u ntrip-client --no-pager -n 5 2>/dev/null | sed 's/^/  /' || true
else
    echo "  Status: not running"
fi
echo

# MAVLink router stats
echo "--- MAVLink Router ---"
if systemctl is-active mavlink-router &>/dev/null; then
    echo "  Status: running"
    journalctl -u mavlink-router --no-pager -n 5 2>/dev/null | sed 's/^/  /' || true
else
    echo "  Status: not running"
fi
echo

# System info
echo "--- System ---"
echo "  Uptime: $(uptime -p 2>/dev/null || uptime)"
echo "  Memory: $(free -h 2>/dev/null | grep Mem | awk '{print $3 "/" $2}' || echo 'unknown')"
echo "  Disk: $(df -h / 2>/dev/null | tail -1 | awk '{print $3 "/" $2 " (" $5 " used)"}' || echo 'unknown')"
echo "  Temp: $(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null | awk '{printf "%.1f°C", $1/1000}' || echo 'unknown')"
echo

echo "============================================"
echo "  Status dump complete"
echo "============================================"
