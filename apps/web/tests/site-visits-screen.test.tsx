import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { refreshSiteVisits, uuidV4, VISIT_PAGE, withQueued } from '@/lib/useSiteVisits';
import type { ApiGateway, ApiSnapshot, OutboxOp, SiteVisit } from '@/data/apiGateway';
import { leftoverEnglish } from './leftover-english';

/**
 * Site Visits SV1-c (#792, QA item 6): the screen reads every visit for every member, and offers only the acts
 * the server allows the viewer (`siteVisit.*` in ROLE_POLICY, and only the visitor edits their own visit, in the
 * role they started it in). An act answers with the whole visit, which replaces the row; a refusal says so; a
 * lost response keeps the act's key for the retry; a reply for a project the viewer has left is dropped.
 */

const PMC = 'u-pmc';
const CONSULTANT = 'u-cons';

const NODES: ProjectNode[] = [
  { id: 'n-gf', parentId: null, name: 'Ground floor', kind: 'zone', order: 0 },
  { id: 'n-kit', parentId: 'n-gf', name: 'Kitchen', kind: 'room', order: 0 },
];
const MEMBERS = [
  { userId: PMC, name: 'Priya Shah', role: 'pmc', email: null, phone: null, status: 'active' },
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
  { userId: 'u-eng', name: 'Ramesh Patel', role: 'engineer', email: null, phone: null, status: 'active' },
] as ProjectMember[];

function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v-1', visitorId: CONSULTANT, visitorName: 'Kiran Rao', visitorRole: 'consultant', status: 'open',
    startedAt: '2026-10-14T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [],
    ...over,
  };
}

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };

