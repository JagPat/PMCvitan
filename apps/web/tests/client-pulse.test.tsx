import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Activity, Decision } from '@vitan/shared';
import { clientPulse } from '@/lib/clientPulse';

/**
 * U2a (design review, Client · Pulse board): the client's home — progress, what is being built,
 * the one thing waiting on them, and what happens next. Derived from what the client already holds;
 * no schedule verdict, and no "oldest" claim (decisions carry no reliable waiting-since date).
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const act = (over: Partial<Activity> & Pick<Activity, 'id' | 'name'>): Activity => ({
  zone: 'GF', decisionId: null, phaseId: null, ps: 0, pe: 0, as: null, ae: null, status: 'not-started',
  gm: 'ok', gt: 'ok', gi: 'ok', ...over,
} as Activity);
const dec = (id: string, title: string, options = 2, over: Partial<Decision> = {}): Decision => ({
  id, title, room: 'Kitchen', status: 'pending', deciderKind: 'client',
  options: Array.from({ length: options }, (_, i) => ({ id: `${id}-${String.fromCharCode(65 + i)}` })),
  ...over,
} as unknown as Decision);

const base = { milestonePct: 45, scheduleStartDate: '2026-06-01', scheduleEndDate: '2026-12-31', today: '2026-10-03', activities: [] as Activity[], reapprovals: [] as Decision[], pending: [] as Decision[] };

describe('U2a — clientPulse, the derivation', () => {
  it('counts the week from the schedule\'s own start, and only inside its dates', () => {
    expect(clientPulse(base).week).toEqual({ at: 18, of: 31 });
    expect(clientPulse({ ...base, today: '2026-06-01' }).week).toEqual({ at: 1, of: 31 });
    expect(clientPulse({ ...base, today: '2026-06-07' }).week?.at).toBe(1);
    expect(clientPulse({ ...base, today: '2026-06-08' }).week?.at).toBe(2);
    expect(clientPulse({ ...base, today: '2026-12-31' }).week).toEqual({ at: 31, of: 31 });
    // before the start, after the end, or without both dates: no week is claimed
    expect(clientPulse({ ...base, today: '2026-05-31' }).week).toBeNull();
    expect(clientPulse({ ...base, today: '2027-01-01' }).week).toBeNull();
    expect(clientPulse({ ...base, scheduleEndDate: null }).week).toBeNull();
  });

  it('shows the recorded progress, kept within 0–100', () => {
    expect(clientPulse(base).progressPct).toBe(45);
    expect(clientPulse({ ...base, milestonePct: 130 }).progressPct).toBe(100);
    expect(clientPulse({ ...base, milestonePct: -4 }).progressPct).toBe(0);
  });

  it('the one thing waiting is a reopened decision before a new one, with how many wait', () => {
    const p = clientPulse({ ...base, pending: [dec('D-1', 'Tiles'), dec('D-2', 'Paint')], reapprovals: [dec('D-9', 'Countertop')] });
    expect(p.needs).toMatchObject({ count: 3, reapproval: true });
    expect(p.needs?.first.id).toBe('D-9');
    expect(clientPulse({ ...base, pending: [dec('D-1', 'Tiles')] }).needs).toMatchObject({ count: 1, reapproval: false });
    expect(clientPulse(base).needs).toBeNull();
  });

  it('what happens next: the next three not-started activities by planned start, each with the decision it waits on', () => {
    const activities = [
      act({ id: 'a1', name: 'Tiling', plannedStartDate: '2026-10-12', decisionId: 'D-1' }),
      act({ id: 'a2', name: 'Wiring', plannedStartDate: '2026-10-05' }),
      act({ id: 'a3', name: 'Painting', plannedStartDate: '2026-11-20' }),
      act({ id: 'a4', name: 'Handover', plannedStartDate: '2026-12-15' }),
      act({ id: 'a5', name: 'Old', plannedStartDate: '2026-09-01' }), // planned before today: not "next"
      act({ id: 'a6', name: 'Plastering', status: 'in-progress', plannedStartDate: '2026-10-20' }),
      act({ id: 'a7', name: 'Undated' }), // no planned date: never guessed
    ];
    const p = clientPulse({ ...base, activities, pending: [dec('D-1', 'Kitchen tiles')] });
    expect(p.next).toEqual([
      { id: 'a2', name: 'Wiring', from: '2026-10-05' },
      { id: 'a1', name: 'Tiling', from: '2026-10-12', waitsOn: 'Kitchen tiles' },
      { id: 'a3', name: 'Painting', from: '2026-11-20' },
    ]);
    expect(p.underWay).toEqual(['Plastering']);
  });

  it('a decision already approved is not something an activity waits on', () => {
    const activities = [act({ id: 'a1', name: 'Tiling', plannedStartDate: '2026-10-12', decisionId: 'D-1' })];
    expect(clientPulse({ ...base, activities }).next[0]).not.toHaveProperty('waitsOn');
  });
});

async function loadPulse(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'ambli',
    projectLoadState: 'ready',
    role: 'client',
    lang: 'en',
    short: 'Ambli',
    screen: 'inbox',
    milestonePct: 45,
    scheduleStartDate: null,
    scheduleEndDate: null,
    ...overrides,
  });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return { useStore, r: render(<InboxScreen />) };
}

describe('U2a — the Pulse on the client\'s home', () => {
  it('the client lands on their Pulse; the waiting decision opens their decisions', async () => {
    const { useStore, r } = await loadPulse({ decisions: [dec('D-1', 'Kitchen countertop')] });
    expect(r.getByTestId('client-pulse').textContent).toContain('Ambli, this week');
    expect(r.getByTestId('pulse-progress').getAttribute('aria-label')).toBe('45% done');
    expect(r.getByTestId('pulse-needs').textContent).toContain('One thing needs you');
    expect(r.getByTestId('pulse-needs').textContent).toContain('Kitchen countertop');
    expect(r.getByTestId('pulse-needs-go').textContent).toContain('See the 2 options');
    // the approval cards the Pulse already carries are not repeated below it
    expect(r.queryByTestId('inbox-item-client-pending')).toBeNull();
    fireEvent.click(r.getByTestId('pulse-needs-go'));
    expect(useStore.getState().screen).toBe('client-decisions');
  });

  it('only what this client decides: a decision held by someone else is not theirs', async () => {
    const { r } = await loadPulse({ decisions: [dec('D-1', 'Rebar spec', 2, { deciderKind: 'pmc' })] });
    expect(r.queryByTestId('pulse-needs')).toBeNull();
    expect(r.getByTestId('pulse-nothing').textContent).toContain('Nothing needs you right now');
  });

  it('says nothing it cannot back: no week without the schedule\'s dates, no verdict at all', async () => {
    const { r } = await loadPulse();
    expect(r.queryByTestId('pulse-week')).toBeNull();
    expect(r.getByTestId('client-pulse').textContent).not.toMatch(/on track|watch|at risk|oldest/iu);
  });

  it("speaks the client's language", async () => {
    const { r } = await loadPulse({ lang: 'gu', decisions: [dec('D-1', 'Kitchen countertop'), dec('D-2', 'Paint')] });
    expect(r.getByTestId('client-pulse').textContent).toContain('Ambli, આ અઠવાડિયે');
    expect(r.getByTestId('pulse-needs').textContent).toContain('2 કામ તમારી રાહ જુએ છે');
  });
});
