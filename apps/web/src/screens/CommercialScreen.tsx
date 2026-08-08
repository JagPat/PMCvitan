import { useState, type CSSProperties, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button } from '@/components';
import { RefreshCw, WifiOff } from '@/lib/icons';
import type { CostHeadPositionDto } from '@vitan/shared';
import styles from './responsive.module.css';

/**
 * Phase 5 Task 7B-i (§M) — the pilot COMMERCIAL hub, opened on the MONEY POSITION.
 *
 * Capability-gated (the nav only surfaces it on a `commercial` project, and every read 404s
 * off-pilot), cloning the cleared Materials/Labour hub idioms exactly: ONE screen, tabbed panels,
 * honest reading / unavailable+Retry / stale states, and a Retry that falls back to the shell when
 * capabilities are unknown.
 *
 * READ ONLY, and that is the unit's boundary rather than an omission. §M is two user workflows:
 * *where do we stand* (this one — budget · commitments · cash forecast, a PMC's question) and
 * *process this vendor claim* (measurements · bills · certification · payments, a different actor
 * with different authority), which is 7B-ii. The §M write actions and their two-key outbox
 * lifecycle land in 7B-iii, with their own reviewer, because that is precisely the concern
 * Phase-3 Task 7 shipped alongside its readiness reads and then needed four corrections for.
 *
 * ── What this screen does NOT do ────────────────────────────────────────────────────────────────
 *
 * It derives no money. Every figure is a server fold: `budget` is the LIVE per-head position
 * (always current), `cashForecast` is the same seven buckets rolled up from the eighth rebuildable
 * projection with a live fallback. §J's rule that `budget` is the CEILING and never a seventh
 * addend is the SERVER's arithmetic; re-adding the buckets here to "check" it would create a second
 * opinion, which is the defect the one-serializer design exists to prevent. The one thing rendered
 * that is not a bucket — `exposure` — is likewise served, not summed.
 */

type Tab = 'position' | 'commitments' | 'forecast' | 'claims' | 'certification' | 'payments' | 'measurements';
const TABS: { key: Tab; label: string }[] = [
  { key: 'position', label: 'Budget' },
  { key: 'commitments', label: 'Commitments' },
  { key: 'forecast', label: 'Cash forecast' },
  // Task 7B-ii — the CLAIM workflow. Four tabs, one selected claim: `Claims` picks it and the
  // other three are views of the SAME server bundle, so they cannot disagree with each other.
  { key: 'claims', label: 'Claims' },
  { key: 'certification', label: 'Certification' },
  { key: 'payments', label: 'Payments' },
  { key: 'measurements', label: 'Measurements' },
];

/** The claim tabs are views of one selected claim; without one there is nothing to show. */
const CLAIM_TABS: readonly Tab[] = ['certification', 'payments', 'measurements'];

const rowCard: CSSProperties = { border: '1px solid var(--hairline)', borderRadius: 11, padding: '11px 13px', marginTop: 10, background: 'var(--panel)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--faint)' };
const muted: CSSProperties = { fontSize: 12.5, color: 'var(--muted)' };
const num: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink)' };
const breachChip: CSSProperties = {
  display: 'inline-block', background: 'var(--red-chip, #F6E4E1)', color: 'var(--red-text, #B4462E)',
  border: '1px solid #E1BEB6', borderRadius: 6, padding: '2px 7px',
  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
};

/** An UNBUDGETED head has no authority to breach — `headroom: null` is not headroom zero, and
 *  showing it as a breach would flag every commitment on a project that has not budgeted yet. */
function isBreached(position: CostHeadPositionDto): boolean {
  return position.headroom !== null && position.headroom.trimStart().startsWith('-');
}

/** Money, as served. Never re-derived, never re-rounded — the server already rounded once from the
 *  full-precision total, and rounding a rounded figure is how a phantom paisa of breach appears. */
function money(value: string | null): string {
  return value === null ? '—' : value;
}

