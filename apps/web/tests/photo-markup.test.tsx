import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhotoMarkup } from '@/components/PhotoMarkup';
import { MK, drawShape, fitWithin, isMeaningful, penWidth, type MarkupPen, type MarkupShape } from '@/lib/photoMarkup';

/** A pen that records what it was asked to draw. */
function recordingPen() {
  const calls: string[] = [];
  const pen = {
    strokeStyle: '', fillStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter', font: '', textBaseline: 'alphabetic',
    beginPath: () => calls.push('begin'),
    moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
    ellipse: (x: number, y: number, rx: number, ry: number) => calls.push(`ellipse ${x},${y} ${rx}x${ry}`),
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    strokeText: (t: string) => calls.push(`outline ${t}`),
    fillText: (t: string, x: number, y: number) => calls.push(`text ${t} ${x},${y}`),
  } as MarkupPen & { drawImage?: () => void };
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
    render(<PhotoMarkup source={new Blob(['x'], { type: 'image/jpeg' })} lang="en" onSave={onSave} onCancel={() => {}} />);
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
    render(<PhotoMarkup source={new Blob(['x'])} lang="en" onSave={onSave} onCancel={() => {}} />);
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

  it('Cancel closes without saving', async () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    render(<PhotoMarkup source={new Blob(['x'])} lang="gu" onSave={onSave} onCancel={onCancel} />);
    await screen.findByTestId('photo-markup-canvas');
    fireEvent.click(screen.getByRole('button', { name: MK.cancel.gu }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
