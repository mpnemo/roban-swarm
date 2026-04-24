// Catmull-Rom spline through waypoint positions — used as a *visual aid*
// only. The flight daemon streams linear-interpolated targets, so the
// dashed curve shows intended shape, not actual flight path.
//
// Standard centripetal Catmull-Rom formula between P1 and P2:
//   P(t) = 0.5 * ((2*P1) + (-P0 + P2)*t + (2*P0 - 5*P1 + 4*P2 - P3)*t^2
//                 + (-P0 + 3*P1 - 3*P2 + P3)*t^3)
// For the first/last segment, phantom endpoints are reflected.

/**
 * Produce smoothed sample points through the given positions.
 * @param {{n:number, e:number, d:number}[]} pts
 * @param {number} samplesPerSegment how many intermediate samples per span
 * @returns {{n:number, e:number, d:number}[]}
 */
export function catmullRom(pts, samplesPerSegment = 16) {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? reflect(pts[0], pts[1]) : pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < n ? pts[i + 2] : reflect(pts[n - 1], pts[n - 2]);
    for (let k = 0; k < samplesPerSegment; k++) {
      const t = k / samplesPerSegment;
      out.push(sample(p0, p1, p2, p3, t));
    }
  }
  out.push({ ...pts[n - 1] });
  return out;
}

function sample(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const n =
    0.5 *
    (2 * p1.n +
      (-p0.n + p2.n) * t +
      (2 * p0.n - 5 * p1.n + 4 * p2.n - p3.n) * t2 +
      (-p0.n + 3 * p1.n - 3 * p2.n + p3.n) * t3);
  const e =
    0.5 *
    (2 * p1.e +
      (-p0.e + p2.e) * t +
      (2 * p0.e - 5 * p1.e + 4 * p2.e - p3.e) * t2 +
      (-p0.e + 3 * p1.e - 3 * p2.e + p3.e) * t3);
  const d =
    0.5 *
    (2 * p1.d +
      (-p0.d + p2.d) * t +
      (2 * p0.d - 5 * p1.d + 4 * p2.d - p3.d) * t2 +
      (-p0.d + 3 * p1.d - 3 * p2.d + p3.d) * t3);
  return { n, e, d };
}

// Mirror `anchor` across `neighbor` to invent a phantom endpoint.
function reflect(anchor, neighbor) {
  return {
    n: 2 * anchor.n - neighbor.n,
    e: 2 * anchor.e - neighbor.e,
    d: 2 * anchor.d - neighbor.d,
  };
}