export function CommercialScreen() {
  const commercial = useStore(useShallow((s) => s.commercialView));
  const commercialLoad = useStore((s) => s.commercialLoad);
  const capabilitiesKnown = useStore((s) => s.capabilitiesKnown);
  const loadCommercial = useStore((s) => s.loadCommercial);
  const loadShell = useStore((s) => s.loadShell);
  const bills = useStore(useShallow((s) => s.commercialBills));
  const billsLoad = useStore((s) => s.commercialBillsLoad);
  const claims = useStore(useShallow((s) => s.commercialClaims));
  const claimLoad = useStore(useShallow((s) => s.commercialClaimLoad));
  const loadCommercialBills = useStore((s) => s.loadCommercialBills);
  const loadCommercialClaim = useStore((s) => s.loadCommercialClaim);
  const [tab, setTab] = useState<Tab>('position');
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);

  const reading = (commercialLoad === 'idle' || commercialLoad === 'loading') && !commercial;
  const unavailable = commercialLoad === 'error' && !commercial;
  const stale = commercialLoad === 'error' && !!commercial;
  // While the shell/capability read has FAILED, `loadCommercial()` is a capability-gated no-op, so
  // Retry must re-drive the shell itself (which reloads the bundle on a pilot, or lets RouteBridge
  // bounce a non-pilot deep link). The labour hub needed a finding to learn this; it is cloned.
  const retry = (): void => { if (capabilitiesKnown) { void loadCommercial(); } else { loadShell(); } };

  const positions = commercial?.budget.positions ?? [];
  // Codex F3 — `commercial/attributions` returns the WHOLE register, superseded history included,
  // because a re-attribution supersedes the old row and inserts its successor rather than editing
  // in place (§C: there is no "revoke", which would drop a live obligation out of every budget).
  // Rendering all of it as current commitments double-counts a re-attributed line — the CIVIL row
  // it left AND the MEP row it moved to — which misstates the very money position this hub exists
  // to state. Only the LIVE rows are current commitments; the history is not this tab's subject.
  const liveAttributions = (commercial?.attributions ?? []).filter((a) => a.supersededAt === null);
  const headName = (code: string): string =>
    commercial?.costHeads.find((h) => h.code === code)?.name
    ?? positions.find((p) => p.costHeadCode === code)?.costHeadName
    ?? code;

  // Task 7B-ii — the claim list is fetched when the user first asks for it rather than on hub open:
  // it answers a different question from the money position, and paying for it up front would make
  // every PMC checking headroom wait on a list only an accountant opens.
  const openTab = (next: Tab): void => {
    setTab(next);
    if ((next === 'claims' || CLAIM_TABS.includes(next)) && billsLoad === 'idle') void loadCommercialBills();
  };
  const selectClaim = (billId: string): void => {
    setSelectedBillId(billId);
    // Always re-read on selection. The lifecycle is what someone is about to ACT on — a certified
    // amount or an approvable balance held from an earlier visit is the one number that must not be
    // stale here, and the per-claim token makes a slow earlier read unable to overwrite this one.
    void loadCommercialClaim(billId);
  };
  const claim = selectedBillId ? claims[selectedBillId] ?? null : null;
  const claimStatus = selectedBillId ? claimLoad[selectedBillId] ?? null : null;
  // A distinct `claimReading` is deliberately absent: 'loading' and the torn-down case (a selected
  // id whose store entry went away with the project) are the SAME answer — we don't have it yet —
  // so the guard's fallback covers both, and a separate flag would only invite the four-state
  // enumeration whose missing fourth branch was the crash.
  const claimStale = claimStatus === 'error' && !!claim;
  const claimUnavailable = claimStatus === 'error' && !claim;

  /**
   * The state to render when there is no claim to render. Returns null ONLY when `claim` is
   * non-null, which is what lets every panel below drop its non-null assertions.
   *
   * The last branch is the one that matters and the one the first draft missed: `selectedBillId` is
   * COMPONENT state while the claim map is STORE state, and a project switch tears the store down
   * without unmounting this screen. That leaves a selected id with no entry and no status — neither
   * loading nor error — which a three-branch guard answered with `null`, so the panel dereferenced
   * an undefined claim and the hub crashed on a plain project switch.
   */
  const claimGuard = (): JSX.Element | null => {
    if (claim) return null;
    if (!selectedBillId) {
      return <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-none">Choose a claim on the Claims tab.</div>;
    }
    if (claimUnavailable) {
      return (
        <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-unavailable">
          <div>This claim couldn&rsquo;t load.</div>
          <div style={{ marginTop: 10 }}>
            <Button variant="ink" onClick={() => selectClaim(selectedBillId)} data-testid="commercial-claim-retry">
              <RefreshCw size={14} /> Retry
            </Button>
          </div>
        </div>
      );
    }
    // 'loading', or the torn-down case above: both are honestly "we don't have it yet".
    return <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-loading">Loading the claim…</div>;
  };

  return (
    <div className={styles.screen}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Eyebrow>Commercial</Eyebrow>
          <h1 style={{ margin: '4px 0 0', fontSize: 21, letterSpacing: '-0.01em' }}>Money position</h1>
          <div style={muted}>What this project has authorised, what it has committed, and what it still owes.</div>
        </div>
        <Button variant="ghost" onClick={() => retry()} data-testid="commercial-refresh" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {stale && (
        <div data-testid="commercial-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>Showing the last-known money picture — the latest couldn&rsquo;t load.</span>
          <button onClick={() => retry()} data-testid="commercial-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {reading && (
        <div data-testid="commercial-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading the money position…</div>
      )}
      {unavailable && (
        <div data-testid="commercial-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> Commercial unavailable.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Check your connection and access, then retry.</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => retry()} data-testid="commercial-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> Retry
            </Button>
          </div>
        </div>
      )}

      {commercial && (
        <>
          <div style={{ display: 'flex', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => openTab(t.key)}
                data-testid={`commercial-tab-${t.key}`}
                style={{
                  border: '1px solid var(--hairline)', borderRadius: 8, padding: '6px 11px', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  background: tab === t.key ? 'var(--ink)' : 'transparent',
                  color: tab === t.key ? 'var(--canvas)' : 'var(--muted)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'position' && (
            <div data-testid="commercial-position">
              {commercial.budget.openExceptions > 0 && (
                <div data-testid="commercial-open-exceptions" style={{ ...rowCard, borderColor: '#E1BEB6' }}>
                  <span style={breachChip}>OVER BUDGET</span>
                  <span style={{ ...muted, marginLeft: 8 }}>
                    {commercial.budget.openExceptions} cost head{commercial.budget.openExceptions === 1 ? '' : 's'} standing over budget.
                  </span>
                </div>
              )}
              {positions.length === 0 && (
                <div data-testid="commercial-position-empty" style={{ ...rowCard, ...muted }}>No cost heads defined yet.</div>
              )}
              {positions.map((p) => (
                <div key={p.costHeadCode} style={rowCard} data-testid={`commercial-head-${p.costHeadCode}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{p.costHeadName}</div>
                      <div style={mono}>{p.costHeadCode}</div>
                    </div>
                    {isBreached(p) && <span style={breachChip} data-testid={`commercial-breach-${p.costHeadCode}`}>OVER BUDGET</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                    <span style={muted}>Budget <span style={num} data-testid={`commercial-budget-${p.costHeadCode}`}>{money(p.budget)}</span></span>
                    <span style={muted}>Exposure <span style={num} data-testid={`commercial-exposure-${p.costHeadCode}`}>{p.exposure}</span></span>
                    <span style={muted}>Headroom <span style={num} data-testid={`commercial-headroom-${p.costHeadCode}`}>{money(p.headroom)}</span></span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'commitments' && (
            <div data-testid="commercial-commitments">
              {liveAttributions.length === 0 && (
                <div data-testid="commercial-commitments-empty" style={{ ...rowCard, ...muted }}>
                  No purchase-order line is attributed to a cost head yet.
                </div>
              )}
              {liveAttributions.map((a) => (
                <div key={a.id} style={rowCard} data-testid={`commercial-attribution-${a.id}`}>
                  <div style={{ fontWeight: 600 }}>{headName(a.costHeadCode)}</div>
                  <div style={mono}>
                    {a.costHeadCode} · {a.poLineId ? `material line ${a.poLineId}` : `labour line ${a.labourPoLineId}`}
                  </div>
                  {a.reason && <div style={{ ...muted, marginTop: 6 }}>{a.reason}</div>}
                </div>
              ))}
            </div>
          )}

          {tab === 'forecast' && (
            <div data-testid="commercial-forecast">
              {/* The projection's freshness, reported rather than implied. `refreshedAt: null` is the
                  LIVE fallback path — an honest "computed just now", never a stamped timestamp. */}
              <div style={{ ...mono, marginTop: 12 }} data-testid="commercial-forecast-freshness">
                {commercial.cashForecast.refreshedAt
                  ? `Projection refreshed ${commercial.cashForecast.refreshedAt}`
                  : 'Computed live from canonical state'}
              </div>
              <div style={rowCard} data-testid="commercial-forecast-totals">
                <div style={{ fontWeight: 600 }}>Project totals</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '6px 18px', marginTop: 8 }}>
                  <span style={muted}>Committed <span style={num} data-testid="forecast-committed">{commercial.cashForecast.totals.committed}</span></span>
                  <span style={muted}>Received, not billed <span style={num} data-testid="forecast-received-not-billed">{commercial.cashForecast.totals.receivedNotBilled}</span></span>
                  <span style={muted}>Awaiting certification <span style={num} data-testid="forecast-awaiting-certification">{commercial.cashForecast.totals.awaitingCertification}</span></span>
                  <span style={muted}>Certified payable <span style={num} data-testid="forecast-certified-payable">{commercial.cashForecast.totals.certifiedPayable}</span></span>
                  <span style={muted}>Approved <span style={num} data-testid="forecast-approved">{commercial.cashForecast.totals.approved}</span></span>
                  <span style={muted}>Paid <span style={num} data-testid="forecast-paid">{commercial.cashForecast.totals.paid}</span></span>
                </div>
                {/* §J — `budget` is the CEILING the six exposure buckets are measured against, never
                    a seventh addend, so it is reported ALONGSIDE `exposure` and `headroom` rather
                    than among them. Two earlier revisions of §J got this wrong in opposite
                    directions, which is why the separation is visible in the layout too. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hairline)' }}>
                  <span style={muted}>Exposure <span style={num} data-testid="forecast-exposure">{commercial.cashForecast.totals.exposure}</span></span>
                  <span style={muted}>Budget <span style={num} data-testid="forecast-budget">{commercial.cashForecast.totals.budget}</span></span>
                  <span style={muted}>Headroom <span style={num} data-testid="forecast-headroom">{commercial.cashForecast.totals.headroom}</span></span>
                </div>
              </div>
            </div>
          )}

          {tab === 'claims' && (
            <div data-testid="commercial-claims">
              {billsLoad === 'loading' && !bills && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-loading">Loading claims…</div>
              )}
              {billsLoad === 'error' && !bills && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-unavailable">
                  <div>Claims couldn&rsquo;t load.</div>
                  <div style={{ marginTop: 10 }}>
                    <Button variant="ink" onClick={() => void loadCommercialBills()} data-testid="commercial-claims-retry">
                      <RefreshCw size={14} /> Retry
                    </Button>
                  </div>
                </div>
              )}
              {bills?.length === 0 && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-empty">No vendor claim has been recorded yet.</div>
              )}
              {(bills ?? []).map((b) => (
                <button
                  key={b.id}
                  onClick={() => selectClaim(b.id)}
                  data-testid={`commercial-claim-row-${b.id}`}
                  style={{
                    ...rowCard, display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    borderColor: b.id === selectedBillId ? 'var(--ink)' : 'var(--hairline)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                    <div style={{ fontWeight: 600 }}>{b.vendorBillNumber}</div>
                    <span style={mono} data-testid={`commercial-claim-status-${b.id}`}>{b.status}</span>
                  </div>
                  <div style={mono}>{b.id}</div>
                </button>
              ))}
            </div>
          )}

          {tab === 'certification' && (
            <div data-testid="commercial-certification">
              {claim ? (
                <>
                  {claimStale && (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-stale">
                      Showing the last-known claim — the latest couldn&rsquo;t load.
                    </div>
                  )}
                  {/* §E — the verification triple, DERIVED server-side on every call. A stored
                      verdict is stale the moment a receipt is reversed, which is why it is not
                      cached here either. */}
                  <div style={rowCard} data-testid="commercial-verification">
                    <div style={{ fontWeight: 600 }}>Verification</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                      <span style={muted}>Verdict <span style={num} data-testid="verification-verdict">{claim.verification.verdict}</span></span>
                      {/* §E is explicit that the VERDICT and the claim's STATUS answer different
                          questions — a claim disputed for its evidence and then re-evidenced reads
                          `matched` with a `disputed` status, true on both counts. Rendering only one
                          of them would let a reader mistake it for the other. */}
                      <span style={muted}>Claim status <span style={num} data-testid="verification-bill-status">{claim.verification.billStatus}</span></span>
                    </div>
                    {claim.verification.exceptions.length > 0 && (
                      <div style={{ ...muted, marginTop: 6 }} data-testid="verification-exceptions">
                        {claim.verification.exceptions.join(', ')}
                      </div>
                    )}
                  </div>
                  {claim.certificate === null ? (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-certificate-none">
                      Not certified yet. A claim before certification is an ordinary state, not an error.
                    </div>
                  ) : (
                    <div style={rowCard} data-testid="commercial-certificate">
                      <div style={{ fontWeight: 600 }}>Certificate</div>
                      <div style={mono}>{claim.certificate.id}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                        <span style={muted}>Certified <span style={num} data-testid="certificate-amount">{claim.certificate.certifiedAmount}</span></span>
                        <span style={muted}>Withheld <span style={num} data-testid="certificate-withheld">{claim.deductions.withheld}</span></span>
                        <span style={muted}>Net payable <span style={num} data-testid="certificate-net-payable">{money(claim.deductions.netPayable)}</span></span>
                      </div>
                      {claim.deductions.deductions.length > 0 && (
                        <div style={{ marginTop: 8 }} data-testid="commercial-deductions">
                          {claim.deductions.deductions.map((d) => (
                            <div key={d.id} style={{ ...muted, marginTop: 4 }} data-testid={`commercial-deduction-${d.id}`}>
                              {d.type} <span style={num}>{d.amount}</span>{d.reason ? ` — ${d.reason}` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : claimGuard()}
            </div>
          )}

          {tab === 'payments' && (
            <div data-testid="commercial-payments">
              {claim ? (
                <div style={rowCard} data-testid="commercial-payment-ledger">
                  <div style={{ fontWeight: 600 }}>Approvals and payments</div>
                  {/* `approvable` is DERIVED from `netPayable` server-side, and both arrive in the
                      same repeatable-read snapshot — which is why they are rendered together here
                      rather than on the tab that happens to own each one. */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                    <span style={muted}>Approved <span style={num} data-testid="payments-approved">{claim.payments.approved}</span></span>
                    <span style={muted}>Paid <span style={num} data-testid="payments-paid">{claim.payments.paid}</span></span>
                    <span style={muted}>Approvable <span style={num} data-testid="payments-approvable">{money(claim.payments.approvable)}</span></span>
                    <span style={muted}>Status <span style={num} data-testid="payments-bill-status">{claim.payments.billStatus}</span></span>
                  </div>
                  {claim.payments.approvals.length === 0 && (
                    <div style={{ ...muted, marginTop: 8 }} data-testid="commercial-approvals-empty">Nothing authorised yet.</div>
                  )}
                  {claim.payments.approvals.map((a) => (
                    <div key={a.id} style={{ ...muted, marginTop: 6 }} data-testid={`commercial-approval-${a.id}`}>
                      <span style={num}>{a.amount}</span> approved · paid <span style={num}>{a.paid}</span>
                    </div>
                  ))}
                </div>
              ) : claimGuard()}
            </div>
          )}

          {tab === 'measurements' && (
            <div data-testid="commercial-measurements">
              {claim ? (
                Object.keys(claim.measurements).length === 0 ? (
                  // §D applies to LABOUR lines. A material line's evidence is accepted stock, which
                  // the verification triple already reports — so this says "does not apply" rather
                  // than showing empty registers, which would read as "measured nothing".
                  <div style={{ ...rowCard, ...muted }} data-testid="commercial-measurements-empty">
                    This claim bills no labour lines — material evidence is accepted stock, shown under Certification.
                  </div>
                ) : (
                  <>
                    {Object.entries(claim.measurements).map(([lineId, register]) => (
                      <div key={lineId} style={rowCard} data-testid={`commercial-measurement-${lineId}`}>
                        <div style={mono}>{lineId}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 8 }}>
                          <span style={muted}>Measured <span style={num}>{register.measured}</span></span>
                          <span style={muted}>Ordered <span style={num}>{register.orderedPersonShiftQty}</span></span>
                          <span style={muted}>Live authority <span style={num}>{register.liveAuthorityPersonShiftQty}</span></span>
                        </div>
                      </div>
                    ))}
                  </>
                )
              ) : claimGuard()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
