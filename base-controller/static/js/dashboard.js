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

    function renderCard(heli) {
        const v = vehicles[heli.sysid] || {};
        const online = v.online || false;
        return `
        <div class="heli-card ${online ? 'online' : 'offline'}" id="card-${heli.id}">
            <div class="heli-header">
                <span class="heli-name">${heli.name}</span>
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
            </div>
            <div class="heli-actions">
                <button onclick="Dashboard.configHeli(${heli.id})">Config</button>
            </div>
        </div>`;
    }

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

    // Initial load
    refresh();

    return { refresh, configHeli };
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
