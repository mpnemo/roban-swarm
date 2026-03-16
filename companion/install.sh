#!/usr/bin/env bash
# Roban Swarm — Companion Install Script
# Usage: sudo ./companion/install.sh [--heli-id <01-10>]
#
# Installs all companion software onto an Orange Pi Zero 2W.
# If --heli-id is given, provisions immediately (no captive portal).
# If omitted, installs the provisioning service for first-boot setup.
#
# Services installed:
#   - roban-provision  (AP captive portal for first-boot config)
#   - mavlink-router   (FC ↔ Base MAVLink)
#   - ntrip-client     (RTCM corrections via str2str)
#   - gps-bridge       (NMEA → MAVLink GPS_INPUT)
#   - roban-watchdog   (service health monitor)
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
            error "Unknown argument: $1\nUsage: $0 [--heli-id <01-10>]"
            ;;
    esac
done

# Validate heli ID if provided
if [ -n "$HELI_ID" ]; then
    if ! echo "$HELI_ID" | grep -qE '^(0[1-9]|10)$'; then
        error "Heli ID must be 01 through 10. Got: $HELI_ID"
    fi
fi

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (sudo)."
fi

if [ ! -f /etc/os-release ]; then
    error "Cannot determine OS."
fi

. /etc/os-release
info "Starting Roban Swarm companion install..."
info "OS: $PRETTY_NAME"
if [ -n "$HELI_ID" ]; then
    info "Heli ID: $HELI_ID (immediate provisioning)"
else
    info "No --heli-id given — will install provisioning service"
fi

# --- Install packages ---
info "Updating apt and installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    dnsmasq \
    rtklib \
    chrony \
    curl \
    socat \
    jq \
    net-tools \
    usbutils \
    > /dev/null 2>&1 || {
    # rtklib may not be in default repos
    warn "Some packages failed. Trying without rtklib..."
    apt-get install -y -qq \
        dnsmasq \
        chrony \
        curl \
        socat \
        net-tools \
        usbutils \
        > /dev/null 2>&1
}

# Disable dnsmasq system service — we manage it ourselves during provisioning
systemctl stop dnsmasq 2>/dev/null || true
systemctl disable dnsmasq 2>/dev/null || true
info "dnsmasq installed (system service disabled — managed by provisioning)"

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

# --- Install provisioning configs ---
info "Installing provisioning configs..."
cp "$SCRIPT_DIR/config/dnsmasq-setup.conf" "$SWARM_CONF_DIR/"
info "Captive portal config installed to $SWARM_CONF_DIR/"

# --- Install scripts ---
info "Installing scripts to $SWARM_OPT_DIR/..."
cp "$SCRIPT_DIR/tools/roban-provision.py" "$SWARM_OPT_DIR/"
cp "$SCRIPT_DIR/tools/gps-bridge.py" "$SWARM_OPT_DIR/"
chmod +x "$SWARM_OPT_DIR/roban-provision.py"
chmod +x "$SWARM_OPT_DIR/gps-bridge.py"

# --- Create watchdog script ---
cat > "$SWARM_OPT_DIR/watchdog.sh" <<'WATCHDOG_EOF'
#!/usr/bin/env bash
# Roban Swarm watchdog — restart services if they fail
set -euo pipefail

CHECK_INTERVAL=30
MAX_FAILURES=3

mavlink_failures=0
ntrip_failures=0
gps_failures=0

while true; do
    sleep "$CHECK_INTERVAL"

    for svc in mavlink-router ntrip-client gps-bridge; do
        if ! systemctl is-active "$svc" &>/dev/null; then
            eval "count=\${${svc//-/_}_failures:-0}"
            count=$((count + 1))
            eval "${svc//-/_}_failures=$count"
            echo "$svc down (failure $count/$MAX_FAILURES)"
            if [ "$count" -ge "$MAX_FAILURES" ]; then
                echo "Restarting $svc..."
                systemctl restart "$svc" || true
                eval "${svc//-/_}_failures=0"
            fi
        else
            eval "${svc//-/_}_failures=0"
        fi
    done
done
WATCHDOG_EOF
chmod +x "$SWARM_OPT_DIR/watchdog.sh"

# --- Install systemd services ---
info "Installing systemd services..."

cp "$SCRIPT_DIR/systemd/roban-provision.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/ntrip-client.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mavlink-router.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/gps-bridge.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/watchdog.service" /etc/systemd/system/roban-watchdog.service

systemctl daemon-reload
systemctl enable roban-provision
systemctl enable ntrip-client
systemctl enable mavlink-router
systemctl enable gps-bridge
systemctl enable roban-watchdog 2>/dev/null || true
info "All services enabled"

# --- Configure chrony (NTP client) ---
info "Configuring chrony to use base station as NTP source..."
CHRONY_CONF="/etc/chrony/chrony.conf"
if [ -f "$CHRONY_CONF" ]; then
    if ! grep -q "192.168.50.1" "$CHRONY_CONF"; then
        echo "" >> "$CHRONY_CONF"
        echo "# Roban Swarm — use base station as NTP server" >> "$CHRONY_CONF"
        echo "server 192.168.50.1 iburst prefer" >> "$CHRONY_CONF"
    fi
    systemctl restart chrony 2>/dev/null || true
