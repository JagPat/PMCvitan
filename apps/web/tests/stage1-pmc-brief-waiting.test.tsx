import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Decision, PmcBriefProject } from '@vitan/shared';
import { pmcBrief } from '@/lib/pmcBrief';
import { HOME_NAV_CAPABILITY } from '@/lib/homeNav';

/**
 * Stage 1 live check A1 (#482 6227430525) — qa.pmc's For You listed "No site log yet today" under "Do these first"
 * while the Dashboard said "Nothing needs you". The PMC cannot start a site log, and a decision with the client is
 * the client's to make, so on a project whose `home-nav` switch is on those two move out of "Do these first" into
 * "Waiting on the engineer / client" lines, worded as the Dashboard tiles (H3). "Do these first" then names only the
 * PMC's own reviews. The PMC's "N decisions awaiting the client" card stays on the list but no longer counts toward
 * N and the badge, so N cannot say 1 while the brief says nothing waits on the PMC. With the switch off all is as today.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const NOW = Date.parse('2026-10-17T06:00:00Z');
const proj = (id: string, over: Partial<PmcBriefProject> = {}): PmcBriefProject => ({
  projectId: id, name: `Residence ${id}`, short: id, orgName: 'Vitan', today: '2026-10-17', logToday: 'sent',
  reviewsWaiting: 0, waitingOnClient: 0, oldestWaitingSince: null,
  sinceYesterday: { approvals: 0, photos: 0, rejectedInspections: 0 },
  ...over,
});
const mixed = [
  proj('A', { logToday: 'missing' }),
  proj('B', { waitingOnClient: 2, oldestWaitingSince: '2026-10-15T06:00:00Z' }),
  proj('C', { reviewsWaiting: 1 }),
];

describe('pmcBrief with the home-nav switch', () => {
  it('on: only reviews are the PMC\'s to do; logs and client decisions are waiting on others', () => {
    const b = pmcBrief(mixed, NOW, true);
    expect(b.first.map((t) => [t.kind, t.projectId])).toEqual([['reviews', 'C']]);
    expect(b.total).toBe(1);
    expect(b.waiting.map((t) => [t.kind, t.projectId])).toEqual([['client', 'B'], ['log', 'A']]);
  });

  it('off: unchanged — all three ranked in "Do these first", nothing waiting', () => {
    const b = pmcBrief(mixed, NOW);
    expect(b.first.map((t) => t.kind)).toEqual(['client', 'reviews', 'log']);
    expect(b.waiting).toEqual([]);
  });
});

async function loadInbox(lang: 'en' | 'hi' | 'gu', capabilities: string[], projects: PmcBriefProject[]) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  const { countActionItems, selectActionItems } = await import('@/store/selectors');
  useStore.setState(getInitialState());
  const switchProject = vi.fn().mockResolvedValue(true);
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'A',
    projectLoadState: 'ready',
    role: 'pmc',
    lang,
    short: 'A',
    screen: 'inbox',
    switchProject,
    loadBrief: vi.fn(),
    capabilities,
    capabilitiesKnown: true,
    brief: { projects },
    briefAt: Date.now(),
  });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return { useStore, switchProject, badge: countActionItems(selectActionItems(useStore.getState())), r: render(<InboxScreen />) };
}

describe('the PMC\'s For You with the switch on (the qa-test-d135 case)', () => {
  it('a log not sent reads "Waiting on the engineer", and "Do these first" agrees with the Dashboard\'s 0', async () => {
    const { r, badge, switchProject } = await loadInbox('en', [HOME_NAV_CAPABILITY], [proj('A', { logToday: 'missing' }), proj('Z', { logToday: 'open' })]);
    expect(badge).toBe(0); // the Dashboard's "Nothing needs you"
    expect(r.queryByTestId('brief-first')).not.toBeInTheDocument();
    expect(r.getByTestId('brief-clear')).toBeInTheDocument();
    const line = r.getByTestId('brief-waiting-log-A');
    expect(line).toHaveTextContent('A · Waiting on the engineer');
    expect(line).toHaveTextContent('No site log yet today');
    // another project keeps its own label and still opens there
    fireEvent.click(r.getByTestId('brief-waiting-log-Z'));
    expect(switchProject).toHaveBeenCalledWith('Z', 'daily-log');
  });

  it('client-held decisions read "Waiting on the client"', async () => {
    const { r } = await loadInbox('en', [HOME_NAV_CAPABILITY], [proj('A', { waitingOnClient: 1 })]);
    expect(r.getByTestId('brief-waiting-client-A')).toHaveTextContent('Waiting on the client');
    expect(r.queryByTestId('brief-task-client-A')).not.toBeInTheDocument();
  });

  it.each([
    ['hi', 'इंजीनियर की राह', 'आज अभी साइट लॉग नहीं'],
    ['gu', 'ઇજનેરની રાહ', 'આજે હજી સાઇટ લૉગ નથી'],
  ] as const)('in %s, the same words as the Dashboard tiles', async (lang, who, what) => {
    const { r } = await loadInbox(lang, [HOME_NAV_CAPABILITY], [proj('A', { logToday: 'missing' })]);
    expect(r.getByTestId('brief-waiting-log-A')).toHaveTextContent(who);
    expect(r.getByTestId('brief-waiting-log-A')).toHaveTextContent(what);
  });

  it('with the switch off, the log stays in "Do these first" (every real project today)', async () => {
    const { r } = await loadInbox('en', [], [proj('A', { logToday: 'missing' })]);
    expect(r.getByTestId('brief-task-log-A')).toHaveTextContent('No site log yet today');
    expect(r.queryByTestId('brief-waiting')).not.toBeInTheDocument();
  });
});

describe('the "decisions awaiting the client" card with the switch on', () => {
  async function pmcWithClientHeld(capabilities: string[]) {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const sel = await import('@/store/selectors');
    const seed = getInitialState().decisions[0]!;
    const two = ['DL-1', 'DL-2'].map((id): Decision => ({ ...structuredClone(seed), id, draft: false, status: 'pending', deciderKind: 'client' }));
    useStore.setState({ ...getInitialState(), role: 'pmc', sessionUserId: 'u-pmc', decisions: two, reviews: [], activities: [], drawings: [], openChecklists: [], capabilities, capabilitiesKnown: true });
    const items = sel.selectActionItems(useStore.getState());
    return { card: items.find((i) => i.key === 'pmc-pending'), n: sel.countActionItems(items) };
  }

  it('on: the card stays, worded as waiting on the client, and counts 0 toward N and the badge', async () => {
    const { card, n } = await pmcWithClientHeld([HOME_NAV_CAPABILITY]);
    expect(card).toMatchObject({ title: '2 decisions awaiting the client', count: 0 });
    expect(n).toBe(0);
  });

  it('off: unchanged — the card counts each decision', async () => {
    const { card, n } = await pmcWithClientHeld([]);
    expect(card).toMatchObject({ count: 2 });
    expect(n).toBe(2);
  });
});

describe('#482 F-A1.1 (Board 6246214610, Option A) — with the switch on, N counts only what waits on the PMC', () => {
  /** Q4's qa.pmc: one review to do (theirs), a change request with the client, and a re-inspection with the engineer */
  async function q4Pmc(capabilities: string[]) {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const sel = await import('@/store/selectors');
    const init = getInitialState();
    const change: Decision = { ...structuredClone(init.decisions[0]!), id: 'DEC_C2', draft: false, status: 'change', deciderKind: 'client' };
    const review = { ...structuredClone(init.reviews[0]!), id: 'INSP-030', decided: false, submitted: true, reinspectionOfId: undefined };
    const reinspection = {
      id: 'INSP-026', title: 'Re-inspection: QA TEST', zone: 'QA', date: 'today', submitted: false, reinspectionOfId: 'INSP-025',
      items: [{ id: 'r1', name: 'Drain slope', state: null, photos: 0, note: '', evidence: [] }],
    };
    useStore.setState({
      ...init, role: 'pmc', sessionUserId: 'u-pmc', decisions: [change], reviews: [review], activities: [], drawings: [],
      openChecklists: [reinspection], capabilities, capabilitiesKnown: true,
    });
    const items = sel.selectActionItems(useStore.getState());
    return { items, n: sel.countActionItems(items), key: (k: string) => items.find((i) => i.key === k) };
  }

  it('on: N = 1, the review; the change request and the re-inspection stay on the list but count 0', async () => {
    const { n, key } = await q4Pmc([HOME_NAV_CAPABILITY]);
    expect(key('pmc-reviews')).toMatchObject({ count: 1 });
    expect(key('pmc-change')).toMatchObject({ title: '1 change request to resolve', count: 0 });
    expect(key('pmc-reinspections')).toMatchObject({ title: '1 re-inspection with the engineer', count: 0 });
    expect(n).toBe(1);
  });

  it('off: unchanged — every card counts, N = 3 (every real project today)', async () => {
    const { n, key } = await q4Pmc([]);
    expect(key('pmc-change')).toMatchObject({ count: 1 });
    expect(key('pmc-reinspections')).toMatchObject({ count: 1 });
    expect(n).toBe(3);
  });

  it('on: a decision awaiting the architect\'s countersign stays listed but counts 0 (Codex 4306414401); off it counts 1', async () => {
    async function held(capabilities: string[]) {
      vi.resetModules();
      const { useStore, getInitialState } = await import('@/store/store');
      const sel = await import('@/store/selectors');
      const init = getInitialState();
      const d: Decision = { ...structuredClone(init.decisions[0]!), id: 'DL-CS', draft: false, status: 'awaiting_countersign', deciderKind: 'client', countersignRequired: true };
      useStore.setState({ ...init, role: 'pmc', sessionUserId: 'u-pmc', decisions: [d], reviews: [], activities: [], drawings: [], openChecklists: [], capabilities, capabilitiesKnown: true });
      const items = sel.selectActionItems(useStore.getState());
      return { card: items.find((i) => i.key === 'pmc-countersign'), n: sel.countActionItems(items) };
    }
    const on = await held([HOME_NAV_CAPABILITY]);
    expect(on.card).toMatchObject({ title: '1 decision awaiting the architect’s countersign', count: 0 });
    expect(on.n).toBe(0);
    const off = await held([]);
    expect(off.card?.count).toBeUndefined();
    expect(off.n).toBe(1);
  });
});
