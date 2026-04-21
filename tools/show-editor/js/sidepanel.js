// Right-side editor tree: show meta, heli list, selected heli's style,
// waypoint list, and selected waypoint's numeric fields. Commits on
// change/blur/Enter so mid-typing doesn't thrash the canvas.

import { heliColor } from "./colors.js";
import { validateTiming, validateSafety, validateLifecycleSafety } from "./validate.js";
import { Lifecycle } from "./lifecycle.js";

export class SidePanel {
  constructor(root, model) {
    this.root = root;
    this.model = model;
    this.lifecycle = new Lifecycle(model);
    model.on("show-changed", () => this.render());
    model.on("selection-changed", () => this.render());
    this.render();
  }

  render() {
    const s = this.model.show;
    if (!s) {
      this.root.innerHTML = `
        <div class="empty-state">
          <p>No show loaded.</p>
          <p class="hint">Click <b>New</b>, pick an example, or drop a show JSON on the window.</p>
        </div>
      `;
      return;
    }

    const sel = this.model.selection;
    const selTrack = sel.heliId != null ? this.model.getTrack(sel.heliId) : null;
    const selWp =
      selTrack && sel.waypointIdx != null
        ? selTrack.waypoints[sel.waypointIdx]
        : null;

    const timingErr = validateTiming(s);
    const safetyWarn = validateSafety(s);
    const lifecycleWarn = this.lifecycle.hasLineup()
      ? validateLifecycleSafety(
          s,
          (hid, t) => this.lifecycle.positionAt(hid, t),
          {
            introDuration: this.lifecycle.introDuration(),
            outroDuration: this.lifecycle.outroDuration(),
          },
        )
      : [];

    this.root.innerHTML = [
      this._validationSection(timingErr, safetyWarn, lifecycleWarn),
      this._showSection(s),
      this._lineupSection(s),
      this._heliListSection(s, selTrack),
      selTrack ? this._trackDetailSection(selTrack, sel.waypointIdx) : "",
      selWp ? this._waypointDetailSection(selTrack, sel.waypointIdx, selWp) : "",
    ].join("");

    this._bindHandlers();
  }

  // --------- section builders ---------

  _validationSection(timingErr, safetyWarn, lifecycleWarn = []) {
    const total = timingErr.length + safetyWarn.length + lifecycleWarn.length;
    if (total === 0) {
      return `
        <section class="pane-section validation-section">
          <h2>Validation <span class="ok-badge">OK</span></h2>
          <p class="hint">Timing, show safety, and lifecycle (intro/outro) all clean.</p>
        </section>
      `;
    }
    const items = [];
    for (const e of timingErr) {
      items.push(`
        <li class="err" data-jump-t="${e.t}" data-jump-heli="${e.heli_id}">
          <span class="chip err-chip">err</span>
          <span class="issue-text">${esc(e.msg)}</span>
        </li>
      `);
    }
    for (const w of safetyWarn) {
      const primary = w.heli_ids?.[0] ?? "";
      const helis = (w.heli_ids || []).join(",");
      items.push(`
        <li class="warn" data-jump-t="${w.t}" data-jump-heli="${primary}" data-jump-helis="${helis}">
          <span class="chip warn-chip">show</span>
          <span class="issue-text">${esc(w.msg)}</span>
        </li>
      `);
    }
    for (const w of lifecycleWarn) {
      const primary = w.heli_ids?.[0] ?? "";
      const helis = (w.heli_ids || []).join(",");
      items.push(`
        <li class="warn" data-jump-t="${w.t}" data-jump-heli="${primary}" data-jump-helis="${helis}">
          <span class="chip lifecycle-chip">${w.phase}</span>
          <span class="issue-text">${esc(w.msg)}</span>
        </li>
      `);
    }
    const errTxt = timingErr.length ? `<span class="err-badge">${timingErr.length} err</span>` : "";
    const warnTxt = (safetyWarn.length + lifecycleWarn.length)
      ? `<span class="warn-badge">${safetyWarn.length + lifecycleWarn.length} warn</span>`
      : "";
    return `
      <section class="pane-section validation-section">
        <h2>Validation ${errTxt} ${warnTxt}</h2>
        <ul class="validation-list">${items.join("")}</ul>
        <p class="hint">Click to jump. All warnings are soft — export not blocked.</p>
      </section>
    `;
  }

