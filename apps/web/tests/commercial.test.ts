import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { emptyProjectData, emptyModuleReadState } from '@/store/projectScope';
import { enabledScreensFor, SCREEN_CAPABILITY } from '@/lib/screens';
// The store's and sync hook's own source text, via Vite's `?raw` loader — the same mechanism
// `snapshot-ordering.test.ts` and `snapshot-shape.test.ts` already use for their source tripwires.
import { selectActionItems } from '@/store/selectors';
import storeSource from '@/store/store.ts?raw';
import gatewaySource from '@/data/apiGateway.ts?raw';
import syncSource from '@/data/useApiSync.ts?raw';
import contractsSource from '../../api/src/contracts.ts?raw';
import billServiceSource from '../../api/src/commercial/commercial-bill.service.ts?raw';
import type { ApiGateway } from '@/data/apiGateway';
import { budgetCoalesceKey, billCoalesceKey, isBudgetPendingForHead, normalizeCommercialOutbox } from '@/lib/commercialKeys';
import type { CommercialClaimView, CommercialView } from '@/store/commercial';
import type { CashForecastReadDto, CommercialBudgetDto, CostHeadPositionDto, MeasurementRegisterDto } from '@vitan/shared';

/**
 * Phase 5 Task 7B-i (§M) — the pilot COMMERCIAL money-position hub: the capability-gated nav entry
 * and the module-query bundle load with honest states, scope gating and latest-request ownership.
 *
 * READ ONLY. The §M write actions and their two-key outbox lifecycle are 7B-iii's, and there is
 * deliberately nothing here about them.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const position = (over: Partial<CostHeadPositionDto> = {}): CostHeadPositionDto => ({
  costHeadCode: 'CIVIL', costHeadName: 'Civil works',
  budget: '1000.00', budgetVersion: 1,
  committed: '100.00', receivedNotBilled: '0.00', awaitingCertification: '0.00',
  certifiedPayable: '0.00', approved: '0.00', paid: '0.00',
  exposure: '100.00', headroom: '900.00', exception: null,
  ...over,
});

const budgetDto = (positions: CostHeadPositionDto[], openExceptions = 0): CommercialBudgetDto => ({
  positions, openExceptions,
});

const forecast = (over: Partial<CashForecastReadDto['totals']> = {}, refreshedAt: string | null = '2026-08-08T05:00:00.000Z'): CashForecastReadDto => ({
  heads: [],
  totals: {
    budget: '1000.00', committed: '100.00', receivedNotBilled: '0.00', awaitingCertification: '0.00',
    certifiedPayable: '0.00', approved: '0.00', paid: '0.00', exposure: '100.00', headroom: '900.00',
    ...over,
  },
  refreshedAt,
});

const bundle = (over: Partial<CommercialView> = {}): CommercialView => ({
  budget: budgetDto([position()]),
  cashForecast: forecast(),
  costHeads: [],
  attributions: [],
  ...over,
});

describe('Task 7B-i (§D/§M) — the Commercial hub is per-project capability-gated', () => {
  beforeEach(() => useStore.setState(getInitialState()));

  it('is ABSENT from the nav without the `commercial` capability, and present with it', () => {
    useStore.setState({ capabilities: [] });
    expect(enabledScreensFor('pmc', [], []).some((m) => m.key === 'commercial')).toBe(false);
    expect(enabledScreensFor('pmc', [], ['commercial']).some((m) => m.key === 'commercial')).toBe(true);
  });

  it('the three pilot capabilities gate INDEPENDENTLY — one on does not reveal the others', () => {
    const keys = (caps: string[]) => enabledScreensFor('pmc', [], caps).map((m) => m.key);
    expect(keys(['commercial'])).toContain('commercial');
    expect(keys(['commercial'])).not.toContain('materials');
    expect(keys(['commercial'])).not.toContain('labour');
    expect(keys(['materials'])).not.toContain('commercial');
    expect(keys(['labour'])).not.toContain('commercial');
  });

  it('an ENGINEER sees it too — the nav follows `commercial.read`, which is pmc AND engineer', () => {
    // The policy is the single statement of who may read the money; a nav stricter than the policy
    // would be this screen inventing an authority rule the server does not have.
    expect(enabledScreensFor('engineer', [], ['commercial']).some((m) => m.key === 'commercial')).toBe(true);
    expect(enabledScreensFor('client', [], ['commercial']).some((m) => m.key === 'commercial')).toBe(false);
    expect(enabledScreensFor('contractor', [], ['commercial']).some((m) => m.key === 'commercial')).toBe(false);
  });
});

describe('Task 7B-i (§M) — loadCommercial: bundle, honest states, capability gate, latest-request', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });

  // Typed for the same reason as the 7B-ii block below: an untyped stub can promise a shape the
  // real gateway never returns, and then the test agrees with the bug instead of the server.
  const gw = (over: Partial<ApiGateway> = {}): Partial<ApiGateway> => ({
    commercialMoneyPosition: vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle()),
    ...over,
  });

  it('is a NO-OP without the `commercial` capability (inert off-pilot)', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [] });
    void s().loadCommercial();
    await flush();
    expect(g.commercialMoneyPosition).not.toHaveBeenCalled();
    expect(s().commercialView).toBeNull();
    expect(s().commercialLoad).toBe('idle');
  });

  it('fetches the whole bundle on a pilot project and lands `ready`', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();
    await flush();
    // Codex round 2 — ONE request, so the four facts cannot come from four database moments
    expect(g.commercialMoneyPosition).toHaveBeenCalledTimes(1);
    expect(s().commercialLoad).toBe('ready');
    expect(s().commercialView?.budget.positions).toHaveLength(1);
    expect(s().commercialView?.cashForecast.totals.headroom).toBe('900.00');
  });

  it('a failed fetch exposes `error` and KEEPS the last-good bundle (stale, not blank)', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad).toBe('ready');

    s()._setGateway(gw({ commercialMoneyPosition: vi.fn().mockRejectedValue(new Error('offline')) }) as unknown as ApiGateway);
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad).toBe('error');
    // the money already on screen survives — the hub shows it under a stale banner rather than
    // blanking a PMC's page because one refresh failed
    expect(s().commercialView?.budget.positions).toHaveLength(1);
  });

  // ── LATEST-REQUEST OWNERSHIP ────────────────────────────────────────────────────────────────
  //
  // `loadCommercial()` is reachable from the shell, from Retry, from a socket refresh and from a
  // project switch, so two can be in flight at once — and `Promise.all` over FOUR reads makes an
  // older bundle finishing late entirely ordinary.
  //
  // Both probes name WHICH write must be dropped, and both were verified RED against a build with
  // the `seq` token removed from `loadCommercial` (the older bundle overwrote the newer money; the
  // older failure flipped a ready hub to its error boundary).

  it('an OLDER success resolving late never overwrites a NEWER bundle', async () => {
    let releaseOld!: (v: CommercialView) => void;
    const oldBundle = new Promise<CommercialView>((r) => { releaseOld = r; });
    s()._setGateway(gw({ commercialMoneyPosition: vi.fn().mockReturnValue(oldBundle) }) as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial(); // request 1 — in flight, will resolve LAST

    // request 2 supersedes it and lands first, with DIFFERENT money
    s()._setGateway(gw({
      commercialMoneyPosition: vi.fn().mockResolvedValue(bundle({ budget: budgetDto([position({ headroom: '42.00', exposure: '958.00' })]) })),
    }) as unknown as ApiGateway);
    void s().loadCommercial();
    await flush();
    expect(s().commercialView?.budget.positions[0]!.headroom).toBe('42.00');

    releaseOld(bundle({ budget: budgetDto([position({ headroom: '900.00' })]) }));
    await flush();
    expect(
      s().commercialView?.budget.positions[0]!.headroom,
      'the superseded request wrote its stale money over the newer answer',
    ).toBe('42.00');
    expect(s().commercialLoad).toBe('ready');
  });

  it('an OLDER failure resolving late never flips a NEWER ready hub to `error`', async () => {
    let failOld!: (e: Error) => void;
    const oldBundle = new Promise<CommercialView>((_, reject) => { failOld = reject; });
    s()._setGateway(gw({ commercialMoneyPosition: vi.fn().mockReturnValue(oldBundle) }) as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial(); // request 1 — will REJECT last

    s()._setGateway(gw() as unknown as ApiGateway);
    void s().loadCommercial(); // request 2 — succeeds first
    await flush();
    expect(s().commercialLoad).toBe('ready');

    failOld(new Error('offline'));
    await flush();
    expect(
      s().commercialLoad,
      'the superseded request\'s failure flipped a healthy hub to its error boundary',
    ).toBe('ready');
    expect(s().commercialView).not.toBeNull();
  });

  it('a reply for a SUPERSEDED project scope is dropped', async () => {
    let release!: (v: CommercialView) => void;
    const held = new Promise<CommercialView>((r) => { release = r; });
    s()._setGateway(gw({ commercialMoneyPosition: vi.fn().mockReturnValue(held) }) as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();

    // the project scope moves on beneath the in-flight request
    useStore.setState({ projectScopeGeneration: s().projectScopeGeneration + 1 });
    release(bundle({ budget: budgetDto([position({ headroom: '1.00' })]) }));
    await flush();
    expect(s().commercialView, 'another project\'s money landed on this project\'s hub').toBeNull();
  });

  it('a refresh over a READY hub keeps the money on screen AND says a read is in flight', async () => {
    // Codex I2 — this assertion used to read `commercialLoad === 'ready'` during the refresh, and
    // that was the defect written down as an expectation: stale-while-revalidate is a property of
    // the VALUE (don't blank what is on screen), not of the STATUS (don't lie about what the read
    // is doing). Holding the status at 'ready' bought nothing — every consumer already gates
    // blanking on the value — and cost the only signal that distinguishes a figure a completed read
    // just confirmed from one held over from an earlier visit.
    s()._setGateway(gw() as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad).toBe('ready');
    const onScreen = s().commercialView;

    let release!: (v: CommercialView) => void;
    const held = new Promise<CommercialView>((r) => { release = r; });
    s()._setGateway(gw({ commercialMoneyPosition: vi.fn().mockReturnValue(held) }) as unknown as ApiGateway);
    void s().loadCommercial();
    await flush();
    expect(s().commercialView, 'a refresh blanked the money already on screen').toBe(onScreen);
    expect(s().commercialLoad, 'a read was in flight and the status said otherwise').toBe('loading');
    release(bundle());
    await flush();
    expect(s().commercialLoad).toBe('ready');
  });

  // Codex F3 — a RE-ATTRIBUTION supersedes the old row and inserts its successor (§C: there is no
  // "revoke", which would drop a live obligation out of every budget), so the register carries both.
  // Rendering both as current commitments double-counts the line — the head it LEFT and the head it
  // moved TO — which misstates the money position this hub exists to state.
  it('only LIVE attributions are current commitments — superseded history is not double-counted', () => {
    const superseded = {
      id: 'A1', poLineId: 'PL-1', labourPoLineId: null, costHeadCode: 'CIVIL', reason: 'initial',
      createdAt: '2026-08-01T00:00:00.000Z', createdById: 'u1',
      supersededAt: '2026-08-02T00:00:00.000Z', supersededById: 'u1', supersedeReason: 'miscoded',
    };
    const live = { ...superseded, id: 'A2', costHeadCode: 'MEP', reason: 'reclassified', supersededAt: null, supersededById: null, supersedeReason: null };
    const view = bundle({ attributions: [superseded, live] });
    const current = view.attributions.filter((a) => a.supersededAt === null);
    expect(current.map((a) => a.id), 'the superseded row rendered as a current commitment').toEqual(['A2']);
    // and the SAME PO line is counted once, not twice
    expect(new Set(current.map((a) => a.poLineId)).size).toBe(1);
  });

  it('the bundle is PROJECT-OWNED — a scope teardown clears it', () => {
    useStore.setState({ commercialView: bundle(), commercialLoad: 'ready' });
    expect(s().commercialView).not.toBeNull();
    useStore.setState(getInitialState());
    expect(s().commercialView, 'one project\'s money survived into another project\'s hub').toBeNull();
    expect(s().commercialLoad).toBe('idle');
  });
});

/**
 * CLOSURE (Codex round 1, 7B-i) — A CAPABILITY-GATED HUB IS WIRED INTO EVERY INTEGRATION POINT.
 *
 * All three round-1 findings were one shape: the new hub was added to SOME of the places the other
 * two hubs live and not all of them. Realtime refresh was missed (another user's payment left the
 * money stale until someone pressed Refresh), and the shell-failure transition was missed (a cold
 * bookmarked `/commercial` whose shell request fails renders a permanent "loading" with no Retry,
 * because `loadCommercial` is an inert no-op while capabilities are unknown).
 *
 * That is this phase's most-repeated root — a hand-written set standing in for a derived one — and
 * the durable form of the fix is to DERIVE the set. `SCREEN_CAPABILITY` already names every
 * capability-gated hub; this scans the wiring sites and requires each hub's loader at each one.
 * A fourth pilot hub is caught here, at the desk, rather than by a reviewer three findings later.
 *
 * Mutation-tested in both directions: removing any one wiring fails, and the derivation is asserted
 * non-empty and to actually contain the three hubs, so it cannot pass by scanning nothing.
 */
