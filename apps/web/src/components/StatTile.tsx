import type { ReactNode } from 'react';

/** Small labelled stat box (e.g. Done 3/5, Photos 2). */
export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        background: 'var(--paper)',
        border: '1px solid var(--hairline)',
        borderRadius: 10,
        padding: 9,
        textAlign: 'center',
      }}
    >
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)' }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
    </div>
  );
}
