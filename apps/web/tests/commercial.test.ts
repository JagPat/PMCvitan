import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { enabledScreensFor } from '@/lib/screens';
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
    commercialBudget: vi.fn().mockResolvedValue(budgetDto([position()])),
    commercialCashForecast: vi.fn().mockResolvedValue(forecast()),
    commercialCostHeads: vi.fn().mockResolvedValue([]),
    commercialAttributions: vi.fn().mockResolvedValue([]),
    ...over,
  });

  it('is a NO-OP without the `commercial` capability (inert off-pilot)', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [] });
    void s().loadCommercial();
    await flush();
    expect(g.commercialBudget).not.toHaveBeenCalled();
    expect(s().commercialView).toBeNull();
    expect(s().commercialLoad).toBe('idle');
  });

  it('fetches the whole bundle on a pilot project and lands `ready`', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();
    await flush();
    expect(g.commercialBudget).toHaveBeenCalledTimes(1);
    expect(g.commercialCashForecast).toHaveBeenCalledTimes(1);
    expect(g.commercialCostHeads).toHaveBeenCalledTimes(1);
    expect(g.commercialAttributions).toHaveBeenCalledTimes(1);
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

    s()._setGateway(gw({ commercialBudget: vi.fn().mockRejectedValue(new Error('offline')) }) as unknown as ApiGateway);
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
    let releaseOld!: (v: CommercialBudgetDto) => void;
    const oldBudget = new Promise<CommercialBudgetDto>((r) => { releaseOld = r; });
    s()._setGateway(gw({ commercialBudget: vi.fn().mockReturnValue(oldBudget) }) as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial(); // request 1 — in flight, will resolve LAST

    // request 2 supersedes it and lands first, with DIFFERENT money
    s()._setGateway(gw({
      commercialBudget: vi.fn().mockResolvedValue(budgetDto([position({ headroom: '42.00', exposure: '958.00' })])),
    }) as unknown as ApiGateway);
    void s().loadCommercial();
    await flush();
    expect(s().commercialView?.budget.positions[0]!.headroom).toBe('42.00');

    releaseOld(budgetDto([position({ headroom: '900.00' })]));
    await flush();
    expect(
      s().commercialView?.budget.positions[0]!.headroom,
      'the superseded request wrote its stale money over the newer answer',
    ).toBe('42.00');
    expect(s().commercialLoad).toBe('ready');
  });

  it('an OLDER failure resolving late never flips a NEWER ready hub to `error`', async () => {
    let failOld!: (e: Error) => void;
    const oldBudget = new Promise<CommercialBudgetDto>((_, reject) => { failOld = reject; });
    s()._setGateway(gw({ commercialBudget: vi.fn().mockReturnValue(oldBudget) }) as unknown as ApiGateway);
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
    let release!: (v: CommercialBudgetDto) => void;
    const held = new Promise<CommercialBudgetDto>((r) => { release = r; });
    s()._setGateway(gw({ commercialBudget: vi.fn().mockReturnValue(held) }) as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();

    // the project scope moves on beneath the in-flight request
    useStore.setState({ projectScopeGeneration: s().projectScopeGeneration + 1 });
    release(budgetDto([position({ headroom: '1.00' })]));
    await flush();
    expect(s().commercialView, 'another project\'s money landed on this project\'s hub').toBeNull();
  });

  it('a refresh over a READY hub is stale-while-revalidate — it never blanks to `loading`', async () => {
    s()._setGateway(gw() as unknown as ApiGateway);
    useStore.setState({ capabilities: ['commercial'] });
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad).toBe('ready');

    let release!: (v: CommercialBudgetDto) => void;
    const held = new Promise<CommercialBudgetDto>((r) => { release = r; });
    s()._setGateway(gw({ commercialBudget: vi.fn().mockReturnValue(held) }) as unknown as ApiGateway);
    void s().loadCommercial();
    await flush();
    expect(s().commercialLoad, 'a refresh blanked the money already on screen').toBe('ready');
    release(budgetDto([position()]));
    await flush();
    expect(s().commercialLoad).toBe('ready');
  });

  it('the bundle is PROJECT-OWNED — a scope teardown clears it', () => {
    useStore.setState({ commercialView: bundle(), commercialLoad: 'ready' });
    expect(s().commercialView).not.toBeNull();
    useStore.setState(getInitialState());
    expect(s().commercialView, 'one project\'s money survived into another project\'s hub').toBeNull();
    expect(s().commercialLoad).toBe('idle');
  });
});
