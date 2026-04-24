// Stable per-heli color palette (10 entries, cycles for heli_id > 10).
// Fixed table — no HSL derivation — to guarantee id=1 is always cyan, etc.,
// and avoid two IDs landing on similar hues.
export const HELI_COLORS = [
  "#00d4ff", // 1  cyan
  "#ff2e88", // 2  magenta
  "#ffb700", // 3  amber
  "#00e676", // 4  green
  "#b040ff", // 5  purple
  "#ff6a00", // 6  orange
  "#40c4ff", // 7  sky blue
  "#ff4444", // 8  red
  "#a0ff00", // 9  lime
  "#ff80ab", // 10 pink
];

export function heliColor(heliId) {
  return HELI_COLORS[(heliId - 1) % HELI_COLORS.length];
}

/**
 * Speed gradient. ratio = speed / max_speed.
 * 0 → blue, 0.5 → green, 1.0 → red. >1 stays red (over-speed pulse is
 * handled by the caller).
 */
export function speedColor(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  // HSL hue: 240 (blue) → 0 (red)
  const hue = 240 - r * 240;
  return `hsl(${hue.toFixed(0)}, 90%, 55%)`;
}

/** Over-speed indicator — returns a "pulsing" red with phase `t` in seconds. */
export function overspeedColor(t) {
  const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 6));
  return `hsl(0, 100%, ${(40 + pulse * 20).toFixed(0)}%)`;
}