  _lineupSection(s) {
    const lineup = s.lineup;
    const tol = lineup?.tolerance_m ?? 1.0;
    const positions = lineup?.positions ?? {};
    const present = !!lineup && Object.keys(positions).length > 0;
    const trackRows = s.tracks.map((track) => {
      const p = positions[track.heli_id];
      const has = !!p;
      return `
        <div class="lineup-row" data-heli-id="${track.heli_id}">
          <span class="heli-swatch" style="background:${heliColor(track.heli_id)}"></span>
          <span class="heli-label">H${pad(track.heli_id)}</span>
          <input type="number" step="0.1" class="lineup-n" data-heli="${track.heli_id}" data-axis="n" value="${has ? p.n : ""}" placeholder="N" title="North (m)" />
          <input type="number" step="0.1" class="lineup-e" data-heli="${track.heli_id}" data-axis="e" value="${has ? p.e : ""}" placeholder="E" title="East (m)" />
          ${has
            ? `<button class="btn-mini btn-danger" data-clear-lineup="${track.heli_id}" title="Remove lineup for this heli">×</button>`
            : `<button class="btn-mini" data-set-lineup="${track.heli_id}" title="Place at (0,0)">+ set</button>`}
        </div>
      `;
    }).join("");

    return `
      <section class="pane-section">
        <h2>
          Lineup
          ${present
            ? `<span class="ok-badge">active</span>`
            : `<span class="hint" style="text-transform:none">optional</span>`}
          <button class="btn-mini" id="lineup-template-btn" title="Auto-arrange templates">templates…</button>
        </h2>
        <div class="field-row">
          <label>tolerance (m)</label>
          <input type="number" step="0.1" min="0" data-bind="lineup.tolerance_m" value="${tol}" />
        </div>
        <div class="lineup-list">${trackRows}</div>
        <p class="hint">Planned ground positions (d=0). Daemon captures real GPS at lineup — these drive the intro/outro preview + safety check. Drag the square markers on the canvas to reposition.</p>
        ${present ? `<div class="action-row"><button class="btn-mini btn-danger" id="lineup-clear-all">Clear lineup</button></div>` : ""}
      </section>
    `;
  }

  _showSection(s) {
    const off = s.show_offset ?? { n: 0, e: 0, d: 0 };
    const offActive = !!s.show_offset && (off.n !== 0 || off.e !== 0 || off.d !== 0);
    return `
      <section class="pane-section">
        <h2>Show</h2>
        <div class="field-row">
          <label>name</label>
          <input type="text" data-bind="show.name" value="${attr(s.name)}" />
        </div>
        <div class="field-row">
          <label>duration (s)</label>
          <input type="number" step="0.1" min="0.1" data-bind="show.duration_s" value="${s.duration_s}" />
        </div>
        <div class="field-row">
          <label>home lat</label>
          <input type="number" step="any" data-bind="show.home_lat" value="${s.home_lat}" />
        </div>
        <div class="field-row">
          <label>home lon</label>
          <input type="number" step="any" data-bind="show.home_lon" value="${s.home_lon}" />
        </div>
        <div class="field-row">
          <label>home alt (m)</label>
          <input type="number" step="any" data-bind="show.home_alt_m" value="${s.home_alt_m}" />
        </div>
        <p class="hint">home_lat/lon are informational — daemon captures real values at lineup.</p>
      </section>
      <section class="pane-section">
        <h2>Show offset (G54) ${offActive ? `<span class="ok-badge">active</span>` : `<span class="hint" style="text-transform:none">zero</span>`}</h2>
        <div class="field-row">
          <label>N (m)</label>
          <input type="number" step="0.1" data-bind="show.offset.n" value="${off.n}" />
        </div>
        <div class="field-row">
          <label>E (m)</label>
          <input type="number" step="0.1" data-bind="show.offset.e" value="${off.e}" />
        </div>
        <div class="field-row">
          <label>D (m)</label>
          <input type="number" step="0.1" data-bind="show.offset.d" value="${off.d}" />
        </div>
        <p class="hint">Added to every waypoint at daemon load. Waypoint numbers above stay in authored coords — the canvas shows the offset-applied result.</p>
        ${offActive ? `<div class="action-row"><button class="btn-mini" id="offset-clear">Clear offset</button></div>` : ""}
      </section>
    `;
  }

