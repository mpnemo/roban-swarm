// Right-side editor tree: show meta, heli list, selected heli's style,
// waypoint list, and selected waypoint's numeric fields. Commits on
// change/blur/Enter so mid-typing doesn't thrash the canvas.

import { heliColor } from "./colors.js";

export class SidePanel {
  constructor(root, model) {
    this.root = root;
    this.model = model;
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

    this.root.innerHTML = [
      this._showSection(s),
      this._heliListSection(s, selTrack),
      selTrack ? this._trackDetailSection(selTrack, sel.waypointIdx) : "",
      selWp ? this._waypointDetailSection(selTrack, sel.waypointIdx, selWp) : "",
    ].join("");

    this._bindHandlers();
  }

  // --------- section builders ---------

  _showSection(s) {
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
        <p class="hint">home_lat/lon are informational — flight daemon captures real values at lineup.</p>
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

function num(inp) {
  const v = Number.parseFloat(inp.value);
  if (Number.isNaN(v)) throw new Error(`Invalid number: ${inp.value}`);
  return v;
}

function attr(s) {
  return String(s).replaceAll('"', "&quot;");
}

function pad(n) {
  return String(n).padStart(2, "0");
}
