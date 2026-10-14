import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectDeciderPending, selectDeciderReapproval, selectLogDecisions } from '@/store/selectors';
import { Eyebrow, Swatch, Button, LocationContext, WaitingCardActions } from '@/components';
import { Check } from '@/lib/icons';
import { signed, type Decision } from '@vitan/shared';
import { groupDecisions } from '@/lib/locationTree';
import { DecisionFocus, ChangeRequestContext } from './DecisionFocus';
import { DecisionLogScreen } from './DecisionLogScreen';
import { decisionsSliceSettled } from '@/lib/notifications';
import styles from './responsive.module.css';

export function ClientDecisionsScreen() {
  // Phase 6 task 4b (§A.3) — the approval surface shows the decisions THIS VIEWER decides
  // (client-held for the client; the named rows for a member-decider; none for a non-decider).
  const pending = useStore(useShallow(selectDeciderPending));
  const reapprovals = useStore(useShallow(selectDeciderReapproval));
  const nodes = useStore(useShallow((s) => s.nodes));
  const openApprove = useStore((s) => s.openApprove);
  const short = useStore((s) => s.short); // live project identity, not the seed
  const decisionFocus = useStore((s) => s.decisionFocus);
  const closeDecision = useStore((s) => s.closeDecision);
  // QA check 14 Oct 2026 (#482): the client's one "Decisions" screen — what waits on them first, then the
  // history (the register) below, in place of two menu entries. Other viewers who reach this approval route as
  // a decider keep the list alone.
  const withHistory = useStore((s) => s.role === 'client');
  // #857 Codex 4268120376 — an old `/decisions/<id>` link naming a decision that still waits on the client marks
  // that card here, since the history below leaves it out
  const linked = useStore((s) => (withHistory && s.screen === 'decision-log' ? s.routeItem : null));
  // #857 Codex 4268290494 — a link naming a decision the register does not (yet) hold shows ONLY the register's
  // loading or not-found boundary, as the standalone register did: never the waiting cards or "All caught up" as if
  // they answered it. The same check the register makes on the same rows (`selectLogDecisions`).
  const linkUnresolved = useStore((s) => linked !== null && !selectLogDecisions(s).some((d) => d.id === linked));
  // #857 Codex 4269078179 — the `/decisions` path is where an UNSETTLED slice routes the client on purpose (failed
  // read, owed reconcile: `decisionRecordLink`, the bell), so retained rows cannot offer live Approve buttons. There
  // the client gets the whole read-only register alone until the slice settles, as before the merge.
  const readOnlyRoute = useStore((s) => withHistory && s.screen === 'decision-log' && !decisionsSliceSettled(s));

  // U2b — one decision on its own screen, while it still waits on THIS viewer. Once it is approved
  // (or is no longer theirs) the focus is let go and the list shows what is left.
  const focused = decisionFocus ? [...reapprovals, ...pending].find((d) => d.id === decisionFocus) ?? null : null;
  useEffect(() => {
    if (decisionFocus && !focused) closeDecision();
  }, [decisionFocus, focused, closeDecision]);

  const waiting = pending.length + reapprovals.length;
  const countLabel = `${waiting} ${waiting === 1 ? 'decision waiting' : 'decisions waiting'}`;
  // group by location so the client can work through a zone/room at a time
  const groups = groupDecisions(pending, nodes, 'location');

  if (readOnlyRoute) {
    // the whole register, waiting rows included and read-only, exactly as the client's Decision Log was
    return (
      <div className={styles.clientScreen}>
        <DecisionLogScreen />
      </div>
    );
  }

  if (linkUnresolved) {
    return (
      <div className={styles.clientScreen}>
        <DecisionLogScreen variant="history" />
      </div>
    );
  }

  if (focused) {
    return (
      <div className={styles.clientScreen}>
        <DecisionFocus d={focused} reopened={reapprovals.some((r) => r.id === focused.id)} />
      </div>
    );
  }

  return (
    <div className={styles.clientScreen}>
      <div style={{ padding: '10px 0 16px' }}>
        <Eyebrow size={9}>{short.toUpperCase()}</Eyebrow>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 27, fontWeight: 500, marginTop: 4, lineHeight: 1.15 }}>
          Decisions waiting for you
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>{countLabel} · Please review and approve.</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {reapprovals.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: '1px solid rgba(180,70,46,.35)', paddingBottom: 6 }}>
              <span style={{ fontFamily: 'var(--font-serif)', fontSize: 18, fontWeight: 500, color: 'var(--red-text)' }}>Needs your re-approval</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>
                {reapprovals.length} reopened — work is on hold until you decide again
              </span>
            </div>
            {reapprovals.map((d) => (
              <PendingCard key={d.id} d={d} subLabel={d.room} onApprove={(i) => openApprove(d.id, i)} current={linked === d.id} />
            ))}
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {groups.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: '1px solid rgba(35,33,28,.1)', paddingBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-serif)', fontSize: 18, fontWeight: 500 }}>{g.label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>{g.counts.total} to decide</span>
              </div>
            )}
            {g.rows.map(({ decision, subLabel }) => (
              <PendingCard key={decision.id} d={decision} subLabel={subLabel} onApprove={(i) => openApprove(decision.id, i)} current={linked === decision.id} />
            ))}
          </div>
        ))}

        {waiting === 0 && (
          <div style={{ textAlign: 'center', padding: withHistory ? '20px 20px 8px' : '48px 20px', color: 'var(--muted)' }} data-testid="decisions-caught-up">
            <div style={{ width: 60, height: 60, margin: '0 auto', borderRadius: '50%', background: 'var(--green-chip)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Check size={30} color="var(--green-solid)" strokeWidth={2.5} />
            </div>
            <div style={{ fontWeight: 600, marginTop: 12 }}>All caught up</div>
            <div style={{ fontSize: 12.5, marginTop: 5 }}>No decisions are waiting for your approval right now.</div>
          </div>
        )}
      </div>

      {withHistory && <DecisionLogScreen variant="history" />}
    </div>
  );
}