  _heliListSection(s, selTrack) {
    const rows = s.tracks
      .map((t) => {
        const selected = t === selTrack ? " selected" : "";
        return `
          <div class="heli-row${selected}" data-heli-id="${t.heli_id}">
            <span class="heli-swatch" style="background:${heliColor(t.heli_id)}"></span>
            <span class="heli-label">H${pad(t.heli_id)}</span>
            <span class="heli-wp-count">${t.waypoints.length} wp</span>
            <button class="btn-mini btn-danger" data-delete-heli="${t.heli_id}" title="Delete heli">×</button>
          </div>
        `;
      })
      .join("");
    return `
      <section class="pane-section">
        <h2>Helis <button class="btn-mini" id="add-heli" title="Add heli">+ add</button></h2>
        <div class="heli-list">${rows}</div>
      </section>
    `;
  }

  _trackDetailSection(track, selWpIdx) {
    const s = track.style;
    const wpRows = track.waypoints
      .map((w, i) => {
        const sel = i === selWpIdx ? " selected" : "";
        const altM = (-w.pos.d).toFixed(1);
        return `
          <div class="wp-row${sel}" data-wp-idx="${i}">
            <span class="wp-idx">${i}</span>
            <span class="wp-t">t=${w.t.toFixed(1)}s</span>
            <span class="wp-pos">N${w.pos.n.toFixed(1)} E${w.pos.e.toFixed(1)} ↑${altM}m</span>
          </div>
        `;
      })
      .join("");
    return `
      <section class="pane-section">
        <h2>Heli ${pad(track.heli_id)} · style</h2>
        <div class="field-row">
          <label>heli_id</label>
          <input type="number" step="1" min="1" max="99" data-bind="track.heli_id" value="${track.heli_id}" />
        </div>
        <div class="field-row">
          <label>max speed (m/s)</label>
          <input type="number" step="0.1" min="0.1" data-bind="style.max_speed" value="${s.max_speed}" />
        </div>
        <div class="field-row">
          <label>max accel (m/s²)</label>
          <input type="number" step="0.1" min="0.1" data-bind="style.max_accel" value="${s.max_accel}" />
        </div>
        <div class="field-row">
          <label>max jerk (m/s³)</label>
          <input type="number" step="0.1" min="0.1" data-bind="style.max_jerk" value="${s.max_jerk}" />
        </div>
        <div class="field-row">
          <label>max lean / bank (°)</label>
          <input type="number" step="1" min="1" max="60" data-bind="style.angle_max_deg" value="${s.angle_max_deg}" />
        </div>
        <div class="field-row">
          <label>corner radius (m)</label>
          <input type="number" step="0.1" min="0" data-bind="style.corner_radius" value="${s.corner_radius}" />
        </div>
      </section>
      <section class="pane-section">
        <h2>Waypoints <button class="btn-mini" id="add-wp" title="Add waypoint at current time">+ at time</button></h2>
        <div class="wp-list">${wpRows}</div>
      </section>
    `;
  }

