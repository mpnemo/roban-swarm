/* Show Control — full flight operations lifecycle + 2D map */

const Show = (() => {
    let currentState = 'idle';
    let vehicleData = {};  // sysid → latest telemetry
    let mapCtx = null;

    // --- UI refs ---
    const btnUpload = document.getElementById('btn-upload-show');
    const fileInput = document.getElementById('show-file-input');
    const fileName = document.getElementById('show-file-name');
    const showInfo = document.getElementById('show-info');
    const showName = document.getElementById('show-name-label');
    const showDuration = document.getElementById('show-duration-label');
    const showTracks = document.getElementById('show-tracks-label');
    const showState = document.getElementById('show-state');
    const showElapsed = document.getElementById('show-elapsed');
    const progressFill = document.getElementById('show-progress-fill');
    const lineupInfo = document.getElementById('lineup-info');
    const lineupDetail = document.getElementById('lineup-detail');
    const readinessDiv = document.getElementById('show-readiness');
    const readinessList = document.getElementById('readiness-list');
    const heliPhaseCards = document.getElementById('heli-phase-cards');
    const telemList = document.getElementById('heli-telemetry-list');
    const logEntries = document.getElementById('show-log-entries');
    const mapCanvas = document.getElementById('show-map');

    const btnLineup = document.getElementById('btn-lineup');
    const btnPreflight = document.getElementById('btn-preflight');
    const btnFixPreflight = document.getElementById('btn-fix-preflight');
    const btnLaunch = document.getElementById('btn-launch');
    const btnGo = document.getElementById('btn-go');
    const btnPause = document.getElementById('btn-pause');
    const btnResume = document.getElementById('btn-resume');
    const btnLand = document.getElementById('btn-land');
    const btnRtl = document.getElementById('btn-rtl');
    const btnStop = document.getElementById('btn-show-stop');

    // Init map canvas
    if (mapCanvas) {
        mapCtx = mapCanvas.getContext('2d');
        mapCanvas.width = 400;
        mapCanvas.height = 400;
    }

    // ================================================================
    // BUTTON HANDLERS (same as before)
    // ================================================================

    btnUpload.addEventListener('click', async () => {
        const file = fileInput.files[0];
        if (!file) { alert('Select a show JSON file first'); return; }
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const r = await fetch('/api/show/upload', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json),
            });
            const d = await r.json();
            if (!r.ok) { alert('Upload failed: ' + JSON.stringify(d.detail)); return; }
            fileName.textContent = file.name;
            showInfo.style.display = '';
            showName.textContent = `Show: ${d.name}`;
            showDuration.textContent = `Duration: ${d.duration_s}s`;
            showTracks.textContent = `Helis: ${d.heli_ids.join(', ')}`;
            if (d.safety_warnings && d.safety_warnings.length)
                d.safety_warnings.forEach(w => appendLog('warn', `Safety: ${w}`));
            appendLog('info', I18N.t('log_show_loaded').replace('{name}', d.name).replace('{tracks}', d.tracks).replace('{duration}', d.duration_s));
            updateButtons('loaded');
        } catch (e) { alert('Error: ' + e.message); }
    });

    btnLineup.addEventListener('click', async () => {
        appendLog('info', I18N.t('log_capturing_lineup'));
        const r = await fetch('/api/show/lineup', { method: 'POST' });
        const d = await r.json();
        if (!r.ok) { (d.detail?.errors || [d.detail]).forEach(e => appendLog('warn', `Lineup: ${e}`)); return; }
        showLineup(d.lineup);
        appendLog('ok', I18N.t('log_lineup_captured'));
    });

    btnPreflight.addEventListener('click', async () => {
        appendLog('info', I18N.t('log_preflight_running'));
        const r = await fetch('/api/show/preflight', { method: 'POST' });
        const d = await r.json();
        readinessDiv.style.display = '';
        readinessList.innerHTML = '';
        let hasFixes = false;
        d.checks.forEach(c => {
            const div = document.createElement('div');
            div.className = `readiness-item ${c.ok ? 'ok' : 'fail'}`;
            div.textContent = `Heli${String(c.heli_id).padStart(2,'0')}: ${c.detail}`;
            readinessList.appendChild(div);
            if (c.fixes && c.fixes.length) hasFixes = true;
        });
        btnFixPreflight.style.display = hasFixes ? '' : 'none';
        appendLog(d.ok ? 'ok' : 'warn', d.ok ? I18N.t('log_preflight_ok') : I18N.t('log_preflight_fail'));
    });

    btnFixPreflight.addEventListener('click', async () => {
        appendLog('info', I18N.t('log_fixing'));
        const r = await fetch('/api/show/preflight/fix', { method: 'POST' });
        const d = await r.json();
        d.results.forEach(res => appendLog(res.ok ? 'ok' : 'warn',
            `Heli${String(res.heli_id).padStart(2,'0')} ${res.param}=${res.value}: ${res.ok ? 'OK' : 'FAIL'}`));
        btnPreflight.click();
    });

    btnLaunch.addEventListener('click', async () => {
        if (!confirm(I18N.t('confirm_launch'))) return;
        appendLog('info', I18N.t('log_launch'));
        const r = await fetch('/api/show/launch', { method: 'POST' });
        if (!r.ok) { const d = await r.json(); appendLog('danger', `${I18N.t('log_launch_fail')}: ${d.detail}`); }
    });

    btnGo.addEventListener('click', async () => {
        await fetch('/api/show/go', { method: 'POST' });
        appendLog('info', I18N.t('log_go'));
    });

    btnPause.addEventListener('click', async () => {
        await fetch('/api/show/pause', { method: 'POST' });
        appendLog('info', I18N.t('log_paused'));
    });

    btnResume.addEventListener('click', async () => {
        await fetch('/api/show/resume', { method: 'POST' });
        appendLog('info', I18N.t('log_resumed'));
    });

    btnLand.addEventListener('click', async () => {
        if (!confirm(I18N.t('confirm_land'))) return;
        await fetch('/api/show/land', { method: 'POST' });
        appendLog('info', I18N.t('log_landing'));
    });

    btnRtl.addEventListener('click', async () => {
        if (!confirm(I18N.t('confirm_rtl'))) return;
        await fetch('/api/show/rtl', { method: 'POST' });
        appendLog('danger', I18N.t('log_rtl'));
    });

    btnStop.addEventListener('click', async () => {
        if (!confirm(I18N.t('confirm_stop'))) return;
        await fetch('/api/show/stop', { method: 'POST' });
        appendLog('danger', I18N.t('log_stop'));
    });

    // ================================================================
    // WEBSOCKET
    // ================================================================

    RobanWS.onMessage((msg) => {
        if (msg.type === 'show_status') {
            updateState(msg);
        } else if (msg.type === 'phase_progress') {
            updateHeliPhases(msg.heli_phases);
            updateButtons(msg.state);
            updateBtnColors(msg.state);
        } else if (msg.type === 'vehicle_update') {
            vehicleData[msg.vehicle.sysid] = msg.vehicle;
            updateTelemetry();
            drawMap();
        } else if (msg.type === 'lineup_captured') {
            showLineup(msg.lineup);
        } else if (msg.type === 'preflight_result') {
            readinessDiv.style.display = '';
            readinessList.innerHTML = '';
            msg.checks.forEach(c => {
                const div = document.createElement('div');
                div.className = `readiness-item ${c.ok ? 'ok' : 'fail'}`;
                div.textContent = `Heli${String(c.heli_id).padStart(2,'0')}: ${c.detail}`;
                readinessList.appendChild(div);
            });
        } else if (msg.type === 'safety_violation') {
            appendLog('danger', `SAFETY: Heli${String(msg.heli_id).padStart(2,'0')} — ${msg.detail}`);
        } else if (msg.type === 'show_error') {
            appendLog('danger', `ERROR: ${msg.message}`);
        } else if (msg.type === 'show_event') {
            const eventMsgs = {
                show_complete: {en: 'Show complete — auto-returning', de: 'Show abgeschlossen — automatische Rückkehr', es: 'Show completo — retorno automático', zh: '表演完成 — 自动返航'},
                returning: {en: 'Returning to home positions', de: 'Rückkehr zu Startpositionen', es: 'Regresando a posiciones de inicio', zh: '返回起始位置'},
                descending: {en: 'All helis descending — parallel landing', de: 'Alle Helis im Sinkflug — parallele Landung', es: 'Todos los helis descendiendo — aterrizaje paralelo', zh: '所有直升机下降 — 平行着陆'},
                all_landed: {en: 'All helis landed — operations complete', de: 'Alle Helis gelandet — Betrieb abgeschlossen', es: 'Todos los helis aterrizados — operaciones completas', zh: '所有直升机已着陆 — 操作完成'},
            };
            const msgs = eventMsgs[msg.event];
            const text = msgs ? (msgs[I18N.getLang()] || msgs.en) : msg.event;
            const level = msg.event === 'all_landed' ? 'ok' : 'info';
            appendLog(level, text);
        } else if (msg.type === 'rtl_triggered') {
            appendLog('danger', `RTL triggered for helis: ${msg.heli_ids.join(', ')}`);
        }
    });

    // ================================================================
    // STATE + BUTTON COLORS
    // ================================================================

    function updateState(msg) {
        currentState = msg.state;
        showState.textContent = I18N.t('state_' + msg.state) || msg.state.toUpperCase().replace(/_/g, ' ');
        showState.className = `state-${msg.state}`;

        if (msg.duration_s > 0 && msg.elapsed_s >= 0) {
            const pct = Math.min(100, (msg.elapsed_s / msg.duration_s) * 100);
            progressFill.style.width = `${pct}%`;
            showElapsed.textContent = `${msg.elapsed_s.toFixed(1)}s / ${msg.duration_s}s`;
        }

        if (msg.show_name) {
            showInfo.style.display = '';
            showName.textContent = `Show: ${msg.show_name}`;
        }
        if (msg.heli_phases) updateHeliPhases(msg.heli_phases);
        if (msg.lineup) showLineup(msg.lineup);
        updateButtons(msg.state);
        updateBtnColors(msg.state);
    }

    function updateBtnColors(state) {
        // Reset classes
        btnLaunch.className = 'btn-op';
        btnGo.className = 'btn-op';

        switch (state) {
            case 'arming': case 'spooling': case 'taking_off':
                btnLaunch.className = 'btn-op btn-green';
                btnGo.className = 'btn-op btn-yellow';
                break;
            case 'staging':
                btnLaunch.className = 'btn-op btn-green';
                btnGo.className = 'btn-op btn-blink';  // blink yellow-green
                break;
            case 'running':
                btnLaunch.className = 'btn-op btn-green';
                btnGo.className = 'btn-op btn-green';
                break;
            case 'paused':
                btnLaunch.className = 'btn-op btn-green';
                btnGo.className = 'btn-op btn-yellow';
                break;
            case 'landing':
                btnLaunch.className = 'btn-op btn-blink';
                btnGo.className = 'btn-op btn-blink';
                break;
            case 'done':
            case 'idle':
            case 'error':
                if (state === 'done' || state === 'error') {
                    btnLaunch.className = 'btn-op btn-red';
                    btnGo.className = 'btn-op btn-red';
                }
                break;
        }
    }

    function updateButtons(state) {
        btnLineup.disabled = !['loaded'].includes(state);
        btnPreflight.disabled = !['lineup_ready', 'preflight_ok'].includes(state);
        btnLaunch.disabled = state !== 'preflight_ok';
        btnGo.disabled = state !== 'staging';
        btnPause.disabled = state !== 'running';
        btnResume.disabled = state !== 'paused';
        btnLand.disabled = !['running', 'paused', 'done', 'staging'].includes(state);
    }

    function updateHeliPhases(phases) {
        if (!phases || !Object.keys(phases).length) return;
        let html = '';
        for (const [hid, phase] of Object.entries(phases)) {
            // Translate phase label via i18n
            const label = I18N.t('state_' + phase) || phase.toUpperCase().replace(/_/g, ' ');
            const cls = phaseClass(phase);
            html += `<div class="heli-phase-card ${cls}">
                <strong>Heli${String(hid).padStart(2,'0')}</strong>
                <span class="phase-label">${label}</span>
            </div>`;
        }
        heliPhaseCards.innerHTML = html;
    }

    function phaseClass(phase) {
        if (['running', 'at_start'].includes(phase)) return 'phase-ok';
        if (['arming', 'spooling', 'taking_off', 'traversing'].includes(phase)) return 'phase-active';
        if (['returning', 'descending'].includes(phase)) return 'phase-landing';
        if (['landed', 'idle'].includes(phase)) return 'phase-idle';
        if (['rtl', 'error'].includes(phase)) return 'phase-danger';
        return '';
    }

    function showLineup(lineup) {
        if (!lineup) return;
        lineupInfo.style.display = '';
        let html = `<div class="lineup-origin">Origin: ${lineup.origin_lat.toFixed(7)}, ${lineup.origin_lon.toFixed(7)} alt ${lineup.origin_alt_m.toFixed(1)}m</div>`;
        html += '<div class="lineup-homes">';
        for (const [hid, pos] of Object.entries(lineup.home_positions))
            html += `<span class="lineup-home">Heli${String(hid).padStart(2,'0')}: N${pos.n.toFixed(1)} E${pos.e.toFixed(1)}</span> `;
        html += '</div>';
        lineupDetail.innerHTML = html;
    }

    // ================================================================
    // TELEMETRY READOUT
    // ================================================================

    function updateTelemetry() {
        if (!telemList) return;
        // Determine which sysids to show (sim offset aware)
        const offset = typeof _simMode !== 'undefined' && _simMode ? 100 : 0;
        const helis = [];
        for (const [sid, v] of Object.entries(vehicleData)) {
            const s = parseInt(sid);
            if (offset > 0 && s > 100 && s < 200) helis.push(v);
            else if (offset === 0 && s > 10 && s < 100) helis.push(v);
        }
        helis.sort((a, b) => a.sysid - b.sysid);

        let html = '';
        for (const v of helis) {
            const alt = v.relative_alt_m != null ? v.relative_alt_m.toFixed(1) : (v.alt_m || 0).toFixed(1);
            const spd = (v.groundspeed || 0).toFixed(1);
            const hdg = (v.heading || v.yaw || 0).toFixed(0);
            html += `<div class="telem-card">
                <div class="telem-hdr">ID${String(v.sysid).padStart(3,'0')} ${v.armed ? '🔴 ARMED' : ''}</div>
                <div class="telem-row">
                    <span><span class="telem-lbl">N:</span>${(v.lat||0).toFixed(5)}</span>
                    <span><span class="telem-lbl">E:</span>${(v.lon||0).toFixed(5)}</span>
                </div>
                <div class="telem-row">
                    <span><span class="telem-lbl">Alt:</span>${alt}m</span>
                    <span><span class="telem-lbl">Spd:</span>${spd}m/s</span>
                    <span><span class="telem-lbl">Hdg:</span>${hdg}°</span>
                </div>
                <div class="telem-row">
                    <span><span class="telem-lbl">Mode:</span>${v.flight_mode || '-'}</span>
                    <span><span class="telem-lbl">Fix:</span>${v.gps_fix || 0}</span>
                </div>
            </div>`;
        }
        telemList.innerHTML = html || '<div class="dim">No vehicles</div>';
    }

    // ================================================================
    // 2D MAP
    // ================================================================

    function drawMap() {
        if (!mapCtx || !mapCanvas) return;
        const ctx = mapCtx;
        const W = mapCanvas.width;
        const H = mapCanvas.height;
        const SCALE = 8;  // pixels per meter
        const CX = W / 2;
        const CY = H / 2;

        // Clear
        ctx.fillStyle = '#0a0a1a';
        ctx.fillRect(0, 0, W, H);

        // Grid
        ctx.strokeStyle = '#1a2a3a';
        ctx.lineWidth = 0.5;
        for (let m = -25; m <= 25; m += 5) {
            const px = CX + m * SCALE;
            const py = CY - m * SCALE;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
        }

        // Axes
        ctx.strokeStyle = '#334455';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(CX, 0); ctx.lineTo(CX, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, CY); ctx.lineTo(W, CY); ctx.stroke();

        // Axis labels
        ctx.fillStyle = '#556677';
        ctx.font = '10px monospace';
        ctx.fillText('N', CX + 3, 12);
        ctx.fillText('E', W - 12, CY - 4);

        // Origin marker
        ctx.fillStyle = '#334455';
        ctx.beginPath(); ctx.arc(CX, CY, 3, 0, Math.PI * 2); ctx.fill();

        // Compute NED from GPS for each vehicle
        // We need origin from lineup — if not available, use first vehicle as ref
        let refLat = 0, refLon = 0, refAlt = 0;
        const lineupEl = document.getElementById('lineup-detail');
        if (lineupEl && lineupEl.textContent.includes('Origin:')) {
            // Parse from displayed lineup
            const m = lineupEl.textContent.match(/Origin:\s*([\d.-]+),\s*([\d.-]+)\s*alt\s*([\d.-]+)/);
            if (m) { refLat = parseFloat(m[1]); refLon = parseFloat(m[2]); refAlt = parseFloat(m[3]); }
        }

        const offset = typeof _simMode !== 'undefined' && _simMode ? 100 : 0;
        const colors = ['#00ff88', '#ff8800', '#00aaff', '#ff44aa', '#aaff00',
                         '#ff4444', '#44ffff', '#ff88ff', '#88ff44', '#4488ff'];
        let ci = 0;

        for (const v of Object.values(vehicleData)) {
            const s = v.sysid;
            if (offset > 0 && (s < 100 || s >= 200)) continue;
            if (offset === 0 && (s < 10 || s >= 100)) continue;

            let n = 0, e = 0;
            if (refLat !== 0 && v.lat) {
                n = (v.lat - refLat) * 111319.5;
                e = (v.lon - refLon) * 111319.5 * Math.cos(refLat * Math.PI / 180);
            }

            const px = CX + e * SCALE;
            const py = CY - n * SCALE;  // NED: north is up
            const alt = v.relative_alt_m != null ? v.relative_alt_m : 0;
            const color = colors[ci % colors.length];
            ci++;

            // Heli symbol (triangle pointing in heading direction)
            const hdg = ((v.heading || v.yaw || 0) - 90) * Math.PI / 180;
            const sz = 6;
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(hdg);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(sz, 0);
            ctx.lineTo(-sz, -sz * 0.6);
            ctx.lineTo(-sz, sz * 0.6);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            // Label
            ctx.fillStyle = color;
            ctx.font = 'bold 10px monospace';
            ctx.fillText(`ID${String(s).padStart(3,'0')}`, px + 8, py - 4);
            ctx.font = '9px monospace';
            ctx.fillText(`${alt.toFixed(1)}m`, px + 8, py + 8);
        }

        // Scale bar
        ctx.fillStyle = '#556677';
        ctx.font = '9px monospace';
        ctx.fillText('5m', CX + 5 * SCALE - 8, H - 8);
        ctx.strokeStyle = '#556677';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(CX, H - 15); ctx.lineTo(CX + 5 * SCALE, H - 15); ctx.stroke();
    }

    // Redraw map periodically even without new data
    setInterval(drawMap, 500);

    // ================================================================
    // LOGGING
    // ================================================================

    function appendLog(level, text) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${text}`;
        logEntries.prepend(entry);
        while (logEntries.children.length > 50) logEntries.lastChild.remove();
    }

    // Initial status fetch
    fetch('/api/show/status').then(r => r.json()).then(d => {
        if (d.state !== 'idle') updateState(d);
    }).catch(() => {});

    return { updateState, appendLog };
})();
