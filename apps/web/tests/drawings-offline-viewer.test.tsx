import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Drawing, DrawingRevision } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * A PDF or CAD drawing opens offline. The viewer's <iframe> and download link used to point at the API's file URL, and
 * opening that is a navigation to the API, which this site's service worker never sees: the copy the worker kept for
 * offline could not be reached. The viewer now reads the file with `fetch` (which the worker answers, from its kept copy
 * when offline) and shows it from a `blob:` URL of a fixed type. A read that fails or is refused falls back to the file's
 * own URL, as before.
 */

const API = 'http://api.test';
const rev = (id: string, mime: string, url = `/drawings/rev/${id}?t=tok`): DrawingRevision => ({
  id, rev: id.toUpperCase(), status: 'for_construction', mime, url, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (revisions: DrawingRevision[]): Drawing => ({
  id: 'DWG-1', number: 'A-101', title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft: false, current: revisions[0], ackedByMe: false, revisions,
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

/** Resolves once `find()` returns something in `root`, checked on every change to it: a signal, never a clock. */
function appears<T>(root: HTMLElement, find: () => T | null | undefined): Promise<T> {
  return new Promise((done) => {
    const now = find();
    if (now) { done(now); return; }
    const watch = new MutationObserver(() => {
      const found = find();
      if (found) { watch.disconnect(); done(found); }
    });
    watch.observe(root, { subtree: true, childList: true, attributes: true });
  });
}

type Read = { url: string; init: RequestInit; answer: (res: Response) => void; fail: (e: Error) => void };
let reads: Read[];
let made: { url: string; blob: Blob }[];
let revoked: string[];

beforeEach(() => {
  vi.unstubAllEnvs();
  reads = [];
  made = [];
  revoked = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    new Promise<Response>((answer, fail) => {
      reads.push({ url, init, answer, fail });
      init.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
    }));
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:${location.origin}/file-${(n += 1)}`;
    made.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const iframeOf = (root: HTMLElement) => root.querySelector('iframe');

describe('a PDF drawing is read through the service worker and shown from a blob', () => {
  it('reads the file with fetch, without cookies, and shows it as a PDF whatever type the server gave', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    // nothing points at the API while the file is read
    expect(iframeOf(r.container)).toBeNull();
    expect(reads.map((x) => x.url)).toEqual([`${API}/drawings/rev/a?t=tok`]);
    expect(reads[0].init.credentials).toBe('omit');
    await act(async () => reads[0].answer(new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(made[0].url);
    expect(made[0].blob.type).toBe('application/pdf');
    expect(await made[0].blob.text()).toBe('%PDF-1.7');
  });

  it('offline with nothing kept (the read fails), the viewer falls back to the file URL, as before', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].fail(new TypeError('Failed to fetch')));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(made).toEqual([]);
  });

  it.each([403, 404, 500])('a refused read (%i) falls back to the file URL, and no blob is made', async (status) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response('nope', { status })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(made).toEqual([]);
  });

  it('closing the viewer lets the blob go', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response('%PDF', { status: 200 })));
    await appears(r.container, () => iframeOf(r.container));
    r.unmount();
    expect(revoked).toEqual([made[0].url]);
  });

  it('closing the viewer while the file is still read stops the read, and makes no blob', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    const signal = reads[0].init.signal!;
    r.unmount();
    expect(signal.aborted).toBe(true);
    expect(made).toEqual([]);
  });

  it('closing the viewer while the file\'s bytes are still arriving makes no blob from them', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    let deliver!: (bytes: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>((done) => { deliver = done; });
    // the server has answered; its body has not all arrived
    await act(async () => reads[0].answer({ ok: true, status: 200, arrayBuffer: () => bytes } as unknown as Response));
    r.unmount();
    // the viewer's own step after the bytes runs before this await returns: it was waiting on them first
    await act(async () => { deliver(new TextEncoder().encode('%PDF').buffer); await bytes; });
    expect(made).toEqual([]);
  });

  it('opening another revision lets the last blob go and shows only the new one', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('b', 'application/pdf'), rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response('rev b', { status: 200 })));
    await appears(r.container, () => iframeOf(r.container));
    fireEvent.click(r.getByText(/Rev A\b/));
    expect(revoked).toEqual([made[0].url]);
    // the old blob is not shown while the new revision is read
    expect(iframeOf(r.container)).toBeNull();
    expect(reads[1].url).toBe(`${API}/drawings/rev/a?t=tok`);
    await act(async () => reads[1].answer(new Response('rev a', { status: 200 })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(made[1].url);
    expect(await made[1].blob.text()).toBe('rev a');
  });
});

describe('a CAD drawing downloads from a blob, and an image is shown as it was', () => {
  it('the download link points at a blob of plain bytes once the file is read', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'image/vnd.dwg')])} onClose={() => {}} />);
    const link = () => r.container.querySelector('a[download]');
    // until then, the file's own URL, as before
    expect(link()!.getAttribute('href')).toBe(`${API}/drawings/rev/a?t=tok`);
    await act(async () => reads[0].answer(new Response('AC1032', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    await appears(r.container, () => (link()!.getAttribute('href')!.startsWith('blob:') ? link() : null));
    expect(link()!.getAttribute('href')).toBe(made[0].url);
    expect(made[0].blob.type).toBe('application/octet-stream');
  });

  it('an image is shown from its URL, with no read of its own (the worker answers the <img>)', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'image/png')])} onClose={() => {}} />);
    expect(r.container.querySelector('img')!.getAttribute('src')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(reads).toEqual([]);
  });

  it("a demo drawing's data: URL is shown as it is, with no read", async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf', 'data:application/pdf;base64,JVBERg==')])} onClose={() => {}} />);
    expect(iframeOf(r.container)!.getAttribute('src')).toBe('data:application/pdf;base64,JVBERg==');
    expect(reads).toEqual([]);
  });
});
