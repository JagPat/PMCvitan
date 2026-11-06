import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { resolveMediaUrl } from '@/data/apiGateway';

/** A moment of silence, played on the Play tap itself. An iPhone lets a player sound only once it has been played from a
 *  tap, and the file is fetched after the tap, so the same player is started on the tap and then given the file. */
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

/** Play `el`. A browser that still will not start it (the tap was not enough) leaves its controls on screen, ready for
 *  the person to start it from there. */
function tryPlay(el: HTMLMediaElement) {
  try {
    void el.play()?.catch(() => {});
  } catch {
    // as above
  }
}

/** The fetched file's bytes, reading them as they come so `progress` hears whole percents (never 100 until they are all
 *  in) when the answer says how large the file is; an answer with no size, or no stream to read, is read whole. */
async function fileOf(r: Response, progress: (pct: number) => void): Promise<Blob> {
  const total = Number(r.headers?.get?.('content-length') ?? 0);
  const reader = r.body?.getReader?.();
  if (!reader || !Number.isFinite(total) || total <= 0) return r.blob();
  const parts: Uint8Array[] = [];
  let got = 0;
  let said = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    const pct = Math.min(99, Math.floor((got * 100) / total));
    if (pct !== said) { said = pct; progress(pct); }
  }
  return new Blob(parts as BlobPart[], { type: r.headers.get('content-type') ?? '' });
}

/**
 * Stage 1 voice notes: plays a recorded visit file, a voice note (and a video clip the same way, V2). A stored file is
 * fetched whole on Play and played from the phone's own copy (an object URL): `/media` serves no byte ranges, and
 * iPhone browsers play media only from a source that does. A file still waiting on the phone (a `data:` URL) plays as
 * it is. The fetch sends no credentials: the signed link is the permission. The copy is let go when the player goes. A
 * file this browser cannot play says so, with Try again. A video clip with a still frame (#995 V2b-2) shows it above
 * Play, and the player shows it until the clip plays; a frame that does not load is left out until a fresh link
 * for it comes.
 */
export function MediaPlayer({ url, mime, label, words, poster }: {
  url: string;
  mime: string;
  /** a video clip's still frame, its own signed link */
  poster?: string;
  /** what the file is, for a screen reader */
  label: string;
  words: { play: string; failed: string; retry: string };
}) {
  const local = url.startsWith('data:');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>(local ? 'ready' : 'idle');
  // #995 V2f: how much of the file has come, in whole percent, while it is fetched (when the answer says its size)
  const [loaded, setLoaded] = useState<number | null>(null);
  // the frame link that did not load: a fresh link (a later read signs a new one) is tried again
  const [posterGone, setPosterGone] = useState<string | null>(null);
  const media = useRef<HTMLMediaElement | null>(null);
  const run = useRef<AbortController | null>(null);
  const owned = useRef<string | null>(null);
  // a file still on the phone that the server has since taken plays from its new link only when asked
  useEffect(() => { if (local) setPhase('ready'); }, [local, url]);
  useEffect(() => () => {
    run.current?.abort();
    if (owned.current) URL.revokeObjectURL(owned.current);
  }, []);

  const load = async () => {
    run.current?.abort();
    const ctrl = new AbortController();
    run.current = ctrl;
    // on the tap itself, before anything is fetched
    const el = media.current;
    if (el) {
      el.src = SILENCE;
      tryPlay(el);
    }
    setPhase('loading');
    setLoaded(null);
    try {
      const r = await fetch(resolveMediaUrl(url), { signal: ctrl.signal, credentials: 'omit' });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await fileOf(r, (pct) => { if (run.current === ctrl) setLoaded(pct); });
      if (ctrl.signal.aborted) return;
      if (owned.current) URL.revokeObjectURL(owned.current);
      // typed as the file is, so the browser knows how to play it whatever the bucket answered with
      owned.current = URL.createObjectURL(blob.type === mime ? blob : blob.slice(0, blob.size, mime));
      setPhase('ready');
      if (el) {
        el.src = owned.current;
        tryPlay(el);
      }
    } catch {
      if (!ctrl.signal.aborted) setPhase('failed');
    }
  };
  // a file this browser cannot play (another browser's format, or damaged) says so rather than leaving a player that
  // does nothing; the silence played on the tap is not the file
  const failed = () => { if (phase === 'ready') setPhase('failed'); };
  const Player = mime.startsWith('video/') ? 'video' : 'audio';
  const still = Player === 'video' && poster && posterGone !== poster ? resolveMediaUrl(poster) : null;
  const play = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Button variant="light" disabled={phase === 'loading'} aria-label={`${words.play}: ${label}`} onClick={() => void load()}>
        {words.play}
      </Button>
      {/* a progress bar, not a live region: a screen reader is not read every percent */}
      {phase === 'loading' && loaded !== null && (
        <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={loaded} aria-label={`${label}: ${loaded}%`}>{loaded}%</span>
      )}
    </span>
  );

  return (
    <>
      <Player
        ref={(el: HTMLMediaElement | null) => { media.current = el; }}
        controls preload={local ? 'metadata' : 'none'} {...(Player === 'video' ? { playsInline: true } : {})} {...(still ? { poster: still } : {})}
        hidden={phase !== 'ready'} aria-label={label} onError={failed}
        {...(local ? { src: url } : {})}
      />
      {phase === 'failed' && (
        <span role="status">
          {words.failed} <Button variant="light" onClick={() => void load()}>{words.retry}</Button>
        </span>
      )}
      {(phase === 'idle' || phase === 'loading') && (still ? (
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          <img
            src={still} alt="" loading="lazy" onError={() => setPosterGone(poster ?? null)}
            style={{ display: 'block', width: 240, maxWidth: '100%', borderRadius: 10, background: '#000' }}
          />
          {play}
        </span>
      ) : play)}
    </>
  );
}
