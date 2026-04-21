// Show editor data model.
// Mirrors base-controller/choreography/show_format.py (Pydantic). The in-
// memory model never carries hold_s — it's expanded into waypoint pairs on
// load and never emitted on save. See DESIGN.md decision 6.

const STYLE_DEFAULTS = Object.freeze({
  max_speed: 5.0,
  max_accel: 2.0,
  max_jerk: 5.0,
  angle_max_deg: 30.0,
  corner_radius: 2.0,
});

class EventBus {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }
  emit(event, data) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (e) { console.error("listener error", e); }
    }
  }
}

export class ShowModel extends EventBus {
  constructor() {
    super();
    /** @type {object|null} */
    this.show = null;
    this.selection = { heliId: null, waypointIdx: null };
    this.time = 0;
    this.dirty = false;
  }

  // ------- lifecycle -------

  newShow(name = "Untitled show", duration_s = 60) {
    this.show = {
      name,
      version: 1,
      home_lat: 0,
      home_lon: 0,
      home_alt_m: 0,
      show_offset: null,
      sequencing: null,
      ops: null,
      lineup: null,
      duration_s,
      tracks: [
        {
          heli_id: 1,
          style: { ...STYLE_DEFAULTS },
          waypoints: [{ t: 0, pos: { n: 0, e: 0, d: -5 } }],
        },
      ],
    };
    this.selection = { heliId: 1, waypointIdx: 0 };
    this.time = 0;
    this.dirty = false;
    this.emit("show-changed");
  }

  /** Load from a JSON string. Throws Error with combined messages on failure. */
  loadJson(text) {
    const raw = JSON.parse(text);
    const { show, errors } = parseAndExpand(raw);
    if (errors.length) throw new Error(errors.join("\n"));
    this.show = show;
    const firstTrack = show.tracks[0];
    this.selection = { heliId: firstTrack?.heli_id ?? null, waypointIdx: 0 };
    this.time = 0;
    this.dirty = false;
    this.emit("show-changed");
  }

  /** Serialize to the exact shape Pydantic ShowFile accepts. */
  toJson() {
    if (!this.show) return null;
    const s = this.show;
    const out = {
      name: s.name,
      version: 1,
      home_lat: s.home_lat,
      home_lon: s.home_lon,
      home_alt_m: s.home_alt_m,
      duration_s: round(s.duration_s, 2),
      tracks: s.tracks.map((t) => ({
        heli_id: t.heli_id,
        style: {
          max_speed: t.style.max_speed,
          max_accel: t.style.max_accel,
          max_jerk: t.style.max_jerk,
          angle_max_deg: t.style.angle_max_deg,
          corner_radius: t.style.corner_radius,
        },
        waypoints: t.waypoints.map((w) => {
          const wp = {
            t: round(w.t, 2),
            pos: {
              n: round(w.pos.n, 3),
              e: round(w.pos.e, 3),
              d: round(w.pos.d, 3),
            },
          };
          if (w.vel) {
            wp.vel = {
              n: round(w.vel.n, 3),
              e: round(w.vel.e, 3),
              d: round(w.vel.d, 3),
            };
          }
          return wp;
        }),
      })),
    };
    // Emit optional show_offset when set.
    if (s.show_offset && (s.show_offset.n || s.show_offset.e || s.show_offset.d)) {
      out.show_offset = {
        n: round(s.show_offset.n, 3),
        e: round(s.show_offset.e, 3),
        d: round(s.show_offset.d, 3),
      };
    }
    // Emit optional sequencing when non-zero.
    if (s.sequencing) {
      const q = s.sequencing;
      if (q.startup_stagger_s || q.takeoff_stagger_s || q.landing_stagger_s) {
        out.sequencing = {
          startup_stagger_s: round(q.startup_stagger_s || 0, 2),
          takeoff_stagger_s: round(q.takeoff_stagger_s || 0, 2),
          landing_stagger_s: round(q.landing_stagger_s || 0, 2),
        };
      }
    }
    // Emit optional ops overrides (only fields the user actually set).
    if (s.ops && Object.keys(s.ops).length > 0) {
      const opsOut = {};
      for (const [k, v] of Object.entries(s.ops)) {
        if (typeof v === "number") opsOut[k] = round(v, 3);
      }
      if (Object.keys(opsOut).length > 0) out.ops = opsOut;
    }
    // Emit optional lineup when present.
    if (s.lineup && s.lineup.positions) {
      const entries = Object.entries(s.lineup.positions)
        .map(([hid, p]) => [hid, {
          n: round(p.n, 3), e: round(p.e, 3), d: round(p.d, 3),
        }]);
      if (entries.length > 0) {
        out.lineup = {
          positions: Object.fromEntries(entries),
          tolerance_m: round(s.lineup.tolerance_m ?? 1.0, 2),
        };
      }
    }
    return JSON.stringify(out, null, 2);
  }

