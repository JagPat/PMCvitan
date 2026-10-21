import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Lang } from '@vitan/shared';
import { Button } from './Button';
import { Modal } from './Modal';
import {
  MK, MARKUP_COLOURS, drawShape, fitLabel, fitWithin, isMeaningful, labelFont, penWidth,
  type MarkupColour, type MeasureLabel, type MarkupShape, type MarkupTool, type Point,
} from '@/lib/photoMarkup';
import { MAX_PHOTO_BASE64 } from '@/lib/shrinkPhoto';

/** What a save hands back: the marked copy as a JPEG, base64 without a `data:` prefix, ready for the upload. */
export interface MarkedCopy {
  mime: 'image/jpeg';
  data: string;
}

/** The largest copy the upload takes: the API's 12 MiB body limit refuses a larger body whole (413) before its own
 *  ceiling (`MAX_MEDIA_BASE64`, 14,000,000) is reached (M3); a copy over it is saved smaller. */
const MAX_BASE64 = MAX_PHOTO_BASE64;

const TOOLS: MarkupTool[] = ['arrow', 'circle', 'line', 'text'];
const COLOURS: MarkupColour[] = ['red', 'yellow'];

/** Reads a stored photo's bytes (a signed file path) or takes a picked file's, as a blob drawn from this page's own
 *  object URL, so the canvas is never tainted by another origin and the copy can be exported. */
async function fetchPhoto(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`photo ${r.status}`);
  return r.blob();
}

/** The photo's bytes arrived but did not decode: `heic` when it is an iPhone HEIC or HEIF photo (by its type or file
 *  name), which only some browsers decode (#1006); otherwise the file itself is damaged or is not a photo (#1007). */
class UndecodablePhoto extends Error {
  readonly heic: boolean;
  constructor(heic: boolean) {
    super('photo did not decode');
    this.heic = heic;
  }
}

function isHeic(blob: Blob): boolean {
  if (/^image\/hei[cf]$/i.test(blob.type)) return true;
  return blob instanceof File && /\.hei[cf]$/i.test(blob.name);
}

