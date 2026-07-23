import { useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button } from '@/components';
import { RefreshCw, WifiOff } from '@/lib/icons';
import type { MaterialCoverageVerdict, StockLotDto } from '@vitan/shared';
import { decAdd, decSum, decIsPositive } from '@/lib/decimal';
import { foldActivityReservations } from '@/lib/reservations';
import { reserveCoalesceKey, issueCoalesceKey, consumeCoalesceKey, requisitionCoalesceKey } from '@/lib/materialsKeys';
import styles from './responsive.module.css';

/**
 * Phase 3 Task 7 — the pilot MATERIALS hub (capability-gated; the nav only surfaces it on a pilot
 * project). ONE screen with tabbed panels for the whole pipeline — requirements → procurement →
 * deliveries → inventory → reservations → issues → readiness. It is OPERATIONAL, not observational
 * (correction findings 1/2): a shorted activity is covered by EXPLICIT single user actions — reserve a
 * SERVER-offered candidate (exact lot + store location + qty), or raise ONE requisition for the residual
 * the server computed — with NO browser-side multi-command orchestration (correction 2). A reservation is
 * issued to a specific store location, and an issue consumed. Every command is write-ahead + idempotency-
 * keyed + disabled while pending. Readiness + shortage TOTALS are counted per ACTIVITY (finding 3), and
 * the Reservations pool is folded from the §C ledger with EXACT decimals, reversals included (finding 5).
 */

type Tab = 'readiness' | 'requirements' | 'procurement' | 'deliveries' | 'inventory' | 'reservations' | 'issues';
const TABS: { key: Tab; label: string }[] = [
  { key: 'readiness', label: 'Readiness' },
  { key: 'requirements', label: 'Requirements' },
  { key: 'procurement', label: 'Procurement' },
  { key: 'deliveries', label: 'Deliveries' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'reservations', label: 'Reservations' },
  { key: 'issues', label: 'Issues' },
];

