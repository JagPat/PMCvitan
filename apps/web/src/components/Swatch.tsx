import type { CSSProperties } from 'react';
import { swatch as swatchGradient } from '@vitan/shared';
import { Lock } from '@/lib/icons';

/**
 * Material swatch — a CSS-placeholder gradient standing in for a real material
 * photo. `lock` overlays a small lock badge (approved/locked decisions).
 */
export function Swatch({
  swatch,
  size = 56,
  radius = 10,
  label,
  lock = false,
  style,
}: {
  swatch: string;
  size?: number;
  radius?: number;
  label?: string;
  lock?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: swatchGradient(swatch),
        border: '1px solid rgba(0,0,0,.1)',
        position: 'relative',
        flex: 'none',
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'rgba(255,255,255,.9)',
            background: 'rgba(0,0,0,.4)',
            padding: '1px 6px',
            borderRadius: 3,
          }}
        >
          {label}
        </span>
      )}
      {lock && (
        <span
          style={{
            position: 'absolute',
            right: -6,
            bottom: -6,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            border: '1px solid var(--hairline)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--sh-subtle)',
          }}
        >
          <Lock size={11} color="var(--ink)" />
        </span>
      )}
    </div>
  );
}
