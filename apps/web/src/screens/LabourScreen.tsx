import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button } from '@/components';
import { RefreshCw, WifiOff } from '@/lib/icons';
import type { LabourForecastVerdict, WorkerDto } from '@vitan/shared';
import { decAdd } from '@/lib/decimal';
import { allocateCoalesceKey, isAllocatePendingForSlice, musterCoalesceKey, workCoalesceKey, labourRequisitionCoalesceKey } from '@/lib/labourKeys';
import { todayCivil } from '@/lib/civilDate';
import { compatibleWorkerIds, allocatedCountFor, sourcedCountFor, pickCommitmentFor, workerActiveOn, bookedWorkerIds, unrequisitionedLines, musteredWorkerIds, remainingShiftMinutes, SHIFT_MINUTES, pendingBookedWorkerIds, hasPendingWorkFor } from '@/lib/labourSelection';
import styles from './responsive.module.css';

/**
 * Phase 4 Task 6 (§J) — the pilot LABOUR hub (capability-gated; the nav only surfaces it on a
 * labour-pilot project), cloning the Materials hub idioms exactly: ONE screen with tabbed panels
 * for the whole §A–§I pipeline — readiness → demand → suppliers → commitments → allocation →
 * attendance → productivity. It is OPERATIONAL: allocate a named worker to a demand slice, record
 * a pmc-attributable manual muster, record worked minutes against an allocation, and raise ONE
 * labour requisition for a requirement's slices — every command write-ahead + fresh-idempotency-
 * keyed + coalesced while pending (the PR-#208 two-key lifecycle), reconciled through
 * `loadLabour`. The FORECAST verdicts shown here come from the server's `labour.readiness` read;
 * the EXECUTION Team gate that authorizes `activities.start` is evaluated server-side in-tx and
 * reaches the Schedule through the baked `ActivityReadiness.team` — this screen never derives it.
 */

type Tab = 'readiness' | 'demand' | 'suppliers' | 'commitments' | 'allocation' | 'attendance' | 'productivity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'readiness', label: 'Readiness' },
  { key: 'demand', label: 'Demand' },
  { key: 'suppliers', label: 'Suppliers' },
  { key: 'commitments', label: 'Commitments' },
  { key: 'allocation', label: 'Allocation' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'productivity', label: 'Productivity' },
];

function verdictChip(v: LabourForecastVerdict): { label: string; bg: string; fg: string; border: string } {
  if (v === 'ready') return { label: 'READY', bg: 'var(--green-chip, #E7F0E9)', fg: 'var(--green-text, #2F6B44)', border: '#BFD8C6' };
  if (v === 'at-risk') return { label: 'AT-RISK', bg: 'var(--amber-chip)', fg: 'var(--amber-text)', border: 'var(--amber-border)' };
  return { label: 'BLOCKED', bg: 'var(--red-chip, #F6E4E1)', fg: 'var(--red-text, #B4462E)', border: '#E1BEB6' };
}

const chip = (m: { label: string; bg: string; fg: string; border: string }): CSSProperties => ({
  display: 'inline-block', background: m.bg, color: m.fg, border: `1px solid ${m.border}`,
  borderRadius: 6, padding: '2px 7px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
});
const rowCard: CSSProperties = { border: '1px solid var(--hairline)', borderRadius: 11, padding: '11px 13px', marginTop: 10, background: 'var(--panel)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--faint)' };
const muted: CSSProperties = { fontSize: 12.5, color: 'var(--muted)' };
const selectStyle: CSSProperties = { border: '1px solid var(--hairline)', borderRadius: 7, padding: '6px 8px', fontSize: 12, background: 'var(--canvas)', color: 'var(--ink)' };

// The raise action's lines are the UNREQUISITIONED residual per demand slice (Codex round 3) —
// see `unrequisitionedLines`; a fully-requisitioned requirement yields [] and shows no button.

