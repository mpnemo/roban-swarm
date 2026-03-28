/* WebSocket client helper for Roban Swarm Controller */

const RobanWS = (() => {
    let ws = null;
    let listeners = [];
    let reconnectTimer = null;

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/ws/telemetry`;

        ws = new WebSocket(url);

        ws.onopen = () => {
            document.getElementById('connection-status').textContent = 'Connected';
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                listeners.forEach(fn => fn(data));
            } catch (e) { /* ignore parse errors */ }
        };

        ws.onclose = () => {
            document.getElementById('connection-status').textContent = 'Disconnected — reconnecting...';
            reconnectTimer = setTimeout(connect, 3000);
        };

        ws.onerror = () => { ws.close(); };
    }

    function onMessage(fn) { listeners.push(fn); }

    // Start connection
    connect();

    return { onMessage };
})();

/* Navigation */
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`page-${btn.dataset.page}`).classList.add('active');
    });
});

/* Fetch health periodically */
async function updateHealth() {
    try {
        const r = await fetch('/api/health');
        const d = await r.json();
        document.getElementById('uptime').textContent = `Uptime: ${Math.floor(d.uptime_s)}s`;
    } catch (e) { /* ignore */ }
}
setInterval(updateHealth, 10000);
updateHealth();

/* Sim mode toggle */
let _simMode = false;

async function toggleSimMode() {
    const endpoint = _simMode ? '/api/mode/real' : '/api/mode/sim';
    try {
        const r = await fetch(endpoint, { method: 'POST' });
        const d = await r.json();
        _simMode = d.sim_mode;
        updateSimBadge();
    } catch (e) { alert('Failed to toggle sim mode: ' + e.message); }
}

function updateSimBadge() {
    const btn = document.getElementById('btn-sim-toggle');
    const banner = document.getElementById('sim-banner');
    const resetBtn = document.getElementById('btn-reset-sim');
    if (_simMode) {
        btn.textContent = 'SIM';
        btn.className = 'badge badge-sim';
        banner.style.display = '';
        if (resetBtn) resetBtn.style.display = '';
    } else {
        btn.textContent = 'REAL';
        btn.className = 'badge badge-real';
        banner.style.display = 'none';
        if (resetBtn) resetBtn.style.display = 'none';
    }
}

async function resetSim() {
    try {
        const r = await fetch('/api/mode/sim/reset', { method: 'POST' });
        const d = await r.json();
        if (d.ok) {
            if (typeof Show !== 'undefined' && Show.appendLog)
                Show.appendLog('info', I18N.t('log_sim_reset'));
        } else {
            alert('Reset failed: ' + (d.error || 'unknown'));
        }
    } catch (e) { alert('Reset failed: ' + e.message); }
}

// Check initial sim mode
fetch('/api/mode').then(r => r.json()).then(d => {
    _simMode = d.sim_mode || false;
    updateSimBadge();
}).catch(() => {});