/** A stored photo's signed URL can expire while the page stays open; `refresh` mints a fresh one for a single retry. */
async function loadPhoto(source: Blob | string, refresh?: () => Promise<string>): Promise<HTMLImageElement> {
  let blob: Blob;
  if (typeof source !== 'string') blob = source;
  else {
    try {
      blob = await fetchPhoto(source);
    } catch (e) {
      if (!refresh) throw e;
      blob = await fetchPhoto(await refresh());
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new UndecodablePhoto(isHeic(blob)));
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
export function PhotoMarkup({ source, refreshSource, lang, busy = false, notice, onSave, onCancel }: {
  /** A picked file, or a stored photo's resolved URL. */
  source: Blob | string;
  /** For a stored photo: a fresh signed URL, asked for once if `source` no longer opens (it expires). */
  refreshSource?: () => Promise<string>;
  lang: Lang;
  /** True while the caller is sending a saved copy: Save is held and the photo takes no new marks, so nothing drawn
   *  after the copy was taken can be lost when the caller closes the editor. */
  busy?: boolean;
  /** What the caller says about the last save, such as why the copy was not kept (M3); shown in the editor, over the
   *  page that would otherwise carry it. */
  notice?: string | null;
  onSave: (copy: MarkedCopy) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  // why the photo did not open: its link or the signal, a type this device cannot decode, or a file that is not a photo
  const [failed, setFailed] = useState<false | 'open' | 'decode' | 'read'>(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<MarkupTool>('arrow');
  const [colour, setColour] = useState<MarkupColour>('red');
  const [label, setLabel] = useState('');
  const [shapes, setShapes] = useState<MarkupShape[]>([]);
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const [hint, setHint] = useState('');
  // the gesture being drawn and the one pointer drawing it; other fingers are ignored until it ends
  const gesture = useRef<{ pointerId: number | null; shape: MarkupShape } | null>(null);
  // where the keyboard marker is, in the photo's own pixels; shown only while the photo has keyboard focus
  const [cursor, setCursor] = useState<Point | null>(null);
  const refreshRef = useRef(refreshSource);
  refreshRef.current = refreshSource;

  const setGesture = (g: { pointerId: number | null; shape: MarkupShape } | null) => {
    gesture.current = g;
    setDraft(g ? g.shape : null);
  };

  useEffect(() => {
    let live = true;
    // a new photo starts clean: nothing from the last one can be saved or drawn onto this one
    setFailed(false);
    setPhoto(null);
    setSize(null);
    setShapes([]);
    setLabel('');
    setHint('');
    setCursor(null);
    setGesture(null);
    loadPhoto(source, refreshRef.current).then((img) => {
      if (!live) return;
      setPhoto(img);
      setSize(fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height));
    }, (e: unknown) => { if (live) setFailed(e instanceof UndecodablePhoto ? (e.heic ? 'decode' : 'read') : 'open'); });
    return () => { live = false; };
  }, [source]);

  /** Paints the photo and these shapes onto the canvas. */
  const paint = useCallback((xs: MarkupShape[]) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !photo || !size) return false;
    // cleared first: a see-through photo would otherwise keep a mark that was undone
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.drawImage(photo, 0, 0, size.width, size.height);
    const w = penWidth(size.width, size.height);
    for (const s of xs) drawShape(ctx, s, w);
    return true;
  }, [photo, size]);
  useEffect(() => { paint(draft ? [...shapes, draft] : shapes); }, [paint, shapes, draft]);

  /** Where a pointer is, in the photo's own pixels (the canvas is shown scaled to the screen). */
  const at = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const canvas = e.currentTarget;
    const r = canvas.getBoundingClientRect();
    const kx = r.width ? canvas.width / r.width : 1;
    const ky = r.height ? canvas.height / r.height : 1;
    return { x: Math.round((e.clientX - r.left) * kx), y: Math.round((e.clientY - r.top) * ky) };
  };

  /** A mark starts here: a label is placed at once; any other tool starts a gesture. */
  const begin = (p: Point, pointerId: number | null): boolean => {
    setHint('');
    if (tool === 'text') {
      if (label.trim() === '') { setHint(MK.labelHint[lang]); return false; }
      const text = label.trim();
      // a label goes where it is placed, moved in from the edges (and drawn smaller if long) so all of it stays on the photo
      const ctx = canvasRef.current?.getContext('2d');
      // measured on the canvas in the font it is drawn in; the estimate is only for a canvas that cannot measure
      const measure: MeasureLabel | undefined = ctx && typeof ctx.measureText === 'function'
        ? (t, px) => {
          ctx.font = labelFont(px);
          ctx.textBaseline = 'middle';
          const m = ctx.measureText(t);
          // the painted ink where the canvas reports it; the advance width alone where it does not
          const box = typeof m.actualBoundingBoxLeft === 'number' && typeof m.actualBoundingBoxRight === 'number'
            ? { left: Math.max(0, m.actualBoundingBoxLeft), right: Math.max(m.actualBoundingBoxRight, 0) }
            : { left: 0, right: m.width };
          // above and below the middle line the label is drawn on (`textBaseline` is set to it while measuring)
          return typeof m.actualBoundingBoxAscent === 'number' && typeof m.actualBoundingBoxDescent === 'number'
            ? { ...box, up: Math.max(0, m.actualBoundingBoxAscent), down: Math.max(0, m.actualBoundingBoxDescent) }
            : box;
        }
        : undefined;
      const fit = size ? fitLabel(p, text, penWidth(size.width, size.height), size.width, size.height, measure) : null;
      setShapes((xs) => [...xs, fit ? { tool: 'text', colour, at: fit.at, text, px: fit.px } : { tool: 'text', colour, at: p, text }]);
      setLabel('');
      return false;
    }
    setGesture({ pointerId, shape: tool === 'line' ? { tool, colour, points: [p] } : { tool, colour, from: p, to: p } });
    return true;
  };
  const extend = (shape: MarkupShape, p: Point): MarkupShape =>
    shape.tool === 'line' ? { ...shape, points: [...shape.points, p] } : shape.tool === 'text' ? shape : { ...shape, to: p };
  /** The gesture ends at `p`: kept if it means something. */
  const finish = (p: Point) => {
    const g = gesture.current;
    if (!g) return;
    const shape = extend(g.shape, p);
    if (isMeaningful(shape)) setShapes((xs) => [...xs, shape]);
    setGesture(null);
  };

  const mine = (e: ReactPointerEvent<HTMLCanvasElement>) => gesture.current?.pointerId === e.pointerId;
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy || gesture.current) return;
    if (begin(at(e), e.pointerId)) e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!mine(e)) return;
    setGesture({ pointerId: e.pointerId, shape: extend(gesture.current!.shape, at(e)) });
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => { if (mine(e)) finish(at(e)); };
  // the browser gave up the gesture (a call, palm rejection): nothing half-drawn is kept
  const cancel = (e: ReactPointerEvent<HTMLCanvasElement>) => { if (mine(e)) setGesture(null); };

  /** Keyboard: arrows move the marker (Shift for bigger steps), Enter or Space starts a mark and ends it. */
  const key = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (busy || !size) return;
    const c = cursor ?? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
    const step = Math.max(4, Math.round(Math.max(size.width, size.height) / 50)) * (e.shiftKey ? 4 : 1);
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (dx || dy) {
      e.preventDefault();
      // the last pixel row and column are the edge: the marker never leaves the photo
      const p = { x: Math.min(size.width - 1, Math.max(0, c.x + dx)), y: Math.min(size.height - 1, Math.max(0, c.y + dy)) };
      setCursor(p);
      const g = gesture.current;
      if (g && g.pointerId === null) setGesture({ pointerId: null, shape: extend(g.shape, p) });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setCursor(c);
      const g = gesture.current;
      if (!g) begin(c, null);
      else if (g.pointerId === null) finish(c);
    }
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // a mark still being drawn is not part of the copy: drop it and paint only the finished marks before taking it
    if (gesture.current) setGesture(null);
    if (shapes.length === 0) { setHint(MK.nothing[lang]); return; }
    if (!paint(shapes)) return;
    for (const quality of [0.85, 0.7, 0.5]) {
      const data = canvas.toDataURL('image/jpeg', quality).replace(/^data:[^,]*,/, '');
      if (data.length <= MAX_BASE64) { onSave({ mime: 'image/jpeg', data }); return; }
    }
    // never hand on a copy the upload would refuse
    setHint(MK.tooLarge[lang]);
  };

  return (
    // while a copy is being sent the editor stays open (no Cancel, Escape or backdrop), so a failed send keeps the marks
    <Modal onClose={busy ? () => {} : onCancel} maxWidth={760} labelledBy="photo-markup-title">
      <div style={{ padding: 16, display: 'grid', gap: 10 }}>
        <h2 id="photo-markup-title" style={{ margin: 0, fontSize: 18 }}>{MK.title[lang]}</h2>
        <div role="toolbar" aria-label={MK.title[lang]} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TOOLS.map((t) => (
            <Button key={t} variant={tool === t ? 'ink' : 'light'} aria-pressed={tool === t} disabled={busy} onClick={() => { setTool(t); setHint(''); }}>{MK[t][lang]}</Button>
          ))}
          {COLOURS.map((c) => (
            <Button key={c} variant={colour === c ? 'ink' : 'light'} aria-pressed={colour === c} disabled={busy} onClick={() => setColour(c)}>
              <span aria-hidden style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: MARKUP_COLOURS[c], marginRight: 6 }} />
              {MK[c][lang]}
            </Button>
          ))}
          <Button variant="light" disabled={busy || shapes.length === 0} onClick={() => setShapes((xs) => xs.slice(0, -1))}>{MK.undo[lang]}</Button>
        </div>
        {tool === 'text' && (
          <input
            aria-label={MK.label[lang]} placeholder={MK.labelHint[lang]} value={label} maxLength={60} disabled={busy}
            onChange={(e) => setLabel(e.target.value)} style={{ minHeight: 44, padding: '0 10px', borderRadius: 10, border: '1px solid rgba(35,33,28,.25)' }}
          />
        )}
        {failed ? (
          <div role="alert">{failed === 'decode' ? MK.cannotDecode[lang] : failed === 'read' ? MK.cannotRead[lang] : MK.cannotOpen[lang]}</div>
        ) : !size ? (
          <div>{MK.loading[lang]}</div>
        ) : (
          <div style={{ position: 'relative' }}>
            <canvas
              ref={canvasRef} width={size.width} height={size.height} data-testid="photo-markup-canvas"
              tabIndex={0} role="application" aria-label={MK.keys[lang]}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
              onKeyDown={key} onFocus={() => setCursor((c) => c ?? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) })}
              // leaving the photo mid-mark (Tab, or a tool clicked) drops a keyboard mark, so a pointer can draw at once
              onBlur={() => { setCursor(null); if (gesture.current?.pointerId === null) setGesture(null); }}
              style={{ display: 'block', width: '100%', height: 'auto', touchAction: 'none', borderRadius: 10, background: '#000' }}
            />
            {cursor && (
              // the keyboard marker sits over the canvas, so it is never drawn into the saved copy
              <span
                aria-hidden data-testid="photo-markup-marker"
                style={{
                  position: 'absolute', left: `${(cursor.x / size.width) * 100}%`, top: `${(cursor.y / size.height) * 100}%`,
                  width: 18, height: 18, margin: '-9px 0 0 -9px', borderRadius: 9, pointerEvents: 'none',
                  border: `2px solid ${MARKUP_COLOURS[colour]}`, boxShadow: '0 0 0 2px rgba(0,0,0,.6)',
                }}
              />
            )}
          </div>
        )}
        {hint && <div role="status">{hint}</div>}
        {notice && <div role="alert" data-testid="photo-markup-notice">{notice}</div>}
        <div style={{ fontSize: 13, opacity: 0.75 }}>{MK.original[lang]}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="light" disabled={busy} onClick={onCancel}>{MK.cancel[lang]}</Button>
          <Button variant="ink" disabled={busy || !size || failed !== false} onClick={save}>{MK.save[lang]}</Button>
        </div>
      </div>
    </Modal>
  );
}