export function LabourScreen() {
  const labour = useStore(useShallow((s) => s.labourView));
  const labourLoad = useStore((s) => s.labourLoad);
  const labourPending = useStore(useShallow((s) => s.labourPending));
  const outbox = useStore(useShallow((s) => s.outbox));
  const activities = useStore(useShallow((s) => s.activities));
  const role = useStore((s) => s.role);
  const timeZone = useStore((s) => s.timeZone);
  const loadLabour = useStore((s) => s.loadLabour);
  const allocateWorker = useStore((s) => s.allocateWorker);
  const musterWorker = useStore((s) => s.musterWorker);
  const recordWorkedMinutes = useStore((s) => s.recordWorkedMinutes);
  const raiseLabourRequisition = useStore((s) => s.raiseLabourRequisition);
  const setScreen = useStore((s) => s.setScreen);
  const [tab, setTab] = useState<Tab>('readiness');
  // per-slice worker choice for the Allocate action, keyed `${requirementId}:${civilDate}`
  const [allocWorker, setAllocWorker] = useState<Record<string, string>>({});
  // per-allocation worked-minutes entry (default one full 8h day shift)
  const [workMinutes, setWorkMinutes] = useState<Record<string, string>>({});
  // the manual-muster form (the pmc-attributable exception path — device taps come from the
  // worker's own bound device, never this hub)
  const [musterWorkerId, setMusterWorkerId] = useState('');
  const [musterShift, setMusterShift] = useState<'day' | 'night'>('day');
  const [musterReason, setMusterReason] = useState('');

  const reading = (labourLoad === 'idle' || labourLoad === 'loading') && !labour;
  const unavailable = labourLoad === 'error' && !labour;
  const stale = labourLoad === 'error' && !!labour;
  const pending = (key: string): boolean => labourPending.includes(key);

  const activityName = (id: string): string => activities.find((a) => a.id === id)?.name ?? id;
  // Codex round 6 — supplier draws still IN FLIGHT: a queued allocate op carrying a commitment id
  // must reserve that capacity in the picker, or a second worker chosen before the labour reload
  // lands re-picks a fully-drawn commitment and the flush 409s the second command under §F
  // bound 3 (own-workforce would have covered the remaining demand).
  const pendingDraws: Record<string, number> = {};
  for (const op of outbox) {
    if (op.t === 'allocateLabour' && typeof op.input.capacityCommitmentId === 'string') {
      pendingDraws[op.input.capacityCommitmentId] = (pendingDraws[op.input.capacityCommitmentId] ?? 0) + 1;
    }
  }
  // Codex round 7 — the queued allocate ops also RESERVE their worker for the (date, shift)
  // (`pendingBookedWorkerIds`), and the queued work ops disable further entry for their
  // allocation/worker-shift (`hasPendingWorkFor`) — both folded from the durable outbox.
  const pendingAllocInputs = outbox.flatMap((op) => (op.t === 'allocateLabour' ? [op.input] : []));
  const pendingWorkIds = new Set(outbox.flatMap((op) => (op.t === 'recordLabourWork' ? [op.input.allocationId] : [])));
  const forecastEntries = labour ? Object.entries(labour.readiness.forecast) : [];
  const readyCount = forecastEntries.filter(([, f]) => f.verdict === 'ready').length;
  const atRiskCount = forecastEntries.filter(([, f]) => f.verdict === 'at-risk').length;
  const blockedCount = forecastEntries.filter(([, f]) => f.verdict === 'blocked').length;
  const labourReqs = labour ? labour.requirements.filter((r) => r.labourSpec !== null) : [];
  const workers = labour ? labour.workforce.workers.filter((w) => w.revokedAt === null) : [];
  // Codex round 2 — the muster picker offers only workers ACTIVE today (project civil day):
  // the server refuses attendance outside the active window with a terminal 400.
  const musterable = workers.filter((w) => workerActiveOn(w, todayCivil(timeZone)));
  const workerName = (id: string): string => labour?.workforce.workers.find((w) => w.id === id)?.name ?? id;
  // Codex F-TZ — the hub's "today" is the PROJECT's civil date, matching the server's
  // `clock.today(project.timeZone)` truth (a viewer abroad must muster against the site's day).
  const today = todayCivil(timeZone);
  const substitutions = labour ? labour.capacity.skillSubstitutions : [];

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Eyebrow>LABOUR · PILOT</Eyebrow>
          <div style={{ ...muted, marginTop: 6, maxWidth: 560 }}>
            One labour flow, end to end — requirement → requisition → quote → purchase order → capacity commitment → allocation → attendance → work → productivity. The Team gate reflects <b>time-capacity truth</b>: an activity is ready only when named workers are allocated — and, on the day, present.
          </div>
        </div>
        <Button variant="outline" onClick={() => loadLabour()} data-testid="labour-refresh" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 13 }}>
          <RefreshCw size={15} /> Refresh
        </Button>
      </div>

      {stale && (
        <div data-testid="labour-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>Showing the last-known labour picture — the latest couldn't load.</span>
          <button onClick={() => loadLabour()} data-testid="labour-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {reading && (
        <div data-testid="labour-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading the labour pipeline…</div>
      )}
      {unavailable && (
        <div data-testid="labour-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> Labour unavailable.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Check your connection and access, then retry.</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => loadLabour()} data-testid="labour-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> Retry
            </Button>
          </div>
        </div>
      )}

      {labour && (
        <>
          {/* forecast summary — one verdict per activity with a live labour requirement */}
          <div data-testid="labour-summary" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <SummaryTile label="Ready" value={readyCount} tone="green" />
            <SummaryTile label="At-risk" value={atRiskCount} tone="amber" />
            <SummaryTile label="Blocked" value={blockedCount} tone="red" />
            <SummaryTile label="Activities" value={forecastEntries.length} tone="ink" />
          </div>

          {/* tabs */}
          <div role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '16px 0 2px' }}>
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} data-testid={`labour-tab-${t.key}`} onClick={() => setTab(t.key)} style={tabBtn(tab === t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 8 }}>
            {tab === 'readiness' && (
              <Panel empty={!forecastEntries.length} emptyKey="readiness" emptyText="No labour requirements yet.">
                {forecastEntries.map(([activityId, f]) => {
                  const m = verdictChip(f.verdict);
                  return (
                    <div key={activityId} data-testid={`labour-activity-${activityId}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{activityName(activityId)}</div>
                        <span style={chip(m)} data-testid={`labour-verdict-${activityId}`}>{m.label}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{f.reason}{f.verdict === 'at-risk' && f.coveringDate ? ` · supplier arrival promised ${f.coveringDate}` : ''}</div>
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'demand' && (
              <Panel empty={!labourReqs.length} emptyKey="demand" emptyText="No labour demand planned.">
                {labourReqs.map((r) => {
                  const spec = r.labourSpec!;
                  // Codex round 3 — send only what the commercial chain does NOT already carry:
                  // the server's §F bound-1 counts existing open/ordered lines per slice, so a
                  // full re-send after a partial requisition is a certain terminal 409.
                  const lines = unrequisitionedLines(r.requirementId, r.revision, spec.demandSlices, labour.requisitions);
                  const reqKey = labourRequisitionCoalesceKey(lines);
                  return (
                    <div key={r.requirementId} data-testid={`labour-requirement-${r.requirementId}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{[spec.tradeCode, spec.skillCode, spec.shift].filter(Boolean).join(' · ')}</div>
                        <span style={mono}>{r.status}{r.revisions > 1 ? ` · rev ${r.revision}` : ''}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{r.qty} {r.baseUom} · needed by {r.requiredBy} · {activityName(r.activityId)}</div>
                      {spec.demandSlices.map((sl) => (
                        <div key={sl.civilDate} style={{ ...mono, marginTop: 3 }}>{sl.civilDate} · {sl.shift} · {sl.personShiftQty} person-shift{sl.personShiftQty === 1 ? '' : 's'}</div>
                      ))}
                      {r.status === 'open' && lines.length > 0 && (
                        <div style={{ marginTop: 9 }}>
                          <Button variant="outline" disabled={pending(reqKey)} data-testid={`labour-raise-req-${r.requirementId}`} onClick={() => raiseLabourRequisition(`Source ${spec.tradeCode} for ${activityName(r.activityId)}`, lines)} style={{ fontSize: 12 }}>
                            {pending(reqKey) ? 'Raising…' : 'Raise labour requisition'}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'suppliers' && (
              <Panel empty={!labour.requisitions.length && !labour.purchaseOrders.length} emptyKey="suppliers" emptyText="No labour requisitions or purchase orders yet.">
                {labour.requisitions.map((rq) => (
                  <div key={rq.id} data-testid={`labour-requisition-${rq.id}`} style={rowCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{rq.title || 'Labour requisition'}</div>
                      <span style={mono}>REQ · {rq.status}</span>
                    </div>
                    <div style={{ ...muted, marginTop: 4 }}>{rq.lines.length} slice{rq.lines.length === 1 ? '' : 's'} · {rq.lines.reduce((s, l) => s + l.personShiftQty, 0)} person-shifts</div>
                  </div>
                ))}
                {labour.purchaseOrders.map((po) => {
                  const v = po.currentVersion;
                  return (
                    <div key={po.id} data-testid={`labour-po-${po.id}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Labour purchase order</div>
                        <span style={mono}>PO v{v.version} · {v.status}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{v.lines.length} slice{v.lines.length === 1 ? '' : 's'} · ₹{v.lines.reduce((s, l) => decAdd(s, l.committedAmountBase), '0')} committed · {v.lines.reduce((s, l) => s + l.committedQty, 0)}/{v.lines.reduce((s, l) => s + l.personShiftQty, 0)} person-shifts committed</div>
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'commitments' && (
              <Panel empty={!labour.commitments.length} emptyKey="commitments" emptyText="No supplier capacity committed yet.">
                {labour.commitments.map((c) => (
                  <div key={c.id} data-testid={`labour-commitment-${c.id}`} style={rowCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.civilDate} · {c.shift} · {c.personShiftQty} person-shift{c.personShiftQty === 1 ? '' : 's'}</div>
                      <span style={mono}>{c.status}</span>
                    </div>
                    <div style={{ ...muted, marginTop: 4 }}>arrival promised {c.latestPromise?.promisedDate ?? '—'} · spec {c.labourSpecFingerprint.slice(0, 10)}</div>
                  </div>
                ))}
              </Panel>
            )}

            {tab === 'allocation' && (
              <Panel empty={!labourReqs.length && !labour.capacity.allocations.length} emptyKey="allocation" emptyText="No labour demand to allocate.">
                {labourReqs.filter((r) => r.status === 'open').map((r) => {
                  const spec = r.labourSpec!;
                  // Codex F1 — offer ONLY workers whose own (trade, skill, shift) identity hashes to
                  // the requirement's head fingerprint or to an ACTIVE approved substitution target;
                  // an electrician is never offered for a mason slice.
                  const compat = compatibleWorkerIds(workers, labour.workerFingerprints, spec, r.requirementId, substitutions);
                  return (
                    <div key={r.requirementId} data-testid={`labour-alloc-req-${r.requirementId}`} style={rowCard}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{[spec.tradeCode, spec.skillCode, spec.shift].filter(Boolean).join(' · ')} · {activityName(r.activityId)}</div>
                      {spec.demandSlices.map((sl) => {
                        const sliceKey = `${r.requirementId}:${sl.civilDate}`;
                        // Codex round 2 — the offer is PER SLICE: compatible AND active on the slice's
                        // civil date (the server 400s outside the window) AND not already booked on
                        // that (civilDate, shift) anywhere (§C one-live-allocation → a certain 409).
                        const booked = bookedWorkerIds(labour.capacity.allocations, labour.capacity.workFacts, sl.civilDate, sl.shift);
                        // Codex round 7 — a worker with an allocate op still IN FLIGHT for this
                        // (date, shift) is already spoken for: offering them for a second slice
                        // queues a command the server's one-live-allocation guard will 409.
                        const pendingBooked = pendingBookedWorkerIds(pendingAllocInputs, labourReqs, sl.civilDate, sl.shift);
                        const offerable = workers.filter((w: WorkerDto) => compat.has(w.id) && workerActiveOn(w, sl.civilDate) && !booked.has(w.id) && !pendingBooked.has(w.id));
                        const chosenRaw = allocWorker[sliceKey] ?? '';
                        const chosen = offerable.some((w) => w.id === chosenRaw) ? chosenRaw : ''; // a stale pick never survives an eligibility change
                        const aKey = chosen ? allocateCoalesceKey(r.activityId, r.requirementId, r.revision, sl.civilDate, chosen) : '';
                        // Codex F6 — count only allocations the server's coverage would count: ACTIVE,
                        // bound to the requirement's CURRENT activity AND a currently-satisfying
                        // fingerprint (a row stranded by a revision is not "allocated").
                        const done = allocatedCountFor(labour.capacity.allocations, r.requirementId, r.activityId, sl.civilDate, spec, substitutions);
                        // Codex rounds 2–3 — the server caps only supplier drawdown; an own-workforce
                        // allocation past the demand would strand a worker on a slice that is already
                        // satisfied. The stop counts SOURCED person-shifts (active ∪ worked, the
                        // server's coverage rule): a worked-then-released slice stays fulfilled.
                        const sourced = sourcedCountFor(labour.capacity.allocations, labour.capacity.workFacts, r.requirementId, r.activityId, sl.civilDate, spec, substitutions);
                        // Codex round 5 — count IN-FLIGHT allocations for this slice (ANY worker):
                        // the per-worker pending guard alone would let a SECOND worker be queued
                        // against a 1-person slice while the first command is still in flight — a
                        // 2/1 own-workforce over-allocation the server accepts. Codex round 6 —
                        // scoped to THIS head revision: a stale-revision op will replay, 409 and
                        // drop; it must not fill current demand and suppress the valid allocation.
                        const slicePending = labourPending.filter((k) => isAllocatePendingForSlice(k, r.activityId, r.requirementId, r.revision, sl.civilDate)).length;
                        const full = sourced + slicePending >= sl.personShiftQty;
                        // Codex F2 — a commitment-covered slice draws DOWN the matching drawable
                        // commitment (§F bound 3): pass its id so the server consumes the capacity
                        // (round 6 — queued draws reserved via `pendingDraws`).
                        const commitmentId = pickCommitmentFor(labour.commitments, labour.capacity.allocations, labour.capacity.workFacts, spec, sl.civilDate, pendingDraws);
                        return (
                          <div key={sl.civilDate} data-testid={`labour-alloc-slice-${r.requirementId}-${sl.civilDate}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 7 }}>
                            <span style={{ fontSize: 12.5, minWidth: 190 }}>{sl.civilDate} · {sl.shift} · allocated {done}/{sl.personShiftQty}{sourced > done ? ` · ${sourced}/${sl.personShiftQty} sourced incl. delivered work` : ''}{slicePending > 0 ? ` · ${slicePending} allocating…` : ''}{!full && commitmentId ? ' · supplier capacity available' : ''}</span>
                            <select value={chosen} disabled={full} data-testid={`labour-worker-select-${r.requirementId}-${sl.civilDate}`} onChange={(e) => setAllocWorker((m) => ({ ...m, [sliceKey]: e.target.value }))} style={selectStyle}>
                              <option value="">{full ? 'Fully allocated' : offerable.length ? 'Choose worker…' : 'No available workers'}</option>
                              {!full && offerable.map((w: WorkerDto) => <option key={w.id} value={w.id}>{w.name} ({w.tradeCode})</option>)}
                            </select>
                            <Button variant="outline" disabled={full || !chosen || pending(aKey)} data-testid={`labour-do-allocate-${r.requirementId}-${sl.civilDate}`} onClick={() => !full && chosen && allocateWorker(r.activityId, r.requirementId, r.revision, sl.civilDate, chosen, commitmentId)} style={{ fontSize: 11.5, flex: 'none' }}>
                              {full ? 'Fully allocated' : chosen && pending(aKey) ? 'Allocating…' : 'Allocate'}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {labour.capacity.allocations.length > 0 && (
                  <div style={{ ...mono, margin: '14px 0 2px' }}>ALLOCATIONS</div>
                )}
                {labour.capacity.allocations.map((a) => {
                  // Codex round 6 — the server's guardrail is CUMULATIVE: Σ workedMinutes per
                  // (worker, civilDate, shift) across ALL allocations ≤ SHIFT_MINUTES, re-derived
                  // under the worker lock — an entry over the REMAINING minutes is a terminal 409
                  // the outbox drops. Cap the entry at the remainder; a full shift disables it.
                  const remaining = remainingShiftMinutes(labour.capacity.workFacts, a.workerId, a.civilDate, a.shift);
                  const minutes = workMinutes[a.id] ?? String(Math.min(480, Math.max(remaining, 1)));
                  // Codex round 4 — parse the FULL numeric string: `parseInt` silently truncates
                  // '1e2'→1 and '7.5'→7, so an intended 100 minutes could be recorded as 1.
                  // `Number` evaluates the whole value; a fractional entry is simply invalid.
                  const minutesNum = minutes.trim() === '' ? Number.NaN : Number(minutes);
                  const valid = Number.isInteger(minutesNum) && minutesNum >= 1 && minutesNum <= remaining;
                  const wKey = valid ? workCoalesceKey(a.id, minutesNum) : '';
                  // Codex round 7 — the coalesce key carries the MINUTES, so editing the input
                  // while a record is pending would re-enable the button and queue a SECOND
                  // distinct command; the row stays disabled while ANY work op for this
                  // allocation/worker-shift is in flight.
                  const workPending = hasPendingWorkFor(pendingWorkIds, labour.capacity.allocations, a);
                  // Codex round 3 — no ACTUAL work before the shift's civil day: a future-dated
                  // booking must not mint delivered-work evidence (productivity + Team coverage
                  // would read a shift as worked before it occurs).
                  const future = a.civilDate > today;
                  return (
                    <div key={a.id} data-testid={`labour-allocation-${a.id}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{workerName(a.workerId)} → {activityName(a.activityId)}</div>
                        <span style={mono}>{a.status}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{a.civilDate} · {a.shift}{a.capacityCommitmentId ? ' · supplier capacity' : ' · own workforce'}</div>
                      {a.status === 'active' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                          <input type="number" min={1} max={remaining} value={minutes} disabled={future || remaining <= 0 || workPending} data-testid={`labour-work-minutes-${a.id}`} onChange={(e) => setWorkMinutes((m) => ({ ...m, [a.id]: e.target.value }))} style={{ ...selectStyle, width: 76 }} />
                          <span style={muted}>min{remaining < SHIFT_MINUTES ? ` · ${remaining} left this shift` : ''}</span>
                          <Button variant="outline" disabled={future || remaining <= 0 || workPending || !valid || pending(wKey)} data-testid={`labour-do-work-${a.id}`} onClick={() => !future && remaining > 0 && !workPending && valid && recordWorkedMinutes(a.id, minutesNum)} style={{ fontSize: 11.5, flex: 'none' }}>
                            {future ? 'Future shift' : remaining <= 0 ? 'Shift full' : workPending ? 'Recording…' : 'Record work'}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'attendance' && (
              <>
                {/* Codex F-PMC — the manual muster is a `labour.override` exception the server allows
                    ONLY to pmc; for any other role the form is absent (an engineer's click would be a
                    guaranteed 403 the outbox discards). Workers normally tap their own bound device. */}
                {role === 'pmc' && (
                <div style={rowCard}>
                  <div style={{ ...mono, marginBottom: 6 }}>MARK PRESENT — {today} (manual exception; workers normally tap their own bound device)</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {(() => {
                      // Codex round 6 — a worker with an ACTIVE muster for this (day, shift) is not
                      // offered again: the second muster is the server's deterministic 409
                      // ("already recorded — revoke it to correct it") the outbox drops as terminal.
                      const alreadyMustered = musteredWorkerIds(labour.presence.musters, musterShift);
                      const musterOfferable = musterable.filter((w) => !alreadyMustered.has(w.id));
                      const ready = musterOfferable.some((w) => w.id === musterWorkerId) && musterReason.trim().length > 0;
                      const mKey = ready ? musterCoalesceKey(musterWorkerId, today, musterShift) : '';
                      return (
                        <>
                          <select value={musterOfferable.some((w) => w.id === musterWorkerId) ? musterWorkerId : ''} data-testid="labour-muster-worker-select" onChange={(e) => setMusterWorkerId(e.target.value)} style={selectStyle}>
                            <option value="">{musterOfferable.length ? 'Choose worker…' : 'All active workers already mustered'}</option>
                            {musterOfferable.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.tradeCode})</option>)}
                          </select>
                          <select value={musterShift} data-testid="labour-muster-shift" onChange={(e) => setMusterShift(e.target.value === 'night' ? 'night' : 'day')} style={selectStyle}>
                            <option value="day">day</option>
                            <option value="night">night</option>
                          </select>
                          <input value={musterReason} placeholder="Reason (e.g. device battery dead)" data-testid="labour-muster-reason" onChange={(e) => setMusterReason(e.target.value)} style={{ ...selectStyle, flex: '1 1 180px' }} />
                          <Button variant="outline" disabled={!ready || pending(mKey)} data-testid="labour-do-muster" onClick={() => ready && musterWorker(musterWorkerId, today, musterShift, musterReason.trim())} style={{ fontSize: 11.5, flex: 'none' }}>
                            {ready && pending(mKey) ? 'Recording…' : 'Mark present'}
                          </Button>
                        </>
                      );
                    })()}
                  </div>
                </div>
                )}
                <Panel empty={!labour.presence.musters.length && !labour.presence.mismatches.length} emptyKey="attendance" emptyText="No attendance recorded today.">
                  {labour.presence.musters.map((mu) => (
                    <div key={`${mu.workerId}-${mu.shift}`} data-testid={`labour-muster-${mu.workerId}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{mu.workerName} · {mu.tradeCode}</div>
                        <span style={mono}>{mu.shift} · {mu.deviceId ? 'device' : 'manual'}</span>
                      </div>
                      {mu.manualReason && <div style={{ ...muted, marginTop: 4 }}>manual: {mu.manualReason}</div>}
                    </div>
                  ))}
                  {labour.presence.mismatches.map((mm) => (
                    <div key={mm.id} data-testid={`labour-mismatch-${mm.id}`} style={{ ...rowCard, borderColor: 'var(--amber-border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--amber-text)' }}>Crew ≠ allocated · {mm.kind === 'wrong_trade' ? 'wrong trade' : 'shortfall'}</div>
                        <span style={mono}>{mm.shift}{mm.workerId ? ` · ${workerName(mm.workerId)}` : ''}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{mm.note} · unresolved — blocks the Team gate until pmc resolves it</div>
                    </div>
                  ))}
                </Panel>
              </>
            )}

            {tab === 'productivity' && (
              <Panel empty={!labour.productivity.activities.length} emptyKey="productivity" emptyText="No work recorded yet.">
                {labour.productivity.activities.map((pa) => (
                  <div key={pa.activityId} data-testid={`labour-productivity-${pa.activityId}`} style={rowCard}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{activityName(pa.activityId)}</div>
                    {pa.rows.map((row) => (
                      <div key={`${row.civilDate}-${row.shift}`} style={{ ...muted, marginTop: 5 }}>
                        <span style={mono}>{row.civilDate} · {row.shift}</span>
                        {' — '}planned {row.plannedPersonShifts} · present {row.presentWorkers} · {row.workedMinutes} min worked
                        {row.outputs.map((o, i) => <span key={i}> · output {o.quantity} {o.uom}</span>)}
                        {row.productivityPerHour
                          ? row.productivityPerHour.map((p, i) => <span key={i}> · {p.quantityPerHour} {p.uom}/h</span>)
                          : ' · productivity — (no effort recorded)'}
                      </div>
                    ))}
                  </div>
                ))}
              </Panel>
            )}
          </div>

          {/* jump to the shortfall Inbox actions */}
          {atRiskCount + blockedCount > 0 && (
            <div style={{ marginTop: 18 }}>
              <Button variant="outline" onClick={() => setScreen('inbox')} data-testid="labour-open-inbox" style={{ fontSize: 12.5 }}>
                {atRiskCount + blockedCount} labour shortfall{atRiskCount + blockedCount === 1 ? '' : 's'} need attention — open For You
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Panel(props: { empty: boolean; emptyKey: string; emptyText: string; children: React.ReactNode }) {
  if (props.empty) {
    return <div data-testid={`labour-empty-${props.emptyKey}`} style={{ marginTop: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{props.emptyText}</div>;
  }
  return <>{props.children}</>;
}

function SummaryTile(props: { label: string; value: number; tone: 'green' | 'amber' | 'red' | 'ink' }) {
  const fg = props.tone === 'green' ? 'var(--green-text, #2F6B44)' : props.tone === 'amber' ? 'var(--amber-text)' : props.tone === 'red' ? 'var(--red-text, #B4462E)' : 'var(--ink)';
  return (
    <div style={{ flex: '1 1 90px', minWidth: 90, border: '1px solid var(--hairline)', borderRadius: 11, padding: '10px 12px', background: 'var(--panel)' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: fg }}>{props.value}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em', color: 'var(--faint)', textTransform: 'uppercase' }}>{props.label}</div>
    </div>
  );
}

function tabBtn(active: boolean): CSSProperties {
  return {
    background: active ? 'var(--ink)' : 'transparent',
    color: active ? 'var(--canvas)' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--ink)' : 'var(--hairline)'}`,
    borderRadius: 9, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  };
}
