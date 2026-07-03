import type { CSSProperties, ReactNode } from 'react';

/** Surface panel. `elevated` = white card with soft shadow; default = flat panel. */
export function Card({
  children,
  elevated = false,
  style,
  onClick,
  className,
}: {
  children: ReactNode;
  elevated?: boolean;
  style?: CSSProperties;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        background: elevated ? 'var(--paper)' : 'var(--panel)',
        border: '1px solid var(--hairline)',
        borderRadius: elevated ? 'var(--r-card-lg)' : 'var(--r-card)',
        boxShadow: elevated ? 'var(--sh-card)' : 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
