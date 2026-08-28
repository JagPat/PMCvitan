import type { CSSProperties } from 'react';
import {
  activityChip,
  activityLabel,
  decisionChip,
  decisionChipLabel,
  resultChip,
  type ActivityStatus,
  type DecisionStatus,
  type InspectionResult,
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

export function DecisionChip({ status, style }: { status: DecisionStatus; style?: CSSProperties }) {
  // Phase 6 unit 4b (Codex R2-F1's class): a status this bundle does not know renders as the
  // muted register chip instead of crashing — the NEXT status addition cannot break a cached tab.
  const c = (decisionChip as Record<string, (typeof decisionChip)[DecisionStatus]>)[status] ?? decisionChip.withdrawn;
  return (
    <span style={{ ...base, background: c.bg, color: c.color, border: `1px solid ${c.border}`, ...style }}>
      {(decisionChipLabel as Record<string, string>)[status] ?? String(status).toUpperCase()}
    </span>
  );
}

export function ActivityChip({ status }: { status: ActivityStatus }) {
  const c = activityChip[status];
  return (
    <span style={{ ...base, fontSize: 8.5, padding: '2px 7px', background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>
      {activityLabel[status]}
    </span>
  );
}

export function ResultChip({ result }: { result: InspectionResult }) {
  const c = resultChip[result];
  return <span style={{ ...base, background: c.bg, color: c.color }}>{result}</span>;
}
