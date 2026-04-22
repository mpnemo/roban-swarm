// Bottom timeline bar: scrubber + playback + per-heli waypoint tick marks.
// rAF-driven playback loops at duration. Keyboard: space = play/pause,
// arrows = ±1s (shift arrows = ±0.1s), Home/End = jump to ends.

import { heliColor } from "./colors.js";
import { Lifecycle } from "./lifecycle.js";

export class Timeline {
  constructor(root, model) {
    this.root = root;
    this.model = model;
    this.lifecycle = new Lifecycle(model);
    this.showLifecycle = true;
    this.playing = false;
    this.speed = 1;
    this._raf = null;
    this._lastRafMs = 0;
    this._dragging = false;

    this._buildDom();
    this._bindEvents();

    model.on("show-changed", () => {
      this._renderTicks();
      this._updateReadout();
    });
    model.on("time-changed", () => this._updateReadout());

    this._renderTicks();
    this._updateReadout();
  }

  // --------- DOM ---------

  _buildDom() {
    this.root.innerHTML = `
      <button class="btn" id="tl-play" title="Play / pause (space)">Play</button>
      <select id="tl-speed" title="Playback speed">
        <option value="0.25">0.25×</option>
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="2">2×</option>
        <option value="4">4×</option>
      </select>
      <span id="tl-readout" class="time-readout">—</span>
      <div class="scrubber" id="tl-scrubber">
        <div class="scrubber-intro" id="tl-intro"></div>
        <div class="scrubber-outro" id="tl-outro"></div>
        <div class="scrubber-fill" id="tl-fill"></div>
        <div class="scrubber-ticks" id="tl-ticks"></div>
        <div class="scrubber-thumb" id="tl-thumb"></div>
      </div>
    `;
    this.playBtn = this.root.querySelector("#tl-play");
    this.speedSel = this.root.querySelector("#tl-speed");
    this.readout = this.root.querySelector("#tl-readout");
    this.scrubber = this.root.querySelector("#tl-scrubber");
    this.fill = this.root.querySelector("#tl-fill");
    this.thumb = this.root.querySelector("#tl-thumb");
    this.ticksEl = this.root.querySelector("#tl-ticks");
    this.introEl = this.root.querySelector("#tl-intro");
    this.outroEl = this.root.querySelector("#tl-outro");
  }

  /** [tMin, tMax] for the scrubber — extended when lineup is present. */
  _timeRange() {
    const s = this.model.show;
    if (!s) return { tMin: 0, tMax: 1 };
    if (this.showLifecycle && this.lifecycle.hasLineup()) {
      return {
        tMin: -this.lifecycle.introDuration(),
        tMax: s.duration_s + this.lifecycle.outroDuration(),
      };
    }
    return { tMin: 0, tMax: s.duration_s };
  }

