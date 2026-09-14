import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { color, status } from '@vitan/shared';

export type ButtonVariant =
  | 'ink'
  | 'accent'
  | 'success'
  | 'outline'
  | 'danger'
  | 'dangerOutline'
  | 'light'
  | 'dashed'
  | 'ghost';

const variants: Record<ButtonVariant, CSSProperties> = {
  ink: { background: color.ink, color: color.sidebarText, border: '1px solid transparent' },
  accent: { background: color.accent, color: '#fff', border: '1px solid transparent' },
  success: { background: status.green.solid, color: '#fff', border: '1px solid transparent' },
  outline: { background: 'transparent', color: color.ink, border: '1px solid rgba(35,33,28,.25)' },
  danger: { background: status.red.solid, color: '#fff', border: '1px solid transparent' },
  dangerOutline: { background: color.panel, color: status.red.solid, border: '1px solid #D9B4B0' },
  light: { background: color.panel, color: color.ink, border: '1px solid rgba(35,33,28,.22)' },
  dashed: { background: '#fff', color: color.ink, border: '1px dashed rgba(35,33,28,.3)' },
  ghost: { background: 'transparent', color: color.muted, border: 'none' },
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

/**
 * Wave 0 / F-1b — the 44px floor, CLAMPED rather than merely declared (#584 review round 7).
 *
 * The floor used to be written above `...style`, with a comment promising a caller could "go
 * taller — but not shorter by accident". The cascade does not work that way: a later property
 * in the same object wins outright, so `style={{ minHeight: 34 }}` replaced the floor and the
 * comment beside it was simply false. That is the same defect this unit has now been caught
 * making three times — a guard whose prose states a rule its mechanism does not implement.
 *
 * So the floor is applied AFTER the caller's styles, as a maximum of the two. A numeric override
 * is compared directly; a string one (`'3rem'`, `'var(--x)'`) goes through CSS `max()`, which
 * resolves at layout time and needs no unit guessing here. Taller still wins; shorter cannot.
 */
function floor(value: string | number | undefined, min: number): string | number {
  if (value === undefined || value === null || value === '') return min;
  if (typeof value === 'number') return Math.max(value, min);
  return `max(${min}px, ${value})`;
}

export function Button({ variant = 'ink', fullWidth, style, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      style={{
        fontFamily: 'var(--font-sans)',
        fontWeight: 600,
        fontSize: 14,
        padding: '12px 16px',
        borderRadius: 'var(--r-btn)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        cursor: rest.disabled ? 'default' : 'pointer',
        width: fullWidth ? '100%' : undefined,
        ...variants[variant],
        ...style,
        // AFTER the spread, deliberately — see `floor` above. A call site that overrides
        // `fontSize` or `padding` for density (LocationPicker's inline Add/Cancel, for one) was
        // silently dropping the button to 34px tall; Wave 0's rule is that a screen needing a fix
        // means the primitive is missing an affordance, so the floor lives here for every Button.
        minHeight: floor(style?.minHeight, 44),
        minWidth: floor(style?.minWidth, 44),
      }}
    >
      {children}
    </button>
  );
}
