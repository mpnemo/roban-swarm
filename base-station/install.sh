#!/usr/bin/env bash
# Roban Swarm — Base Station Install Script
# Usage: sudo ./base-station/install.sh
#
# Installs and configures all base station services:
#   - Static IP (netplan)
#   - DHCP/DNS (dnsmasq)
#   - NTP (chrony)
#   - NTRIP caster (RTKBase)
#   - MAVLink hub (mavlink-routerd)
#   - Firewall (nftables)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SWARM_CONF_DIR="/etc/roban-swarm"

# --- Helpers ---
info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (sudo)."
fi

if [ ! -f /etc/os-release ]; then
    error "Cannot determine OS. Expected Ubuntu Server."
fi

. /etc/os-release
if [ "$ID" != "ubuntu" ]; then
    warn "Expected Ubuntu, detected '$ID'. Proceeding anyway."
fi

info "Starting Roban Swarm base station install..."
info "OS: $PRETTY_NAME"

# --- Detect LAN interface ---
# Find the first non-loopback, non-wireless interface
LAN_NIC=""
for iface in /sys/class/net/*; do
    iface_name=$(basename "$iface")
    [ "$iface_name" = "lo" ] && continue
    # Skip wireless interfaces
    [ -d "$iface/wireless" ] && continue
    [ -d "$iface/phy80211" ] && continue
    LAN_NIC="$iface_name"
    break
done

if [ -z "$LAN_NIC" ]; then
    warn "Could not auto-detect LAN NIC. Defaulting to eth0."
    LAN_NIC="eth0"
fi
info "Using LAN interface: $LAN_NIC"

# --- Install packages ---
info "Updating apt and installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    dnsmasq \
    chrony \
    nftables \
    git \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    wget \
    socat \
    jq \
    net-tools \
    > /dev/null

# --- Install mavlink-router ---
if ! command -v mavlink-routerd &>/dev/null; then
    info "Installing mavlink-router from source..."
    apt-get install -y -qq \
        gcc \
        g++ \
        meson \
        ninja-build \
        pkg-config \
        > /dev/null

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

# --- Create config directory ---
mkdir -p "$SWARM_CONF_DIR"

# --- Configure static IP (netplan) ---
info "Configuring static IP on $LAN_NIC..."

# Disable any existing DHCP client on LAN NIC
# Create netplan config with detected interface name
cat > /etc/netplan/01-roban-swarm.yaml <<EOF
# Roban Swarm — Base station static IP
network:
  version: 2
  renderer: networkd
  ethernets:
    ${LAN_NIC}:
      addresses:
        - 192.168.50.1/24
      nameservers:
        addresses: [192.168.50.1]
EOF
chmod 600 /etc/netplan/01-roban-swarm.yaml

# Remove default netplan configs that might conflict
for f in /etc/netplan/00-*.yaml /etc/netplan/50-*.yaml; do
    if [ -f "$f" ] && [ "$f" != "/etc/netplan/01-roban-swarm.yaml" ]; then
        info "Backing up existing netplan config: $f"
        mv "$f" "${f}.bak.$(date +%s)"
    fi
done

netplan apply 2>/dev/null || warn "netplan apply failed — may need reboot"

# --- Configure dnsmasq ---
info "Configuring dnsmasq..."

# Disable systemd-resolved if it's holding port 53
if systemctl is-active systemd-resolved &>/dev/null; then
    info "Disabling systemd-resolved (conflicts with dnsmasq)..."
    systemctl stop systemd-resolved
    systemctl disable systemd-resolved
fi

# Install dnsmasq config with correct interface
mkdir -p /etc/dnsmasq.d
sed "s/interface=eth0/interface=${LAN_NIC}/" \
    "$SCRIPT_DIR/config/dnsmasq.conf" \
    > /etc/dnsmasq.d/roban-swarm.conf

# Ensure dnsmasq reads from /etc/dnsmasq.d/
if ! grep -q "conf-dir=/etc/dnsmasq.d" /etc/dnsmasq.conf 2>/dev/null; then
    echo "conf-dir=/etc/dnsmasq.d/,*.conf" >> /etc/dnsmasq.conf
fi

systemctl enable dnsmasq
systemctl restart dnsmasq || warn "dnsmasq restart failed — check config"

# Point resolv.conf to dnsmasq AFTER it is running.
# This avoids a window where DNS is completely broken.
if ss -ulnp 2>/dev/null | grep -q ":53 .*dnsmasq"; then
    info "dnsmasq listening on :53 — setting /etc/resolv.conf"
    rm -f /etc/resolv.conf
    echo "nameserver 127.0.0.1" > /etc/resolv.conf
else
    warn "dnsmasq not yet listening on :53 — leaving resolv.conf unchanged"
    warn "After reboot, DNS will resolve via dnsmasq (netplan sets 192.168.50.1)"
fi

# --- Configure chrony (NTP) ---
info "Configuring chrony as local NTP server..."

# Add local network serving if not present
CHRONY_CONF="/etc/chrony/chrony.conf"
if [ -f "$CHRONY_CONF" ]; then
    if ! grep -q "allow 192.168.50.0/24" "$CHRONY_CONF"; then
        echo "" >> "$CHRONY_CONF"
        echo "# Roban Swarm — serve time to field network" >> "$CHRONY_CONF"
        echo "allow 192.168.50.0/24" >> "$CHRONY_CONF"
        echo "local stratum 10" >> "$CHRONY_CONF"
    fi
fi

systemctl enable chrony
systemctl restart chrony || warn "chrony restart failed"

# --- Install RTKBase ---
info "Installing RTKBase..."

if [ ! -d /opt/rtkbase ]; then
    # Clone RTKBase
    git clone --depth 1 https://github.com/Stefal/rtkbase.git /opt/rtkbase 2>/dev/null || \
        warn "RTKBase clone failed — install manually later"
fi

# Copy environment file
cp "$SCRIPT_DIR/config/rtkbase.env" "$SWARM_CONF_DIR/rtkbase.env"
chmod 600 "$SWARM_CONF_DIR/rtkbase.env"
info "RTKBase env installed to $SWARM_CONF_DIR/rtkbase.env"
info "  >>> EDIT $SWARM_CONF_DIR/rtkbase.env with actual serial port and credentials <<<"

# Install RTKBase systemd service (NOT enabled by default — enable after
# configuring serial port and verifying RTKBase starts correctly).
# On Ubuntu x86, RTKBase may need Docker or extra dependencies.
cp "$SCRIPT_DIR/systemd/rtkbase.service" /etc/systemd/system/rtkbase.service
systemctl daemon-reload
info "RTKBase service installed but NOT enabled."
info "  After configuring RTKBase, enable with: sudo systemctl enable --now rtkbase"

# --- Install MAVLink hub ---
info "Configuring MAVLink hub..."

mkdir -p /etc/mavlink-router
cp "$SCRIPT_DIR/config/mavlink-routerd.conf" /etc/mavlink-router/main.conf

# Install systemd service
cp "$SCRIPT_DIR/systemd/mavlink-hub.service" /etc/systemd/system/mavlink-hub.service

# Install dnsmasq override
mkdir -p /etc/systemd/system/dnsmasq.service.d
cp "$SCRIPT_DIR/systemd/dnsmasq.service.d/override.conf" \
   /etc/systemd/system/dnsmasq.service.d/override.conf

# Install chrony override
mkdir -p /etc/systemd/system/chrony.service.d
cp "$SCRIPT_DIR/systemd/chrony.service.d/override.conf" \
   /etc/systemd/system/chrony.service.d/override.conf

systemctl daemon-reload
systemctl enable mavlink-hub
systemctl start mavlink-hub || warn "mavlink-hub start failed — check config"

# --- Configure firewall (nftables) ---
info "Configuring nftables firewall..."

mkdir -p /etc/nftables.d
cp "$SCRIPT_DIR/config/firewall.nft" /etc/nftables.d/roban-swarm.nft

# Ensure /etc/nftables.conf includes our drop-in directory on boot.
# Ubuntu's default nftables.conf does NOT include /etc/nftables.d/*.
if [ -f /etc/nftables.conf ]; then
    if ! grep -q 'include "/etc/nftables.d/\*.nft"' /etc/nftables.conf 2>/dev/null; then
        echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
        info "Added include directive to /etc/nftables.conf"
    fi
fi

# Apply firewall rules from the installed location
nft -f /etc/nftables.d/roban-swarm.nft 2>/dev/null || \
    warn "nftables apply failed — apply manually: nft -f /etc/nftables.d/roban-swarm.nft"

systemctl enable nftables 2>/dev/null || true
systemctl restart nftables 2>/dev/null || true

# --- Install tools ---
info "Installing diagnostic tools..."
chmod +x "$SCRIPT_DIR/tools/"*.sh

# --- Create base coordinates persistence file ---
touch "$SWARM_CONF_DIR/base_coords.conf"

# --- Print summary ---
echo
echo "============================================"
echo "  Roban Swarm Base Station Install Complete"
echo "============================================"
echo
echo "Network:"
echo "  Interface: $LAN_NIC"
echo "  IP: 192.168.50.1/24"
ip addr show "$LAN_NIC" 2>/dev/null | grep "inet " | head -1 | sed 's/^/  Current: /'
echo
echo "DHCP (dnsmasq):"
systemctl is-active dnsmasq 2>/dev/null | sed 's/^/  Status: /'
echo
echo "NTRIP (RTKBase):"
echo "  Installed to: /opt/rtkbase"
echo "  Config: $SWARM_CONF_DIR/rtkbase.env"
echo "  Service: installed but NOT enabled (enable after config)"
echo "  >>> Configure serial port and credentials, then run:"
echo "  >>> sudo systemctl enable --now rtkbase"
echo
echo "MAVLink Hub:"
systemctl is-active mavlink-hub 2>/dev/null | sed 's/^/  Status: /'
echo "  Config: /etc/mavlink-router/main.conf"
echo "  GCS port: 14550/udp"
echo "  Heli telemetry ports: 14560-14569/udp"
echo "  Heli command ports:  14660-14669/udp"
echo
echo "NTP (chrony):"
systemctl is-active chrony 2>/dev/null | sed 's/^/  Status: /'
echo
echo "Firewall ports open:"
echo "  22/tcp (SSH)"
echo "  53/tcp+udp (DNS)"
echo "  67/udp (DHCP)"
echo "  123/udp (NTP)"
echo "  2101/tcp (NTRIP)"
echo "  14550/udp (GCS MAVLink)"
echo "  14560-14569/udp (Heli MAVLink telemetry)"
echo "  14660-14669/udp (Heli MAVLink command return)"
echo
echo "Next steps:"
echo "  1. Edit $SWARM_CONF_DIR/rtkbase.env (serial port + credentials)"
echo "  2. Configure RTKBase via its web UI or CLI"
echo "  3. Add heli MAC addresses to /etc/dnsmasq.d/roban-swarm.conf"
echo "  4. Run: ./base-station/tools/status_dump.sh"
echo
