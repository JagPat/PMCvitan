import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhotoMarkup } from '@/components/PhotoMarkup';
import { photoDecodes } from '@/lib/photoDecodes';
import { MK, drawShape, fitLabel, fitWithin, isMeaningful, labelWidth, penWidth, type MarkupPen, type MarkupShape } from '@/lib/photoMarkup';

/** A pen that records what it was asked to draw. */
function recordingPen() {
  const calls: string[] = [];
  const pen = {
    strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter', font: '', textBaseline: 'alphabetic',
    clearRect: () => {},
    beginPath: () => calls.push('begin'),
    moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
    ellipse: (x: number, y: number, rx: number, ry: number) => calls.push(`ellipse ${x},${y} ${rx}x${ry}`),
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    strokeText: (t: string) => calls.push(`outline ${t}`),
    fillText: (t: string, x: number, y: number) => calls.push(`text ${t} ${x},${y}`),
  } as MarkupPen & { drawImage?: () => void; clearRect: () => void };
  return { pen, calls };
}

describe('photo markup: the shapes', () => {
  it('fits a large photo within the saved size and leaves a small one as it is', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(penWidth(1600, 1200)).toBe(9);
    expect(penWidth(100, 100)).toBe(3);
  });

  it('keeps a mark only when it means something: not a tap, an empty label or a single point', () => {
    expect(isMeaningful({ tool: 'arrow', colour: 'red', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })).toBe(false);
    expect(isMeaningful({ tool: 'circle', colour: 'red', from: { x: 1, y: 1 }, to: { x: 40, y: 30 } })).toBe(true);
    expect(isMeaningful({ tool: 'line', colour: 'red', points: [{ x: 1, y: 1 }] })).toBe(false);
    expect(isMeaningful({ tool: 'text', colour: 'red', at: { x: 1, y: 1 }, text: '  ' })).toBe(false);
  });

  it('draws an arrow as a shaft and a filled head, a circle inside its box, a line through its points and a label as typed', () => {
    const shapes: MarkupShape[] = [
      { tool: 'arrow', colour: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } },
      { tool: 'circle', colour: 'yellow', from: { x: 10, y: 10 }, to: { x: 50, y: 30 } },
      { tool: 'line', colour: 'red', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 2 }] },
      { tool: 'text', colour: 'yellow', at: { x: 20, y: 40 }, text: 'दरार' },
    ];
    const { pen, calls } = recordingPen();
    for (const s of shapes) drawShape(pen, s, 4);
    expect(calls.slice(0, 4)).toEqual(['begin', 'move 0,0', 'line 100,0', 'stroke']);
    expect(calls).toContain('fill');
    expect(calls).toContain('ellipse 30,20 20x10');
    expect(calls).toContain('line 9,2');
    expect(calls).toContain('text दरार 20,40');
    expect(pen.fillStyle).toBe('#ffd200');
  });
});

