import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import { ProjectLoadBoundary } from '@/layout/ProjectLoadBoundary';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Board order: error messages) — the lines a decision action shows afterwards (approve, change,
 * withdraw, consult, advise), the "could not reach the server" line, the queued-offline line and the
 * project loading / load-failed screen follow the viewer's language. English is byte-identical.
 */

const s = () => useStore.getState();
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });

afterEach(() => {
  cleanup();
  s()._setGateway(null);
  useStore.setState(getInitialState());
});

const snapshot = (): ApiSnapshot => ({
  project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'x', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});

const HINDI = /[ऀ-ॿ]/;
const GUJARATI = /[઀-૿]/;
const script = { hi: HINDI, gu: GUJARATI } as const;
/** What is left after removing the decision id: no Latin letters may remain. "PMC" is the role's
 *  acronym, kept on purpose ("प्रोजेक्ट मैनेजर (PMC)", the #827 rename). */
const latinLeft = (text: string, keep: string[] = []) => [...keep, 'PMC'].reduce((t, k) => t.split(k).join(''), text).match(/[A-Za-z]+/g) ?? [];

const firstDecision = () => getInitialState().decisions[0]!;

function connect(gw: Partial<ApiGateway>, lang: 'en' | 'hi' | 'gu', online = true) {
  useStore.setState(getInitialState());
  s()._setGateway({ snapshot: vi.fn().mockResolvedValue(snapshot()), ...gw } as unknown as ApiGateway);
  useStore.setState({ online, activeProjectId: 'ambli', projectScopeGeneration: 1, outbox: [], syncQueue: [], lang });
}

describe('approve', () => {
  it('English stays as it was', async () => {
    const d = firstDecision();
    connect({ approveDecision: vi.fn().mockResolvedValue(snapshot()) }, 'en');
    useStore.setState({ modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
    s().confirmApprove();
    await settles(() => s().toast === 'Approved & locked — saved to the server.');
  });

  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: the saved line`, async () => {
      const d = firstDecision();
      connect({ approveDecision: vi.fn().mockResolvedValue(snapshot()) }, lang);
      useStore.setState({ modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
      s().confirmApprove();
      await settles(() => s().toast !== null && script[lang].test(s().toast!));
      expect(latinLeft(s().toast!)).toEqual([]);
    });

    it(`${lang}: the server cannot be reached`, async () => {
      const d = firstDecision();
      connect({ approveDecision: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }, lang);
      useStore.setState({ modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
      s().confirmApprove();
      await settles(() => s().toast !== null && script[lang].test(s().toast!));
      expect(latinLeft(s().toast!)).toEqual([]);
    });

    it(`${lang}: queued offline names the decision and nothing else in English`, () => {
      const d = firstDecision();
      connect({ approveDecision: vi.fn() }, lang, false);
      useStore.setState({ modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
      s().confirmApprove();
      expect(s().toast).toContain(d.id);
      expect(latinLeft(s().toast!, [d.id])).toEqual([]);
      // the sync list keeps its English label: it is the outbox's key, not a toast
      expect(s().syncQueue).toEqual(['Approve ' + d.id]);
    });

    it(`${lang}: the demo approve line`, () => {
      const d = firstDecision();
      useStore.setState({ ...getInitialState(), lang, modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
      s().confirmApprove();
      expect(latinLeft(s().toast!)).toEqual([]);
    });
  }

  it('English offline line is unchanged', () => {
    const d = firstDecision();
    connect({ approveDecision: vi.fn() }, 'en', false);
    useStore.setState({ modal: { type: 'approve', decId: d.id, optIdx: 0 } } as never);
    s().confirmApprove();
    expect(s().toast).toBe(`Approve ${d.id} — saved offline, will sync when you reconnect.`);
  });
});

describe('change request and withdraw', () => {
  const change = (decId: string) =>
    useStore.setState({ modal: { type: 'change', decId, changeText: 'Thicker slab', changeCost: '0', changeTime: '0' } } as never);

  it('English stays as it was, for the client and for another decider', async () => {
    const d = firstDecision();
    connect({ requestChange: vi.fn().mockResolvedValue(snapshot()) }, 'en');
    change(d.id);
    s().submitChange();
    await settles(() => s().toast === 'Change Request submitted for client re-approval.');

    connect({ requestChange: vi.fn().mockResolvedValue(snapshot()) }, 'en');
    useStore.setState({ decisions: [{ ...d, deciderKind: 'architect' }] } as never);
    change(d.id);
    s().submitChange();
    await settles(() => s().toast === 'Change Request submitted for the architect’s re-approval.');
  });

  for (const lang of ['hi', 'gu'] as const) {
    for (const kind of ['client', 'architect', 'pmc'] as const) {
      it(`${lang}: submitted for the ${kind}`, async () => {
        const d = firstDecision();
        connect({ requestChange: vi.fn().mockResolvedValue(snapshot()) }, lang);
        useStore.setState({ decisions: [{ ...d, deciderKind: kind }] } as never);
        change(d.id);
        s().submitChange();
        await settles(() => s().toast !== null && script[lang].test(s().toast!));
        expect(latinLeft(s().toast!)).toEqual([]);
      });
    }

    it(`${lang}: withdrawn`, async () => {
      const d = firstDecision();
      connect({ withdrawChange: vi.fn().mockResolvedValue(snapshot()) }, lang);
      s().withdrawChange(d.id);
      await settles(() => s().toast !== null && script[lang].test(s().toast!));
      expect(latinLeft(s().toast!)).toEqual([]);
    });

    it(`${lang}: the demo change and withdraw lines`, () => {
      const d = firstDecision();
      useStore.setState({ ...getInitialState(), lang });
      change(d.id);
      s().submitChange();
      expect(latinLeft(s().toast!)).toEqual([]);
      s().withdrawChange(d.id);
      expect(latinLeft(s().toast!)).toEqual([]);
    });
  }
});

describe('the project loading and load-failed screen', () => {
  const screen = (state: 'loading' | 'error', error: string | null = null) =>
    render(<ProjectLoadBoundary state={state} error={error} label="Ambli" onRetry={() => {}}><div>body</div></ProjectLoadBoundary>);

  it('English stays as it was', () => {
    useStore.setState({ lang: 'en' });
    expect(screen('loading').container.textContent).toBe('Loading Ambli…Fetching this project’s decisions, schedule and site data.');
    cleanup();
    expect(screen('error').container.textContent).toBe('Couldn’t load this project' + 'Check your connection and access, then retry.' + 'Retry');
    cleanup();
    expect(screen('error', 'HTTP 503').container.textContent).toContain('HTTP 503');
  });

  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: loading, with the project name kept`, () => {
      useStore.setState({ lang });
      const r = screen('loading');
      expect(r.container.textContent).toContain('Ambli');
      expect(leftoverEnglish(r.container, ['Ambli'])).toEqual([]);
    });

    it(`${lang}: failed, and the English server error is not shown`, () => {
      useStore.setState({ lang });
      const r = screen('error', 'Request failed with status 503');
      expect(leftoverEnglish(r.container, [])).toEqual([]);
    });
  }
});
