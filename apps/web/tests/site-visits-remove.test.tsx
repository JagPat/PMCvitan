import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { replayOutboxOp, type ApiGateway, type OutboxOp, type SiteVisit, type SiteVisitFile, type SiteVisitRemoval } from '@/data/apiGateway';
import { fileVisitPhoto, listVisitPhotos, putVisitPhoto, visitPhotoScope, VisitPhotoUnreadable, type SiteVisitAddFileOp } from '@/data/visitPhotoStore';
import { flushesEnded, settled, startWork, tracked } from './site-visit-work';

/**
 * #1179 R3, taking a file off a visit (Jagrut's rule, 27 Oct 2026): the person who added a file removes it within the
 * hour while the visit is open, and the PMC removes any file at any time with a reason. The screen offers Remove only
 * where the server's read says the viewer may (`removable`), asks once before removing, and asks the PMC why when the
 * file is not their own within the hour. It is online only: the server's answer is the removal, and a removed file
 * never comes back on screen. The visit lists what was taken off it, who removed it, when and why.
 */

const CONSULTANT = 'u-cons';
const PMC = 'u-pmc';
const MEMBERS = [
  { userId: PMC, name: 'Priya Shah', role: 'pmc', email: null, phone: null, status: 'active' },
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
] as ProjectMember[];
const NOW = Date.parse('2026-10-14T05:00:00.000Z');
let now = NOW;

const voice = (over: Partial<SiteVisitFile> = {}): SiteVisitFile => ({
  mediaId: 'm-v', url: '/media/m-v?sig=x', mime: 'audio/webm', clientKey: null, takenAt: null, durationSec: 9, note: 'Leak by the tap',
  rating: null, place: null, addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
  removable: null, ...over,
});
const line = (over: Partial<SiteVisitRemoval> = {}): SiteVisitRemoval => ({
  mediaId: 'm-v', kind: 'voice', addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-10-14T04:50:00.000Z',
  removedById: CONSULTANT, removedByName: 'Kiran Rao', removedByRole: 'consultant', reason: null, removedAt: '2026-10-14T05:00:00.000Z', ...over,
});
function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v-1', visitorId: CONSULTANT, visitorName: 'Kiran Rao', visitorRole: 'consultant', status: 'open',
    startedAt: '2026-10-14T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [], files: [], removals: [],
    ...over,
  };
}
const own = { reasonRequired: false, until: '2026-10-14T05:50:00.000Z' };
const pmcOffer = { reasonRequired: true, until: null };

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };
/** a server holding one visit: each read answers with what `reads` says now */
function server(first: SiteVisit, over: Fake = {}) {
  const state = { visit: first };
  const gw: Fake = {
    listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' && state.visit.status !== 'open' ? [] : [state.visit])),
    removeSiteVisitFile: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  return { gw, state };
}

async function mount(role: Role, me: string, gw: Fake, lang: Lang = 'en') {
  useStore.setState({ ...getInitialState(), role, lang, sessionUserId: me, members: MEMBERS, loadTeam: async () => true });
  (gw as { project?: string }).project = useStore.getState().activeProjectId;
  useStore.getState()._setGateway(tracked(gw) as unknown as ApiGateway);
  render(<SiteVisitsScreen />);
  await act(async () => {});
  await settled();
  return screen.getByTestId('sv-visit-v-1');
}
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); await settled(); };