  _waypointDetailSection(track, idx, wp) {
    const altM = -wp.pos.d;
    const hasVel = !!wp.vel;
    return `
      <section class="pane-section">
        <h2>Waypoint ${idx}</h2>
        <div class="field-row">
          <label>t (s)</label>
          <input type="number" step="0.1" min="0" data-bind="wp.t" value="${wp.t}" />
        </div>
        <div class="field-row">
          <label>N (m)</label>
          <input type="number" step="0.1" data-bind="wp.pos.n" value="${wp.pos.n}" />
        </div>
        <div class="field-row">
          <label>E (m)</label>
          <input type="number" step="0.1" data-bind="wp.pos.e" value="${wp.pos.e}" />
        </div>
        <div class="field-row">
          <label>alt AGL (m)</label>
          <input type="number" step="0.1" min="0" data-bind="wp.alt" value="${altM.toFixed(3)}" />
        </div>
        <div class="field-row checkbox-row">
          <label>
            <input type="checkbox" data-bind="wp.vel.enabled" ${hasVel ? "checked" : ""} />
            velocity hint
          </label>
        </div>
        ${hasVel ? `
          <div class="field-row">
            <label>vN (m/s)</label>
            <input type="number" step="0.1" data-bind="wp.vel.n" value="${wp.vel.n}" />
          </div>
          <div class="field-row">
            <label>vE (m/s)</label>
            <input type="number" step="0.1" data-bind="wp.vel.e" value="${wp.vel.e}" />
          </div>
          <div class="field-row">
            <label>vD (m/s)</label>
            <input type="number" step="0.1" data-bind="wp.vel.d" value="${wp.vel.d}" />
          </div>
        ` : ""}
        <div class="action-row">
          <button class="btn-mini" id="add-hold">+ hold here</button>
          <input type="number" step="0.1" min="0.1" id="hold-s" value="2" />
          <span class="hint">s</span>
        </div>
        <div class="action-row">
          <button class="btn-mini btn-danger" id="delete-wp">Delete waypoint</button>
        </div>
      </section>
    `;
  }

  // --------- event handlers ---------

