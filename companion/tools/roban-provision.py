#!/usr/bin/env python3
"""
Roban Swarm — Companion Provisioning via Captive Portal

Boot-time service that checks if the OPi has been provisioned.
If not: starts AP mode + captive portal so the user can set
Heli ID, WiFi SSID, and WiFi password from a phone/laptop.

Pure stdlib — no pip packages needed.
"""

import http.server
import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse

CONF_DIR = "/etc/roban-swarm"
PROVISIONED_FLAG = os.path.join(CONF_DIR, "provisioned")
HELI_ENV = os.path.join(CONF_DIR, "heli.env")
SETUP_SSID = "RobanHeli-SETUP"
SETUP_PSK = "robansetup"
WEB_PORT = 80
IFACE = "wlan0"
AP_IP = "192.168.4.1"

# --- Operational services that should NOT run during setup ---
OPERATIONAL_SERVICES = [
    "mavlink-router",
    "ntrip-client",
    "gps-bridge",
    "roban-watchdog",
]

# ─── Default config values ───────────────────────────────────────────
DEFAULTS = {
    "base_ip": "192.168.50.1",
    "wifi_ssid": "Robanswarm",
    "ntrip_port": "2101",
    "ntrip_mount": "BASE",
    "ntrip_user": "admin",
    "ntrip_pass": "roban",
    "fc_serial": "/dev/ttyS0",
    "fc_baud": "115200",
    "gnss_serial": "/dev/ttyS5",
    "gnss_baud": "115200",
}


# ─── HTML form ────────────────────────────────────────────────────────
HTML_FORM = """\
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roban Swarm Setup</title>
<style>
  body {{ font-family: sans-serif; max-width: 420px; margin: 40px auto;
         padding: 0 16px; background: #f5f5f5; }}
  h1 {{ color: #333; font-size: 1.4em; }}
  label {{ display: block; margin-top: 12px; font-weight: bold; color: #555; }}
  input, select {{ width: 100%; padding: 8px; margin-top: 4px;
                   border: 1px solid #ccc; border-radius: 4px;
                   box-sizing: border-box; font-size: 1em; }}
  select {{ background: #fff; }}
  button {{ margin-top: 20px; width: 100%; padding: 12px;
            background: #2a7ae2; color: white; border: none;
            border-radius: 4px; font-size: 1.1em; cursor: pointer; }}
  button:hover {{ background: #1a5ab8; }}
  .note {{ color: #888; font-size: 0.85em; margin-top: 2px; }}
  .section {{ background: #fff; padding: 16px; border-radius: 8px;
              margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
</style>
</head>
<body>
<h1>Roban Swarm — Helicopter Setup</h1>
<form method="POST" action="/provision">
  <div class="section">
    <label for="heli_id">Helicopter ID</label>
    <select name="heli_id" id="heli_id" required>
      {heli_options}
    </select>
    <div class="note">Determines IP address, MAVLink ports, and SYSID</div>
  </div>

  <div class="section">
    <label for="wifi_ssid">WiFi Network (SSID)</label>
    <input type="text" name="wifi_ssid" id="wifi_ssid"
           value="{wifi_ssid}" required>

    <label for="wifi_pass">WiFi Password</label>
    <input type="password" name="wifi_pass" id="wifi_pass"
           required minlength="8">
  </div>

  <div class="section">
    <label for="ntrip_pass">NTRIP Password</label>
    <input type="text" name="ntrip_pass" id="ntrip_pass"
           value="{ntrip_pass}">
    <div class="note">Base station NTRIP caster password (default: roban)</div>
  </div>

  <button type="submit">Save &amp; Reboot</button>
</form>
</body>
</html>
"""

HTML_SUCCESS = """\
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roban Swarm — Saved</title>
<style>
  body {{ font-family: sans-serif; max-width: 420px; margin: 80px auto;
         padding: 0 16px; text-align: center; }}
  h1 {{ color: #2a7ae2; }}
  p {{ color: #555; }}
</style>
</head>
<body>
<h1>Configuration Saved</h1>
<p>Heli <strong>{heli_id}</strong> configured.</p>
<p>The board will reboot now and connect to <strong>{wifi_ssid}</strong>.</p>
<p>Expected IP: <strong>{expected_ip}</strong></p>
</body>
</html>
"""


# ─── Helpers ──────────────────────────────────────────────────────────

def log(msg):
    print(f"[provision] {msg}", flush=True)


def run(cmd, check=True):
    log(f"  $ {cmd}")
    return subprocess.run(cmd, shell=True, check=check,
                          capture_output=True, text=True)


def stop_operational_services():
    """Stop operational services so they don't interfere with setup."""
    for svc in OPERATIONAL_SERVICES:
        run(f"systemctl stop {svc}", check=False)


