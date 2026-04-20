// Altitude-over-time view. Horizontal axis = time (0..duration_s).
// Vertical axis = altitude AGL in meters (positive up, 0 at takeoff).
// Under the hood alt = -d; the UI never exposes the sign flip.
//
// Interactions: click empty space (with heli selected) to insert a
// waypoint at the clicked (t, alt) — N/E inherit from the interpolated
// position. Drag a dot to edit both t and altitude; t clamped to the
// [prev, next] window to preserve ordering; snapped to 0.1s; alt
// clamped >= 0 (no burying the heli).

import { heliColor, speedColor } from "./colors.js";
import { catmullRom } from "./smoothing.js";

const BG = "#1a1a2e";
const GRID_MINOR = "#252538";
const GRID_GROUND = "#505070";
const AXIS_LABEL = "#707090";
const TIME_CURSOR = "#e94560";
const SEL_OUTLINE = "#e94560";

const MARGIN_L = 40;
const MARGIN_R = 12;
const MARGIN_T = 10;
const MARGIN_B = 20;

export class AltitudeView {
  constructor(canvasEl, model) {
    this.el = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.model = model;
    this.viewMaxAlt = 10;
    this.showSmooth = false;
    this._dpr = window.devicePixelRatio || 1;
    this._raf = null;
    this._drag = null;
    this._clickAdd = null;
    this._bindEvents();
    this._resize();
    this._scheduleRender();
  }

  setShowSmooth(on) {
    this.showSmooth = !!on;
    this._scheduleRender();
  }

  _size() { return { w: this.el.clientWidth, h: this.el.clientHeight }; }

  _resize() {
    const { w, h } = this._size();
    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    if (this.el.width !== Math.floor(w * dpr) ||
        this.el.height !== Math.floor(h * dpr)) {
      this.el.width = Math.floor(w * dpr);
      this.el.height = Math.floor(h * dpr);
    }
  }

  _plotArea() {
    const { w, h } = this._size();
    return {
      x0: MARGIN_L,
      y0: MARGIN_T,
      w: Math.max(1, w - MARGIN_L - MARGIN_R),
      h: Math.max(1, h - MARGIN_T - MARGIN_B),
    };
  }

  tToX(t) {
    const s = this.model.show;
    if (!s || s.duration_s <= 0) return MARGIN_L;
    const { x0, w } = this._plotArea();
    return x0 + (t / s.duration_s) * w;
  }
  xToT(x) {
    const s = this.model.show;
    if (!s || s.duration_s <= 0) return 0;
    const { x0, w } = this._plotArea();
    return ((x - x0) / w) * s.duration_s;
  }
  altToY(alt) {
    const { y0, h } = this._plotArea();
    return y0 + h - (alt / this.viewMaxAlt) * h;
  }
  yToAlt(y) {
    const { y0, h } = this._plotArea();
    return ((y0 + h - y) / h) * this.viewMaxAlt;
  }

  _bindEvents() {
    window.addEventListener("resize", () => {
      this._resize();
      this._scheduleRender();
    });
    this.model.on("show-changed", () => this._scheduleRender());
    this.model.on("selection-changed", () => this._scheduleRender());
    this.model.on("time-changed", () => this._scheduleRender());
    this.el.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
    this.el.addEventListener("pointermove", (ev) => this._onPointerMove(ev));
    this.el.addEventListener("pointerup", (ev) => this._onPointerUp(ev));
    this.el.addEventListener("pointercancel", (ev) => this._onPointerUp(ev));
  }

  _scheduleRender() {
    if (this._raf != null) return;
    this._raf = requestAnimationFrame(() => this._render());
  }

  _render() {
    this._raf = null;
    this._resize();
    const ctx = this.ctx;
    const dpr = this._dpr;
    const { w, h } = this._size();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    const show = this.model.show;
    if (!show) {
      ctx.fillStyle = AXIS_LABEL;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Altitude view — load a show to begin", w / 2, h / 2);
      return;
    }

    // Compute vertical scale from data (with 20% headroom, min 5m).
    let maxAlt = 5;
    for (const t of show.tracks) {
      for (const wp of t.waypoints) {
        const a = -wp.pos.d;
        if (a > maxAlt) maxAlt = a;
      }
    }
    this.viewMaxAlt = Math.max(5, Math.ceil(maxAlt * 1.2));

    this._drawGrid();
    if (this.showSmooth) {
      for (const track of show.tracks) this._drawSmoothOverlay(track);
    }
    for (const track of show.tracks) this._drawTrack(track);
    this._drawTimeCursor();
  }

