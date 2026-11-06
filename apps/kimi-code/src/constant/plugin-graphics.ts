export const GRAPHICS_FRAME_MS = 50;
export const GRAPHICS_COMMAND_TIMEOUT_MS = 10000;
export const GRAPHICS_VISIBILITY_TIMEOUT_MS = 500;
export const GRAPHICS_MAX_COLUMNS = 240;
export const GRAPHICS_MAX_ROWS = 32;
export const GRAPHICS_MAX_PIXELS = 2000000;
export const GRAPHICS_QUADRANTS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const;
export const GRAPHICS_SEXTANTS = Array.from({ length: 64 }, (_, mask) => {
  if (mask === 0) return ' ';
  if (mask === 21) return '▌';
  if (mask === 42) return '▐';
  if (mask === 63) return '█';
  return String.fromCodePoint(0x1FB00 + mask - 1 - Number(mask > 21) - Number(mask > 42));
});
const OCTANT_EXISTING = new Map<number, string>([
  [0, ' '], [3, '🮂'], [5, '▘'], [10, '▝'], [15, '▀'], [63, '🮅'],
  [80, '▖'], [85, '▌'], [90, '▞'], [95, '▛'], [160, '▗'], [165, '▚'],
  [170, '▐'], [175, '▜'], [192, '▂'], [240, '▄'], [245, '▙'], [250, '▟'],
  [252, '▆'], [255, '█'],
]);
const OCTANT_OMITTED = new Set([0, 1, 2, 3, 5, 10, 15, 20, 40, 63, 64, 80, 85, 90, 95, 128, 160, 165, 170, 175, 192, 240, 245, 250, 252, 255]);
let octantIndex = 0;
export const GRAPHICS_OCTANTS = Array.from({ length: 256 }, (_, mask) => {
  if (OCTANT_OMITTED.has(mask)) return OCTANT_EXISTING.get(mask);
  return String.fromCodePoint(0x1CD00 + octantIndex++);
});
export const GRAPHICS_IDLE_MS = 5000;