  /**
   * Patch one ops override. Pass value = null to clear that field (fall
   * back to daemon default). Pass a number to override it.
   */
  setOpsOverride(key, value) {
    if (!this.show) return;
    const current = this.show.ops ? { ...this.show.ops } : {};
    if (value === null || value === undefined || Number.isNaN(value)) {
      delete current[key];
    } else {
      current[key] = value;
    }
    this.show.ops = Object.keys(current).length > 0 ? current : null;
    this.dirty = true;
    this.emit("show-changed");
  }

  /** Clear all ops overrides (fall back to daemon defaults). */
  clearOpsOverrides() {
    if (!this.show) return;
    this.show.ops = null;
    this.dirty = true;
    this.emit("show-changed");
  }

  /** Merge the sequencing block (patch). Pass null to clear. */
  setSequencing(seq) {
    if (!this.show) return;
    if (seq === null) {
      this.show.sequencing = null;
    } else {
      const current = this.show.sequencing || {
        startup_stagger_s: 0, takeoff_stagger_s: 0, landing_stagger_s: 0,
      };
      const merged = { ...current, ...seq };
      // Clamp non-negative
      for (const k of ["startup_stagger_s", "takeoff_stagger_s", "landing_stagger_s"]) {
        if (merged[k] < 0) merged[k] = 0;
      }
      const all_zero = !merged.startup_stagger_s && !merged.takeoff_stagger_s && !merged.landing_stagger_s;
      this.show.sequencing = all_zero ? null : merged;
    }
    this.dirty = true;
    this.emit("show-changed");
  }

  /** Set or clear the show_offset. Pass null to clear, or {n,e,d} to set. */
  setShowOffset(offset) {
    if (!this.show) return;
    if (!offset || (offset.n === 0 && offset.e === 0 && offset.d === 0)) {
      this.show.show_offset = null;
    } else {
      this.show.show_offset = {
        n: offset.n ?? 0, e: offset.e ?? 0, d: offset.d ?? 0,
      };
    }
    this.dirty = true;
    this.emit("show-changed");
  }

  // --------- lineup ---------

  /** Merge the lineup block (patch). Pass null to clear. */
  setLineup(lineup) {
    if (!this.show) return;
    if (lineup === null) {
      this.show.lineup = null;
    } else {
      const current = this.show.lineup || { positions: {}, tolerance_m: 1.0 };
      this.show.lineup = {
        positions: lineup.positions ? { ...lineup.positions } : current.positions,
        tolerance_m: lineup.tolerance_m ?? current.tolerance_m,
      };
    }
    this.dirty = true;
    this.emit("show-changed");
  }

  /** Set one heli's planned lineup position. Creates lineup block if absent. */
  setLineupPos(heliId, pos) {
    if (!this.show) return;
    const lineup = this.show.lineup || { positions: {}, tolerance_m: 1.0 };
    lineup.positions = {
      ...lineup.positions,
      [heliId]: { n: pos.n, e: pos.e, d: pos.d ?? 0 },
    };
    this.show.lineup = lineup;
    this.dirty = true;
    this.emit("show-changed");
  }

  /** Remove one heli's lineup position. */
  removeLineupPos(heliId) {
    if (!this.show?.lineup?.positions) return;
    const { [heliId]: _, ...rest } = this.show.lineup.positions;
    this.show.lineup = { ...this.show.lineup, positions: rest };
    this.dirty = true;
    this.emit("show-changed");
  }

  // ------- selection -------

  select(heliId, waypointIdx = null) {
    this.selection = { heliId, waypointIdx };
    this.emit("selection-changed");
  }

  getSelectedTrack() {
    return this.selection.heliId != null
      ? this.getTrack(this.selection.heliId)
      : null;
  }