function fakeGateway(list: SiteVisit[], over: Fake = {}): Fake {
  return {
    // the open read lists every open visit; the page read lists the newest
    listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' ? list.filter((v) => v.status === 'open') : list)),
    startSiteVisit: vi.fn(async (input: { id: string; nodeId?: string }) => visit({ id: input.id, visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc', startPlace: input.nodeId ? { nodeId: input.nodeId, name: 'Kitchen' } : null })),
    ...over,
  };
}

async function mount(role: Role, me: string, gw: Fake, lang: Lang = 'en', members: ProjectMember[] = MEMBERS, loadTeam: () => Promise<boolean> = async () => true) {
  useStore.setState({ ...getInitialState(), role, lang, sessionUserId: me, nodes: NODES, members, loadTeam });
  // the outbox tells the screen a replayed act's answer for the gateway's project
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(gw as unknown as ApiGateway);
  const view = render(<SiteVisitsScreen />);
  await act(async () => {});
  return view;
}

afterEach(() => {
  cleanup();
  useStore.getState()._setGateway(null);
});

describe('Site Visits screen', () => {
  it('lists every visit for a client, with its places and people, and offers no act', async () => {
    const v = visit({
      status: 'ended', endedAt: '2026-10-14T05:30:00.000Z',
      places: [
        { id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null },
        { id: 'p-2', nodeId: 'n-gf', name: 'Ground floor', addedAt: '2026-10-14T04:41:00.000Z', addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: '2026-10-14T04:42:00.000Z' },
      ],
      attendees: [{ id: 'a-1', kind: 'guest', userId: null, role: null, name: 'Mr Mehta', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null }],
    });
    await mount('client', 'u-client', fakeGateway([v]));
    const card = screen.getByTestId('sv-visit-v-1');
    expect(card.textContent).toContain('Kiran Rao');
    expect(card.textContent).toContain('Ended');
    expect(card.textContent).toContain('Kitchen');
    expect(card.textContent).toContain('Ground floor · removed');
    expect(card.textContent).toContain('Mr Mehta · Guest');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByTestId('sv-start')).toBeNull();
  });

  it.each(['engineer', 'contractor'] as Role[])('offers a %s no act', async (role) => {
    await mount(role, 'u-x', fakeGateway([visit()]));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('lets a PMC start a visit at a chosen place, with one key and one device-minted id', async () => {
    const gw = fakeGateway([]);
    await mount('pmc', PMC, gw);
    expect(screen.getByText('No site visits yet.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Starting place (optional)'), { target: { value: 'n-kit' } });
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    expect(gw.startSiteVisit).toHaveBeenCalledTimes(1);
    const [body, key] = gw.startSiteVisit!.mock.calls[0];
    expect(body).toMatchObject({ nodeId: 'n-kit' });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof key).toBe('string');
    // the new visit is the viewer's own open visit: no second start, and its edit controls show
    expect(screen.queryByTestId('sv-start')).toBeNull();
    expect(screen.getByRole('button', { name: 'End visit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close visit' })).toBeNull();
  });

  it('draws the starting place as a normal one-line select (live check after #874)', async () => {
    await mount('pmc', PMC, fakeGateway([]));
    const select = screen.getByLabelText('Starting place (optional)') as HTMLSelectElement;
    expect(select.multiple).toBe(false);
    expect(select.size).toBe(0);
    // it sits straight in the card, a column: there a flex basis is a height, so .field must not carry one
    const css = (await import('node:fs')).readFileSync('src/screens/SiteVisitsScreen.module.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (sel: string) => css.match(new RegExp(`(^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[2] ?? '';
    expect(block('.field')).toMatch(/height:\s*44px/);
    expect(block('.field')).not.toMatch(/(^|[\s;])flex(-basis|-grow)?\s*:/);
    expect(block('.card')).toMatch(/flex-direction:\s*column/);
    expect(block('.add .field')).toMatch(/flex:\s*1 1 180px/);
  });

  it('saves the phone’s location when it shares one, and starts without it when the prompt goes unanswered', async () => {
    const geo = { getCurrentPosition: vi.fn((ok: PositionCallback) => ok({ coords: { latitude: 23.03, longitude: 72.5, accuracy: 12 }, timestamp: Date.parse('2026-10-14T04:30:00Z') } as GeolocationPosition)) };
    vi.stubGlobal('navigator', { ...navigator, geolocation: geo });
    const gw = fakeGateway([]);
    await mount('pmc', PMC, gw);
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    expect(gw.startSiteVisit!.mock.calls[0][0].location).toEqual({ lat: 23.03, lng: 72.5, accuracyM: 12, at: '2026-10-14T04:30:00.000Z' });
    cleanup();

    // a permission prompt nobody answers never calls back; the start goes without a location after the wait
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition: vi.fn() } });
    const gw2 = fakeGateway([]);
    await mount('pmc', PMC, gw2);
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    expect(gw2.startSiteVisit).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(5000); });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(gw2.startSiteVisit).toHaveBeenCalledTimes(1);
    expect(gw2.startSiteVisit!.mock.calls[0][0].location).toBeUndefined();
  });

  it('lets the visitor add a place, a member and a guest, remove one, and end the visit', async () => {
    const v = visit();
    const withPlace = visit({ places: [{ id: 'p-9', nodeId: 'n-kit', name: 'Kitchen', addedAt: v.startedAt, addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null }] });
    const gw = fakeGateway([v], {
      addSiteVisitPlace: vi.fn().mockResolvedValue(withPlace),
      addSiteVisitAttendee: vi.fn().mockResolvedValue(withPlace),
      retireSiteVisitPlace: vi.fn().mockResolvedValue({ ...withPlace, places: [{ ...withPlace.places[0], retiredAt: v.startedAt }] }),
      endSiteVisit: vi.fn().mockResolvedValue(visit({ status: 'ended', endedAt: v.startedAt })),
    });
    await mount('consultant', CONSULTANT, gw);
    const card = screen.getByTestId('sv-visit-v-1');

    fireEvent.change(within(card).getByLabelText('Choose a place'), { target: { value: 'n-kit' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add place' })); });
    expect(gw.addSiteVisitPlace).toHaveBeenCalledWith('v-1', expect.objectContaining({ nodeId: 'n-kit' }), expect.any(String));
    expect(within(card).getByText('Kitchen')).toBeTruthy();
    // a standing place is not offered again, and the visitor is not offered as their own attendee
    expect(within(within(card).getByLabelText('Choose a place')).queryByText('Ground floor › Kitchen')).toBeNull();
    expect(within(within(card).getByLabelText('Choose a team member')).queryByText(/Kiran Rao/)).toBeNull();

    fireEvent.change(within(card).getByLabelText('Choose a team member'), { target: { value: 'u-eng:engineer' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add member' })); });
    expect(gw.addSiteVisitAttendee).toHaveBeenLastCalledWith('v-1', expect.objectContaining({ userId: 'u-eng', role: 'engineer' }), expect.any(String));

    fireEvent.change(within(card).getByLabelText('Guest’s name'), { target: { value: '  Mr Mehta ' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add guest' })); });
    expect(gw.addSiteVisitAttendee).toHaveBeenLastCalledWith('v-1', expect.objectContaining({ guestName: 'Mr Mehta' }), expect.any(String));

    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Remove: Kitchen' })); });
    expect(gw.retireSiteVisitPlace).toHaveBeenCalledWith('v-1', 'p-9', expect.any(String));
    expect(card.textContent).toContain('Kitchen · removed');

    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'End visit' })); });
    expect(gw.endSiteVisit).toHaveBeenCalledWith('v-1', expect.any(String), expect.any(String));
    expect(card.textContent).toContain('Ended');
  });

  it('offers a PMC Close on someone else’s open visit, with a reason, and no edits', async () => {
    const gw = fakeGateway([visit()], { closeSiteVisit: vi.fn().mockResolvedValue(visit({ status: 'closed', closeReason: 'Left open' })) });
    await mount('pmc', PMC, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    expect(within(card).queryByRole('button', { name: 'End visit' })).toBeNull();
    expect(within(card).queryByLabelText('Choose a place')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Close visit' }));
    const confirm = within(card).getByRole('button', { name: 'Close it' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText('Why are you closing it?'), { target: { value: 'Left open' } });
    await act(async () => { fireEvent.click(confirm); });
    expect(gw.closeSiteVisit).toHaveBeenCalledWith('v-1', 'Left open', expect.any(String));
    expect(card.textContent).toContain('Closed by the project manager: Left open');
  });

  it('keeps an act whose answer never came, shows it as waiting, and sends the same act again (F53)', async () => {
    const startSiteVisit = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementation(async (input: { id: string }) => visit({ id: input.id, visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc' }));
    await mount('pmc', PMC, fakeGateway([], { startSiteVisit }));
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    // kept in the durable outbox, shown at once as the viewer's own open visit, waiting to send
    expect(useStore.getState().outbox).toHaveLength(1);
    const id = startSiteVisit.mock.calls[0][0].id;
    expect(screen.getByTestId(`sv-visit-${id}`).textContent).toContain('On site now · waiting to send');
    expect(screen.getByTestId('sv-waiting').textContent).toContain('Changes waiting to send: 1');
    expect(screen.queryByTestId('sv-start')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    const [[b1, k1], [b2, k2]] = startSiteVisit.mock.calls;
    // the same act: its key and its whole first body, time included (Codex 4274234568)
    expect(k2).toBe(k1);
    expect(b2).toEqual(b1);
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(screen.queryByTestId('sv-waiting')).toBeNull();
    expect(screen.getByTestId(`sv-visit-${id}`).textContent).not.toContain('waiting to send');
  });

  it('says what the server refused in its own words, and takes the refused act off the screen', async () => {
    const refused = Object.assign(new Error('403'), { status: 403, serverMessage: 'Your role on this project has changed; sign in again' });
    const startSiteVisit = vi.fn().mockRejectedValue(refused);
    await mount('pmc', PMC, fakeGateway([], { startSiteVisit }));
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    expect(screen.getByRole('alert').textContent).toBe('This was not saved. Your role on this project has changed; sign in again');
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(screen.queryAllByTestId(/^sv-visit-/)).toHaveLength(0);
    // the next press is a new act
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const [[b1, k1], [b2, k2]] = startSiteVisit.mock.calls;
    expect(k2).not.toBe(k1);
    expect(b2.id).not.toBe(b1.id);
  });

  it('drops a reply for a project the viewer has left', async () => {
    let answer!: (v: SiteVisit) => void;
    const endSiteVisit = vi.fn().mockImplementationOnce(() => new Promise<SiteVisit>((r) => { answer = r; })).mockResolvedValue(visit({ status: 'ended' }));
    const gw = fakeGateway([visit()], { endSiteVisit });
    await mount('consultant', CONSULTANT, gw);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'End visit' })); });
    gw.listSiteVisits!.mockResolvedValue([]);
    // another sign-in: it brings its own queue (hydrateOutbox), so only the old flush's late answer is left
    await act(async () => { useStore.setState((s) => ({ projectScopeGeneration: s.projectScopeGeneration + 1, outbox: [] })); });
    await act(async () => { answer(visit({ status: 'ended' })); });
    expect(screen.queryByTestId('sv-visit-v-1')).toBeNull();
    expect(screen.getByText('No site visits yet.')).toBeTruthy();
  });

  it('takes no late answer from an earlier sign-in over the visit this one reads (Codex 4278754326)', async () => {
    let answer!: (v: SiteVisit) => void;
    const endSiteVisit = vi.fn().mockImplementationOnce(() => new Promise<SiteVisit>((r) => { answer = r; }));
    const gw = fakeGateway([visit()], { endSiteVisit });
    await mount('consultant', CONSULTANT, gw);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'End visit' })); });
    // a new sign-in on the same project, with its own queue, reads the visit as still open
    await act(async () => { useStore.setState((s) => ({ projectScopeGeneration: s.projectScopeGeneration + 1, outbox: [] })); });
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('On site now');
    await act(async () => { answer(visit({ status: 'ended', endedAt: '2026-10-14T06:00:00.000Z' })); });
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('On site now');
    expect(screen.getByTestId('sv-visit-v-1').textContent).not.toContain('Ended');
  });

  it('shows the answer of an act kept across a reload that lands before the first read (Codex 4278754321)', async () => {
    const held: ((rows: SiteVisit[]) => void)[] = [];
    const ended = visit({ status: 'ended', endedAt: '2026-10-14T06:00:00.000Z' });
    const gw = fakeGateway([], {
      endSiteVisit: vi.fn(async () => ended),
      // the first read (a page and the open list) answers late, with the visit still open; later reads see it ended
      listSiteVisits: vi.fn((q?: { status?: string }) => (held.length < 2
        ? new Promise<SiteVisit[]>((r) => { held.push(r); })
        : Promise.resolve(q?.status === 'open' ? [] : [ended]))),
    });
    useStore.setState({ ...getInitialState(), role: 'consultant', lang: 'en', sessionUserId: CONSULTANT, nodes: NODES, members: MEMBERS, loadTeam: async () => true });
    (gw as { project?: string }).project = useStore.getState().activeProjectId;
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    // the End made before the reload, read back from this phone's storage
    useStore.setState({ outbox: [{ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T06:00:00.000Z', idempotencyKey: 'k-end' }] });
    render(<SiteVisitsScreen />);
    await act(async () => {});
    expect(gw.endSiteVisit).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox).toHaveLength(0);
    await act(async () => { held.forEach((r) => r([visit()])); });
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('Ended');
  });

  it('shows no buttons and says so with no server', async () => {
    useStore.setState({ ...getInitialState(), role: 'pmc', lang: 'en' });
    useStore.getState()._setGateway(null);
    render(<SiteVisitsScreen />);
    expect(screen.getByText('Site visits need the server.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it.each(['hi', 'gu'] as Lang[])('shows no English in %s, with every control on', async (lang) => {
    const v = visit({
      location: { kind: 'device', lat: 23, lng: 72, accuracyM: 300, at: '2026-10-14T04:30:00.000Z', approximate: true },
      places: [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: false, addedAfterEnd: true, retiredAt: '2026-10-14T04:42:00.000Z' }],
      attendees: [{ id: 'a-1', kind: 'member', userId: 'u-eng', role: 'engineer', name: 'Ramesh Patel', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null }],
    });
    const { container } = await mount('consultant', CONSULTANT, fakeGateway([v, visit({ id: 'v-2', status: 'closed', closeReason: 'Left open', lateEndedAt: '2026-10-14T06:00:00.000Z' })]), lang);
    expect(leftoverEnglish(container, ['Kiran Rao', 'Ramesh Patel', 'Priya Shah', 'Kitchen', 'Ground floor', 'Left open', 'PMC'])).toEqual([]);
  });
  it('keeps the key and the body after a passing server fault, and drops the act on a definite refusal (Codex 4274234578)', async () => {
    const fault = Object.assign(new Error('503'), { status: 503 });
    const refused = Object.assign(new Error('409'), { status: 409, serverMessage: 'This site visit was closed by the PMC and takes no more changes' });
    const addSiteVisitAttendee = vi.fn().mockRejectedValueOnce(fault).mockRejectedValueOnce(refused).mockResolvedValue(visit());
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { addSiteVisitAttendee }));
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Guest’s name'), { target: { value: 'Mr Mehta' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add guest' })); });
    expect(card.textContent).toContain('Mr Mehta · Guest · waiting to send');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(screen.getByRole('alert').textContent).toBe('This was not saved. This site visit was closed by the PMC and takes no more changes');
    expect(card.textContent).not.toContain('Mr Mehta');
    fireEvent.change(within(card).getByLabelText('Guest’s name'), { target: { value: 'Mr Mehta' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add guest' })); });
    const [[, b1, k1], [, b2, k2], [, b3, k3]] = addSiteVisitAttendee.mock.calls;
    expect(k2).toBe(k1);
    expect(b2).toEqual(b1);
    expect(k3).not.toBe(k2);
    expect(b3.id).not.toBe(b2.id);
  });

  it('never sends a start whose location wait outlives the project it was pressed in (Codex 4274234657)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition: vi.fn() } });
    const gw = fakeGateway([]);
    await mount('pmc', PMC, gw);
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    await act(async () => { useStore.setState((s) => ({ projectScopeGeneration: s.projectScopeGeneration + 1 })); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(gw.startSiteVisit).not.toHaveBeenCalled();
  });

  it('mints a version 4 UUID for each row even where the browser has no randomUUID (Codex 4274234621)', async () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => globalThis.Array.from(b, (_, i) => (b[i] = (i * 37) % 256)) && b });
    expect(uuidV4()).toMatch(uuid);
    vi.stubGlobal('crypto', undefined);
    expect(uuidV4()).toMatch(uuid);
    const gw = fakeGateway([]);
    await mount('pmc', PMC, gw);
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    vi.unstubAllGlobals();
    expect(gw.startSiteVisit!.mock.calls[0][0].id).toMatch(uuid);
  });

  it('knows the viewer’s own open visit even when it is older than the first page (Codex 4274234592)', async () => {
    const newer = Array.from({ length: VISIT_PAGE }, (_, i) => visit({ id: `v-new-${i}`, status: 'ended', startedAt: `2026-10-14T0${i % 10}:00:00.000Z` }));
    const mine = visit({ id: 'v-mine', visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc', startedAt: '2026-10-01T04:30:00.000Z' });
    const listSiteVisits = vi.fn(async (q?: { status?: string }) => (q?.status === 'open' ? [mine] : newer));
    await mount('pmc', PMC, fakeGateway([], { listSiteVisits }));
    expect(screen.queryByTestId('sv-start')).toBeNull();
    const cards = screen.getAllByTestId(/^sv-visit-/);
    expect(cards[0].getAttribute('data-testid')).toBe('sv-visit-v-mine');
    expect(within(cards[0]).getByRole('button', { name: 'End visit' })).toBeTruthy();
  });

  it('reads the visits again when the server says the project changed (Codex 4274234605)', async () => {
    const gw = fakeGateway([visit()]);
    await mount('client', 'u-client', gw);
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('On site now');
    const closed = visit({ status: 'closed', closedAt: '2026-10-14T09:00:00.000Z', closeReason: 'Left open' });
    gw.listSiteVisits!.mockImplementation(async (q?: { status?: string }) => (q?.status === 'open' ? [] : [closed]));
    await act(async () => { refreshSiteVisits(); });
    const card = screen.getByTestId('sv-visit-v-1');
    expect(card.textContent).toContain('Closed');
    // a closed visit says when it was closed, not only why (Codex 4274234615)
    expect(card.textContent).toContain('Closed 14 Oct, 14:30');
  });

  it('offers only active members, and a retry when the team could not be read (Codex 4274234633, 4274234646)', async () => {
    const invited = { userId: 'u-inv', name: 'Neha Joshi', role: 'engineer', email: null, phone: null, status: 'invited' } as ProjectMember;
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'en', [...MEMBERS, invited]);
    const picker = within(screen.getByTestId('sv-visit-v-1')).getByLabelText('Choose a team member');
    expect(within(picker).queryByText(/Neha Joshi/)).toBeNull();
    expect(within(picker).getByText(/Ramesh Patel/)).toBeTruthy();
    cleanup();

    const loadTeam = vi.fn().mockResolvedValueOnce(false).mockImplementation(async () => { useStore.setState({ members: MEMBERS }); return true; });
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'en', [], loadTeam);
    expect(loadTeam).toHaveBeenCalledTimes(1);
    const card = screen.getByTestId('sv-visit-v-1');
    expect(card.textContent).toContain('Could not load the team.');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Try again' })); });
    expect(loadTeam).toHaveBeenCalledTimes(2);
    expect(card.textContent).not.toContain('Could not load the team.');
    expect(within(within(card).getByLabelText('Choose a team member')).getByText(/Ramesh Patel/)).toBeTruthy();
  });
  it('offers Start once the open visits are read or the read has failed, not while it is out (Codex 4275589690, 4278908034)', async () => {
    const listSiteVisits = vi.fn(() => new Promise<SiteVisit[]>(() => {}));
    await mount('pmc', PMC, fakeGateway([], { listSiteVisits }));
    expect(screen.queryByTestId('sv-start')).toBeNull();
    cleanup();
    // a failed read (no signal) still lets the visitor start: a start refused for an open visit is moved onto it (F53)
    await mount('pmc', PMC, fakeGateway([], { listSiteVisits: vi.fn().mockRejectedValue(new Error('network')) }));
    expect(screen.getByTestId('sv-start')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('reads every open visit, past the open read’s page ceiling (Codex 4275589710)', async () => {
    const others = Array.from({ length: 200 }, (_, i) => visit({ id: `v-o-${i}`, visitorId: `u-${i}`, startedAt: `2026-10-14T04:${String(i % 60).padStart(2, '0')}:00.000Z` }));
    const mine = visit({ id: 'v-mine', visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc', startedAt: '2026-10-01T04:30:00.000Z' });
    const listSiteVisits = vi.fn(async (q?: { status?: string; before?: string }) => {
      if (q?.status !== 'open') return [];
      return q.before === undefined ? others : q.before === 'v-o-199' ? [mine] : [];
    });
    await mount('pmc', PMC, fakeGateway([], { listSiteVisits }));
    expect(listSiteVisits).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', before: 'v-o-199' }));
    expect(screen.queryByTestId('sv-start')).toBeNull();
    expect(within(screen.getByTestId('sv-visit-v-mine')).getByRole('button', { name: 'End visit' })).toBeTruthy();
  });

  it('never lets an older read overwrite a newer act or read (Codex 4275589722)', async () => {
    const gw = fakeGateway([visit()], { endSiteVisit: vi.fn().mockResolvedValue(visit({ status: 'ended', endedAt: '2026-10-14T05:30:00.000Z' })) });
    await mount('consultant', CONSULTANT, gw);
    // a refresh that read the visit as open before the End landed answers only after it
    let late!: () => void;
    gw.listSiteVisits!.mockImplementation((q?: { status?: string }) => new Promise<SiteVisit[]>((r) => {
      const prev = late;
      late = () => { prev?.(); r(q?.status === 'open' ? [visit()] : [visit()]); };
    }));
    await act(async () => { refreshSiteVisits(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'End visit' })); });
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('Ended');
    await act(async () => { late(); });
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('Ended');
    expect(screen.queryByRole('button', { name: 'End visit' })).toBeNull();
  });

  it('reads the team again when the server says the project changed, even with one already loaded (Codex 4275589729)', async () => {
    const loadTeam = vi.fn(async () => true);
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'en', MEMBERS, loadTeam);
    expect(loadTeam).toHaveBeenCalledTimes(1);
    loadTeam.mockImplementation(async () => { useStore.setState({ members: MEMBERS.filter((m) => m.userId !== 'u-eng') }); return true; });
    await act(async () => { refreshSiteVisits(); });
    expect(loadTeam).toHaveBeenCalledTimes(2);
    const picker = within(screen.getByTestId('sv-visit-v-1')).getByLabelText('Choose a team member');
    expect(within(picker).queryByText(/Ramesh Patel/)).toBeNull();
  });

  it('shows a queued add once when a read already shows it, and sends it under its first key (Codex 4275589736)', async () => {
    const addSiteVisitAttendee = vi.fn().mockRejectedValueOnce(new Error('network'));
    const gw = fakeGateway([visit()], { addSiteVisitAttendee });
    await mount('consultant', CONSULTANT, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Guest’s name'), { target: { value: 'Mr Mehta' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add guest' })); });
    const [, b1, k1] = addSiteVisitAttendee.mock.calls[0];
    // the add committed though its answer was lost: the next read shows it, and it is not shown twice
    const guest = { id: b1.id, kind: 'guest' as const, userId: null, role: null, name: 'Mr Mehta', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null };
    gw.listSiteVisits!.mockImplementation(async () => [visit({ attendees: [guest] })]);
    addSiteVisitAttendee.mockResolvedValue(visit({ attendees: [guest] }));
    await act(async () => { refreshSiteVisits(); });
    // the ping also sent the queued add again, under its first key and body, and the server replayed it
    const [, b2, k2] = addSiteVisitAttendee.mock.calls[1];
    expect(k2).toBe(k1);
    expect(b2).toEqual(b1);
    expect(card.textContent?.match(/Mr Mehta/g)).toHaveLength(1);
    expect(card.textContent).not.toContain('waiting to send');
  });

  it('reads the older pages already shown again when the server says the project changed (Codex 4275589742)', async () => {
    const newer = Array.from({ length: VISIT_PAGE }, (_, i) => visit({ id: `v-new-${i}`, status: 'ended', startedAt: `2026-10-14T0${9 - (i % 10)}:${String(59 - i).padStart(2, '0')}:00.000Z` }));
    let old = visit({ id: 'v-old', status: 'ended', startedAt: '2026-10-01T04:30:00.000Z' });
    const listSiteVisits = vi.fn(async (q?: { status?: string; before?: string }) => {
      if (q?.status === 'open') return [];
      return q?.before === undefined ? newer : q.before === `v-new-${VISIT_PAGE - 1}` ? [old] : [];
    });
    await mount('client', 'u-client', fakeGateway([], { listSiteVisits }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show older visits' })); });
    expect(screen.getByTestId('sv-visit-v-old').textContent).not.toContain('Kitchen');
    old = visit({ ...old, places: [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-01T05:00:00.000Z', addedTimeAdjusted: false, addedAfterEnd: true, retiredAt: null }] });
    await act(async () => { refreshSiteVisits(); });
    expect(screen.getByTestId('sv-visit-v-old').textContent).toContain('Kitchen');
  });
  describe('acts made with no signal (unit 2, F53)', () => {
    const lost = () => new Error('network');
    // the phone's signal: while it is down, every act fails as a lost request
    const net = { down: true };
    const signal = <A extends unknown[], R>(f: (...a: A) => R) => vi.fn(async (...a: A) => { if (net.down) throw lost(); return f(...a); });
    afterEach(() => { net.down = true; });
    const own = (over: Partial<SiteVisit> = {}) => visit({ visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc', ...over });

    it('moves the places, people and End of a start refused for an open visit onto that visit', async () => {
    const already = own({ id: 'v-open', startedAt: '2026-10-14T03:00:00.000Z' });
    const conflict = Object.assign(new Error('409'), { status: 409, serverMessage: 'You already have a site visit open on this project; end it first' });
    const startSiteVisit = signal((_body: { id: string }): SiteVisit => { throw conflict; });
    const addSiteVisitPlace = signal(() => already);
    const endSiteVisit = signal((): SiteVisit => ({ ...already, status: 'ended', endedAt: '2026-10-14T06:00:00.000Z' }));
    const gw = fakeGateway([], { startSiteVisit, addSiteVisitPlace, endSiteVisit });
    await mount('pmc', PMC, gw);
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const queuedId = startSiteVisit.mock.calls[0][0].id;
    const card = screen.getByTestId(`sv-visit-${queuedId}`);
    fireEvent.change(within(card).getByLabelText('Choose a place'), { target: { value: 'n-kit' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add place' })); });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'End visit' })); });
    expect(useStore.getState().outbox).toHaveLength(3);
    // back online: the visit opened on another device earlier is the one the server knows
    net.down = false;
    gw.listSiteVisits!.mockImplementation(async () => [already]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(addSiteVisitPlace).toHaveBeenCalledWith('v-open', expect.objectContaining({ nodeId: 'n-kit' }), expect.any(String));
    expect(endSiteVisit).toHaveBeenCalledWith('v-open', expect.any(String), expect.any(String));
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('You already had a visit open');
    expect(screen.queryByRole('alert')).toBeNull();
  });

    it('offers Start when the first read fails for want of signal, and queues it (Codex 4278908034)', async () => {
    const startSiteVisit = signal((body: { id: string }) => own({ id: body.id }));
    const gw = fakeGateway([], { startSiteVisit, listSiteVisits: signal((): SiteVisit[] => []) });
    await mount('pmc', PMC, gw);
    expect(screen.getByText(/could not/i)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const id = startSiteVisit.mock.calls[0][0].id;
    expect(screen.getByTestId(`sv-visit-${id}`).textContent).toContain('waiting to send');
    // the queued visit is the viewer's own open visit: no second start
    expect(screen.queryByTestId('sv-start')).toBeNull();
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitStart']);
  });

    it('keeps a start refused for an open visit that is gone by the lookup, and sends it again with its acts (Codex 4278681348)', async () => {
    const conflict = Object.assign(new Error('409'), { status: 409, serverMessage: 'You already have a site visit open on this project; end it first' });
    let refuse = true;
    const startSiteVisit = signal((body: { id: string }): SiteVisit => { if (refuse) throw conflict; return own({ id: body.id }); });
    const addSiteVisitAttendee = signal(() => visit());
    // another device ended the open visit after the refusal: the open read finds none
    await mount('pmc', PMC, fakeGateway([], { startSiteVisit, addSiteVisitAttendee }));
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const id = startSiteVisit.mock.calls[0][0].id;
    const card = screen.getByTestId(`sv-visit-${id}`);
    fireEvent.change(within(card).getByLabelText('Guest’s name'), { target: { value: 'Mr Mehta' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add guest' })); });
    net.down = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitStart', 'siteVisitAddAttendee']);
    expect(screen.queryByRole('alert')).toBeNull();
    // next time the same start, under the same key, goes, and its guest after it
    refuse = false;
    addSiteVisitAttendee.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(startSiteVisit.mock.calls.at(-1)).toEqual(startSiteVisit.mock.calls[0]);
    expect(addSiteVisitAttendee).toHaveBeenCalledWith(id, expect.objectContaining({ guestName: 'Mr Mehta' }), expect.any(String));
    expect(useStore.getState().outbox).toHaveLength(0);
  });

    it('shows the answers of acts moved onto the open visit before a read shows that visit (Codex 4278681356)', async () => {
    const already = own({ id: 'v-open', startedAt: '2026-10-14T03:00:00.000Z' });
    const conflict = Object.assign(new Error('409'), { status: 409, serverMessage: 'You already have a site visit open on this project; end it first' });
    const startSiteVisit = signal((_body: { id: string }): SiteVisit => { throw conflict; });
    const endSiteVisit = signal((): SiteVisit => ({ ...already, status: 'ended', endedAt: '2026-10-14T06:00:00.000Z' }));
    const gw = fakeGateway([], { startSiteVisit, endSiteVisit });
    await mount('pmc', PMC, gw);
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const card = screen.getByTestId(`sv-visit-${startSiteVisit.mock.calls[0][0].id}`);
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'End visit' })); });
    net.down = false;
    // the outbox's lookup finds the open visit; the screen's own reads have not answered yet
    gw.listSiteVisits!.mockImplementationOnce(async () => [already]).mockImplementation(() => new Promise(() => {}));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(endSiteVisit).toHaveBeenCalledWith('v-open', expect.any(String), expect.any(String));
    expect(screen.getByTestId('sv-visit-v-open').textContent).toContain('Ended');
  });

    it('takes the queued acts of a start refused for any other reason with it, and says why once', async () => {
    const refused = Object.assign(new Error('400'), { status: 400, serverMessage: 'That place is not a published place on this project' });
    const startSiteVisit = signal((_body: { id: string }): SiteVisit => { throw refused; });
    const addSiteVisitAttendee = signal(() => visit());
    await mount('pmc', PMC, fakeGateway([], { startSiteVisit, addSiteVisitAttendee }));
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const card = screen.getByTestId(`sv-visit-${startSiteVisit.mock.calls[0][0].id}`);
    fireEvent.change(within(card).getByLabelText('Guest’s name'), { target: { value: 'Mr Mehta' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add guest' })); });
    net.down = false;
    addSiteVisitAttendee.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(addSiteVisitAttendee).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('This was not saved. That place is not a published place on this project');
  });

    it('sends a remove only after the add it removes', async () => {
    const order: string[] = [];
    const addSiteVisitPlace = signal((_v: string, body: { id: string }) => { order.push(`add:${body.id}`); return visit(); });
    const retireSiteVisitPlace = signal((_v: string, id: string) => { order.push(`retire:${id}`); return visit(); });
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { addSiteVisitPlace, retireSiteVisitPlace }));
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.change(within(card).getByLabelText('Choose a place'), { target: { value: 'n-kit' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Add place' })); });
    expect(card.textContent).toContain('Ground floor › Kitchen · waiting to send');
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Remove: Ground floor › Kitchen' })); });
    // the remove went into the queue behind its add, not ahead of it
    expect(useStore.getState().outbox.map((o) => o.t)).toEqual(['siteVisitAddPlace', 'siteVisitRetirePlace']);
    net.down = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    const id = addSiteVisitPlace.mock.calls[0][1].id;
    expect(order).toEqual([`add:${id}`, `retire:${id}`]);
  });

    it('keeps queued acts across a reload, and sends them when the browser comes back online', async () => {
    const endSiteVisit = vi.fn().mockRejectedValueOnce(lost()).mockResolvedValue(visit({ status: 'ended', endedAt: '2026-10-14T06:00:00.000Z' }));
    await mount('consultant', CONSULTANT, fakeGateway([visit()], { endSiteVisit }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'End visit' })); });
    const [op] = useStore.getState().outbox;
    // a reload reads the queue back from this phone's storage
    useStore.setState({ outbox: [] });
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toEqual([op]);
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('Ended · waiting to send');
    await act(async () => { globalThis.dispatchEvent(new Event('online')); });
    expect(endSiteVisit).toHaveBeenCalledTimes(2);
    expect(endSiteVisit.mock.calls[1]).toEqual(endSiteVisit.mock.calls[0]);
    expect(useStore.getState().outbox).toHaveLength(0);
  });
  });

  it('marks a time the server set in place of the one claimed (Codex 4278522397)', async () => {
    const v = visit({
      startTimeAdjusted: true, status: 'ended', endedAt: '2026-10-14T05:30:00.000Z', endTimeAdjusted: true,
      places: [{ id: 'p-1', nodeId: 'n-kit', name: 'Kitchen', addedAt: '2026-10-14T04:40:00.000Z', addedTimeAdjusted: true, addedAfterEnd: false, retiredAt: null }],
    });
    await mount('client', 'u-client', fakeGateway([v]));
    const text = screen.getByTestId('sv-visit-v-1').textContent ?? '';
    expect(text).toContain('Started 14 Oct, 10:00 (time set by the server)');
    expect(text).toContain('Ended 14 Oct, 11:00 (time set by the server)');
    expect(text).toContain('Kitchen (time set by the server)');
  });

  it('does not offer a person already on the visit in another role (Codex 4275767032)', async () => {
    const v = visit({ attendees: [{ id: 'a-1', kind: 'member', userId: 'u-eng', role: 'engineer', name: 'Ramesh Patel', addedAt: '2026-10-14T04:45:00.000Z', retiredAt: null }] });
    const reroled = MEMBERS.map((m) => (m.userId === 'u-eng' ? { ...m, role: 'contractor' } : m)) as ProjectMember[];
    await mount('consultant', CONSULTANT, fakeGateway([v]), 'en', reroled);
    const picker = within(screen.getByTestId('sv-visit-v-1')).getByLabelText('Choose a team member');
    expect(within(picker).queryByText(/Ramesh Patel/)).toBeNull();
  });

  it('offers a retry when a team read fails with a team already on hand (Codex 4275767047)', async () => {
    const loadTeam = vi.fn(async () => true);
    await mount('consultant', CONSULTANT, fakeGateway([visit()]), 'en', MEMBERS, loadTeam);
    loadTeam.mockResolvedValue(false);
    await act(async () => { refreshSiteVisits(); });
    expect(screen.getByTestId('sv-visit-v-1').textContent).toContain('Could not load the team.');
  });

  it('takes the close form away once the visit is no longer open (Codex 4275767057)', async () => {
    const gw = fakeGateway([visit()]);
    await mount('pmc', PMC, gw);
    const card = screen.getByTestId('sv-visit-v-1');
    fireEvent.click(within(card).getByRole('button', { name: 'Close visit' }));
    expect(within(card).getByLabelText('Why are you closing it?')).toBeTruthy();
    gw.listSiteVisits!.mockImplementation(async (q?: { status?: string }) => (q?.status === 'open' ? [] : [visit({ status: 'ended', endedAt: '2026-10-14T05:30:00.000Z' })]));
    await act(async () => { refreshSiteVisits(); });
    expect(within(card).queryByLabelText('Why are you closing it?')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Close it' })).toBeNull();
  });

  it('offers Try again when a refresh fails after it overtook the first read (Codex 4278522389)', async () => {
    let first!: () => void;
    const listSiteVisits = vi.fn()
      .mockImplementationOnce(() => new Promise<SiteVisit[]>((r) => { first = () => r([visit()]); }))
      .mockImplementationOnce(async () => [visit()])
      .mockRejectedValue(new Error('network'));
    await mount('pmc', PMC, fakeGateway([], { listSiteVisits }));
    await act(async () => { refreshSiteVisits(); });
    await act(async () => { first(); });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('queued acts drawn as the server will read them', () => {
  const start = (accuracyM: number) => ({
    t: 'siteVisitStart' as const, idempotencyKey: 'k', visitor: { name: 'Priya Shah', role: 'pmc', placeName: null },
    body: { id: 'v-new', claimedAt: '2026-10-14T04:30:00.000Z', location: { lat: 23, lng: 72, accuracyM, at: '2026-10-14T04:30:00.000Z' } },
  });

  it('marks a coarse queued location approximate, as the server will (Codex 4278681374)', () => {
    const loc = (m: number) => withQueued([], [start(m)], PMC).visits[0].location;
    expect(loc(250)).toMatchObject({ kind: 'device', approximate: true });
    expect(loc(100)).toMatchObject({ kind: 'device', approximate: false });
  });

  it('marks a place queued on an ended visit as added after the end (Codex 4278681369)', () => {
    const add = (v: SiteVisit) => withQueued([v], [{
      t: 'siteVisitAddPlace', visitId: 'v-1', idempotencyKey: 'k', name: 'Kitchen', body: { id: 'p-new', nodeId: 'n-kit', claimedAt: '2026-10-14T05:00:00.000Z' },
    }], CONSULTANT).visits[0].places[0].addedAfterEnd;
    expect(add(visit({ status: 'ended', endedAt: '2026-10-14T04:50:00.000Z' }))).toBe(true);
    expect(add(visit())).toBe(false);
  });
});

describe('a flush of site visit acts alone', () => {
  it('leaves a snapshot already being read to land (Codex 4278681363)', async () => {
    let release!: (s: ApiSnapshot) => void;
    const snap = {
      project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
      drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    } as unknown as ApiSnapshot;
    const gw = {
      snapshot: vi.fn(() => new Promise<ApiSnapshot>((r) => { release = r; })),
      endSiteVisit: vi.fn(async () => visit({ status: 'ended', endedAt: '2026-10-14T06:00:00.000Z' })),
    };
    useStore.setState({ ...getInitialState(), role: 'consultant', sessionUserId: CONSULTANT });
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    const read = Promise.resolve(useStore.getState().requestFreshSnapshot());
    useStore.setState({ outbox: [{ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T06:00:00.000Z', idempotencyKey: 'k' }] });
    await useStore.getState().flushOutbox();
    expect(gw.endSiteVisit).toHaveBeenCalledTimes(1);
    release(snap);
    await read;
    await vi.waitFor(() => expect(useStore.getState().projectLoadState).toBe('ready'));
  });
});

describe('the queue of site visit acts', () => {
  const end = { t: 'siteVisitEnd' as const, visitId: 'v-1', claimedAt: '2026-10-14T06:00:00.000Z', idempotencyKey: 'k-end' };

  it('is kept per person under passwordless dev sign-in (Codex 4278754328)', () => {
    useStore.setState({ ...getInitialState(), sessionToken: null, sessionUserId: 'u-a', online: false });
    useStore.getState()._setGateway({ project: useStore.getState().activeProjectId } as unknown as ApiGateway);
    useStore.getState().queueSiteVisitAct(end, 'saved');
    const project = useStore.getState().activeProjectId;
    expect(JSON.parse(localStorage.getItem(`vitan.siteVisitQueue.dev:u-a.${project}`) ?? '[]')).toEqual([end]);
    // another dev persona on the same project does not get it
    useStore.setState({ sessionUserId: 'u-b' });
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toEqual([]);
    useStore.setState({ sessionUserId: 'u-a' });
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toEqual([end]);
    localStorage.clear();
  });

  it('moves an act queued during a refused start\'s lookup even when the project changes mid-flush (Codex 4278754334)', async () => {
    const conflict = Object.assign(new Error('409'), { status: 409, serverMessage: 'You already have a site visit open on this project; end it first' });
    const open = visit({ id: 'v-open', visitorId: PMC });
    let lookup!: (rows: SiteVisit[]) => void;
    let ended!: (v: SiteVisit) => void;
    const gw = {
      project: 'p-a',
      startSiteVisit: vi.fn(async () => { throw conflict; }),
      listSiteVisits: vi.fn(() => new Promise<SiteVisit[]>((r) => { lookup = r; })),
      endSiteVisit: vi.fn(() => new Promise<SiteVisit>((r) => { ended = r; })),
      addSiteVisitAttendee: vi.fn(async () => open),
    };
    useStore.setState({ ...getInitialState(), sessionUserId: PMC, activeProjectId: 'p-a', online: true });
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    const start = { t: 'siteVisitStart' as const, idempotencyKey: 'k-s', visitor: { name: 'Priya Shah', role: 'pmc', placeName: null }, body: { id: 'v-tmp', claimedAt: '2026-10-14T04:30:00.000Z' } };
    useStore.setState({ outbox: [start, { ...end, visitId: 'v-tmp' }] });
    const flushed = useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(gw.listSiteVisits).toHaveBeenCalled());
    // a guest added on the visit being started, while the lookup is out
    const guest = { t: 'siteVisitAddAttendee' as const, visitId: 'v-tmp', idempotencyKey: 'k-g', name: 'Mr Mehta', body: { id: 'a-1', guestName: 'Mr Mehta' } };
    useStore.getState().queueSiteVisitAct(guest, 'saved');
    lookup([open]);
    await vi.waitFor(() => expect(gw.endSiteVisit).toHaveBeenCalledWith('v-open', expect.any(String), expect.any(String)));
    // the viewer switches project while the moved End is out
    useStore.setState((s) => ({ activeProjectId: 'p-b', projectScopeGeneration: s.projectScopeGeneration + 1 }));
    ended(open);
    await flushed;
    const kept = JSON.parse(localStorage.getItem(`vitan.siteVisitQueue.dev:${PMC}.p-a`) ?? '[]') as { t: string; visitId: string }[];
    expect(kept).toEqual([expect.objectContaining({ t: 'siteVisitAddAttendee', visitId: 'v-open' })]);
    localStorage.clear();
  });

  it('is kept apart from the outbox an older bundle reads, so it never replays an act it has no case for (Codex 4278991737)', () => {
    useStore.setState({ ...getInitialState(), sessionToken: null, sessionUserId: 'u-a', online: false });
    useStore.getState()._setGateway({ project: useStore.getState().activeProjectId } as unknown as ApiGateway);
    const project = useStore.getState().activeProjectId;
    const other: OutboxOp = { t: 'changeWithdraw', decisionId: 'd-1', idempotencyKey: 'k-w' };
    useStore.setState({ outbox: [other] });
    useStore.getState().queueSiteVisitAct(end, 'saved');
    // the outbox key an older bundle reads holds no site visit act
    expect(JSON.parse(localStorage.getItem(`vitan.outbox.dev:u-a.${project}`) ?? '[]')).toEqual([other]);
    expect(JSON.parse(localStorage.getItem(`vitan.siteVisitQueue.dev:u-a.${project}`) ?? '[]')).toEqual([end]);
    // a reload reads both back
    useStore.setState({ outbox: [] });
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toEqual([other, end]);
    localStorage.clear();
  });
});
