import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { isStrandedCountersign, selectPhase6_4dOpen } from '@/store/selectors';
import { isCountersignChainOp } from '@/data/apiGateway';
// the LEAF module, not the `@/components` barrel (the `ConsultationThread` convention: this component is
// itself exported from that barrel, so importing through it would close a cycle)
import { Button } from './Button';
import { readImpact } from '@/lib/impactInput';
import { can, viewerIsDecider, countersignLabels as L, memberRoleIn, type Decision, type Lang } from '@vitan/shared';

/**
 * Phase 6 task 4d-ii-b / B5b — the countersign chain's AFFORDANCES and CONTROLS on a register row (the web
 * arms of P30, P33 and P34; 4d-ii-a / A8a, A8b):
 *
 * - **Forward** on an OPEN decision (`pending` / `change`) for its holder, the PMC and an architect —
 *   rendered ONLY while the shell reads `rollout.phase6_4d = 'open'` (`selectPhase6_4dOpen`, B1's one read),
 *   because the server refuses every forward 409 while the six reservation doors stand (P29c's "no Forward
 *   renders" arm);
 * - the ARCHITECT's controls on a decision AWAITING its countersign — Countersign, Reject back
 *   (`disagree` / `reject_back`), Forward on (`disagree` / `forward_on` with the target);
 * - the PMC's STRANDED resolution — Complete / Return — on an awaiting decision served WITHOUT the
 *   `countersignRequired` overlay (`isStrandedCountersign`: the chain's activity as the DTO exposes it); both
 *   through the required-reason form (the reason is persisted as the resolution's own), and a Return re-homes
 *   the decision ONLY when the PMC chooses a target.
 *
 * Every control dispatches one of B5a's write-ahead acts (one key per act; the server's refusal surfaced as
 * its own words) and is DISABLED while an act on this decision is still in the outbox ("Working…"). The
 * reason is required at the client layer where the shared contract requires it. The optional cost and
 * schedule impacts (Reject back, Forward on, the stranded Return) are read by `readImpact`: blank is 0, a
 * whole number is sent exactly as typed, and anything else is REFUSED with the reason shown under its field
 * and the send disabled — never repaired into a different amount (#482 comment 5923291892). Nothing here
 * renders for a delivered role while the doors stand: no row can be awaiting and the rollout reads reserved.
 */
type Designation = 'client' | 'pmc' | 'member' | 'architect';
type Panel = 'forward' | 'reject_back' | 'forward_on' | 'completed' | 'returned' | null;