describe('CLOSURE (7B-i) — every capability-gated hub is wired into every integration point', () => {
  /** The loader each capability-gated screen owns, derived from the gate rather than listed. */
  const loaders = Object.entries(SCREEN_CAPABILITY).map(([screen, capability]) => ({
    screen,
    capability: capability!,
    // `materials` → `loadMaterials`, `labour` → `loadLabour`, `commercial` → `loadCommercial`
    loader: `load${capability![0]!.toUpperCase()}${capability!.slice(1)}`,
  }));

  it('the derivation sees every pilot hub (it cannot pass by scanning nothing)', () => {
    expect(loaders.length).toBeGreaterThanOrEqual(3);
    expect(loaders.map((l) => l.loader).sort()).toEqual(['loadCommercial', 'loadLabour', 'loadMaterials']);
  });

  it('each hub refreshes on the realtime `changed` ping — module-query data is never in the snapshot', () => {
    const sync = syncSource;
    for (const { loader, screen } of loaders) {
      expect(
        sync.includes(`${loader}()`),
        `${screen}: useApiSync's refresh does not call ${loader}(). Its bundle is greenfield module-query data — never in ApiSnapshot — so another client's write leaves this hub stale until a manual refresh.`,
      ).toBe(true);
    }
  });

  it('each hub is loaded once the shell REPORTS its capability', () => {
    const store = storeSource;
    for (const { loader, capability, screen } of loaders) {
      expect(
        new RegExp(`capabilities\\.includes\\('${capability}'\\)[\\s\\S]{0,200}${loader}\\(\\)`, 'u').test(store),
        `${screen}: the shell success path does not load ${loader}() when it reports '${capability}'.`,
      ).toBe(true);
    }
  });

  it("each hub's load state flips to `error` when the SHELL fails, so a deep link shows Retry", () => {
    const store = storeSource;
    // the one block that surfaces a swallowed shell failure through the hubs' own states
    const start = store.indexOf('if (s.materialsLoad === ');
    expect(start, 'the shell-failure transition block was not found — this closure would scan nothing').toBeGreaterThan(-1);
    const block = store.slice(start, start + 1200);
    for (const { capability, screen } of loaders) {
      const state = `${capability}Load`;
      expect(
        block.includes(`if (s.${state} === 'idle') s.${state} = 'error';`),
        `${screen}: a failed shell leaves ${state} at 'idle' forever, so the hub renders a permanent "loading" with no Retry — ${capability === 'commercial' ? 'exactly the round-1 finding' : 'the defect this transition exists to prevent'}.`,
      ).toBe(true);
    }
  });
});

