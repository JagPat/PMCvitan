import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Drawing, DrawingRevision } from '@vitan/shared';
import { warmImports } from './warm-imports';
import { holdFileReads } from './file-reads';

/**
 * Each type the API accepts for a drawing previews the way a browser can show it. A CAD type is registered under
 * `image/` too (`image/vnd.dxf`), and an <img> of it shows nothing: it gets the Download link, as a DWG does.
 */

const API = 'http://api.test';
const rev = (mime: string): DrawingRevision => ({
  id: 'a', rev: 'A', status: 'for_construction', mime, url: '/drawings/rev/a?t=tok', sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (r: DrawingRevision): Drawing => ({
  id: 'DWG-1', number: 'A-101', title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft: false, current: r, ackedByMe: false, revisions: [r],
});

async function loadViewer() {
  vi.stubEnv('VITE_API_URL', API);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', short: 'Villa' });
  const { DrawingViewer } = await import('@/screens/DrawingsScreen');
  return DrawingViewer;
}

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DrawingsScreen'));

beforeEach(() => holdFileReads());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Every type the API accepts (`DRAWING_MIMES`), and how the viewer shows it. */
const EXPECTED: Record<string, 'image' | 'pdf' | 'download'> = {
  'application/pdf': 'pdf',
  'image/vnd.dwg': 'download',
  'application/acad': 'download',
  'application/dwg': 'download',
  'image/vnd.dxf': 'download',
  'application/dxf': 'download',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
};

function shownAs(root: HTMLElement): 'image' | 'pdf' | 'download' | 'none' {
  if (root.querySelector('a[download]')) return 'download';
  if (root.querySelector('img')) return 'image';
  if (root.querySelector('iframe, [role="status"]')) return 'pdf';
  return 'none';
}

describe('each drawing type the API accepts previews the way a browser can show it', () => {
  it('this list is exactly the API\'s DRAWING_MIMES', () => {
    const source = readFileSync(resolve(__dirname, '../../api/src/contracts.ts'), 'utf8');
    const list = source.match(/export const DRAWING_MIMES = \[([\s\S]*?)\] as const/)![1];
    expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s is shown as %s', async (mime, kind) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg(rev(mime))} onClose={() => {}} />);
    expect(shownAs(r.container)).toBe(kind);
  });

  it.each(['image/vnd.dwg', 'application/acad', 'application/dwg', 'image/vnd.dxf', 'application/dxf'])('%s says it is a CAD source', async (mime) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg(rev(mime))} onClose={() => {}} />);
    expect(r.container.textContent).toContain('CAD source');
  });

  it.each([
    ['', 'A-101-RevA'], ['image/gif', 'A-101-RevA.gif'], ['image/tiff', 'A-101-RevA.tif'], ['image/heic', 'A-101-RevA.heic'],
    ['image/bmp', 'A-101-RevA.bmp'], ['image/avif', 'A-101-RevA.avif'], ['IMAGE/PNG', 'A-101-RevA.png'], ['text/html', 'A-101-RevA'],
    ['image/gif; charset=x', 'A-101-RevA.gif'], ['IMAGE/SVG+XML', 'A-101-RevA'], ['image/svg+xml; charset=utf-8', 'A-101-RevA'],
    ['text/html; x=dwg', 'A-101-RevA'],
  ])('a type not on the list (%j) gets the Download link, saved as %s', async (mime, name) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg(rev(mime))} onClose={() => {}} />);
    expect(shownAs(r.container)).toBe('download');
    // an image app opens it by its extension (Codex, #1063); a type off the extension list (text/html) gets none
    expect(r.container.querySelector('a[download]')!.getAttribute('download')).toBe(name);
  });

  it.each([
    ['image/vnd.dwg', '.dwg'], ['application/acad', '.dwg'], ['application/dwg', '.dwg'], ['image/vnd.dxf', '.dxf'], ['application/dxf', '.dxf'],
  ])('%s is saved with %s', async (mime, ext) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg(rev(mime))} onClose={() => {}} />);
    expect(r.container.querySelector('a[download]')!.getAttribute('download')).toBe(`A-101-RevA${ext}`);
  });

  it("the demo's SVG sheets still show as images", async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg(rev('image/svg+xml'))} onClose={() => {}} />);
    expect(shownAs(r.container)).toBe('image');
  });
});
