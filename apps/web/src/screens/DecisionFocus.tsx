import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { Swatch, LocationContext } from '@/components';
import { ChevronLeft, Lock } from '@/lib/icons';
import {
  clientDecisionApprove,
  clientDecisionDelta,
  clientDecisionLabels as L,
  signed,
  type Decision,
} from '@vitan/shared';
import styles from './DecisionFocus.module.css';

/**
 * U2b (design review, Client · Decision board): one decision on its own screen — pick one option,
 * then approve it. Presentation only: the approval is the existing `openApprove` → `ApproveModal`
 * → `confirmApprove` path, so the confirmation, the countersign route and the outcome are exactly
 * those of the list. The board's due date, per-option notes and "ask the architect" have nothing
 * behind them yet, so they are not drawn.
 */
export function DecisionFocus({ d, reopened }: { d: Decision; reopened: boolean }) {
  const lang = useStore((s) => s.lang);
  const openApprove = useStore((s) => s.openApprove);
  const closeDecision = useStore((s) => s.closeDecision);
  // nothing is chosen for the client: the architect's pick is marked, never preselected
  const [picked, setPicked] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // a decision opened here is announced and starts at the top
  useEffect(() => {
    setPicked(null);
    heading.current?.focus();
  }, [d.id]);

  const option = picked === null ? null : d.options[picked];
  return (
    <section className={styles.focus} data-testid="decision-focus" data-decision={d.id}>
      <div className={styles.top}>
        <button className={styles.back} onClick={closeDecision} data-testid="decision-focus-back">
          <ChevronLeft size={20} aria-hidden /> {L.back[lang]}
        </button>
      </div>

      <LocationContext nodeId={d.nodeId} fallback={d.room} compact testId={`decision-focus-place-${d.id}`} />
      <h1 className={styles.title} ref={heading} tabIndex={-1}>{d.title}</h1>
      <p className={styles.intro}>{L.pick[lang]}</p>
      {reopened && (
        <>
          <p className={styles.reopened}>{L.reopened[lang]}</p>
          {d.changeRequest && <ChangeRequestContext d={d} />}
        </>
      )}

      <div className={styles.options} role="radiogroup" aria-label={d.title}>
        {d.options.map((o, i) => (
          <button
            key={o.key}
            role="radio"
            aria-checked={picked === i}
            className={`${styles.option} ${picked === i ? styles.optionPicked : ''}`}
            onClick={() => setPicked(i)}
            data-testid={`decision-option-${d.id}-${o.key}`}
          >
            <Swatch swatch={o.swatch} size={72} radius={12} />
            <span className={styles.optionText}>
              {o.recommended && <span className={styles.recommended}>{L.recommends[lang]}</span>}
              <span className={styles.optionName}>{o.label} · {o.material}</span>
              <span className={styles.delta}>{clientDecisionDelta(o.delta, lang)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={styles.lockNote} data-testid="decision-focus-lock">
        <Lock size={20} aria-hidden />
        <span>{d.countersignRequired ? L.lockCountersign[lang] : L.lock[lang]}</span>
      </div>

      <button
        className={styles.approve}
        disabled={picked === null}
        onClick={() => picked !== null && openApprove(d.id, picked)}
        data-testid="decision-focus-approve"
      >
        {option ? clientDecisionApprove(option.material, lang) : L.pickFirst[lang]}
      </button>
    </section>
  );
}

/** A reopened decision's change request — what was asked and what it costs — shared by the list's
 *  cards and the one-decision screen. A countersign rejection reads as what it is. */
export function ChangeRequestContext({ d }: { d: Decision }) {
  const cr = d.changeRequest;
  if (!cr) return null;
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 10, background: 'var(--red-chip, rgba(180,70,46,.08))', fontSize: 12.5 }} data-testid={`cr-context-${d.id}`}>
      {/* Phase 6 task 4d-ii-b / B4 — a countersign rejection reads as what it is (see DecisionLogScreen) */}
      <div style={{ fontWeight: 600, color: 'var(--red-text)' }}>
        {cr.origin === 'countersign_rejection'
          ? <span data-testid={`cr-origin-${d.id}`}>Sent back by the architect: {cr.reason}</span>
          : <>Change requested: {cr.reason}</>}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
        {cr.costImpact === 0 ? 'No cost change' : signed(cr.costImpact)}
        {' · '}
        {cr.timeImpactDays === 0 ? 'no schedule impact' : `${cr.timeImpactDays} day${cr.timeImpactDays === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}
