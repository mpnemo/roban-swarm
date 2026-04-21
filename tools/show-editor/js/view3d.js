// 3D view using vendored Three.js. Orbit camera, ground grid, per-heli
// trajectory lines with per-segment speed coloring, live markers that
// track model.time, optional dashed Catmull-Rom overlay.
//
// Coordinate mapping NED → Three.js:
//   Three X = E  (east, right in the default view)
//   Three Y = -d (altitude, up)
//   Three Z = -N (so a positive-N position sits "away" from the default
//                 camera, making a top-down orbit view land N = up)

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { heliColor } from "./colors.js";
import { catmullRom } from "./smoothing.js";
import { Lifecycle } from "./lifecycle.js";

export class ThreeView {
  constructor(canvasEl, model) {
    this.el = canvasEl;
    this.model = model;
    this.lifecycle = new Lifecycle(model);
    this.showSmooth = false;
    this.showLifecycle = true;
    this._visible = false;
    this._disposed = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#1a1a2e");

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(18, 14, 18);

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.controls = new OrbitControls(this.camera, canvasEl);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 5, 0);
    this.controls.update();

    // Lighting — Lambertian feel for spheres; lines ignore lights.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(10, 20, 10);
    this.scene.add(dir);

    // Ground grid (XZ plane, 1m squares, 40m extent). The GridHelper is
    // actually on Y=0 which we're using as "altitude 0 AGL", so the grid
    // sits on the takeoff ground.
    const grid = new THREE.GridHelper(40, 40, 0x454568, 0x2a2a42);
    this.scene.add(grid);

    // Origin axes + labels. Red = N, green = E, blue = Up.
    const axes = new THREE.AxesHelper(2.5);
    this.scene.add(axes);
    this.scene.add(this._makeLabel("N", 0, 0.3, -3.2, "#ff4444"));
    this.scene.add(this._makeLabel("E", 3.2, 0.3, 0, "#40c4ff"));
    this.scene.add(this._makeLabel("Up", 0, 3.2, 0, "#a0ff00"));

    this.tracksGroup = new THREE.Group();
    this.lifecycleGroup = new THREE.Group();
    this.markersGroup = new THREE.Group();
    this.scene.add(this.tracksGroup);
    this.scene.add(this.lifecycleGroup);
    this.scene.add(this.markersGroup);

    // Model subscriptions
    model.on("show-changed", () => this._rebuildTracks());
    model.on("selection-changed", () => this._rebuildTracks());
    model.on("time-changed", () => this._updateMarkers());

    window.addEventListener("resize", () => this._resize());