/**
 * Codex round 2 — the three findings, each asserted where it actually bites.
 */
describe('Task 7B-i round 2 — staleness, consistency, and the breach a PMC must not miss', () => {
  beforeEach(() => useStore.setState(getInitialState()));

  // F1 is asserted on the API side, where the catalog lives — `commercial.contract.test.ts`
  // pins that `commercial.money_moved` invalidates, because a web test reaching across the
  // workspace into `apps/api` would couple the two packages to make one assertion.

  // F2. Four HTTP reads assemble a page from four database moments. Proven by construction now:
  // the loader makes exactly ONE call, so there is no window to interleave.
  it('F2: the money position is ONE request — four moments cannot be mixed into one page', async () => {
    const g = { commercialMoneyPosition: vi.fn().mockResolvedValue(bundle()) };
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    await s().loadCommercial();
    expect(g.commercialMoneyPosition).toHaveBeenCalledTimes(1);
    // the gateway exposes no per-fact commercial read the hub could accidentally reach for
    for (const gone of ['commercialBudget', 'commercialCashForecast', 'commercialCostHeads', 'commercialAttributions']) {
      expect(
        gatewaySource.includes(`  ${gone}(`),
        `${gone}() is back on the gateway — the money position must come from one snapshot`,
      ).toBe(false);
    }
  });

  // F3. `openExceptions` is documented in the contract as "the Inbox action count (§B)", and the hub
  // was the only place it appeared: a PMC with no other work saw "all caught up" over a live breach.
  it('F3: an over-budget head raises a RED Inbox action naming the worst head', () => {
    useStore.setState({
      role: 'pmc',
      commercialView: bundle({
        budget: budgetDto([
          position({ costHeadCode: 'CIVIL', costHeadName: 'Civil works', headroom: '-50.00' }),
          position({ costHeadCode: 'MEP', costHeadName: 'MEP', headroom: '-500.00' }),
        ], 2),
      }),
    });
    const item = selectActionItems(s()).find((i) => i.key === 'commercial-over-budget');
    expect(item, 'a live over-budget exception is invisible from For You').toBeTruthy();
    expect(item!.title).toContain('2 cost heads over budget');
    expect(item!.detail, 'the item names the WORST head, not merely a count').toContain('MEP');
    expect(item!.detail).toContain('500.00');
    expect(item!.tone, 'a breach has no inbound commitment that resolves it — it is red, not amber').toBe('red');
    expect(item!.screen).toBe('commercial');
  });

  it('F3: no breach, no action — and off-pilot there is no bundle to raise one from', () => {
    useStore.setState({ role: 'pmc', commercialView: bundle({ budget: budgetDto([position()], 0) }) });
    expect(selectActionItems(s()).some((i) => i.key === 'commercial-over-budget')).toBe(false);
    useStore.setState({ role: 'pmc', commercialView: null });
    expect(selectActionItems(s()).some((i) => i.key === 'commercial-over-budget')).toBe(false);
    // and a role without `commercial.read` never sees it even with a bundle in state
    useStore.setState({ role: 'contractor', commercialView: bundle({ budget: budgetDto([position({ headroom: '-1.00' })], 1) }) });
    expect(selectActionItems(s()).some((i) => i.key === 'commercial-over-budget')).toBe(false);
  });
});

// ── Task 7B-ii (§M) — the CLAIM lifecycle reads ────────────────────────────────────────────────

/**
 * A TYPED fixture. The first draft of this was `as any` over invented field names, and the screen
 * compiled against fields `VerificationDto` does not have — the test passed while the component was
 * wrong, which is the whole failure mode a contract type exists to prevent. `pnpm check`'s project
 * build caught it; the fixture is typed so the next mismatch fails here instead.
 */
const register = (over: Partial<MeasurementRegisterDto> = {}): MeasurementRegisterDto => ({
  labourPoLineId: 'LPL-1', rows: [], measured: '0', effort: '10',
  orderedPersonShiftQty: 10, liveAuthorityPersonShiftQty: 10, defaulted: false,
  lineLive: true, certifiedConsumption: [],
  ...over,
});

const claimDto = (over: Partial<CommercialClaimView> = {}): CommercialClaimView => ({
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
  certificate: {
    id: 'cert-1', billId: 'bill-1', versionId: 'ver-1', certifiedAmount: '100.00',
    certifiedAt: '2026-08-21T00:00:00.000Z', certifiedById: 'u-1',
    supersededAt: null, supersededById: null, supersedeReason: null, sodException: null,
    acceptanceConsumption: [], measurementConsumption: [],
  },
  deductions: {
    billId: 'bill-1', certificateId: 'cert-1', certifiedAmount: '100.00', deductions: [],
    withheld: '10.00', netPayable: '90.00', billStatus: 'certified',
    advance: { vendorId: 'v-1', advanced: '0.00', recovered: '0.00', recoverable: '0.00' },
  },
  payments: {
    billId: 'bill-1', certificateId: 'cert-1', approvals: [],
    approved: '0.00', paid: '0.00', approvable: '90.00', billStatus: 'certified',
  },
  measurements: {},
  certifyPreflight: { grantState: 'none', grantId: null, callerActorId: 'u-self' },
  ...over,
});