fi

# --- Set tool scripts executable ---
chmod +x "$SCRIPT_DIR/tools/"*.sh 2>/dev/null || true

# --- Immediate provisioning (if --heli-id given) ---
if [ -n "$HELI_ID" ]; then
    info "Provisioning immediately as Heli $HELI_ID..."

    HELI_NUM=$((10#$HELI_ID))
    UDP_PORT=$((14559 + HELI_NUM))
    CMD_PORT=$((14659 + HELI_NUM))
    EXPECTED_IP="192.168.50.$((100 + HELI_NUM))"
    SYSID=$((10 + HELI_NUM))
    BASE_IP="192.168.50.1"
    FC_SERIAL="/dev/ttyS0"
    FC_BAUD="115200"
    GNSS_RTCM_SERIAL="/dev/ttyS5"
    GNSS_RTCM_BAUD="115200"

    # Write heli.env
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
NTRIP_PASS=roban

# Serial ports — native SoC UARTs on 40-pin header
FC_SERIAL=$FC_SERIAL
FC_BAUD=$FC_BAUD
GNSS_RTCM_SERIAL=$GNSS_RTCM_SERIAL
GNSS_RTCM_BAUD=$GNSS_RTCM_BAUD

# MAVLink
UDP_PORT=$UDP_PORT
CMD_PORT=$CMD_PORT
SYSID=$SYSID
EOF
    chmod 600 "$SWARM_CONF_DIR/heli.env"

    # Write mavlink-router config
    cat > /etc/mavlink-router/main.conf <<EOF
# Roban Swarm — Heli $HELI_ID mavlink-router config
# Generated by install.sh on $(date)

[General]
TcpServerPort = 0
ReportStats = false
MavlinkDialect = ardupilotmega

[UartEndpoint fc]
Device = $FC_SERIAL
Baud = $FC_BAUD

[UdpEndpoint to_base]
Mode = Normal
Address = $BASE_IP
Port = $UDP_PORT

[UdpEndpoint from_base]
Mode = Server
Address = 0.0.0.0
Port = $CMD_PORT

[UdpEndpoint gps_bridge]
Mode = Server
Address = 127.0.0.1
Port = 14570
EOF

    # Mark provisioned (skips captive portal on boot)
    cat > "$SWARM_CONF_DIR/provisioned" <<EOF
heli_id=$HELI_ID
provisioned=$(date '+%Y-%m-%d %H:%M:%S')
EOF

    info "Heli $HELI_ID provisioned and marked"
fi

# --- Print summary ---
echo
echo "============================================"
echo "  Roban Swarm Companion Install Complete"
echo "============================================"
echo
if [ -n "$HELI_ID" ]; then
    HELI_NUM=$((10#$HELI_ID))
    echo "Identity:"
    echo "  Heli ID:     $HELI_ID"
    echo "  Expected IP: 192.168.50.$((100 + HELI_NUM))"
    echo "  Telemetry:   $((14559 + HELI_NUM)) (outbound to base)"
    echo "  Command:     $((14659 + HELI_NUM)) (inbound from base)"
    echo "  SYSID:       $((10 + HELI_NUM)) (set this on the FC!)"
    echo
    echo "Provisioned: YES"
    echo "  All configs written. Services will start on reboot."
else
    echo "Provisioned: NO (first-boot setup enabled)"
    echo
    echo "On first boot, the OPi will:"
    echo "  1. Start AP: SSID='RobanHeli-SETUP', password='robansetup'"
    echo "  2. Serve config form at http://192.168.4.1"
    echo "  3. After form submit → save config + reboot into normal mode"
    echo
    echo "To provision manually instead:"
    echo "  sudo $0 --heli-id <01-10>"
fi
echo
echo "Serial ports (native SoC UARTs):"
echo "  FC:   /dev/ttyS0 (UART0, header pins 8/10)"
echo "  GNSS: /dev/ttyS5 (UART5, header pins 11/13)"
echo
echo "Services:"
for svc in roban-provision mavlink-router ntrip-client gps-bridge roban-watchdog; do
    status=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
    enabled=$(systemctl is-enabled "$svc" 2>/dev/null || echo "disabled")
    printf "  %-20s active=%-12s enabled=%s\n" "$svc" "$status" "$enabled"
done
echo
echo "Root access: root / dopedope (for HDMI+keyboard debug)"
echo
echo "Factory reset: rm /etc/roban-swarm/provisioned && reboot"
echo
echo "Next steps:"
if [ -z "$HELI_ID" ]; then
    echo "  1. Write this SD image to all 10 cards"
    echo "  2. Boot each OPi → connect to 'RobanHeli-SETUP' WiFi"
    echo "  3. Open browser → fill form → OPi reboots into normal mode"
else
    echo "  1. Reboot to activate UART5 overlay + console fix"
    echo "  2. Wire FC to header pins 8/10 (UART0)"
    echo "  3. Wire GNSS to header pins 11/13 (UART5)"
    echo "  4. Set ArduPilot SYSID_THISMAV=$((10 + 10#$HELI_ID)) on the FC"
fi
echo
