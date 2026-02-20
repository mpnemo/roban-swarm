#!/usr/bin/env bash
# Roban Swarm — Detect serial ports for FC and GNSS
# Usage: ./detect_ports.sh [--save]
#
# Scans for available serial ports and helps identify FC TELEM and GNSS RTCM.
# With --save, writes detected ports to /etc/roban-swarm/heli.env.
set -euo pipefail

SAVE_MODE=false
ENV_FILE="/etc/roban-swarm/heli.env"

if [ "${1:-}" = "--save" ]; then
    SAVE_MODE=true
fi

echo "Roban Swarm — Serial Port Detection"
echo "====================================="
echo

# Check /dev/serial/by-id/ (preferred — stable names)
echo "--- /dev/serial/by-id/ (preferred) ---"
if [ -d /dev/serial/by-id ] && [ "$(ls -A /dev/serial/by-id/ 2>/dev/null)" ]; then
    for link in /dev/serial/by-id/*; do
        target=$(readlink -f "$link")
        echo "  $link -> $target"
    done
else
    echo "  (none found — USB-UART adapters may not be connected)"
fi
echo

# Check /dev/serial/by-path/ (stable but less readable)
echo "--- /dev/serial/by-path/ ---"
if [ -d /dev/serial/by-path ] && [ "$(ls -A /dev/serial/by-path/ 2>/dev/null)" ]; then
    for link in /dev/serial/by-path/*; do
        target=$(readlink -f "$link")
        echo "  $link -> $target"
    done
else
    echo "  (none found)"
fi
echo

# Check /dev/ttyUSB* (USB-UART adapters)
echo "--- /dev/ttyUSB* ---"
found_usb=false
for dev in /dev/ttyUSB*; do
    [ -e "$dev" ] || continue
    found_usb=true
    echo "  $dev"
done
if ! $found_usb; then
    echo "  (none found)"
fi
echo

# Check /dev/ttyS* (onboard UARTs — filter out inactive ones)
echo "--- /dev/ttyS* (onboard, active only) ---"
found_onboard=false
for dev in /dev/ttyS*; do
    [ -e "$dev" ] || continue
    # Try to check if port is real (has IRQ other than 0)
    port_num="${dev##/dev/ttyS}"
    if [ -f "/proc/tty/driver/serial" ]; then
        if grep -q "^${port_num}: uart:" /proc/tty/driver/serial 2>/dev/null; then
            uart_type=$(grep "^${port_num}:" /proc/tty/driver/serial 2>/dev/null | grep -o "uart:[^ ]*" || echo "unknown")
            if echo "$uart_type" | grep -qv "unknown"; then
                found_onboard=true
                echo "  $dev ($uart_type)"
            fi
        fi
    else
        found_onboard=true
        echo "  $dev (cannot verify — /proc/tty/driver/serial not available)"
    fi
done
if ! $found_onboard; then
    echo "  (none active)"
fi
echo

# Check /dev/ttyAMA* and /dev/ttyAML* (ARM SoC UARTs)
echo "--- /dev/ttyAMA* / ttyAML* (ARM SoC UARTs) ---"
found_arm=false
for dev in /dev/ttyAMA* /dev/ttyAML*; do
    [ -e "$dev" ] || continue
    found_arm=true
    echo "  $dev"
done
if ! $found_arm; then
    echo "  (none found)"
fi
echo

# Recent dmesg for USB serial devices
echo "--- Recent USB-serial kernel messages ---"
dmesg 2>/dev/null | grep -i "usb.*serial\|ttyUSB\|ch341\|cp210x\|ftdi" | tail -10 | sed 's/^/  /' || echo "  (no messages or permission denied)"
echo

# Summary / recommendation
echo "=== Recommendation ==="
echo
if [ -d /dev/serial/by-id ] && [ "$(ls -A /dev/serial/by-id/ 2>/dev/null)" ]; then
    echo "Use /dev/serial/by-id/ paths for stable naming."
    echo "Identify which device is FC TELEM and which is GNSS RTCM:"
    echo
    echo "  1. Unplug all USB-UART adapters"
    echo "  2. Plug in FC adapter only — note which /dev/serial/by-id/ entry appears"
    echo "  3. Plug in GNSS adapter — note the new entry"
    echo

    if $SAVE_MODE; then
        echo "  (--save mode: manually edit $ENV_FILE with correct ports)"
    fi
else
    echo "No /dev/serial/by-id/ devices found."
    echo "Options:"
    echo "  1. Connect USB-UART adapters and re-run this script"
    echo "  2. Use onboard UARTs (/dev/ttyS* or /dev/ttyAMA*) — less stable names"
    echo "  3. Create custom udev rules for stable naming"
fi
