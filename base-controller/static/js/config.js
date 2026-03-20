/* Config console — route single heli to GCS */

const Config = (() => {
    document.getElementById('btn-connect-gcs').addEventListener('click', async () => {
        const heliId = parseInt(document.getElementById('config-heli-select').value);
        if (!heliId) { alert('Select a heli first'); return; }

        await fetch('/api/mode/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({heli: heliId}),
        });
        updateModeBadge();
        document.getElementById('config-telemetry').innerHTML =
            `<p>Heli ${heliId} routed to GCS. Connect Mission Planner to TCP 192.168.50.1:5760</p>`;
    });

    document.getElementById('btn-production').addEventListener('click', async () => {
        await fetch('/api/mode/production', {method: 'POST'});
        updateModeBadge();
        document.getElementById('config-telemetry').innerHTML =
            '<p>Production mode — GCS forwarding stopped.</p>';
    });
})();
