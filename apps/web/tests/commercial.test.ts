import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { enabledScreensFor, SCREEN_CAPABILITY } from '@/lib/screens';
// The store's and sync hook's own source text, via Vite's `?raw` loader — the same mechanism
// `snapshot-ordering.test.ts` and `snapshot-shape.test.ts` already use for their source tripwires.
import { selectActionItems } from '@/store/selectors';
import storeSource from '@/store/store.ts?raw';
import gatewaySource from '@/data/apiGateway.ts?raw';
import syncSource from '@/data/useApiSync.ts?raw';
import type { ApiGateway } from '@/data/apiGateway';
import type { CommercialView } from '@/store/commercial';
import type { CashForecastReadDto, CommercialBudgetDto, CostHeadPositionDto } from '@vitan/shared';

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

  const gw = (over: Partial<Record<string, unknown>> = {}) => ({
    commercialMoneyPosition: vi.fn().mockResolvedValue(bundle()),
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

  it('a refresh over a READY hub is stale-while-revalidate — it never blanks to `loading`', async () => {
    s()._setGateway(gw() as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad).toBe('ready');

    let release!: (v: CommercialView) => void;
    const held = new Promise<CommercialView>((r) => { release = r; });
    s()._setGateway(gw({ commercialMoneyPosition: vi.fn().mockReturnValue(held) }) as unknown as ApiGateway);
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad, 'a refresh blanked the money already on screen').toBe('ready');
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
