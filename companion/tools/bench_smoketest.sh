#!/usr/bin/env bash
# Roban Swarm — Bench Smoketest (pre-flight checks)
# Run this BEFORE flight, props off, to verify all systems.
set -euo pipefail

ENV_FILE="/etc/roban-swarm/heli.env"
PASS=0
FAIL=0
WARN=0

pass() { echo "  [PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $*"; FAIL=$((FAIL + 1)); }
warn() { echo "  [WARN] $*"; WARN=$((WARN + 1)); }

echo "============================================"
echo "  Roban Swarm Bench Smoketest"
echo "  $(date)"
echo "============================================"
echo

# Check env file
echo "1. Configuration"
if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$ENV_FILE"
    pass "heli.env loaded (HELI_ID=${HELI_ID:-?})"
else
    fail "heli.env not found at $ENV_FILE"
    echo "  Cannot continue without configuration."
    exit 1
fi

# Check WiFi
echo
echo "2. WiFi Connection"
if nmcli -t -f STATE general status 2>/dev/null | grep -q "connected"; then
    pass "NetworkManager connected"
else
    fail "NetworkManager not connected"
fi

wifi_ip=$(ip -4 addr show wlan0 2>/dev/null | grep -oP 'inet \K[\d.]+' || true)
if [ -n "$wifi_ip" ]; then
    pass "wlan0 has IP: $wifi_ip"
else
    fail "wlan0 has no IP address"
fi

# Check connectivity to base
echo
echo "3. Base Station Connectivity"
if ping -c 1 -W 3 "${BASE_IP}" &>/dev/null; then
    pass "Base station reachable at ${BASE_IP}"
else
    fail "Cannot reach base station at ${BASE_IP}"
fi

# Check NTRIP caster reachable
if command -v curl &>/dev/null; then
    if curl -sf --connect-timeout 3 "http://${BASE_IP}:${NTRIP_PORT}/" &>/dev/null; then
        pass "NTRIP caster reachable at ${BASE_IP}:${NTRIP_PORT}"
    else
        fail "NTRIP caster not reachable at ${BASE_IP}:${NTRIP_PORT}"
    fi
else
    if timeout 3 bash -c "echo > /dev/tcp/${BASE_IP}/${NTRIP_PORT}" 2>/dev/null; then
        pass "NTRIP port ${NTRIP_PORT} open on base"
    else
        fail "NTRIP port ${NTRIP_PORT} not reachable on base"
    fi
fi

# Check serial ports
echo
echo "4. Serial Ports"
if [ -e "${FC_SERIAL:-/dev/null}" ]; then
    pass "FC serial exists: ${FC_SERIAL}"
else
    fail "FC serial not found: ${FC_SERIAL:-not set}"
fi

if [ -e "${GNSS_RTCM_SERIAL:-/dev/null}" ]; then
    pass "GNSS RTCM serial exists: ${GNSS_RTCM_SERIAL}"
else
    fail "GNSS RTCM serial not found: ${GNSS_RTCM_SERIAL:-not set}"
fi

# Check services
echo
echo "5. Services"
for svc in ntrip-client mavlink-router; do
    if systemctl is-active "$svc" &>/dev/null; then
        pass "$svc is running"
    else
        fail "$svc is NOT running"
    fi
done

if systemctl is-active watchdog &>/dev/null; then
    pass "watchdog is running"
else
    warn "watchdog is not running (optional)"
fi

# Check NTRIP client bytes
echo
echo "6. RTCM Data Flow"
ntrip_log=$(journalctl -u ntrip-client --no-pager -n 20 2>/dev/null || true)
if echo "$ntrip_log" | grep -qi "byte\|recv\|read"; then
    pass "NTRIP client shows data activity"
else
    warn "Cannot confirm RTCM bytes flowing (check logs manually)"
fi

# Check MAVLink heartbeat
echo
echo "7. MAVLink Heartbeat"
mavlink_log=$(journalctl -u mavlink-router --no-pager -n 20 2>/dev/null || true)
if echo "$mavlink_log" | grep -qi "heartbeat\|connected\|endpoint"; then
    pass "MAVLink router shows activity"
else
    warn "Cannot confirm MAVLink heartbeat (check logs manually)"
fi

# Summary
echo
echo "============================================"
echo "  Smoketest Summary"
echo "  PASS: $PASS  FAIL: $FAIL  WARN: $WARN"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
    echo
    echo "  *** FAILURES DETECTED — DO NOT FLY ***"
    echo "  Fix all FAIL items before proceeding."
    exit 1
elif [ "$WARN" -gt 0 ]; then
    echo
    echo "  Warnings present — review before flight."
    exit 0
else
    echo
    echo "  All checks passed."
    exit 0
fi
