#!/usr/bin/env bash
# Roban Swarm — Companion Install Script
# Usage: sudo ./companion/install.sh --heli-id <01-10>
#
# Installs and configures all companion services:
#   - WiFi (NetworkManager)
#   - NTRIP client (str2str from RTKLIB)
#   - MAVLink router (mavlink-routerd)
#   - Watchdog (optional)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SWARM_CONF_DIR="/etc/roban-swarm"
SWARM_OPT_DIR="/opt/roban-swarm"

# --- Helpers ---
info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

# --- Parse arguments ---
HELI_ID=""

while [ $# -gt 0 ]; do
    case "$1" in
        --heli-id)
            HELI_ID="$2"
            shift 2
            ;;
        --heli-id=*)
            HELI_ID="${1#*=}"
            shift
            ;;
        *)
            error "Unknown argument: $1\nUsage: $0 --heli-id <01-10>"
            ;;
    esac
done

if [ -z "$HELI_ID" ]; then
    error "Missing required argument: --heli-id\nUsage: $0 --heli-id <01-10>"
fi

# Validate heli ID
if ! echo "$HELI_ID" | grep -qE '^(0[1-9]|10)$'; then
    error "Heli ID must be 01 through 10. Got: $HELI_ID"
fi

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (sudo)."
fi

if [ ! -f /etc/os-release ]; then
    error "Cannot determine OS."
fi

. /etc/os-release
info "Starting Roban Swarm companion install (Heli $HELI_ID)..."
info "OS: $PRETTY_NAME"