  getSelectedWaypoint() {
    const t = this.getSelectedTrack();
    if (!t || this.selection.waypointIdx == null) return null;
    return t.waypoints[this.selection.waypointIdx] ?? null;
  }

  // ------- time / playback -------

  /**
   * Set the scrubber time. Allows any finite value — the lifecycle helper
   * caps the usable range to [-introDuration, duration_s + outroDuration].
   * Views are expected to clamp the thumb; the model just stores.
   */
  setTime(t) {
    if (!this.show) return;
    if (!Number.isFinite(t)) return;
    if (t === this.time) return;
    this.time = t;
    this.emit("time-changed");
  }

  // ------- tracks -------

  getTrack(heliId) {
    return this.show?.tracks.find((t) => t.heli_id === heliId) ?? null;
  }

  addTrack() {
    if (!this.show) return null;
    const existing = new Set(this.show.tracks.map((t) => t.heli_id));
    let hid = 1;
    while (existing.has(hid) && hid <= 99) hid++;
    if (hid > 99) throw new Error("All heli IDs 1..99 are in use");
    this.show.tracks.push({
      heli_id: hid,
      style: { ...STYLE_DEFAULTS },
      waypoints: [{ t: 0, pos: { n: 0, e: 0, d: -5 } }],
    });
    this.selection = { heliId: hid, waypointIdx: 0 };
    this.dirty = true;
    this.emit("show-changed");
    return hid;
  }

  removeTrack(heliId) {
    if (!this.show) return;
    if (this.show.tracks.length <= 1) {
      throw new Error("A show needs at least one heli track");
    }
    this.show.tracks = this.show.tracks.filter((t) => t.heli_id !== heliId);
    if (this.selection.heliId === heliId) {
      this.selection = {
        heliId: this.show.tracks[0].heli_id,
        waypointIdx: 0,
      };
    }
    this.dirty = true;
    this.emit("show-changed");
  }

  updateHeliId(oldId, newId) {
    newId = Number.parseInt(newId, 10);
    if (!Number.isInteger(newId) || newId < 1 || newId > 99) {
      throw new Error("heli_id must be an integer 1..99");
    }
    if (oldId !== newId && this.show.tracks.some((t) => t.heli_id === newId)) {
      throw new Error(`heli_id ${newId} already in use`);
    }
    const track = this.getTrack(oldId);
    if (!track) return;
    track.heli_id = newId;
    if (this.selection.heliId === oldId) this.selection.heliId = newId;
    this.dirty = true;
    this.emit("show-changed");
  }

  updateStyle(heliId, patch) {
    const track = this.getTrack(heliId);
    if (!track) return;
    const merged = { ...track.style, ...patch };
    assertStyle(merged);
    track.style = merged;
    this.dirty = true;
    this.emit("show-changed");
  }

  updateShowMeta(patch) {
    if (!this.show) return;
    if (patch.duration_s !== undefined && patch.duration_s <= 0) {
      throw new Error("duration_s must be > 0");
    }
    Object.assign(this.show, patch);
    this.dirty = true;
    this.emit("show-changed");
  }

  // ------- waypoints -------

  addWaypoint(heliId, wp) {
    const track = this.getTrack(heliId);
    if (!track) return -1;
    assertWaypoint(wp);
    const w = { t: wp.t, pos: { ...wp.pos } };
    if (wp.vel) w.vel = { ...wp.vel };
    let idx = track.waypoints.findIndex((x) => x.t > w.t);
    if (idx < 0) idx = track.waypoints.length;
    track.waypoints.splice(idx, 0, w);
    this.selection = { heliId, waypointIdx: idx };
    this.dirty = true;
    this.emit("show-changed");
    return idx;
  }

  removeWaypoint(heliId, idx) {
    const track = this.getTrack(heliId);
    if (!track) return;
    if (track.waypoints.length <= 1) {
      throw new Error(
        "Cannot remove the last waypoint on a track — remove the heli instead",
      );
    }
    track.waypoints.splice(idx, 1);
    if (this.selection.heliId === heliId) {
      this.selection.waypointIdx = Math.min(idx, track.waypoints.length - 1);
    }
    this.dirty = true;
    this.emit("show-changed");
  }