/** `lang` is the caller's (#482 QA item 3): the controls' own words follow it, English unless it says otherwise. */
export function CountersignControls({ decision: d, lang = 'en' }: { decision: Decision; lang?: Lang }) {
  const role = useStore((s) => s.role);
  const sessionUserId = useStore((s) => s.sessionUserId);
  const chainOpen = useStore(selectPhase6_4dOpen);
  const members = useStore(useShallow((s) => s.members));
  const loadTeam = useStore((s) => s.loadTeam);
  const pending = useStore((s) => s.outbox.some((o) => isCountersignChainOp(o) && o.decisionId === d.id));
  const forwardDecision = useStore((s) => s.forwardDecision);
  const countersignDecision = useStore((s) => s.countersignDecision);
  const disagreeDecision = useStore((s) => s.disagreeDecision);
  const resolveStrandedCountersign = useStore((s) => s.resolveStrandedCountersign);

  const [panel, setPanel] = useState<Panel>(null);
  // the target designation: NEVER defaulted (#683 review, finding 4149247992) — a Forward / Forward on
  // requires the PMC or the architect to CHOOSE one, and a stranded Return sends none unless they choose to
  // re-home the decision (the service reads a supplied target on a return as a same-bundle forward, so a
  // defaulted one would silently reassign a decision whose designation still has a holder)
  const [kind, setKind] = useState<Designation | ''>('');
  const [membershipId, setMembershipId] = useState('');
  const [reason, setReason] = useState('');
  const [cost, setCost] = useState('');
  const [days, setDays] = useState('');

  if (d.draft) return null;
  // the Forward affordance: an OPEN decision, its holder / the PMC / an architect, and the chain OPEN —
  // the exact set the service admits; an awaiting decision is the architect's (forward on, below)
  const open = d.status === 'pending' || d.status === 'change';
  const awaiting = d.status === 'awaiting_countersign';
  const mayForward = chainOpen && open && can('decision.forward', role)
    && (role === 'pmc' || role === 'architect' || viewerIsDecider(d, role, sessionUserId));
  const mayCountersign = awaiting && role === 'architect' && can('decision.countersign', role) && can('decision.disagree', role);
  const mayResolve = role === 'pmc' && isStrandedCountersign(d) && can('decision.resolveStrandedCountersign', role);
  if (!mayForward && !mayCountersign && !mayResolve) return null;

  const openPanel = (p: Panel) => {
    setPanel(p);
    setReason(''); setCost(''); setDays(''); setMembershipId(''); setKind('');
    // the target chooser draws from the roster only `loadTeam()` fills — load it when it opens over an empty slice
    if ((p === 'forward' || p === 'forward_on' || p === 'returned') && !members.length) void loadTeam();
  };
  const hasTarget = panel === 'forward' || panel === 'forward_on' || panel === 'returned';
  const targetRequired = panel === 'forward' || panel === 'forward_on';
  // the target as the shared input carries it: absent when none was chosen (a stranded Return keeps its decider)
  const target = kind === '' ? {} : kind === 'member' ? { toDesignationKind: kind, toDesignationMembershipId: membershipId } : { toDesignationKind: kind };
  const targetComplete = (kind !== '' || !targetRequired) && (kind !== 'member' || !!membershipId);
  // the impacts, read exactly or refused (never repaired); only the panels that show the fields carry them
  const hasImpacts = panel === 'reject_back' || panel === 'forward_on' || panel === 'returned';
  const costReading = readImpact(cost, 'cost');
  const daysReading = readImpact(days, 'days');
  const impactsValid = !hasImpacts || (costReading.ok && daysReading.ok);
  const impacts = costReading.ok && daysReading.ok ? { costImpact: costReading.value, timeImpactDays: daysReading.value } : null;
  const send = () => {
    const r = reason.trim();
    if (!r || !targetComplete) return;
    // a refused impact sends NOTHING: the button is disabled, and this guard holds even if it is not
    if (hasImpacts && !impacts) return;
    // only the three impact panels read `chosen`, and for them it is the exact reading (the guard above)
    const chosen = impacts ?? { costImpact: 0, timeImpactDays: 0 };
    if (panel === 'forward') forwardDecision(d.id, { ...target, reason: r } as Parameters<typeof forwardDecision>[1]);
    if (panel === 'reject_back') disagreeDecision(d.id, { path: 'reject_back', reason: r, ...chosen });
    if (panel === 'forward_on') disagreeDecision(d.id, { path: 'forward_on', reason: r, ...chosen, ...target });
    // the PMC's OWN reason on both outcomes: the service persists it as the immutable resolution reason
    // (#683 review, finding 4149247987), so Complete goes through the same required-reason form as Return
    if (panel === 'completed') resolveStrandedCountersign(d.id, { outcome: 'completed', reason: r });
    if (panel === 'returned') resolveStrandedCountersign(d.id, { outcome: 'returned', reason: r, ...chosen, ...target });
    setPanel(null);
  };
  const askable = members.filter((m) => m.status === 'active' && m.membershipId);
  const btn: CSSProperties = { padding: '6px 12px', fontSize: 11.5, fontWeight: 500 };
  const working = pending ? L.working[lang] : null;

  return (
    <div data-testid={`chain-controls-${d.id}`} style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {mayForward && (
          <Button variant="outline" style={btn} disabled={pending} onClick={() => openPanel('forward')} data-testid={`forward-${d.id}`}>{working ?? L.forward[lang]}</Button>
        )}
        {mayCountersign && (
          <>
            <Button variant="success" style={btn} disabled={pending} onClick={() => countersignDecision(d.id)} data-testid={`countersign-${d.id}`}>{working ?? L.countersign[lang]}</Button>
            <Button variant="outline" style={btn} disabled={pending} onClick={() => openPanel('reject_back')} data-testid={`reject-back-${d.id}`}>{working ?? L.rejectBack[lang]}</Button>
            <Button variant="outline" style={btn} disabled={pending} onClick={() => openPanel('forward_on')} data-testid={`forward-on-${d.id}`}>{working ?? L.forwardOn[lang]}</Button>
          </>
        )}
        {mayResolve && (
          <>
            <Button variant="success" style={btn} disabled={pending} onClick={() => openPanel('completed')} data-testid={`stranded-complete-${d.id}`}>{working ?? L.completeWithout[lang]}</Button>
            <Button variant="outline" style={btn} disabled={pending} onClick={() => openPanel('returned')} data-testid={`stranded-return-${d.id}`}>{working ?? L.returnToDecider[lang]}</Button>
          </>
        )}
      </div>
      {panel && (
        <div data-testid={`chain-panel-${d.id}`} style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(35,33,28,.035)', border: '1px solid rgba(35,33,28,.12)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)' }}>
            {(panel === 'forward' ? L.forwardTo : panel === 'reject_back' ? L.rejectBackTitle : panel === 'forward_on' ? L.forwardOnTo : panel === 'completed' ? L.completeWithout : L.returnToDecider)[lang]}
          </div>
          {hasTarget && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select aria-label={(panel === 'returned' ? L.rehomeTo : L.forwardTo)[lang]} value={kind} onChange={(e) => setKind(e.target.value as Designation | '')} style={{ ...fld, flex: '0 0 200px' }} data-testid={`chain-kind-${d.id}`}>
                <option value="">{(panel === 'returned' ? L.keepDecider : L.chooseWho)[lang]}</option>
                <option value="client">{L.kindClient[lang]}</option>
                <option value="pmc">{L.kindPmc[lang]}</option>
                <option value="member">{L.kindMember[lang]}</option>
                <option value="architect">{L.kindArchitect[lang]}</option>
              </select>
              {kind === 'member' && (
                <select aria-label={L.namedMember[lang]} value={membershipId} onChange={(e) => setMembershipId(e.target.value)} style={{ ...fld, flex: '1 1 160px' }} data-testid={`chain-member-${d.id}`}>
                  <option value="">{L.chooseMember[lang]}</option>
                  {askable.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.name} · {memberRoleIn(m.role, lang)}</option>)}
                </select>
              )}
            </div>
          )}
          <textarea aria-label={L.reason[lang]} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={L.reasonHint[lang]} data-testid={`chain-reason-${d.id}`}
            style={{ width: '100%', fontSize: 12.5, padding: 8, borderRadius: 8, border: '1px solid var(--hairline)', font: 'inherit' }} />
          {hasImpacts && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px' }}>
                <input aria-label={L.cost[lang]} value={cost} onChange={(e) => setCost(e.target.value)} placeholder={L.costHint[lang]}
                  aria-invalid={!costReading.ok} aria-describedby={!costReading.ok ? `chain-cost-error-${d.id}` : undefined}
                  style={{ ...fld, ...(costReading.ok ? null : invalid) }} data-testid={`chain-cost-${d.id}`} />
                {!costReading.ok && <div id={`chain-cost-error-${d.id}`} role="alert" style={err} data-testid={`chain-cost-error-${d.id}`}>{costReading.reason}</div>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 120px' }}>
                <input aria-label={L.days[lang]} value={days} onChange={(e) => setDays(e.target.value)} placeholder={L.daysHint[lang]}
                  aria-invalid={!daysReading.ok} aria-describedby={!daysReading.ok ? `chain-days-error-${d.id}` : undefined}
                  style={{ ...fld, ...(daysReading.ok ? null : invalid) }} data-testid={`chain-days-${d.id}`} />
                {!daysReading.ok && <div id={`chain-days-error-${d.id}`} role="alert" style={err} data-testid={`chain-days-error-${d.id}`}>{daysReading.reason}</div>}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ink" style={btn} disabled={pending || !reason.trim() || !targetComplete || !impactsValid} onClick={send} data-testid={`chain-send-${d.id}`}>
              {(panel === 'forward' ? L.forward : panel === 'reject_back' ? L.sendBack : panel === 'forward_on' ? L.forwardOn : panel === 'completed' ? L.complete : L.return)[lang]}
            </Button>
            <Button variant="outline" style={btn} onClick={() => setPanel(null)} data-testid={`chain-cancel-${d.id}`}>{L.cancel[lang]}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const fld: CSSProperties = { height: 40, padding: '0 10px', borderRadius: 8, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--ink)', outline: 'none' };
const invalid: CSSProperties = { borderColor: 'var(--red-solid)' };
const err: CSSProperties = { fontSize: 11.5, lineHeight: 1.35, color: 'var(--red-solid)' };
