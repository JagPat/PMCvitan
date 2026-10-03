import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { countActionItems, selectActionItems, selectDecisionsNeedingViewer } from '@/store/selectors';

const s = () => useStore.getState();
const keys = () => selectActionItems(s()).map((i) => i.key);

beforeEach(() => {
  useStore.setState(getInitialState());
});

describe('selectActionItems — the per-role "For You" action queue', () => {
  it('client: surfaces the decisions awaiting their approval and clears them as they approve', () => {
    s().setRole('client');

    // two seeded pending decisions (DL-014, DL-011) → one action, pointed at their screen
    const item = selectActionItems(s()).find((i) => i.key === 'client-pending')!;
    expect(item).toBeTruthy();
    expect(item.title).toContain('2 decisions');
    expect(item.screen).toBe('client-decisions');
    expect(item.tone).toBe('amber');

    // approving one shrinks the count live…
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(selectActionItems(s()).find((i) => i.key === 'client-pending')!.title).toContain('1 decision');

    // …approving the last pending one clears the approval item. What remains is the
    // seeded reopened decision (DL-003): mandatory re-approval IS the client's work
    // now (Phase 1 Task 2), so the queue holds exactly that item.
    s().openApprove('DL-011', 0);
    s().confirmApprove();
    expect(keys()).toEqual(['client-reapprove']);
  });

  it('pmc: surfaces the inspection to review, the change request, blocked work and client-pending', () => {
    // default role is pmc
    const k = keys();
    expect(k).toContain('pmc-reviews'); // 1 seeded, undecided review
    expect(k).toContain('pmc-change'); // DL-003 is an open change request
    expect(k).toContain('pmc-blocked'); // 1 seeded blocked activity
    expect(k).toContain('pmc-pending'); // 2 decisions issued, waiting on the client
  });

  it('pmc as DECIDER (4b round-3 Codex F1): a pmc-held decision is the PMC’s OWN approval task; the management summaries cover only other deciders', () => {
    // default role is pmc — re-point the seeded pending DL-014 and the reopened DL-003 at the PMC
    useStore.setState({
      decisions: s().decisions.map((d) =>
        d.id === 'DL-014' || d.id === 'DL-003' ? { ...d, deciderKind: 'pmc' as const } : d),
    });
    const items = selectActionItems(s());
    // the PMC's own decider queue: the pending approval and the re-approval, at the approval surface
    const mine = items.find((i) => i.key === 'decider-pending')!;
    expect(mine).toBeTruthy();
    expect(mine.title).toContain('1 decision');
    expect(mine.title).toContain('awaiting your approval');
    expect(mine.screen).toBe('client-decisions');
    expect(items.map((i) => i.key)).toContain('decider-reapprove');
    // the management summaries shrink to the OTHER-held rows: DL-011 stays with the client,
    // and the pmc-held change request is the PMC's re-approval, not a row "to resolve"
    const summary = items.find((i) => i.key === 'pmc-pending')!;
    expect(summary.title).toContain('1 decision');
    expect(summary.title).toContain('awaiting the client');
    expect(items.map((i) => i.key)).not.toContain('pmc-change');

    // a non-client other-held decision is never described as "awaiting the client"
    useStore.setState({
      decisions: s().decisions.map((d) =>
        d.id === 'DL-011' ? { ...d, deciderKind: 'member' as const, deciderUserId: 'u-eng' } : d),
    });
    const mixed = selectActionItems(s()).find((i) => i.key === 'pmc-pending')!;
    expect(mixed.title).toContain('awaiting its decider');
  });

  it('engineer & contractor: surface the drawings to acknowledge (all 3 seeded sheets are unacked)', () => {
    s().setRole('engineer');
    const eng = selectActionItems(s()).find((i) => i.key === 'eng-ack')!;
    expect(eng).toBeTruthy();
    expect(eng.title).toContain('3 drawings');
    expect(eng.screen).toBe('drawings');

    s().setRole('contractor');
    const con = selectActionItems(s()).find((i) => i.key === 'con-ack')!;
    expect(con).toBeTruthy();
    expect(con.title).toContain('3 drawings');
    expect(con.screen).toBe('drawings');
  });

  it('consultant (demo persona → structural): points at their discipline’s issued set', () => {
    s().setRole('consultant');
    const item = selectActionItems(s()).find((i) => i.key === 'cons-review')!;
    expect(item).toBeTruthy();
    expect(item.title).toContain('structural'); // the demo persona falls back to structural
    expect(item.screen).toBe('drawings');
  });
});

describe('For You counts (audit B1/B2)', () => {
  it('pmc: an approved inspection leaves the queue at once — decided reviews are not "awaiting your review"', () => {
    expect(keys()).toContain('pmc-reviews');
    s().approveInspection();
    expect(s().reviews.every((r) => r.decided)).toBe(true);
    expect(keys()).not.toContain('pmc-reviews');
  });

  it('pmc: the item names and counts only the undecided reviews', () => {
    const [first] = s().reviews;
    useStore.setState({
      reviews: [{ ...first, decided: true }, { ...first, id: 'INSP-99', title: 'Second check', decided: false }],
    });
    const item = selectActionItems(s()).find((i) => i.key === 'pmc-reviews')!;
    expect(item.title).toBe('1 inspection awaiting your review');
    expect(item.detail).toBe('Second check');
  });

  it('client: the For You count equals the decisions waiting on them (pending + re-approval), not the number of cards', () => {
    s().setRole('client');
    const waiting = selectDecisionsNeedingViewer(s());
    // seeded: DL-003 reopened first, then DL-014 and DL-011
    expect(waiting.map((d) => d.id)).toEqual(['DL-003', 'DL-014', 'DL-011']);
    const items = selectActionItems(s());
    expect(items).toHaveLength(2); // one pending card, one re-approval card…
    expect(countActionItems(items)).toBe(3); // …standing for three decisions
  });

  it('a viewer who decides nothing has nothing waiting on them', () => {
    s().setRole('consultant');
    expect(selectDecisionsNeedingViewer(s())).toEqual([]);
  });

  it('an item without a count still counts once', () => {
    expect(countActionItems([{ key: 'k', title: 't', screen: 'inbox', cta: 'c', tone: 'ink' }])).toBe(1);
  });
});
