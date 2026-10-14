import type { CSSProperties } from 'react';

/** One colour on the Site Map and what it means, in the same tones the place cards and record rows use. */
const ENTRIES: { key: string; label: string; tone: CSSProperties }[] = [
  { key: 'done', label: 'Done, or approved and locked', tone: { background: '#dcebdf', color: 'var(--green-text)' } },
  { key: 'under-way', label: 'Under way, or waiting on someone', tone: { background: '#f6ead2', color: 'var(--amber-text)' } },
  { key: 'attention', label: 'Blocked, failed or an open issue', tone: { background: '#f7e1df', color: '#8a2a25' } },
  { key: 'not-started', label: 'Not started', tone: { background: 'rgba(35,33,28,.06)', color: 'var(--muted)' } },
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
