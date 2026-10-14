import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, ProjectNode, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import type { ApiGateway, SiteVisit } from '@/data/apiGateway';
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
    listSiteVisits: vi.fn().mockResolvedValue(list),
    startSiteVisit: vi.fn(async (input: { id: string; nodeId?: string }) => visit({ id: input.id, visitorId: PMC, visitorName: 'Priya Shah', visitorRole: 'pmc', startPlace: input.nodeId ? { nodeId: input.nodeId, name: 'Kitchen' } : null })),
    ...over,
  };
}

async function mount(role: Role, me: string, gw: Fake, lang: Lang = 'en') {
  useStore.setState({ ...getInitialState(), role, lang, sessionUserId: me, nodes: NODES, members: MEMBERS, loadTeam: async () => {} });
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

  it('says what the server refused, and reuses the key only after a lost response', async () => {
    const lost = Object.assign(new Error('network'), {});
    const refused = Object.assign(new Error('409'), { status: 409, serverMessage: 'You already have an open site visit' });
    const startSiteVisit = vi.fn().mockRejectedValueOnce(lost).mockRejectedValueOnce(refused).mockRejectedValueOnce(refused);
    await mount('pmc', PMC, fakeGateway([], { startSiteVisit }));
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    expect(screen.getByRole('alert').textContent).toContain('No signal');
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    expect(screen.getByRole('alert').textContent).toBe('This was not saved. You already have an open site visit');
    await act(async () => { fireEvent.click(screen.getByTestId('sv-start')); });
    const [[b1, k1], [b2, k2], [b3, k3]] = startSiteVisit.mock.calls;
    // the retry after the lost response is the same act; after a refusal the next press is a new one
    expect(k2).toBe(k1);
    expect(b2.id).toBe(b1.id);
    expect(k3).not.toBe(k2);
    expect(b3.id).not.toBe(b2.id);
  });

  it('drops a reply for a project the viewer has left', async () => {
    let answer!: (v: SiteVisit) => void;
    const gw = fakeGateway([visit()], { endSiteVisit: vi.fn(() => new Promise<SiteVisit>((r) => { answer = r; })) });
    await mount('consultant', CONSULTANT, gw);
    fireEvent.click(screen.getByRole('button', { name: 'End visit' }));
    gw.listSiteVisits!.mockResolvedValue([]);
    await act(async () => { useStore.setState((s) => ({ projectScopeGeneration: s.projectScopeGeneration + 1 })); });
    await act(async () => { answer(visit({ status: 'ended' })); });
    expect(screen.queryByTestId('sv-visit-v-1')).toBeNull();
    expect(screen.getByText('No site visits yet.')).toBeTruthy();
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
});
