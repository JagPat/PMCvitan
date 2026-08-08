import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { CommercialScreen } from '@/screens/CommercialScreen';
import { emptyProjectData, emptyModuleReadState } from '@/store/projectScope';
import type { CommercialClaimView, CommercialView } from '@/store/commercial';

/**
 * Phase 5 Task 7B-ii (§M) — the RENDERED claim tabs.
 *
 * The store tests cover the loaders. This file covers what only a render can: that a claim panel
 * never dereferences a claim it does not have.
 *
 * The case that made it necessary is not exotic. `selectedBillId` is COMPONENT state while the claim
 * map is STORE state, and a project switch tears the store down without unmounting this screen —
 * leaving a selected id with no entry and no status, neither loading nor error. The first draft's
 * guard had three branches for three known states and returned `null` for that fourth one, so the
 * panel rendered `claim!.verification.verdict` against `undefined` and the hub crashed on an
 * ordinary project switch. The guard now returns null ONLY when the claim is present, which is what
 * lets the panels carry no non-null assertions at all.
 */

const bundle = (): CommercialView => ({
  budget: { positions: [], openExceptions: 0 },
  cashForecast: {
    heads: [],
    totals: {
      budget: '1000.00', committed: '0.00', receivedNotBilled: '0.00', awaitingCertification: '0.00',
      certifiedPayable: '0.00', approved: '0.00', paid: '0.00', exposure: '0.00', headroom: '1000.00',
    },
    refreshedAt: null,
  },
  costHeads: [],
  attributions: [],
});

const claim = (): CommercialClaimView => ({
  bill: {
    id: 'bill-1', vendorId: 'v-1', vendorBillNumber: 'V-1', status: 'certified',
    documentDate: '2026-08-20', statusChangedAt: '2026-08-21T00:00:00.000Z',
    statusReason: null, disputeReason: null,
    createdAt: '2026-08-20T00:00:00.000Z', createdById: 'u-1',
    versions: [{
      id: 'ver-1', version: 1, supersedesVersion: null, claimedAmount: '100.00', lines: [],
      createdAt: '2026-08-20T00:00:00.000Z', createdById: 'u-1',
      supersededAt: null, supersededById: null, supersedeReason: null, live: true,
    }],
  },
  verification: {
    billId: 'bill-1', versionId: 'ver-1', verdict: 'matched', lines: [], exceptions: [],
    billStatus: 'certified',
  },
  certificate: null,
  deductions: {
    billId: 'bill-1', certificateId: null, certifiedAmount: null, deductions: [],
    withheld: '0.00', netPayable: null, billStatus: 'certified',
    advance: { vendorId: 'v-1', advanced: '0.00', recovered: '0.00', recoverable: '0.00' },
  },
  payments: {
    billId: 'bill-1', certificateId: null, approvals: [],
    approved: '0.00', paid: '0.00', approvable: null, billStatus: 'certified',
  },
  measurements: {},
});

