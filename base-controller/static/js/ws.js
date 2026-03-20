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