beforeEach(() => {
  expect(useStore.getState()._outboxFlushing()).toBe(false);
  onTestFinished(startWork(useStore));
  now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  await flushesEnded();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

describe('#1179 R3: taking a file off a visit', () => {
  it('offers Remove only where the server says the viewer may, and only until the offer ends', async () => {
    const shows = async (file: SiteVisitFile) => {
      const card = await mount('consultant', CONSULTANT, server(visit({ files: [file] })).gw);
      const has = within(card).queryByTestId('sv-remove-m-v') !== null;
      cleanup();
      return has;
    };
    expect(await shows(voice({ removable: own }))).toBe(true);
    expect(await shows(voice({ removable: null }))).toBe(false);
    // an API before removals says nothing: nothing is offered that the server may not take
    const { removable: _, ...older } = voice();
    expect(await shows(older as SiteVisitFile)).toBe(false);
    // an hour already over on this phone's clock
    expect(await shows(voice({ removable: { reasonRequired: false, until: '2026-10-14T04:59:59.000Z' } }))).toBe(false);
  });

  it('the person who added a file removes it within the hour after one question; it leaves at once and the visit says who removed it', async () => {
    const { gw, state } = server(visit({ files: [voice({ removable: own })] }));
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    const ask = within(card).getByTestId('sv-remove-ask-m-v');
    expect(ask.textContent).toContain('This file will be removed for everyone. This can’t be undone.');
    // their own file within the hour needs no reason
    expect(within(ask).queryByRole('textbox')).toBeNull();
    // Keep it asks nothing of the server
    await click(within(ask).getByTestId('sv-remove-keep-m-v'));
    expect(gw.removeSiteVisitFile).not.toHaveBeenCalled();
    await click(within(card).getByTestId('sv-remove-m-v'));
    // the server's next read no longer lists the file, and carries its line
    state.visit = visit({ files: [], removals: [line()] });
    await click(within(card).getByTestId('sv-remove-yes-m-v'));
    expect(gw.removeSiteVisitFile).toHaveBeenCalledTimes(1);
    expect(gw.removeSiteVisitFile).toHaveBeenCalledWith('m-v', undefined);
    expect(within(card).queryByTestId('sv-file-m-v')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('File removed.');
    const removed = within(card).getByTestId('sv-removal-m-v');
    expect(removed.textContent).toContain('Voice note');
    expect(removed.textContent).toContain('Removed by Kiran Rao');
    expect(removed.textContent).toContain('Removed by the person who added it.');
  });

  it('the PMC says why before removing someone else\'s file, and the reason must show something', async () => {
    const { gw, state } = server(visit({ files: [voice({ removable: pmcOffer })] }));
    const card = await mount('pmc', PMC, gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    const yes = within(card).getByTestId('sv-remove-yes-m-v');
    const reason = within(card).getByTestId('sv-remove-reason-m-v');
    expect(yes).toBeDisabled();
    // blank, or marks and fillers that draw nothing, are not a reason (the server's own rule, shared)
    for (const blank of ['   ', '️', 'ㅤ', '⠀', '​']) {
      fireEvent.change(reason, { target: { value: blank } });
      expect(yes, JSON.stringify(blank)).toBeDisabled();
    }
    // nor one holding a NUL (which the server cannot store), nor one past 300 characters, counted as the server counts
    fireEvent.change(reason, { target: { value: 'Wrong\u0000site' } });
    expect(yes).toBeDisabled();
    fireEvent.change(reason, { target: { value: `  ${'🙂'.repeat(301)}  ` } });
    expect(yes).toBeDisabled();
    expect(within(card).getByTestId('sv-remove-long-m-v').textContent).toBe('Keep the reason to 300 characters.');
    fireEvent.change(reason, { target: { value: `  ${'🙂'.repeat(300)}  ` } });
    expect(yes).toBeEnabled();
    expect(within(card).queryByTestId('sv-remove-long-m-v')).toBeNull();
    fireEvent.change(reason, { target: { value: '  Recorded by mistake ' } });
    expect(yes).toBeEnabled();
    state.visit = visit({ files: [], removals: [line({ removedById: PMC, removedByName: 'Priya Shah', removedByRole: 'pmc', reason: 'Recorded by mistake' })] });
    await click(yes);
    expect(gw.removeSiteVisitFile).toHaveBeenCalledWith('m-v', 'Recorded by mistake');
    const removed = within(card).getByTestId('sv-removal-m-v');
    expect(removed.textContent).toContain('Removed by Priya Shah');
    expect(removed.textContent).toContain('Reason: Recorded by mistake');
  });

  it('a removal whose answer was lost, sent again, finds the file gone and settles as removed; a route\'s 404 does not', async () => {
    const gone = refusal(404, 'This file is no longer on the site visit');
    const { gw } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw gone; }) });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    await click(within(card).getByTestId('sv-remove-yes-m-v'));
    // and the server's read, sent before it answered, still listing it never brings it back
    expect(within(card).queryByTestId('sv-file-m-v')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('File removed.');
    cleanup();

    // the server's other answer to a removal sent again: the file's row went before the visit was asked
    const media = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw refusal(404, 'Media not found'); }) });
    const card1 = await mount('consultant', CONSULTANT, media.gw);
    await click(within(card1).getByTestId('sv-remove-m-v'));
    await click(within(card1).getByTestId('sv-remove-yes-m-v'));
    expect(within(card1).queryByTestId('sv-file-m-v')).toBeNull();
    cleanup();

    const route = refusal(404, 'Cannot POST /projects/p/media/m-v/visit-removal');
    const other = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw route; }) });
    const card2 = await mount('consultant', CONSULTANT, other.gw);
    await click(within(card2).getByTestId('sv-remove-m-v'));
    await click(within(card2).getByTestId('sv-remove-yes-m-v'));
    expect(within(card2).getByTestId('sv-file-m-v')).toBeTruthy();
    expect(within(card2).getByTestId('sv-remove-said-m-v').textContent).toContain('The file was not removed.');
  });

  it('a refusal is said beside the file, in the viewer\'s language, and the offer is read again', async () => {
    const ended = refusal(409, 'This site visit has ended; ask the PMC to remove the file');
    const { gw, state } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw ended; }) });
    const card = await mount('consultant', CONSULTANT, gw, 'hi');
    const reads = gw.listSiteVisits!.mock.calls.length;
    await click(within(card).getByTestId('sv-remove-m-v'));
    // the visit ended meanwhile: the next read no longer offers it
    state.visit = visit({ status: 'ended', endedAt: '2026-10-14T04:58:00.000Z', files: [voice({ removable: null })] });
    await click(within(card).getByTestId('sv-remove-yes-m-v'));
    expect(gw.listSiteVisits!.mock.calls.length).toBeGreaterThan(reads);
    expect(within(card).getByTestId('sv-file-m-v')).toBeTruthy();
    // the offer is gone with the fresh read, and with it the question; why it was refused stays said
    expect(within(card).queryByTestId('sv-remove-m-v')).toBeNull();
    expect(within(card).queryByTestId('sv-remove-ask-m-v')).toBeNull();
    expect(within(card).getByTestId('sv-remove-said-m-v').textContent).toBe('फ़ाइल नहीं हटी। यह साइट विज़िट ख़त्म हो चुकी है; फ़ाइल हटाने के लिए PMC से कहें');
  });

  it('says what went wrong while the question is still open, in Hindi and Gujarati too', async () => {
    for (const [lang, words] of [['hi', 'फ़ाइल नहीं हटी। फ़ाइल जोड़ने के एक घंटे के अंदर ही हटाई जा सकती है; PMC से कहें'], ['gu', 'ફાઇલ કઢાઈ નથી. ફાઇલ ઉમેર્યાના એક કલાકમાં જ કાઢી શકાય છે; PMCને કહો']] as const) {
      const late = refusal(403, 'A file can be removed only within an hour of adding it; ask the PMC');
      const { gw } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw late; }) });
      const card = await mount('consultant', CONSULTANT, gw, lang);
      await click(within(card).getByTestId('sv-remove-m-v'));
      await click(within(card).getByTestId('sv-remove-yes-m-v'));
      expect(within(card).getByTestId('sv-remove-said-m-v').textContent).toBe(words);
      cleanup();
    }
  });

  it('no answer is said as such, and with no signal nothing is sent', async () => {
    const { gw } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    await click(within(card).getByTestId('sv-remove-yes-m-v'));
    expect(within(card).getByTestId('sv-remove-said-m-v').textContent).toBe('No answer from the server. If the file is still listed, try again.');
    expect(within(card).getByTestId('sv-file-m-v')).toBeTruthy();
    cleanup();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const offline = server(visit({ files: [voice({ removable: own })] }));
    const card2 = await mount('consultant', CONSULTANT, offline.gw);
    await click(within(card2).getByTestId('sv-remove-m-v'));
    await click(within(card2).getByTestId('sv-remove-yes-m-v'));
    expect(offline.gw.removeSiteVisitFile).not.toHaveBeenCalled();
    expect(within(card2).getByTestId('sv-remove-said-m-v').textContent).toBe('No signal. Removing a file needs a connection.');
  });

  it('a server that answered is never said to have given no answer: a sign-in, a timeout, a busy or failing server', async () => {
    for (const [status, said] of [[503, 'Service unavailable'], [429, 'Too many requests'], [408, 'Request timed out'], [401, '']] as const) {
      const { gw } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(async () => { throw refusal(status, said); }) });
      const card = await mount('consultant', CONSULTANT, gw);
      await click(within(card).getByTestId('sv-remove-m-v'));
      await click(within(card).getByTestId('sv-remove-yes-m-v'));
      expect(within(card).getByTestId('sv-remove-said-m-v').textContent).toBe(said ? `The file was not removed. ${said}` : 'The file was not removed.');
      expect(within(card).getByTestId('sv-file-m-v')).toBeTruthy();
      cleanup();
    }
  });

  it('the offer on one\'s own file leaves when the hour is up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { gw } = server(visit({ files: [voice({ removable: { reasonRequired: false, until: new Date(NOW + 60_000).toISOString() } })] }));
    const card = await mount('consultant', CONSULTANT, gw);
    expect(within(card).getByTestId('sv-remove-m-v')).toBeTruthy();
    now = NOW + 60_001;
    await act(async () => { vi.advanceTimersByTime(60_100); });
    expect(within(card).queryByTestId('sv-remove-m-v')).toBeNull();
  });

  it('lists each removal line with what it was, in the viewer\'s language', async () => {
    const lines = [
      line({ mediaId: 'm-p', kind: 'photo', removedById: PMC, removedByName: 'Priya Shah', removedByRole: 'pmc', reason: 'Wrong site' }),
      line({ mediaId: 'm-c', kind: 'video' }),
    ];
    const card = await mount('client', 'u-cl', server(visit({ removals: lines })).gw, 'gu');
    expect(within(card).getByText('કાઢેલી ફાઇલો')).toBeTruthy();
    expect(within(card).getByTestId('sv-removal-m-p').textContent).toContain('ફોટો');
    expect(within(card).getByTestId('sv-removal-m-p').textContent).toContain('કારણ: Wrong site');
    expect(within(card).getByTestId('sv-removal-m-c').textContent).toContain('વીડિયો');
    expect(within(card).getByTestId('sv-removal-m-c').textContent).toContain('ઉમેરનારે પોતે કાઢી.');
  });
  it('the PMC\'s own file stays removable when the hour is up, now with a reason, as the server allows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mine = voice({ addedById: PMC, addedByName: 'Priya Shah', addedByRole: 'pmc', removable: { reasonRequired: false, until: new Date(NOW + 60_000).toISOString() } });
    const card = await mount('pmc', PMC, server(visit({ files: [mine] })).gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    expect(within(card).queryByTestId('sv-remove-reason-m-v')).toBeNull();
    now = NOW + 60_001;
    await act(async () => { vi.advanceTimersByTime(60_100); });
    expect(within(card).getByTestId('sv-remove-reason-m-v')).toBeTruthy();
    expect(within(card).getByTestId('sv-remove-yes-m-v')).toBeDisabled();
  });

  it('a second press while the removal is on its way sends nothing more', async () => {
    let answer!: () => void;
    const { gw } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(() => new Promise((ok) => { answer = () => ok({ ok: true }); })) });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    const yes = within(card).getByTestId('sv-remove-yes-m-v');
    await act(async () => { fireEvent.click(yes); });
    expect(yes).toBeDisabled();
    await act(async () => { fireEvent.click(yes); });
    expect(gw.removeSiteVisitFile).toHaveBeenCalledTimes(1);
    await act(async () => { answer(); });
    await settled();
    expect(within(card).queryByTestId('sv-file-m-v')).toBeNull();
  });

  it('an answer that lands after a new sign-in changes nothing on the new screen', async () => {
    let answer!: () => void;
    const { gw } = server(visit({ files: [voice({ removable: own })] }), { removeSiteVisitFile: vi.fn(() => new Promise((ok) => { answer = () => ok({ ok: true }); })) });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-remove-m-v'));
    await act(async () => { fireEvent.click(within(card).getByTestId('sv-remove-yes-m-v')); });
    // the new sign-in's screen reads its own visits while the old removal is still out (its answer is held here)
    await act(async () => { useStore.setState({ projectScopeGeneration: useStore.getState().projectScopeGeneration + 1 }); });
    await vi.waitFor(() => expect(within(screen.getByTestId('sv-visit-v-1')).getByTestId('sv-file-m-v')).toBeTruthy());
    await act(async () => { answer(); });
    await settled();
    const fresh = screen.getByTestId('sv-visit-v-1');
    expect(screen.queryByRole('status')).toBeNull();
    // the new sign-in's own read still lists the file: nothing of the old one's removal hides it
    expect(within(fresh).getByTestId('sv-file-m-v')).toBeTruthy();
    expect(within(fresh).getByTestId('sv-remove-m-v')).toBeEnabled();
  });

  it('the phone\'s own copy of a file it sent does not come back once the server\'s file is removed', async () => {
    useStore.setState({ ...getInitialState(), sessionUserId: CONSULTANT });
    const st = useStore.getState();
    const scope = visitPhotoScope(st.sessionToken, CONSULTANT);
    const op = {
      t: 'siteVisitAddFile', visitId: 'v-1', idempotencyKey: 'idem-1', scope,
      file: { id: 'ck-1', mime: 'image/jpeg' }, by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: new Date(NOW).toISOString(),
    } as SiteVisitAddFileOp;
    // filed after the screen's first read is sent, so that read does not settle it: it is shown from the phone
    now = NOW + 5_000;
    await putVisitPhoto(scope, st.activeProjectId, op, 'AAAA');
    await fileVisitPhoto(scope, st.activeProjectId, 'ck-1');
    now = NOW;
    const photo = voice({ mediaId: 'm-p', mime: 'image/jpeg', url: '/media/m-p?sig=x', clientKey: 'ck-1', removable: own, durationSec: null, note: null });
    const { gw, state } = server(visit({ files: [photo] }));
    const card = await mount('consultant', CONSULTANT, gw);
    // the server lists it under the phone's key, so the phone's copy is not shown beside it
    expect(within(card).getByTestId('sv-file-m-p')).toBeTruthy();
    state.visit = visit({ files: [], removals: [line({ mediaId: 'm-p', kind: 'photo' })] });
    await click(within(card).getByTestId('sv-remove-m-p'));
    await click(within(card).getByTestId('sv-remove-yes-m-p'));
    expect(within(card).queryByTestId('sv-file-m-p')).toBeNull();
    expect(within(card).queryByTestId('sv-file-ck-1')).toBeNull();
    // and the phone lets go of its copy with the removal: no later read is needed, and a reload rebuilds nothing
    expect(await listVisitPhotos(scope, st.activeProjectId)).toEqual([]);
  });

  it('a send whose answer was lost, replayed after its file was removed, is settled: never "not sent"', async () => {
    useStore.setState({ ...getInitialState(), sessionUserId: CONSULTANT });
    const st = useStore.getState();
    const scope = visitPhotoScope(st.sessionToken, CONSULTANT);
    const op = {
      t: 'siteVisitAddFile', visitId: 'v-1', idempotencyKey: 'idem-2', scope,
      file: { id: 'ck-2', mime: 'audio/webm' }, by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: new Date(NOW).toISOString(),
    } as SiteVisitAddFileOp;
    await putVisitPhoto(scope, st.activeProjectId, op, 'AAAA');
    const gw = { project: st.activeProjectId, uploadMedia: vi.fn(async () => { throw refusal(410, 'This photo was deleted'); }) };
    // settled: the act leaves the queue, and the phone lets go of the file's bytes
    await expect(replayOutboxOp(gw as unknown as ApiGateway, op as unknown as OutboxOp, st.projectScopeGeneration)).resolves.toBeNull();
    expect(await listVisitPhotos(scope, st.activeProjectId)).toEqual([]);
    // any other 410 is still a refusal, kept with the server's words
    const other = { ...op, idempotencyKey: 'idem-3', file: { id: 'ck-3', mime: 'audio/webm' } } as SiteVisitAddFileOp;
    await putVisitPhoto(scope, st.activeProjectId, other, 'AAAA');
    const gone = { project: st.activeProjectId, uploadMedia: vi.fn(async () => { throw refusal(410, 'Gone'); }) };
    await expect(replayOutboxOp(gone as unknown as ApiGateway, other as unknown as OutboxOp, st.projectScopeGeneration)).rejects.toMatchObject({ status: 410 });
    expect((await listVisitPhotos(scope, st.activeProjectId)).map((r) => [r.clientKey, r.state, r.reason])).toEqual([['ck-3', 'failed', 'Gone']]);
  });
  it('a removed file whose copy the phone cannot let go holds its own visit only, as an unreadable copy does', async () => {
    useStore.setState({ ...getInitialState(), sessionUserId: CONSULTANT });
    const st = useStore.getState();
    const scope = visitPhotoScope(st.sessionToken, CONSULTANT);
    const op = {
      t: 'siteVisitAddFile', visitId: 'v-1', idempotencyKey: 'idem-4', scope,
      file: { id: 'ck-4', mime: 'audio/webm' }, by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: new Date(NOW).toISOString(),
    } as SiteVisitAddFileOp;
    await putVisitPhoto(scope, st.activeProjectId, op, 'AAAA');
    // the phone's store fails once the server has answered
    const gw = { project: st.activeProjectId, uploadMedia: vi.fn(async () => {
      vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('storage gone'); });
      throw refusal(410, 'This photo was deleted');
    }) };
    await expect(replayOutboxOp(gw as unknown as ApiGateway, op as unknown as OutboxOp, st.projectScopeGeneration)).rejects.toBeInstanceOf(VisitPhotoUnreadable);
    vi.mocked(indexedDB.open).mockRestore();
    expect((await listVisitPhotos(scope, st.activeProjectId)).map((r) => r.clientKey)).toEqual(['ck-4']);
  });

  it('a sent clip removed before its still frame went: the frame\'s not-found lets go of the whole clip on the phone', async () => {
    useStore.setState({ ...getInitialState(), sessionUserId: CONSULTANT });
    const st = useStore.getState();
    const scope = visitPhotoScope(st.sessionToken, CONSULTANT);
    const clip = (id: string) => ({
      t: 'siteVisitAddFile', visitId: 'v-1', idempotencyKey: `idem-${id}`, scope,
      file: { id, mime: 'video/webm' }, by: { name: 'Kiran Rao', role: 'consultant' }, placeName: null, queuedAt: new Date(NOW).toISOString(),
    } as SiteVisitAddFileOp);
    for (const id of ['ck-c', 'ck-d', 'ck-e']) {
      await putVisitPhoto(scope, st.activeProjectId, clip(id), 'AAAA', null, undefined, '/9j/frame');
      await fileVisitPhoto(scope, st.activeProjectId, id, `m-${id}`);
    }
    const removed = { project: st.activeProjectId, addVisitPoster: vi.fn(async () => { throw refusal(404, 'Media not found'); }) };
    await expect(replayOutboxOp(removed as unknown as ApiGateway, clip('ck-c') as unknown as OutboxOp, st.projectScopeGeneration)).resolves.toBeNull();
    // a frame refused for any other reason leaves the frame alone; the clip stays, filed, for its visit's next read
    const refused = { project: st.activeProjectId, addVisitPoster: vi.fn(async () => { throw refusal(400, 'This file is not a still frame the app can show'); }) };
    await expect(replayOutboxOp(refused as unknown as ApiGateway, clip('ck-d') as unknown as OutboxOp, st.projectScopeGeneration)).resolves.toBeNull();
    // a removed clip the phone cannot let go of just then holds its own visit, to be answered and let go again
    const stuck = { project: st.activeProjectId, addVisitPoster: vi.fn(async () => {
      vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('storage gone'); });
      throw refusal(404, 'Media not found');
    }) };
    await expect(replayOutboxOp(stuck as unknown as ApiGateway, clip('ck-e') as unknown as OutboxOp, st.projectScopeGeneration)).rejects.toBeInstanceOf(VisitPhotoUnreadable);
    vi.mocked(indexedDB.open).mockRestore();
    expect((await listVisitPhotos(scope, st.activeProjectId)).map((r) => [r.clientKey, r.state, r.poster ?? null])).toEqual([['ck-d', 'filed', null], ['ck-e', 'filed', '/9j/frame']]);
    await expect(replayOutboxOp(removed as unknown as ApiGateway, clip('ck-e') as unknown as OutboxOp, st.projectScopeGeneration)).resolves.toBeNull();
    expect((await listVisitPhotos(scope, st.activeProjectId)).map((r) => r.clientKey)).toEqual(['ck-d']);
  });
});
