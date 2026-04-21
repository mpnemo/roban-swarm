// Intro / outro position model — mirrors base-controller/choreography/
// flight_daemon.py lifecycle so the editor can preview and validate the
// full show including takeoff, staging, return, and descent.
//
// All constants come from flight_daemon.py defaults. Task 4 will let
// show.ops override them per show. Tasks 3 will honor show.sequencing
// for staggered startup / takeoff / landing.

// Daemon constants — keep in sync with flight_daemon.py
export const DAEMON_DEFAULTS = Object.freeze({
  HOVER_ALT_M: 5.0,               // takeoff + staging cruise altitude
  SPOOL_TIME_S: 8.0,              // rotor spool-up after arm
  RETURN_BASE_ALT_M: 8.0,         // first heli's return altitude
  RETURN_ALT_STEP_M: 3.0,         // +m per heli index
  LANDING_DESCENT_RATE: 1.0,      // m/s during controlled descent

  // Editor-only estimates (daemon doesn't fix these — ArduPilot's
  // WPNAV_SPEED governs actual speed)
  STAGING_SPEED_M_S: 4.0,         // horizontal during staging/return
  VERTICAL_SPEED_M_S: 2.0,        // vertical takeoff/climb
});

export class Lifecycle {
  constructor(model) {
    this.model = model;
    // Cache keyed on show-version so we don't recompute on every render
    this._cache = null;
    this._cacheKey = null;
    model.on("show-changed", () => { this._cache = null; this._cacheKey = null; });
  }

  // ---------- overrides & lookups ----------

  _ops() {
    const o = this.model.show?.ops ?? {};
    return {
      HOVER_ALT_M: o.hover_alt_m ?? DAEMON_DEFAULTS.HOVER_ALT_M,
      SPOOL_TIME_S: o.spool_time_s ?? DAEMON_DEFAULTS.SPOOL_TIME_S,
      RETURN_BASE_ALT_M: o.return_base_alt_m ?? DAEMON_DEFAULTS.RETURN_BASE_ALT_M,
      RETURN_ALT_STEP_M: o.return_alt_step_m ?? DAEMON_DEFAULTS.RETURN_ALT_STEP_M,
      LANDING_DESCENT_RATE: o.landing_descent_rate ?? DAEMON_DEFAULTS.LANDING_DESCENT_RATE,
      STAGING_SPEED_M_S: DAEMON_DEFAULTS.STAGING_SPEED_M_S,
      VERTICAL_SPEED_M_S: DAEMON_DEFAULTS.VERTICAL_SPEED_M_S,
    };
  }

  _sequencing() {
    // Task 3 will read show.sequencing; for now, zero staggers.
    const s = this.model.show?.sequencing ?? {};
    return {
      startup_stagger_s: s.startup_stagger_s ?? 0,
      takeoff_stagger_s: s.takeoff_stagger_s ?? 0,
      landing_stagger_s: s.landing_stagger_s ?? 0,
    };
  }

  hasLineup() {
    const p = this.model.show?.lineup?.positions;
    return !!(p && Object.keys(p).length > 0);
  }

  /** Planned ground position for a heli, or null. */
  lineupPos(heli_id) {
    const p = this.model.show?.lineup?.positions?.[heli_id];
    return p ? { n: p.n, e: p.e, d: 0 } : null;
  }

  /** Heli index (0..N-1) by sorted heli_id — same ordering as the daemon. */
  heliIndex(heli_id) {
    if (!this.model.show) return -1;
    const ids = this.model.show.tracks
      .map((t) => t.heli_id)
      .sort((a, b) => a - b);
    return ids.indexOf(heli_id);
  }

  heliCount() {
    return this.model.show?.tracks.length ?? 0;
  }

  // ---------- phase timings ----------

  /**
   * Per-heli intro timing. Each heli ends its intro at t=0. Phase
   * durations are computed from positions; per-heli delays come from
   * stagger fields. Returns null if no lineup.
   */
  introTimings() {
    if (!this.hasLineup()) return null;
    this._buildCacheIfStale();
    return this._cache?.intro ?? null;
  }

