/* Fleet manager — add/remove/edit helis */

const Fleet = (() => {
    const tbody = document.getElementById('fleet-tbody');

    async function refresh() {
        try {
            const r = await fetch('/api/fleet');
            const helis = await r.json();
            tbody.innerHTML = helis.map(h => `
                <tr>
                    <td>${h.id}</td>
                    <td>${h.name}</td>
                    <td><code>${h.mac}</code></td>
                    <td>${h.ip}</td>
                    <td>${h.sysid}</td>
                    <td>${h.hub_port}</td>
                    <td>${h.status}</td>
                    <td><button class="btn-delete" onclick="Fleet.remove(${h.id})">Remove</button></td>
                </tr>
            `).join('');

            // Also update config page dropdown
            const sel = document.getElementById('config-heli-select');
            sel.innerHTML = helis.map(h =>
                `<option value="${h.id}">${h.name} (${h.ip})</option>`
            ).join('');
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="8">Error loading fleet</td></tr>';
        }
    }

    document.getElementById('btn-add-heli').addEventListener('click', async () => {
        const id = parseInt(document.getElementById('add-heli-id').value);
        const mac = document.getElementById('add-heli-mac').value.trim();
        const name = document.getElementById('add-heli-name').value.trim() || undefined;

        if (!id || !mac) { alert('Heli ID and MAC required'); return; }

        try {
            const r = await fetch('/api/fleet', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id, mac, name}),
            });
            if (!r.ok) {
                const err = await r.json();
                alert(`Error: ${err.detail}`);
                return;
            }
            document.getElementById('add-heli-id').value = '';
            document.getElementById('add-heli-mac').value = '';
            document.getElementById('add-heli-name').value = '';
            refresh();
            Dashboard.refresh();
        } catch (e) { alert('Failed to add heli'); }
    });

    async function remove(heliId) {
        if (!confirm(`Remove Heli ${heliId}?`)) return;
        await fetch(`/api/fleet/${heliId}`, {method: 'DELETE'});
        refresh();
        Dashboard.refresh();
    }

    document.getElementById('btn-apply').addEventListener('click', async () => {
        const btn = document.getElementById('btn-apply');
        btn.textContent = 'Applying...';
        btn.disabled = true;
        try {
            const r = await fetch('/api/fleet/apply', {method: 'POST'});
            const d = await r.json();
            alert(`Applied: ${JSON.stringify(d.details)}`);
        } catch (e) {
            alert('Apply failed');
        }
        btn.textContent = 'Apply Changes';
        btn.disabled = false;
    });

    refresh();
    return { refresh, remove };
})();
