import type { Lang } from '@vitan/shared';

/**
 * Stage 1 photo markup (Jagrut, 19 Oct 2026: "yes to all" on the media plan): what a person draws on a photo to point at
 * a problem, kept as shapes in the photo's own pixels and drawn onto a copy when they save. The photo itself is never
 * changed; the copy is a new file that names it.
 */

export type MarkupTool = 'arrow' | 'circle' | 'line' | 'text';
export type MarkupColour = 'red' | 'yellow';
export interface Point { x: number; y: number }

export type MarkupShape =
  | { tool: 'arrow'; colour: MarkupColour; from: Point; to: Point }
  | { tool: 'circle'; colour: MarkupColour; from: Point; to: Point }
  | { tool: 'line'; colour: MarkupColour; points: Point[] }
  | { tool: 'text'; colour: MarkupColour; at: Point; text: string };

/** The pen colours: a strong red and a yellow that both read on concrete, brick and sky. */
export const MARKUP_COLOURS: Record<MarkupColour, string> = { red: '#e0262b', yellow: '#ffd200' };

/** The longest side of a saved copy, in pixels: enough to read a crack, small enough to send on a site connection. */
export const MARKUP_MAX_SIDE = 1600;

/** The size a photo is drawn at: its own size, scaled down so its longest side is at most `max`. */
export function fitWithin(width: number, height: number, max = MARKUP_MAX_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const k = max / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The pen width for a photo of this size, so a mark reads the same on a small and a large photo. */
export function penWidth(width: number, height: number): number {
  return Math.max(3, Math.round(Math.max(width, height) / 180));
}

/** A shape too small to mean anything (a tap with the arrow or circle tool): not kept. */
export function isMeaningful(shape: MarkupShape): boolean {
  if (shape.tool === 'text') return shape.text.trim() !== '';
  if (shape.tool === 'line') return shape.points.length > 1;
  return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= 4;
}

/** The drawing calls a shape needs, so the shapes can be drawn on a canvas and checked without one. */
export interface MarkupPen {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textBaseline: CanvasTextBaseline;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
}

/** Draws one shape with a pen of width `w`. */
export function drawShape(pen: MarkupPen, shape: MarkupShape, w: number): void {
  const colour = MARKUP_COLOURS[shape.colour];
  pen.strokeStyle = colour;
  pen.fillStyle = colour;
  pen.lineWidth = w;
  pen.lineCap = 'round';
  pen.lineJoin = 'round';
  if (shape.tool === 'line') {
    pen.beginPath();
    pen.moveTo(shape.points[0]!.x, shape.points[0]!.y);
    for (const p of shape.points.slice(1)) pen.lineTo(p.x, p.y);
    pen.stroke();
    return;
  }
  if (shape.tool === 'circle') {
    const cx = (shape.from.x + shape.to.x) / 2;
    const cy = (shape.from.y + shape.to.y) / 2;
    pen.beginPath();
    pen.ellipse(cx, cy, Math.abs(shape.to.x - shape.from.x) / 2, Math.abs(shape.to.y - shape.from.y) / 2, 0, 0, Math.PI * 2);
    pen.stroke();
    return;
  }
  if (shape.tool === 'arrow') {
    const { from, to } = shape;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = w * 4;
    pen.beginPath();
    pen.moveTo(from.x, from.y);
    pen.lineTo(to.x, to.y);
    pen.stroke();
    pen.beginPath();
    pen.moveTo(to.x, to.y);
    pen.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    pen.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    pen.lineTo(to.x, to.y);
    pen.fill();
    return;
  }
  // a label: the text as typed, with a dark outline so it reads on any background
  pen.font = `bold ${w * 6}px system-ui, sans-serif`;
  pen.textBaseline = 'middle';
  pen.strokeStyle = 'rgba(0,0,0,.75)';
  pen.lineWidth = w;
  pen.strokeText(shape.text, shape.at.x, shape.at.y);
  pen.fillText(shape.text, shape.at.x, shape.at.y);
}

/** The editor's words, in English, Hindi and Gujarati. Text written on the photo stays as typed. */
export const MK = {
  title: { en: 'Mark up photo', hi: 'फ़ोटो पर निशान लगाएँ', gu: 'ફોટા પર નિશાન કરો' },
  arrow: { en: 'Arrow', hi: 'तीर', gu: 'તીર' },
  circle: { en: 'Circle', hi: 'गोला', gu: 'વર્તુળ' },
  line: { en: 'Draw', hi: 'रेखा खींचें', gu: 'રેખા દોરો' },
  text: { en: 'Text', hi: 'लिखें', gu: 'લખાણ' },
  red: { en: 'Red', hi: 'लाल', gu: 'લાલ' },
  yellow: { en: 'Yellow', hi: 'पीला', gu: 'પીળો' },
  undo: { en: 'Undo', hi: 'पूर्ववत करें', gu: 'પાછું કરો' },
  save: { en: 'Save marked copy', hi: 'निशान वाली कॉपी सहेजें', gu: 'નિશાનવાળી નકલ સાચવો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  label: { en: 'Words to place', hi: 'लगाने के लिए शब्द', gu: 'મૂકવાના શબ્દો' },
  labelHint: { en: 'Type the words, then tap the photo where they go', hi: 'शब्द लिखें, फिर फ़ोटो पर वहाँ टैप करें जहाँ उन्हें लगाना है', gu: 'શબ્દો લખો, પછી ફોટા પર જ્યાં મૂકવા હોય ત્યાં ટૅપ કરો' },
  original: { en: 'The original photo is kept as it is.', hi: 'मूल फ़ोटो जैसी है वैसी रखी जाती है।', gu: 'મૂળ ફોટો જેવો છે તેવો જ રહે છે.' },
  loading: { en: 'Opening the photo…', hi: 'फ़ोटो खुल रही है…', gu: 'ફોટો ખૂલે છે…' },
  cannotOpen: { en: 'This photo could not be opened for marking. Check the signal and try again.', hi: 'यह फ़ोटो निशान लगाने के लिए नहीं खुल सकी। सिग्नल देखें और फिर से कोशिश करें।', gu: 'આ ફોટો નિશાન કરવા માટે ખૂલી શક્યો નહીં. સિગ્નલ તપાસો અને ફરી પ્રયાસ કરો.' },
  nothing: { en: 'Draw on the photo first', hi: 'पहले फ़ोटो पर कुछ बनाएँ', gu: 'પહેલાં ફોટા પર કંઈક દોરો' },
} satisfies Record<string, Record<Lang, string>>;