  _bindHandlers() {
    // validation issue click → jump to t, select primary heli
    for (const li of this.root.querySelectorAll("[data-jump-t]")) {
      li.addEventListener("click", () => {
        const t = Number.parseFloat(li.dataset.jumpT);
        if (Number.isFinite(t)) this.model.setTime(t);
        const hid = Number.parseInt(li.dataset.jumpHeli ?? "", 10);
        if (Number.isInteger(hid) && this.model.getTrack(hid)) {
          // Find the waypoint at or nearest to t for that heli
          const track = this.model.getTrack(hid);
          let nearest = 0;
          let best = Infinity;
          for (let i = 0; i < track.waypoints.length; i++) {
            const d = Math.abs(track.waypoints[i].t - t);
            if (d < best) { best = d; nearest = i; }
          }
          this.model.select(hid, nearest);
        }
      });
    }

    // heli row click → select
    for (const row of this.root.querySelectorAll(".heli-row")) {
      row.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const id = Number(row.dataset.heliId);
        this.model.select(id, 0);
      });
    }
    // delete heli
    for (const btn of this.root.querySelectorAll("[data-delete-heli]")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.deleteHeli);
        if (!confirm(`Delete Heli${pad(id)} and all its waypoints?`)) return;
        try { this.model.removeTrack(id); } catch (err) { alert(err.message); }
      });
    }
    // add heli
    this.root.querySelector("#add-heli")?.addEventListener("click", () => {
      try { this.model.addTrack(); } catch (err) { alert(err.message); }
    });

    // show_offset clear
    this.root.querySelector("#offset-clear")?.addEventListener("click", () => {
      this.model.setShowOffset(null);
    });

    // lineup: per-row set/clear
    for (const btn of this.root.querySelectorAll("[data-set-lineup]")) {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.setLineup);
        this.model.setLineupPos(id, { n: 0, e: 0, d: 0 });
      });
    }
    for (const btn of this.root.querySelectorAll("[data-clear-lineup]")) {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.clearLineup);
        this.model.removeLineupPos(id);
      });
    }
    this.root.querySelector("#lineup-clear-all")?.addEventListener("click", () => {
      if (!confirm("Clear all planned lineup positions?")) return;
      this.model.setLineup(null);
    });

    // lineup n/e inputs — commit on change
    for (const inp of this.root.querySelectorAll(".lineup-n, .lineup-e")) {
      inp.addEventListener("change", () => {
        const id = Number(inp.dataset.heli);
        const axis = inp.dataset.axis;
        const v = Number.parseFloat(inp.value);
        if (!Number.isFinite(v)) return;
        const current = this.model.show.lineup?.positions?.[id] || { n: 0, e: 0, d: 0 };
        const next = { ...current, [axis]: v };
        this.model.setLineupPos(id, next);
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
      });
    }

    // lineup templates
    this.root.querySelector("#lineup-template-btn")?.addEventListener("click", () => {
      this._openLineupTemplates();
    });
    // wp row click → select
    for (const row of this.root.querySelectorAll(".wp-row")) {
      row.addEventListener("click", () => {
        const idx = Number(row.dataset.wpIdx);
        this.model.select(this.model.selection.heliId, idx);
      });
    }
    // add wp at current time
    this.root.querySelector("#add-wp")?.addEventListener("click", () => {
      const track = this.model.getSelectedTrack();
      if (!track) return;
      const t = this.model.time;
      const pos = this.model.interpolate(track, t) ?? { n: 0, e: 0, d: -5 };
      this.model.addWaypoint(track.heli_id, { t, pos });
    });
    // add hold
    this.root.querySelector("#add-hold")?.addEventListener("click", () => {
      const holdEl = this.root.querySelector("#hold-s");
      const holdS = Number.parseFloat(holdEl?.value ?? "");
      if (!(holdS > 0)) return;
      const sel = this.model.selection;
      try { this.model.addHold(sel.heliId, sel.waypointIdx, holdS); }
      catch (err) { alert(err.message); }
    });
    // delete selected wp
    this.root.querySelector("#delete-wp")?.addEventListener("click", () => {
      const sel = this.model.selection;
      try { this.model.removeWaypoint(sel.heliId, sel.waypointIdx); }
      catch (err) { alert(err.message); }
    });

    // Number/text inputs: commit on change/Enter.
    for (const inp of this.root.querySelectorAll("[data-bind]")) {
      if (inp.type === "checkbox") {
        inp.addEventListener("change", () => this._commit(inp));
      } else {
        inp.addEventListener("change", () => this._commit(inp));
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") inp.blur();
        });
      }
    }
  }

  _commit(inp) {
    const bind = inp.dataset.bind;
    const sel = this.model.selection;
    const track = this.model.getSelectedTrack();

    try {
      if (bind === "show.name") {
        this.model.updateShowMeta({ name: inp.value || "Untitled" });
      } else if (bind === "show.duration_s") {
        this.model.updateShowMeta({ duration_s: num(inp) });
      } else if (bind === "show.home_lat") {
        this.model.updateShowMeta({ home_lat: num(inp) });
      } else if (bind === "show.home_lon") {
        this.model.updateShowMeta({ home_lon: num(inp) });
      } else if (bind === "show.home_alt_m") {
        this.model.updateShowMeta({ home_alt_m: num(inp) });
      } else if (bind.startsWith("show.offset.")) {
        const axis = bind.slice("show.offset.".length);
        const current = this.model.show.show_offset ?? { n: 0, e: 0, d: 0 };
        const next = { ...current, [axis]: num(inp) };
        this.model.setShowOffset(next);
      } else if (bind === "lineup.tolerance_m") {
        const v = num(inp);
        if (v < 0) throw new Error("tolerance_m must be >= 0");
        this.model.setLineup({ tolerance_m: v });
      } else if (bind === "track.heli_id") {
        this.model.updateHeliId(track.heli_id, Number.parseInt(inp.value, 10));
      } else if (bind.startsWith("style.")) {
        const field = bind.slice("style.".length);
        this.model.updateStyle(track.heli_id, { [field]: num(inp) });
      } else if (bind === "wp.t") {
        this.model.updateWaypoint(track.heli_id, sel.waypointIdx, {
          t: num(inp),
        });
      } else if (bind === "wp.pos.n" || bind === "wp.pos.e") {
        const f = bind.slice("wp.pos.".length);
        this.model.updateWaypoint(track.heli_id, sel.waypointIdx, {
          pos: { [f]: num(inp) },
        });
      } else if (bind === "wp.alt") {
        this.model.updateWaypoint(track.heli_id, sel.waypointIdx, {
          pos: { d: -num(inp) },
        });
      } else if (bind === "wp.vel.enabled") {
        if (inp.checked) {
          this.model.updateWaypoint(track.heli_id, sel.waypointIdx, {
            vel: { n: 0, e: 0, d: 0 },
          });
        } else {
          this.model.updateWaypoint(track.heli_id, sel.waypointIdx, {
            vel: null,
          });
        }
      } else if (bind.startsWith("wp.vel.")) {
        const f = bind.slice("wp.vel.".length);
        this.model.updateWaypoint(track.heli_id, sel.waypointIdx, {
          vel: { [f]: num(inp) },
        });
      }
    } catch (err) {
      alert(err.message);
      this.render();
    }
  }
}

