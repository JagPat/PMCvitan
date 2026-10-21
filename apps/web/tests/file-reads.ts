import { vi } from 'vitest';

/**
 * The drawing viewer reads a PDF revision's file with `fetch` (drawings-offline-viewer). A test about something
 * else holds that read: it is never sent, and it stops when the viewer closes. Any other read fails at once, loudly.
 */
export function holdFileReads(): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (!String(url).includes('/drawings/rev/')) return Promise.reject(new Error(`unexpected read: ${url}`));
    return new Promise<Response>((_, fail) => {
      init?.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
    });
  });
}

/**
 * The same read, answered when the test says so with a small PDF, so the frame (and the title a screen reader says) is
 * on screen, from a blob, with no network. `arrive()` answers every read made so far.
 */
export function answerFileReads(): { arrive: () => void } {
  const waiting: ((res: Response) => void)[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (!String(url).includes('/drawings/rev/')) return Promise.reject(new Error(`unexpected read: ${url}`));
    return new Promise<Response>((answer, fail) => {
      waiting.push(answer);
      init?.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
    });
  });
  URL.createObjectURL = () => `blob:${location.origin}/file`;
  URL.revokeObjectURL = () => {};
  return { arrive: () => { for (const answer of waiting.splice(0)) answer(new Response('%PDF-1.7', { status: 200 })); } };
}

/** Resolves once `find()` returns something in `root`, checked on every change to it: a signal, never a clock. */
export function appears<T>(root: HTMLElement, find: () => T | null | undefined): Promise<T> {
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
