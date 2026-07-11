import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { selectDraftDecisions, selectPending, selectLogDecisions, selectApprovedDecisions } from '@/store/selectors';

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState(getInitialState());
});

describe('draft → publish lifecycle (decisions)', () => {
  it('a draft is private + weightless: in the Drafts workspace, but not the log or pending count', () => {
    const drafts = selectDraftDecisions(s());
    expect(drafts.map((d) => d.id)).toContain('DL-015'); // the seeded work-in-progress draft
    expect(drafts.every((d) => d.draft)).toBe(true);

    // it does NOT show in the shared surfaces
    expect(selectPending(s()).some((d) => d.id === 'DL-015')).toBe(false);
    expect(selectLogDecisions(s()).some((d) => d.id === 'DL-015')).toBe(false);
    // the two seeded published-pending decisions still count
    expect(selectPending(s())).toHaveLength(2);
  });

  it('the client never sees a draft — not in their pending list nor the decision log', () => {
    s().setRole('client');
    expect(selectPending(s()).some((d) => d.id === 'DL-015')).toBe(false);
    expect(selectLogDecisions(s()).some((d) => d.id === 'DL-015')).toBe(false);
  });

  it('publishing a draft makes it live: it leaves Drafts, enters pending + the log, and notifies', () => {
    const notifBefore = s().notifications.length;

    s().publishDecision('DL-015');

    // no longer a draft
    expect(selectDraftDecisions(s()).some((d) => d.id === 'DL-015')).toBe(false);
    // now a normal pending decision the client must act on
    const pending = selectPending(s());
    expect(pending.some((d) => d.id === 'DL-015')).toBe(true);
    expect(pending).toHaveLength(3);
    expect(selectLogDecisions(s()).some((d) => d.id === 'DL-015')).toBe(true);
    // the client is told, exactly once
    expect(s().notifications.length).toBe(notifBefore + 1);
    expect(s().notifications[0].text).toContain('Living Room Feature Wall');
  });

  it('selectApprovedDecisions excludes a draft even if it were marked approved (defensive)', () => {
    // force the impossible-today state to prove the client-facing surfaces can never leak a draft
    useStore.setState((st) => {
      const row = st.decisions.find((d) => d.id === 'DL-015')!;
      row.status = 'approved';
    });
    expect(selectApprovedDecisions(s()).some((d) => d.id === 'DL-015')).toBe(false);
  });

  it('publishing is idempotent-ish: a second publish of the same id is a no-op', () => {
    s().publishDecision('DL-015');
    const notifAfterFirst = s().notifications.length;
    s().publishDecision('DL-015'); // already live — nothing changes
    expect(s().notifications.length).toBe(notifAfterFirst);
  });
});
