import type { CSSProperties } from 'react';
import { activityChip, decisionChip, siteMapLabels, siteMapLegendLabels, type Lang } from '@vitan/shared';

const tone = (c: { bg: string; color: string; border: string }): CSSProperties => ({ background: c.bg, color: c.color, border: `1px solid ${c.border}` });

/**
 * Each colour family the Site Map's chips and rows use, from the shared status tokens, and what it means. One
 * entry per family, so every colour on the screen has a meaning here (Codex 4273627423).
 */
const ENTRIES: { key: keyof typeof siteMapLegendLabels; tone: CSSProperties }[] = [
  { key: 'done', tone: tone(activityChip.done) },
  { key: 'under-way', tone: tone(decisionChip.pending) },
  { key: 'with-reviewer', tone: tone(activityChip['awaiting-signoff']) },
  { key: 'attention', tone: { background: '#f7e1df', color: '#8a2a25', border: `1px solid ${activityChip.blocked.border}` } },
  { key: 'neutral', tone: tone(activityChip['not-started']) },
];

/**
 * #633 unit B (UX brief §10) — a short "Colours mean" key, so a status colour on a place card or a
 * record row is never the only way to read it. Each colour is shown with its meaning in words.
 */
export function SiteMapLegend({ lang = 'en' }: { lang?: Lang }) {
  return (
    <div data-testid="site-map-legend" role="group" aria-labelledby="site-map-legend-title" style={wrap}>
      <span id="site-map-legend-title" style={{ fontWeight: 600, color: 'var(--ink)' }}>{siteMapLabels.legendTitle[lang]}</span>
      {ENTRIES.map((e) => (
        <span key={e.key} data-testid={`site-map-legend-${e.key}`} style={{ ...chip, ...e.tone }}>{siteMapLegendLabels[e.key][lang]}</span>
      ))}
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, margin: '0 0 16px' };
const chip: CSSProperties = { padding: '2px 8px', borderRadius: 5, fontWeight: 500 };
