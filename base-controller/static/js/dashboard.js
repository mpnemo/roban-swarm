/* Dashboard — fleet overview with live status cards */

const Dashboard = (() => {
    const grid = document.getElementById('fleet-grid');
    let vehicles = {};  // sysid -> state
    let helis = [];     // fleet list cache

    function fixLabel(fixType) {
        switch (fixType) {
            case 6: return '<span class="fix-rtk">RTK</span>';
            case 5: return '<span class="fix-rtk">Float</span>';
            case 4: return '<span class="fix-rtk">RTK Float</span>';
            case 3: return '<span class="fix-3d">3D</span>';
            case 2: return '<span class="fix-3d">2D</span>';
            default: return '<span class="fix-none">No Fix</span>';
        }
    }

    let paramStatus = {};  // heli_id -> {needs_check, sysid_ok}

    function renderCard(heli) {
        const v = vehicles[heli.sysid] || {};
        const online = v.online || false;
        const ps = paramStatus[heli.id];
        const paramWarn = ps && (ps.needs_check || !ps.sysid_ok);
        return `
        <div class="heli-card ${online ? 'online' : 'offline'}" id="card-${heli.id}">
            <div class="heli-header">
                <span class="heli-name">${heli.name}</span>
                ${paramWarn ? '<span class="badge badge-warn" onclick="Dashboard.checkParams(' + heli.id + ')" title="FC params may be incorrect">⚠ Params</span>' : ''}
                <span class="heli-status ${online ? 'online' : 'offline'}"></span>
            </div>
            <div class="heli-stats">
                <span class="label">IP</span><span class="value">${heli.ip}</span>
                <span class="label">GPS</span><span class="value">${fixLabel(v.gps_fix || 0)}</span>
                <span class="label">Sats</span><span class="value">${v.sats != null ? v.sats : '-'}</span>
                <span class="label">HDOP</span><span class="value">${v.hdop != null ? v.hdop.toFixed(1) : '-'}</span>
                <span class="label">Batt</span><span class="value">${v.battery_pct != null ? v.battery_pct + '%' : '-'}</span>
                <span class="label">Mode</span><span class="value">${v.flight_mode || '-'}</span>
                <span class="label">Armed</span><span class="value">${v.armed ? 'YES' : 'No'}</span>
                <span class="label">SysID</span><span class="value">${heli.sysid}</span>
                <span class="label">FW</span><span class="value">${v.fw_version || '-'}</span>
            </div>
            <div class="heli-actions">
                <button onclick="Dashboard.configHeli(${heli.id})">Config</button>
                <button onclick="Dashboard.checkParams(${heli.id})">Check Params</button>
            </div>
        </div>`;
    }

    async function checkParams(heliId) {
        // Switch to config page and trigger param check
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelector('[data-page="config"]').classList.add('active');
        document.getElementById('page-config').classList.add('active');
        if (typeof Config !== 'undefined' && Config.loadParams) {
            Config.loadParams(heliId);
        }
    }

    async function refreshParamStatus() {
        try {
            const r = await fetch('/api/fleet/params/summary');
            const data = await r.json();
            paramStatus = {};
            data.forEach(h => { paramStatus[h.heli_id] = h; });
            renderAll();
        } catch (e) { /* ignore */ }
    }
    // Check param status every 30s
    setTimeout(refreshParamStatus, 3000);
    setInterval(refreshParamStatus, 30000);

    function renderAll() {
        if (helis.length === 0) {
            grid.innerHTML = '<p class="placeholder">No vehicles registered. Go to Fleet to add helis.</p>';
            return;
        }
        grid.innerHTML = helis.map(renderCard).join('');
    }

    async function refresh() {
        try {
            const r = await fetch('/api/fleet');
            helis = await r.json();
            renderAll();
        } catch (e) {
            grid.innerHTML = '<p class="placeholder">Error loading fleet.</p>';
        }
    }

    function updateVehicle(v) {
        // v = { sysid, online, gps_fix, sats, hdop, battery_pct, armed, flight_mode, ... }
        vehicles[v.sysid] = v;
        renderAll();  // re-render from cache, no fetch
    }

    async function configHeli(heliId) {
        await fetch('/api/mode/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({heli: heliId}),
        });
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelector('[data-page="config"]').classList.add('active');
        document.getElementById('page-config').classList.add('active');
        updateModeBadge();
    }

    // Listen for WebSocket vehicle updates
    RobanWS.onMessage((msg) => {
        if (msg.type === 'vehicle_update' && msg.vehicle) {
            updateVehicle(msg.vehicle);
        }
    });

    // --- Base station status ---
    async function refreshBase() {
        try {
            const r = await fetch('/api/base/status');
            const d = await r.json();
            const badge = document.getElementById('base-ntrip-badge');
            if (d.ntrip_active) {
                badge.textContent = 'NTRIP OK';
                badge.className = 'badge badge-online';
            } else {
                badge.textContent = 'NTRIP OFF';
                badge.className = 'badge badge-offline';
            }
            const bps = d.rtcm_bps || 0;
            document.getElementById('base-rtcm-bps').textContent = bps > 0 ? (bps / 1000).toFixed(1) + ' kbps' : '-';
            document.getElementById('base-ntrip-clients').textContent = d.ntrip_clients || '0';
            const total = d.rtcm_bytes_total || 0;
            document.getElementById('base-rtcm-total').textContent = total > 0 ? (total / 1048576).toFixed(1) + ' MB' : '-';
        } catch (e) { /* ignore */ }
    }
    refreshBase();
    setInterval(refreshBase, 5000);

    // Initial load
    refresh();

    return { refresh, configHeli, checkParams };
})();

async function updateModeBadge() {
    try {
        const r = await fetch('/api/mode');
        const d = await r.json();
        const badge = document.getElementById('mode-badge');
        badge.textContent = d.mode.toUpperCase();
        badge.className = `badge badge-${d.mode}`;
    } catch (e) { /* ignore */ }
}
updateModeBadge();
