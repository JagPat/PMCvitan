import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen, within } from '@testing-library/react';
import type { Lang, ProjectMember, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { SiteVisitsScreen } from '@/screens/SiteVisitsScreen';
import { tellSiteVisits, type ApiGateway, type SiteVisit, type SiteVisitFile, type SiteVisitFileLink } from '@/data/apiGateway';
import { flushesEnded, settled, startWork, tracked } from './site-visit-work';

/**
 * Video V2g-2 (#995, Jagrut's choice 6 Nov 2026): a clip's link to its full-quality video in Google Drive or Zoho
 * WorkDrive. The card shows the link, which opens in a new tab with no opener and no referrer, and only when it passes
 * the shared allow-list. Add, Change and Take off show where the server's read offers them (`fullVideoLinkOffer`, a
 * removal offer's rule). It is online only: the server's answer is the change, a refusal is said beside the clip, and
 * nothing is queued to send later. A lost answer sent again goes under the same key and body.
 */

const CONSULTANT = 'u-cons';
const PMC = 'u-pmc';
const MEMBERS = [
  { userId: PMC, name: 'Priya Shah', role: 'pmc', email: null, phone: null, status: 'active' },
  { userId: CONSULTANT, name: 'Kiran Rao', role: 'consultant', email: null, phone: null, status: 'active' },
] as ProjectMember[];
const NOW = Date.parse('2026-11-07T05:00:00.000Z');
const DRIVE = 'https://drive.google.com/file/d/1AbC/view?usp=sharing';
const ZOHO = 'https://workdrive.zohopublic.in/file/xyz';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const clip = (over: Partial<SiteVisitFile> = {}): SiteVisitFile => ({
  mediaId: 'm-c', url: '/media/m-c?sig=x', mime: 'video/mp4', clientKey: null, takenAt: null, durationSec: 20, note: null,
  rating: null, place: null, addedById: CONSULTANT, addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-11-07T04:50:00.000Z',
  removable: null, posterUrl: null, fullVideoLink: null, fullVideoLinkOffer: null, ...over,
});
const link = (over: Partial<SiteVisitFileLink> = {}): SiteVisitFileLink => ({
  id: '11111111-1111-4111-8111-111111111111', url: DRIVE, host: 'drive', label: 'Slab pour, full', addedById: CONSULTANT,
  addedByName: 'Kiran Rao', addedByRole: 'consultant', addedAt: '2026-11-07T04:55:00.000Z', ...over,
});
function visit(over: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: '22222222-2222-4222-8222-222222222222', visitorId: CONSULTANT, visitorName: 'Kiran Rao', visitorRole: 'consultant', status: 'open',
    startedAt: '2026-11-07T04:30:00.000Z', startTimeAdjusted: false, startPlace: null, location: { kind: 'none' },
    endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
    lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [], files: [], removals: [],
    ...over,
  };
}
const VISIT = '22222222-2222-4222-8222-222222222222';
const addOffer = { reasonRequired: false, until: null };
const ownOffer = { reasonRequired: false, until: '2026-11-07T05:55:00.000Z' };
const pmcOffer = { reasonRequired: true, until: null };

type Fake = { [K in keyof ApiGateway]?: ReturnType<typeof vi.fn> };
/** a server holding one visit: each read, and each link change's answer, is what `state.visit` holds then */
function server(first: SiteVisit, over: Fake = {}) {
  const state = { visit: first };
  const gw: Fake = {
    listSiteVisits: vi.fn(async (q?: { status?: string }) => (q?.status === 'open' && state.visit.status !== 'open' ? [] : [state.visit])),
    setSiteVisitFileLink: vi.fn(async () => state.visit),
    endSiteVisitFileLink: vi.fn(async () => state.visit),
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
  return screen.getByTestId(`sv-visit-${VISIT}`);
}
const refusal = (status: number, serverMessage: string) => Object.assign(new Error(String(status)), { status, serverMessage });
const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); await settled(); };
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  expect(useStore.getState()._outboxFlushing()).toBe(false);
  onTestFinished(startWork(useStore));
  vi.spyOn(Date, 'now').mockImplementation(() => NOW);
});
afterEach(async () => {
  await flushesEnded();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  await new Promise((done) => { const q = indexedDB.deleteDatabase('vitan-visit-photos'); q.onsuccess = q.onerror = q.onblocked = () => done(null); });
});