  /**
   * Partial update of a waypoint. Re-sorts track if `t` changes and keeps
   * the selection pointed at the same waypoint (by identity) after resort.
   */
  updateWaypoint(heliId, idx, patch) {
    const track = this.getTrack(heliId);
    if (!track) return;
    const wp = track.waypoints[idx];
    if (!wp) return;
    if (patch.t !== undefined) {
      if (patch.t < 0) throw new Error("t must be >= 0");
      wp.t = patch.t;
    }
    if (patch.pos) Object.assign(wp.pos, patch.pos);
    if (patch.vel !== undefined) {
      if (patch.vel === null) delete wp.vel;
      else wp.vel = { ...(wp.vel || { n: 0, e: 0, d: 0 }), ...patch.vel };
    }
    if (patch.t !== undefined) {
      track.waypoints.sort((a, b) => a.t - b.t);
      const newIdx = track.waypoints.indexOf(wp);
      if (
        this.selection.heliId === heliId &&
        this.selection.waypointIdx === idx
      ) {
        this.selection.waypointIdx = newIdx;
      }
    }
    this.dirty = true;
    this.emit("show-changed");
  }

  /**
   * Insert a paired hold waypoint after idx. The new waypoint shares the
   * same (n, e, d) and sits at t + holdS. Fails if it would overlap the
   * next waypoint.
   */
  addHold(heliId, afterIdx, holdS) {
    if (!(holdS > 0)) throw new Error("Hold duration must be > 0");
    const track = this.getTrack(heliId);
    if (!track) return;
    const wp = track.waypoints[afterIdx];
    if (!wp) return;
    const newT = wp.t + holdS;
    const next = track.waypoints[afterIdx + 1];
    if (next && newT >= next.t) {
      throw new Error(
        `Hold end (t=${newT.toFixed(2)}s) would overlap the next waypoint at t=${next.t.toFixed(2)}s`,
      );
    }
    if (this.show && newT > this.show.duration_s) {
      throw new Error(
        `Hold end (t=${newT.toFixed(2)}s) exceeds show duration (${this.show.duration_s}s)`,
      );
    }
    const holdWp = { t: newT, pos: { n: wp.pos.n, e: wp.pos.e, d: wp.pos.d } };
    track.waypoints.splice(afterIdx + 1, 0, holdWp);
    this.dirty = true;
    this.emit("show-changed");
  }

  // ------- offset helpers -------

  /** Current show_offset as a Vec3 (zeroes if unset). */
  getOffset() {
    const o = this.show?.show_offset;
    return o ? { n: o.n, e: o.e, d: o.d } : { n: 0, e: 0, d: 0 };
  }

  /** Authored → flown position (apply show_offset). */
  applyOffset(pos) {
    const o = this.getOffset();
    return { n: pos.n + o.n, e: pos.e + o.e, d: pos.d + o.d };
  }

  /** Flown → authored position (subtract show_offset). */
  removeOffset(pos) {
    const o = this.getOffset();
    return { n: pos.n - o.n, e: pos.e - o.e, d: pos.d - o.d };
  }

  // ------- interpolation helpers (linear, hold-free by construction) -------

  /** Interpolated NED position of a track at time t, offset applied. */
  interpolate(track, t) {
    const authored = posAt(track, t);
    return authored ? this.applyOffset(authored) : null;
  }

  /** Raw authored position (no offset) — for the edit UI. */
  interpolateAuthored(track, t) {
    return posAt(track, t);
  }

  /** Instantaneous velocity vector (NED m/s) at time t. */
  velAt(track, t) {
    const wps = track.waypoints;
    if (wps.length < 2) return { n: 0, e: 0, d: 0 };
    if (t <= wps[0].t || t >= wps[wps.length - 1].t) {
      return { n: 0, e: 0, d: 0 };
    }
    for (let i = 0; i < wps.length - 1; i++) {
      if (wps[i].t <= t && t <= wps[i + 1].t) {
        const dt = wps[i + 1].t - wps[i].t;
        if (dt <= 0) return { n: 0, e: 0, d: 0 };
        const p0 = wps[i].pos;
        const p1 = wps[i + 1].pos;
        return {
          n: (p1.n - p0.n) / dt,
          e: (p1.e - p0.e) / dt,
          d: (p1.d - p0.d) / dt,
        };
      }
    }
    return { n: 0, e: 0, d: 0 };
  }

  /** Scalar speed magnitude at time t. */
  speedAt(track, t) {
    const v = this.velAt(track, t);
    return Math.sqrt(v.n * v.n + v.e * v.e + v.d * v.d);
  }
}

// ------- parsing -------

