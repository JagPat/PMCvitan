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
    // (`Cannot read properties of null (reading 'verification')`); it now says so instead.
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
    expect(r.getByTestId('commercial-claim-loading')).toBeTruthy();
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
    // the list was fetched before a certification landed; the claim read is fresher
    const stale = { ...claim().bill, status: 'verified' as const };
    const fresh = claim(); // status: 'certified'
    useStore.setState({
      commercialBills: [stale],
      commercialBillsLoad: 'ready',
      commercialClaims: { 'bill-1': fresh },
      commercialClaimLoad: { 'bill-1': 'ready' },
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
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'error' },
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
      commercialClaims: { 'bill-1': claim() },
      commercialClaimLoad: { 'bill-1': 'ready' },
    });
    const r = render(<CommercialScreen />);
    fireEvent.click(r.getByTestId('commercial-tab-claims'));
    fireEvent.click(r.getByTestId('commercial-claim-row-bill-1'));
    expect(r.getByTestId('commercial-claim-status-bill-1').textContent).toBe('certified');
  });
});
