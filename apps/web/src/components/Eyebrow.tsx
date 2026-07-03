import type { CSSProperties, ReactNode } from 'react';

/** Mono, uppercase, tracked eyebrow label used above section/screen titles. */
export function Eyebrow({
  children,
  color = 'var(--amber-text)',
  size = 10,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: size,
        letterSpacing: '.22em',
        textTransform: 'uppercase',
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