/**
 * Parse a raw JSON value into the in-memory model and expand hold_s into
 * paired waypoints. Returns { show, errors }. If errors is non-empty,
 * show is partial and must not be adopted.
 */
function parseAndExpand(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { show: null, errors: ["Not a JSON object"] };
  }
  if (typeof raw.name !== "string" || !raw.name) {
    errors.push("Missing or invalid 'name'");
  }
  if (typeof raw.duration_s !== "number" || raw.duration_s <= 0) {
    errors.push("Missing or invalid 'duration_s' (must be > 0)");
  }
  if (!Array.isArray(raw.tracks) || raw.tracks.length < 1) {
    errors.push("Missing 'tracks' (need at least 1)");
  }
  if (errors.length) return { show: null, errors };

  const show = {
    name: raw.name,
    version: 1,
    home_lat: typeof raw.home_lat === "number" ? raw.home_lat : 0,
    home_lon: typeof raw.home_lon === "number" ? raw.home_lon : 0,
    home_alt_m: typeof raw.home_alt_m === "number" ? raw.home_alt_m : 0,
    show_offset: null,
    sequencing: null,
    ops: null,
    lineup: null,
    duration_s: raw.duration_s,
    tracks: [],
  };

  // Optional ops overrides (per-show overrides of daemon constants).
  if (raw.ops && typeof raw.ops === "object") {
    const allowed = [
      "hover_alt_m", "spool_time_s",
      "return_base_alt_m", "return_alt_step_m",
      "landing_descent_rate",
    ];
    const ops = {};
    for (const k of allowed) {
      if (typeof raw.ops[k] === "number") ops[k] = raw.ops[k];
    }
    if (Object.keys(ops).length > 0) show.ops = ops;
  }

  // Optional sequencing staggers
  if (raw.sequencing && typeof raw.sequencing === "object") {
    const seq = raw.sequencing;
    const get = (k) =>
      typeof seq[k] === "number" && seq[k] >= 0 ? seq[k] : 0;
    const startup = get("startup_stagger_s");
    const takeoff = get("takeoff_stagger_s");
    const landing = get("landing_stagger_s");
    if (startup || takeoff || landing) {
      show.sequencing = {
        startup_stagger_s: startup,
        takeoff_stagger_s: takeoff,
        landing_stagger_s: landing,
      };
    }
  }

  // Optional show_offset (G54-style, applied by daemon at load)
  if (raw.show_offset && typeof raw.show_offset === "object") {
    const o = raw.show_offset;
    if (typeof o.n === "number" && typeof o.e === "number" && typeof o.d === "number") {
      show.show_offset = { n: o.n, e: o.e, d: o.d };
    } else {
      errors.push("show_offset: must be {n, e, d}");
    }
  }

  // Optional lineup
  if (raw.lineup && typeof raw.lineup === "object") {
    const positions = {};
    const rawPos = raw.lineup.positions || {};
    for (const [k, v] of Object.entries(rawPos)) {
      const hid = Number.parseInt(k, 10);
      if (!Number.isInteger(hid) || hid < 1 || hid > 99) {
        errors.push(`lineup.positions: invalid heli_id key "${k}"`);
        continue;
      }
      if (!v || typeof v.n !== "number" || typeof v.e !== "number") {
        errors.push(`lineup.positions[${hid}]: must be {n, e, d}`);
        continue;
      }
      positions[hid] = {
        n: v.n,
        e: v.e,
        d: typeof v.d === "number" ? v.d : 0,
      };
    }
    show.lineup = {
      positions,
      tolerance_m: typeof raw.lineup.tolerance_m === "number"
        ? raw.lineup.tolerance_m : 1.0,
    };
  }

  const usedIds = new Set();
  for (let tIdx = 0; tIdx < raw.tracks.length; tIdx++) {
    const rt = raw.tracks[tIdx];
    const hid = rt?.heli_id;
    if (!Number.isInteger(hid) || hid < 1 || hid > 99) {
      errors.push(`track[${tIdx}]: heli_id must be integer 1..99`);
      continue;
    }
    if (usedIds.has(hid)) {
      errors.push(`track[${tIdx}]: duplicate heli_id ${hid}`);
      continue;
    }
    usedIds.add(hid);

    if (!Array.isArray(rt.waypoints) || rt.waypoints.length < 1) {
      errors.push(`heli ${hid}: waypoints must be non-empty`);
      continue;
    }

    const style = { ...STYLE_DEFAULTS, ...(rt.style || {}) };
    try {
      assertStyle(style);
    } catch (e) {
      errors.push(`heli ${hid} style: ${e.message}`);
      continue;
    }

    const waypoints = [];
    for (let wIdx = 0; wIdx < rt.waypoints.length; wIdx++) {
      const rw = rt.waypoints[wIdx];
      if (typeof rw?.t !== "number" || rw.t < 0) {
        errors.push(`heli ${hid} wp[${wIdx}]: t must be number >= 0`);
        continue;
      }
      if (!rw.pos || typeof rw.pos.n !== "number" ||
          typeof rw.pos.e !== "number" || typeof rw.pos.d !== "number") {
        errors.push(`heli ${hid} wp[${wIdx}]: pos must be {n, e, d}`);
        continue;
      }
      const wp = {
        t: rw.t,
        pos: { n: rw.pos.n, e: rw.pos.e, d: rw.pos.d },
      };
      if (rw.vel &&
          typeof rw.vel.n === "number" &&
          typeof rw.vel.e === "number" &&
          typeof rw.vel.d === "number") {
        wp.vel = { n: rw.vel.n, e: rw.vel.e, d: rw.vel.d };
      }
      waypoints.push(wp);

      const hold = typeof rw.hold_s === "number" ? rw.hold_s : 0;
      if (hold > 0) {
        const nextRaw = rt.waypoints[wIdx + 1];
        const nextT = nextRaw?.t;
        if (typeof nextT === "number" && wp.t + hold >= nextT) {
          errors.push(
            `heli ${hid} wp[${wIdx}]: hold_s=${hold} overlaps next waypoint at t=${nextT}`,
          );
          continue;
        }
        if (wp.t + hold > show.duration_s) {
          errors.push(
            `heli ${hid} wp[${wIdx}]: hold_s=${hold} extends past duration`,
          );
          continue;
        }
        waypoints.push({
          t: wp.t + hold,
          pos: { n: wp.pos.n, e: wp.pos.e, d: wp.pos.d },
        });
      }
    }

    // Order check after expansion
    for (let i = 1; i < waypoints.length; i++) {
      if (waypoints[i].t < waypoints[i - 1].t) {
        errors.push(`heli ${hid} wp[${i}]: t=${waypoints[i].t}s is before previous wp`);
      }
    }

    show.tracks.push({ heli_id: hid, style, waypoints });
  }

  return { show, errors };
}

