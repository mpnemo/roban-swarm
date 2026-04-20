// Bottom timeline bar: scrubber + playback + per-heli waypoint tick marks.
// rAF-driven playback loops at duration. Keyboard: space = play/pause,
// arrows = ±1s (shift arrows = ±0.1s), Home/End = jump to ends.

import { heliColor } from "./colors.js";

export class Timeline {
  constructor(root, model) {
    this.root = root;
    this.model = model;
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
        this.model.setTime(this.model.time - (ev.shiftKey ? 0.1 : 1));
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        this.model.setTime(this.model.time + (ev.shiftKey ? 0.1 : 1));
      } else if (ev.key === "Home") {
        ev.preventDefault();
        this.model.setTime(0);
      } else if (ev.key === "End") {
        ev.preventDefault();
        if (this.model.show) this.model.setTime(this.model.show.duration_s);
      }
    });
  }

  _setFromPointer(ev) {
    if (!this.model.show) return;
    const rect = this.scrubber.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    this.model.setTime(frac * this.model.show.duration_s);
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
      const dur = this.model.show.duration_s;
      let t = this.model.time + dt * this.speed;
      if (t >= dur) t = t - Math.floor(t / dur) * dur; // loop
      if (t < 0) t = 0;
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
    const dur = s.duration_s;
    for (const track of s.tracks) {
      const col = heliColor(track.heli_id);
      for (const wp of track.waypoints) {
        const tick = document.createElement("div");
        tick.className = "scrubber-tick";
        tick.style.left = ((wp.t / dur) * 100).toFixed(3) + "%";
        tick.style.background = col;
        this.ticksEl.appendChild(tick);
      }
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
    const dur = s.duration_s;
    const frac = dur > 0 ? t / dur : 0;
    const pct = (frac * 100).toFixed(3);
    this.fill.style.width = pct + "%";
    this.thumb.style.left = pct + "%";
    this.readout.textContent = `${fmtTime(t)} / ${fmtDuration(dur)}`;
  }
}

function fmtTime(t) {
  const mm = Math.floor(t / 60);
  const ss = t - mm * 60;
  return `${String(mm).padStart(2, "0")}:${ss.toFixed(1).padStart(4, "0")}`;
}

function fmtDuration(d) {
  return `${d.toFixed(1)}s`;
}