/** One pending decision the client acts on — full location breadcrumb + option cards. */
function PendingCard({ d, subLabel, onApprove, current = false }: { d: Decision; subLabel: string; onApprove: (optionIndex: number) => void; current?: boolean }) {
  useEffect(() => {
    if (current) document.querySelector(`[data-testid="pending-card-${CSS.escape(d.id)}"]`)?.scrollIntoView({ block: 'center' });
  }, [current, d.id]);
  return (
    <div
      data-testid={`pending-card-${d.id}`}
      aria-current={current ? 'true' : undefined}
      style={{ background: '#fff', border: '1px solid rgba(35,33,28,.12)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--sh-card)', outline: current ? '2px solid var(--accent)' : undefined, outlineOffset: 2 }}
    >
      <div style={{ padding: '15px 16px 12px', borderBottom: '1px solid rgba(35,33,28,.08)' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)' }}>{d.id}</div>
        {/* WHERE this choice applies — the same trail the PMC's register shows, so the client
            and the architect read one coordinate. Falls back to the legacy free-text room. */}
        <LocationContext nodeId={d.nodeId} fallback={subLabel || d.room} compact testId={`client-decision-place-${d.id}`} />
        <div style={{ fontWeight: 700, fontSize: 18, marginTop: 3 }}>{d.title}</div>
        {d.status === 'change' && d.changeRequest && <ChangeRequestContext d={d} />}
        {/* #482 follow-up — the advice on this choice and the client's own change request, as on the one-decision screen */}
        <WaitingCardActions d={d} />
      </div>
      <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {d.options.map((o, i) => {
          const isRec = o.recommended;
          return (
            <div key={o.key} style={{ border: `1.5px solid ${isRec ? 'var(--ink)' : 'rgba(35,33,28,.14)'}`, borderRadius: 13, padding: 11, position: 'relative', background: isRec ? '#FBF7F0' : '#fff' }}>
              {isRec && (
                <div style={{ position: 'absolute', top: -9, left: 12, fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '.1em', background: 'var(--ink)', color: 'var(--sidebar-text)', padding: '2px 8px', borderRadius: 10 }}>
                  ★ ARCHITECT&apos;S PICK
                </div>
              )}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Swatch swatch={o.swatch} size={56} radius={10} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>{o.material}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: o.delta === 0 ? 'var(--muted)' : 'var(--amber-text)', marginTop: 2 }}>
                    {o.delta === 0 ? 'Baseline (no extra cost)' : signed(o.delta)}
                  </div>
                </div>
              </div>
              <Button variant={isRec ? 'ink' : 'light'} fullWidth onClick={() => onApprove(i)} data-testid={`approve-${d.id}-${o.key}`} style={{ marginTop: 11, padding: 12 }}>
                Approve {o.label}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
