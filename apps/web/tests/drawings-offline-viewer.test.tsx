import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Drawing, DrawingRevision } from '@vitan/shared';
import { warmImports } from './warm-imports';
import { appears } from './file-reads';

/**
 * A PDF or CAD drawing opens offline. The viewer's <iframe> and download link used to point at the API's file URL, and
 * opening that is a navigation to the API, which this site's service worker never sees: the copy the worker kept for
 * offline could not be reached. The viewer now reads a PDF with `fetch` (which the worker answers, from its kept copy
 * when offline) and shows it from a `blob:` URL typed as a PDF; a CAD file is read the same way when Download is tapped
 * and saved from a blob with its extension. A read that fails or is refused falls back to the file's own URL, as before.
 */

const API = 'http://api.test';
const PDF = '%PDF-1.7';
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

type Read = { url: string; init: RequestInit; answer: (res: Response) => void; fail: (e: Error) => void };
let reads: Read[];
let made: { url: string; blob: Blob }[];
let revoked: string[];
/** Each link the viewer clicked to save a file: where it pointed, and the name it saves under. */
let saved: { href: string; download: string }[];
/** Resolves on the next save, so a test waits on the click itself. */
let nextSave: Promise<void>;

beforeEach(() => {
  vi.unstubAllEnvs();
  reads = [];
  made = [];
  revoked = [];
  saved = [];
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
  let onSave = () => {};
  nextSave = new Promise((done) => { onSave = done; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.getAttribute('href')!, download: this.download });
    onSave();
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    await act(async () => reads[0].answer(new Response(PDF, { status: 200, headers: { 'Content-Type': 'text/html' } })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(made[0].url);
    expect(made[0].blob.type).toBe('application/pdf');
    expect(await made[0].blob.text()).toBe(PDF);
  });

  it('says the drawing is opening while the file is read, and not once it shows', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    expect(r.getByRole('status').textContent).toBe('Opening the drawing…');
    await act(async () => reads[0].answer(new Response(PDF, { status: 200 })));
    await appears(r.container, () => iframeOf(r.container));
    expect(r.queryByText('Opening the drawing…')).toBeNull();
  });

  it('offline with nothing kept (the read fails), the viewer falls back to the file URL, as before', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].fail(new TypeError('Failed to fetch')));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(made).toEqual([]);
  });

  it.each([403, 404, 500])('a refused read (%i) falls back to the file URL, and no blob is made, whatever its body', async (status) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response(PDF, { status })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(made).toEqual([]);
  });

  it('bytes that are not a PDF never become a blob on this origin: the viewer falls back to the file URL', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response('<html><script>parent.x=1</script></html>', { status: 200 })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(made).toEqual([]);
  });

  it('closing the viewer lets the blob go', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response(PDF, { status: 200 })));
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

  it("closing the viewer while the file's bytes are still arriving makes no blob from them", async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    let deliver!: (file: Blob) => void;
    const file = new Promise<Blob>((done) => { deliver = done; });
    // the server has answered; its body has not all arrived
    await act(async () => reads[0].answer({ ok: true, status: 200, blob: () => file } as unknown as Response));
    r.unmount();
    // the viewer's own step after the bytes runs before this await returns: it was waiting on them first
    await act(async () => { deliver(new Blob([PDF])); await file; });
    expect(made).toEqual([]);
  });

  it("closing the viewer while the file's header is still checked makes no blob", async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/pdf')])} onClose={() => {}} />);
    let header!: (text: string) => void;
    const held = new Promise<string>((done) => { header = done; });
    const file = new Blob([PDF]);
    const slice = file.slice.bind(file);
    let headerRead!: () => void;
    const headerAsked = new Promise<void>((done) => { headerRead = done; });
    file.slice = ((start?: number, end?: number, type?: string) => {
      if (end === 1024) { headerRead(); return { text: () => held } as unknown as Blob; }
      return slice(start, end, type);
    }) as Blob['slice'];
    await act(async () => reads[0].answer({ ok: true, status: 200, blob: async () => file } as unknown as Response));
    await headerAsked;
    r.unmount();
    await act(async () => { header(PDF); await held; });
    expect(made).toEqual([]);
  });

  it('opening another revision lets the last blob go and shows only the new one', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('b', 'application/pdf'), rev('a', 'application/pdf')])} onClose={() => {}} />);
    await act(async () => reads[0].answer(new Response(`${PDF} rev b`, { status: 200 })));
    await appears(r.container, () => iframeOf(r.container));
    fireEvent.click(r.getByText(/Rev A\b/));
    expect(revoked).toEqual([made[0].url]);
    // the old blob is not shown while the new revision is read
    expect(iframeOf(r.container)).toBeNull();
    expect(reads[1].url).toBe(`${API}/drawings/rev/a?t=tok`);
    await act(async () => reads[1].answer(new Response(`${PDF} rev a`, { status: 200 })));
    const frame = await appears(r.container, () => iframeOf(r.container));
    expect(frame.getAttribute('src')).toBe(made[1].url);
    expect(await made[1].blob.text()).toBe(`${PDF} rev a`);
  });
});

