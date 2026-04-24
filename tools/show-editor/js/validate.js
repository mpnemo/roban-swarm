// Port of ShowFile.validate_timing / validate_safety from the Pydantic
// model (base-controller/choreography/show_format.py). Matches the Python
// semantics exactly — linear interpolation, no hold awareness — because
// the editor model never carries hold_s (expanded on load).

/**
 * Check waypoint timing invariants: each wp.t <= duration_s and wp times
 * are ascending within a track. Returns a list of issue records.
 * @returns {{msg:string, heli_id:number, t:number}[]}
 */
export function validateTiming(show) {
  const issues = [];
  for (const track of show.tracks) {
    for (let i = 0; i < track.waypoints.length; i++) {
      const wp = track.waypoints[i];
      if (wp.t > show.duration_s) {
        issues.push({
          msg: `Heli${pad(track.heli_id)} wp[${i}] t=${fmt(wp.t)}s exceeds duration ${fmt(show.duration_s)}s`,
          heli_id: track.heli_id,
          t: wp.t,
        });
      }
      if (i > 0 && wp.t < track.waypoints[i - 1].t) {
        issues.push({
          msg: `Heli${pad(track.heli_id)} wp[${i}] t=${fmt(wp.t)}s is before wp[${i - 1}] t=${fmt(track.waypoints[i - 1].t)}s`,
          heli_id: track.heli_id,
          t: wp.t,
        });
      }
    }
  }
  return issues;
}

/**
 * Pairwise safety separation check during the show proper. For every
 * pair of tracks, sample each of their combined waypoint times and
 * compute the linear-interpolated 3D distance. Flag any below `minSepM`.
 * @returns {{msg:string, heli_ids:[number, number], t:number, dist:number}[]}
 */
export function validateSafety(show, minSepM = 3.0) {
  const warnings = [];
  const tracks = show.tracks;
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const t1 = tracks[i];
      const t2 = tracks[j];
      const timesSet = new Set();
      for (const w of t1.waypoints) timesSet.add(w.t);
      for (const w of t2.waypoints) timesSet.add(w.t);
      const times = [...timesSet].sort((a, b) => a - b);

      for (const t of times) {
        const p1 = posAt(t1, t);
        const p2 = posAt(t2, t);
        if (!p1 || !p2) continue;
        const dn = p1.n - p2.n;
        const de = p1.e - p2.e;
        const dd = p1.d - p2.d;
        const dist = Math.sqrt(dn * dn + de * de + dd * dd);
        if (dist < minSepM) {
          warnings.push({
            msg: `Heli${pad(t1.heli_id)} and Heli${pad(t2.heli_id)} within ${dist.toFixed(1)}m at t=${fmt(t)}s`,
            heli_ids: [t1.heli_id, t2.heli_id],
            t,
            dist,
          });
        }
      }
    }
  }
  return warnings;
}

/**
 * Lifecycle-wide safety: sample the intro and outro at regular intervals
 * and check pairwise separation. Uses an injected `positionAt(heli_id, t)`
 * function so callers can drive it via the Lifecycle helper.
 *
 * @param {object} show - the ShowModel's show object
 * @param {(heliId:number, t:number) => ({n,e,d}|null)} positionAt
 * @param {{introDuration:number, outroDuration:number}} timings
 * @param {number} minSepM - separation threshold (default 3.0)
 * @param {number} stepS - sample step (default 0.5s)
 * @returns {{msg:string, heli_ids:[number, number], t:number, dist:number, phase:"intro"|"outro"}[]}
 */
export function validateLifecycleSafety(show, positionAt, timings, minSepM = 3.0, stepS = 0.5) {
  const warnings = [];
  if (!timings) return warnings;
  const tracks = show.tracks;

  const sampleRange = (tStart, tEnd, phase) => {
    if (tEnd - tStart <= 0) return;
    // Worst-offender per heli-pair: only report the closest approach.
    const worst = new Map();
    for (let t = tStart; t <= tEnd; t += stepS) {
      for (let i = 0; i < tracks.length; i++) {
        for (let j = i + 1; j < tracks.length; j++) {
          const h1 = tracks[i].heli_id;
          const h2 = tracks[j].heli_id;
          const p1 = positionAt(h1, t);
          const p2 = positionAt(h2, t);
          if (!p1 || !p2) continue;
          const dn = p1.n - p2.n, de = p1.e - p2.e, dd = p1.d - p2.d;
          const dist = Math.sqrt(dn * dn + de * de + dd * dd);
          if (dist < minSepM) {
            const key = `${h1}:${h2}`;
            const cur = worst.get(key);
            if (!cur || dist < cur.dist) {
              worst.set(key, { h1, h2, t, dist });
            }
          }
        }
      }
    }
    for (const w of worst.values()) {
      warnings.push({
        msg: `Heli${pad(w.h1)} and Heli${pad(w.h2)} within ${w.dist.toFixed(1)}m during ${phase} at t=${fmt(w.t)}s`,
        heli_ids: [w.h1, w.h2],
        t: w.t,
        dist: w.dist,
        phase,
      });
    }
  };

  const introDur = timings.introDuration ?? 0;
  const outroDur = timings.outroDuration ?? 0;
  if (introDur > 0) sampleRange(-introDur, 0, "intro");
  if (outroDur > 0) {
    sampleRange(show.duration_s, show.duration_s + outroDur, "outro");
  }
  return warnings;
}

function posAt(track, t) {
  const wps = track.waypoints;
  if (!wps || !wps.length) return null;
  if (t <= wps[0].t) return wps[0].pos;
  for (let i = 0; i < wps.length - 1; i++) {
    if (wps[i].t <= t && t <= wps[i + 1].t) {
      const dt = wps[i + 1].t - wps[i].t;
      if (dt <= 0) return wps[i + 1].pos;
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
  return wps[wps.length - 1].pos;
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function pad(n) {
  return String(n).padStart(2, "0");
}
