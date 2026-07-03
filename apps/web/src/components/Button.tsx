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
      }}
    >
      {children}
    </button>
  );
}