describe('video V2g-2: a clip\'s full-video link', () => {
  it('shows the link, opening in a new tab with no opener and no referrer, with its host and label', async () => {
    const card = await mount('consultant', CONSULTANT, server(visit({ files: [clip({ fullVideoLink: link() })] })).gw);
    const a = within(card).getByTestId('sv-link-open-m-c') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(DRIVE);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
    const shown = within(card).getByTestId('sv-link-m-c').textContent;
    expect(shown).toContain('Full video ↗');
    expect(shown).toContain('Google Drive');
    expect(shown).toContain('Slab pour, full');
    expect(shown).toContain('Link added by Kiran Rao');
    // nothing is offered that the read does not offer
    expect(within(card).queryByTestId('sv-link-add-m-c')).toBeNull();
    expect(within(card).queryByTestId('sv-link-change-m-c')).toBeNull();
  });

  it('a stored url the shared allow-list refuses is shown as text, never as a link', async () => {
    for (const url of ['https://drive.google.com.evil.io/x', 'javascript:alert(1)', 'http://drive.google.com/x', 'https://u@drive.google.com/x']) {
      const card = await mount('consultant', CONSULTANT, server(visit({ files: [clip({ fullVideoLink: link({ url }) })] })).gw);
      expect(within(card).queryByTestId('sv-link-open-m-c'), url).toBeNull();
      expect(within(card).queryByRole('link', { name: /Full video/u }), url).toBeNull();
      expect(within(card).getByTestId('sv-link-text-m-c').textContent).toContain(url);
      cleanup();
    }
  });

  it('a voice note, and a clip read from an API before links, show no link and offer none', async () => {
    const { fullVideoLink: _l, fullVideoLinkOffer: _o, ...older } = clip();
    const card = await mount('consultant', CONSULTANT, server(visit({
      files: [older as SiteVisitFile, clip({ mediaId: 'm-v', mime: 'audio/webm', fullVideoLinkOffer: addOffer })],
    })).gw);
    expect(within(card).queryByTestId('sv-link-add-m-c')).toBeNull();
    expect(within(card).queryByTestId('sv-link-m-c')).toBeNull();
    // the server never offers a voice note one; a stray offer on one still shows nothing
    expect(within(card).queryByTestId('sv-link-add-m-v')).toBeNull();
  });

  it('adds a link where the read offers it: a refused host sends nothing; a good one is saved and shown from the answer', async () => {
    const { gw, state } = server(visit({ files: [clip({ fullVideoLinkOffer: addOffer })] }));
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-link-add-m-c'));
    const form = within(card).getByTestId('sv-link-form-m-c');
    expect(form.textContent).toContain('Make sure the link’s sharing lets your project team open it.');
    const save = within(card).getByTestId('sv-link-save-m-c');
    expect(save).toBeDisabled();
    for (const bad of ['http://drive.google.com/x', 'https://drive.google.com.evil.io/x', 'https://docs.google.com/x', 'javascript:alert(1)', 'https://drive.google.com:443/x']) {
      type(within(card).getByTestId('sv-link-url-m-c'), bad);
      expect(save, bad).toBeDisabled();
      expect(within(card).getByTestId('sv-link-problem-m-c').textContent).toBe('Paste a share link from Google Drive or Zoho WorkDrive');
    }
    expect(gw.setSiteVisitFileLink).not.toHaveBeenCalled();
    type(within(card).getByTestId('sv-link-url-m-c'), `  ${ZOHO}  `);
    type(within(card).getByTestId('sv-link-label-m-c'), ' Roof walk ');
    expect(save).toBeEnabled();
    state.visit = visit({ files: [clip({ fullVideoLink: link({ url: ZOHO, host: 'zoho', label: 'Roof walk' }), fullVideoLinkOffer: ownOffer })] });
    await click(save);
    expect(gw.setSiteVisitFileLink).toHaveBeenCalledTimes(1);
    const [visitId, mediaId, body, key] = gw.setSiteVisitFileLink!.mock.calls[0]!;
    expect([visitId, mediaId]).toEqual([VISIT, 'm-c']);
    // the server's contract, applied here: trimmed, and the link the person saw (none)
    expect(body).toEqual({ id: expect.stringMatching(UUID), url: ZOHO, label: 'Roof walk', replaces: null });
    expect(key).toEqual(expect.stringMatching(UUID));
    expect(within(card).queryByTestId('sv-link-form-m-c')).toBeNull();
    expect(within(card).getByTestId('sv-link-m-c').textContent).toContain('Zoho WorkDrive');
    expect(screen.getByRole('status').textContent).toBe('Full video link saved.');
    // their own link within the hour: they may change it or take it off, with no reason
    expect(within(card).getByTestId('sv-link-change-m-c')).toBeTruthy();
    expect(within(card).getByTestId('sv-link-off-m-c')).toBeTruthy();
  });

  it('a lost answer sent again goes under the same key and id; a changed body is a change of its own', async () => {
    const lost = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { gw, state } = server(visit({ files: [clip({ fullVideoLinkOffer: addOffer })] }), { setSiteVisitFileLink: lost });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-link-add-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), DRIVE);
    await click(within(card).getByTestId('sv-link-save-m-c'));
    expect(within(card).getByTestId('sv-link-said-m-c').textContent).toBe('No answer from the server. Try again: it is saved only once.');
    // the form stays as typed, to send again
    expect(within(card).getByTestId('sv-link-form-m-c')).toBeTruthy();
    await click(within(card).getByTestId('sv-link-save-m-c'));
    const [, , first, firstKey] = lost.mock.calls[0]!;
    const [, , again, againKey] = lost.mock.calls[1]!;
    expect(againKey).toBe(firstKey);
    expect(again).toEqual(first);
    // a label added after: another body, another key and link id
    type(within(card).getByTestId('sv-link-label-m-c'), 'Full pour');
    lost.mockImplementationOnce(async () => state.visit);
    state.visit = visit({ files: [clip({ fullVideoLink: link({ label: 'Full pour' }), fullVideoLinkOffer: ownOffer })] });
    await click(within(card).getByTestId('sv-link-save-m-c'));
    const [, , third, thirdKey] = lost.mock.calls[2]!;
    expect(thirdKey).not.toBe(firstKey);
    expect((third as { id: string }).id).not.toBe((first as { id: string }).id);
    expect(within(card).getByTestId('sv-link-m-c').textContent).toContain('Full pour');
  });

  it('a lost answer is not sent again once the form is closed: a fresh try names the link on screen, and one that landed is a stale 409, never a second link', async () => {
    const stale = refusal(409, 'Someone else changed this video\'s full video link; look at it again');
    const sends = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(stale);
    const { gw, state } = server(visit({ files: [clip({ fullVideoLinkOffer: addOffer })] }), { setSiteVisitFileLink: sends });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-link-add-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), DRIVE);
    await click(within(card).getByTestId('sv-link-save-m-c'));
    // the first send landed at the server; its answer was lost. The person closes the form and tries again
    await click(within(card).getByTestId('sv-link-cancel-m-c'));
    state.visit = visit({ files: [clip({ fullVideoLink: link({ label: null }), fullVideoLinkOffer: ownOffer })] });
    await click(within(card).getByTestId('sv-link-add-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), DRIVE);
    await click(within(card).getByTestId('sv-link-save-m-c'));
    const [, , first, firstKey] = sends.mock.calls[0]!;
    const [, , fresh, freshKey] = sends.mock.calls[1]!;
    expect(freshKey).not.toBe(firstKey);
    expect((fresh as { id: string }).id).not.toBe((first as { id: string }).id);
    // the link on screen when the form opened: none, so the server refuses it as stale and the visit is read again
    expect((fresh as { replaces: string | null }).replaces).toBeNull();
    expect(within(card).queryByTestId('sv-link-form-m-c')).toBeNull();
    expect(within(card).getByTestId('sv-link-open-m-c').getAttribute('href')).toBe(DRIVE);
    expect(within(card).getByTestId('sv-link-said-m-c').textContent).toContain('Someone else changed');
    expect(sends).toHaveBeenCalledTimes(2);

    // a reload forgets the lost send too: the page reads the link that landed, and nothing is sent by itself
    cleanup();
    const again = await mount('consultant', CONSULTANT, gw);
    expect(within(again).getByTestId('sv-link-open-m-c').getAttribute('href')).toBe(DRIVE);
    expect(sends).toHaveBeenCalledTimes(2);
  });

  it('the offline and no-answer words are said in Hindi and Gujarati too', async () => {
    for (const [lang, offline] of [['hi', 'नेटवर्क नहीं।'], ['gu', 'નેટવર્ક નથી.']] as const) {
      vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: false });
      const { gw } = server(visit({ files: [clip({ fullVideoLinkOffer: addOffer })] }), {
        setSiteVisitFileLink: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
      });
      const card = await mount('consultant', CONSULTANT, gw, lang);
      await click(within(card).getByTestId('sv-link-add-m-c'));
      type(within(card).getByTestId('sv-link-url-m-c'), DRIVE);
      await click(within(card).getByTestId('sv-link-save-m-c'));
      expect(within(card).getByTestId('sv-link-said-m-c').textContent).toContain(offline);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('offline, nothing is queued: it says a connection is needed', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, onLine: false });
    const { gw } = server(visit({ files: [clip({ fullVideoLinkOffer: addOffer })] }), {
      setSiteVisitFileLink: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
    });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-link-add-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), DRIVE);
    await click(within(card).getByTestId('sv-link-save-m-c'));
    expect(within(card).getByTestId('sv-link-said-m-c').textContent).toBe('No signal. Saving a link needs a connection; try again when you are online.');
    expect(useStore.getState().outbox).toEqual([]);
    expect(Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? '').includes('m-c'))).toEqual([]);
  });

  it('a link someone else changed meanwhile is refused, never replaced unseen: the form closes and the visit is read again', async () => {
    const stale = refusal(409, 'Someone else changed this video\'s full video link; look at it again');
    const theirs = link({ id: '33333333-3333-4333-8333-333333333333', url: ZOHO, host: 'zoho', label: 'Their take', addedById: PMC, addedByName: 'Priya Shah', addedByRole: 'pmc' });
    const { gw, state } = server(visit({ files: [clip({ fullVideoLink: link(), fullVideoLinkOffer: ownOffer })] }), {
      setSiteVisitFileLink: vi.fn(async () => { throw stale; }),
    });
    const card = await mount('consultant', CONSULTANT, gw);
    await click(within(card).getByTestId('sv-link-change-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), ZOHO);
    // the read the refusal asks for shows the PMC's link, which this consultant may not change
    state.visit = visit({ files: [clip({ fullVideoLink: theirs, fullVideoLinkOffer: null })] });
    const reads = gw.listSiteVisits!.mock.calls.length;
    await click(within(card).getByTestId('sv-link-save-m-c'));
    // the change named the link they saw
    expect((gw.setSiteVisitFileLink!.mock.calls[0]![2] as { replaces: string }).replaces).toBe(link().id);
    expect(gw.listSiteVisits!.mock.calls.length).toBeGreaterThan(reads);
    expect(within(card).queryByTestId('sv-link-form-m-c')).toBeNull();
    expect(within(card).getByTestId('sv-link-said-m-c').textContent)
      .toBe('The link was not saved. Someone else changed this video’s full video link; look at it again');
    expect(within(card).getByTestId('sv-link-m-c').textContent).toContain('Their take');
    expect(within(card).queryByTestId('sv-link-change-m-c')).toBeNull();
  });

  it('a link put on while the Add form was open is not replaced: the add still names none, and is refused', async () => {
    const { gw, state } = server(visit({ files: [clip({ fullVideoLinkOffer: addOffer })] }), {
      setSiteVisitFileLink: vi.fn(async () => { throw refusal(409, 'Someone else changed this video\'s full video link; look at it again'); }),
    });
    const card = await mount('pmc', PMC, gw);
    await click(within(card).getByTestId('sv-link-add-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), ZOHO);
    // a read lands meanwhile with another person's link on the clip
    state.visit = visit({ files: [clip({ fullVideoLink: link(), fullVideoLinkOffer: pmcOffer })] });
    const st = useStore.getState();
    await act(async () => { tellSiteVisits({ kind: 'answer', project: st.activeProjectId, generation: st.projectScopeGeneration, visit: state.visit }); });
    await settled();
    expect(within(card).getByTestId('sv-link-m-c')).toBeTruthy();
    expect(within(card).getByTestId('sv-link-form-m-c')).toBeTruthy();
    await click(within(card).getByTestId('sv-link-save-m-c'));
    expect((gw.setSiteVisitFileLink!.mock.calls[0]![2] as { replaces: string | null }).replaces).toBeNull();
    // the form filled for no link is closed, to be opened again on the link as it now is
    expect(within(card).queryByTestId('sv-link-form-m-c')).toBeNull();
    expect(within(card).getByTestId('sv-link-said-m-c').textContent).toContain('Someone else changed');
    await click(within(card).getByTestId('sv-link-change-m-c'));
    // a change of that link needs the PMC's reason, and names it
    type(within(card).getByTestId('sv-link-url-m-c'), ZOHO);
    expect(within(card).getByTestId('sv-link-save-m-c')).toBeDisabled();
    type(within(card).getByTestId('sv-link-reason-m-c'), 'Better copy');
    (gw.setSiteVisitFileLink!).mockImplementationOnce(async () => state.visit);
    await click(within(card).getByTestId('sv-link-save-m-c'));
    expect((gw.setSiteVisitFileLink!.mock.calls[1]![2] as { replaces: string | null }).replaces).toBe(link().id);
  });

  it('the PMC says why before changing or taking off someone else\'s link', async () => {
    const { gw, state } = server(visit({ files: [clip({ fullVideoLink: link(), fullVideoLinkOffer: pmcOffer })] }));
    const card = await mount('pmc', PMC, gw);
    await click(within(card).getByTestId('sv-link-off-m-c'));
    const yes = within(card).getByTestId('sv-link-off-yes-m-c');
    expect(within(card).getByTestId('sv-link-off-ask-m-c').textContent).toContain('Take this link off the clip? The visit keeps a record of it.');
    expect(yes).toBeDisabled();
    for (const blank of ['   ', '️', 'ㅤ', 'Wrong\u0000link']) {
      type(within(card).getByTestId('sv-link-reason-m-c'), blank);
      expect(yes, JSON.stringify(blank)).toBeDisabled();
    }
    type(within(card).getByTestId('sv-link-reason-m-c'), `  ${'🙂'.repeat(301)}  `);
    expect(yes).toBeDisabled();
    expect(within(card).getByTestId('sv-link-problem-m-c').textContent).toBe('Keep the reason to 300 characters');
    type(within(card).getByTestId('sv-link-reason-m-c'), ' Wrong clip linked ');
    expect(yes).toBeEnabled();
    state.visit = visit({ files: [clip({ fullVideoLink: null, fullVideoLinkOffer: addOffer })] });
    await click(yes);
    expect(gw.endSiteVisitFileLink).toHaveBeenCalledWith(VISIT, 'm-c', { linkId: link().id, reason: 'Wrong clip linked' }, expect.stringMatching(UUID));
    expect(within(card).queryByTestId('sv-link-m-c')).toBeNull();
    expect(within(card).getByTestId('sv-link-add-m-c')).toBeTruthy();

    // a replace asks the same
    cleanup();
    const other = server(visit({ files: [clip({ fullVideoLink: link(), fullVideoLinkOffer: pmcOffer })] }));
    const card2 = await mount('pmc', PMC, other.gw);
    await click(within(card2).getByTestId('sv-link-change-m-c'));
    type(within(card2).getByTestId('sv-link-url-m-c'), ZOHO);
    expect(within(card2).getByTestId('sv-link-save-m-c')).toBeDisabled();
    type(within(card2).getByTestId('sv-link-reason-m-c'), 'Better copy');
    await click(within(card2).getByTestId('sv-link-save-m-c'));
    expect(other.gw.setSiteVisitFileLink!.mock.calls[0]![2]).toEqual({ id: expect.stringMatching(UUID), url: ZOHO, replaces: link().id, reason: 'Better copy' });
  });

  it('a refusal of the form\'s own fields keeps the form, said in the viewer\'s language', async () => {
    const { gw } = server(visit({ files: [clip({ fullVideoLink: link(), fullVideoLinkOffer: ownOffer })] }), {
      setSiteVisitFileLink: vi.fn(async () => { throw refusal(403, 'A link can be changed only within an hour of adding it; ask the PMC'); }),
    });
    const card = await mount('consultant', CONSULTANT, gw, 'hi');
    await click(within(card).getByTestId('sv-link-change-m-c'));
    type(within(card).getByTestId('sv-link-url-m-c'), ZOHO);
    await click(within(card).getByTestId('sv-link-save-m-c'));
    expect(within(card).getByTestId('sv-link-said-m-c').textContent).toBe('लिंक नहीं सहेजा गया। लिंक जोड़ने के एक घंटे के अंदर ही बदला जा सकता है; PMC से कहें');
    expect(within(card).getByTestId('sv-link-form-m-c')).toBeTruthy();
  });

  it('the offer to change one\'s own link leaves when its hour is up', async () => {
    const card = await mount('consultant', CONSULTANT, server(visit({
      files: [clip({ fullVideoLink: link(), fullVideoLinkOffer: { reasonRequired: false, until: '2026-11-07T04:59:59.000Z' } })],
    })).gw);
    expect(within(card).getByTestId('sv-link-m-c')).toBeTruthy();
    expect(within(card).queryByTestId('sv-link-change-m-c')).toBeNull();
    expect(within(card).queryByTestId('sv-link-off-m-c')).toBeNull();
  });
});
