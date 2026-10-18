import type { CSSProperties } from 'react';
import {
  activityChip,
  activityLabel,
  activityStatusLabels,
  decisionChip,
  decisionChipLabel,
  decisionStatusChipLabels,
  inspectionReviewText,
  resultChip,
  type ActivityStatus,
  type DecisionStatus,
  type InspectionResult,
  type Lang,
} from '@vitan/shared';

const base: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  padding: '3px 9px',
  borderRadius: 'var(--r-chip)',
  whiteSpace: 'nowrap',
  display: 'inline-block',
  lineHeight: 1.3,
};

/** `lang` is the caller's (English when not given, the chip's long-standing words). */
export function DecisionChip({ status, style, lang = 'en' }: { status: DecisionStatus; style?: CSSProperties; lang?: Lang }) {
  // Phase 6 unit 4b (Codex R2-F1's class): a status this bundle does not know renders as the
  // muted register chip instead of crashing — the NEXT status addition cannot break a cached tab.
  const c = (decisionChip as Record<string, (typeof decisionChip)[DecisionStatus]>)[status] ?? decisionChip.withdrawn;
  return (
    <span style={{ ...base, background: c.bg, color: c.color, border: `1px solid ${c.border}`, ...style }}>
      {lang === 'en'
        ? (decisionChipLabel as Record<string, string>)[status] ?? String(status).toUpperCase()
        : (decisionStatusChipLabels as Record<string, Record<Lang, string>>)[status]?.[lang] ?? String(status).toUpperCase()}
    </span>
  );
}

/** `lang` is the caller's (English when not given, the chip's long-standing words). */
export function ActivityChip({ status, lang = 'en' }: { status: ActivityStatus; lang?: Lang }) {
  const c = activityChip[status];
  return (
    <span style={{ ...base, fontSize: 8.5, padding: '2px 7px', background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {lang === 'en' ? activityLabel[status] : activityStatusLabels[status][lang]}
    </span>
  );
}

/** `lang` is the caller's (English when not given, the chip's long-standing words). */
export function ResultChip({ result, lang = 'en' }: { result: InspectionResult; lang?: Lang }) {
  const c = resultChip[result];
  return <span style={{ ...base, background: c.bg, color: c.color }}>{inspectionReviewText.result(result, lang)}</span>;
}