// --------- lineup templates ---------

// Shared across instances for the prompt-based template UI.
SidePanel.prototype._openLineupTemplates = function () {
  const tracks = this.model.show?.tracks ?? [];
  const N = tracks.length;
  if (N === 0) return;
  const name = prompt(
    `Auto-arrange ${N} heli(s) — choose a template:\n` +
    `  line       [spacing_m]\n` +
    `  grid       [rows cols] [spacing_m]\n` +
    `  circle     [radius_m]\n` +
    `  arc        [radius_m] [span_deg]\n\n` +
    `Examples:  "line 3"  |  "grid 2 4 2.5"  |  "circle 5"  |  "arc 6 120"`,
    "line 3",
  );
  if (!name) return;
  try {
    const positions = computeTemplate(name.trim(), N, tracks);
    const idMap = {};
    tracks
      .slice()
      .sort((a, b) => a.heli_id - b.heli_id)
      .forEach((t, i) => { idMap[t.heli_id] = positions[i]; });
    this.model.setLineup({
      positions: idMap,
      tolerance_m: this.model.show.lineup?.tolerance_m ?? 1.0,
    });
  } catch (err) {
    alert(err.message);
  }
};

function computeTemplate(spec, N, _tracks) {
  const parts = spec.split(/\s+/);
  const kind = parts[0].toLowerCase();
  const nums = parts.slice(1).map(Number);
  const positions = [];
  if (kind === "line") {
    const spacing = Number.isFinite(nums[0]) ? nums[0] : 3;
    const halfSpan = ((N - 1) * spacing) / 2;
    for (let i = 0; i < N; i++) {
      positions.push({ n: 0, e: -halfSpan + i * spacing, d: 0 });
    }
  } else if (kind === "grid") {
    const rows = Number.isFinite(nums[0]) ? Math.max(1, Math.floor(nums[0])) : 2;
    const cols = Number.isFinite(nums[1]) ? Math.max(1, Math.floor(nums[1])) : Math.ceil(N / rows);
    const spacing = Number.isFinite(nums[2]) ? nums[2] : 3;
    if (rows * cols < N) throw new Error(`grid ${rows}x${cols} = ${rows * cols} slots, but ${N} helis`);
    const halfN = ((rows - 1) * spacing) / 2;
    const halfE = ((cols - 1) * spacing) / 2;
    for (let i = 0; i < N; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      positions.push({ n: halfN - r * spacing, e: -halfE + c * spacing, d: 0 });
    }
  } else if (kind === "circle") {
    const radius = Number.isFinite(nums[0]) ? nums[0] : 5;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      positions.push({ n: radius * Math.cos(ang), e: radius * Math.sin(ang), d: 0 });
    }
  } else if (kind === "arc") {
    const radius = Number.isFinite(nums[0]) ? nums[0] : 6;
    const spanDeg = Number.isFinite(nums[1]) ? nums[1] : 120;
    const spanRad = (spanDeg * Math.PI) / 180;
    const start = -spanRad / 2;
    for (let i = 0; i < N; i++) {
      const frac = N === 1 ? 0.5 : i / (N - 1);
      const ang = start + frac * spanRad;
      // Arc facing north: 0 rad = south of origin, π/2 = east. Put helis
      // along an arc that curves away from the audience (south).
      positions.push({
        n: radius * Math.cos(ang) - radius,
        e: radius * Math.sin(ang),
        d: 0,
      });
    }
  } else {
    throw new Error(`Unknown template "${kind}". Try line / grid / circle / arc.`);
  }
  return positions.map((p) => ({
    n: Math.round(p.n * 100) / 100,
    e: Math.round(p.e * 100) / 100,
    d: 0,
  }));
}

function num(inp) {
  const v = Number.parseFloat(inp.value);
  if (Number.isNaN(v)) throw new Error(`Invalid number: ${inp.value}`);
  return v;
}

function attr(s) {
  return String(s).replaceAll('"', "&quot;");
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pad(n) {
  return String(n).padStart(2, "0");
}
