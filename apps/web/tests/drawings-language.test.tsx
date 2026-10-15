import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Drawing, DrawingRevision, Lang, ProjectNode } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 QA item 3 — the Drawings register in Hindi and Gujarati: every state of the screen (loading,
 * unavailable, empty, stale, a consultant's discipline scope, a missing drawing), the open drawing with its
 * acknowledgements, location and history, and the PMC's issue form show no English; what the drawing actions
 * say back follows the language too. English stays as it was. Numbers, titles, revision letters, names and
 * places are project data, shown as recorded.
 */

const rev = (id: string, over: Partial<DrawingRevision> = {}): DrawingRevision => ({
  id, rev: 'B', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=tok`, sizeBytes: 10, note: '',
  issuedBy: 'Asha Mehta', issuedAt: '14 Oct 2026', acks: [{ userName: 'Ravi Patel', role: 'engineer', at: '15 Oct 2026' }],
  recipients: [{ userName: 'Kiran Shah', role: 'contractor', acked: false }] as DrawingRevision['recipients'],
  ...over,
});
const dwg = (id: string, number: string, over: Partial<Drawing> = {}): Drawing => ({
  id, number, title: 'Ground Plan', discipline: 'architectural', zone: 'GF', activityId: 'ACT-3', decisionId: null,
  draft: false, current: rev(`${id}-b`), ackedByMe: false, nodeId: 'z1',
  revisions: [rev(`${id}-b`), rev(`${id}-a`, { rev: 'A', status: 'superseded', mime: 'application/dwg', acks: [] })],
  ...over,
});
const NODES: ProjectNode[] = [{ id: 'z1', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }];

// project data people typed, and the acronyms sites use as they are
const DATA = ['Villa Bodakdev', 'Ground Plan', 'Ground Floor', 'Asha Mehta', 'Ravi Patel', 'Kiran Shah', 'A-101', 'S-201', 'ACT-3', 'GF', 'PMC', 'MEP', 'CAD', 'DWG', 'PDF', 'DWG-404'];
const words = (text: string): string[] => {
  const allow = new Set(DATA.flatMap((a) => a.match(/[A-Za-z]+/g) ?? []));
  return (text.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !allow.has(w));
};

async function load(lang: Lang, over: Record<string, unknown>, { mode = 'snapshot', demo = false } = {}) {
  vi.stubEnv('VITE_API_URL', demo ? '' : 'http://api.test');
  vi.stubEnv('VITE_DRAWINGS_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', short: 'Villa Bodakdev', nodes: NODES, lang,
    ...over,
  });
  const mod = await import('@/screens/DrawingsScreen');
  return { useStore, ...mod };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const STATES: [string, Record<string, unknown>, { mode?: string }?][] = [
  ['loading', { drawings: [], drawingsLoad: 'loading' }, { mode: 'moduleQuery' }],
  ['unavailable', { drawings: [], drawingsLoad: 'error' }, { mode: 'moduleQuery' }],
  ['empty', { drawings: [] }],
  ['the register', { drawings: [dwg('DWG-1', 'A-101'), dwg('DWG-2', 'S-201', { discipline: 'mep', current: null, revisions: [rev('r', { status: 'for_review' })] })] }],
  ['stale last-known register', { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'error' }, { mode: 'moduleQuery' }],
  ['a consultant on their discipline', { role: 'consultant', drawings: [dwg('DWG-1', 'A-101', { discipline: 'structural' })] }],
  ['a consultant whose discipline has none', { role: 'consultant', drawings: [dwg('DWG-1', 'A-101')] }],
  ['a link to a missing drawing', { drawings: [dwg('DWG-1', 'A-101')], routeItem: 'DWG-404' }],
  ['a link while the register loads', { drawings: [], drawingsLoad: 'loading', routeItem: 'DWG-404' }, { mode: 'moduleQuery' }],
  ['the open drawing', { drawings: [dwg('DWG-1', 'A-101')], routeItem: 'DWG-1' }],
  ['the open drawing, acknowledged', { drawings: [dwg('DWG-1', 'A-101', { ackedByMe: true })], routeItem: 'DWG-1' }],
  ['the PMC on the open drawing', { role: 'pmc', drawings: [dwg('DWG-1', 'A-101')], routeItem: 'DWG-1' }],
];

describe('the Drawings register in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const [name, over, opts] of STATES) {
      it(`${lang}, ${name}: no leftover English`, async () => {
        const { DrawingsScreen } = await load(lang, over, opts);
        render(<DrawingsScreen />);
        expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      });
    }

    it(`${lang}: an older revision, the location editor and the issue form`, async () => {
      const { DrawingsScreen } = await load(lang, { role: 'pmc', drawings: [dwg('DWG-1', 'A-101')], routeItem: 'DWG-1' });
      const r = render(<DrawingsScreen />);
      fireEvent.click(r.getByTestId('rev-DWG-1-a')); // the DWG revision: download only
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      fireEvent.click(r.getByTestId('drawing-refile'));
      expect(r.getByTestId('drawing-unfile')).toBeInTheDocument();
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      cleanup();
      const again = await load(lang, { role: 'pmc', drawings: [dwg('DWG-1', 'A-101')] });
      const r2 = render(<again.DrawingsScreen />);
      fireEvent.click(r2.getByTestId('issue-drawing'));
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      // the browser's own file button speaks the browser's language: the app draws its own (Codex, #902)
      expect(r2.getByTestId('issue-drawing-file').style.position).toBe('absolute');
      expect(r2.getByTestId('issue-drawing-file-status').textContent).not.toMatch(/[A-Za-z]/);
    });

    it(`${lang}: what the drawing actions say back`, async () => {
      const said: string[] = [];
      const demo = await load(lang, { drawings: [dwg('DWG-1', 'A-101')] }, { demo: true });
      const s = () => demo.useStore.getState();
      const run = (act: () => void) => { act(); said.push(s().toast ?? ''); };
      run(() => s().acknowledgeDrawing('DWG-1'));
      run(() => s().fileDrawing('DWG-1', 'z1'));
      run(() => s().fileDrawing('DWG-1', null));
      const input = { number: 'A-101', title: 'Ground Plan', discipline: 'architectural' as const, rev: 'C', mime: 'application/pdf', data: 'AA==', status: 'for_construction' as const };
      run(() => s().issueDrawing({ ...input, publish: true }));
      run(() => s().issueDrawing({ ...input, publish: false }));
      const live = await load(lang, { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'loading' }, { mode: 'moduleQuery' });
      const l = () => live.useStore.getState();
      for (const act of [() => l().acknowledgeDrawing('DWG-1'), () => l().fileDrawing('DWG-1', null), () => l().issueDrawing({ ...input, publish: true })]) {
        act();
        said.push(l().toast ?? '');
      }
      // offline: the queued acknowledgement and re-file say so in the language
      live.useStore.setState({ drawingsLoad: 'ready', online: false });
      for (const act of [() => l().acknowledgeDrawing('DWG-1'), () => l().fileDrawing('DWG-1', 'z1')]) {
        act();
        said.push(l().toast ?? '');
      }
      expect(said.filter((t) => !t)).toEqual([]);
      for (const t of said) expect(words(t)).toEqual([]);
    });
  }

  it('the served dates read in the language; English keeps the server\'s string', async () => {
    const { drawingDateIn } = await import('@vitan/shared');
    expect(drawingDateIn('14 Oct 2026', 'en')).toBe('14 Oct 2026');
    for (const lang of ['hi', 'gu'] as const) {
      // the month name comes from the browser's own calendar data, so only its language is checked
      expect(drawingDateIn('14 Oct 2026', lang)).toMatch(/^14 .+ 2026$/);
      expect(words(drawingDateIn('14 Oct 2026', lang))).toEqual([]);
    }
    expect(drawingDateIn('sometime', 'gu')).toBe('sometime');
  });

  it('English reads as before', async () => {
    const { DrawingsScreen } = await load('en', { drawings: [dwg('DWG-1', 'A-101')], routeItem: 'DWG-1' });
    render(<DrawingsScreen />);
    const text = document.body.textContent ?? '';
    for (const line of ['DRAWINGS · REGISTER', 'Rev B · issued by Asha Mehta · 14 Oct 2026', 'BUILDING TO REV B', 'Issued to — not yet confirmed', 'I’m building to Rev B', 'REVISION HISTORY', 'Engineer', 'Contractor', '15 Oct 2026']) {
      expect(text).toContain(line);
    }
    const { returnToPlaceText } = await import('@vitan/shared');
    expect(returnToPlaceText(null, 'en')).toBe('← Back to the Site Map');
    expect(returnToPlaceText('Kitchen', 'en')).toBe('← Back to Kitchen');
    expect(words(returnToPlaceText(null, 'hi'))).toEqual([]);
    expect(words(returnToPlaceText(null, 'gu'))).toEqual([]);
  });
});