# --- Derive values from heli ID ---
HELI_NUM=$((10#$HELI_ID))
UDP_PORT=$((14559 + HELI_NUM))
CMD_PORT=$((14659 + HELI_NUM))
EXPECTED_IP="192.168.50.$((100 + HELI_NUM))"
SYSID=$((10 + HELI_NUM))
BASE_IP="192.168.50.1"

info "Heli $HELI_ID → IP=$EXPECTED_IP, Telemetry=$UDP_PORT, Cmd=$CMD_PORT, SYSID=$SYSID"

# --- Install packages ---
info "Updating apt and installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    network-manager \
    rtklib \
    chrony \
    curl \
    socat \
    jq \
    net-tools \
    usbutils \
    > /dev/null 2>&1 || {
    # rtklib may not be in default repos — try alternatives
    warn "Some packages failed. Trying alternative install..."
    apt-get install -y -qq \
        network-manager \
        chrony \
        curl \
        socat \
        net-tools \
        usbutils \
        > /dev/null 2>&1
}

# Check if str2str is available
if ! command -v str2str &>/dev/null; then
    info "str2str not found in packages, building RTKLIB from source..."
    BUILD_DIR=$(mktemp -d)
    apt-get install -y -qq gcc make > /dev/null 2>&1
    git clone --depth 1 https://github.com/tomojitakasu/RTKLIB.git "$BUILD_DIR/rtklib" 2>/dev/null
    cd "$BUILD_DIR/rtklib/app/str2str/gcc"
    make > /dev/null 2>&1
    cp str2str /usr/local/bin/
    cd "$REPO_DIR"
    rm -rf "$BUILD_DIR"
    info "str2str installed: $(which str2str)"
fi

# --- Install mavlink-router ---
if ! command -v mavlink-routerd &>/dev/null; then
    info "Installing mavlink-router from source..."
    apt-get install -y -qq \
        gcc \
        g++ \
        meson \
        ninja-build \
        pkg-config \
        git \
        > /dev/null 2>&1

    MAVLINK_ROUTER_BUILD=$(mktemp -d)
    git clone --depth 1 https://github.com/mavlink-router/mavlink-router.git "$MAVLINK_ROUTER_BUILD" 2>/dev/null
    cd "$MAVLINK_ROUTER_BUILD"
    git submodule update --init --recursive 2>/dev/null
    meson setup build . > /dev/null 2>&1
    ninja -C build > /dev/null 2>&1
    ninja -C build install > /dev/null 2>&1
    cd "$REPO_DIR"
    rm -rf "$MAVLINK_ROUTER_BUILD"
    info "mavlink-routerd installed: $(which mavlink-routerd)"
else
    info "mavlink-routerd already installed: $(which mavlink-routerd)"
fi

# --- Create config directories ---
mkdir -p "$SWARM_CONF_DIR"
mkdir -p "$SWARM_OPT_DIR"
mkdir -p /etc/mavlink-router

# --- Configure native UARTs ---
# OPi Zero 2W uses SoC UARTs on the 40-pin header (no USB-UART needed):
#   UART0 (ttyS0) pins 8/10 (PH0/PH1) → flight controller MAVLink
#   UART5 (ttyS5) pins 11/13 (PH2/PH3) → LC29H GNSS RTCM
info "Configuring native UARTs..."

# Enable UART5 overlay if not already set
ARMBIAN_ENV="/boot/armbianEnv.txt"
if [ -f "$ARMBIAN_ENV" ]; then
    if ! grep -q "uart5" "$ARMBIAN_ENV"; then
        if grep -q "^overlays=" "$ARMBIAN_ENV"; then
            sed -i 's/^overlays=.*/& uart5/' "$ARMBIAN_ENV"
        else
            echo "overlays=uart5" >> "$ARMBIAN_ENV"
        fi
        info "UART5 overlay enabled (reboot required)"
    fi

    # Set console=display to free UART0 from kernel console
    if grep -q "^console=both" "$ARMBIAN_ENV"; then
        sed -i 's/^console=both/console=display/' "$ARMBIAN_ENV"
        info "Console switched to display (frees UART0)"
    fi
fi

# Fix boot.cmd so console=display doesn't still add ttyS0
if [ -f /boot/boot.cmd ]; then
    OLD_LINE='if test "${console}" = "display" || test "${console}" = "both"'
    if grep -q "$OLD_LINE" /boot/boot.cmd; then
        python3 -c "
p = open('/boot/boot.cmd').read()
old = 'if test \"\${console}\" = \"display\" || test \"\${console}\" = \"both\"; then setenv consoleargs \"console=ttyS0,115200 console=tty1\"; fi'
new = 'if test \"\${console}\" = \"both\"; then setenv consoleargs \"console=ttyS0,115200 console=tty1\"; fi\nif test \"\${console}\" = \"display\"; then setenv consoleargs \"console=tty1\"; fi'
open('/boot/boot.cmd','w').write(p.replace(old, new))
"
        mkimage -C none -A arm64 -T script -d /boot/boot.cmd /boot/boot.scr > /dev/null 2>&1
        info "Fixed boot.cmd console handling"
    fi
fi

# Disable serial-getty on ttyS0 so MAVLink can use it
systemctl stop serial-getty@ttyS0.service 2>/dev/null || true
systemctl disable serial-getty@ttyS0.service 2>/dev/null || true
systemctl mask serial-getty@ttyS0.service 2>/dev/null || true
info "serial-getty@ttyS0 disabled (UART0 free for MAVLink)"

FC_SERIAL="/dev/ttyS0"
GNSS_RTCM_SERIAL="/dev/ttyS5"

# --- Create heli.env ---
info "Creating heli.env..."
cat > "$SWARM_CONF_DIR/heli.env" <<EOF
# Roban Swarm — Heli $HELI_ID environment
# Generated by install.sh on $(date)

# Identity
HELI_ID=$HELI_ID

# Network
BASE_IP=$BASE_IP
WIFI_SSID=Robanswarm

# NTRIP (RTCM corrections)
NTRIP_PORT=2101
NTRIP_MOUNT=BASE
NTRIP_USER=admin
NTRIP_PASS=REPLACE_WITH_NTRIP_PASSWORD

# Serial ports — native SoC UARTs on 40-pin header
# UART0 (pins 8/10, PH0/PH1) → Flight controller MAVLink
FC_SERIAL=$FC_SERIAL
FC_BAUD=115200
# UART5 (pins 11/13, PH2/PH3) → LC29H GNSS RTCM
GNSS_RTCM_SERIAL=$GNSS_RTCM_SERIAL
GNSS_RTCM_BAUD=115200

# MAVLink
# Telemetry outbound to base hub
UDP_PORT=$UDP_PORT
# Command inbound from base hub (deterministic return path)
CMD_PORT=$CMD_PORT
EOF
chmod 600 "$SWARM_CONF_DIR/heli.env"
info "heli.env written to $SWARM_CONF_DIR/heli.env"

# --- Configure WiFi ---
info "Configuring WiFi connection profile..."

# Create NetworkManager connection (passphrase must be set manually)
NM_CONN_DIR="/etc/NetworkManager/system-connections"
mkdir -p "$NM_CONN_DIR"

cat > "$NM_CONN_DIR/RTK-FIELD.nmconnection" <<EOF
[connection]
id=RTK-FIELD
type=wifi
autoconnect=true
autoconnect-priority=100

[wifi]
mode=infrastructure
ssid=RTK-FIELD

[wifi-security]
key-mgmt=wpa-psk
psk=REPLACE_WITH_WIFI_PASSPHRASE

[ipv4]
method=auto

[ipv6]
method=disabled
EOF
chmod 600 "$NM_CONN_DIR/RTK-FIELD.nmconnection"
info "WiFi profile created. Set passphrase in $NM_CONN_DIR/RTK-FIELD.nmconnection"

# Reload NetworkManager
if systemctl is-active NetworkManager &>/dev/null; then
    nmcli connection reload 2>/dev/null || true
fi

# --- Configure mavlink-router ---
info "Configuring MAVLink router..."

# Read serial port from env
source "$SWARM_CONF_DIR/heli.env"

cat > /etc/mavlink-router/main.conf <<EOF
# Roban Swarm — Heli $HELI_ID mavlink-router config
# Generated by install.sh on $(date)

[General]
TcpServerPort = 0
ReportStats = false
MavlinkDialect = ardupilotmega

# Flight controller serial connection
[UartEndpoint fc]
Device = $FC_SERIAL
Baud = $FC_BAUD

# Telemetry outbound to base station hub
[UdpEndpoint to_base]
Mode = Normal
Address = $BASE_IP
Port = $UDP_PORT

# Command inbound from base station hub (deterministic return path)
[UdpEndpoint from_base]
Mode = Server
Address = 0.0.0.0
Port = $CMD_PORT
EOF

# --- Install systemd services ---
info "Installing systemd services..."

cp "$SCRIPT_DIR/systemd/ntrip-client.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mavlink-router.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/watchdog.service" /etc/systemd/system/

# Create watchdog script
cat > "$SWARM_OPT_DIR/watchdog.sh" <<'WATCHDOG_EOF'
#!/usr/bin/env bash
# Roban Swarm watchdog — restart services if they fail
set -euo pipefail

CHECK_INTERVAL=30  # seconds
MAX_FAILURES=3

mavlink_failures=0
ntrip_failures=0

while true; do
    sleep "$CHECK_INTERVAL"

    # Check mavlink-router
    if ! systemctl is-active mavlink-router &>/dev/null; then
        mavlink_failures=$((mavlink_failures + 1))
        echo "mavlink-router down (failure $mavlink_failures/$MAX_FAILURES)"
        if [ "$mavlink_failures" -ge "$MAX_FAILURES" ]; then
            echo "Restarting mavlink-router..."
            systemctl restart mavlink-router || true
            mavlink_failures=0
        fi
    else
        mavlink_failures=0
    fi

    # Check ntrip-client
    if ! systemctl is-active ntrip-client &>/dev/null; then
        ntrip_failures=$((ntrip_failures + 1))
        echo "ntrip-client down (failure $ntrip_failures/$MAX_FAILURES)"
        if [ "$ntrip_failures" -ge "$MAX_FAILURES" ]; then
            echo "Restarting ntrip-client..."
            systemctl restart ntrip-client || true
            ntrip_failures=0
        fi
    else
        ntrip_failures=0
    fi
done
WATCHDOG_EOF
chmod +x "$SWARM_OPT_DIR/watchdog.sh"

systemctl daemon-reload
systemctl enable ntrip-client
systemctl enable mavlink-router
systemctl enable watchdog 2>/dev/null || true

# Don't start services now — serial ports are likely still placeholders.
# Services are enabled and will start automatically on next boot once
# heli.env has real serial port paths configured.
info "Services installed and enabled (will auto-start on boot)."
info "Not started now because serial ports are placeholders."
info "After configuring heli.env, start with: sudo systemctl start ntrip-client mavlink-router"

# --- Install tools ---
info "Setting tool scripts executable..."
chmod +x "$SCRIPT_DIR/tools/"*.sh

# --- Configure chrony (NTP client) ---
info "Configuring chrony to use base station as NTP source..."
CHRONY_CONF="/etc/chrony/chrony.conf"
if [ -f "$CHRONY_CONF" ]; then
    # Add base station as preferred NTP server
    if ! grep -q "192.168.50.1" "$CHRONY_CONF"; then
        echo "" >> "$CHRONY_CONF"
        echo "# Roban Swarm — use base station as NTP server" >> "$CHRONY_CONF"
        echo "server 192.168.50.1 iburst prefer" >> "$CHRONY_CONF"
    fi
    systemctl restart chrony 2>/dev/null || true
fi

# --- Print summary ---
echo
echo "============================================"
echo "  Roban Swarm Companion Install Complete"
echo "  Heli ID: $HELI_ID"
echo "============================================"
echo
echo "Identity:"
echo "  Heli ID:     $HELI_ID"
echo "  Expected IP: $EXPECTED_IP"
echo "  Telemetry:   $UDP_PORT (outbound to base)"
echo "  Command:     $CMD_PORT (inbound from base)"
echo "  SYSID:       $SYSID (set this on the FC!)"
echo
echo "WiFi:"
echo "  SSID: RTK-FIELD"
echo "  >>> Set passphrase in $NM_CONN_DIR/RTK-FIELD.nmconnection <<<"
if command -v nmcli &>/dev/null; then
    nmcli -t -f DEVICE,STATE dev status 2>/dev/null | grep wlan | sed 's/^/  /'
fi
echo
echo "Serial ports (native SoC UARTs):"
echo "  FC:   $FC_SERIAL (UART0, header pins 8/10)"
echo "  GNSS: $GNSS_RTCM_SERIAL (UART5, header pins 11/13)"
echo
echo "Services (enabled for boot, not started — serial ports are placeholders):"
for svc in ntrip-client mavlink-router watchdog; do
    status=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo "disabled")
    printf "  %-20s active=%-12s enabled=%s\n" "$svc" "$status" "$enabled"
done
echo
echo "Next steps:"
echo "  1. Edit NTRIP credentials:"
echo "     sudo nano $SWARM_CONF_DIR/heli.env"
echo "  2. Reboot to activate UART5 overlay + console fix:"
echo "     sudo reboot"
echo "  3. Wire FC to header pins 8/10 (UART0), GNSS to pins 11/13 (UART5)"
echo "  4. Start services:"
echo "     sudo systemctl start ntrip-client mavlink-router"
echo "  5. Run smoketest:"
echo "     ./companion/tools/bench_smoketest.sh"
echo "  6. Set ArduPilot SYSID_THISMAV=$SYSID on the flight controller"
echo
