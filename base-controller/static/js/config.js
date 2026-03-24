/* Config console — GCS routing + FC parameter management */

const Config = (() => {
    // --- GCS mode controls ---
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

    // --- Param map table ---
    const tbody = document.getElementById('param-map-tbody');
    let paramCache = {};  // heli_id -> param check result

    function renderParamRow(heliId, name, ip, expectedSysid) {
        const p = paramCache[heliId];
        if (!p) {
            return `<tr>
                <td>${name}</td><td>${ip}</td><td>${expectedSysid}</td>
                <td colspan="5" class="dim">Not checked yet</td>
                <td><span class="badge badge-warn">?</span></td>
                <td><button onclick="Config.loadParams(${heliId})">Check</button></td>
            </tr>`;
        }
        const paramCells = ['GPS1_TYPE', 'GPS_AUTO_CONFIG', 'SERIAL2_BAUD', 'SERIAL2_PROTOCOL', 'SYSID_THISMAV']
            .map(name => {
                const pp = p.params.find(x => x.param === name);
                if (!pp) return '<td class="dim">-</td>';
                const cls = pp.ok ? 'param-ok' : 'param-bad';
                const actual = pp.actual !== null ? pp.actual : '?';
                return `<td class="${cls}" title="Expected: ${pp.expected}">${actual}</td>`;
            }).join('');

        const statusBadge = p.all_ok
            ? '<span class="badge badge-online">OK</span>'
            : '<span class="badge badge-warn">MISMATCH</span>';

        const fixBtn = p.all_ok
            ? ''
            : `<button class="btn-fix" onclick="Config.fixParams(${heliId})">Fix All</button>`;

        return `<tr>
            <td>${name}</td><td>${ip}</td><td>${expectedSysid}</td>
            ${paramCells}
            <td>${statusBadge}</td>
            <td>${fixBtn}</td>
        </tr>`;
    }

    async function renderParamMap() {
        try {
            const r = await fetch('/api/fleet');
            const fleet = await r.json();
            tbody.innerHTML = fleet.map(h =>
                renderParamRow(h.id, h.name, h.ip, h.sysid)
            ).join('');
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="10">Error loading fleet</td></tr>';
        }
    }

    async function loadParams(heliId) {
        const detail = document.getElementById('param-detail');
        const title = document.getElementById('param-detail-title');
        title.style.display = 'block';
        detail.style.display = 'block';
        detail.innerHTML = `<p>Reading params from Heli${String(heliId).padStart(2,'0')}...</p>`;

        try {
            const r = await fetch(`/api/fleet/${heliId}/params`);
            const data = await r.json();
            paramCache[heliId] = data;

            title.textContent = `Parameter Details — ${data.name}`;

            let html = '<table class="param-detail-table"><thead><tr>' +
                '<th>Parameter</th><th>Expected</th><th>Actual</th><th>Status</th><th></th>' +
                '</tr></thead><tbody>';

            data.params.forEach(p => {
                const cls = p.ok ? 'param-ok' : 'param-bad';
                const icon = p.ok ? '✓' : '✗';
                const actual = p.actual !== null ? p.actual : 'NO RESPONSE';
                const sendBtn = p.ok ? '' :
                    `<button onclick="Config.sendParam(${heliId}, '${p.param}', ${p.expected})">Send ${p.expected}</button>`;
                html += `<tr class="${cls}">
                    <td>${p.param}</td><td>${p.expected}</td>
                    <td>${actual}</td><td>${icon}</td><td>${sendBtn}</td>
                </tr>`;
            });

            html += '</tbody></table>';

            if (!data.all_ok) {
                html += `<button class="btn-primary" onclick="Config.fixParams(${heliId})" style="margin-top:8px">Fix All Mismatched</button>`;
            }

            detail.innerHTML = html;
            renderParamMap();
        } catch (e) {
            detail.innerHTML = `<p class="error">Failed to read params: ${e.message}</p>`;
        }
    }

    async function sendParam(heliId, param, value) {
        try {
            const r = await fetch(`/api/fleet/${heliId}/params`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({param, value}),
            });
            const data = await r.json();
            if (r.ok) {
                alert(`${param} set to ${value} ✓`);
                loadParams(heliId);  // Refresh
            } else {
                alert(`Failed: ${data.detail}`);
            }
        } catch (e) {
            alert(`Error: ${e.message}`);
        }
    }

    async function fixParams(heliId) {
        const detail = document.getElementById('param-detail');
        detail.innerHTML = `<p>Fixing params on Heli${String(heliId).padStart(2,'0')}...</p>`;

        try {
            const r = await fetch(`/api/fleet/${heliId}/params/fix`, {method: 'POST'});
            const data = await r.json();

            let html = '<h4>Results:</h4><ul>';
            data.results.forEach(p => {
                const icon = p.status === 'ok' ? '✓' : p.status === 'set' ? '⟳' : '✗';
                html += `<li>${icon} ${p.param} = ${p.value} (${p.status})</li>`;
            });
            html += '</ul><p>Refreshing...</p>';
            detail.innerHTML = html;

            // Re-read to confirm
            setTimeout(() => loadParams(heliId), 2000);
        } catch (e) {
            detail.innerHTML = `<p class="error">Fix failed: ${e.message}</p>`;
        }
    }

    // Check all params for entire fleet
    document.getElementById('btn-check-all-params').addEventListener('click', async () => {
        const r = await fetch('/api/fleet');
        const fleet = await r.json();
        for (const h of fleet) {
            try {
                const pr = await fetch(`/api/fleet/${h.id}/params`);
                paramCache[h.id] = await pr.json();
            } catch (e) { /* skip offline */ }
        }
        renderParamMap();
    });

    // Initial render
    renderParamMap();

    return { loadParams, sendParam, fixParams };
})();
