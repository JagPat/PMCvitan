import { gateColor, type Gate } from '@vitan/shared';

/** A readiness-gate dot. `na` renders as a hollow inset ring. */
export function GateDot({ v, size = 9 }: { v: Gate; size?: number }) {
  const na = v === 'na';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: na ? 'transparent' : gateColor[v],
        boxShadow: na ? 'inset 0 0 0 1px rgba(35,33,28,.25)' : 'none',
      }}
    />
  );
}