  outroTimings() {
    if (!this.hasLineup()) return null;
    this._buildCacheIfStale();
    return this._cache?.outro ?? null;
  }

  /**
   * Total intro duration. The scrubber extends from -introDuration to
   * (duration + outroDuration).
   */
  introDuration() {
    const t = this.introTimings();
    return t ? t.duration : 0;
  }

  outroDuration() {
    const t = this.outroTimings();
    return t ? t.duration : 0;
  }

  // ---------- position at global time ----------

  /**
   * Get a heli's position at any time on the extended timeline.
   * globalT < 0: intro phase.
   * 0 <= globalT <= duration_s: show playback (linear interp).
   * globalT > duration_s: outro phase.
   * Returns null if the heli has no lineup and we're outside [0, duration_s].
   */
  positionAt(heli_id, globalT) {
    const show = this.model.show;
    if (!show) return null;
    const track = this.model.getTrack(heli_id);
    if (!track) return null;
    if (globalT >= 0 && globalT <= show.duration_s) {
      return this.model.interpolate(track, globalT);
    }
    if (!this.hasLineup()) return null;
    if (globalT < 0) return this._introPosAt(heli_id, globalT);
    return this._outroPosAt(heli_id, globalT - show.duration_s);
  }

  // ---------- internals ----------

