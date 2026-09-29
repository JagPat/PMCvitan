import type { CSSProperties, ReactNode } from 'react';

/** The critical-label floor (owner GO): an eyebrow names the screen or section, so it never
 *  renders below 13px, whatever size a caller asks for. */
export const EYEBROW_MIN_SIZE = 13;

/** The size a caller asked for: a numeric or `px` style wins over the prop, as it did before the
 *  floor; any other unit cannot be compared with the floor, so the prop decides. */
function requestedSize(styleSize: CSSProperties['fontSize'], size: number): number {
  if (typeof styleSize === 'number') return styleSize;
  if (typeof styleSize === 'string' && /^\d+(\.\d+)?px$/.test(styleSize.trim())) return parseFloat(styleSize);
  return size;
}

/** Mono, uppercase, tracked eyebrow label used above section/screen titles. */
export function Eyebrow({
  children,
  color = 'var(--amber-text)',
  size = EYEBROW_MIN_SIZE,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      data-eyebrow=""
      style={{
        fontFamily: 'var(--font-mono)',
        letterSpacing: '.14em',
        textTransform: 'uppercase',
        overflowWrap: 'anywhere',
        color,
        ...style,
        // after the spread, so no caller style can push a critical label under the floor — while a
        // caller's own size (prop or style) above the floor is kept as asked
        fontSize: Math.max(requestedSize(style?.fontSize, size), EYEBROW_MIN_SIZE),
      }}
    >
      {children}
    </div>
  );
}
