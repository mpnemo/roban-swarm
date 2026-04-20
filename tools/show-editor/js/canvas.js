// Top-down N/E canvas: grid, origin, per-heli trajectory polylines (speed-
// graded), waypoint dots, and a live marker at model.time. Pan + zoom.
// No click-to-add / drag interactions yet — those land in chunk 3.

import { heliColor, speedColor } from "./colors.js";
import { catmullRom } from "./smoothing.js";

const MIN_SCALE = 2;       // px/m — zoomed all the way out
const MAX_SCALE = 400;     // px/m — zoomed all the way in
const BG = "#1a1a2e";
const GRID_MINOR = "#252538";
const GRID_MAJOR = "#353553";
const GRID_LABEL = "#707090";
const ORIGIN_COL = "#e0e0e0";
const WP_DOT_RADIUS = 4;
const HOLD_DOT_RADIUS = 6;
const SELECTED_OUTLINE = "#e94560";

export class TopdownCanvas {
  /**
   * @param {HTMLCanvasElement} canvasEl
   * @param {import("./model.js").ShowModel} model
   */
  constructor(canvasEl, model) {
    this.el = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.model = model;
    this.view = { centerN: 0, centerE: 0, scale: 20 };
    this.showSmooth = false; // dashed Catmull-Rom overlay, planning aid only
    this._dpr = window.devicePixelRatio || 1;
    this._raf = null;
    this._pan = null;
    this._bindEvents();
    this._resize();
    this._scheduleRender();
  }

  setShowSmooth(on) {
    this.showSmooth = !!on;
    this._scheduleRender();
  }

  // --------- public ---------

  /** Center the view on all current waypoints, fitting them with margin. */
  fitAll() {
    const s = this.model.show;
    if (!s || s.tracks.length === 0) return;
    let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
    for (const t of s.tracks) {
      for (const w of t.waypoints) {
        if (w.pos.n < minN) minN = w.pos.n;
        if (w.pos.n > maxN) maxN = w.pos.n;
        if (w.pos.e < minE) minE = w.pos.e;
        if (w.pos.e > maxE) maxE = w.pos.e;
      }
    }
    if (!isFinite(minN)) return;
    const spanN = Math.max(1, maxN - minN);
    const spanE = Math.max(1, maxE - minE);
    this.view.centerN = (minN + maxN) / 2;
    this.view.centerE = (minE + maxE) / 2;
    const { w, h } = this._size();
    // 20% margin all around
    const scaleN = (h * 0.8) / spanN;
    const scaleE = (w * 0.8) / spanE;
    this.view.scale = clamp(Math.min(scaleN, scaleE), MIN_SCALE, MAX_SCALE);
    this._scheduleRender();
  }

  /** Convert a mouse event client-coord to world NE. */
  clientToNE(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    return this.screenToNE(clientX - rect.left, clientY - rect.top);
  }

  screenToNE(x, y) {
    const { w, h } = this._size();
    return {
      n: this.view.centerN - (y - h / 2) / this.view.scale,
      e: this.view.centerE + (x - w / 2) / this.view.scale,
    };
  }

  neToScreen(n, e) {
    const { w, h } = this._size();
    return {
      x: w / 2 + (e - this.view.centerE) * this.view.scale,
      y: h / 2 - (n - this.view.centerN) * this.view.scale,
    };
  }

  // --------- internals ---------

  _size() {
    return { w: this.el.clientWidth, h: this.el.clientHeight };
  }

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

