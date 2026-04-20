// Glue: wires DOM controls + canvas + side panel to the model.
// Timeline, altitude view, validation panel land in later chunks.

import { ShowModel } from "./model.js";
import { validateTiming, validateSafety } from "./validate.js";
import { TopdownCanvas } from "./canvas.js";
import { AltitudeView } from "./altitude.js";
import { SidePanel } from "./sidepanel.js";
import { Timeline } from "./timeline.js";
import { ThreeView } from "./view3d.js";

const model = new ShowModel();
const canvas = new TopdownCanvas(document.getElementById("topdown"), model);
const altitude = new AltitudeView(document.getElementById("altitude"), model);
const sidePanel = new SidePanel(document.getElementById("side-pane"), model);
const timeline = new Timeline(document.getElementById("timeline-bar"), model);
const view3d = new ThreeView(document.getElementById("view3d"), model);

// View tab switching (top-down ↔ 3D). Altitude view stays put below.
let activeView = "topdown";
const viewTabs = document.querySelectorAll(".view-tab");
const viewPanels = document.querySelectorAll(".view-panel");
for (const tab of viewTabs) {
  tab.addEventListener("click", () => {
    activeView = tab.dataset.view;
    for (const t of viewTabs) t.classList.toggle("active", t === tab);
    for (const p of viewPanels) {
      p.hidden = p.dataset.view !== activeView;
    }
    view3d.setVisible(activeView === "3d");
    if (activeView === "3d") {
      // Re-fit on first reveal so the camera frames the data, not empty space.
      requestAnimationFrame(() => view3d.fitAll());
    }
  });
}

const summary = document.getElementById("status-summary");
const examplePicker = document.getElementById("example-select");
const filePicker = document.getElementById("file-picker");

document.getElementById("btn-new").addEventListener("click", () => {
  if (!confirmDiscard()) return;
  model.newShow();
  fitAllViews();
});

function fitAllViews() {
  canvas.fitAll();
  view3d.fitAll();
}

document.getElementById("btn-open").addEventListener("click", () => {
  if (!confirmDiscard()) return;
  filePicker.click();
});

function confirmDiscard() {
  return !model.dirty || confirm("Discard unsaved changes?");
}

document.getElementById("btn-fit").addEventListener("click", () => {
  if (activeView === "3d") view3d.fitAll();
  else canvas.fitAll();
});

// Smooth-preview toggle: Catmull-Rom overlay on top-down + altitude.
// Purely visual; flight daemon still streams linear-interpolated targets.
const smoothToggle = document.getElementById("toggle-smooth");
const savedSmooth = localStorage.getItem("roban.editor.smooth") === "1";
smoothToggle.checked = savedSmooth;
canvas.setShowSmooth(savedSmooth);
altitude.setShowSmooth(savedSmooth);
view3d.setShowSmooth(savedSmooth);
smoothToggle.addEventListener("change", () => {
  const on = smoothToggle.checked;
  canvas.setShowSmooth(on);
  altitude.setShowSmooth(on);
  view3d.setShowSmooth(on);
  localStorage.setItem("roban.editor.smooth", on ? "1" : "0");
});

document.getElementById("btn-save").addEventListener("click", () => {
  if (!model.show) {
    alert("Nothing to save — create or load a show first.");
    return;
  }
  const timing = validateTiming(model.show);
  if (timing.length > 0) {
    const first = timing.slice(0, 3).map((e) => "  • " + e.msg).join("\n");
    const more = timing.length > 3 ? `\n  …and ${timing.length - 3} more` : "";
    if (!confirm(
      `This show has ${timing.length} timing error(s):\n\n${first}${more}\n\n` +
      `The flight daemon will refuse to load it until these are fixed.\n\nSave anyway?`
    )) return;
  }
  const text = model.toJson();
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = slugify(model.show.name) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  model.dirty = false;
  updateSummary();
  updateTitle();
});

filePicker.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    model.loadJson(text);
    fitAllViews();
  } catch (e) {
    alert(`Load failed: ${e.message}`);
  }
  filePicker.value = "";
});

examplePicker.addEventListener("change", async (ev) => {
  const path = ev.target.value;
  if (!path) return;
  if (!confirmDiscard()) { ev.target.value = ""; return; }
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    const text = await res.text();
    model.loadJson(text);
    fitAllViews();
  } catch (e) {
    alert(`Load failed: ${e.message}`);
  }
  examplePicker.value = "";
});

// Drag-drop onto window
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!confirmDiscard()) return;
  try {
    const text = await file.text();
    model.loadJson(text);
    fitAllViews();
  } catch (err) {
    alert(`Load failed: ${err.message}`);
  }
});

// Keyboard shortcuts
window.addEventListener("keydown", (ev) => {
  const t = ev.target;
  const typing =
    t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable;
  if (typing) return;

  if (ev.key === "Delete" || ev.key === "Backspace") {
    const sel = model.selection;
    if (sel.heliId == null || sel.waypointIdx == null) return;
    ev.preventDefault();
    try {
      model.removeWaypoint(sel.heliId, sel.waypointIdx);
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  if (/^[1-9]$/.test(ev.key)) {
    const id = Number.parseInt(ev.key, 10);
    if (model.getTrack(id)) {
      ev.preventDefault();
      model.select(id, 0);
    }
    return;
  }

  // Ctrl/Cmd shortcuts
  if (ev.ctrlKey || ev.metaKey) {
    if (ev.key === "s") {
      ev.preventDefault();
      document.getElementById("btn-save").click();
    } else if (ev.key === "o") {
      ev.preventDefault();
      document.getElementById("btn-open").click();
    } else if (ev.key === "n") {
      ev.preventDefault();
      document.getElementById("btn-new").click();
    }
  }
});

model.on("show-changed", () => { updateSummary(); updateTitle(); });
model.on("selection-changed", updateSummary);

// Warn on close/refresh if there are unsaved changes.
window.addEventListener("beforeunload", (ev) => {
  if (model.dirty) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

function updateTitle() {
  const name = model.show?.name ?? null;
  const dirty = model.dirty ? "*" : "";
  const base = "Roban Swarm — Show Editor";
  document.title = name ? `${dirty}${name} — ${base}` : base;
}

function updateSummary() {
  if (!model.show) {
    summary.textContent = "";
    return;
  }
  const timing = validateTiming(model.show);
  const safety = validateSafety(model.show);
  const tracks = model.show.tracks.length;
  const wps = model.show.tracks.reduce((a, t) => a + t.waypoints.length, 0);
  const flag = timing.length
    ? ` · ${timing.length} timing err`
    : safety.length
      ? ` · ${safety.length} safety warn`
      : "";
  const dirty = model.dirty ? " *" : "";
  summary.textContent = `${tracks} heli · ${wps} wp · ${model.show.duration_s}s${flag}${dirty}`;
  summary.className = "status-summary " + (
    timing.length ? "err" : safety.length ? "warn" : "ok"
  );
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "show"
  );
}

// Debug handles
window.__model = model;
window.__canvas = canvas;
window.__timeline = timeline;
window.__sidePanel = sidePanel;
window.__altitude = altitude;
window.__view3d = view3d;