function verdictChip(v: MaterialCoverageVerdict): { label: string; bg: string; fg: string; border: string } {
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

/** A lot's free-available quantity across its store locations, summed with EXACT decimal arithmetic. */
const freeOf = (lot: StockLotDto): string => decSum(lot.locations.map((b) => b.freeAvailable));

export function MaterialsScreen() {
  const materials = useStore(useShallow((s) => s.materialsView));
  const materialsLoad = useStore((s) => s.materialsLoad);
  const reservationPlans = useStore(useShallow((s) => s.reservationPlans));
  const materialsPending = useStore(useShallow((s) => s.materialsPending));
  const loadMaterials = useStore((s) => s.loadMaterials);
  const loadReservationPlan = useStore((s) => s.loadReservationPlan);
  const reserveCandidate = useStore((s) => s.reserveCandidate);
  const raiseRequisition = useStore((s) => s.raiseRequisition);
  const setScreen = useStore((s) => s.setScreen);
  const issueMaterial = useStore((s) => s.issueMaterial);
  const consumeMaterial = useStore((s) => s.consumeMaterial);
  const [tab, setTab] = useState<Tab>('readiness');
  // which activity's cover panel is expanded — opening it fetches the SERVER's reservation plan.
  const [openCover, setOpenCover] = useState<string | null>(null);

  const reading = (materialsLoad === 'idle' || materialsLoad === 'loading') && !materials;
  const unavailable = materialsLoad === 'error' && !materials;
  const stale = materialsLoad === 'error' && !!materials;
  const pending = (key: string): boolean => materialsPending.includes(key);

  // Reservations: each activity's ACTIVE reserved pool per store location, folded from the §C ledger's
  // bucket movements (reversals + issues included) with exact decimal arithmetic (finding 5).
  const reservations = useMemo(() => foldActivityReservations(materials?.stock ?? []), [materials]);

  // Open/close a shorted activity's cover panel; opening it (re)loads the SERVER-computed plan so the
  // browser never recreates coverage compatibility from fingerprints (correction 2).
  const toggleCover = (activityId: string): void => {
    setOpenCover((cur) => {
      if (cur === activityId) return null;
      loadReservationPlan(activityId);
      return activityId;
    });
  };

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Eyebrow>MATERIALS · PILOT</Eyebrow>
          <div style={{ ...muted, marginTop: 6, maxWidth: 560 }}>
            One material flow, end to end — requirement → requisition → comparison → purchase order → delivery → stock → reservation → issue → consumption. Readiness reflects <b>physical truth</b>: an activity is ready only when its material is actually, exclusively there.
          </div>
        </div>
        <Button variant="outline" onClick={() => loadMaterials()} data-testid="materials-refresh" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 13 }}>
          <RefreshCw size={15} /> Refresh
        </Button>
      </div>

      {stale && (
        <div data-testid="materials-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>Showing the last-known materials — the latest couldn't load.</span>
          <button onClick={() => loadMaterials()} data-testid="materials-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {reading && (
        <div data-testid="materials-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading the materials pipeline…</div>
      )}
      {unavailable && (
        <div data-testid="materials-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> Materials unavailable.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Check your connection and access, then retry.</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => loadMaterials()} data-testid="materials-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> Retry
            </Button>
          </div>
        </div>
      )}

      {materials && (
        <>
          {/* readiness summary — counted per ACTIVITY (finding 3) */}
          <div data-testid="materials-summary" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <SummaryTile label="Ready" value={materials.readiness.summary.ready} tone="green" />
            <SummaryTile label="At-risk" value={materials.readiness.summary.atRisk} tone="amber" />
            <SummaryTile label="Blocked" value={materials.readiness.summary.blocked} tone="red" />
            <SummaryTile label="Activities" value={materials.readiness.summary.total} tone="ink" />
          </div>

          {/* tabs */}
          <div role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '16px 0 2px' }}>
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} data-testid={`materials-tab-${t.key}`} onClick={() => setTab(t.key)} style={tabBtn(tab === t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 8 }}>
            {tab === 'readiness' && (
              <Panel empty={!materials.readiness.activities.length} emptyKey="readiness" emptyText="No material requirements yet.">
                {materials.readiness.activities.map((a) => {
                  const m = verdictChip(a.verdict);
                  const reqs = materials.readiness.requirements.filter((r) => r.activityId === a.activityId);
                  return (
                    <div key={a.activityId} data-testid={`materials-activity-${a.activityId}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{a.activityName}</div>
                        <span style={chip(m)} data-testid={`materials-verdict-${a.activityId}`}>{m.label}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{a.reason}</div>
                      {reqs.map((r) => (
                        <div key={r.requirementId} data-testid={`materials-reqdetail-${r.requirementId}`} style={{ ...mono, marginTop: 4 }}>
                          {r.material} · covered {r.coveredQty} / {r.requiredQty} {r.baseUom}{decIsPositive(r.shortfall) ? ` · short ${r.shortfall}` : ''}
                        </div>
                      ))}
                      {a.verdict !== 'ready' && (
                        <div style={{ marginTop: 9 }}>
                          <Button variant="outline" data-testid={`materials-cover-${a.activityId}`} onClick={() => toggleCover(a.activityId)} style={{ fontSize: 12 }}>
                            {openCover === a.activityId ? 'Close' : 'Cover shortage'}
                          </Button>
                          {openCover === a.activityId && (
                            <CoverPanel
                              activityId={a.activityId}
                              activityName={a.activityName}
                              plan={reservationPlans[a.activityId]}
                              pending={pending}
                              onReserve={reserveCandidate}
                              onRequisition={raiseRequisition}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'requirements' && (
              <Panel empty={!materials.requirements.length} emptyKey="requirements" emptyText="No requirements planned.">
                {materials.requirements.map((r) => (
                  <div key={r.requirementId} data-testid={`materials-requirement-${r.requirementId}`} style={rowCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.spec ? [r.spec.materialCategory, r.spec.make, r.spec.grade].filter(Boolean).join(' · ') : r.type}</div>
                      <span style={mono}>{r.status}{r.revisions > 1 ? ` · rev ${r.revision}` : ''}</span>
                    </div>
                    <div style={{ ...muted, marginTop: 4 }}>{r.qty} {r.baseUom} · needed by {r.requiredBy} · {r.criticality} · activity {r.activityId}</div>
                  </div>
                ))}
              </Panel>
            )}

            {tab === 'procurement' && (
              <Panel empty={!materials.requisitions.length && !materials.purchaseOrders.length} emptyKey="procurement" emptyText="No requisitions or purchase orders yet.">
                {materials.requisitions.map((rq) => (
                  <div key={rq.id} data-testid={`materials-requisition-${rq.id}`} style={rowCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{rq.title || 'Requisition'}</div>
                      <span style={mono}>REQ · {rq.status}</span>
                    </div>
                    <div style={{ ...muted, marginTop: 4 }}>{rq.lines.length} line{rq.lines.length === 1 ? '' : 's'}</div>
                  </div>
                ))}
                {materials.purchaseOrders.map((po) => {
                  const v = po.versions[po.versions.length - 1];
                  return (
                    <div key={po.id} data-testid={`materials-po-${po.id}`} style={rowCard}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Purchase order</div>
                        <span style={mono}>PO v{v?.version} · {v?.status}</span>
                      </div>
                      <div style={{ ...muted, marginTop: 4 }}>{v?.lines.length ?? 0} line{(v?.lines.length ?? 0) === 1 ? '' : 's'} · ₹{v?.lines.reduce((s, l) => decAdd(s, l.committedAmountBase), '0')} committed</div>
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'deliveries' && (() => {
              const commitments = materials.purchaseOrders.flatMap((po) => po.versions[po.versions.length - 1]?.lines.flatMap((l) => l.commitments.map((c) => ({ c, l }))) ?? []);
              return (
                <Panel empty={!commitments.length} emptyKey="deliveries" emptyText="No delivery commitments yet.">
                  {commitments.map(({ c, l }) => {
                    const latest = c.promises[c.promises.length - 1];
                    return (
                      <div key={c.id} data-testid={`materials-delivery-${c.id}`} style={rowCard}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{l.quotedMake || l.specFingerprint.slice(0, 10)} · {l.qty} {l.uom}</div>
                          <span style={mono}>{c.status}</span>
                        </div>
                        <div style={{ ...muted, marginTop: 4 }}>promised {latest?.promisedDate ?? '—'} · received {l.receivedQty} / {l.qty} {l.uom}</div>
                      </div>
                    );
                  })}
                </Panel>
              );
            })()}

            {tab === 'inventory' && (
              <Panel empty={!materials.stock.length} emptyKey="inventory" emptyText="No stock received yet.">
                {materials.stock.map((lot) => {
                  const onHand = decSum(lot.locations.map((b) => b.acceptedOnHand));
                  const reserved = decSum(lot.locations.map((b) => b.reserved));
                  const free = freeOf(lot);
                  const issued = decSum(lot.locations.map((b) => b.issuedToActivity));
                  return (
                    <div key={lot.id} data-testid={`materials-lot-${lot.id}`} style={rowCard}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{[lot.materialCategory, lot.make, lot.grade].filter(Boolean).join(' · ')}</div>
                      <div style={{ ...muted, marginTop: 4 }}>on-hand {onHand} · reserved {reserved} · free {free} · issued {issued} {lot.baseUom}</div>
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'reservations' && (
              <Panel empty={!reservations.length} emptyKey="reservations" emptyText="No stock reserved to an activity yet.">
                {reservations.map((r) => {
                  const iKey = issueCoalesceKey(r.activityId, r.lotId, r.storeLocation, r.qty);
                  return (
                    <div key={`${r.lotId}-${r.storeLocation}-${r.activityId}`} data-testid={`materials-reservation-${r.lotId}-${r.activityId}`} style={rowCard}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.material}</div>
                      <div style={{ ...muted, marginTop: 4 }}>{r.qty} {r.baseUom} reserved to activity {r.activityId} · at {r.storeLocation}</div>
                      <div style={{ marginTop: 9 }}>
                        <Button variant="outline" disabled={pending(iKey)} data-testid={`materials-do-issue-${r.lotId}-${r.activityId}`} onClick={() => issueMaterial(r.lotId, r.storeLocation, r.activityId, r.qty)} style={{ fontSize: 12 }}>
                          {pending(iKey) ? 'Issuing…' : 'Issue to site'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </Panel>
            )}

            {tab === 'issues' && (
              <Panel empty={!materials.issues.length} emptyKey="issues" emptyText="No material issued to site yet.">
                {materials.issues.map((i) => (
                  <div key={i.id} data-testid={`materials-issue-${i.id}`} style={rowCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{[i.materialCategory, i.make].filter(Boolean).join(' · ')} · {i.qty} {i.baseUom}</div>
                      <span style={mono}>{i.storeLocation}</span>
                    </div>
                    <div style={{ ...muted, marginTop: 4 }}>issued to activity {i.activityId} · remaining custody {i.remainingCustody} {i.baseUom}</div>
                    {decIsPositive(i.remainingCustody) && (() => {
                      const cKey = consumeCoalesceKey(i.id, i.remainingCustody);
                      return (
                        <div style={{ marginTop: 9 }}>
                          <Button variant="outline" disabled={pending(cKey)} data-testid={`materials-do-consume-${i.id}`} onClick={() => consumeMaterial(i.id, i.remainingCustody)} style={{ fontSize: 12 }}>
                            {pending(cKey) ? 'Recording…' : 'Record consumption'}
                          </Button>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </Panel>
            )}
          </div>

          {/* jump back to the shortage Inbox actions */}
          {materials.readiness.shortages.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <Button variant="outline" onClick={() => setScreen('inbox')} data-testid="materials-open-inbox" style={{ fontSize: 12.5 }}>
                {materials.readiness.shortages.length} shortage{materials.readiness.shortages.length === 1 ? '' : 's'} need attention — open For You
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
    return <div data-testid={`materials-empty-${props.emptyKey}`} style={{ marginTop: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>{props.emptyText}</div>;
  }
  return <>{props.children}</>;
}

/**
 * Phase 3 Task 7 (correction 2) — the cover-shortage panel for one activity. It renders the SERVER's
 * canonical reservation plan (never recomputed in the browser): each `candidate` is ONE reserve command
 * (exact lot + store location + a conserved qty ≤ free, never over-allocating shared stock), and the
 * `residuals` are the shortfall no on-hand stock covers, raised as ONE requisition. Buttons disable while
 * their command is pending (double-click coalesces at the same idempotency key).
 */
function CoverPanel(props: {
  activityId: string;
  activityName: string;
  plan: import('@vitan/shared').ReservationPlan | undefined;
  pending: (key: string) => boolean;
  onReserve: (activityId: string, lotId: string, storeLocation: string, qty: string) => void;
  onRequisition: (activityId: string, title: string, lines: ReadonlyArray<{ requirementId: string; revision: number; qty: string }>) => void;
}) {
  const { activityId, activityName, plan, pending, onReserve, onRequisition } = props;
  const box: CSSProperties = { marginTop: 10, border: '1px dashed var(--hairline)', borderRadius: 9, padding: '10px 12px', background: 'var(--canvas)' };
  if (!plan) {
    return <div data-testid={`materials-cover-loading-${activityId}`} style={{ ...box, ...muted }}>Loading cover options…</div>;
  }
  const residualLines = plan.residuals.map((r) => ({ requirementId: r.requirementId, revision: r.revision, qty: r.qty }));
  const residualTotal = plan.residuals.length ? decSum(plan.residuals.map((r) => r.qty)) : '0';
  const reqKey = requisitionCoalesceKey(activityId, residualLines);
  if (!plan.candidates.length && !residualLines.length) {
    return <div data-testid={`materials-cover-none-${activityId}`} style={{ ...box, ...muted }}>Nothing to cover — this activity is already served.</div>;
  }
  return (
    <div data-testid={`materials-cover-panel-${activityId}`} style={box}>
      {plan.candidates.length > 0 && (
        <div>
          <div style={{ ...mono, marginBottom: 6 }}>RESERVE ON-HAND STOCK</div>
          {plan.candidates.map((c) => {
            const rKey = reserveCoalesceKey(activityId, c.lotId, c.storeLocation);
            return (
              <div key={`${c.lotId}-${c.storeLocation}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 6 }}>
                <div style={{ fontSize: 12.5 }}>{c.material} · {c.qty} {c.baseUom} @ {c.storeLocation}</div>
                <Button variant="outline" disabled={pending(rKey)} data-testid={`materials-reserve-${c.lotId}-${c.storeLocation}-${activityId}`} onClick={() => onReserve(activityId, c.lotId, c.storeLocation, c.qty)} style={{ fontSize: 11.5, flex: 'none' }}>
                  {pending(rKey) ? 'Reserving…' : `Reserve ${c.qty}`}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {residualLines.length > 0 && (
        <div style={{ marginTop: plan.candidates.length ? 10 : 0 }}>
          <div style={{ ...mono, marginBottom: 6 }}>PROCURE THE RESIDUAL</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontSize: 12.5 }}>{plan.residuals.length} line{plan.residuals.length === 1 ? '' : 's'} · {residualTotal} short</div>
            <Button variant="outline" disabled={pending(reqKey)} data-testid={`materials-requisition-${activityId}`} onClick={() => onRequisition(activityId, `Cover ${activityName}`, residualLines)} style={{ fontSize: 11.5, flex: 'none' }}>
              {pending(reqKey) ? 'Raising…' : 'Raise requisition'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
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
