import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { selectActionItems } from '@/store/selectors';

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

    // …approving the last one empties the client's queue entirely (nothing else is theirs)
    s().openApprove('DL-011', 0);
    s().confirmApprove();
    expect(selectActionItems(s())).toHaveLength(0);
  });

  it('pmc: surfaces the inspection to review, the change request, blocked work and client-pending', () => {
    // default role is pmc
    const k = keys();
    expect(k).toContain('pmc-reviews'); // 1 seeded, undecided review
    expect(k).toContain('pmc-change'); // DL-003 is an open change request
    expect(k).toContain('pmc-blocked'); // 1 seeded blocked activity
    expect(k).toContain('pmc-pending'); // 2 decisions issued, waiting on the client
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