function assertStyle(s) {
  if (!(s.max_speed > 0)) throw new Error("max_speed must be > 0");
  if (!(s.max_accel > 0)) throw new Error("max_accel must be > 0");
  if (!(s.max_jerk > 0)) throw new Error("max_jerk must be > 0");
  if (!(s.angle_max_deg > 0 && s.angle_max_deg <= 60)) {
    throw new Error("angle_max_deg must be in (0, 60]");
  }
  if (!(s.corner_radius >= 0)) throw new Error("corner_radius must be >= 0");
}

function assertWaypoint(wp) {
  if (typeof wp.t !== "number" || wp.t < 0) {
    throw new Error("waypoint.t must be a number >= 0");
  }
  if (!wp.pos || typeof wp.pos.n !== "number" ||
      typeof wp.pos.e !== "number" || typeof wp.pos.d !== "number") {
    throw new Error("waypoint.pos must be {n, e, d}");
  }
}

function posAt(track, t) {
  const wps = track.waypoints;
  if (!wps || !wps.length) return null;
  if (t <= wps[0].t) return { ...wps[0].pos };
  for (let i = 0; i < wps.length - 1; i++) {
    if (wps[i].t <= t && t <= wps[i + 1].t) {
      const dt = wps[i + 1].t - wps[i].t;
      if (dt <= 0) return { ...wps[i + 1].pos };
      const frac = (t - wps[i].t) / dt;
      const p0 = wps[i].pos;
      const p1 = wps[i + 1].pos;
      return {
        n: p0.n + (p1.n - p0.n) * frac,
        e: p0.e + (p1.e - p0.e) * frac,
        d: p0.d + (p1.d - p0.d) * frac,
      };
    }
  }
  return { ...wps[wps.length - 1].pos };
}

function round(v, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

export { STYLE_DEFAULTS, parseAndExpand };