def start_ap_mode():
    """Switch wlan0 to AP mode using wpa_supplicant + dnsmasq.

    The Unisoc WiFi driver on OPi Zero 2W does not support hostapd's
    nl80211 AP interface.  wpa_supplicant mode=2 (AP) works instead.
    The interface must be set to __ap type via iw before starting.
    """
    log("Starting AP mode...")

    # Kill anything that might hold wlan0
    run("systemctl stop wpa_supplicant 2>/dev/null || true", check=False)
    run("killall wpa_supplicant 2>/dev/null || true", check=False)
    run("systemctl stop NetworkManager 2>/dev/null || true", check=False)

    # Set interface to AP type (required for Unisoc driver)
    run(f"ip link set {IFACE} down", check=False)
    run(f"ip addr flush dev {IFACE}", check=False)
    run(f"iw dev {IFACE} set type __ap", check=False)
    run(f"ip link set {IFACE} up", check=False)
    run(f"ip addr add {AP_IP}/24 dev {IFACE}", check=False)

    # Write wpa_supplicant AP config
    wpa_ap_conf = "/tmp/roban-ap.conf"
    with open(wpa_ap_conf, "w") as f:
        f.write(f'network={{\n'
                f'    ssid="{SETUP_SSID}"\n'
                f'    mode=2\n'
                f'    key_mgmt=WPA-PSK\n'
                f'    psk="{SETUP_PSK}"\n'
                f'    frequency=2437\n'
                f'}}\n')

    # Start wpa_supplicant in AP mode (background)
    run(f"wpa_supplicant -B -i {IFACE} -c {wpa_ap_conf}")

    # Start dnsmasq for DHCP + DNS wildcard (captive portal)
    # Kill any stale dnsmasq first
    run("killall dnsmasq 2>/dev/null || true", check=False)
    time.sleep(1)
    run("dnsmasq -C /etc/roban-swarm/dnsmasq-setup.conf")

    log(f"AP mode active: SSID={SETUP_SSID}, IP={AP_IP}")


def stop_ap_mode():
    """Tear down AP mode and restore managed mode for WiFi client."""
    run("killall dnsmasq 2>/dev/null || true", check=False)
    run("killall wpa_supplicant 2>/dev/null || true", check=False)
    run(f"ip addr flush dev {IFACE}", check=False)
    # Restore managed mode so WiFi client works after reboot
    run(f"ip link set {IFACE} down", check=False)
    run(f"iw dev {IFACE} set type managed", check=False)