  _buildCacheIfStale() {
    const show = this.model.show;
    if (!show) { this._cache = null; return; }
    const key = JSON.stringify({
      // cheap version-ish key — not perfect but fine at v1 scale
      tracks: show.tracks.map((t) => ({
        id: t.heli_id,
        first: t.waypoints[0]?.pos,
        last: t.waypoints[t.waypoints.length - 1]?.pos,
      })),
      lineup: show.lineup?.positions,
      seq: show.sequencing,
      ops: show.ops,
    });
    if (key === this._cacheKey) return;
    this._cacheKey = key;

    if (!this.hasLineup()) {
      this._cache = { intro: null, outro: null };
      return;
    }

    const ops = this._ops();
    const seq = this._sequencing();
    const ids = show.tracks
      .map((t) => t.heli_id)
      .sort((a, b) => a - b);

    // --- INTRO ---
    // Phase lengths per heli (each phase starts with some global stagger).
    const intro = { perHeli: {}, duration: 0 };
    // Global phase endpoints (all helis sync up at each phase boundary):
    // 1. spool: each heli arms at idx*startup_stagger then spools spool_time.
    //    Global spool complete = max(idx)*startup_stagger + spool_time.
    const maxIdx = ids.length - 1;
    const spoolEndGlobal = maxIdx * seq.startup_stagger_s + ops.SPOOL_TIME_S;
    // 2. takeoff: each heli begins climb at idx*takeoff_stagger after spool end.
    //    Per-heli takeoff duration depends on hover_alt and vertical speed (constant).
    const takeoffDuration = ops.HOVER_ALT_M / ops.VERTICAL_SPEED_M_S;
    // Global takeoff complete = spool end + max takeoff delay + takeoff duration
    const takeoffEndGlobal =
      spoolEndGlobal + maxIdx * seq.takeoff_stagger_s + takeoffDuration;

    // 3. horizontal traverse + descent — per heli, starts once heli is at
    //    hover altitude. For simplicity, all traverse simultaneously once
    //    the latest heli is airborne. Horizontal time depends on distance.
    const traverseInfo = {};
    let maxTraverseTime = 0;
    for (const id of ids) {
      const track = this.model.getTrack(id);
      const wp0raw = track.waypoints[0]?.pos;
      const wp0 = wp0raw ? this.model.applyOffset(wp0raw) : null;
      const lineup = this.lineupPos(id);
      if (!wp0 || !lineup) { traverseInfo[id] = null; continue; }
      const dist = Math.hypot(wp0.n - lineup.n, wp0.e - lineup.e);
      const traverseT = dist / ops.STAGING_SPEED_M_S;
      // descent: from hover alt to wp0.d (alt = -wp0.d meters above ground)
      const descentDepth = Math.abs(wp0.d - -ops.HOVER_ALT_M);
      const descentT = descentDepth / ops.VERTICAL_SPEED_M_S;
      traverseInfo[id] = { dist, traverseT, descentT };
      if (traverseT > maxTraverseTime) maxTraverseTime = traverseT;
    }
    const traverseEndGlobal = takeoffEndGlobal + maxTraverseTime;
    let maxDescentT = 0;
    for (const id of ids) {
      const t = traverseInfo[id]?.descentT ?? 0;
      if (t > maxDescentT) maxDescentT = t;
    }
    const descentEndGlobal = traverseEndGlobal + maxDescentT;

    intro.duration = descentEndGlobal;

    // Per-heli absolute phase endpoints within the intro
    for (const id of ids) {
      const idx = ids.indexOf(id);
      const ti = traverseInfo[id];
      if (!ti) continue;
      // All times RELATIVE to intro start (0 = first event, introDuration = t=0 show)
      const spoolStart = idx * seq.startup_stagger_s;
      const spoolEnd = spoolStart + ops.SPOOL_TIME_S;
      const takeoffStart = spoolEndGlobal + idx * seq.takeoff_stagger_s;
      const takeoffEnd = takeoffStart + takeoffDuration;
      const traverseEnd = takeoffEndGlobal; // hold at wp0_xy_at_hover if early
      const heliTraverseEnd = takeoffEndGlobal - (maxTraverseTime - ti.traverseT);
      // (Faster heli arrives earlier than takeoffEndGlobal; holds until
      //  descentStart at takeoffEndGlobal below.)
      // Simpler: let helis traverse starting at takeoffEndGlobal (once all
      //  airborne) and take traverseT each — faster helis finish sooner and
      //  hold.
      const traverseStart = takeoffEndGlobal;
      const heliTraverseEndAligned = traverseStart + ti.traverseT;
      const descentStart = traverseEndGlobal; // all descend after slowest done
      const descentEnd = descentStart + ti.descentT;
      intro.perHeli[id] = {
        spoolStart, spoolEnd,
        takeoffStart, takeoffEnd,
        traverseStart, traverseEnd: heliTraverseEndAligned,
        descentStart, descentEnd,
      };
    }

    // --- OUTRO ---
    // Phase 1: RETURN — all helis simultaneously fly from wp[-1] to their home
    //          (lineup.n, lineup.e) at their staggered return altitude.
    // Phase 2: DESCENT — each heli descends from its return altitude to ground,
    //          with landing_stagger_s delay between helis.
    const outro = { perHeli: {}, duration: 0 };
    // Estimate return time: max over all helis of distance / speed.
    let maxReturnT = 0;
    const returnInfo = {};
    for (const id of ids) {
      const idx = ids.indexOf(id);
      const track = this.model.getTrack(id);
      const wpNraw = track.waypoints[track.waypoints.length - 1]?.pos;
      const wpN = wpNraw ? this.model.applyOffset(wpNraw) : null;
      const lineup = this.lineupPos(id);
      if (!wpN || !lineup) { returnInfo[id] = null; continue; }
      const returnAlt = ops.RETURN_BASE_ALT_M + idx * ops.RETURN_ALT_STEP_M;
      // Return target in NED: home xy, altitude returnAlt meters up (d = -returnAlt)
      const target = { n: lineup.n, e: lineup.e, d: -returnAlt };
      const dist = Math.sqrt(
        (target.n - wpN.n) ** 2 + (target.e - wpN.e) ** 2 + (target.d - wpN.d) ** 2,
      );
      const returnT = dist / ops.STAGING_SPEED_M_S;
      if (returnT > maxReturnT) maxReturnT = returnT;
      returnInfo[id] = { returnAlt, target, returnT };
    }
    const returnEndGlobal = maxReturnT;

    // Descent: each heli descends landing_stagger_s after the previous.
    let lastDescentEnd = 0;
    for (const id of ids) {
      const idx = ids.indexOf(id);
      const info = returnInfo[id];
      if (!info) continue;
      const descentStart = returnEndGlobal + idx * seq.landing_stagger_s;
      const descentT = info.returnAlt / ops.LANDING_DESCENT_RATE;
      const descentEnd = descentStart + descentT;
      if (descentEnd > lastDescentEnd) lastDescentEnd = descentEnd;
      outro.perHeli[id] = {
        returnStart: 0,
        returnEnd: info.returnT,    // individual return completion (may be < returnEndGlobal)
        holdUntilDescent: descentStart,
        descentStart,
        descentEnd,
        returnAlt: info.returnAlt,
        target: info.target,
      };
    }
    outro.duration = lastDescentEnd;

    this._cache = { intro, outro };
  }