describe('a CAD drawing is read only when Download is tapped, and an image is shown as it was', () => {
  const linkOf = (root: HTMLElement) => root.querySelector('a[download]')!;

  it('opening a CAD revision reads nothing; its link names the file with its extension', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'image/vnd.dwg')])} onClose={() => {}} />);
    expect(reads).toEqual([]);
    expect(linkOf(r.container).getAttribute('href')).toBe(`${API}/drawings/rev/a?t=tok`);
    expect(linkOf(r.container).getAttribute('download')).toBe('A-101-RevA.dwg');
  });

  it('tapping Download reads the file without cookies and saves a blob of plain bytes as A-101-RevA.dwg', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'image/vnd.dwg')])} onClose={() => {}} />);
    // the let-go is scheduled, not run: the test runs it itself, so no clock is waited on
    const letGo: { run: () => void; ms: number | undefined }[] = [];
    const schedule = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((run: () => void, ms?: number) => {
      if (ms === 60_000) { letGo.push({ run, ms }); return 0; }
      return schedule(run, ms);
    }) as typeof window.setTimeout);
    fireEvent.click(linkOf(r.container));
    expect(reads.map((x) => [x.url, x.init.credentials])).toEqual([[`${API}/drawings/rev/a?t=tok`, 'omit']]);
    await act(async () => reads[0].answer(new Response('AC1032', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    await nextSave;
    expect(saved).toEqual([{ href: made[0].url, download: 'A-101-RevA.dwg' }]);
    expect(made[0].blob.type).toBe('application/octet-stream');
    expect(await made[0].blob.text()).toBe('AC1032');
    // a browser that reads the blob after the click still finds it (Codex, #1057); it is let go a minute later
    expect(revoked).toEqual([]);
    expect(letGo.length).toBe(1);
    letGo[0].run();
    expect(revoked).toEqual([made[0].url]);
  });

  it('a second tap while the file is read makes no second read, and the viewer says the file is coming', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'image/vnd.dwg')])} onClose={() => {}} />);
    fireEvent.click(linkOf(r.container));
    fireEvent.click(linkOf(r.container));
    expect(reads.length).toBe(1);
    expect(r.getByRole('status').textContent).toBe('Getting the file…');
    await act(async () => reads[0].answer(new Response('AC1032', { status: 200 })));
    await nextSave;
    await appears(r.container, () => (r.queryByRole('status') ? null : true));
    expect(saved.length).toBe(1);
  });

  it('a DXF file keeps its own extension', async () => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'application/dxf')])} onClose={() => {}} />);
    expect(linkOf(r.container).getAttribute('download')).toBe('A-101-RevA.dxf');
  });

  it.each([
    ['offline with nothing kept', (x: Read) => x.fail(new TypeError('Failed to fetch'))],
    ['a refused read', (x: Read) => x.answer(new Response('AC1032', { status: 403 }))],
  ])('%s: the tap goes to the file URL, as before, and no blob is made', async (_, end) => {
    const DrawingViewer = await loadViewer();
    const r = render(<DrawingViewer drawing={dwg([rev('a', 'image/vnd.dwg')])} onClose={() => {}} />);
    fireEvent.click(linkOf(r.container));
    await act(async () => end(reads[0]));
    await nextSave;
    expect(saved).toEqual([{ href: `${API}/drawings/rev/a?t=tok`, download: 'A-101-RevA.dwg' }]);
    expect(made).toEqual([]);
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
