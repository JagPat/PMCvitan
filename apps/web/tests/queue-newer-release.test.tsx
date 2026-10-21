import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { useStore, getInitialState, newerReloadedMark } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QW } from '@/lib/queueWords';
import { QueueUnreadable } from '@/layout/QueueUnreadable';
import { LeaveUnkept } from '@/layout/LeaveUnkept';

/**
 * #792: a queue key that holds an act a newer release saved is read by that release. The strip asks the person to
 * reload (on their tap only) to send it. Such a key is never set aside, removed or written here: Set aside would move a
 * live newer tab's whole queue where nothing reads it (#1037 r1 check gap 3). This tab's own acts for that project are
 * not kept, as for any listed key. Everything here fails on #1037's head, which calls such a key unreadable and offers
 * only Set aside.
 */

const USER = 'u-eng';
const P2 = 'p-2';
const key = `vitan.outbox.dev:${USER}.${P2}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P2}`;
const draftKey = `vitan.dailyLogDraft.anon.${P2}`;
const start = (activityId: string): OutboxOp => ({ t: 'startActivity', activityId, idempotencyKey: `k-${activityId}` });
const newerAct = { t: 'futureOperation', idempotencyKey: 'k-f' };

function onP2(stored: Record<string, string>, lang: 'en' | 'hi' | 'gu' = 'en') {
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang, sessionUserId: USER, activeProjectId: P2, online: false });
  useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
  useStore.getState().hydrateOutbox();
  render(<><QueueUnreadable /><LeaveUnkept /></>);
}
/** what the Reload tap leaves in this tab: the key was met by a reload of this build, holding these bytes */
const marker = (k: string) => `vitan.newerReloaded.${k}`;
const stubReload = () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
};
const buttons = () => within(screen.getByTestId('queue-unreadable')).getAllByRole('button').map((b) => b.textContent);
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('a queue key a newer release wrote (#792)', () => {
  it.each([
    ['the general key', key, [start('A-1'), newerAct]],
    ['the visit lane', lane, [{ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-end' }, { t: 'siteVisitFutureAct', visitId: 'v-1', idempotencyKey: 'k-fv' }]],
  ])('%s: the strip says a newer version saved it, and offers Reload only', (_label, k, stored) => {
    onP2({ [k]: JSON.stringify(stored) });
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [k], failed: false, newer: [k] });
    expect(screen.getByTestId('queue-newer').textContent).toBe(QW.newerRelease.en);
    expect(screen.getByTestId('queue-unreadable').textContent).not.toContain(QW.unreadable.en);
    expect(buttons()).toEqual([QW.reload.en]);
  });

  it('the page reloads only when Reload is tapped', () => {
    const reload = stubReload();
    onP2({ [key]: JSON.stringify([newerAct]) });
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('PX2: Set aside never copies, removes or writes it: the key keeps its bytes, stays listed, and nothing is said to have failed', () => {
    const raw = JSON.stringify([start('A-1'), newerAct]);
    onP2({ [key]: raw });
    act(() => useStore.getState().setAsideUnreadableQueue());
    expect(localStorage.getItem(key)).toBe(raw);
    expect(copiesOf(key)).toEqual([]);
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: false, newer: [key] });
    // a load again brings back nothing from it, and leaves it as it was
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toEqual([]);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('this tab’s own acts on that project are not kept on this phone, and the key is never written', () => {
    const raw = JSON.stringify([newerAct]);
    onP2({ [key]: raw });
    useStore.getState().startActivity('B-1');
    const made = useStore.getState().outbox[0] as { idempotencyKey: string };
    expect(useStore.getState().queueUnkept).toEqual([`k:${made.idempotencyKey}`]);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('beside another key that cannot be read, both are said; Set aside moves only the other, and the newer key stays listed', () => {
    const raw = JSON.stringify([newerAct]);
    onP2({ [key]: raw, [draftKey]: '{"projectId":' });
    expect(useStore.getState().queueUnreadable?.newer).toEqual([key]);
    expect(screen.getByTestId('queue-newer').textContent).toBe(QW.newerRelease.en);
    expect(screen.getByTestId('queue-unreadable').textContent).toContain(QW.unreadable.en);
    expect(buttons()).toEqual([QW.reload.en, QW.setAside.en]);
    fireEvent.click(screen.getByRole('button', { name: QW.setAside.en }));
    expect(copiesOf(draftKey).map((x) => localStorage.getItem(x))).toEqual(['{"projectId":']);
    expect(copiesOf(key)).toEqual([]);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: false, newer: [key] });
    expect(buttons()).toEqual([QW.reload.en]);
  });

  it.each([
    ['an object that names no kind of act', JSON.stringify([start('A-1'), { activityId: 'A-2' }])],
    ['bad JSON', '{not json'],
    ['a known act in a shape this release does not load', JSON.stringify([{ t: 'recordLabourWork', input: {}, idempotencyKey: 'k-w', workKey: 'renamed' }, newerAct])],
  ])('%s is not a newer release’s: it is called unreadable, with Set aside and no Reload', (_label, raw) => {
    onP2({ [key]: raw });
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: false });
    expect(screen.queryByTestId('queue-newer')).toBeNull();
    expect(buttons()).toEqual([QW.setAside.en]);
  });

  describe('Reload is a way out the person starts (#1037 r1 re-check N1)', () => {
    it('with an update not kept, Reload asks first; Cancel stays on the page, and the update is still held', () => {
      const reload = stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(reload).not.toHaveBeenCalled();
      expect(useStore.getState().leaveConfirm).toEqual({ action: 'reload' });
      expect(screen.getByTestId('leave-unkept').textContent).toContain(QW.leaveTitle.en.replace('{n}', '1'));
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(reload).not.toHaveBeenCalled();
      expect(useStore.getState().leaveConfirm).toBeNull();
      expect(useStore.getState().queueUnkept).toHaveLength(1);
    });

    it('Continue reloads the page, once', () => {
      const reload = stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      expect(reload).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem(marker(key))).toBe(newerReloadedMark(JSON.stringify([newerAct])));
    });

    it('PR1 (re-check 2, G1): after Continue the browser does not ask again; before it, a reload is still asked', () => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      const leave = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      expect(leave()).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(leave()).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      expect(useStore.getState().queueUnkept).toHaveLength(1);
      expect(leave()).toBe(false);
    });

    it('PR6 (#1037 r2, Codex 4335234372): the agreement covers one reload: when that reload does not happen, the next leave is asked', () => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      const leave = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      // the agreed reload's own unload is not asked again; the stubbed reload leaves the page as it was
      expect(leave()).toBe(false);
      // a later close or reload of the same page, with the same update still not kept, is asked
      expect(useStore.getState().queueUnkept).toHaveLength(1);
      expect(leave()).toBe(true);
    });

    // a reload that does not happen (the person stops it, a 204, a download) leaves this page as it was: the stubbed
    // reload below does nothing, as such a reload does
    const leave = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    it.each([
      ['nothing was not kept at the tap, and an act made since is not kept (PR2)', false, false],
      ['Continue let one act go, and a second act made since is not kept (PR3)', true, false],
      ['a load of another project follows, and an act made there is not kept (PR4)', false, true],
    ])('re-check 3, G1: after a Reload that does not happen, when %s, the browser asks again', (_label, oneBefore, switchAway) => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      const refuse = () => vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
      if (oneBefore) {
        const w = refuse();
        useStore.getState().startActivity('B-1');
        w.mockRestore();
      }
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      if (oneBefore) fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      expect(leave()).toBe(false);
      if (switchAway) act(() => { useStore.setState({ activeProjectId: 'p-1' }); useStore.getState().hydrateOutbox(); });
      const w = refuse();
      act(() => useStore.getState().startActivity('B-2'));
      w.mockRestore();
      expect(useStore.getState().queueUnkept).toHaveLength(oneBefore ? 2 : 1);
      expect(leave()).toBe(true);
    });

    it('PR5 (re-check 3, G1): after a Reload that does not happen, a load of the same project asks again for the act agreed to, still not kept', () => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      const w = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
      useStore.getState().startActivity('B-1');
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      expect(leave()).toBe(false);
      // a load of the same scope (a sign-in again) while every write is still refused: B-1 is held, still not kept
      act(() => useStore.getState().hydrateOutbox());
      w.mockRestore();
      expect(useStore.getState().queueUnkept).toHaveLength(1);
      expect(leave()).toBe(true);
    });

    it.each([
      ['every read of this phone’s storage is refused (PE1)', 'refused'],
      ['this phone has no storage (PE2)', 'gone'],
    ] as const)('re-check 4, G1: after a Reload that does not happen, a load where %s asks again for the act agreed to, carried back', (_label, how) => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      const w = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
      useStore.getState().startActivity('B-1');
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      expect(leave()).toBe(false);
      if (how === 'refused') {
        const r = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
        act(() => useStore.getState().hydrateOutbox());
        r.mockRestore();
      } else {
        vi.stubGlobal('localStorage', undefined);
        act(() => useStore.getState().hydrateOutbox());
        vi.unstubAllGlobals();
        stubReload();
      }
      w.mockRestore();
      expect(useStore.getState().queueUnkept).toHaveLength(1);
      expect(leave()).toBe(true);
    });

    it('PD1 (re-check 4, G2): after a Reload that does not happen, a day-log draft edited since and not kept asks again', () => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      const w = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
      act(() => useStore.getState().checkIn());
      expect(useStore.getState().queueUnkept).toContain('draft:current');
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
      expect(leave()).toBe(false);
      act(() => useStore.getState().checkOut());
      w.mockRestore();
      expect(leave()).toBe(true);
    });

    it('MR7 (re-check 2, G3): with another question open, Reload changes nothing and does not reload', () => {
      const reload = stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      act(() => useStore.setState({ leaveConfirm: { action: 'signOut' } }));
      act(() => useStore.getState().requestReload());
      expect(useStore.getState().leaveConfirm).toEqual({ action: 'signOut' });
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(marker(key))).toBeNull();
    });

    it('MR8 (re-check 2, G3): with a leave the person already agreed to under way, Reload reloads without asking again', () => {
      const reload = stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      act(() => useStore.setState({ pendingProjectId: 'p-1' }));
      act(() => useStore.getState().requestReload());
      expect(useStore.getState().leaveConfirm).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('a key the newer tab has emptied since loads at the tap, keeping this tab’s update, with no reload and no question', () => {
      const reload = stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      useStore.getState().startActivity('B-1');
      const made = useStore.getState().outbox[0] as { idempotencyKey: string };
      // the newer tab sent its act, and its write left the key empty
      localStorage.setItem(key, '[]');
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(reload).not.toHaveBeenCalled();
      expect(useStore.getState().leaveConfirm).toBeNull();
      expect(useStore.getState().queueUnreadable).toBeNull();
      expect(useStore.getState().queueUnkept).toEqual([]);
      expect((JSON.parse(localStorage.getItem(key) ?? '[]') as { idempotencyKey: string }[]).map((o) => o.idempotencyKey)).toEqual([made.idempotencyKey]);
      expect(screen.queryByTestId('queue-unreadable')).toBeNull();
    });
  });

  describe('a reload that did not help: the key may then be set aside (#1037 r1 re-check N2)', () => {
    it.each([
      ['a kind a rollback removed (PA1)', [start('A-1'), { t: 'siteVisitAddVoice', visitId: 'v-1', idempotencyKey: 'k-v' }]],
      ['a damaged kind (PA2)', [{ t: 'startActivit', activityId: 'A-1', idempotencyKey: 'k-A-1' }]],
    ])('%s: after a reload of this build, Set aside is offered with its own words, and moves the key like any unreadable one', (_label, stored) => {
      const reload = stubReload();
      const raw = JSON.stringify(stored);
      onP2({ [key]: raw });
      expect(buttons()).toEqual([QW.reload.en]);
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(reload).toHaveBeenCalledTimes(1);
      // the reload loads this same build: the key is still a newer release's
      cleanup();
      onP2({});
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: false, newer: [key], reloaded: [key] });
      expect(screen.getByTestId('queue-newer-reloaded').textContent).toBe(QW.newerReloaded.en);
      expect(screen.queryByTestId('queue-newer')).toBeNull();
      expect(buttons()).toEqual([QW.reload.en, QW.setAside.en]);
      fireEvent.click(screen.getByRole('button', { name: QW.setAside.en }));
      expect(copiesOf(key).map((x) => localStorage.getItem(x))).toEqual([raw]);
      expect(useStore.getState().outbox).toEqual([]);
      expect(screen.queryByTestId('queue-unreadable')).toBeNull();
    });

    it.each([
      ['no reload yet', null],
      ['a reload of another build (a deploy since)', 'other@build'],
    ])('with %s, the key is Reload only, and Set aside leaves it', (_label, mark) => {
      if (mark) sessionStorage.setItem(marker(key), mark);
      const raw = JSON.stringify([newerAct]);
      onP2({ [key]: raw });
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: false, newer: [key] });
      expect(buttons()).toEqual([QW.reload.en]);
      act(() => useStore.getState().setAsideUnreadableQueue());
      expect(localStorage.getItem(key)).toBe(raw);
    });

    it.each(['hi', 'gu'] as const)('its words are said in %s', (lang) => {
      sessionStorage.setItem(marker(key), newerReloadedMark(JSON.stringify([newerAct])));
      onP2({ [key]: JSON.stringify([newerAct]) }, lang);
      expect(screen.getByTestId('queue-newer-reloaded').textContent).toBe(QW.newerReloaded[lang]);
      expect(buttons()).toEqual([QW.reload[lang], QW.setAside[lang]]);
    });

    it.each([
      ['the general key', 'a load then finds the key readable, and a newer act is written there again', key, true],
      ['the visit lane', 'a load then finds the key readable, and a newer act is written there again', lane, true],
      ['the general key', 'another tab writes other newer bytes there', key, false],
    ])('PK1 (re-check 2, G2), %s: after a Reload, when %s, the key is Reload only again', (_where, _label, k, readsBetween) => {
      stubReload();
      onP2({ [k]: JSON.stringify([newerAct]) });
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(sessionStorage.getItem(marker(k))).not.toBeNull();
      cleanup();
      if (readsBetween) {
        // the newer tab sent and emptied the key: a load finds it readable, and its mark goes
        onP2({ [k]: '[]' });
        expect(useStore.getState().queueUnreadable).toBeNull();
        expect(sessionStorage.getItem(marker(k))).toBeNull();
        cleanup();
      }
      // a newer tab writes a new act there; this tab loads another project, then this one again
      localStorage.setItem(k, JSON.stringify([{ ...newerAct, idempotencyKey: 'k-g' }]));
      act(() => { useStore.setState({ activeProjectId: 'p-1' }); useStore.getState().hydrateOutbox(); });
      onP2({});
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [k], failed: false, newer: [k] });
      expect(buttons()).toEqual([QW.reload.en]);
    });

    it('PA3 (re-check 3, G2): after a Reload that does not happen, a load on the same page is Reload only: no reload has met the key', () => {
      stubReload();
      onP2({ [key]: JSON.stringify([newerAct]) });
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(sessionStorage.getItem(marker(key))).not.toBeNull();
      // the person switches away and back on the same page
      act(() => { useStore.setState({ activeProjectId: 'p-1' }); useStore.getState().hydrateOutbox(); });
      act(() => { useStore.setState({ activeProjectId: P2 }); useStore.getState().hydrateOutbox(); });
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: false, newer: [key] });
      expect(buttons()).toEqual([QW.reload.en]);
      act(() => useStore.getState().setAsideUnreadableQueue());
      expect(localStorage.getItem(key)).toBe(JSON.stringify([newerAct]));
    });

    it('PF2 (re-check 3, G3): the visit lane, after a Reload, is offered Set aside on the reloaded page, while the general key, emptied since, loses its mark', () => {
      stubReload();
      const rawLane = JSON.stringify([newerAct]);
      onP2({ [key]: JSON.stringify([newerAct]), [lane]: rawLane });
      fireEvent.click(screen.getByRole('button', { name: QW.reload.en }));
      expect(sessionStorage.getItem(marker(key))).not.toBeNull();
      expect(sessionStorage.getItem(marker(lane))).not.toBeNull();
      cleanup();
      // the reloaded page, this same build: the newer tab has emptied the general key meanwhile
      onP2({ [key]: '[]' });
      expect(sessionStorage.getItem(marker(key))).toBeNull();
      expect(sessionStorage.getItem(marker(lane))).not.toBeNull();
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [lane], failed: false, newer: [lane], reloaded: [lane] });
      expect(buttons()).toEqual([QW.reload.en, QW.setAside.en]);
      fireEvent.click(screen.getByRole('button', { name: QW.setAside.en }));
      expect(copiesOf(lane).map((x) => localStorage.getItem(x))).toEqual([rawLane]);
      expect(screen.queryByTestId('queue-unreadable')).toBeNull();
    });

    it('MR0 (re-check 2, G3): a reloaded key whose copy aside is refused stays offered Set aside with its own words', () => {
      const raw = JSON.stringify([newerAct]);
      sessionStorage.setItem(marker(key), newerReloadedMark(raw));
      onP2({ [key]: raw });
      expect(buttons()).toEqual([QW.reload.en, QW.setAside.en]);
      const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string) {
        if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
      });
      fireEvent.click(screen.getByRole('button', { name: QW.setAside.en }));
      write.mockRestore();
      expect(localStorage.getItem(key)).toBe(raw);
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [key], failed: true, newer: [key], reloaded: [key] });
      expect(screen.getByTestId('queue-newer-reloaded').textContent).toBe(QW.newerReloaded.en);
      expect(buttons()).toEqual([QW.reload.en, QW.setAside.en]);
    });
  });

  it.each(['hi', 'gu'] as const)('the strip is said in %s', (lang) => {
    onP2({ [key]: JSON.stringify([newerAct]) }, lang);
    expect(screen.getByTestId('queue-newer').textContent).toBe(QW.newerRelease[lang]);
    expect(buttons()).toEqual([QW.reload[lang]]);
  });
});
