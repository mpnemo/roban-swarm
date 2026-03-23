/* Show Control — upload, arm, go, pause, resume, stop */

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
    const readinessDiv = document.getElementById('show-readiness');
    const readinessList = document.getElementById('readiness-list');
    const logEntries = document.getElementById('show-log-entries');

    const btnArm = document.getElementById('btn-arm');
    const btnGo = document.getElementById('btn-go');
    const btnPause = document.getElementById('btn-pause');
    const btnResume = document.getElementById('btn-resume');
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
            appendLog('info', `Show "${d.name}" loaded — ${d.tracks} tracks, ${d.duration_s}s`);
            updateButtons('loaded');
        } catch (e) {
            alert('Error: ' + e.message);
        }
    });

    // --- Arm ---
    btnArm.addEventListener('click', async () => {
        const r = await fetch('/api/show/arm', { method: 'POST' });
        const d = await r.json();
        readinessDiv.style.display = '';
        readinessList.innerHTML = '';
        d.checks.forEach(c => {
            const div = document.createElement('div');
            div.className = `readiness-item ${c.ok ? 'ok' : 'fail'}`;
            div.textContent = `Heli${String(c.heli_id).padStart(2,'0')}: ${c.detail}`;
            readinessList.appendChild(div);
        });
        if (d.armed) {
            appendLog('ok', 'All pre-flight checks passed — ARMED');
        } else {
            appendLog('warn', 'Arm failed — see readiness checks above');
        }
    });

    // --- Go / Pause / Resume / Stop ---
    btnGo.addEventListener('click', async () => {
        await fetch('/api/show/go', { method: 'POST' });
        appendLog('info', 'Show started — staging...');
    });

    btnPause.addEventListener('click', async () => {
        await fetch('/api/show/pause', { method: 'POST' });
        appendLog('info', 'Show PAUSED');
    });

    btnResume.addEventListener('click', async () => {
        await fetch('/api/show/resume', { method: 'POST' });
        appendLog('info', 'Show RESUMED');
    });

    btnStop.addEventListener('click', async () => {
        if (!confirm('EMERGENCY STOP — Brake all helis?')) return;
        await fetch('/api/show/stop', { method: 'POST' });
        appendLog('warn', 'EMERGENCY STOP — all helis braking');
    });

    // --- WebSocket events ---
    RobanWS.onMessage((msg) => {
        if (msg.type === 'show_status') {
            updateState(msg);
        } else if (msg.type === 'show_readiness') {
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
        }
    });

    function updateState(msg) {
        currentState = msg.state;
        showState.textContent = msg.state.toUpperCase();
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

        updateButtons(msg.state);
    }

    function updateButtons(state) {
        btnArm.disabled = !['loaded', 'done'].includes(state);
        btnGo.disabled = state !== 'armed';
        btnPause.disabled = state !== 'running';
        btnResume.disabled = state !== 'paused';
        btnStop.disabled = !['staging', 'running', 'paused'].includes(state);
    }

    function appendLog(level, text) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${text}`;
        logEntries.prepend(entry);
        // Keep max 50 entries
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
