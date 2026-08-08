import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { Eyebrow, Button } from '@/components';
import { RefreshCw, WifiOff } from '@/lib/icons';
import type { CommercialClaimView } from '@/store/commercial';
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

/**
 * Codex H2 — the tabs that need the MONEY bundle, as opposed to the ones that need a claim.
 *
 * This PR argued in prose that the claim workflow is independent of the money position — "nothing
 * in the claim list is derived from the money position" — and then rendered every tab inside
 * `{commercial && …}`. So a failed `/commercial/money-position` hid the whole claim workflow behind
 * a headroom retry, even though `/commercial/bills` and `/commercial/claims/:id` were fine. The
 * principle was right and applied to exactly the layer I was looking at.
 */
const MONEY_TABS: readonly Tab[] = ['position', 'commitments', 'forecast'];

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

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Codex I3 — WHAT A RESOURCE SHOWS, as a total function instead of a list of guards.
 *
 * This is the third finding on this PR where a state fell through every branch and the panel
 * rendered **nothing** — no rows, no loading, no error, no explanation, no retry. G1 was a scope
 * reset under an open tab; H3 was a capability-gated loader no-opping; I3 is a shell failure that
 * leaves the list `idle` with `onPilot` false, so no branch matches and `(bills ?? []).map` over
 * null renders an empty div. Three times, three different states, one shape: independent `&&`
 * guards ENUMERATE the states someone thought of, and a state nobody thought of renders nothing.
 *
 * Patching in a fourth branch would fix I3 and leave the shape. So the decision is made once, here,
 * over the whole space: a resource either has a value to show, is being fetched, or cannot be
 * shown. The return is a discriminated union, the callers `switch` on it, and TypeScript's
 * exhaustiveness check is what guarantees coverage — the property is structural rather than
 * remembered.
 *
 * `willLoad` is the term I3 turns on and the one a status alone cannot supply. `idle` means "no
 * read has happened", which is a HOPEFUL state when something is about to fetch and a DEAD one when
 * nothing is — and the difference is not visible from the status. The caller passes the same
 * condition its loader gates on (H3's lesson: name the term, do not proxy it), so "idle and nothing
 * is coming" resolves to unavailable-with-a-retry rather than a spinner that never ends.
 */
type ResourceView<T> =
  | { show: 'content'; value: T; stale: boolean; refreshing: boolean }
  | { show: 'loading' }
  | { show: 'unavailable' };

function viewOf<T>(value: T | null | undefined, status: LoadState | null | undefined, willLoad: boolean): ResourceView<T> {
  // A value we hold is shown whatever the read is doing — that IS stale-while-revalidate, and it
  // belongs to the value. What the read is doing is reported ALONGSIDE it (Codex I2): `error` means
  // what is on screen is known-stale, `loading` means a fresh read is in flight right now.
  if (value !== null && value !== undefined) {
    return { show: 'content', value, stale: status === 'error', refreshing: status === 'loading' };
  }
  if (status === 'error') return { show: 'unavailable' };
  if (status === 'loading') return { show: 'loading' };
  // 'idle', or no status at all (never attempted, or attempted while inert).
  return willLoad ? { show: 'loading' } : { show: 'unavailable' };
}

export function CommercialScreen() {
  const commercial = useStore(useShallow((s) => s.commercialView));
  const commercialLoad = useStore((s) => s.commercialLoad);
  const capabilities = useStore(useShallow((s) => s.capabilities));
  const loadCommercial = useStore((s) => s.loadCommercial);
  const loadShell = useStore((s) => s.loadShell);
  const bills = useStore(useShallow((s) => s.commercialBills));
  const billsLoad = useStore((s) => s.commercialBillsLoad);
  const claims = useStore(useShallow((s) => s.commercialClaims));
  const claimLoad = useStore(useShallow((s) => s.commercialClaimLoad));
  // Codex I2 — the ordering of the two reads' last SUCCESS, so "which is fresher" is looked up
  // rather than guessed. See the row-selection comment on the Claims tab.
  const billsStamp = useStore((s) => s.commercialBillsStamp);
  const claimStamp = useStore(useShallow((s) => s.commercialClaimStamp));
  const loadCommercialBills = useStore((s) => s.loadCommercialBills);
  const loadCommercialClaim = useStore((s) => s.loadCommercialClaim);
  const [tab, setTab] = useState<Tab>('position');
  // The scope a selection belongs to. A project switch (or a re-auth) bumps this, and the selection
  // below is only honoured while its recorded scope still matches — see the comment at `claim`.
  const scopeKey = useStore((s) => `${s.activeProjectId}:${s.projectScopeGeneration}`);
  const [selection, setSelection] = useState<{ scope: string; billId: string | null }>({ scope: '', billId: null });
  const selectedBillId = selection.scope === scopeKey ? selection.billId : null;

  // Declared here because THREE things now depend on it: the money view below, the claim-list
  // load condition, and Refresh — every one of them gating on the capability the loaders
  // themselves gate on, rather than on a proxy for it (Codex H3, then I1).
  const onPilot = capabilities.includes('commercial');

  // The money bundle's own states, and they belong to the MONEY tabs only (Codex H2).
  //
  // Codex I3, applied to the case the finding did NOT name. `viewOf` was written for the claim
  // list, and the money bundle three lines up had the same three-independent-guards shape with the
  // same hole: `commercial === null` with the status still `idle` because `loadCommercial()` is
  // capability-gated rendered "Loading the money position…" with nothing loading and nothing that
  // would — the permanent spinner F3 found on the claim panel, on the tab this hub OPENS on.
  //
  // Root F of the convergence audit is the reason this is here rather than in the next round:
  // stating a principle covers the instance you are looking at and nothing else unless you go and
  // count them. There are three resources on this screen; all three now decide the same way.
  const moneyView = viewOf(commercial, commercialLoad, onPilot);
  const reading = moneyView.show === 'loading';
  const unavailable = moneyView.show === 'unavailable';
  const stale = moneyView.show === 'content' && moneyView.stale;
  const moneyRefreshing = moneyView.show === 'content' && moneyView.refreshing;
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

  // Task 7B-ii — the claim list is fetched when the user is in the claim workflow rather than on
  // hub open: it answers a different question from the money position, and paying for it up front
  // would make every PMC checking headroom wait on a list only an accountant opens.
  //
  // Codex G1 — DECLARATIVE, not a click handler. The first version loaded on the tab CLICK when the
  // list was `idle`, which treats "the user opened Claims" as a moment. It is a STATE: a project
  // switch resets the list to `null`/`idle` while the Claims tab is still showing, and no click
  // follows, so the panel rendered nothing at all — no rows, no loading, no error, no empty state,
  // because `(bills ?? []).map` over null renders nothing and every other branch was false.
  //
  // Expressed as a condition instead, the load re-fires whenever the condition becomes true again,
  // whatever made it true. The one-shot trigger is deleted rather than supplemented — a second
  // trigger beside the first would leave the same class of gap for the next state change.
  const inClaimWorkflow = tab === 'claims' || CLAIM_TABS.includes(tab);
  const onMoneyTab = MONEY_TABS.includes(tab);
  // Codex H3 — the condition must name EVERY term it depends on. `loadCommercialBills()` is itself
  // capability-gated, and a project switch resets capabilities to `[]` at the same moment it resets
  // the list to `idle`: the effect fired, the loader no-opped, and when `loadShell()` later reported
  // the new project's `commercial` capability neither dependency had changed — so it never fired
  // again and the Claims tab rendered the same blank panel the previous round was meant to fix.
  //
  // Expressing a condition instead of an event (the previous round) is only half of it; the
  // condition also has to be complete. `onPilot` is the missing term, in the guard AND the deps.
  useEffect(() => {
    if (inClaimWorkflow && onPilot && billsLoad === 'idle') void loadCommercialBills();
  }, [inClaimWorkflow, onPilot, billsLoad, loadCommercialBills]);

  /**
   * Codex I1 — REFRESH RE-READS WHAT THIS SCREEN IS SHOWING.
   *
   * The page-level button drove the money bundle alone, because it was written when the hub had
   * money tabs only and never revisited when the claim workflow was added beside them. On a claim
   * tab it therefore re-read something not on screen and left the claim list and the open claim —
   * the lifecycle an accountant is about to authorise money against — exactly as stale as before.
   *
   * The gate is `onPilot`, not `capabilitiesKnown`. Both loaders gate on the CAPABILITY itself, so
   * `capabilitiesKnown` was a proxy for "the loader will do something" that is wrong in the case
   * that matters: capabilities known but not yet reporting `commercial` (a shell failure, or the
   * gap after a project switch) makes every loader an inert no-op, and a Refresh that dispatches
   * inert no-ops is a dead button. Re-driving the shell is the only thing that can recover it, and
   * naming the loader's own condition is the same lesson H3 cost a round to learn.
   */
  const refresh = (): void => {
    if (!onPilot) { loadShell(); return; }
    if (onMoneyTab) { void loadCommercial(); return; }
    void loadCommercialBills();
    if (selectedBillId) void loadCommercialClaim(selectedBillId);
  };

  const openTab = (next: Tab): void => { setTab(next); };
  const selectClaim = (billId: string): void => {
    setSelection({ scope: scopeKey, billId });
    // Always re-read on selection. The lifecycle is what someone is about to ACT on — a certified
    // amount or an approvable balance held from an earlier visit is the one number that must not be
    // stale here, and the per-claim token makes a slow earlier read unable to overwrite this one.
    void loadCommercialClaim(billId);
  };
  // Codex F3 — the SELECTION IS SCOPED. `selectedBillId` is component state and the claim map is
  // store state, so a project switch tore one down and left the other pointing at a claim that
  // belongs to a site the user is no longer on. The guard then rendered "Loading the claim…"
  // forever: nothing was loading, nothing would, and no Retry was offered.
  //
  // Derived rather than reset in an effect: an effect runs AFTER the offending render, so there is
  // a frame in which the old id is live in the new scope. Carrying the scope WITH the selection
  // means the stale id is simply not selected, with no frame in between and nothing to clean up.
  const claim = selectedBillId ? claims[selectedBillId] ?? null : null;
  const claimStatus = selectedBillId ? claimLoad[selectedBillId] ?? null : null;
  // Nothing auto-loads a claim: selection does, and a selection whose scope no longer matches is
  // simply not selected (above). So a selected claim with no status at all is a claim nothing is
  // going to fetch — `willLoad: false` — which `viewOf` answers with a retry rather than the
  // permanent "Loading the claim…" that was F3's finding.
  const claimView = viewOf<CommercialClaimView>(claim, claimStatus, false);

  /**
   * Codex F2 — EVERY claim tab wears the same states, because they are properties of the CLAIM.
   *
   * The three tabs are views of ONE bundle; a banner on one of them is not a property of the thing
   * they all show. Round 1 had the warning on Certification only — and Payments is where
   * `approvable` lives, the figure someone is about to authorise money against.
   *
   * Codex I3 — this used to be TWO functions: a `claimPanel` wrapper and a `claimGuard` fallback,
   * with every call site spelling `{claim ? claimPanel(…) : claimGuard()}`. Two functions that are
   * only correct when used together are one function written twice, and the pairing is what let a
   * state fall between them. Merged, the panel takes what to render WITH a claim and decides every
   * other case itself, so no call site can get the pairing wrong and the non-null assertion the old
   * shape needed is gone.
   */
  const claimPanel = (render: (loaded: CommercialClaimView) => JSX.Element): JSX.Element => {
    if (!selectedBillId) {
      return <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-none">Choose a claim on the Claims tab.</div>;
    }
    switch (claimView.show) {
      case 'loading':
        return <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-loading">Loading the claim…</div>;
      case 'unavailable':
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
      case 'content':
        return (
          <>
            {claimView.stale && (
              <div style={{ ...rowCard, ...muted, borderColor: 'var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)' }} data-testid="commercial-claim-stale">
                Showing the last-known claim — the latest couldn&rsquo;t load.{' '}
                <button onClick={() => selectClaim(selectedBillId)} data-testid="commercial-claim-stale-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer' }}>
                  Retry
                </button>
              </div>
            )}
            {/* Codex I2 — a read IS in flight, and saying so is the whole point of an honest status.
                Without it, a lifecycle held from an earlier visit and a lifecycle a completed read
                just confirmed look identical on a page about to authorise a payment. */}
            {claimView.refreshing && (
              <div style={{ ...rowCard, ...muted }} data-testid="commercial-claim-refreshing">Refreshing this claim…</div>
            )}
            {render(claimView.value)}
          </>
        );
    }
  };

  return (
    <div className={styles.screen}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Eyebrow>Commercial</Eyebrow>
          <h1 style={{ margin: '4px 0 0', fontSize: 21, letterSpacing: '-0.01em' }}>Money position</h1>
          <div style={muted}>What this project has authorised, what it has committed, and what it still owes.</div>
        </div>
        <Button variant="ghost" onClick={() => refresh()} data-testid="commercial-refresh" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} /> Refresh
        </Button>
      </div>

      {stale && onMoneyTab && (
        <div data-testid="commercial-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>Showing the last-known money picture — the latest couldn&rsquo;t load.</span>
          <button onClick={() => refresh()} data-testid="commercial-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {reading && onMoneyTab && (
        <div data-testid="commercial-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading the money position…</div>
      )}
      {/* Codex I2, third instance — a refresh over money already on screen is visible, for the same
          reason it is on the claim: the figures are what someone acts on, and "held from earlier"
          and "just confirmed" must not look identical. */}
      {moneyRefreshing && onMoneyTab && (
        <div data-testid="commercial-refreshing" style={{ ...mono, marginTop: 12 }}>Refreshing the money position…</div>
      )}
      {unavailable && onMoneyTab && (
        <div data-testid="commercial-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> Commercial unavailable.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Check your connection and access, then retry.</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => refresh()} data-testid="commercial-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> Retry
            </Button>
          </div>
        </div>
      )}

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

      {tab === 'position' && commercial && (
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

      {tab === 'commitments' && commercial && (
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

      {tab === 'forecast' && commercial && (
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

          {tab === 'claims' && (() => {
            // Codex I3 — the list's state is DECIDED, not enumerated. `willLoad` is exactly the
            // effect's own condition above, so "idle" is a spinner only while something is actually
            // going to fetch; after a shell failure `onPilot` is false, nothing will, and the panel
            // says so with a retry instead of rendering an empty div.
            const v = viewOf(bills, billsLoad, onPilot && billsLoad === 'idle');
            return (
            <div data-testid="commercial-claims">
              {v.show === 'loading' && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-loading">Loading claims…</div>
              )}
              {v.show === 'unavailable' && (
                <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-unavailable">
                  <div>Claims couldn&rsquo;t load.</div>
                  <div style={{ marginTop: 10 }}>
                    <Button variant="ink" onClick={() => refresh()} data-testid="commercial-claims-retry">
                      <RefreshCw size={14} /> Retry
                    </Button>
                  </div>
                </div>
              )}
              {v.show === 'content' && (
                <>
                  {/* Codex H1 — a cached list whose latest refresh FAILED says so. Round 2 hoisted
                      exactly this warning for the CLAIM and left the LIST without one, so an open
                      Claims tab could render "No vendor claim has been recorded yet" after a failed
                      refresh that would have shown the first claim another user recorded. Both
                      resources now render through the SAME decision, so the pair cannot drift. */}
                  {v.stale && (
                    <div style={{ ...rowCard, ...muted, borderColor: 'var(--amber-border)', background: 'var(--amber-chip)', color: 'var(--amber-text)' }} data-testid="commercial-claims-stale">
                      Showing the last-known claim list — the latest couldn&rsquo;t load.{' '}
                      <button onClick={() => refresh()} data-testid="commercial-claims-stale-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer' }}>
                        Retry
                      </button>
                    </div>
                  )}
                  {v.refreshing && (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-refreshing">Refreshing the claim list…</div>
                  )}
                  {v.value.length === 0 && (
                    <div style={{ ...rowCard, ...muted }} data-testid="commercial-claims-empty">No vendor claim has been recorded yet.</div>
                  )}
                  {v.value.map((row) => {
                // Codex F4 — the SELECTED row reads whichever of the two reads is FRESHER, because
                // the list and the claim bundle both carry this bill's status and are fetched
                // independently. F4 preferred the claim whenever one existed; H4 narrowed that to
                // "whenever it did not error"; I2 showed the narrowing still wrong — a list refresh
                // that lands first during a joint refresh is demonstrably newer than a claim held
                // from an earlier visit, and the row went on showing `certified` while the list had
                // already returned `paid`.
                //
                // All three were proxies for one question — WHICH READ IS NEWER — that the store now
                // answers with a fact. Two successes on one monotonic counter are ordered; nothing
                // is inferred from an error, a status or the mere presence of a bundle.
                const claimFresher = row.id === selectedBillId
                  && claim !== null
                  && (claimStamp[row.id] ?? 0) > billsStamp;
                const b = claimFresher && claim ? claim.bill : row;
                return (
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
                );
                  })}
                </>
              )}
            </div>
            );
          })()}

          {tab === 'certification' && (
            <div data-testid="commercial-certification">
              {claimPanel((claim) => (
                <>
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
              ))}
            </div>
          )}

          {tab === 'payments' && (
            <div data-testid="commercial-payments">
              {claimPanel((claim) => (
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
              ))}
            </div>
          )}

          {tab === 'measurements' && (
            <div data-testid="commercial-measurements">
              {claimPanel((claim) => (
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
              ))}
            </div>
          )}
    </div>
  );
}
