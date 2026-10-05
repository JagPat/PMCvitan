import { useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectLogDecisions } from '@/store/selectors';
import { Eyebrow, DecisionChip, Button, LocationContext, EditState, ConsultationThread, CountersignControls } from '@/components';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import { Lock, Plus, ChevronRight } from '@/lib/icons';
import { deciderNoun, signed, swatch as swatchGradient, decisionRail, can, type Decision } from '@vitan/shared';
import { groupDecisions, locationSegments, type GroupBy } from '@/lib/locationTree';
import styles from './responsive.module.css';

const GROUP_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: 'location', label: 'Location' },
  { key: 'room', label: 'Room' },
  { key: 'element', label: 'Object' },
  { key: 'status', label: 'Status' },
  { key: 'flat', label: 'All' },
];
// Phase 6 task 4a — the register keeps withdrawn rows (pmc-only; the server filters them out of every
// other role's snapshot, so that chip simply never matches for them).
// Phase 6 task 4d-ii-b / B3 — the filter set answers EVERY status (the API's status tripwire pins it): a
// record is a filed fact the reader may want alone, and a decision awaiting the architect's countersign is
// its own state between approval and lock. Neither new chip matches a row while the doors stand (no row can
// be awaiting) unless the project files records.
const STATUS_FILTERS: { key: Decision['status']; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'change', label: 'Change' },
  { key: 'withdrawn', label: 'Withdrawn' },
  { key: 'recorded', label: 'Recorded' },
  { key: 'awaiting_countersign', label: 'Awaiting countersign' },
];

