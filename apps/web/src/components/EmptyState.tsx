import type { ReactNode } from 'react';

/** An honest "this project has none" panel — shown instead of seed/fallback data
 *  when a project-owned record (checklist, daily log, …) is absent. */
export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div data-testid="empty-state" style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '64px 16px' }}>
      <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 16 }}>{title}</div>
      <div style={{ marginTop: 8, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto' }}>{detail}</div>
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
