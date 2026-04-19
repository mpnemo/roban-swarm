/* Dashboard — fleet overview with live status cards */

const Dashboard = (() => {
    const grid = document.getElementById('fleet-grid');
    let vehicles = {};  // sysid -> state
    let helis = [];     // fleet list cache
    let toggleStatus = {};  // heli_id -> {gps_mode, control_mode}
    let pendingToggles = {};  // 'gps-N' or 'ctrl-N' -> true while waiting for readback

    function fixLabel(fixType) {
        switch (fixType) {
            case 6: return `<span class="fix-rtk">${I18N.t('gps_rtk')}</span>`;
            case 5: return `<span class="fix-rtk">${I18N.t('gps_float')}</span>`;
            case 4: return `<span class="fix-rtk">${I18N.t('gps_float')}</span>`;
            case 3: return `<span class="fix-3d">${I18N.t('gps_3d')}</span>`;
            case 2: return `<span class="fix-3d">${I18N.t('gps_2d')}</span>`;
            default: return `<span class="fix-none">${I18N.t('gps_nofix')}</span>`;
        }
    }

    let paramStatus = {};  // heli_id -> {needs_check, sysid_ok}

    function renderCard(heli) {
        // In sim mode, telemetry arrives under sysid+100
        const simOffset = (typeof _simMode !== 'undefined' && _simMode) ? 100 : 0;
        const v = vehicles[heli.sysid + simOffset] || vehicles[heli.sysid] || {};
        const online = v.online || false;
        const ps = paramStatus[heli.id];
        const paramWarn = ps && (ps.needs_check || !ps.sysid_ok);
        const ts = toggleStatus[heli.id] || {};
        const gpsMode = ts.gps_mode || 'unknown';
        const controlMode = ts.control_mode || 'unknown';
        const gpsPending = pendingToggles['gps-' + heli.id] || false;
        const ctrlPending = pendingToggles['ctrl-' + heli.id] || false;
        // Lamp states
        const gpsLamp = gpsPending ? 'pending' : (gpsMode === 'rtk' ? 'confirmed-on' : gpsMode === 'direct' ? 'confirmed-off' : 'unknown');
        const ctrlLamp = ctrlPending ? 'pending' : (controlMode === 'swarm' ? 'confirmed-on' : controlMode === 'rc' ? 'confirmed-off' : 'unknown');
        // Slider position
        const gpsSlider = gpsMode === 'rtk' ? 'on' : gpsMode === 'direct' ? 'off' : 'unknown';
        const ctrlSlider = controlMode === 'swarm' ? 'on' : controlMode === 'rc' ? 'off' : 'unknown';
        const gpsBusy = gpsPending ? 'busy' : '';
        const ctrlBusy = ctrlPending ? 'busy' : '';
        // Block swarm toggle if GPS not RTK
        const ctrlDisabled = (!ctrlPending && gpsMode !== 'rtk' && controlMode !== 'swarm') ? 'disabled' : '';
        return `
        <div class="heli-card ${online ? 'online' : 'offline'}" id="card-${heli.id}">
            <div class="heli-header">
                <span class="heli-name">${heli.name}</span>
                ${paramWarn ? '<span class="badge badge-warn" onclick="Dashboard.checkParams(' + heli.id + ')" title="FC params may be incorrect">⚠ Params</span>' : ''}
                <span class="heli-status ${online ? 'online' : 'offline'}"></span>
            </div>
            <div class="heli-stats">
                <span class="label">${I18N.t('lbl_ip')}</span><span class="value">${heli.ip}</span>
                <span class="label">${I18N.t('lbl_gps')}</span><span class="value">${fixLabel(v.gps_fix || 0)}</span>
                <span class="label">${I18N.t('lbl_sats')}</span><span class="value">${v.sats != null ? v.sats : '-'}</span>
                <span class="label">${I18N.t('lbl_hdop')}</span><span class="value">${v.hdop != null ? v.hdop.toFixed(1) : '-'}</span>
                <span class="label">${I18N.t('lbl_batt')}</span><span class="value">${v.battery_pct != null ? v.battery_pct + '%' : '-'}</span>
                <span class="label">${I18N.t('lbl_mode')}</span><span class="value">${v.flight_mode || '-'}</span>
                <span class="label">${I18N.t('lbl_armed')}</span><span class="value">${v.armed ? I18N.t('lbl_yes') : I18N.t('lbl_no')}</span>
                <span class="label">${I18N.t('lbl_sysid')}</span><span class="value">${heli.sysid}${simOffset ? ` (sim: ${heli.sysid + simOffset})` : ''}</span>
                <span class="label">${I18N.t('lbl_fw')}</span><span class="value">${v.fw_version || '-'}</span>
            </div>
            <div class="heli-toggles">
                <div class="toggle-row">
                    <span class="toggle-label">GPS</span>
                    <span class="toggle-lamp ${gpsLamp}" id="lamp-gps-${heli.id}"></span>
                    <div class="toggle-slider ${gpsSlider} ${gpsBusy}" id="slider-gps-${heli.id}"
                         onclick="Dashboard.toggleGPS(${heli.id}, '${gpsMode === 'rtk' ? 'direct' : 'rtk'}')">
                        <span class="slider-lbl slider-lbl-left">Direct</span>
                        <span class="slider-lbl slider-lbl-right">RTK</span>
                        <div class="thumb"></div>
                    </div>
                </div>
                <div class="toggle-row">
                    <span class="toggle-label">Mode</span>
                    <span class="toggle-lamp ${ctrlLamp}" id="lamp-ctrl-${heli.id}"></span>
                    <div class="toggle-slider ${ctrlSlider} ${ctrlBusy} ${ctrlDisabled}" id="slider-ctrl-${heli.id}"
                         onclick="Dashboard.toggleControl(${heli.id}, '${controlMode === 'swarm' ? 'rc' : 'swarm'}')">
                        <span class="slider-lbl slider-lbl-left">RC</span>
                        <span class="slider-lbl slider-lbl-right">Swarm</span>
                        <div class="thumb"></div>
                    </div>
                </div>
            </div>
            <div class="heli-actions">
                <button onclick="Dashboard.configHeli(${heli.id})">Config</button>
                <button onclick="Dashboard.checkParams(${heli.id})">Check Params</button>
                <button class="btn-reboot" onclick="Dashboard.rebootHeli(${heli.id})" title="Reboot FC">⟳</button>
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
            await refreshToggleStatus();
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

    async function refreshAll() {
        await refresh();
        refreshBase();
        refreshParamStatus();
        refreshToggleStatus();
    }

    async function readbackHeli(heliId) {
        /** Read back toggle status from FC params, update cache + lamps. */
        try {
            const r = await fetch(`/api/fleet/${heliId}/toggle/status`);
            const d = await r.json();
            toggleStatus[heliId] = d;
        } catch (e) { /* leave as-is */ }
        // Clear pending flags for this heli
        delete pendingToggles['gps-' + heliId];
        delete pendingToggles['ctrl-' + heliId];
        renderAll();
    }

    async function toggleGPS(heliId, newMode) {
        const label = newMode === 'rtk' ? 'RTK (OPi)' : 'Direct (uBlox)';
        if (!confirm(`Switch Heli${String(heliId).padStart(2,'0')} GPS to ${label}? FC will reboot.`)) return;
        // Set pending immediately — lamp goes yellow
        pendingToggles['gps-' + heliId] = true;
        renderAll();
        try {
            const r = await fetch(`/api/fleet/${heliId}/toggle/gps`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode: newMode}),
            });
            const d = await r.json();
            if (!r.ok) {
                delete pendingToggles['gps-' + heliId];
                renderAll();
                alert('Failed: ' + (d.detail || JSON.stringify(d)));
                return;
            }
            // GPS toggle reboots FC — wait for it to come back, then readback
            setTimeout(() => readbackHeli(heliId), 8000);
        } catch (e) {
            delete pendingToggles['gps-' + heliId];
            renderAll();
            alert('Error: ' + e.message);
        }
    }

    async function toggleControl(heliId, newMode) {
        const ts = toggleStatus[heliId] || {};
        if (newMode === 'swarm' && ts.gps_mode !== 'rtk') {
            alert('Cannot enable Swarm mode without RTK GPS enabled first.');
            return;
        }
        const label = newMode === 'swarm' ? 'Swarm (GUIDED)' : 'RC Manual';
        if (!confirm(`Switch Heli${String(heliId).padStart(2,'0')} to ${label}?`)) return;
        pendingToggles['ctrl-' + heliId] = true;
        renderAll();
        try {
            const r = await fetch(`/api/fleet/${heliId}/toggle/control`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode: newMode}),
            });
            const d = await r.json();
            if (!r.ok) {
                delete pendingToggles['ctrl-' + heliId];
                renderAll();
                alert('Failed: ' + (d.detail || JSON.stringify(d)));
                return;
            }
            // Control params don't need reboot — readback immediately
            await readbackHeli(heliId);
        } catch (e) {
            delete pendingToggles['ctrl-' + heliId];
            renderAll();
            alert('Error: ' + e.message);
        }
    }

    async function rebootHeli(heliId) {
        if (!confirm(`Reboot Heli${String(heliId).padStart(2,'0')} FC? This will interrupt all operations.`)) return;
        try {
            await fetch(`/api/fleet/${heliId}/reboot`, {method: 'POST'});
            // After reboot, readback to confirm state
            pendingToggles['gps-' + heliId] = true;
            pendingToggles['ctrl-' + heliId] = true;
            renderAll();
            setTimeout(() => readbackHeli(heliId), 8000);
        } catch (e) { /* ignore */ }
    }

    async function toggleAll(mode) {
        const label = mode === 'swarm' ? 'Swarm+RTK' : 'RC+Direct GPS';
        if (!confirm(`Switch ALL helis to ${label}? FCs will reboot.`)) return;
        // Set all helis pending
        for (const h of helis) {
            pendingToggles['gps-' + h.id] = true;
            pendingToggles['ctrl-' + h.id] = true;
        }
        renderAll();
        try {
            const r = await fetch('/api/fleet/toggle/all', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode: mode}),
            });
            const d = await r.json();
            if (!r.ok) {
                // Clear pending
                for (const h of helis) {
                    delete pendingToggles['gps-' + h.id];
                    delete pendingToggles['ctrl-' + h.id];
                }
                renderAll();
                alert('Failed: ' + (d.detail || JSON.stringify(d)));
                return;
            }
            // Readback all helis after reboot delay
            setTimeout(async () => {
                for (const h of helis) await readbackHeli(h.id);
            }, 10000);
        } catch (e) {
            for (const h of helis) {
                delete pendingToggles['gps-' + h.id];
                delete pendingToggles['ctrl-' + h.id];
            }
            renderAll();
            alert('Error: ' + e.message);
        }
    }

    async function refreshToggleStatus() {
        // Fetch all helis in parallel
        await Promise.all(helis.map(async (h) => {
            try {
                const r = await fetch(`/api/fleet/${h.id}/toggle/status`);
                const d = await r.json();
                toggleStatus[h.id] = d;
            } catch (e) { /* ignore */ }
        }));
        renderAll();
    }

    return { refresh, configHeli, checkParams, refreshAll, toggleGPS, toggleControl, rebootHeli, toggleAll, readbackHeli };
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
