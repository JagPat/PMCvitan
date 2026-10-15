import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Decision, Lang, ProjectMember, ProjectNode } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 QA item 3 — the Decision Log in Hindi and Gujarati: an engineer with Gujarati chosen saw the menu
 * translated and the Decisions body in English. The register (decisions in every status, the filters and
 * every group-by lens), each row with its edit state, consultation thread and countersign controls, the list
 * awaiting the client, "Withdraw request" and the missing-item boundary show no English. English stays as it
 * was, and the shared components keep English for the screens that do not pass a language.
 * Decision titles and ids, option and material names, people's names, places and typed text are data.
 */

const NODES: ProjectNode[] = [
  { id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'kit', parentId: 'gf', name: 'Kitchen', kind: 'room', order: 0 },
  { id: 'door', parentId: 'kit', name: 'Main Door', kind: 'element', order: 0 },
];
const OPTIONS = [
  { label: 'Option A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true },
  { label: 'Option B', key: 'b', material: 'Quartz', delta: 12000, swatch: 'tile' },
];
const dec = (over: Partial<Decision> & { id: string }): Decision => ({
  title: `Title ${over.id}`, room: '', status: 'pending', deciderKind: 'client', photoSwatch: 'tile', options: OPTIONS, ageDays: 4, approvalCycle: 0,
  ...over,
}) as Decision;
const approvedShape = { approvedOption: 'Option A', material: 'Granite', approver: 'Mr. Shah', date: '03 Jul 2026', cost: 12000 };
const DECISIONS: Decision[] = [
  dec({ id: 'DL-1', title: 'Kitchen Counter', nodeId: 'kit', status: 'approved', ...approvedShape, onBehalfOf: 'client' }),
  dec({ id: 'DL-2', title: 'Tile Colour', nodeId: 'kit', status: 'change', ...approvedShape, changeRequest: { reason: 'Lighter tone', costImpact: 5000, timeImpactDays: 2, requestedById: 'u-me' } }),
  dec({ id: 'DL-3', title: 'Sink', nodeId: 'gf', status: 'awaiting_countersign', ...approvedShape, cost: 0, countersignRequired: true } as Partial<Decision> & { id: string }),
  dec({ id: 'DL-4', title: 'Skirting', nodeId: 'door', status: 'withdrawn', withdrawnBy: 'Ar. Meghna', withdrawnAt: '2026-08-13T10:00:00Z', withdrawReason: 'Wrong room' }),
  dec({
    id: 'DL-5', title: 'Door Finish', nodeId: 'door', status: 'pending',
    consultations: [
      { id: 'c1', consulteeMembershipId: 'm-u-eng', consulteeUserId: 'u-eng', requestedById: 'u-me', question: 'Which lasts', openCycle: 0, requestedAt: '2026-10-01T00:00:00Z', response: { id: 'r1', respondedById: 'u-eng', response: 'Teak lasts', recommendedOptionKey: 'b', respondedAt: '2026-10-02T00:00:00Z' } },
      { id: 'c2', consulteeMembershipId: 'm-u-eng', consulteeUserId: 'u-eng', requestedById: 'u-me', question: 'And the cost', openCycle: 0, requestedAt: '2026-10-03T00:00:00Z' },
    ],
  }),
  dec({ id: 'DL-6', title: 'Crack Note', status: 'recorded', deciderKind: 'none' }),
  dec({ id: 'DL-7', title: 'Basin', nodeId: 'kit', status: 'change', ...approvedShape, changeRequest: { reason: 'Too deep', costImpact: 0, timeImpactDays: 1, origin: 'countersign_rejection' } } as Partial<Decision> & { id: string }),
  dec({ id: 'DL-8', title: 'Lights', status: 'change', deciderKind: 'pmc', ...approvedShape, changeRequest: { reason: 'Warmer', costImpact: 0, timeImpactDays: 0, requestedById: 'u-other' } }),
  dec({ id: 'DL-9', title: 'Paint', status: 'pending', deciderKind: 'architect', ageDays: 1 }),
];
const member = (userId: string, name: string, role: ProjectMember['role']): ProjectMember =>
  ({ userId, membershipId: `m-${userId}`, name, email: null, phone: null, role, status: 'active' }) as ProjectMember;
const MEMBERS = [member('u-me', 'Asha Rao', 'pmc'), member('u-eng', 'Ravi Patel', 'engineer'), member('u-arch', 'Meera Iyer', 'architect')];
const AWAITING = [
  { id: 'AW-1', title: 'Wardrobe Laminate', room: 'Bedroom', nodeId: null, status: 'pending', waitingSince: new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString() },
  { id: 'AW-2', title: 'Bath Tiles', room: '', nodeId: 'kit', status: 'pending', waitingSince: new Date(Date.now() - 86_400_000 - 60_000).toISOString() },
];

// project data, people's names and typed text, and the acronyms sites use as they are
const DATA = [
  'Ground Floor', 'Kitchen', 'Main Door', 'Option A', 'Option B', 'Granite', 'Quartz', 'Mr. Shah', 'Kitchen Counter', 'Tile Colour', 'Sink',
  'Skirting', 'Ar. Meghna', 'Wrong room', 'Door Finish', 'Which lasts', 'Teak lasts', 'And the cost', 'Crack Note', 'Basin', 'Too deep',
  'Lights', 'Warmer', 'Paint', 'Lighter tone', 'Asha Rao', 'Ravi Patel', 'Meera Iyer', 'Wardrobe Laminate', 'Bedroom', 'Bath Tiles',
  'Villa B', 'DL', 'AW', 'PMC',
];

async function load(lang: Lang, over: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', decisionsLoad: 'ready', screen: 'decision-log',
    role: 'pmc', sessionUserId: 'u-me', short: 'Villa B', lang, routeItem: null, phase6_4dRollout: 'open',
    nodes: NODES, decisions: DECISIONS, members: MEMBERS,
    fetchAwaitingClient: () => Promise.resolve(AWAITING), loadTeam: () => Promise.resolve(),
    ...over,
  } as never);
  const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
  return { useStore, r: render(<DecisionLogScreen />) };
}

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe.each(['hi', 'gu'] as const)('the Decision Log in %s (#482 QA item 3)', (lang) => {
  it('the PMC\'s register, in every status and every group-by lens, shows no English', async () => {
    const { r } = await load(lang);
    for (const id of ['DL-1', 'DL-2', 'DL-3', 'DL-4', 'DL-5', 'DL-6', 'DL-7', 'DL-8', 'DL-9']) expect(r.getByTestId(`log-row-${id}`)).toBeTruthy();
    expect(r.getByTestId('withdraw-DL-2')).toBeTruthy();
    expect(r.getByTestId('request-change-DL-1')).toBeTruthy();
    expect(r.getByTestId('consultation-thread-DL-5')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    for (const lens of ['room', 'element', 'status', 'flat', 'location']) {
      fireEvent.click(r.getByTestId(`groupby-${lens}`));
      expect(leftoverEnglish(document.body, DATA), lens).toEqual([]);
    }
  });

  it('the status filters, and a filter that matches nothing, show no English', async () => {
    const { r } = await load(lang, { decisions: DECISIONS.filter((d) => d.status !== 'recorded') });
    fireEvent.click(r.getByTestId('filter-approved'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('filter-approved'));
    fireEvent.click(r.getByTestId('filter-recorded'));
    expect(r.queryAllByTestId(/^log-row-/)).toHaveLength(0);
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the consultation thread\'s ask form shows no English', async () => {
    const { r } = await load(lang);
    fireEvent.click(r.getByTestId('consultation-ask-DL-5'));
    expect(r.getByTestId('consultation-ask-form-DL-5')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the consultee\'s compose box shows no English', async () => {
    const { r } = await load(lang, { role: 'engineer', sessionUserId: 'u-eng' });
    expect(r.getByTestId('consultation-respond-DL-5')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the architect\'s countersign controls and their panels show no English', async () => {
    const { r } = await load(lang, { role: 'architect', sessionUserId: 'u-arch' });
    expect(r.getByTestId('countersign-DL-3')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('forward-on-DL-3'));
    fireEvent.change(r.getByTestId('chain-kind-DL-3'), { target: { value: 'member' } });
    expect(r.getByTestId('chain-member-DL-3')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('chain-cancel-DL-3'));
    fireEvent.click(r.getByTestId('reject-back-DL-3'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('chain-cancel-DL-3'));
    fireEvent.click(r.getByTestId('forward-DL-5'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the PMC\'s stranded countersign resolution shows no English', async () => {
    const stranded = DECISIONS.map((d) => (d.id === 'DL-3' ? { ...d, countersignRequired: undefined } : d));
    const { r } = await load(lang, { decisions: stranded });
    expect(r.getByTestId('stranded-complete-DL-3')).toBeTruthy();
    fireEvent.click(r.getByTestId('stranded-return-DL-3'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    fireEvent.click(r.getByTestId('chain-cancel-DL-3'));
    fireEvent.click(r.getByTestId('stranded-complete-DL-3'));
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('an engineer\'s screen, with the decisions awaiting the client, shows no English', async () => {
    const { r } = await load(lang, { role: 'engineer', sessionUserId: 'u-eng' });
    await waitFor(() => expect(r.getByTestId('awaiting-client-AW-1')).toBeTruthy());
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('the awaiting-client list while it loads, when it is empty and when it fails shows no English', async () => {
    const pending = await load(lang, { role: 'contractor', fetchAwaitingClient: () => new Promise(() => {}) });
    expect(pending.r.getByTestId('awaiting-client')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    cleanup();
    const empty = await load(lang, { role: 'consultant', fetchAwaitingClient: () => Promise.resolve([]) });
    await waitFor(() => expect(empty.r.getByTestId('awaiting-client-empty')).toBeTruthy());
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    cleanup();
    const failed = await load(lang, { role: 'engineer', fetchAwaitingClient: () => Promise.reject(new Error('503')) });
    await waitFor(() => expect(failed.r.getByTestId('awaiting-client-failed')).toBeTruthy());
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('"Withdraw request" on the waiting card, for the requester and for the PMC, shows no English', async () => {
    await load(lang);
    const { WaitingCardActions } = await import('@/components/WaitingCardActions');
    cleanup();
    const mine = render(<WaitingCardActions d={DECISIONS[1]!} lang={lang} />);
    expect(mine.getByTestId('withdraw-DL-2')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    cleanup();
    const others = render(<WaitingCardActions d={DECISIONS[7]!} lang={lang} />);
    expect(others.getByTestId('withdraw-DL-8')).toBeTruthy();
    expect(leftoverEnglish(document.body, DATA)).toEqual([]);
  });

  it('a link to a decision the register does not hold, loading, failed and missing, shows no English', async () => {
    const missing = await load(lang, { routeItem: 'DL-404' });
    expect(missing.r.getByTestId('item-not-found')).toBeTruthy();
    expect(leftoverEnglish(document.body, [...DATA, 'DL-404'])).toEqual([]);
    cleanup();
    await load(lang, { routeItem: 'DL-404', decisionsLoad: 'loading' });
    expect(leftoverEnglish(document.body, [...DATA, 'DL-404'])).toEqual([]);
    cleanup();
    const failed = await load(lang, { routeItem: 'DL-404', decisionsLoad: 'error' });
    expect(failed.r.getByTestId('decisions-unavailable')).toBeTruthy();
    expect(leftoverEnglish(document.body, [...DATA, 'DL-404'])).toEqual([]);
  });
});

describe('the Decision Log in English is unchanged', () => {
  it('keeps its words', async () => {
    const { r } = await load('en');
    expect(r.getByTestId('withdraw-DL-2').textContent).toBe('Withdraw request');
    expect(r.getByTestId('edit-state-DL-2').textContent).toBe('A change request is with the client — the decision reopens when they answer.Withdraw request');
    expect(r.getByTestId('edit-state-DL-1').textContent).toBe('Locked after approval — the approved choice is the record.Request change');
    expect(r.getByTestId('cr-detail-DL-2').textContent).toBe('Change requested: Lighter tone+₹5,000 · 2 days · awaiting the client’s re-approval');
    expect(r.getByTestId('cr-detail-DL-8').textContent).toBe('Change requested: WarmerNo cost change · no schedule impact · awaiting the PMC’s re-approval');
    expect(r.getByTestId('withdraw-detail-DL-4').textContent).toBe('Withdrawn: Wrong room');
    expect(r.getByTestId('log-row-DL-4').textContent).toContain('Withdrawn by Ar. Meghna · 13 Aug 2026');
    expect(r.getByTestId('log-row-DL-1').textContent).toContain('Approved by Mr. Shah (on behalf of the client) · 03 Jul 2026');
    expect(r.getByTestId('log-row-DL-3').textContent).toContain('Approved by Mr. Shah — awaiting the architect’s countersign');
    expect(r.getByTestId('log-row-DL-5').textContent).toContain('Ageing 4 days · awaiting client');
    expect(r.getByTestId('log-row-DL-5').textContent).toContain('2 options presented');
    expect(r.getByTestId('log-row-DL-5').textContent).toContain('up to +₹12,000');
    expect(r.getByTestId('log-row-DL-9').textContent).toContain('Ageing 1 days · awaiting the architect');
    expect(r.getByTestId('log-row-DL-6').textContent).toContain('Issue recorded — no approval required');
    expect(r.getByTestId('consultation-c1').textContent).toBe('Asha Rao asked Ravi Patel: Which lastsRavi Patel: Teak lasts · leans to option B');
    expect(r.getByTestId('consultation-c2').textContent).toBe('Asha Rao asked Ravi Patel: And the costAwaiting their advice');
    expect(r.getByTestId('filter-awaiting_countersign').textContent).toBe('Awaiting countersign');
    expect(r.getByTestId('groupby-element').textContent).toBe('Object');
    expect(r.getByTestId('decision-search').getAttribute('placeholder')).toBe('Search decisions…');
    expect(document.body.textContent).toContain('CLIENT DECISION LOG');
    expect(document.body.textContent).toContain('9 DECISIONS');
    fireEvent.click(r.getByTestId('groupby-status'));
    expect(r.getByTestId('group-head-change').textContent).toContain('Change requested');
    fireEvent.click(r.getByTestId('groupby-room'));
    expect(r.getByTestId('group-head-room:~none').textContent).toContain('No room');
  });

  it('keeps the waiting card\'s words and the awaiting-client list\'s', async () => {
    await load('en');
    const { WaitingCardActions } = await import('@/components/WaitingCardActions');
    cleanup();
    const mine = render(<WaitingCardActions d={DECISIONS[1]!} />);
    expect(mine.getByTestId('edit-state-DL-2').textContent).toBe('You asked for this change. Withdraw it to keep the approved choice.Withdraw request');
    cleanup();
    const { r } = await load('en', { role: 'engineer', sessionUserId: 'u-eng' });
    await waitFor(() => expect(r.getByTestId('awaiting-client-AW-1')).toBeTruthy());
    expect(r.getByTestId('awaiting-client-count').textContent).toBe('2 DECISIONS');
    expect(r.getByTestId('awaiting-client-AW-1').textContent).toContain('Waiting 3 days');
    expect(r.getByTestId('awaiting-client-AW-2').textContent).toContain('Waiting 1 day');
    expect(r.getByTestId('awaiting-client').textContent).toContain('Awaiting client');
  });
});

describe('a shared component given no language stays English for its other callers', () => {
  it('the consultation thread, countersign controls, location and waiting card read English with the store in Hindi', async () => {
    const { useStore } = await load('hi', { role: 'architect', sessionUserId: 'u-arch' });
    const { ConsultationThread } = await import('@/components/ConsultationThread');
    const { CountersignControls } = await import('@/components/CountersignControls');
    const { LocationContext } = await import('@/components/LocationContext');
    const { WaitingCardActions } = await import('@/components/WaitingCardActions');
    cleanup();
    const thread = render(<ConsultationThread decision={DECISIONS[4]!} />);
    expect(thread.getByTestId('consultation-c2').textContent).toContain('Awaiting their advice');
    cleanup();
    const chain = render(<CountersignControls decision={DECISIONS[2]!} />);
    expect(chain.getByTestId('countersign-DL-3').textContent).toBe('Countersign');
    cleanup();
    const place = render(<LocationContext nodeId={null} testId="place" />);
    expect(place.getByTestId('place').textContent).toBe('Not filed to a location');
    cleanup();
    useStore.setState({ role: 'pmc', sessionUserId: 'u-me' } as never);
    const card = render(<WaitingCardActions d={DECISIONS[7]!} />);
    expect(card.getByTestId('withdraw-DL-8').textContent).toBe('Withdraw request');
  });
});