describe('Task 7B-ii (§M) — the claim list and the per-claim lifecycle', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });

  /**
   * A TYPED gateway stub. `Partial<ApiGateway>` is the whole point: an untyped
   * `vi.fn().mockResolvedValue(...)` let this file mock `commercialBills` as a bare ARRAY while the
   * real route returns the wrapper `VendorBillListDto` — so the mock agreed with the bug instead of
   * the server, the store stashed an object where the screen maps an array, and every test passed.
   * Codex found it (P1). Typed, the compiler refuses a stub whose shape the gateway would never
   * return, which closes the class rather than this one instance.
   */
  const gw = (over: Partial<ApiGateway> = {}): Partial<ApiGateway> => ({
    commercialMoneyPosition: vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle()),
    commercialBills: vi.fn<ApiGateway['commercialBills']>().mockResolvedValue({ bills: [claimDto().bill] }),
    commercialClaim: vi.fn<ApiGateway['commercialClaim']>().mockResolvedValue(claimDto()),
    ...over,
  });
  const pilot = (g: Partial<ApiGateway>) => {
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
  };

  it('both claim reads are INERT off-pilot', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [] });
    void s().loadCommercialBills();
    void s().loadCommercialClaim('bill-1');
    await flush();
    expect(g.commercialBills).not.toHaveBeenCalled();
    expect(g.commercialClaim).not.toHaveBeenCalled();
    expect(s().commercialBillsLoad).toBe('idle');
    expect(s().commercialClaimLoad).toEqual({});
  });

  it('loads the claim list and one claim, and keeps their load states separate', async () => {
    const g = gw();
    pilot(g);
    await s().loadCommercialBills();
    await s().loadCommercialClaim('bill-1');
    expect(s().commercialBills).toHaveLength(1);
    expect(s().commercialBillsLoad).toBe('ready');
    expect(s().commercialClaims['bill-1'].payments.approvable).toBe('90.00');
    expect(s().commercialClaimLoad['bill-1']).toBe('ready');
  });

  it('a failing claim does not poison the list, and vice versa', async () => {
    const g = gw({ commercialClaim: vi.fn().mockRejectedValue(new Error('nope')) });
    pilot(g);
    await s().loadCommercialBills();
    await s().loadCommercialClaim('bill-1');
    expect(s().commercialBillsLoad, 'the list loaded fine and must not inherit the claim failure').toBe('ready');
    expect(s().commercialClaimLoad['bill-1']).toBe('error');
    expect(s().commercialClaims['bill-1']).toBeUndefined();
  });

  it('the per-claim token is PER CLAIM — a slow claim A is not cancelled by opening claim B', async () => {
    let resolveA: (v: unknown) => void = () => {};
    const g = gw({
      commercialClaim: vi.fn().mockImplementation((id: string) => (id === 'bill-A'
        ? new Promise((r) => { resolveA = r; })
        : Promise.resolve(claimDto({ bill: { ...claimDto().bill, id: 'bill-B', vendorBillNumber: 'V-B' } })))),
    });
    pilot(g);

    const a = s().loadCommercialClaim('bill-A');
    await s().loadCommercialClaim('bill-B');
    expect(s().commercialClaimLoad['bill-B']).toBe('ready');

    // A finishes LAST and must still land: nothing newer asked for A. A single shared token would
    // have dropped it here, leaving claim A stuck on 'loading' forever.
    resolveA(claimDto({ bill: { ...claimDto().bill, id: 'bill-A', vendorBillNumber: 'V-A' } }));
    await a;
    expect(s().commercialClaimLoad['bill-A'], 'a slow claim that nothing superseded must still land').toBe('ready');
    expect(s().commercialClaims['bill-A'].bill.vendorBillNumber).toBe('V-A');
  });

  it('an OLDER load of the SAME claim never overwrites a newer one', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    let call = 0;
    const g = gw({
      commercialClaim: vi.fn().mockImplementation(() => {
        call += 1;
        return call === 1
          ? new Promise((r) => { resolveFirst = r; })
          : Promise.resolve(claimDto({ payments: { ...claimDto().payments, approvable: '50.00' } }));
      }),
    });
    pilot(g);

    const first = s().loadCommercialClaim('bill-1');
    await s().loadCommercialClaim('bill-1');
    expect(s().commercialClaims['bill-1'].payments.approvable).toBe('50.00');

    resolveFirst(claimDto()); // the STALE 90.00 answer, arriving late
    await first;
    expect(
      s().commercialClaims['bill-1'].payments.approvable,
      'a slow earlier read overwrote a newer one — the figure an accountant is about to act on',
    ).toBe('50.00');
  });

  it('an older FAILURE never flips a newer success to error', async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    let call = 0;
    const g = gw({
      commercialClaim: vi.fn().mockImplementation(() => {
        call += 1;
        return call === 1 ? new Promise((_r, rej) => { rejectFirst = rej; }) : Promise.resolve(claimDto());
      }),
    });
    pilot(g);
    const first = s().loadCommercialClaim('bill-1');
    await s().loadCommercialClaim('bill-1');
    rejectFirst(new Error('stale'));
    await first;
    expect(s().commercialClaimLoad['bill-1']).toBe('ready');
  });

  it('a project switch tears down the claim list AND every opened claim', async () => {
    const g = gw();
    pilot(g);
    await s().loadCommercialBills();
    await s().loadCommercialClaim('bill-1');
    expect(s().commercialClaims['bill-1']).toBeDefined();

    // a claim id is project-contained: carrying either across a switch renders another site's money
    useStore.setState({ ...emptyProjectData(), ...emptyModuleReadState() });
    expect(s().commercialBills).toBeNull();
    expect(s().commercialClaims).toEqual({});
    expect(s().commercialBillsLoad).toBe('idle');
    expect(s().commercialClaimLoad).toEqual({});
  });

  it('I2: a refresh over a cached claim keeps the lifecycle AND reports the read in flight', async () => {
    let release!: (v: unknown) => void;
    let call = 0;
    const g = gw({
      commercialClaim: vi.fn().mockImplementation(() => {
        call += 1;
        return call === 1 ? Promise.resolve(claimDto()) : new Promise((r) => { release = r; });
      }),
    });
    pilot(g);
    await s().loadCommercialClaim('bill-1');
    expect(s().commercialClaimLoad['bill-1']).toBe('ready');
    const held = s().commercialClaims['bill-1'];

    void s().loadCommercialClaim('bill-1');
    await flush();
    // The VALUE is what stale-while-revalidate protects, and it is untouched…
    expect(s().commercialClaims['bill-1'], 'a refresh blanked a claim page an accountant is reading').toBe(held);
    // …while the STATUS reports what is actually happening. RED before: 'ready' throughout, so an
    // old lifecycle and one a completed current read had just confirmed were indistinguishable.
    expect(s().commercialClaimLoad['bill-1'], 'a read was in flight and the status said `ready`').toBe('loading');

    release(claimDto({ payments: { ...claimDto().payments, approvable: '10.00' } }));
    await flush();
    expect(s().commercialClaimLoad['bill-1']).toBe('ready');
  });

  it('a claim read that resolves after a project switch is DROPPED', async () => {
    let resolve: (v: unknown) => void = () => {};
    const g = gw({ commercialClaim: vi.fn().mockImplementation(() => new Promise((r) => { resolve = r; })) });
    pilot(g);
    const pending = s().loadCommercialClaim('bill-1');
    useStore.setState({ projectScopeGeneration: s().projectScopeGeneration + 1 });
    resolve(claimDto());
    await pending;
    expect(s().commercialClaims['bill-1'], 'another project was on screen by the time this landed').toBeUndefined();
  });

  it('G2/G3: the realtime refresh keys on INTENT and on an opened list, not on results', () => {
    // Codex G2 — the list is refreshed once it has been opened. "A ping is not evidence anyone is
    // looking at it" was true before the tab is opened and false after; a list already on screen
    // silently missed a claim another user recorded until a full page reload.
    expect(syncSource).toContain("commercialBillsLoad !== 'idle'");
    expect(syncSource).toContain('loadCommercialBills()');

    // Codex G3 — the claim refresh set is the UNION of arrived lifecycles and in-flight/failed
    // intent. Keying on `commercialClaims` alone missed a claim whose first read was still in
    // flight: the ping lands before the response, no key exists yet, and the stale response then
    // lands as `ready` with an out-of-date `approvable`.
    expect(syncSource).toContain('commercialClaimLoad');
    expect(syncSource).toContain('loadCommercialClaim(billId)');
    // …and the negative twin over the SAME text: the old results-only key is gone, so this cannot
    // pass while the union is still keyed on the map of arrived claims alone.
    expect(
      syncSource.includes('Object.keys(useStore.getState().commercialClaims)'),
      'the refresh still keys on arrived results only — an in-flight claim misses the invalidation',
    ).toBe(false);
  });

  it('the realtime ping refreshes an OPEN claim, and only the ones already opened', () => {
    // Root B from the 7B-i convergence audit, applied before it bit: becoming a new consumer of the
    // realtime refresh is the signal to re-check what that refresh owes. A payment committed by
    // another client now invalidates (7B-i-a), so the ping fires — and an accountant with a claim
    // open must not be left acting on a stale approvable balance.
    expect(syncSource).toContain('loadCommercialClaim(billId)');
    expect(syncSource).toContain('commercialClaims');
    // The list IS refreshed now, but only once opened — Codex G2 reversed the original judgement
    // and the assertion above it. What stays true is the narrower claim: the refresh is CONDITIONAL,
    // never unconditional, so a ping still does not fetch a tab nobody has opened.
    expect(syncSource).toContain("commercialBillsLoad !== 'idle'");
  });

  it('the claim bundle is ONE request — the six per-bill reads are not assembled client-side', () => {
    // The defect this whole read exists to remove: `approvable` is derived from `netPayable`, so a
    // client stitching six responses can render two figures that were never true together. A
    // gateway method per sub-read would be that stitching, so the tripwire is that they do not exist.
    for (const forbidden of ['commercialVerification(', 'commercialCertificate(', 'commercialDeductions(', 'commercialPayments(']) {
      expect(
        gatewaySource.includes(forbidden),
        `${forbidden} exists — a claim page built from per-part reads can contradict itself`,
      ).toBe(false);
    }
    expect(gatewaySource).toContain('commercial/claims/');
    // …and the positive twin, so this can never pass by scanning nothing.
    expect(storeSource).toContain('gateway.commercialClaim(billId)');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// Task 7B-iii-a (§M) — the WRITE lifecycle.
//
// The three commands are low-stakes on purpose; the LIFECYCLE is the reviewable surface, and it
// is the one Phase-3 Task 7 shipped beside its reads and then needed four corrections for. Each
// probe below names the round that paid for the property it pins.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('Task 7B-iii-a (§M) — the two-key write lifecycle', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.setState({ online: true, activeProjectId: 'p1', sessionToken: 't' });
  });

  const s = () => useStore.getState();
  // Condition-based, never a fixed number of ticks: `flushOutbox` awaits the route call AND a
  // snapshot refetch AND the money reload, so "two microtasks" is a guess that silently measures
  // the wrong moment. (Root E — wait for the state to be true, not for an event to have happened.)
  const settles = (cond: () => boolean) =>
    vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 5 });
  /** A command held open on purpose, and ALWAYS released before the test ends.
   *
   *  `flushOutbox` serializes on a latch that lives in the store CLOSURE, not in the state that
   *  `getInitialState()` resets — so a stub that never settles leaves that latch raised and every
   *  later flush in the module returns "not run". The first draft of these probes did exactly
   *  that and three unrelated tests timed out. Holding a resolvable deferred keeps the in-flight
   *  window observable without stranding the latch. */
  //  Every deferred is registered and released in afterEach, because a test that FAILS before its
  //  own `resolve()` would otherwise leave the latch raised and time out every later test in the
  //  module — turning one real failure into four and making any mutation signal unreadable. A
  //  probe has to be able to fail alone.
  const held: Array<(v: unknown) => void> = [];
  const deferred = () => {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => { resolve = r; });
    held.push(resolve);
    return { promise, resolve };
  };
  afterEach(async () => {
    while (held.length) held.pop()?.({});
    await vi.waitFor(() => { if (useStore.getState().outbox.length > 0) throw new Error('draining'); },
      { timeout: 2000, interval: 5 }).catch(() => { /* a probe may intend a retained op */ });
  });
  // Its OWN base stub rather than another describe's `gw`: a helper reached across scopes is a
  // shared fixture two suites can silently drift apart on, and the write probes need the write
  // methods typed from the gateway contract anyway (root D — derive the fixture, don't retype it).
  const writeGw = (over: Partial<ApiGateway> = {}): Partial<ApiGateway> => ({
    commercialMoneyPosition: vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle()),
    // The M1 reconcile refreshes the claim LIST and every open claim too, not only the money
    // position — so a stub missing them is a fixture that no longer models the gateway. Vitest
    // surfaced it as unhandled errors rather than failures, which is exactly the shape that hides:
    // green tests, a red run. (Root D: derive the fixture from the contract.)
    commercialBills: vi.fn<ApiGateway['commercialBills']>().mockResolvedValue({ bills: [] }),
    commercialClaim: vi.fn<ApiGateway['commercialClaim']>().mockResolvedValue(claimDto()),
    setCommercialBudget: vi.fn<ApiGateway['setCommercialBudget']>().mockResolvedValue(undefined),
    defineCostHead: vi.fn<ApiGateway['defineCostHead']>().mockResolvedValue(undefined),
    reattributeCommitment: vi.fn<ApiGateway['reattributeCommitment']>().mockResolvedValue(undefined),
    // the write ops chase their route JSON with a snapshot refetch (replayOutboxOp), so the
    // flush needs a resolvable one — a rejecting stub makes every op look transient-failed and
    // the probe would be measuring the stub, not the lifecycle.
    snapshot: vi.fn<ApiGateway['snapshot']>().mockResolvedValue({
      project: { id: 'p1', name: 'P', short: 'P', descriptor: '', stage: '', siteCode: 'P', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
      drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    } as never),
    ...over,
  });
  const pilot = (g: Partial<ApiGateway>) => {
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
  };

  it('is INERT off-pilot — no op is queued and nothing is marked pending', async () => {
    const g = writeGw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [] });
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    s().defineCostHead('MEP', 'Mechanical');
    s().reattributeCommitment({ poLineId: 'PL-1' }, 'MEP', 'miscoded');
    await new Promise((r) => setTimeout(r, 0));
    expect(g.setCommercialBudget).not.toHaveBeenCalled();
    expect(s().outbox).toHaveLength(0);
    expect(s().commercialPending).toEqual([]);
  });

  it('the two keys are DIFFERENT things: identity is fresh, coalescing is deterministic', async () => {
    const held = deferred();
    pilot(writeGw({ setCommercialBudget: vi.fn().mockReturnValue(held.promise) }));
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    const first = s().outbox[0] as { idempotencyKey: string; coalesceKey: string };
    expect(first.coalesceKey).toBe('com:budget:CIVIL:100.00');
    expect(first.idempotencyKey).not.toBe(first.coalesceKey);
    expect(s().commercialPending).toEqual(['com:budget:CIVIL:100.00']);

    // PR #208 finding 1 — an EQUIVALENT action while pending is coalesced away (one queued op,
    // one disabled button), NOT queued a second time.
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    expect(s().outbox).toHaveLength(1);
    held.resolve({});
    await settles(() => s().outbox.length === 0);
  });

  it('labour r7: a DIFFERENT amount is a different action, but does not re-enable the button', async () => {
    const held = deferred();
    pilot(writeGw({ setCommercialBudget: vi.fn().mockReturnValue(held.promise) }));
    s().setCommercialBudget('CIVIL', '100.00', 'v1');

    // the KEY carries the amount, so 200 is genuinely a different action…
    expect(budgetCoalesceKey('CIVIL', '200.00')).not.toBe(budgetCoalesceKey('CIVIL', '100.00'));
    // …but the disable TEST is prefix-matched on the head, so editing the input mid-flight does
    // NOT re-arm the button. RED if the screen tested `commercialPending.includes(key(head,amount))`:
    // the user retypes the figure and a second revision is written against the same head.
    expect(
      s().commercialPending.some((k) => isBudgetPendingForHead(k, 'CIVIL')),
      'editing the amount while a set is in flight re-enabled the button',
    ).toBe(true);
    held.resolve({});
    await settles(() => s().outbox.length === 0);
  });

  it('labour r5: the attribution key names the LINE, so a second head for it cannot be queued', async () => {
    const held = deferred();
    pilot(writeGw({ reattributeCommitment: vi.fn().mockReturnValue(held.promise) }));
    s().reattributeCommitment({ poLineId: 'PL-1' }, 'MEP', 'miscoded');
    expect(s().outbox).toHaveLength(1);

    // change of mind while the first is in flight — §C keeps ONE live attribution per line, so
    // this must be coalesced away, not queued. RED with a (line, costHead) key: both queue and
    // one line gets two supersessions.
    s().reattributeCommitment({ poLineId: 'PL-1' }, 'CIVIL', 'actually civil');
    expect(s().outbox, 'two attributions were queued for one line').toHaveLength(1);

    // a DIFFERENT line is untouched by that block
    s().reattributeCommitment({ labourPoLineId: 'LPL-9' }, 'MEP', 'labour line');
    expect(s().outbox).toHaveLength(2);
    held.resolve({});
    await settles(() => s().outbox.length === 0);
  });

  it('PR #208 F4: an UNCERTAIN failure keeps the op AND re-reads the money', async () => {
    const setBudget = vi.fn<ApiGateway['setCommercialBudget']>().mockRejectedValue(new Error('network'));
    const money = vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle());
    pilot(writeGw({ setCommercialBudget: setBudget, commercialMoneyPosition: money }));
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    await settles(() => (money as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    // the server may have committed despite losing the reply, so the money is re-read…
    expect(money, 'an uncertain response left the money position unrefreshed').toHaveBeenCalled();
    // …and the op is RETAINED with its key, so the button stays disabled while it retries
    expect(s().outbox).toHaveLength(1);
    expect(s().commercialPending).toEqual(['com:budget:CIVIL:100.00']);
  });

  it('labour r8: a resolved key clears when the fresh money APPLIES, not in the success gap', async () => {
    const money = vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle());
    pilot(writeGw({ commercialMoneyPosition: money }));
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    await settles(() => s().outbox.length === 0 && s().commercialLoad === 'ready');

    // the op resolved and left the outbox; the key is cleared by loadCommercial's APPLY, which
    // rebuilds the set from the live outbox. RED against a flush that clears keys eagerly
    // (materials' older design): the key would be gone while the PRE-command figure still
    // rendered, re-enabling the button and writing a second revision of the same budget.
    expect(s().outbox).toHaveLength(0);
    expect(s().commercialPending).toEqual([]);
    expect(s().commercialLoad).toBe('ready');
  });

  it('a later legitimate action gets a FRESH idempotency key', async () => {
    const money = vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle());
    pilot(writeGw({ commercialMoneyPosition: money }));
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    const firstKey = (s().outbox[0] as { idempotencyKey: string }).idempotencyKey;
    await settles(() => s().commercialPending.length === 0 && s().outbox.length === 0);

    s().setCommercialBudget('CIVIL', '150.00', 'revised');
    const secondKey = (s().outbox[0] as { idempotencyKey: string }).idempotencyKey;
    expect(secondKey, 'a legitimate second action reused the first attempt identity').not.toBe(firstKey);
  });

  it('hydration is a GUARD: a malformed op is dropped and never becomes `undefined` pending', () => {
    const { ops, changed } = normalizeCommercialOutbox([
      { t: 'setCommercialBudget', idempotencyKey: 'i1', coalesceKey: 'com:budget:CIVIL:100.00' },
      { t: 'setCommercialBudget', idempotencyKey: 'i2' },              // no coalesceKey
      { t: 'defineCostHead', coalesceKey: 'com:head:MEP' },            // no idempotencyKey
      { t: 'checkIn' },                                                // not ours — untouched
    ] as never[]);
    expect(changed).toBe(true);
    expect(ops.map((o: { t: string }) => o.t)).toEqual(['setCommercialBudget', 'checkIn']);
    expect(ops.every((o: { t: string; coalesceKey?: unknown }) => o.t !== 'setCommercialBudget' || typeof o.coalesceKey === 'string')).toBe(true);
  });

  it('the pending set is PROJECT-OWNED — a scope teardown clears it', async () => {
    const held = deferred();
    pilot(writeGw({ setCommercialBudget: vi.fn().mockReturnValue(held.promise) }));
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    expect(s().commercialPending).toHaveLength(1);
    useStore.setState({ ...emptyProjectData(), ...emptyModuleReadState() });
    expect(s().commercialPending, "one project's disabled button survived into another").toEqual([]);
    held.resolve({});
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// Task 7B-iii-b (§D/§F) — the ENGINEER's six writes, on 7B-iii-a's lifecycle.
//
// The lifecycle itself is not re-probed: it is merged and cleared. What is new here is which
// AUTHORITY each action reads, and the §F rule that three verbs share one constrained resource.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe('Task 7B-iii-b (§D/§F) — the engineer\'s writes', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    useStore.setState({ online: true, activeProjectId: 'p1', sessionToken: 't', role: 'engineer' });
  });
  const s = () => useStore.getState();
  const held: Array<(v: unknown) => void> = [];
  const deferred = () => {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => { resolve = r; });
    held.push(resolve);
    return { promise, resolve };
  };
  afterEach(async () => {
    while (held.length) held.pop()?.({});
    await vi.waitFor(() => { if (useStore.getState().outbox.length > 0) throw new Error('draining'); },
      { timeout: 2000, interval: 5 }).catch(() => {});
  });
  const engGw = (over: Partial<ApiGateway> = {}): Partial<ApiGateway> => ({
    commercialBills: vi.fn<ApiGateway['commercialBills']>().mockResolvedValue({ bills: [] }),
    commercialClaim: vi.fn<ApiGateway['commercialClaim']>().mockResolvedValue(claimDto()),
    takeMeasurement: vi.fn<ApiGateway['takeMeasurement']>().mockResolvedValue(undefined),
    submitVendorBill: vi.fn<ApiGateway['submitVendorBill']>().mockResolvedValue(undefined),
    rejectVendorBill: vi.fn<ApiGateway['rejectVendorBill']>().mockResolvedValue(undefined),
    setCommercialBudget: vi.fn<ApiGateway['setCommercialBudget']>().mockResolvedValue(undefined),
    commercialMoneyPosition: vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle()),
    commercialLineRegister: vi.fn<ApiGateway['commercialLineRegister']>().mockResolvedValue(register()),
    snapshot: vi.fn<ApiGateway['snapshot']>().mockResolvedValue({
      project: { id: 'p1', name: 'P', short: 'P', descriptor: '', stage: '', siteCode: 'P', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
      drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    } as never),
    ...over,
  });
  const pilot = (g: Partial<ApiGateway>) => {
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
  };

  it('an ENGINEER may lodge — `commercial.bill` is one of the two permissions admitting the role', () => {
    const held = deferred();
    pilot(engGw({ recordVendorBill: vi.fn().mockReturnValue(held.promise) }));
    s().recordVendorBill({
      vendorId: 'v-1', vendorBillNumber: 'V-3', documentDate: '2026-08-20',
      lines: [{ poLineId: 'PL-1', quantity: '1', rate: '10.00' }],
    });
    expect(s().outbox, 'an engineer was refused a write their role DOES authorise').toHaveLength(1);
    expect(s().commercialPending).toEqual([billCoalesceKey('v-1', 'V-3')]);
  });

  it('…and may NOT set a budget, which is pmc-only', () => {
    pilot(engGw());
    s().setCommercialBudget('CIVIL', '100.00', 'v1');
    expect(s().outbox, 'an engineer queued a pmc-only write').toHaveLength(0);
  });

  it('§F: submit and reject are ONE constrained resource — a pending transition blocks both', async () => {
    const gate = deferred();
    pilot(engGw({ submitVendorBill: vi.fn().mockReturnValue(gate.promise) }));
    s().submitVendorBill('bill-1');
    expect(s().outbox).toHaveLength(1);

    // The interference case, ACTUALLY ATTEMPTED. The first version of this probe only asserted
    // that a pending key existed and never dispatched the second verb, so it passed with the
    // per-verb defect restored — caught by mutation, and it is root L from PR #303 (a suppression
    // probe must exercise the thing that must still be blocked, not merely observe state).
    s().rejectVendorBill('bill-1', 'changed my mind');
    expect(
      s().outbox,
      'a reject queued beside a pending submit for the SAME claim — the server applies whichever '
      + 'lands first and terminally 4xx\'s the other, after the user was told both were saved',
    ).toHaveLength(1);

    // a DIFFERENT claim is untouched by that block
    s().rejectVendorBill('bill-2', 'wrong vendor');
    expect(s().outbox).toHaveLength(2);
    gate.resolve({});
  });

  it('M1: a claim-changing write refreshes the CLAIM, not only the money position', async () => {
    const money = vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle());
    const bills = vi.fn<ApiGateway['commercialBills']>().mockResolvedValue({ bills: [claimDto().bill] });
    const oneClaim = vi.fn<ApiGateway['commercialClaim']>().mockResolvedValue(claimDto());
    pilot(engGw({
      commercialMoneyPosition: money, commercialBills: bills, commercialClaim: oneClaim,
      submitVendorBill: vi.fn<ApiGateway['submitVendorBill']>().mockResolvedValue(undefined),
    }));
    // a claim is open on screen — its STATUS is what the transition changes
    await s().loadCommercialClaim('bill-1');
    bills.mockClear(); oneClaim.mockClear();

    s().submitVendorBill('bill-1');
    await vi.waitFor(() => { if (s().outbox.length > 0) throw new Error('draining'); }, { timeout: 5000, interval: 5 });

    // RED before: the reconcile reloaded ONLY the money position, so `commercialPending` cleared
    // while the claim on screen was still pre-command — and the control it guards was re-enabled
    // over truth that had not moved.
    expect(bills, 'the claim LIST was not refreshed after a claim-changing write').toHaveBeenCalled();
    expect(oneClaim, 'the OPEN claim was not refreshed — its status is what changed').toHaveBeenCalled();
  });

  it('O1: a LODGE key survives a claim-bundle read — the LIST is what carries a new claim', async () => {
    // N1 partitioned the pending set two ways: money keys, and "claim-affecting" keys released by
    // any claim read. Two is one too few. A lodge becomes visible in the claim LIST — which is also
    // the list the lodge form's duplicate guard reads — so releasing it when a claim BUNDLE lands
    // re-enables the button while the guard is still blind, and the second lodge is the server's
    // duplicate-document 409 after the user was told it was saved.
    const slowBills = deferred();
    pilot(engGw({
      recordVendorBill: vi.fn<ApiGateway['recordVendorBill']>().mockResolvedValue(undefined),
      commercialBills: vi.fn().mockReturnValue(slowBills.promise),   // the LIST is SLOW
      commercialClaim: vi.fn<ApiGateway['commercialClaim']>().mockResolvedValue(claimDto()),
    }));
    useStore.setState({ commercialClaimLoad: { 'bill-1': 'ready' } }); // a claim is open

    s().recordVendorBill({
      vendorId: 'v-9', vendorBillNumber: 'B-9', documentDate: '2026-08-20',
      lines: [{ labourPoLineId: 'LPL-1', quantity: '1', rate: '10.00' }],
    });
    // wait on the STAMP, which is written only by a successful claim APPLY. Waiting on
    // `commercialClaimLoad` was satisfied by this test's own setup, so the assertion ran before
    // the read it is about had landed — and the probe passed under a mutation that reintroduces
    // the defect. A probe's synchronisation is part of what it claims.
    await vi.waitFor(() => { if (s().commercialClaims['bill-1'] === undefined) throw new Error('claim not applied'); },
      { timeout: 5000, interval: 5 });

    expect(
      s().commercialPending,
      'the lodge key cleared on a CLAIM read, so the form re-armed while the claim LIST its '
      + 'duplicate guard reads was still pre-command',
    ).toContain(billCoalesceKey('v-9', 'B-9'));

    slowBills.resolve({ bills: [] });
    await vi.waitFor(() => { if (s().commercialPending.length > 0) throw new Error('still held'); },
      { timeout: 5000, interval: 5 });
  });

  it('the labour-charge rule is ONE statement the SERVICE guards with', async () => {
    const { claimLineMayCarryCharges } = await import('@vitan/shared');
    expect(claimLineMayCarryCharges('material')).toBe(true);
    expect(claimLineMayCarryCharges('labour')).toBe(false);
    // The rule that matters is not that the constant exists but that the SERVER reads it. A labour
    // purchase-order snapshot freezes neither tax nor freight; when the labour lodge form lands in
    // its own unit it imports this same function, so the form cannot offer a charge the service
    // rejects without the service changing too. Root M's mechanism, checked mechanically.
    expect(billServiceSource).toContain('claimLineMayCarryCharges(kind)');
    expect(billServiceSource, 'the service restated the rule instead of reading it')
      .not.toMatch(/kind === 'labour' && \(taxAmount/u);
  });

  it('Q-a (gate): a read that could not have observed the write releases nothing', async () => {
    // The whole of the fix, at the layer it lives in. `readClearsKey` is pure, so this is
    // deterministic where a store-level interleaving is not — see the honest note on the probe
    // below about which defence actually closes Codex's scenario today.
    const { readClearsKey } = await import('@/lib/commercialKeys');
    for (const key of ['com:meas:LPL-1:ACT-1', 'com:mcorr:m1:-1']) {
      expect(
        readClearsKey(key, { read: 'lineRegister', labourPoLineId: 'LPL-1', rowIds: ['m1'], observedWrite: false }),
        `${key} was released by a read that started before the write settled`,
      ).toBe(false);
      expect(readClearsKey(key, { read: 'lineRegister', labourPoLineId: 'LPL-1', rowIds: ['m1'], observedWrite: true }))
        .toBe(true);
    }
    // and a read of a DIFFERENT line never releases this line's key, observed or not
    expect(readClearsKey('com:meas:LPL-1:ACT-1',
      { read: 'lineRegister', labourPoLineId: 'LPL-2', rowIds: [], observedWrite: true })).toBe(false);
  });

  it('a superseded register read is dropped whole — value AND key release', async () => {
    // HONEST SCOPE. Codex's Q-a scenario is a pre-write read releasing a key; in the store as it
    // stands, latest-request ownership already closes it, because the reconcile issues its fresh
    // read synchronously after the write settles (no `await` between the two), so any older read
    // has been superseded before its continuation can run. This probe pins THAT defence. The
    // causality gate above is the structural guarantee for the same property — kept because
    // "an incidental ordering makes this unreachable" is a weaker thing to rely on than "a read
    // that cannot have observed the write releases nothing", and a future reconcile change would
    // silently remove the first without touching the second.
    const stale = deferred();
    const post = deferred();
    let calls = 0;
    const lineRead = vi.fn<ApiGateway['commercialLineRegister']>().mockImplementation(() => {
      calls += 1;
      // 1 = the refresh already in flight when the write is queued; 2 = the reconcile's own read,
      // held so that ONLY the stale one has applied at the assertion.
      return (calls === 1 ? stale.promise : post.promise) as Promise<MeasurementRegisterDto>;
    });
    pilot(engGw({ commercialLineRegister: lineRead }));

    // (1) a refresh STARTS — it will resolve with the PRE-write register
    const inFlight = s().loadCommercialLineRegister('LPL-1');
    // (2) the write is queued and settles
    s().takeMeasurement({ labourPoLineId: 'LPL-1', activityId: 'ACT-1', quantity: '2', citedOutputId: 'OUT-1' });
    await vi.waitFor(() => { if (s().outbox.length > 0) throw new Error('draining'); }, { timeout: 5000, interval: 5 });
    await vi.waitFor(() => { if (calls < 2) throw new Error('reconcile has not read yet'); },
      { timeout: 5000, interval: 5 });
    // (3) only NOW does the older read land, and it lands FIRST
    stale.resolve(register({ measured: '0' }));
    await inFlight;

    expect(
      s().commercialPending,
      'a read that could not have observed the write released its key, re-enabling Measure over a '
      + 'pre-command register',
    ).toContain('com:meas:LPL-1:ACT-1');
    expect(s().commercialLineRegisters['LPL-1'], 'the stale VALUE was applied — latest-request '
      + 'ownership should already have dropped it, and the causality gate is the SECOND line of '
      + 'defence for the case where no newer read has started yet').toBeUndefined();

    // the reconcile's own read STARTED after the settle, so it does release
    post.resolve(register({ measured: '2' }));
    await vi.waitFor(() => { if (s().commercialPending.length > 0) throw new Error('still held'); },
      { timeout: 5000, interval: 5 });
    expect(s().commercialLineRegisters['LPL-1']?.measured).toBe('2');
  });

  it('R2-5: a second activity on the SAME line is refused by the dispatcher, not just the screen', () => {
    // The cap belongs to the LINE. Measure the remainder against ACT-1, retarget the form to
    // ACT-2 before the reconcile lands, and the exact-key check sees nothing — both queue against
    // one authority and the server terminally refuses the loser. J1's lesson: the durable layer
    // has to hold it, because an op it accepts has already been reported saved.
    const gate = deferred();
    pilot(engGw({ takeMeasurement: vi.fn().mockReturnValue(gate.promise) }));
    s().takeMeasurement({ labourPoLineId: 'LPL-1', activityId: 'ACT-1', quantity: '5', citedOutputId: 'OUT-1' });
    expect(s().outbox).toHaveLength(1);
    expect(
      Object.values(s().commercialPendingQty).filter((r) => r.lineId === 'LPL-1').map((r) => r.qty),
      'the queued QUANTITY is what the cap subtracts',
    ).toEqual(['5']);

    s().takeMeasurement({ labourPoLineId: 'LPL-1', activityId: 'ACT-2', quantity: '5', citedOutputId: 'OUT-2' });
    expect(s().outbox, 'a second activity queued against a remainder the first already claimed').toHaveLength(1);

    // a DIFFERENT line is untouched — the constrained resource is this line, not measurement itself
    s().takeMeasurement({ labourPoLineId: 'LPL-2', activityId: 'ACT-1', quantity: '1', citedOutputId: 'OUT-3' });
    expect(s().outbox).toHaveLength(2);
    gate.resolve({});
  });

  it('R3-2: a queued POSITIVE correction spends the same line authority as a measurement', () => {
    // RED before: the pending-quantity rebuild recorded only `takeMeasurement`, so a queued +5
    // correction and a queued measurement of 5 both passed against one remaining 5. The server
    // applies one and terminally refuses the other, after the UI reported both saved.
    const gate = deferred();
    pilot(engGw({ correctMeasurement: vi.fn().mockReturnValue(gate.promise) }));
    s().correctMeasurement('m1', '5', 'more work', 'LPL-1');
    expect(s().outbox).toHaveLength(1);
    const reserved = () => Object.values(s().commercialPendingQty)
      .filter((r) => r.lineId === 'LPL-1').map((r) => r.qty);
    expect(reserved(), 'a positive correction spends line authority and was not counted against it')
      .toEqual(['5']);

    // a WITHDRAWAL frees authority rather than spending it, so it is never subtracted
    s().correctMeasurement('m2', '-2', 'miscount', 'LPL-1');
    expect(reserved()).toEqual(['5']);
    gate.resolve({});
  });

  it('R4-1: a reservation lives exactly as long as its key', async () => {
    // RED before: the quantity map was re-derived from the live outbox on EVERY read, so a money
    // read landing after the op left the outbox dropped the reservation while the KEY was still
    // retained — the cap freed authority the screen had not yet been told about.
    const slowLine = deferred();
    pilot(engGw({
      commercialLineRegister: vi.fn().mockReturnValue(slowLine.promise),
      commercialMoneyPosition: vi.fn<ApiGateway['commercialMoneyPosition']>().mockResolvedValue(bundle()),
    }));
    useStore.setState({ commercialLineRegisterLoad: { 'LPL-1': 'ready' } });

    s().takeMeasurement({ labourPoLineId: 'LPL-1', activityId: 'ACT-1', quantity: '5', citedOutputId: 'OUT-1' });
    await vi.waitFor(() => { if (s().commercialLoad !== 'ready') throw new Error('money not applied'); },
      { timeout: 5000, interval: 5 });

    // the money read has applied and the LINE REGISTER has not: the key is held, so its
    // reservation must be too
    expect(s().commercialPending).toContain('com:meas:LPL-1:ACT-1');
    expect(
      Object.values(s().commercialPendingQty).filter((r) => r.lineId === 'LPL-1').map((r) => r.qty),
      'the reservation was dropped while its key was still held, freeing authority on screen',
    ).toEqual(['5']);

    slowLine.resolve(register({ measured: '5' }));
    await vi.waitFor(() => { if (s().commercialPending.length > 0) throw new Error('still held'); },
      { timeout: 5000, interval: 5 });
    expect(s().commercialPendingQty, 'the reservation outlived the key it belongs to').toEqual({});
  });

  it('R5-1: a reservation survives a RELOAD, like the key it belongs to', () => {
    // RED before: hydration rebuilt `commercialPending` from localStorage and not the reservations,
    // so a correction queued offline came back with its button disabled and its authority silently
    // freed — the round-4 lifecycle broken at the one moment it is rebuilt from scratch.
    const gate = deferred();
    pilot(engGw({ correctMeasurement: vi.fn().mockReturnValue(gate.promise) }));
    s().correctMeasurement('m1', '5', 'more work', 'LPL-1');
    expect(s().outbox).toHaveLength(1);
    const key = s().commercialPending[0]!;

    // a RELOAD: a fresh store over the same persisted queue
    const projectId = s().activeProjectId;
    useStore.setState(getInitialState());
    useStore.setState({ activeProjectId: projectId, capabilities: ['commercial'] });
    s().hydrateOutbox();

    expect(s().outbox, 'the durable op did not survive the reload').toHaveLength(1);
    expect(s().commercialPending).toContain(key);
    expect(
      s().commercialPendingQty[key],
      'the key came back and its cap reservation did not, so the reload freed authority the '
      + 'queued write still holds',
    ).toEqual({ lineId: 'LPL-1', qty: '5' });
    gate.resolve({});
  });

  it('R3-3: the realtime `changed` path refreshes open line registers', () => {
    // The caps are computed from the register, and it was the one read nothing refreshed — the
    // money bundle, the claim list and the claims all did.
    expect(syncSource).toContain('loadCommercialLineRegister(lineId)');
    expect(syncSource).toContain('commercialLineRegisters');
  });

  it('the §A value rules are the SHARED ones — no second opinion in the browser', async () => {
    const { isMoneyString, isPositiveQuantity } = await import('@vitan/shared');
    // the exact cases Codex J3 named, now answered by the same function the zod contract uses
    expect(isMoneyString('100.123')).toBe(false);
    expect(isMoneyString('abc')).toBe(false);
    expect(isMoneyString('-5.00')).toBe(false);
    expect(isMoneyString('100.5')).toBe(true);
    // a measurement of zero measures nothing; six decimals are real person-shift precision
    expect(isPositiveQuantity('0')).toBe(false);
    expect(isPositiveQuantity('0.000001')).toBe(true);
    expect(isPositiveQuantity('1.1234567')).toBe(false);
  });

  it('CLOSURE — the money and quantity rules exist ONCE, with no inline copy left behind', () => {
    // J3's fix named `setBudgetSchema` and I stopped there, leaving four copies in the same file.
    // This is the mechanical form of "the rule lives once": the literals must not reappear.
    expect(contractsSource.includes(String.raw`/^\d+(\.\d{1,2})?$/u`), 'an inline money regex is back').toBe(false);
    expect(contractsSource.includes(String.raw`/^\d+(\.\d{1,6})?$/u`), 'an inline quantity regex is back').toBe(false);
    expect(contractsSource).toContain('MONEY_STRING');
    expect(contractsSource).toContain('QUANTITY_STRING');
  });
});
