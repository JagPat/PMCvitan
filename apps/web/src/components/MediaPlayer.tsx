import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { resolveMediaUrl } from '@/data/apiGateway';

/**
 * Stage 1 voice notes: plays a recorded visit file, a voice note (and a video clip the same way, V2). A stored file is
 * fetched whole on Play and played from the phone's own copy (an object URL): `/media` serves no byte ranges, and
 * iPhone browsers play media only from a source that does. A file still waiting on the phone (a `data:` URL) plays as
 * it is. The fetch sends no credentials: the signed link is the permission. The copy is let go when the player goes.
 */
export function MediaPlayer({ url, mime, label, words }: {
  url: string;
  mime: string;
  /** what the file is, for a screen reader */
  label: string;
  words: { play: string; failed: string; retry: string };
}) {
  const local = url.startsWith('data:');
  const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'failed' } | { phase: 'ready'; src: string }>(
    local ? { phase: 'ready', src: url } : { phase: 'idle' },
  );
  const run = useRef<AbortController | null>(null);
  const owned = useRef<string | null>(null);
  // a file still on the phone that the server has since taken plays from its new link only when asked
  useEffect(() => { if (local) setState({ phase: 'ready', src: url }); }, [local, url]);
  useEffect(() => () => {
    run.current?.abort();
    if (owned.current) URL.revokeObjectURL(owned.current);
  }, []);

  const load = async () => {
    run.current?.abort();
    const ctrl = new AbortController();
    run.current = ctrl;
    setState({ phase: 'loading' });
    try {
      const r = await fetch(resolveMediaUrl(url), { signal: ctrl.signal, credentials: 'omit' });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      if (ctrl.signal.aborted) return;
      if (owned.current) URL.revokeObjectURL(owned.current);
      // typed as the file is, so the browser knows how to play it whatever the bucket answered with
      owned.current = URL.createObjectURL(blob.type === mime ? blob : blob.slice(0, blob.size, mime));
      setState({ phase: 'ready', src: owned.current });
    } catch {
      if (!ctrl.signal.aborted) setState({ phase: 'failed' });
    }
  };

  if (state.phase === 'ready') {
    return mime.startsWith('video/')
      ? <video controls playsInline preload="metadata" src={state.src} aria-label={label} />
      : <audio controls preload="metadata" autoPlay={!local} src={state.src} aria-label={label} />;
  }
  if (state.phase === 'failed') {
    return (
      <span role="status">
        {words.failed} <Button variant="light" onClick={() => void load()}>{words.retry}</Button>
      </span>
    );
  }
  return (
    <Button variant="light" disabled={state.phase === 'loading'} aria-label={`${words.play}: ${label}`} onClick={() => void load()}>
      {words.play}
    </Button>
  );
}