    this._resize();
    this._rebuildTracks();
    this._loop();
  }

  // ---------- public ----------

  setVisible(on) {
    this._visible = !!on;
    if (this._visible) this._resize();
  }

  setShowSmooth(on) {
    this.showSmooth = !!on;
    this._rebuildTracks();
  }

  setShowLifecycle(on) {
    this.showLifecycle = !!on;
    this._rebuildTracks();
  }

  /** Frame the camera on all current waypoints (and lineup if present). */
  fitAll() {
    const s = this.model.show;
    if (!s) return;
    const box = new THREE.Box3();
    let hasAny = false;
    const expand = (p) => {
      if (!hasAny) { box.min.copy(p); box.max.copy(p); hasAny = true; }
      else box.expandByPoint(p);
    };
    const off = this.model.getOffset();
    for (const t of s.tracks) {
      for (const w of t.waypoints) {
        expand(nedToThree(w.pos.n + off.n, w.pos.e + off.e, w.pos.d + off.d));
      }
    }
    const positions = s.lineup?.positions;
    if (positions) {
      for (const p of Object.values(positions)) {
        expand(nedToThree(p.n, p.e, 0));
      }
    }
    if (!hasAny) return;
    // Include ground and a little headroom
    box.expandByScalar(2);
    box.expandByPoint(new THREE.Vector3(0, 0, 0));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.75 + 4;
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360);
    // Place camera on an offset from the center
    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
  }

  // ---------- internals ----------

  _resize() {
    const w = this.el.clientWidth | 0;
    const h = this.el.clientHeight | 0;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (this._disposed) return;
    requestAnimationFrame(() => this._loop());
    if (!this._visible) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  _clearGroup(group) {
    while (group.children.length) {
      const obj = group.children[0];
      group.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
      if (obj.map) obj.map.dispose?.();
    }
  }

  _rebuildTracks() {
    this._clearGroup(this.tracksGroup);
    this._clearGroup(this.lifecycleGroup);
    this._clearGroup(this.markersGroup);
    const show = this.model.show;
    if (!show) return;
    for (const track of show.tracks) this._buildTrack(track);
    if (this.showLifecycle && this.lifecycle.hasLineup()) {
      this._buildLifecycle();
    }
    this._updateMarkers();
  }

  _buildLifecycle() {
    const lf = this.lifecycle;
    const show = this.model.show;

    // Lineup markers — small flat boxes on the ground, color-coded per heli.
    const boxGeom = new THREE.BoxGeometry(0.35, 0.08, 0.35);
    for (const track of show.tracks) {
      const lineup = lf.lineupPos(track.heli_id);
      if (!lineup) continue;
      const col = new THREE.Color(heliColor(track.heli_id));
      const mat = new THREE.MeshLambertMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: 0.15,
      });
      const mesh = new THREE.Mesh(boxGeom, mat);
      mesh.position.copy(nedToThree(lineup.n, lineup.e, 0));
      this.lifecycleGroup.add(mesh);

      // Tolerance envelope: circle on the ground
      const tol = show.lineup?.tolerance_m ?? 1.0;
      if (tol > 0) {
        const ringGeom = new THREE.RingGeometry(tol - 0.02, tol, 48);
        ringGeom.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.position.copy(nedToThree(lineup.n, lineup.e, 0));
        ring.position.y = 0.02;
        this.lifecycleGroup.add(ring);
      }
    }

    // Dashed intro/outro paths per heli
    for (const track of show.tracks) {
      this._buildLifecyclePath(track);
    }
  }

  _buildLifecyclePath(track) {
    const lf = this.lifecycle;
    const show = this.model.show;
    const introDur = lf.introDuration();
    const outroDur = lf.outroDuration();
    const col = new THREE.Color(heliColor(track.heli_id));
    const dashMat = new THREE.LineDashedMaterial({
      color: col,
      dashSize: 0.35,
      gapSize: 0.25,
      transparent: true,
      opacity: 0.6,
    });

    const addSegment = (tStart, tEnd) => {
      const pts = [];
      const samples = 48;
      for (let i = 0; i <= samples; i++) {
        const tt = tStart + (tEnd - tStart) * (i / samples);
        const p = lf.positionAt(track.heli_id, tt);
        if (p) pts.push(nedToThree(p.n, p.e, p.d));
      }
      if (pts.length < 2) return;
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geom, dashMat);
      line.computeLineDistances();
      this.lifecycleGroup.add(line);
    };

    if (introDur > 0) addSegment(-introDur, 0);
    if (outroDur > 0) addSegment(show.duration_s, show.duration_s + outroDur);
  }

  _buildTrack(track) {
    const wps = track.waypoints;
    const heli = new THREE.Color(heliColor(track.heli_id));
    const maxSpeed = track.style.max_speed || 1;
    const off = this.model.getOffset();

    // Solid trajectory: LineSegments with per-vertex colors — one color
    // per segment, anchored to each segment's linear-interp speed.
    if (wps.length >= 2) {
      const positions = new Float32Array((wps.length - 1) * 2 * 3);
      const colors = new Float32Array((wps.length - 1) * 2 * 3);
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i], b = wps[i + 1];
        const dt = Math.max(0.001, b.t - a.t);
        const dn = b.pos.n - a.pos.n;
        const de = b.pos.e - a.pos.e;
        const dd = b.pos.d - a.pos.d;
        const speed = Math.sqrt(dn * dn + de * de + dd * dd) / dt;
        const ratio = speed / maxSpeed;
        const segCol = segmentColor(ratio, speed, heli);
        const pA = nedToThree(a.pos.n + off.n, a.pos.e + off.e, a.pos.d + off.d);
        const pB = nedToThree(b.pos.n + off.n, b.pos.e + off.e, b.pos.d + off.d);
        const off = i * 6;
        positions[off + 0] = pA.x; positions[off + 1] = pA.y; positions[off + 2] = pA.z;
        positions[off + 3] = pB.x; positions[off + 4] = pB.y; positions[off + 5] = pB.z;
        colors[off + 0] = segCol.r; colors[off + 1] = segCol.g; colors[off + 2] = segCol.b;
        colors[off + 3] = segCol.r; colors[off + 4] = segCol.g; colors[off + 5] = segCol.b;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true });
      this.tracksGroup.add(new THREE.LineSegments(geom, mat));
    }

    // Waypoint dots
    const dotGeom = new THREE.SphereGeometry(0.18, 10, 10);
    const dotMat = new THREE.MeshLambertMaterial({ color: heli });
    for (const wp of wps) {
      const m = new THREE.Mesh(dotGeom, dotMat);
      const p3 = nedToThree(wp.pos.n + off.n, wp.pos.e + off.e, wp.pos.d + off.d);
      m.position.copy(p3);
      this.tracksGroup.add(m);
      // Yaw indicator on waypoints with yaw_mode='absolute'
      if (wp.yaw_mode === "absolute" && typeof wp.yaw_deg === "number") {
        const yr = wp.yaw_deg * Math.PI / 180;
        const dir = new THREE.Vector3(Math.sin(yr), 0, -Math.cos(yr)).normalize();
        const arrow = new THREE.ArrowHelper(dir, p3, 0.8, 0xffffff, 0.25, 0.15);
        this.tracksGroup.add(arrow);
      }
    }

    // Smooth overlay — dashed
    if (this.showSmooth && wps.length >= 2) {
      const pts = wps.map((w) => ({
        n: w.pos.n + off.n, e: w.pos.e + off.e, d: w.pos.d + off.d,
      }));
      const smooth = catmullRom(pts, 18);
      const verts = smooth.map((p) => nedToThree(p.n, p.e, p.d));
      const geom = new THREE.BufferGeometry().setFromPoints(verts);
      const mat = new THREE.LineDashedMaterial({
        color: heli,
        dashSize: 0.35,
        gapSize: 0.25,
        transparent: true,
        opacity: 0.7,
      });
      const line = new THREE.Line(geom, mat);
      line.computeLineDistances();
      this.tracksGroup.add(line);
    }
  }

  _updateMarkers() {
    this._clearGroup(this.markersGroup);
    const show = this.model.show;
    if (!show) return;
    const t = this.model.time;
    const geom = new THREE.SphereGeometry(0.3, 16, 16);
    const inShow = t >= 0 && t <= show.duration_s;
    for (const track of show.tracks) {
      const p = this.lifecycle.positionAt(track.heli_id, t);
      if (!p) continue;
      const col = heliColor(track.heli_id);
      const mat = new THREE.MeshLambertMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: 0.35,
      });
      const m = new THREE.Mesh(geom, mat);
      m.position.copy(nedToThree(p.n, p.e, p.d));
      this.markersGroup.add(m);

      // Heading arrow: explicit yaw if set in this span, else velocity
      const yawDeg = inShow ? this.model.yawAt(track, t) : null;
      let dir = null;
      if (yawDeg != null) {
        // Convert compass yaw (0=N, 90=E) to Three.js world vector.
        // N is -Z, E is +X in our mapping.
        const yr = yawDeg * Math.PI / 180;
        dir = new THREE.Vector3(Math.sin(yr), 0, -Math.cos(yr)).normalize();
      } else {
        const v = this.model.velAt(track, t);
        const vmag = Math.sqrt(v.n * v.n + v.e * v.e);
        if (vmag > 0.1) {
          dir = new THREE.Vector3(v.e, 0, -v.n).normalize();
        }
      }
      if (dir) {
        const origin = nedToThree(p.n, p.e, p.d);
        const arrow = new THREE.ArrowHelper(
          dir, origin, 1.2, col, 0.35, 0.2,
        );
        arrow.line.material.transparent = true;
        arrow.line.material.opacity = 0.9;
        this.markersGroup.add(arrow);
      }
    }
  }

  _makeLabel(text, x, y, z, color) {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.font = "bold 56px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(text, size / 2, size / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.2, 1.2, 1);
    sprite.position.set(x, y, z);
    sprite.renderOrder = 10;
    return sprite;
  }
}

// ---------- helpers ----------

function nedToThree(n, e, d) {
  return new THREE.Vector3(e, -d, -n);
}

function segmentColor(ratio, speed, heliCol) {
  if (ratio > 1) return new THREE.Color(0xff1744);
  if (speed < 1e-3) return heliCol.clone().multiplyScalar(0.5);
  // HSL ramp: blue (240°) → red (0°)
  const hue = (240 - 240 * Math.min(1, ratio)) / 360;
  const c = new THREE.Color();
  c.setHSL(hue, 0.9, 0.55);
  return c;
}
