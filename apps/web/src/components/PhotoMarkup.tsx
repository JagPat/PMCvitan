import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Lang } from '@vitan/shared';
import { Button } from './Button';
import { Modal } from './Modal';
import {
  MK, MARKUP_COLOURS, drawShape, fitWithin, isMeaningful, penWidth,
  type MarkupColour, type MarkupShape, type MarkupTool, type Point,
} from '@/lib/photoMarkup';

/** What a save hands back: the marked copy as a JPEG, base64 without a `data:` prefix, ready for the upload. */
export interface MarkedCopy {
  mime: 'image/jpeg';
  data: string;
}

/** The upload's own ceiling on base64 (`MAX_MEDIA_BASE64` in the API's contracts); a copy over it is saved smaller. */
const MAX_BASE64 = 14_000_000;

const TOOLS: MarkupTool[] = ['arrow', 'circle', 'line', 'text'];
const COLOURS: MarkupColour[] = ['red', 'yellow'];

/** Reads a stored photo's bytes (a signed file path) or takes a picked file's, as a blob drawn from this page's own
 *  object URL, so the canvas is never tainted by another origin and the copy can be exported. */
async function loadPhoto(source: Blob | string): Promise<HTMLImageElement> {
  const blob = typeof source === 'string' ? await fetch(source).then((r) => {
    if (!r.ok) throw new Error(`photo ${r.status}`);
    return r.blob();
  }) : source;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('photo did not decode'));
      img.src = url;
    });
  } finally {
    // the decoded image keeps its pixels once loaded
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Stage 1 photo markup: draw arrows, circles, lines and short labels on a photo, in red or yellow, with undo, and save
 * the result as a NEW copy. The photo passed in is never changed. The caller sends the copy (naming the original) and
 * closes the editor; a save that fails leaves the drawing in place to try again.
 */
export function PhotoMarkup({ source, lang, busy = false, onSave, onCancel }: {
  /** A picked file, or a stored photo's resolved URL. */
  source: Blob | string;
  lang: Lang;
  /** True while the caller is sending a saved copy: Save is held. */
  busy?: boolean;
  onSave: (copy: MarkedCopy) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<MarkupTool>('arrow');
  const [colour, setColour] = useState<MarkupColour>('red');
  const [label, setLabel] = useState('');
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const [hint, setHint] = useState('');

  useEffect(() => {
    let live = true;
    setFailed(false);
    loadPhoto(source).then((img) => {
      if (!live) return;
      setPhoto(img);
      setSize(fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height));
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [source]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !photo || !size) return;
    ctx.drawImage(photo, 0, 0, size.width, size.height);
    const w = penWidth(size.width, size.height);
    for (const s of draft ? [...shapes, draft] : shapes) drawShape(ctx, s, w);
  }, [photo, size, shapes, draft]);
  useEffect(redraw, [redraw]);

  /** Where a pointer is, in the photo's own pixels (the canvas is shown scaled to the screen). */
  const at = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = e.currentTarget;
    const r = canvas.getBoundingClientRect();
    const kx = r.width ? canvas.width / r.width : 1;
    const ky = r.height ? canvas.height / r.height : 1;
    return { x: Math.round((e.clientX - r.left) * kx), y: Math.round((e.clientY - r.top) * ky) };
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = at(e);
    setHint('');
    if (tool === 'text') {
      if (label.trim() === '') { setHint(MK.labelHint[lang]); return; }
      setShapes((xs) => [...xs, { tool: 'text', colour, at: p, text: label.trim() }]);
      setLabel('');
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDraft(tool === 'line' ? { tool, colour, points: [p] } : { tool, colour, from: p, to: p });
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const p = at(e);
    setDraft(draft.tool === 'line' ? { ...draft, points: [...draft.points, p] } : draft.tool === 'text' ? draft : { ...draft, to: p });
  };
  const up = () => {
    if (draft && isMeaningful(draft)) setShapes((xs) => [...xs, draft]);
    setDraft(null);
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (shapes.length === 0) { setHint(MK.nothing[lang]); return; }
    let data = '';
    for (const quality of [0.85, 0.7, 0.5]) {
      data = canvas.toDataURL('image/jpeg', quality).replace(/^data:[^,]*,/, '');
      if (data.length <= MAX_BASE64) break;
    }
    onSave({ mime: 'image/jpeg', data });
  };

  return (
    <Modal onClose={onCancel} maxWidth={760} labelledBy="photo-markup-title">
      <div style={{ padding: 16, display: 'grid', gap: 10 }}>
        <h2 id="photo-markup-title" style={{ margin: 0, fontSize: 18 }}>{MK.title[lang]}</h2>
        <div role="toolbar" aria-label={MK.title[lang]} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TOOLS.map((t) => (
            <Button key={t} variant={tool === t ? 'ink' : 'light'} aria-pressed={tool === t} onClick={() => { setTool(t); setHint(''); }}>{MK[t][lang]}</Button>
          ))}
          {COLOURS.map((c) => (
            <Button key={c} variant={colour === c ? 'ink' : 'light'} aria-pressed={colour === c} onClick={() => setColour(c)}>
              <span aria-hidden style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: MARKUP_COLOURS[c], marginRight: 6 }} />
              {MK[c][lang]}
            </Button>
          ))}
          <Button variant="light" disabled={shapes.length === 0} onClick={() => setShapes((xs) => xs.slice(0, -1))}>{MK.undo[lang]}</Button>
        </div>
        {tool === 'text' && (
          <input
            aria-label={MK.label[lang]} placeholder={MK.labelHint[lang]} value={label} maxLength={60}
            onChange={(e) => setLabel(e.target.value)} style={{ minHeight: 44, padding: '0 10px', borderRadius: 10, border: '1px solid rgba(35,33,28,.25)' }}
          />
        )}
        {failed ? (
          <div role="alert">{MK.cannotOpen[lang]}</div>
        ) : !size ? (
          <div>{MK.loading[lang]}</div>
        ) : (
          <canvas
            ref={canvasRef} width={size.width} height={size.height} data-testid="photo-markup-canvas"
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            style={{ width: '100%', height: 'auto', touchAction: 'none', borderRadius: 10, background: '#000' }}
          />
        )}
        {hint && <div role="status">{hint}</div>}
        <div style={{ fontSize: 13, opacity: 0.75 }}>{MK.original[lang]}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="light" onClick={onCancel}>{MK.cancel[lang]}</Button>
          <Button variant="ink" disabled={busy || !size || failed} onClick={save}>{MK.save[lang]}</Button>
        </div>
      </div>
    </Modal>
  );
}
