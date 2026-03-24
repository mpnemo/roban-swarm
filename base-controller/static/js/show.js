/* Show Control — full flight operations lifecycle */

const Show = (() => {
    let currentState = 'idle';

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
    const logEntries = document.getElementById('show-log-entries');

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

    // --- Upload ---
    btnUpload.addEventListener('click', async () => {
        const file = fileInput.files[0];
        if (!file) { alert('Select a show JSON file first'); return; }
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const r = await fetch('/api/show/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json),
            });
            const d = await r.json();
            if (!r.ok) {
                alert('Upload failed: ' + JSON.stringify(d.detail));
                return;
            }
            fileName.textContent = file.name;
            showInfo.style.display = '';
            showName.textContent = `Show: ${d.name}`;
            showDuration.textContent = `Duration: ${d.duration_s}s`;
            showTracks.textContent = `Helis: ${d.heli_ids.join(', ')}`;
            if (d.safety_warnings && d.safety_warnings.length) {
                d.safety_warnings.forEach(w => appendLog('warn', `Safety: ${w}`));
            }
            appendLog('info', `Show "${d.name}" loaded — ${d.tracks} tracks, ${d.duration_s}s`);
            updateButtons('loaded');
        } catch (e) {
            alert('Error: ' + e.message);
        }
    });

    // --- Lineup ---
    btnLineup.addEventListener('click', async () => {
        appendLog('info', 'Capturing lineup...');
        const r = await fetch('/api/show/lineup', { method: 'POST' });
        const d = await r.json();
        if (!r.ok) {
            const errs = d.detail?.errors || [d.detail];
            errs.forEach(e => appendLog('warn', `Lineup: ${e}`));
            return;
        }
        showLineup(d.lineup);
        appendLog('ok', 'Lineup captured — origin computed');
    });

    function showLineup(lineup) {
        if (!lineup) return;
        lineupInfo.style.display = '';
        let html = `<div class="lineup-origin">Origin: ${lineup.origin_lat.toFixed(7)}, ${lineup.origin_lon.toFixed(7)} alt ${lineup.origin_alt_m.toFixed(1)}m</div>`;
        html += '<div class="lineup-homes">';
        for (const [hid, pos] of Object.entries(lineup.home_positions)) {
            html += `<span class="lineup-home">Heli${String(hid).padStart(2,'0')}: N${pos.n.toFixed(1)} E${pos.e.toFixed(1)}</span> `;
        }
        html += '</div>';
        lineupDetail.innerHTML = html;
    }

    // --- Preflight ---
    btnPreflight.addEventListener('click', async () => {
        appendLog('info', 'Running preflight checks...');
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
        if (d.ok) {
            appendLog('ok', 'All preflight checks passed');
        } else {
            appendLog('warn', 'Preflight issues — fix before launch');
        }
    });

    btnFixPreflight.addEventListener('click', async () => {
        appendLog('info', 'Fixing preflight issues...');
        const r = await fetch('/api/show/preflight/fix', { method: 'POST' });
        const d = await r.json();
        d.results.forEach(res => {
            appendLog(res.ok ? 'ok' : 'warn',
                `Heli${String(res.heli_id).padStart(2,'0')} ${res.param}=${res.value}: ${res.ok ? 'OK' : 'FAIL'}`);
        });
        // Re-run preflight
        btnPreflight.click();
    });

    // --- Launch ---
    btnLaunch.addEventListener('click', async () => {
        if (!confirm('Launch all helis? This will ARM and TAKE OFF.')) return;
        appendLog('info', 'LAUNCH sequence starting...');
        const r = await fetch('/api/show/launch', { method: 'POST' });
        if (!r.ok) {
            const d = await r.json();
            appendLog('danger', `Launch failed: ${d.detail}`);
        }
    });

    // --- Go ---
    btnGo.addEventListener('click', async () => {
        await fetch('/api/show/go', { method: 'POST' });
        appendLog('info', 'Show GO!');
    });

    // --- Pause / Resume ---
    btnPause.addEventListener('click', async () => {
        await fetch('/api/show/pause', { method: 'POST' });
        appendLog('info', 'Show PAUSED');
    });

    btnResume.addEventListener('click', async () => {
        await fetch('/api/show/resume', { method: 'POST' });
        appendLog('info', 'Show RESUMED');
    });

    // --- Land ---
    btnLand.addEventListener('click', async () => {
        if (!confirm('Start landing sequence?')) return;
        await fetch('/api/show/land', { method: 'POST' });
        appendLog('info', 'Landing sequence started');
    });

    // --- Emergency ---
    btnRtl.addEventListener('click', async () => {
        if (!confirm('EMERGENCY RTL — All helis return to home with staggered altitudes. ArduPilot takes over. Proceed?')) return;
        await fetch('/api/show/rtl', { method: 'POST' });
        appendLog('danger', 'RTL ALL — ArduPilot in control');
    });

    btnStop.addEventListener('click', async () => {
        if (!confirm('EMERGENCY STOP — BRAKE all helis immediately?')) return;
        await fetch('/api/show/stop', { method: 'POST' });
        appendLog('danger', 'EMERGENCY STOP — all helis braking');
    });

    // --- WebSocket events ---
    RobanWS.onMessage((msg) => {
        if (msg.type === 'show_status') {
            updateState(msg);
        } else if (msg.type === 'phase_progress') {
            updateHeliPhases(msg.heli_phases);
            updateButtons(msg.state);
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
        } else if (msg.type === 'rtl_triggered') {
            appendLog('danger', `RTL triggered for helis: ${msg.heli_ids.join(', ')}`);
        }
    });

    function updateState(msg) {
        currentState = msg.state;
        showState.textContent = msg.state.toUpperCase().replace('_', ' ');
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

        if (msg.heli_phases) {
            updateHeliPhases(msg.heli_phases);
        }

        if (msg.lineup) {
            showLineup(msg.lineup);
        }

        updateButtons(msg.state);
    }

    function updateHeliPhases(phases) {
        if (!phases || !Object.keys(phases).length) return;
        let html = '';
        for (const [hid, phase] of Object.entries(phases)) {
            const label = phase.toUpperCase().replace('_', ' ');
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

    function updateButtons(state) {
        btnLineup.disabled = !['loaded'].includes(state);
        btnPreflight.disabled = !['lineup_ready', 'preflight_ok'].includes(state);
        btnLaunch.disabled = state !== 'preflight_ok';
        btnGo.disabled = state !== 'staging';
        btnPause.disabled = state !== 'running';
        btnResume.disabled = state !== 'paused';
        btnLand.disabled = !['running', 'paused', 'done', 'staging'].includes(state);
    }

    function appendLog(level, text) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${text}`;
        logEntries.prepend(entry);
        while (logEntries.children.length > 50) {
            logEntries.lastChild.remove();
        }
    }

    // Initial status fetch
    fetch('/api/show/status').then(r => r.json()).then(d => {
        if (d.state !== 'idle') updateState(d);
    }).catch(() => {});

    return { updateState, appendLog };
})();