  _bindEvents() {
    window.addEventListener("resize", () => {
      this._resize();
      this._scheduleRender();
    });

    this.model.on("show-changed", () => this._scheduleRender());
    this.model.on("selection-changed", () => this._scheduleRender());
    this.model.on("time-changed", () => this._scheduleRender());

    // Wheel zoom, anchored at the mouse cursor.
    this.el.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const before = this.screenToNE(mx, my);
      const factor = Math.exp(-ev.deltaY * 0.0015);
      this.view.scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
      const after = this.screenToNE(mx, my);
      this.view.centerN += before.n - after.n;
      this.view.centerE += before.e - after.e;
      this._scheduleRender();
    }, { passive: false });

    this.el.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
    this.el.addEventListener("pointermove", (ev) => this._onPointerMove(ev));
    this.el.addEventListener("pointerup", (ev) => this._onPointerUp(ev));
    this.el.addEventListener("pointercancel", (ev) => this._onPointerUp(ev));
    this.el.addEventListener("contextmenu", (ev) => ev.preventDefault());
  }

  _onPointerDown(ev) {
    // Pan: middle-button OR right-button OR shift+left.
    const isPan =
      ev.button === 1 ||
      ev.button === 2 ||
      (ev.button === 0 && ev.shiftKey);
    if (isPan) {
      ev.preventDefault();
      this.el.setPointerCapture(ev.pointerId);
      this._pan = {
        startX: ev.clientX,
        startY: ev.clientY,
        startCenterN: this.view.centerN,
        startCenterE: this.view.centerE,
      };
      return;
    }
    if (ev.button !== 0) return;

    const rect = this.el.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const hit = this._hitTest(px, py);
    ev.preventDefault();
    this.el.setPointerCapture(ev.pointerId);

    if (hit) {
      this.model.select(hit.heliId, hit.wpIdx);
      this._drag = {
        heliId: hit.heliId,
        wpIdx: hit.wpIdx,
        startNE: this.screenToNE(px, py),
        startN: hit.wp.pos.n,
        startE: hit.wp.pos.e,
        moved: false,
      };
    } else {
      this._clickAdd = { startPx: px, startPy: py };
    }
  }

  _onPointerMove(ev) {
    if (this._pan) {
      const dx = ev.clientX - this._pan.startX;
      const dy = ev.clientY - this._pan.startY;
      this.view.centerE = this._pan.startCenterE - dx / this.view.scale;
      this.view.centerN = this._pan.startCenterN + dy / this.view.scale;
      this._scheduleRender();
      return;
    }
    if (this._drag) {
      const rect = this.el.getBoundingClientRect();
      const ne = this.screenToNE(ev.clientX - rect.left, ev.clientY - rect.top);
      this._drag.moved = true;
      this.model.updateWaypoint(this._drag.heliId, this._drag.wpIdx, {
        pos: {
          n: this._drag.startN + (ne.n - this._drag.startNE.n),
          e: this._drag.startE + (ne.e - this._drag.startNE.e),
        },
      });
      return;
    }
    if (this._clickAdd) {
      // Upgrade to an idle cursor move — nothing to do.
    }
  }

  _onPointerUp(ev) {
    try { this.el.releasePointerCapture?.(ev.pointerId); } catch {}
    if (this._pan) { this._pan = null; return; }
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

  _hitTest(px, py) {
    const s = this.model.show;
    if (!s) return null;
    const HIT_RADIUS = 10;
    // Render order: tracks then waypoints. Hit in reverse so topmost wins.
    for (let ti = s.tracks.length - 1; ti >= 0; ti--) {
      const track = s.tracks[ti];
      for (let wi = track.waypoints.length - 1; wi >= 0; wi--) {
        const wp = track.waypoints[wi];
        const scr = this.neToScreen(wp.pos.n, wp.pos.e);
        if (Math.hypot(scr.x - px, scr.y - py) < HIT_RADIUS) {
          return { heliId: track.heli_id, wpIdx: wi, wp };
        }
      }
    }
    return null;
  }

  _handleClickAdd(px, py) {
    const s = this.model.show;
    if (!s) return;
    const selId = this.model.selection.heliId;
    const track = selId != null ? this.model.getTrack(selId) : null;
    if (!track) return;
    const ne = this.screenToNE(px, py);
    // Keep altitude unchanged from interpolated value at current time, so
    // a top-down click never accidentally moves a heli up or down.
    const t = this.model.time;
    const interp = this.model.interpolate(track, t);
    const d = interp ? interp.d : -5;
    this.model.addWaypoint(track.heli_id, {
      t,
      pos: { n: ne.n, e: ne.e, d },
    });
  }

  _scheduleRender() {
    if (this._raf != null) return;
    this._raf = requestAnimationFrame(() => this._render());
  }

  _render() {
    this._raf = null;
    this._resize();
    const { ctx } = this;
    const dpr = this._dpr;
    const { w, h } = this._size();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    this._drawGrid(w, h);
    this._drawOrigin();

    const show = this.model.show;
    if (show) {
      if (this.showSmooth) {
        for (const track of show.tracks) this._drawSmoothOverlay(track);
      }
      for (const track of show.tracks) this._drawTrackPolyline(track);
      for (const track of show.tracks) this._drawWaypoints(track);
      for (const track of show.tracks) this._drawLiveMarker(track);
    }
  }

  _drawSmoothOverlay(track) {
    const wps = track.waypoints;
    if (wps.length < 2) return;
    const pts = wps.map((w) => w.pos);
    const smooth = catmullRom(pts, 18);
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = heliColor(track.heli_id) + "aa";
    ctx.beginPath();
    const first = this.neToScreen(smooth[0].n, smooth[0].e);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < smooth.length; i++) {
      const { x, y } = this.neToScreen(smooth[i].n, smooth[i].e);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawGrid(w, h) {
    const ctx = this.ctx;
    const scale = this.view.scale;
    // Pick a step in meters that renders at 20-80 px.
    let step = 1;
    while (step * scale < 20) step *= 10;
    while (step * scale > 200) step /= 10;
    const majorEvery = step * scale < 40 ? 10 : 5;

    const leftNE = this.screenToNE(0, 0);
    const rightNE = this.screenToNE(w, h);
    const eMin = Math.floor(leftNE.e / step) * step;
    const eMax = Math.ceil(rightNE.e / step) * step;
    const nMin = Math.floor(rightNE.n / step) * step;
    const nMax = Math.ceil(leftNE.n / step) * step;

    ctx.lineWidth = 1;

    // E lines (vertical on screen)
    for (let e = eMin; e <= eMax; e += step) {
      const { x } = this.neToScreen(0, e);
      const isMajor = Math.abs(Math.round(e / step) % majorEvery) < 1e-6;
      ctx.strokeStyle = isMajor ? GRID_MAJOR : GRID_MINOR;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    // N lines (horizontal on screen)
    for (let n = nMin; n <= nMax; n += step) {
      const { y } = this.neToScreen(n, 0);
      const isMajor = Math.abs(Math.round(n / step) % majorEvery) < 1e-6;
      ctx.strokeStyle = isMajor ? GRID_MAJOR : GRID_MINOR;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }

    // Labels on major lines
    ctx.fillStyle = GRID_LABEL;
    ctx.font = "10px var(--font-mono), monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (let e = eMin; e <= eMax; e += step) {
      if (Math.abs(Math.round(e / step) % majorEvery) > 1e-6) continue;
      const { x } = this.neToScreen(0, e);
      if (x < 0 || x > w) continue;
      ctx.fillText(`E ${fmtMeters(e)}`, x + 3, 2);
    }
    ctx.textAlign = "right";
    for (let n = nMin; n <= nMax; n += step) {
      if (Math.abs(Math.round(n / step) % majorEvery) > 1e-6) continue;
      const { y } = this.neToScreen(n, 0);
      if (y < 12 || y > h) continue;
      ctx.fillText(`N ${fmtMeters(n)}`, w - 4, y + 2);
    }
  }

  _drawOrigin() {
    const ctx = this.ctx;
    const { x, y } = this.neToScreen(0, 0);
    ctx.strokeStyle = ORIGIN_COL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y);
    ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10);
    ctx.stroke();
    ctx.fillStyle = ORIGIN_COL;
    ctx.font = "10px var(--font-mono), monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("HOME", x + 12, y - 14);
  }

  _drawTrackPolyline(track) {
    const ctx = this.ctx;
    const wps = track.waypoints;
    if (wps.length < 2) return;
    const maxSpeed = track.style.max_speed || 1;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      const dt = Math.max(0.001, b.t - a.t);
      const dn = (b.pos.n - a.pos.n);
      const de = (b.pos.e - a.pos.e);
      const dd = (b.pos.d - a.pos.d);
      const speed = Math.sqrt(dn * dn + de * de + dd * dd) / dt;
      const ratio = speed / maxSpeed;
      const color = ratio > 1
        ? "#ff1744"                 // hard red for over-speed
        : speed < 1e-3
          ? heliColor(track.heli_id) + "66"  // semi-transparent heli color for stationary hold
          : speedColor(ratio);
      ctx.strokeStyle = color;
      const pa = this.neToScreen(a.pos.n, a.pos.e);
      const pb = this.neToScreen(b.pos.n, b.pos.e);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }

  _drawWaypoints(track) {
    const ctx = this.ctx;
    const col = heliColor(track.heli_id);
    const sel = this.model.selection;
    const isTrackSel = sel.heliId === track.heli_id;
    for (let i = 0; i < track.waypoints.length; i++) {
      const wp = track.waypoints[i];
      const { x, y } = this.neToScreen(wp.pos.n, wp.pos.e);
      const isPair = this._isHoldPair(track, i);
      const r = isPair ? HOLD_DOT_RADIUS : WP_DOT_RADIUS;
      const isSel = isTrackSel && sel.waypointIdx === i;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? SELECTED_OUTLINE : col;
      ctx.fill();
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeStyle = isSel ? "#fff" : "rgba(0,0,0,0.4)";
      ctx.stroke();

      if (isPair) {
        // Draw a small clock-hand tick to signal "hold"
        ctx.strokeStyle = isSel ? "#fff" : "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - (r - 1));
        ctx.stroke();
      }

      // Small id label on the first waypoint of each track
      if (i === 0) {
        ctx.fillStyle = col;
        ctx.font = "10px var(--font-mono), monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`H${String(track.heli_id).padStart(2, "0")}`, x + 8, y - 4);
      }
    }
  }

  _isHoldPair(track, i) {
    // A waypoint is part of a hold pair if its position equals an adjacent
    // waypoint's position (within 1 mm) — which is what the load-time
    // expansion produces.
    const wp = track.waypoints[i];
    const prev = track.waypoints[i - 1];
    const next = track.waypoints[i + 1];
    const same = (a, b) =>
      a &&
      b &&
      Math.abs(a.pos.n - b.pos.n) < 0.001 &&
      Math.abs(a.pos.e - b.pos.e) < 0.001 &&
      Math.abs(a.pos.d - b.pos.d) < 0.001;
    return same(wp, prev) || same(wp, next);
  }

  _drawLiveMarker(track) {
    const ctx = this.ctx;
    const pos = this.model.interpolate(track, this.model.time);
    if (!pos) return;
    const vel = this.model.velAt(track, this.model.time);
    const col = heliColor(track.heli_id);
    const { x, y } = this.neToScreen(pos.n, pos.e);

    // Direction from velocity (n=up, e=right → screen up = -y, right = +x)
    // world velocity (vel.n, vel.e) → screen delta (vel.e, -vel.n)
    const vx = vel.e, vy = -vel.n;
    const vmag = Math.sqrt(vx * vx + vy * vy);
    const ang = vmag > 1e-3 ? Math.atan2(vy, vx) : 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = col;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, 5);
    ctx.lineTo(-6, -5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fmtMeters(v) {
  if (Math.abs(v) < 0.001) return "0";
  if (Math.abs(v) >= 100) return `${v.toFixed(0)}m`;
  return `${v.toFixed(0)}m`;
}
