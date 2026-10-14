import type { CSSProperties } from 'react';
import { activityChip, decisionChip } from '@vitan/shared';

const tone = (c: { bg: string; color: string; border: string }): CSSProperties => ({ background: c.bg, color: c.color, border: `1px solid ${c.border}` });

/**
 * Each colour family the Site Map's chips and rows use, from the shared status tokens, and what it means. One
 * entry per family, so every colour on the screen has a meaning here (Codex 4273627423).
 */
const ENTRIES: { key: string; label: string; tone: CSSProperties }[] = [
  { key: 'done', label: 'Done, passed, or approved and locked', tone: tone(activityChip.done) },
  { key: 'under-way', label: 'Under way, or waiting on a decision or review', tone: tone(decisionChip.pending) },
  { key: 'with-reviewer', label: 'Change requested, or waiting for sign-off', tone: tone(activityChip['awaiting-signoff']) },
  { key: 'attention', label: 'Blocked, failed or an open issue', tone: { background: '#f7e1df', color: '#8a2a25', border: `1px solid ${activityChip.blocked.border}` } },
  { key: 'neutral', label: 'Not started, withdrawn or only recorded', tone: tone(activityChip['not-started']) },
];

/**
 * #633 unit B (UX brief §10) — a short "Colours mean" key, so a status colour on a place card or a
 * record row is never the only way to read it. Each colour is shown with its meaning in words.
 */
export function SiteMapLegend() {
  return (
    <div data-testid="site-map-legend" role="group" aria-labelledby="site-map-legend-title" style={wrap}>
      <span id="site-map-legend-title" style={{ fontWeight: 600, color: 'var(--ink)' }}>Colours mean</span>
      {ENTRIES.map((e) => (
        <span key={e.key} data-testid={`site-map-legend-${e.key}`} style={{ ...chip, ...e.tone }}>{e.label}</span>
      ))}
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, margin: '0 0 16px' };
const chip: CSSProperties = { padding: '2px 8px', borderRadius: 5, fontWeight: 500 };
