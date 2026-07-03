/**
 * Material swatch gradients.
 *
 * CSS-placeholder gradients standing in for real materials (marble, vitrified,
 * teak, walnut, chrome, glass, quartz, water, concrete, tile, paint). Copied
 * BYTE-FOR-BYTE from the prototype's `SW` map — retyping the multi-layer marble
 * or the 92° teak/walnut stripes introduces visible drift. Always apply as the
 * CSS `background` shorthand (not `background-color`).
 *
 * These are placeholders; the production media pipeline (Phase 8) replaces them
 * with real geo/time-stamped site photos.
 */

export const SW = {
  marble:
    'repeating-linear-gradient(118deg, rgba(150,140,118,0) 0 20px, rgba(120,108,86,.14) 20px 21px), linear-gradient(135deg,#f1eee6,#e6e0d3)',
  vitrified: 'linear-gradient(135deg,#d8ccb8,#c7b89f)',
  teak: 'repeating-linear-gradient(92deg,#7c4a25 0 3px,#8a5628 3px 6px)',
  walnut: 'repeating-linear-gradient(92deg,#4f3018 0 3px,#5f3a20 3px 7px)',
  chrome: 'linear-gradient(135deg,#eef1f4,#b7bfc7 45%,#f4f6f8 55%,#a7afb7)',
  glass: 'linear-gradient(135deg,rgba(150,185,200,.6),rgba(120,160,178,.4))',
  quartz: 'linear-gradient(135deg,#f5f3ef,#e0dad0)',
  water: 'linear-gradient(160deg,#7fa6b5,#4f7d8f)',
  concrete: 'linear-gradient(135deg,#b9b4a8,#9c968a)',
  tile: 'linear-gradient(135deg,#e8e2d6,#d4ccbc)',
  paint: 'linear-gradient(135deg,#e9e2d4,#d8cfbd)',
} as const;

export type SwatchKey = keyof typeof SW;

/** Safe lookup that falls back to the neutral `tile` gradient. */
export function swatch(key: string | null | undefined): string {
  return (key && (SW as Record<string, string>)[key]) || SW.tile;
}