  _introPosAt(heli_id, globalT) {
    const intro = this.introTimings();
    if (!intro) return null;
    const lineup = this.lineupPos(heli_id);
    const track = this.model.getTrack(heli_id);
    const wp0raw = track?.waypoints[0]?.pos;
    const wp0 = wp0raw ? this.model.applyOffset(wp0raw) : null;
    const per = intro.perHeli[heli_id];
    if (!lineup || !wp0 || !per) return null;

    const ops = this._ops();
    // Convert globalT (negative) to intro-relative time (0 = intro start).
    const relT = globalT + intro.duration;

    // Pre-spool / spool / waiting for takeoff: on the ground at lineup.
    if (relT < per.takeoffStart) return { ...lineup };
    // Takeoff: vertical 0 → -hover
    if (relT < per.takeoffEnd) {
      const frac = (relT - per.takeoffStart) /
                   Math.max(1e-6, per.takeoffEnd - per.takeoffStart);
      return { n: lineup.n, e: lineup.e, d: -ops.HOVER_ALT_M * frac };
    }
    // Wait at hover over lineup until traverse begins
    if (relT < per.traverseStart) {
      return { n: lineup.n, e: lineup.e, d: -ops.HOVER_ALT_M };
    }
    // Horizontal traverse at hover_alt
    if (relT < per.traverseEnd) {
      const frac = (relT - per.traverseStart) /
                   Math.max(1e-6, per.traverseEnd - per.traverseStart);
      return {
        n: lineup.n + (wp0.n - lineup.n) * frac,
        e: lineup.e + (wp0.e - lineup.e) * frac,
        d: -ops.HOVER_ALT_M,
      };
    }
    // Hold at wp0 xy at hover until descent
    if (relT < per.descentStart) {
      return { n: wp0.n, e: wp0.e, d: -ops.HOVER_ALT_M };
    }
    // Descent to wp0.d
    if (relT < per.descentEnd) {
      const frac = (relT - per.descentStart) /
                   Math.max(1e-6, per.descentEnd - per.descentStart);
      return {
        n: wp0.n,
        e: wp0.e,
        d: -ops.HOVER_ALT_M + (wp0.d - -ops.HOVER_ALT_M) * frac,
      };
    }
    return { ...wp0 };
  }

  _outroPosAt(heli_id, relT) {
    const outro = this.outroTimings();
    if (!outro) return null;
    const lineup = this.lineupPos(heli_id);
    const track = this.model.getTrack(heli_id);
    const wpNraw = track?.waypoints[track.waypoints.length - 1]?.pos;
    const wpN = wpNraw ? this.model.applyOffset(wpNraw) : null;
    const per = outro.perHeli[heli_id];
    if (!lineup || !wpN || !per) return null;

    // Phase 1: return from wpN → (lineup.n, lineup.e, -returnAlt)
    if (relT < per.returnEnd) {
      const frac = relT / Math.max(1e-6, per.returnEnd);
      return {
        n: wpN.n + (per.target.n - wpN.n) * frac,
        e: wpN.e + (per.target.e - wpN.e) * frac,
        d: wpN.d + (per.target.d - wpN.d) * frac,
      };
    }
    // Hold at return target until descent starts
    if (relT < per.descentStart) {
      return { ...per.target };
    }
    // Descent: from -returnAlt to 0 at LANDING_DESCENT_RATE
    if (relT < per.descentEnd) {
      const frac = (relT - per.descentStart) /
                   Math.max(1e-6, per.descentEnd - per.descentStart);
      return {
        n: per.target.n,
        e: per.target.e,
        d: per.target.d + (0 - per.target.d) * frac,
      };
    }
    return { n: per.target.n, e: per.target.e, d: 0 };
  }
}
