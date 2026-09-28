import type { CSSProperties, ReactNode } from 'react';

/** The critical-label floor (owner GO): an eyebrow names the screen or section, so it never
 *  renders below 13px, whatever size a caller asks for. */
export const EYEBROW_MIN_SIZE = 13;

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
        // after the spread, so no caller style can push a critical label under the floor
        fontSize: Math.max(size, EYEBROW_MIN_SIZE),
      }}
    >
      {children}
    </div>
  );
}