describe('photo markup: the editor', () => {
  // one photo per test: a new Blob is a new photo, and the editor starts clean on each
  const PHOTO = new Blob(['x'], { type: 'image/jpeg' });
  let drawn: number;
  beforeEach(() => {
    drawn = 0;
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 3200;
      naturalHeight = 2400;
      set src(_: string) { setTimeout(() => this.onload?.(), 0); }
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      const { pen } = recordingPen();
      return Object.assign(pen, { drawImage: () => { drawn += 1; } }) as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,QUJD');
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const drag = (canvas: HTMLElement, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1], pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: to[0], clientY: to[1], pointerId: 1 });
  };

  it('opens a picked photo at the saved size, and saves the drawing as a JPEG copy', async () => {
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={onSave} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    expect(canvas).toHaveAttribute('width', '1600');
    expect(canvas).toHaveAttribute('height', '1200');
    expect(drawn).toBeGreaterThan(0);
    // nothing drawn: Save asks for a mark first and sends nothing
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(screen.getByRole('status')).toHaveTextContent(MK.nothing.en);
    expect(onSave).not.toHaveBeenCalled();
    drag(canvas, [100, 100], [300, 200]);
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(onSave).toHaveBeenCalledWith({ mime: 'image/jpeg', data: 'QUJD' });
  });

  it('undo takes the last mark back; a label is placed where the photo is tapped once words are typed', async () => {
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={onSave} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    drag(canvas, [10, 10], [200, 150]);
    const undo = screen.getByRole('button', { name: MK.undo.en });
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    expect(undo).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: MK.text.en }));
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, pointerId: 1 });
    expect(screen.getByRole('status')).toHaveTextContent(MK.labelHint.en);
    fireEvent.change(screen.getByLabelText(MK.label.en), { target: { value: 'Crack' } });
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, pointerId: 1 });
    expect(undo).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('says plainly when a stored photo cannot be opened, and offers no save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    render(<PhotoMarkup source="https://api.test/media/m1?t=x" lang="hi" onSave={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(MK.cannotOpen.hi);
    expect(screen.getByRole('button', { name: MK.save.hi })).toBeDisabled();
  });

  it('ends a mark where the pointer is let go, even when no move arrived in between', async () => {
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={onSave} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 300, clientY: 200, pointerId: 1 });
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeEnabled();
  });

  it('a second finger neither replaces nor ends the mark, and a cancelled gesture keeps nothing', async () => {
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    const undo = screen.getByRole('button', { name: MK.undo.en });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 400, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 400, pointerId: 2 });
    expect(undo).toBeDisabled();
    fireEvent.pointerMove(canvas, { clientX: 200, clientY: 150, pointerId: 1 });
    fireEvent.pointerCancel(canvas, { clientX: 200, clientY: 150, pointerId: 1 });
    expect(undo).toBeDisabled();
    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 150, pointerId: 1 });
    expect(undo).toBeDisabled();
  });

  it('marks a photo with the keyboard alone: arrows move the marker, Enter starts and ends the mark', async () => {
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={onSave} onCancel={() => {}} />);
    const canvas = await screen.findByRole('application', { name: MK.keys.en });
    expect(canvas).toHaveAttribute('tabindex', '0');
    fireEvent.focus(canvas);
    expect(screen.getByTestId('photo-markup-marker')).toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: 'Enter' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('never hands on a copy over the upload ceiling', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(`data:image/jpeg;base64,${'A'.repeat(14_000_001)}`);
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={onSave} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    drag(canvas, [10, 10], [300, 200]);
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(MK.tooLarge.en);
  });

  it('asks once for a fresh link when a stored photo\'s link has expired', async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes('fresh') ? new Response('x', { status: 200 }) : new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const refreshSource = vi.fn(async () => 'https://api.test/media/m1?t=fresh');
    render(<PhotoMarkup source="https://api.test/media/m1?t=old" refreshSource={refreshSource} lang="en" onSave={() => {}} onCancel={() => {}} />);
    await screen.findByTestId('photo-markup-canvas');
    expect(refreshSource).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a new photo starts clean: the last photo\'s marks are dropped and nothing saves until it opens', async () => {
    const onSave = vi.fn();
    const { rerender } = render(<PhotoMarkup source={new Blob(['a'])} lang="en" onSave={onSave} onCancel={() => {}} />);
    drag(await screen.findByTestId('photo-markup-canvas'), [10, 10], [300, 200]);
    rerender(<PhotoMarkup source={new Blob(['b'])} lang="en" onSave={onSave} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: MK.save.en })).toBeDisabled();
    await screen.findByTestId('photo-markup-canvas');
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeDisabled();
  });

  // round 2 on #1002 (c688a2d): each of these failed there

  it('a new photo also drops words typed but not yet placed', async () => {
    const { rerender } = render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    await screen.findByTestId('photo-markup-canvas');
    fireEvent.click(screen.getByRole('button', { name: MK.text.en }));
    fireEvent.change(screen.getByLabelText(MK.label.en), { target: { value: 'Crack' } });
    rerender(<PhotoMarkup source={new Blob(['b'])} lang="en" onSave={() => {}} onCancel={() => {}} />);
    await screen.findByTestId('photo-markup-canvas');
    expect(screen.getByLabelText(MK.label.en)).toHaveValue('');
  });

  it('a tap with the Draw tool is not a mark', async () => {
    expect(isMeaningful({ tool: 'line', colour: 'red', points: [{ x: 5, y: 5 }, { x: 5, y: 5 }] })).toBe(false);
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    fireEvent.click(screen.getByRole('button', { name: MK.line.en }));
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 50, clientY: 50, pointerId: 1 });
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeDisabled();
  });

  it('a keyboard mark left unfinished is not in the saved copy', async () => {
    // one shared pen: what is on the canvas since the photo was last drawn, at the moment the copy is taken
    let painted: string[] = [];
    let atExport: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      const { pen, calls } = recordingPen();
      calls.push = (...xs: string[]) => { painted.push(...xs); return painted.length; };
      return Object.assign(pen, { drawImage: () => { painted = []; } }) as unknown as CanvasRenderingContext2D;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { atExport = [...painted]; return 'data:image/jpeg;base64,QUJD'; });
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={onSave} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    drag(canvas, [10, 10], [300, 200]);
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: 'Enter' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(onSave).toHaveBeenCalledTimes(1);
    // one arrow: a shaft and a head
    expect(atExport.filter((c) => c === 'begin')).toHaveLength(2);
  });

  it('a label placed at the right edge from the keyboard stays on the photo', async () => {
    const texts: Array<{ text: string; x: number }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      const { pen } = recordingPen();
      return Object.assign(pen, {
        drawImage: () => {},
        fillText: (text: string, x: number) => { texts.push({ text, x }); },
      }) as unknown as CanvasRenderingContext2D;
    } as never);
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    fireEvent.click(screen.getByRole('button', { name: MK.text.en }));
    fireEvent.change(screen.getByLabelText(MK.label.en), { target: { value: 'Crack here' } });
    fireEvent.focus(canvas);
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(canvas, { key: 'Enter' });
    const placed = texts.filter((t) => t.text === 'Crack here').at(-1);
    expect(placed).toBeDefined();
    // the label's estimated width (bold, 6 pens tall) still fits inside the 1600 px photo
    expect(placed!.x + labelWidth('Crack here', penWidth(1600, 1200) * 6)).toBeLessThanOrEqual(1600);
  });

  it('while a saved copy is being sent, the photo and tools take no new marks', async () => {
    render(<PhotoMarkup source={PHOTO} lang="en" busy onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    drag(canvas, [10, 10], [300, 200]);
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: 'Enter' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeDisabled();
    expect(screen.getByRole('button', { name: MK.circle.en })).toBeDisabled();
  });

  // round 1 on #1003 (89c3e4a): each of these failed there

  it('each repaint clears the canvas first, so an undone mark on a see-through photo is gone', async () => {
    const order: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      const { pen } = recordingPen();
      return Object.assign(pen, { clearRect: () => order.push('clear'), drawImage: () => order.push('photo') }) as unknown as CanvasRenderingContext2D;
    } as never);
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    drag(canvas, [10, 10], [300, 200]);
    fireEvent.click(screen.getByRole('button', { name: MK.undo.en }));
    expect(order.length).toBeGreaterThan(2);
    order.forEach((c, i) => { if (c === 'photo') expect(order[i - 1]).toBe('clear'); });
  });

  it('Save with only an unfinished keyboard mark drops it, and touch drawing still works', async () => {
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: 'Enter' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: MK.save.en }));
    expect(screen.getByRole('status')).toHaveTextContent(MK.nothing.en);
    drag(canvas, [10, 10], [300, 200]);
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeEnabled();
  });

  it('a label stays whole on the photo: a long one is drawn smaller, and one at the top or bottom edge is moved in', () => {
    const w = penWidth(1600, 1200);
    const long = fitLabel({ x: 0, y: 600 }, 'A'.repeat(60), w, 1600, 1200);
    expect(long.px).toBeLessThan(w * 6);
    expect(long.at.x + labelWidth('A'.repeat(60), long.px)).toBeLessThanOrEqual(1600);
    const top = fitLabel({ x: 100, y: 0 }, 'Crack', w, 1600, 1200);
    expect(top.at.y - top.px / 2).toBeGreaterThanOrEqual(0);
    const bottom = fitLabel({ x: 100, y: 1199 }, 'Crack', w, 1600, 1200);
    expect(bottom.at.y + bottom.px / 2).toBeLessThanOrEqual(1200);
    const { pen, calls } = recordingPen();
    drawShape(pen, { tool: 'text', colour: 'red', at: long.at, text: 'A'.repeat(60), px: long.px }, w);
    expect(pen.font).toContain(`${long.px}px`);
    expect(calls).toContain(`text ${'A'.repeat(60)} ${long.at.x},${long.at.y}`);
  });

  // round 2 on #1003 (cc4e50d): failed there

  it('a keyboard mark left unfinished when the photo loses focus is dropped, and touch drawing still works', async () => {
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: 'Enter' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.blur(canvas);
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeDisabled();
    drag(canvas, [10, 10], [300, 200]);
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeEnabled();
  });

  // #1006: the three review points filed at #1003's round cap; each failed on 44a1811

  it('a label of wide letters, measured on the canvas with its outline, stays whole on the photo (#1006, 4320857017)', async () => {
    // a font whose letters are each as wide as the font is tall: wider than any estimate from the letter count
    const texts: Array<{ text: string; x: number; font: string }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      const { pen } = recordingPen();
      return Object.assign(pen, {
        drawImage: () => {},
        measureText(this: { font: string }, text: string) {
          const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10);
          return { width: [...text].length * px } as TextMetrics;
        },
        fillText(this: { font: string }, text: string, x: number) { texts.push({ text, x, font: this.font }); },
      }) as unknown as CanvasRenderingContext2D;
    } as never);
    render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={() => {}} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    fireEvent.click(screen.getByRole('button', { name: MK.text.en }));
    fireEvent.change(screen.getByLabelText(MK.label.en), { target: { value: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW' } });
    fireEvent.pointerDown(canvas, { clientX: 790, clientY: 300, pointerId: 1 });
    const placed = texts.filter((t) => t.text.startsWith('WWWW')).at(-1)!;
    const px = Number(/(\d+)px/.exec(placed.font)![1]);
    const w = penWidth(1600, 1200);
    // the drawn extent (the measured text and half an outline each side) is inside the 1600 px photo
    expect(placed.x - w / 2).toBeGreaterThanOrEqual(0);
    expect(placed.x + 40 * px + w / 2).toBeLessThanOrEqual(1600);
  });

  it('fitLabel measures with the measure it is given and leaves room for the outline', () => {
    const w = penWidth(1600, 1200);
    const wide = (text: string, px: number) => [...text].length * px;
    const fit = fitLabel({ x: 1599, y: 600 }, 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM', w, 1600, 1200, wide);
    expect(fit.at.x - w / 2).toBeGreaterThanOrEqual(0);
    expect(fit.at.x + wide('M'.repeat(42), fit.px) + w / 2).toBeLessThanOrEqual(1600);
    const left = fitLabel({ x: 0, y: 600 }, 'Crack', w, 1600, 1200, wide);
    expect(left.at.x).toBeGreaterThanOrEqual(w / 2);
  });

  it('a photo this device cannot decode (an iPhone HEIC on another browser) says so, not "check the signal" (#1006, 4320857021)', async () => {
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) { setTimeout(() => this.onerror?.(), 0); }
    });
    render(<PhotoMarkup source={new Blob(['x'], { type: 'image/heic' })} lang="gu" onSave={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(MK.cannotDecode.gu);
    expect(screen.getByRole('alert')).not.toHaveTextContent(MK.cannotOpen.gu);
    expect(screen.getByRole('button', { name: MK.save.gu })).toBeDisabled();
  });

  it('photoDecodes tells a caller beforehand whether this device can open a photo for marking (#1006, 4320857021)', async () => {
    expect(await photoDecodes(new Blob(['x'], { type: 'image/jpeg' }))).toBe(true);
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) { setTimeout(() => this.onerror?.(), 0); }
    });
    expect(await photoDecodes(new Blob(['x'], { type: 'image/heic' }))).toBe(false);
  });

  it('while a saved copy is being sent the editor cannot be closed, so a failed send keeps the marks (#1006, 4320857025)', async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={onCancel} />);
    const canvas = await screen.findByTestId('photo-markup-canvas');
    drag(canvas, [10, 10], [300, 200]);
    rerender(<PhotoMarkup source={PHOTO} lang="en" busy onSave={() => {}} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: MK.cancel.en })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: MK.cancel.en }));
    fireEvent.keyDown(window, { key: 'Escape' });
    // the backdrop: the dialog's parent
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onCancel).not.toHaveBeenCalled();
    // the send failed: the caller clears busy, and the mark is still there to save again
    rerender(<PhotoMarkup source={PHOTO} lang="en" onSave={() => {}} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: MK.undo.en })).toBeEnabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes without saving', async () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    render(<PhotoMarkup source={PHOTO} lang="gu" onSave={onSave} onCancel={onCancel} />);
    await screen.findByTestId('photo-markup-canvas');
    fireEvent.click(screen.getByRole('button', { name: MK.cancel.gu }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
