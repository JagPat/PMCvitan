export function ProgressBar({ pct, height = 9 }: { pct: number; height?: number }) {
  return (
    <div style={{ height, background: 'rgba(35,33,28,.1)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 6 }} />
    </div>
  );
}