def write_config(heli_id, wifi_ssid, wifi_pass, ntrip_pass):
    """Write heli.env, netplan WiFi config, and mark provisioned."""
    heli_num = int(heli_id)
    udp_port = 14559 + heli_num
    cmd_port = 14659 + heli_num
    expected_ip = f"192.168.50.{100 + heli_num}"
    sysid = 10 + heli_num

    os.makedirs(CONF_DIR, exist_ok=True)

    # --- heli.env ---
    env_content = f"""\
# Roban Swarm — Heli {heli_id:02d} environment
# Generated by roban-provision on {time.strftime('%Y-%m-%d %H:%M:%S')}

# Identity
HELI_ID={heli_id:02d}

# Network
BASE_IP={DEFAULTS['base_ip']}
WIFI_SSID={wifi_ssid}

# NTRIP (RTCM corrections)
NTRIP_PORT={DEFAULTS['ntrip_port']}
NTRIP_MOUNT={DEFAULTS['ntrip_mount']}
NTRIP_USER={DEFAULTS['ntrip_user']}
NTRIP_PASS={ntrip_pass}

# Serial ports — native SoC UARTs on 40-pin header
FC_SERIAL={DEFAULTS['fc_serial']}
FC_BAUD={DEFAULTS['fc_baud']}
GNSS_RTCM_SERIAL={DEFAULTS['gnss_serial']}
GNSS_RTCM_BAUD={DEFAULTS['gnss_baud']}

# MAVLink
UDP_PORT={udp_port}
CMD_PORT={cmd_port}
SYSID={sysid}
"""
    with open(HELI_ENV, "w") as f:
        f.write(env_content)
    os.chmod(HELI_ENV, 0o600)
    log(f"Wrote {HELI_ENV}")

    # --- Netplan WiFi client config ---
    netplan_content = f"""\
# Roban Swarm — WiFi client config
# Generated by roban-provision
network:
  version: 2
  renderer: networkd
  wifis:
    {IFACE}:
      dhcp4: true
      access-points:
        "{wifi_ssid}":
          password: "{wifi_pass}"
"""
    netplan_path = "/etc/netplan/50-roban-wifi.yaml"
    with open(netplan_path, "w") as f:
        f.write(netplan_content)
    os.chmod(netplan_path, 0o600)
    log(f"Wrote {netplan_path}")

    # Remove any conflicting netplan configs
    for name in os.listdir("/etc/netplan/"):
        full = os.path.join("/etc/netplan/", name)
        if name.endswith(".yaml") and name != "50-roban-wifi.yaml":
            # Keep non-wifi configs (like wired), remove old wifi ones
            try:
                with open(full) as f:
                    content = f.read()
                if "wifis:" in content:
                    os.rename(full, full + ".bak")
                    log(f"Backed up conflicting netplan: {name}")
            except Exception:
                pass

    # --- mavlink-router config ---
    mavlink_conf_dir = "/etc/mavlink-router"
    os.makedirs(mavlink_conf_dir, exist_ok=True)
    mavlink_content = f"""\
# Roban Swarm — Heli {heli_id:02d} mavlink-router config
# Generated by roban-provision on {time.strftime('%Y-%m-%d %H:%M:%S')}

[General]
TcpServerPort = 0
ReportStats = false
MavlinkDialect = ardupilotmega

# Flight controller serial connection
[UartEndpoint fc]
Device = {DEFAULTS['fc_serial']}
Baud = {DEFAULTS['fc_baud']}

# Telemetry outbound to base station hub
[UdpEndpoint to_base]
Mode = Normal
Address = {DEFAULTS['base_ip']}
Port = {udp_port}

# Command inbound from base station hub
[UdpEndpoint from_base]
Mode = Server
Address = 0.0.0.0
Port = {cmd_port}

# Local GPS bridge input
[UdpEndpoint gps_bridge]
Mode = Server
Address = 127.0.0.1
Port = 14570
"""
    with open(os.path.join(mavlink_conf_dir, "main.conf"), "w") as f:
        f.write(mavlink_content)
    log("Wrote mavlink-router config")

    # --- Mark provisioned ---
    with open(PROVISIONED_FLAG, "w") as f:
        f.write(f"heli_id={heli_id:02d}\nprovisioned={time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    log("Marked as provisioned")

    return expected_ip


# ─── HTTP Handler ─────────────────────────────────────────────────────

class ProvisionHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(f"HTTP: {fmt % args}")

    def do_GET(self, *_args):
        """Serve the setup form. All paths redirect here (captive portal)."""
        heli_options = "\n".join(
            f'      <option value="{i:02d}">Heli {i:02d} '
            f'(IP .{100+i}, SYSID {10+i})</option>'
            for i in range(1, 11)
        )
        html = HTML_FORM.format(
            heli_options=heli_options,
            wifi_ssid=DEFAULTS["wifi_ssid"],
            ntrip_pass=DEFAULTS["ntrip_pass"],
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode())

    def do_POST(self, *_args):
        """Handle form submission."""
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len).decode()
        params = urllib.parse.parse_qs(body)

        heli_id = int(params.get("heli_id", ["1"])[0])
        wifi_ssid = params.get("wifi_ssid", [DEFAULTS["wifi_ssid"]])[0]
        wifi_pass = params.get("wifi_pass", [""])[0]
        ntrip_pass = params.get("ntrip_pass", [DEFAULTS["ntrip_pass"]])[0]

        log(f"Provisioning: Heli {heli_id:02d}, SSID={wifi_ssid}")

        expected_ip = write_config(heli_id, wifi_ssid, wifi_pass, ntrip_pass)

        html = HTML_SUCCESS.format(
            heli_id=f"{heli_id:02d}",
            wifi_ssid=wifi_ssid,
            expected_ip=expected_ip,
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode())

        # Schedule reboot after response is sent
        log("Rebooting in 3 seconds...")

        def delayed_reboot():
            time.sleep(3)
            stop_ap_mode()
            run("reboot")

        import threading
        threading.Thread(target=delayed_reboot, daemon=True).start()


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    log("Roban Swarm Provisioning Service starting...")

    if os.path.exists(PROVISIONED_FLAG):
        log(f"Already provisioned ({PROVISIONED_FLAG} exists). Exiting.")
        log("To re-provision: delete /etc/roban-swarm/provisioned and reboot")
        sys.exit(0)

    log("NOT provisioned — entering setup mode")

    # Stop operational services
    stop_operational_services()

    # Start AP + captive portal
    start_ap_mode()

    # Serve web form
    server = http.server.HTTPServer(("0.0.0.0", WEB_PORT), ProvisionHandler)
    log(f"Web server listening on {AP_IP}:{WEB_PORT}")
    log(f"Connect to WiFi '{SETUP_SSID}' (password: {SETUP_PSK})")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down...")
    finally:
        stop_ap_mode()
        server.server_close()


if __name__ == "__main__":
    main()
