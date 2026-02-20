# Access Point Setup Checklist

## Device: TP-Link TL-AP1901GP

### Initial Access

1. Connect laptop directly to AP via Ethernet
2. Access AP web UI (check label for default IP — typically 192.168.0.254)
3. Login with default credentials (check label or manual)
4. Change admin password to something secure

### Configuration Steps

Complete each step and check the box:

#### Operating Mode
- [ ] Set mode to **AP** (Access Point) or **Bridge**
- [ ] **NOT** Router mode — we do not want NAT or DHCP from the AP

#### SSID and Security
- [ ] Set SSID: `RTK-FIELD`
- [ ] Set security: **WPA2-PSK** (AES)
- [ ] Set passphrase: (use a strong passphrase, record securely offline)
- [ ] Disable WPS (if available)

#### Band and Channel
- [ ] Enable **5 GHz** band (preferred for outdoor, less interference)
- [ ] Set **fixed channel** (e.g., channel 36, 40, or 44 for 5 GHz)
  - Do NOT use auto-channel — it may switch mid-operation
- [ ] If companions only support 2.4 GHz: enable 2.4 GHz with fixed channel
  - Orange Pi Zero H2+/H3 WiFi may be 2.4 GHz only — **verify before 5 GHz-only config**
- [ ] Set channel width: 20 MHz (more reliable) or 40 MHz (more throughput)

#### DHCP
- [ ] **Disable** AP DHCP server
  - Base station dnsmasq handles all DHCP
  - If AP is in pure bridge mode, DHCP should be off by default
- [ ] If AP has its own management IP, set it to 192.168.50.250 (out of DHCP range)
  - This allows accessing AP web UI from the field network

#### Client Isolation
- [ ] **Disable** client isolation (also called "AP isolation" or "wireless isolation")
  - **CRITICAL:** With client isolation ON, wireless clients cannot reach
    the wired network or each other. Companions would be unable to reach
    the base station IP.
  - Verify this is OFF — it may be ON by default in some AP modes

#### Other Settings
- [ ] Disable band steering (if present) — let clients connect to preferred band
- [ ] Set transmit power to maximum (outdoor deployment, need range)
- [ ] Disable any captive portal or guest network features
- [ ] Enable SNMP or logging if available (for diagnostics)
- [ ] Set timezone (nice-to-have for log correlation)

### Verification

After configuration, verify:

1. **SSID broadcast:**
   ```bash
   # From a laptop or companion:
   nmcli dev wifi list | grep RTK-FIELD
   ```

2. **Client can connect:**
   ```bash
   nmcli dev wifi connect RTK-FIELD password "YOUR_PASSPHRASE"
   ```

3. **Client gets DHCP from base station (not AP):**
   ```bash
   ip addr show wlan0
   # Should show 192.168.50.x address
   # Gateway should be 192.168.50.1 (base station)
   ```

4. **Client can reach base station:**
   ```bash
   ping -c 3 192.168.50.1
   ```

5. **Client isolation is OFF:**
   ```bash
   # From one wireless client, ping another wireless client:
   ping -c 3 192.168.50.102  # (if two companions are connected)
   ```

### Physical Installation

- Mount AP as high as practical (pole mount if available)
- Ensure clear line of sight to operating area
- Protect Ethernet cable connections from weather
- Verify PoE injector is rated for AP power requirements
- Secure cable connections — vibration and wind can loosen connectors

### Troubleshooting

| Issue | Check |
|-------|-------|
| SSID not visible | AP powered? Correct mode? Band enabled? |
| Can connect but no IP | dnsmasq on base running? AP DHCP off? |
| IP from wrong range | AP DHCP is enabled — disable it |
| Can't reach base | Client isolation ON — disable it |
| Intermittent drops | Auto-channel? Change to fixed. Interference? Change channel |
| Short range | TX power at max? Antenna connected? Line of sight? |