describe('Task 7B-ii (§M) — the rendered claim tabs never dereference an absent claim', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    // The gateway lives in the store's CLOSURE, so `getInitialState()` does not clear it and a
    // deliberately-minimal stub (J1's) leaked into every later test in this file. Harmless until a
    // render dispatched a read that stub lacked; then the failure lands in an unrelated probe.
    useStore.getState()._setGateway(null);
    useStore.setState({
      capabilities: ['commercial'],
      commercialView: bundle(),
      commercialLoad: 'ready',
      commercialBills: [claim().bill],
      commercialBillsLoad: 'ready',
    });
  });
  afterEach(cleanup);

  const openClaimTab = (tab: 'certification' | 'payments' | 'measurements') => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId(`commercial-tab-${tab}`));
    return r;
  };

  it('with no claim selected, each claim tab asks for one instead of rendering blanks', () => {
    for (const tab of ['certification', 'payments', 'measurements'] as const) {
      const r = openClaimTab(tab);
      expect(r.getByTestId('commercial-claim-none')).toBeTruthy();
      cleanup();
    }
  });

  it('renders the lifecycle once the claim is loaded', () => {
    useStore.setState({
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-certification'));
    expect(r.getByTestId('verification-verdict').textContent).toBe('matched');
    // an uncertified claim is an ordinary state of this page, not an error
    expect(r.getByTestId('commercial-certificate-none')).toBeTruthy();
  });

  it('a project switch under a SELECTED claim renders a state, not a crash', () => {
    useStore.setState({
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-certification'));
    expect(r.getByTestId('verification-verdict')).toBeTruthy();

    // A REAL project switch: the store data and module-read state are emptied AND
    // `projectScopeGeneration` is bumped — `orgs`/auth do both together, and a test that omits the
    // bump is not reproducing a switch, it is reproducing a state the app never reaches.
    //
    // Wrapped in `act` because this is a store update outside an event handler; without it React
    // has not flushed the re-render when the assertion runs, so the test would pass on the PREVIOUS
    // frame — the render that must not exist.
    act(() => {
      useStore.setState({
        ...emptyProjectData(),
        ...emptyModuleReadState(),
        projectScopeGeneration: useStore.getState().projectScopeGeneration + 1,
        capabilities: ['commercial'],
        commercialView: bundle(),
        commercialLoad: 'ready',
      });
    });

    // Codex F3 corrected what this should ASSERT. The first version accepted "Loading the claim…",
    // which is not honest: nothing was loading and nothing would, so the tab was stuck with no
    // Retry. A selection belongs to the scope it was made in, so after a switch there is simply no
    // selection — and the panel says so.
    expect(
      r.getByTestId('commercial-claim-none'),
      'a claim selected in the previous project is not a selection in this one',
    ).toBeTruthy();
    expect(() => r.getByTestId('commercial-claim-loading')).toThrow();
  });

  it('the guard still renders a state if a claim vanishes WITHOUT a scope change', () => {
    // Defence in depth, and the probe that keeps the guard's structural property honest: with the
    // scope unchanged the selection stands, so a missing entry is the genuinely unknown case. The
    // three-branch guard returned `null` here and the panel crashed
    // (`Cannot read properties of null (reading 'verification')`).
    //
    // Codex I3 — and the answer is UNAVAILABLE, not "Loading the claim…". Nothing auto-loads a
    // claim, so with no value and no status there is no read in flight and none coming: a spinner
    // here is a promise the screen cannot keep, which is exactly the permanent-loading shape F3
    // found one branch over. `viewOf`'s `willLoad: false` is what tells the two apart.
    useStore.setState({
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-certification'));
    expect(r.getByTestId('verification-verdict')).toBeTruthy();

    act(() => { useStore.setState({ commercialClaims: {}, commercialClaimLoad: {} }); });
    expect(r.getByTestId('commercial-claim-unavailable')).toBeTruthy();
    expect(r.getByTestId('commercial-claim-retry')).toBeTruthy();
  });

  it('F3: selecting again in the NEW scope works — the reset is not a permanent block', () => {
    useStore.setState({
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    act(() => { useStore.setState({ projectScopeGeneration: useStore.getState().projectScopeGeneration + 1 }); });

    // the same claim, selected fresh in the new scope, is honoured
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-certification'));
    expect(r.getByTestId('verification-verdict').textContent).toBe('matched');
  });

  it('F2: a failed refresh warns on EVERY claim tab, not just Certification', () => {
    useStore.setState({
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'error' }, // last-good kept, latest read failed
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));

    for (const tab of ['certification', 'payments', 'measurements'] as const) {
      fireEvent.click(r.getByTestId(`commercial-tab-${tab}`));
      expect(
        r.getByTestId('commercial-claim-stale'),
        `${tab} renders a claim whose latest read failed without saying so`,
      ).toBeTruthy();
    }
    // and Payments is the tab that matters most: `approvable` is what gets authorised
    fireEvent.click(r.getByTestId('commercial-tab-payments'));
    expect(r.getByTestId('payments-approvable')).toBeTruthy();
    expect(r.getByTestId('commercial-claim-stale')).toBeTruthy();
  });

  it('F4: the selected row shows the LOADED claim\'s status, not the list\'s stale copy', () => {
    // The list was fetched before a certification landed; the claim read is fresher — and Codex I2
    // is why that sentence now appears in the FIXTURE instead of only in this comment. The screen
    // used to infer "fresher" from the claim's mere presence (F4) and then from its not having
    // errored (H4); it now reads the ordering of the two successes, so the precondition this test
    // has always described is stated as data rather than implied by a proxy.
    const stale = { ...claim().bill, status: 'verified' as const };
    const fresh = claim(); // status: 'certified'
    useStore.setState({
      commercialBills: [stale],
      commercialBillsLoad: 'ready',
      commercialBillsStamp: 1,
      commercialClaims: { 'bill-1': fresh },
      commercialClaimLoad: { 'bill-1': 'ready' },
      commercialClaimStamp: { 'bill-1': 2 }, // the claim read succeeded AFTER the list read
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    expect(r.getByTestId('commercial-claim-status-bill-1').textContent).toBe('verified');

    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    expect(
      r.getByTestId('commercial-claim-status-bill-1').textContent,
      'the row said `verified` while the claim tabs said `certified` — one workflow, two answers',
    ).toBe('certified');
  });

  it('a claim that failed to load offers Retry rather than an empty panel', () => {
    useStore.setState({ commercialClaimLoad: { 'bill-1': 'error' } });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-payments'));
    expect(r.getByTestId('commercial-claim-unavailable')).toBeTruthy();
    expect(r.getByTestId('commercial-claim-retry')).toBeTruthy();
  });

  it('G1: a scope change while Claims is showing RELOADS the list, not renders nothing', () => {
    const loadCommercialBills = vi.fn().mockResolvedValue(undefined);
    useStore.setState({ loadCommercialBills } as never);
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    expect(r.getByTestId('commercial-claim-row-bill-1')).toBeTruthy();

    // the scope teardown: the list goes back to null/idle while Claims is STILL the active tab and
    // no click follows. RED against the click-handler version: no load fires and the panel renders
    // nothing at all — `(bills ?? []).map` over null, with every other branch false.
    act(() => {
      useStore.setState({
        commercialBills: null,
        commercialBillsLoad: 'idle',
        projectScopeGeneration: useStore.getState().projectScopeGeneration + 1,
      });
    });

    expect(
      loadCommercialBills,
      'the list emptied under an open Claims tab and nothing asked for it again',
    ).toHaveBeenCalled();
  });

  it('G1: the panel is never blank — an emptied list shows a state while it reloads', () => {
    useStore.setState({ commercialBills: null, commercialBillsLoad: 'loading' });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    expect(r.getByTestId('commercial-claims-loading')).toBeTruthy();
  });

  it('H1: a cached list whose refresh FAILED says so, with a retry', () => {
    useStore.setState({ commercialBills: [], commercialBillsLoad: 'error' });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    // the empty-state copy is still there — that is the trap: "no claims yet" reads as fact
    expect(r.getByTestId('commercial-claims-empty')).toBeTruthy();
    expect(
      r.getByTestId('commercial-claims-stale'),
      '"No vendor claim has been recorded yet" after a failed refresh is a claim about the world',
    ).toBeTruthy();
    expect(r.getByTestId('commercial-claims-stale-retry')).toBeTruthy();
  });

  it('H2: the claim workflow works when the MONEY bundle failed', () => {
    // money-position is down; /commercial/bills and /commercial/claims/:id are fine
    useStore.setState({
      commercialView: null,
      commercialLoad: 'error',
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
    });
    const r = render(<CommercialScreen />);
    // the tabs exist at all — RED when everything sits inside `{commercial && …}`
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-certification'));
    expect(
      r.getByTestId('verification-verdict').textContent,
      'an accountant could not process a claim because the headroom read was down',
    ).toBe('matched');
    // …and the money tab still reports its own failure honestly
    fireEvent.click(r.getByTestId('commercial-tab-position'));
    expect(r.getByTestId('commercial-unavailable')).toBeTruthy();
  });

  it('H3: the list loads when the CAPABILITY arrives after the scope reset', () => {
    // The stub RECORDS the capability state at call time, because the real
    // `loadCommercialBills` is capability-gated and returns immediately when the project is
    // off-pilot. A stub that resolves unconditionally cannot see this defect at all — it counts a
    // call that would have done nothing, which is how the first version of this probe passed with
    // the bug in place. (The convergence doc's root D, third appearance on this PR: a stub that
    // does not model the thing it stands for agrees with the bug.)
    const onPilotAtCall: boolean[] = [];
    const loadCommercialBills = vi.fn().mockImplementation(() => {
      onPilotAtCall.push(useStore.getState().capabilities.includes('commercial'));
      return Promise.resolve();
    });
    useStore.setState({ loadCommercialBills } as never);
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    loadCommercialBills.mockClear();
    onPilotAtCall.length = 0;

    // the real project-switch path: capabilities AND the list reset together, so the effect fires
    // once into a capability-gated no-op...
    act(() => {
      useStore.setState({
        capabilities: [],
        commercialBills: null,
        commercialBillsLoad: 'idle',
        projectScopeGeneration: useStore.getState().projectScopeGeneration + 1,
      });
    });
    // ...and the shell then reports the new project's capability. RED when `onPilot` is missing from
    // the condition and the deps: nothing changed that the effect watches, so it never fires again.
    act(() => { useStore.setState({ capabilities: ['commercial'] }); });

    expect(
      onPilotAtCall.some((onPilot) => onPilot),
      'every request for the list happened while the project was off-pilot, so the real loader would '
      + 'have no-opped every time — the capability arrived and nothing asked again',
    ).toBe(true);
  });

  it('H4: a STALE claim does not override a freshly refreshed row', () => {
    // the list refreshed successfully to `paid`; the claim refresh failed, leaving `certified`
    useStore.setState({
      commercialBills: [{ ...claim().bill, status: 'paid' as const }],
      commercialBillsLoad: 'ready',
      commercialBillsStamp: 2, // the list's success is the LATER of the two
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'error' },
      commercialClaimStamp: { 'bill-1': 1 },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    expect(
      r.getByTestId('commercial-claim-status-bill-1').textContent,
      'the claim bundle is the OLDER read here — preferring it always is the mirror of the bug it fixed',
    ).toBe('paid');
  });

  it('H4: a healthy claim still wins over a stale list row', () => {
    // the guard must not swing the other way: this is the case the previous round fixed
    useStore.setState({
      commercialBills: [{ ...claim().bill, status: 'verified' as const }],
      commercialBillsLoad: 'ready',
      commercialBillsStamp: 1,
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
      commercialClaimStamp: { 'bill-1': 2 },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    expect(r.getByTestId('commercial-claim-status-bill-1').textContent).toBe('certified');
  });

  // ── Codex round 4 ────────────────────────────────────────────────────────────────────────────

  /** The four store loaders the screen can dispatch, stubbed together so a probe can assert not
   *  only what Refresh DID re-read but what it left alone. */
  const stubLoaders = () => {
    const loaders = {
      loadCommercial: vi.fn().mockResolvedValue(undefined),
      loadCommercialBills: vi.fn().mockResolvedValue(undefined),
      loadCommercialClaim: vi.fn().mockResolvedValue(undefined),
      loadShell: vi.fn(),
    };
    // in `act` so the screen has re-read the swapped functions before the click under test
    act(() => { useStore.setState(loaders as never); });
    return loaders;
  };

  it('I1: Refresh on a CLAIM tab re-reads the claim workflow, not the money position', () => {
    useStore.setState({
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
      commercialClaimStamp: { 'bill-1': 2 },
      commercialBillsStamp: 1,
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-payments'));

    // stubbed AFTER the selection so the load `selectClaim` fires is not counted as Refresh's work
    const loaders = stubLoaders();
    fireEvent.click(r.getByTestId('commercial-refresh'));

    // RED before: Refresh drove `loadCommercial()` alone, so the open claim — the lifecycle
    // someone is about to authorise a payment against — was exactly as stale afterwards.
    expect(loaders.loadCommercialBills, 'Refresh left the claim list as stale as it found it').toHaveBeenCalled();
    expect(loaders.loadCommercialClaim).toHaveBeenCalledWith('bill-1');
    expect(loaders.loadCommercial, 'Refresh re-read a money bundle that is not on screen').not.toHaveBeenCalled();
  });

  it('I1: Refresh on a MONEY tab still re-reads the money position, and only that', () => {
    // The symmetric half, and deliberately a REGRESSION GUARD rather than a finding reproduction:
    // it passes both before and after, because what it protects is the behaviour the fix must not
    // swing away from. Round 3's H4 was an over-correction that mirrored the bug it fixed; a probe
    // pinning the untouched direction is the cheap defence against doing that again.
    useStore.setState({ capabilitiesKnown: true });
    const r = render(<CommercialScreen />);
    const loaders = stubLoaders();
    fireEvent.click(r.getByTestId('commercial-refresh'));
    expect(loaders.loadCommercial).toHaveBeenCalled();
    expect(loaders.loadCommercialBills).not.toHaveBeenCalled();
    expect(loaders.loadCommercialClaim).not.toHaveBeenCalled();
  });

  it('I1: with the capability missing, Refresh re-drives the SHELL rather than an inert loader', () => {
    // Every loader gates on `capabilities.includes('commercial')`, so `capabilitiesKnown` was a
    // proxy for "the loader will do something" that is wrong exactly here: known, but not reporting
    // the capability. RED before: Refresh dispatched `loadCommercial()`, which returns immediately.
    useStore.setState({ capabilities: [], capabilitiesKnown: true });
    const r = render(<CommercialScreen />);
    const loaders = stubLoaders();
    fireEvent.click(r.getByTestId('commercial-refresh'));
    expect(loaders.loadShell, 'Refresh dispatched an inert no-op — a dead button').toHaveBeenCalled();
    expect(loaders.loadCommercial).not.toHaveBeenCalled();
  });

  it('I2: a claim being REFRESHED says so, and the row prefers whichever read is newer', () => {
    // The concrete case: a joint refresh in which the LIST comes back first with `paid` while the
    // claim bundle held from an earlier visit still says `certified` and its own read is in flight.
    useStore.setState({
      commercialBills: [{ ...claim().bill, status: 'paid' as const }],
      commercialBillsLoad: 'ready',
      commercialBillsStamp: 2, // the list's success is the later one
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'loading' },
      commercialClaimStamp: { 'bill-1': 1 },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    // The preference rule only applies to the SELECTED row, so the row has to be selected before
    // this asserts anything — an unselected row always renders the list's copy and would pass
    // whatever the rule said. (Root D: a probe that cannot reach the code it names.)
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    // RED before: the row preferred the claim bundle for any status other than `error`, so it went
    // on saying `certified` after the list had already reported `paid`.
    expect(
      r.getByTestId('commercial-claim-status-bill-1').textContent,
      'the row showed a lifecycle the list had already superseded',
    ).toBe('paid');

    fireEvent.click(r.getByTestId('commercial-tab-payments'));
    // …and the tabs still show the last-known bundle (stale-while-revalidate is the VALUE's job),
    // but no longer pretend a completed read confirmed it.
    expect(r.getByTestId('payments-approvable')).toBeTruthy();
    expect(
      r.getByTestId('commercial-claim-refreshing'),
      'a lifecycle held from an earlier visit looked identical to one a current read confirmed',
    ).toBeTruthy();
  });

  it('I3: a shell failure leaves the Claims panel explained and retryable, never blank', () => {
    // The real shape: the shell read failed, so capabilities are empty and the list never left
    // `idle`. RED before: `billsLoad === 'loading'` false, `=== 'error'` false, `bills?.length`
    // undefined and `(bills ?? []).map` over null — every branch false, an empty div on screen.
    useStore.setState({ capabilities: [], commercialBills: null, commercialBillsLoad: 'idle' });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    expect(
      r.getByTestId('commercial-claims-unavailable'),
      'the Claims tab rendered nothing at all — no rows, no state, no explanation, no retry',
    ).toBeTruthy();

    const loaders = stubLoaders();
    fireEvent.click(r.getByTestId('commercial-claims-retry'));
    expect(loaders.loadShell, 'the retry dispatched a capability-gated no-op').toHaveBeenCalled();
  });

  it('I3 (symmetric): the MONEY tab has the same hole, and the same decision closes it', () => {
    // Not a finding — the instance the finding did not name. Root F of the convergence audit says a
    // principle applies to what you enumerate, so: three resources on this screen, all three routed
    // through `viewOf`. The money bundle's `reading` guard was `(idle || loading) && !commercial`,
    // which renders a spinner for a bundle that a capability-gated `loadCommercial()` will never
    // fetch — the permanent-loading shape, on the tab this hub OPENS on.
    useStore.setState({ capabilities: [], commercialView: null, commercialLoad: 'idle' });
    const r = render(<CommercialScreen />);
    expect(r.getByTestId('commercial-unavailable')).toBeTruthy();
    expect(() => r.getByTestId('commercial-loading')).toThrow();

    const loaders = stubLoaders();
    fireEvent.click(r.getByTestId('commercial-retry-empty'));
    expect(loaders.loadShell).toHaveBeenCalled();
  });

  it('I3: `idle` while the list IS about to load still shows loading, not unavailable', () => {
    // The other side of `willLoad`, and the reason it is a parameter rather than a status check:
    // `idle` is hopeful when the effect is about to fetch and dead when nothing is. Getting this
    // backwards would replace a blank panel with a false "couldn't load" on every first open.
    useStore.setState({ commercialBills: null, commercialBillsLoad: 'idle' }); // capability present
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    expect(r.getByTestId('commercial-claims-loading')).toBeTruthy();
  });
});

describe('Task 7B-iii-a (§M) — the write controls', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    // The gateway lives in the store's CLOSURE, so `getInitialState()` does not clear it and a
    // deliberately-minimal stub (J1's) leaked into every later test in this file. Harmless until a
    // render dispatched a read that stub lacked; then the failure lands in an unrelated probe.
    useStore.getState()._setGateway(null);
    useStore.setState({
      capabilities: ['commercial'],
      commercialView: { ...bundle(), costHeads: [{ code: 'CIVIL', name: 'Civil' }, { code: 'MEP', name: 'MEP' }] } as never,
      commercialLoad: 'ready',
    });
  });
  afterEach(cleanup);

  it('labour r7: editing the amount does NOT re-enable a budget set that is in flight', () => {
    // The screen — not the helper. A probe that only calls `isBudgetPendingForHead` passes even
    // if the screen stops using it, which is the shape that let a stub agree with a defect three
    // times on PR #300. This asserts the rendered button.
    useStore.setState({ commercialPending: ['com:budget:CIVIL:100.00'] });
    const r = render(<CommercialScreen />);
    fireEvent.change(r.getByTestId('budget-head'), { target: { value: 'CIVIL' } });
    fireEvent.change(r.getByTestId('budget-amount'), { target: { value: '100.00' } });
    fireEvent.change(r.getByTestId('budget-reason'), { target: { value: 'v1' } });
    expect((r.getByTestId('budget-submit') as HTMLButtonElement).disabled).toBe(true);

    // the user retypes the figure while the first command is still in flight
    fireEvent.change(r.getByTestId('budget-amount'), { target: { value: '200.00' } });
    expect(
      (r.getByTestId('budget-submit') as HTMLButtonElement).disabled,
      'the button re-armed mid-flight — the same head would get two revisions',
    ).toBe(true);
  });

  it('a budget set for a DIFFERENT head is unaffected by the one in flight', () => {
    useStore.setState({ commercialPending: ['com:budget:CIVIL:100.00'] });
    const r = render(<CommercialScreen />);
    fireEvent.change(r.getByTestId('budget-head'), { target: { value: 'MEP' } });
    fireEvent.change(r.getByTestId('budget-amount'), { target: { value: '50.00' } });
    fireEvent.change(r.getByTestId('budget-reason'), { target: { value: 'mep v1' } });
    expect(
      (r.getByTestId('budget-submit') as HTMLButtonElement).disabled,
      'one head in flight disabled every other head',
    ).toBe(false);
  });

  it('the form is SCOPED — a project switch cannot submit one site\'s draft against another', () => {
    const r = render(<CommercialScreen />);
    fireEvent.change(r.getByTestId('budget-head'), { target: { value: 'CIVIL' } });
    fireEvent.change(r.getByTestId('budget-amount'), { target: { value: '100.00' } });
    act(() => {
      useStore.setState({ projectScopeGeneration: useStore.getState().projectScopeGeneration + 1 });
    });
    expect((r.getByTestId('budget-amount') as HTMLInputElement).value).toBe('');
    expect((r.getByTestId('budget-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Task 7B-iii-a round 2 — Codex J1/J2/J3', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.setState({
      role: 'pmc',
      capabilities: ['commercial'],
      commercialView: {
        ...bundle(),
        costHeads: [{ code: 'CIVIL', name: 'Civil' }, { code: 'MEP', name: 'MEP' }],
        attributions: [
          { id: 'A1', poLineId: 'PL-1', labourPoLineId: null, costHeadCode: 'CIVIL', reason: 'initial', createdAt: '', createdById: 'u', supersededAt: null, supersededById: null, supersedeReason: null },
          { id: 'A2', poLineId: 'PL-2', labourPoLineId: null, costHeadCode: 'CIVIL', reason: 'initial', createdAt: '', createdById: 'u', supersededAt: null, supersededById: null, supersedeReason: null },
        ],
      } as never,
      commercialLoad: 'ready',
    });
  });
  afterEach(cleanup);

  it('J1: an ENGINEER sees the hub but none of the write controls', () => {
    // `commercial.read` is pmc+engineer; all three writes are pmc. The outbox is WRITE-AHEAD, so
    // an engineer offline was told "saved, will sync" and the op was discarded on reconnect.
    useStore.setState({ role: 'engineer' });
    const r = render(<CommercialScreen />);
    expect(r.getByTestId('commercial-position'), 'the hub itself is readable by an engineer').toBeTruthy();
    expect(() => r.getByTestId('commercial-budget-form')).toThrow();
    expect(() => r.getByTestId('commercial-costhead-form')).toThrow();
    fireEvent.click(r.getByTestId('commercial-tab-commitments'));
    expect(() => r.getByTestId('attr-submit-A1')).toThrow();
  });

  it('J1: the store REFUSES an unauthorised write even if a control is bypassed', () => {
    // A GATEWAY is required or this passes for the wrong reason: `dispatchCommercial` returns at
    // `if (!gateway …)` before the authority check is ever reached, so the probe would be green
    // with the guard deleted. Caught by mutation — the first version did exactly that.
    useStore.getState()._setGateway({
      setCommercialBudget: vi.fn().mockResolvedValue({}),
      snapshot: vi.fn().mockResolvedValue({}),
    } as never);
    useStore.setState({ role: 'engineer', online: false });
    useStore.getState().setCommercialBudget('CIVIL', '100.00', 'v1');
    expect(useStore.getState().outbox, 'an op was queued without the authority to run it').toHaveLength(0);
    expect(useStore.getState().commercialPending).toEqual([]);
  });

  it('J2: editing one attribution row does NOT arm another row with its values', () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-commitments'));
    fireEvent.change(r.getByTestId('attr-head-A1'), { target: { value: 'MEP' } });
    fireEvent.change(r.getByTestId('attr-reason-A1'), { target: { value: 'miscoded' } });

    expect((r.getByTestId('attr-submit-A1') as HTMLButtonElement).disabled).toBe(false);
    // RED with one component-wide draft: B's button is enabled carrying A's head and reason, so a
    // click re-attributes the WRONG commitment to a head nobody chose for it.
    expect(
      (r.getByTestId('attr-submit-A2') as HTMLButtonElement).disabled,
      "another line's button was armed with this line's values",
    ).toBe(true);
    expect((r.getByTestId('attr-head-A2') as HTMLSelectElement).value).toBe('');
  });

  it('J3: a malformed amount never reaches the durable outbox', () => {
    const r = render(<CommercialScreen />);
    fireEvent.change(r.getByTestId('budget-head'), { target: { value: 'CIVIL' } });
    fireEvent.change(r.getByTestId('budget-reason'), { target: { value: 'v1' } });
    for (const bad of ['100.123', 'abc', '-5.00', '1e3']) {
      fireEvent.change(r.getByTestId('budget-amount'), { target: { value: bad } });
      expect(
        (r.getByTestId('budget-submit') as HTMLButtonElement).disabled,
        `"${bad}" would have been queued, then discarded on reconnect with a 400`,
      ).toBe(true);
      expect(r.getByTestId('budget-amount-invalid')).toBeTruthy();
    }
    fireEvent.change(r.getByTestId('budget-amount'), { target: { value: '100.5' } });
    expect((r.getByTestId('budget-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(() => r.getByTestId('budget-amount-invalid')).toThrow();
  });
});

describe('Task 7B-iii-b round 2 — Codex M1–M7', () => {
  const claimWith = (status: string) => ({ ...claim(), bill: { ...claim().bill, status } });
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.getState()._setGateway(null);   // the gateway lives in the store closure — see above
    useStore.setState({
      role: 'engineer', capabilities: ['commercial'],
      commercialView: bundle() as never, commercialLoad: 'ready',
      commercialBills: [claim().bill], commercialBillsLoad: 'ready',
    });
  });
  afterEach(cleanup);

  it('M2: an engineer can LODGE a claim — the workflow can create what it processes', () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    // RED before: the Claims tab could only act on bills that already existed, so a project with
    // no claim showed an empty state and no way out of it.
    expect(r.getByTestId('commercial-lodge-form')).toBeTruthy();
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(true);
    // a bill number NOT already on screen — the fixture's claim is v-1/V-1, and N5's guard
    // correctly refuses a duplicate of it (asserted separately below)
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-2'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    // round-3 P2: a claim is the vendor's whole invoice, so lines are ADDED to a set. Round 7
    // refined WHEN that set counts as non-empty: a VALID entry row folds into the payload, because
    // pressing Lodge with a filled row plainly means "including this one". So the claim is
    // lodgeable here — and Add line is for the SECOND and later lines.
    fireEvent.click(r.getByTestId('lodge-add-line'));
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('N5: a duplicate of a LIVE claim already on screen is refused, not promised', () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-9'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(false);
    // the SAME claim under case and padding the server's index collapses — refused, with the
    // reason shown rather than a silent disable
    fireEvent.change(r.getByTestId('lodge-number'), { target: { value: ' v-1 ' } });
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByTestId('lodge-duplicate')).toBeTruthy();
  });

  it('N4: an impossible calendar date never reaches the outbox', () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-9'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    // `2026-02-31` is well-SHAPED and impossible — a regex would pass it
    for (const bad of ['abc', '2026-02-31', '2026-13-01']) {
      fireEvent.change(r.getByTestId('lodge-date'), { target: { value: bad } });
      expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled, bad).toBe(true);
    }
    fireEvent.change(r.getByTestId('lodge-date'), { target: { value: '2026-02-28' } });
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('P3: a material line carries the invoice\u2019s tax and freight', () => {
    // RED before: lodge lines held only quantity and rate, so the server defaulted both to zero and
    // the claim was certified and paid at its base amount — silently disagreeing with the document.
    const recordVendorBill = vi.fn();
    act(() => { useStore.setState({ recordVendorBill } as never); });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-6'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '50'], ['lodge-rate', '100.00'],
      ['lodge-tax', '900.00'], ['lodge-freight', '250.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    fireEvent.click(r.getByTestId('lodge-submit'));
    expect(recordVendorBill.mock.calls[0][0].lines[0]).toMatchObject({
      poLineId: 'PL-1', quantity: '50', rate: '100.00', taxAmount: '900.00', freightAmount: '250.00',
    });

    // and a blank one is OMITTED rather than sent as an explicit zero the document never stated
    for (const [id, v] of [['lodge-poline', 'PL-2'], ['lodge-qty', '1'], ['lodge-rate', '5.00'],
      ['lodge-tax', ''], ['lodge-freight', '']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    fireEvent.click(r.getByTestId('lodge-submit'));
    const second = recordVendorBill.mock.calls[1][0].lines[1];
    expect(second).not.toHaveProperty('taxAmount');
    expect(second).not.toHaveProperty('freightAmount');
  });

  it('R1: a line typed but not ADDED is never dropped from the claim', () => {
    // RED before: Lodge read only `lodge.lines`, so a filled entry row vanished — and the vendor's
    // document number is frozen by the duplicate index the moment the claim is recorded, so that
    // line had no later path into the invoice.
    const recordVendorBill = vi.fn();
    act(() => { useStore.setState({ recordVendorBill } as never); });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-4'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));

    // a second line typed and NOT added — pressing Lodge here plainly means "including this one"
    for (const [id, v] of [['lodge-poline', 'PL-2'], ['lodge-qty', '3'], ['lodge-rate', '50.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-submit'));
    const sent = recordVendorBill.mock.calls[0][0].lines;
    expect(sent, 'a line visible on screen was dropped from the claim it was typed into').toHaveLength(2);
    expect(sent[1]).toMatchObject({ poLineId: 'PL-2', quantity: '3', rate: '50.00' });
  });

  it('R2: a DIRTY but incomplete entry refuses the lodge rather than being dropped', () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-4'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(false);

    // a half-typed line: neither droppable nor sendable, so the form says so
    fireEvent.change(r.getByTestId('lodge-poline'), { target: { value: 'PL-2' } });
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByTestId('lodge-entry-incomplete')).toBeTruthy();

    // clearing it returns the form to lodgeable — the empty entry loses nothing
    fireEvent.change(r.getByTestId('lodge-poline'), { target: { value: '' } });
    expect((r.getByTestId('lodge-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  const labourClaim = (status: string, registerOver: Record<string, unknown> = {}) => {
    const c = claim();
    useStore.setState({
      commercialClaims: {
        'bill-1': {
          ...c, measurements: {},
          bill: {
            ...c.bill, status,
            versions: [{
              ...c.bill.versions[0]!, live: status === 'submitted',
              lines: [{
                id: 'ln-1', type: 'labour' as const, poLineId: null, labourPoLineId: 'LPL-1',
                quantity: '2', rate: '100.00', taxAmount: '0.00', freightAmount: '0.00', amount: '200.00',
              }],
            }],
          },
        } as never,
      },
      commercialClaimLoad: { 'bill-1': 'ready' },
      commercialClaimStamp: { 'bill-1': 2 },
      commercialBillsStamp: 1,
      commercialLineRegisters: {
        'LPL-1': {
          labourPoLineId: 'LPL-1', rows: [], measured: '0', effort: '10',
          orderedPersonShiftQty: 10, liveAuthorityPersonShiftQty: 10, defaulted: false,
          ...registerOver,
        },
      } as never,
      commercialLineRegisterLoad: { 'LPL-1': 'ready' },
    });
  };
  const openMeasurements = () => {
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    fireEvent.click(r.getByTestId('commercial-tab-measurements'));
    return r;
  };

  it('Q-c: a quantity the register already rules out never reaches the outbox', () => {
    // measured 9 of a live authority of 10 — the screen holds enough to know 2 is refused, and the
    // durable outbox would otherwise report it saved before the server dropped it.
    labourClaim('draft', { measured: '9' });
    const r = openMeasurements();
    fireEvent.change(r.getByTestId('measure-activity-LPL-1'), { target: { value: 'ACT-1' } });
    fireEvent.change(r.getByTestId('measure-output-LPL-1'), { target: { value: 'OUT-1' } });
    fireEvent.change(r.getByTestId('measure-qty-LPL-1'), { target: { value: '2' } });
    expect((r.getByTestId('measure-submit-LPL-1') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByTestId('measure-over-cap-LPL-1').textContent).toContain('1');
    // exactly the remainder is allowed — the boundary is not off by one
    fireEvent.change(r.getByTestId('measure-qty-LPL-1'), { target: { value: '1' } });
    expect((r.getByTestId('measure-submit-LPL-1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Q-c: the EFFORT cap binds when it is the tighter of the two', () => {
    labourClaim('draft', { measured: '0', effort: '3', liveAuthorityPersonShiftQty: 10 });
    const r = openMeasurements();
    fireEvent.change(r.getByTestId('measure-activity-LPL-1'), { target: { value: 'ACT-1' } });
    fireEvent.change(r.getByTestId('measure-output-LPL-1'), { target: { value: 'OUT-1' } });
    fireEvent.change(r.getByTestId('measure-qty-LPL-1'), { target: { value: '4' } });
    expect((r.getByTestId('measure-submit-LPL-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('measure-qty-LPL-1'), { target: { value: '3' } });
    expect((r.getByTestId('measure-submit-LPL-1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Q-d: a correction that would take its OWN row below zero is refused', () => {
    labourClaim('draft', {
      measured: '5',
      rows: [
        { id: 'm1', quantity: '1', correctsId: null, activityId: 'ACT-1', citedOutputId: 'OUT-1', reason: null },
        { id: 'm2', quantity: '4', correctsId: null, activityId: 'ACT-1', citedOutputId: 'OUT-2', reason: null },
      ],
    });
    const r = openMeasurements();
    fireEvent.change(r.getByTestId('correct-reason-m1'), { target: { value: 'miscount' } });
    // the LINE has 5 measured, so a line-level rule would allow -2; the row has 1, and the server's
    // floor is the row's
    fireEvent.change(r.getByTestId('correct-qty-m1'), { target: { value: '-2' } });
    expect((r.getByTestId('correct-submit-m1') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByTestId('correct-over-withdraw-m1').textContent).toContain('1');
    fireEvent.change(r.getByTestId('correct-qty-m1'), { target: { value: '-1' } });
    expect((r.getByTestId('correct-submit-m1') as HTMLButtonElement).disabled).toBe(false);
    // and a POSITIVE delta is never blocked by a withdrawal floor
    fireEvent.change(r.getByTestId('correct-qty-m1'), { target: { value: '3' } });
    expect((r.getByTestId('correct-submit-m1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Q-d: an earlier correction reduces what the row still has to give', () => {
    labourClaim('draft', {
      measured: '1',
      rows: [
        { id: 'm1', quantity: '3', correctsId: null, activityId: 'ACT-1', citedOutputId: 'OUT-1', reason: null },
        { id: 'c1', quantity: '-2', correctsId: 'm1', activityId: 'ACT-1', citedOutputId: 'OUT-1', reason: 'first' },
      ],
    });
    const r = openMeasurements();
    fireEvent.change(r.getByTestId('correct-reason-m1'), { target: { value: 'again' } });
    fireEvent.change(r.getByTestId('correct-qty-m1'), { target: { value: '-2' } });
    expect((r.getByTestId('correct-submit-m1') as HTMLButtonElement).disabled, '3 − 2 leaves 1').toBe(true);
    fireEvent.change(r.getByTestId('correct-qty-m1'), { target: { value: '-1' } });
    expect((r.getByTestId('correct-submit-m1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('N2/Q-b: a LABOUR claim line is lodged as `labourPoLineId` and carries no charges', () => {
    const recordVendorBill = vi.fn();
    act(() => { useStore.setState({ recordVendorBill } as never); });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-7'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'LPL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00'], ['lodge-tax', '900.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.change(r.getByTestId('lodge-linekind'), { target: { value: 'labour' } });
    // Q-b — a labour PO snapshot freezes neither, so the switch CLEARS and disables them rather
    // than carrying a value the server would refuse
    expect((r.getByTestId('lodge-tax') as HTMLInputElement).value).toBe('');
    expect((r.getByTestId('lodge-tax') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(r.getByTestId('lodge-add-line'));
    fireEvent.click(r.getByTestId('lodge-submit'));
    // N2 — the server's XOR
    const sent = recordVendorBill.mock.calls[0][0].lines[0];
    expect(sent).toMatchObject({ labourPoLineId: 'LPL-1' });
    expect(sent.poLineId).toBeUndefined();
    expect(sent.taxAmount).toBeUndefined();
  });

  it('O4: a vendor invoice covering SEVERAL po lines is lodged whole', () => {
    // RED before: the submit path always sent a singleton `lines` array. The vendor's document
    // number is the frozen duplicate key and amendment is not surfaced, so every line after the
    // first had no path into the claim — one line was enough to record a claim and not enough to
    // record THAT claim.
    const recordVendorBill = vi.fn();
    act(() => { useStore.setState({ recordVendorBill } as never); });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    for (const [id, v] of [['lodge-vendor', 'v-1'], ['lodge-number', 'V-8'], ['lodge-date', '2026-08-08'],
      ['lodge-poline', 'PL-1'], ['lodge-qty', '2'], ['lodge-rate', '100.00']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    // a SECOND line on the same invoice
    for (const [id, v] of [['lodge-poline', 'PL-9'], ['lodge-qty', '3'], ['lodge-rate', '250.50']] as const) {
      fireEvent.change(r.getByTestId(id), { target: { value: v } });
    }
    fireEvent.click(r.getByTestId('lodge-add-line'));
    fireEvent.click(r.getByTestId('lodge-submit'));

    expect(recordVendorBill).toHaveBeenCalledTimes(1);
    const sent = recordVendorBill.mock.calls[0][0].lines;
    expect(sent, 'the invoice was lodged one line at a time, and the rest were unreachable').toHaveLength(2);
    expect(sent[0]).toMatchObject({ poLineId: 'PL-1', quantity: '2', rate: '100.00' });
    expect(sent[1]).toMatchObject({ poLineId: 'PL-9', quantity: '3', rate: '250.50' });
    // and a mistaken line can be taken back out before the claim is recorded
    expect(r.getByTestId('lodge-line-1')).toBeTruthy();
  });

  it('M3/M4: a transition the server refuses is never offered', () => {
    useStore.setState({ commercialBills: [claimWith('paid').bill] as never });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    const id = claim().bill.id;
    // RED before: both were enabled for every status, so an impossible transition was persisted to
    // the durable outbox and reported saved before a terminal 409 dropped it.
    expect((r.getByTestId(`bill-submit-${id}`) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId(`bill-reason-${id}`), { target: { value: 'no' } });
    expect((r.getByTestId(`bill-reject-${id}`) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    useStore.setState({ commercialBills: [claimWith('draft').bill] as never });
    const d = render(<CommercialScreen />);
    fireEvent.click(d.getByTestId('commercial-tab-claims'));
    expect((d.getByTestId(`bill-submit-${id}`) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Task 7B-iii-b round 2 — the shared value rules (M5, M6, M7)', () => {
  it('M5: a correction delta is validated with the SAME rule the contract uses', async () => {
    const { isCorrectionDelta } = await import('@vitan/shared');
    for (const bad of ['abc', '0', '0.0', '1.1234567', '']) expect(isCorrectionDelta(bad), bad).toBe(false);
    for (const ok of ['-0.5', '2', '-1.000001']) expect(isCorrectionDelta(ok), ok).toBe(true);
  });

  it('M6: the bill coalesce key normalizes the way the SERVER duplicate index does', async () => {
    const { billCoalesceKey } = await import('@/lib/commercialKeys');
    // RED before (trim only): a case or INNER-whitespace difference produced different keys, so
    // both entered the durable outbox for what the server treats as ONE live claim.
    //
    // The pairs are chosen against the server's ACTUAL rule — strip all whitespace, lowercase —
    // rather than the review comment's illustration: `V-1` and `v 1` normalize to `v-1` and `v1`,
    // which the server also treats as different claims, so asserting them equal would have pinned
    // a behaviour the server does not have.
    expect(billCoalesceKey('v-1', 'V-1')).toBe(billCoalesceKey('v-1', ' v-1 '));   // case + padding
    expect(billCoalesceKey('v-1', 'V- 1')).toBe(billCoalesceKey('v-1', 'v-1'));    // inner whitespace
    expect(billCoalesceKey('v-1', 'V-1')).not.toBe(billCoalesceKey('v-1', 'V-2')); // genuinely different
  });

});