  _drawSmoothOverlay(track) {
    const wps = track.waypoints;
    if (wps.length < 2) return;
    // For altitude, we sample (t, alt) as a 2D Catmull-Rom directly —
    // using position NED as the source would mis-shape the t axis. So
    // treat (t, -d) as the smoothing inputs by stuffing into a Vec3.
    const pts = wps.map((w) => ({ n: w.t, e: -w.pos.d, d: 0 }));
    const smooth = catmullRom(pts, 18);
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = heliColor(track.heli_id) + "aa";
    ctx.beginPath();
    const first = smooth[0];
    ctx.moveTo(this.tToX(first.n), this.altToY(first.e));
    for (let i = 1; i < smooth.length; i++) {
      const p = smooth[i];
      ctx.lineTo(this.tToX(p.n), this.altToY(p.e));
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawGrid() {
    const ctx = this.ctx;
    const s = this.model.show;
    const { x0, y0, w, h } = this._plotArea();

    let tStep = 5;
    if (s.duration_s > 120) tStep = 10;
    if (s.duration_s > 300) tStep = 30;

    ctx.strokeStyle = GRID_MINOR;
    ctx.lineWidth = 1;
    for (let t = 0; t <= s.duration_s + 0.001; t += tStep) {
      const x = Math.round(this.tToX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
    }

    let aStep = 2;
    if (this.viewMaxAlt > 30) aStep = 5;
    if (this.viewMaxAlt > 80) aStep = 10;

    for (let a = 0; a <= this.viewMaxAlt + 0.001; a += aStep) {
      const y = Math.round(this.altToY(a)) + 0.5;
      ctx.strokeStyle = a === 0 ? GRID_GROUND : GRID_MINOR;
      ctx.lineWidth = a === 0 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
    }

    // Labels
    ctx.fillStyle = AXIS_LABEL;
    ctx.font = "10px var(--font-mono), monospace";

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = 0; t <= s.duration_s + 0.001; t += tStep) {
      const x = this.tToX(t);
      ctx.fillText(`${t}s`, x, y0 + h + 3);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let a = 0; a <= this.viewMaxAlt + 0.001; a += aStep) {
      ctx.fillText(`${a}m`, x0 - 4, this.altToY(a));
    }
  }

  _drawTrack(track) {
    const ctx = this.ctx;
    const wps = track.waypoints;
    const col = heliColor(track.heli_id);
    const maxSpeed = track.style.max_speed || 1;
    const sel = this.model.selection;
    const isTrackSel = sel.heliId === track.heli_id;

    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      const dt = Math.max(0.001, b.t - a.t);
      const dn = b.pos.n - a.pos.n;
      const de = b.pos.e - a.pos.e;
      const dd = b.pos.d - a.pos.d;
      const speed = Math.sqrt(dn * dn + de * de + dd * dd) / dt;
      const ratio = speed / maxSpeed;
      const color =
        ratio > 1 ? "#ff1744" :
        speed < 1e-3 ? col + "66" :
        speedColor(ratio);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(this.tToX(a.t), this.altToY(-a.pos.d));
      ctx.lineTo(this.tToX(b.t), this.altToY(-b.pos.d));
      ctx.stroke();
    }

    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i];
      const x = this.tToX(wp.t);
      const y = this.altToY(-wp.pos.d);
      const isSel = isTrackSel && sel.waypointIdx === i;
      ctx.beginPath();
      ctx.arc(x, y, isSel ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? SEL_OUTLINE : col;
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  _drawTimeCursor() {
    const ctx = this.ctx;
    const { y0, h } = this._plotArea();
    const t = this.model.time;
    const x = this.tToX(t);
    ctx.strokeStyle = TIME_CURSOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + h);
    ctx.stroke();

    for (const track of this.model.show.tracks) {
      const p = this.model.interpolate(track, t);
      if (!p) continue;
      const y = this.altToY(-p.d);
      ctx.fillStyle = heliColor(track.heli_id);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // --------- interactions ---------

  _hitTest(px, py) {
    const s = this.model.show;
    if (!s) return null;
    const R = 8;
    for (let ti = s.tracks.length - 1; ti >= 0; ti--) {
      const track = s.tracks[ti];
      for (let wi = track.waypoints.length - 1; wi >= 0; wi--) {
        const wp = track.waypoints[wi];
        const wx = this.tToX(wp.t);
        const wy = this.altToY(-wp.pos.d);
        if (Math.hypot(wx - px, wy - py) < R) {
          return { heliId: track.heli_id, wpIdx: wi };
        }
      }
    }
    return null;
  }

  _onPointerDown(ev) {
    if (ev.button !== 0 || !this.model.show) return;
    const rect = this.el.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const hit = this._hitTest(px, py);
    ev.preventDefault();
    this.el.setPointerCapture(ev.pointerId);
    if (hit) {
      this.model.select(hit.heliId, hit.wpIdx);
      this._drag = { heliId: hit.heliId, wpIdx: hit.wpIdx };
    } else {
      this._clickAdd = { startPx: px, startPy: py };
    }
  }

  _onPointerMove(ev) {
    if (!this._drag) return;
    const rect = this.el.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const track = this.model.getTrack(this._drag.heliId);
    if (!track) return;
    const idx = this._drag.wpIdx;
    const prevT = idx > 0 ? track.waypoints[idx - 1].t : 0;
    const nextT = idx < track.waypoints.length - 1
      ? track.waypoints[idx + 1].t
      : this.model.show.duration_s;
    const t = clamp(this.xToT(px), prevT, nextT);
    const snapT = Math.round(t * 10) / 10;
    const alt = Math.max(0, this.yToAlt(py));
    this.model.updateWaypoint(this._drag.heliId, idx, {
      t: snapT,
      pos: { d: -alt },
    });
  }

  _onPointerUp(ev) {
    try { this.el.releasePointerCapture?.(ev.pointerId); } catch {}
    if (this._drag) { this._drag = null; return; }
    if (this._clickAdd) {
      const rect = this.el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const moved =
        Math.hypot(px - this._clickAdd.startPx, py - this._clickAdd.startPy) > 3;
      this._clickAdd = null;
      if (!moved) this._handleClickAdd(px, py);
    }
  }

  _handleClickAdd(px, py) {
    const selId = this.model.selection.heliId;
    const track = selId != null ? this.model.getTrack(selId) : null;
    if (!track) return;
    const { x0, w, y0, h } = this._plotArea();
    if (px < x0 || px > x0 + w || py < y0 || py > y0 + h) return;
    const t = clamp(this.xToT(px), 0, this.model.show.duration_s);
    const alt = Math.max(0, this.yToAlt(py));
    // N/E inherit from interpolated position at the clicked time.
    const interp = this.model.interpolate(track, t) ?? { n: 0, e: 0, d: -5 };
    this.model.addWaypoint(track.heli_id, {
      t: Math.round(t * 10) / 10,
      pos: { n: interp.n, e: interp.e, d: -alt },
    });
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
