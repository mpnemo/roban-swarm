// Glue: wires DOM controls + canvas + side panel to the model.
// Timeline, altitude view, validation panel land in later chunks.

import { ShowModel } from "./model.js";
import { validateTiming, validateSafety } from "./validate.js";
import { TopdownCanvas } from "./canvas.js";
import { SidePanel } from "./sidepanel.js";

const model = new ShowModel();
const canvas = new TopdownCanvas(document.getElementById("topdown"), model);
const sidePanel = new SidePanel(document.getElementById("side-pane"), model);

const summary = document.getElementById("status-summary");
const examplePicker = document.getElementById("example-select");
const filePicker = document.getElementById("file-picker");

document.getElementById("btn-new").addEventListener("click", () => {
  if (model.dirty && !confirm("Discard unsaved changes?")) return;
  model.newShow();
  canvas.fitAll();
});

document.getElementById("btn-open").addEventListener("click", () => {
  filePicker.click();
});

document.getElementById("btn-fit").addEventListener("click", () => {
  canvas.fitAll();
});

document.getElementById("btn-save").addEventListener("click", () => {
  if (!model.show) {
    alert("Nothing to save — create or load a show first.");
    return;
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
});

filePicker.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    model.loadJson(text);
    canvas.fitAll();
  } catch (e) {
    alert(`Load failed: ${e.message}`);
  }
  filePicker.value = "";
});

examplePicker.addEventListener("change", async (ev) => {
  const path = ev.target.value;
  if (!path) return;
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
    const text = await res.text();
    model.loadJson(text);
    canvas.fitAll();
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
  try {
    const text = await file.text();
    model.loadJson(text);
    canvas.fitAll();
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

model.on("show-changed", updateSummary);
model.on("selection-changed", updateSummary);

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