export function DecisionLogScreen() {
  const rows = useStore(useShallow(selectLogDecisions));
  const nodes = useStore(useShallow((s) => s.nodes));
  const openChange = useStore((s) => s.openChange);
  const withdrawChange = useStore((s) => s.withdrawChange);
  const openWithdraw = useStore((s) => s.openWithdraw);
  const role = useStore((s) => s.role);
  const sessionToken = useStore((s) => s.sessionToken);
  // who am I? — the JWT sub, for the requester-may-withdraw rule (null in demo mode)
  const mySub = useMemo(() => {
    if (!sessionToken) return null;
    try {
      return (JSON.parse(atob(sessionToken.split('.')[1])) as { sub?: string }).sub ?? null;
    } catch {
      return null;
    }
  }, [sessionToken]);
  // the SERVICE narrows withdraw to the requester or the PMC — mirror it so the
  // button only appears where the server would accept the call. Phase 6 task 4d-ii-b / B4 (P33's web
  // arm): a request the ARCHITECT opened by rejecting a countersign (`origin: 'countersign_rejection'`)
  // cannot be withdrawn by anyone — withdrawing it would complete an approval the architect refused —
  // and the service 409s the call (4d-ii-a / A7b), so the affordance is not offered. Only that origin is
  // named: a request with no origin is a standard one from any server, before or after 4d.
  const mayWithdraw = (d: Decision): boolean =>
    can('decision.withdrawChange', role)
    && d.changeRequest?.origin !== 'countersign_rejection'
    && (role === 'pmc' || (!!mySub && d.changeRequest?.requestedById === mySub));
  // Phase 6 task 4a — withdrawing the DECISION itself: pmc only, and only a published,
  // never-approved pending row is eligible (the service refuses everything else with a 409)
  const mayWithdrawDecision = (d: Decision): boolean =>
    can('decision.withdraw', role) && d.status === 'pending' && !d.draft;
  const [issuing, setIssuing] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('location');
  const [query, setQuery] = useState('');
  const [statuses, setStatuses] = useState<Set<Decision['status']>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((d) => {
      if (statuses.size && !statuses.has(d.status)) return false;
      if (!q) return true;
      const hay = [d.title, d.room, d.id, d.material ?? '', ...locationSegments(d, nodes)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, nodes, query, statuses]);

  const groups = useMemo(() => groupDecisions(filtered, nodes, groupBy), [filtered, nodes, groupBy]);
  const toggleStatus = (s: Decision['status']) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className={`${styles.screen} ${styles.narrow}`}>
      <Eyebrow>CLIENT DECISION LOG</Eyebrow>
      <div className={styles.headRule} style={{ margin: '6px 0 8px' }}>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>Decision Register</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{filtered.length} {filtered.length === 1 ? 'DECISION' : 'DECISIONS'}</div>
          {can('decision.create', role) && (
            <Button variant="ink" onClick={() => setIssuing(true)} data-testid="issue-decision" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
              <Plus size={15} /> Issue decision
            </Button>
          )}
        </div>
      </div>
      {issuing && <IssueDecisionModal onClose={() => setIssuing(false)} />}

      {/* controls: group-by, search, status filter */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0 4px' }}>
        <div role="tablist" aria-label="Group by" style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 2 }}>
          {GROUP_OPTIONS.map((g) => {
            const on = groupBy === g.key;
            return (
              <button key={g.key} onClick={() => setGroupBy(g.key)} data-testid={`groupby-${g.key}`} style={{ padding: '6px 11px', minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, background: on ? 'var(--ink)' : 'transparent', color: on ? '#fff' : 'var(--muted)' }}>
                {g.label}
              </button>
            );
          })}
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search decisions…" data-testid="decision-search" style={{ ...fldD, flex: '1 1 160px', minWidth: 44 }} />
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '8px 0 20px' }}>
        {STATUS_FILTERS.map((s) => {
          const on = statuses.has(s.key);
          return (
            <button key={s.key} onClick={() => toggleStatus(s.key)} data-testid={`filter-${s.key}`} style={{ padding: '5px 11px', minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 20, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`, background: on ? 'var(--ink)' : 'var(--panel)', color: on ? '#fff' : 'var(--muted)' }}>
              {s.label}
            </button>
          );
        })}
      </div>

      {groups.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13.5, padding: '10px 0' }}>No decisions match your filters.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          const single = groupBy === 'flat';
          return (
            <div key={g.key} data-testid={`group-${g.key}`}>
              {!single && (
                <button
                  onClick={() => toggleGroup(g.key)}
                  data-testid={`group-head-${g.key}`}
                  style={{ width: '100%', minHeight: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '9px 4px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', textAlign: 'left', marginBottom: isCollapsed ? 0 : 12 }}
                >
                  <ChevronRight size={15} style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s', color: 'var(--muted)' }} />
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{g.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>{g.counts.total}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {g.counts.pending > 0 && <RollupChip n={g.counts.pending} color="var(--amber-solid)" label="pending" />}
                    {g.counts.change > 0 && <RollupChip n={g.counts.change} color="var(--red-solid)" label="change" />}
                    {g.counts.awaiting_countersign > 0 && <RollupChip n={g.counts.awaiting_countersign} color={decisionRail.awaiting_countersign} label="awaiting countersign" />}
                    {g.counts.approved > 0 && <RollupChip n={g.counts.approved} color="var(--green-solid)" label="approved" />}
                    {g.counts.withdrawn > 0 && <RollupChip n={g.counts.withdrawn} color="var(--muted)" label="withdrawn" />}
                    {g.counts.recorded > 0 && <RollupChip n={g.counts.recorded} color="var(--muted)" label="recorded" />}
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {g.rows.map(({ decision, subLabel }) => (
                    <DecisionRowCard
                      key={decision.id}
                      d={decision}
                      subLabel={subLabel}
                      onChange={() => openChange(decision.id)}
                      onWithdraw={mayWithdraw(decision) ? () => withdrawChange(decision.id) : undefined}
                      onWithdrawDecision={mayWithdrawDecision(decision) ? () => openWithdraw(decision.id) : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RollupChip({ n, color, label }: { n: number; color: string; label: string }) {
  return (
    <span title={`${n} ${label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      {n}
    </span>
  );
}

/** One decision card — the register row, with its finer location shown as a caption. */
function DecisionRowCard({ d, subLabel, onChange, onWithdraw, onWithdrawDecision }: { d: Decision; subLabel: string; onChange: () => void; onWithdraw?: () => void; onWithdrawDecision?: () => void }) {
  const locked = d.status === 'approved';
  // Phase 6 task 4b (round-1 Codex F2) — a RECORD is a filed fact: no approver, no options, no
  // approval demand, no cost. It renders its own branch instead of borrowing the approved shape.
  const recorded = d.status === 'recorded';
  // Phase 6 task 4d-ii-b / B3 — a decision AWAITING its countersign carries its decider's PROVISIONAL
  // approval (the chosen option, the approver, the cost) but no lock: the attribution says who approved
  // it and what it still waits for, the photo tag says PROVISIONAL, and the lock icon stays final-only.
  const awaiting = d.status === 'awaiting_countersign';
  // Phase 6 task 4a — a withdrawn decision was never approved: it renders its options (never a
  // fabricated approval line), and its attribution names the withdrawer, not an approver.
  const neverLocked = d.status === 'pending' || d.status === 'withdrawn';
  // round-5 Codex F2 — the open-row attribution names the ACTUAL decider (the shared
  // `deciderNoun`): a pmc- or member-held row must not direct its own decider at the client.
  // The client-held text stays byte-identical (the legacy default).
  const kind = d.deciderKind ?? 'client';
  const attribution = recorded
    ? 'Issue recorded — no approval required'
    : d.status === 'withdrawn'
      ? `Withdrawn by ${d.withdrawnBy ?? 'the PMC'}${d.withdrawnAt ? ` · ${new Date(d.withdrawnAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}`
      : awaiting
        ? `Approved by ${d.approver ?? deciderNoun(kind)} — awaiting the architect’s countersign`
        : d.approver
          ? `Approved by ${d.approver}${d.onBehalfOf ? ` (on behalf of the ${d.onBehalfOf})` : ''} · ${d.date}`
          : `Ageing ${d.ageDays} days · ${kind === 'client' ? 'awaiting client' : `awaiting ${deciderNoun(kind)}`}`;
  const approvedLine = recorded
    ? 'Filed on the register — nothing approvable'
    : neverLocked ? `${d.options.length} options presented` : `${d.approvedOption} — ${d.material}`;
  const costStr = recorded
    ? '—'
    : neverLocked ? 'up to ' + signed(Math.max(...d.options.map((o) => o.delta))) : signed(d.cost ?? 0);
  const photoLabel = recorded ? 'RECORDED' : neverLocked ? 'OPTIONS' : awaiting ? 'PROVISIONAL' : 'APPROVED';

  return (
    <div
      data-testid={`log-row-${d.id}`}
      style={{ background: 'var(--panel)', border: '1px solid var(--hairline)', borderLeft: `4px solid ${decisionRail[d.status]}`, borderRadius: 12, overflow: 'hidden', animation: 'vpop .3s' }}
    >
      <div className={styles.logRow}>
        <div className={styles.logPhoto} style={{ background: swatchGradient(d.photoSwatch ?? ''), position: 'relative', flex: 'none' }}>
          <span style={{ position: 'absolute', left: 8, bottom: 8, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,.9)', background: 'rgba(0,0,0,.4)', padding: '1px 6px', borderRadius: 3 }}>{photoLabel}</span>
        </div>
        <div style={{ flex: 1, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                <span style={{ fontWeight: 600, fontSize: 16 }}>{d.title}</span>
                {locked && <Lock size={13} data-testid={`lock-${d.id}`} />}
              </div>
              {/* WHERE this decision belongs — tappable back to the Site Map at that place.
                  `subLabel` (the finer location under the group header) stays the fallback for a
                  legacy free-text decision that never got a node. */}
              <div style={{ marginTop: 3 }}>
                <LocationContext nodeId={d.nodeId} fallback={subLabel || d.room} compact testId={`decision-place-${d.id}`} />
              </div>
            </div>
            <DecisionChip status={d.status} />
          </div>
          {d.status === 'withdrawn' && d.withdrawReason && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(35,33,28,.05)', border: '1px solid rgba(35,33,28,.14)' }} data-testid={`withdraw-detail-${d.id}`}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>Withdrawn: {d.withdrawReason}</div>
            </div>
          )}
          {/* Phase 6 unit 4c-ii — the consultation thread and its affordances. Renders nothing at
              all off-pilot (the component reads the same per-project capability the server does),
              and nothing for a decision with no thread and no action available to this viewer. */}
          <ConsultationThread decision={d} />
          {/* Phase 6 task 4d-ii-b / B5b — the countersign chain's affordances and controls: Forward while the
              rollout is open, the architect's Countersign / Reject back / Forward on, the PMC's stranded
              resolution. Renders nothing for a delivered role while the doors stand. */}
          <CountersignControls decision={d} />
          {d.status === 'change' && d.changeRequest && (
            <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(180,70,46,.07)', border: '1px solid rgba(180,70,46,.2)' }} data-testid={`cr-detail-${d.id}`}>
              {/* Phase 6 task 4d-ii-b / B4 — a request the architect opened by REJECTING the countersign names
                  its origin: the decider reads that their provisional approval was sent back, not that a
                  colleague asked for a change. A standard request reads exactly as it always did. */}
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red-text)' }}>
                {d.changeRequest.origin === 'countersign_rejection'
                  ? <span data-testid={`cr-origin-${d.id}`}>Sent back by the architect: {d.changeRequest.reason}</span>
                  : <>Change requested: {d.changeRequest.reason}</>}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                {d.changeRequest.costImpact === 0 ? 'No cost change' : signed(d.changeRequest.costImpact)}
                {' · '}
                {d.changeRequest.timeImpactDays === 0 ? 'no schedule impact' : `${d.changeRequest.timeImpactDays} day${d.changeRequest.timeImpactDays === 1 ? '' : 's'}`}
                {` · awaiting ${deciderNoun(kind)}’s re-approval`}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(35,33,28,.1)', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{approvedLine}</div>
              <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 3 }}>{attribution}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: (d.cost ?? 0) > 0 ? 'var(--ink)' : 'var(--muted)' }}>{costStr}</div>
              {onWithdrawDecision && (
                <Button variant="outline" onClick={onWithdrawDecision} data-testid={`withdraw-decision-${d.id}`} style={{ marginTop: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 500 }}>
                  Withdraw decision
                </Button>
              )}
            </div>
          </div>
          {/* Can I edit this? If not, why — and what may I do instead? The verdict is the domain's
              (approved ⇒ locked; a change request is with the DECIDER — round-11 Codex F2:
              every message on this workflow derives from `deciderNoun(kind)`, so a pmc- or
              member-held reopening never directs anyone at the client; the client-held text is
              byte-identical since deciderNoun('client') === 'the client'). */}
          {locked && (
            <div style={{ marginTop: 10 }}>
              <EditState
                state="locked"
                reason="Locked after approval — the approved choice is the record."
                action={{ label: 'Request change', onClick: onChange, testId: `request-change-${d.id}` }}
                testId={`edit-state-${d.id}`}
              />
            </div>
          )}
          {d.status === 'change' && (
            <div style={{ marginTop: 10 }}>
              <EditState
                state="workflow"
                reason={`A change request is with ${deciderNoun(kind)} — the decision reopens when they answer.`}
                action={onWithdraw ? { label: 'Withdraw request', onClick: onWithdraw, testId: `withdraw-${d.id}` } : undefined}
                testId={`edit-state-${d.id}`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const fldD: CSSProperties = { height: 44, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