  _bindEvents() {
    this.playBtn.addEventListener("click", () => this.toggle());
    this.speedSel.addEventListener("change", () => {
      this.speed = Number.parseFloat(this.speedSel.value) || 1;
    });

    this.scrubber.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      this.scrubber.setPointerCapture(ev.pointerId);
      this._dragging = true;
      this._setFromPointer(ev);
    });
    this.scrubber.addEventListener("pointermove", (ev) => {
      if (this._dragging) this._setFromPointer(ev);
    });
    const end = (ev) => {
      this._dragging = false;
      try { this.scrubber.releasePointerCapture?.(ev.pointerId); } catch {}
    };
    this.scrubber.addEventListener("pointerup", end);
    this.scrubber.addEventListener("pointercancel", end);

    window.addEventListener("keydown", (ev) => {
      const t = ev.target;
      const typing =
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.tagName === "SELECT" ||
        t?.isContentEditable;
      if (typing) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (ev.key === " ") {
        ev.preventDefault();
        this.toggle();
      } else if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        const { tMin } = this._timeRange();
        this.model.setTime(Math.max(tMin, this.model.time - (ev.shiftKey ? 0.1 : 1)));
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        const { tMax } = this._timeRange();
        this.model.setTime(Math.min(tMax, this.model.time + (ev.shiftKey ? 0.1 : 1)));
      } else if (ev.key === "Home") {
        ev.preventDefault();
        const { tMin } = this._timeRange();
        this.model.setTime(tMin);
      } else if (ev.key === "End") {
        ev.preventDefault();
        const { tMax } = this._timeRange();
        this.model.setTime(tMax);
      }
    });
  }

  _setFromPointer(ev) {
    if (!this.model.show) return;
    const rect = this.scrubber.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const { tMin, tMax } = this._timeRange();
    this.model.setTime(tMin + frac * (tMax - tMin));
  }

  // --------- playback ---------

  toggle() { if (this.playing) this.pause(); else this.play(); }

  play() {
    if (this.playing || !this.model.show) return;
    this.playing = true;
    this.playBtn.textContent = "Pause";
    this._lastRafMs = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      const dt = (now - this._lastRafMs) / 1000;
      this._lastRafMs = now;
      const { tMin, tMax } = this._timeRange();
      const span = Math.max(1e-6, tMax - tMin);
      let t = this.model.time + dt * this.speed;
      if (t > tMax) t = tMin + ((t - tMin) % span);
      if (t < tMin) t = tMax - ((tMin - t) % span);
      this.model.setTime(t);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  pause() {
    this.playing = false;
    this.playBtn.textContent = "Play";
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  // --------- render ---------

  _renderTicks() {
    this.ticksEl.innerHTML = "";
    const s = this.model.show;
    if (!s || s.duration_s <= 0) return;
    const { tMin, tMax } = this._timeRange();
    const span = tMax - tMin;
    if (span <= 0) return;
    // Intro/outro band sizing
    if (this.showLifecycle && this.lifecycle.hasLineup()) {
      const introDur = this.lifecycle.introDuration();
      const outroDur = this.lifecycle.outroDuration();
      if (this.introEl) {
        this.introEl.style.left = "0%";
        this.introEl.style.width = ((introDur / span) * 100).toFixed(3) + "%";
      }
      if (this.outroEl) {
        const leftPct = ((introDur + s.duration_s) / span) * 100;
        this.outroEl.style.left = leftPct.toFixed(3) + "%";
        this.outroEl.style.width = ((outroDur / span) * 100).toFixed(3) + "%";
      }
    } else {
      if (this.introEl) this.introEl.style.width = "0";
      if (this.outroEl) this.outroEl.style.width = "0";
    }
    for (const track of s.tracks) {
      const col = heliColor(track.heli_id);
      for (const wp of track.waypoints) {
        const tick = document.createElement("div");
        tick.className = "scrubber-tick";
        tick.style.left = (((wp.t - tMin) / span) * 100).toFixed(3) + "%";
        tick.style.background = col;
        this.ticksEl.appendChild(tick);
      }
    }

    // Red markers at times where any pair is < 3m apart — spans intro,
    // show, and outro. The scrubber thumb passes right over them during
    // playback so you know when to look for a collision.
    for (const ct of this.lifecycle.proximitySampleTimes()) {
      const tick = document.createElement("div");
      tick.className = "scrubber-conflict";
      tick.style.left = (((ct - tMin) / span) * 100).toFixed(3) + "%";
      this.ticksEl.appendChild(tick);
    }
  }

  _updateReadout() {
    const s = this.model.show;
    if (!s) {
      this.readout.textContent = "—";
      this.fill.style.width = "0%";
      this.thumb.style.left = "0%";
      return;
    }
    const t = this.model.time;
    const { tMin, tMax } = this._timeRange();
    const span = Math.max(1e-6, tMax - tMin);
    const frac = (t - tMin) / span;
    const pct = (Math.max(0, Math.min(1, frac)) * 100).toFixed(3);
    this.fill.style.width = pct + "%";
    this.thumb.style.left = pct + "%";
    let phase = "";
    if (t < 0) phase = " · intro";
    else if (t > s.duration_s) phase = " · outro";
    this.readout.textContent = `${fmtSignedTime(t)} / ${fmtDuration(s.duration_s)}${phase}`;
  }
}

function fmtTime(t) {
  const mm = Math.floor(t / 60);
  const ss = t - mm * 60;
  return `${String(mm).padStart(2, "0")}:${ss.toFixed(1).padStart(4, "0")}`;
}

function fmtSignedTime(t) {
  if (t < 0) return "-" + fmtTime(-t);
  return fmtTime(t);
}

function fmtDuration(d) {
  return `${d.toFixed(1)}s`;
}
