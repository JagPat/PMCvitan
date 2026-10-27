import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { POSTER_MAX_SIDE, readJpegStill } from './jpeg-still';

const still = (name: string) => readFileSync(join(__dirname, '..', '..', 'test', 'unit-support', 'recordings', name));
const big = still('chromium-153-still-640x360.jpg');
const tiny = still('chromium-153-still-1x1.jpg');
const progressive = still('pillow-12.3-progressive-48x32.jpg');
const restart = still('pillow-12.3-restart-48x32.jpg');
const restartProgressive = still('pillow-12.3-restart-progressive-48x32.jpg');

/** A JPEG as its segments: each marker with its body, a scan's entropy data riding after its SOS. */
interface Part { marker: number; body: Buffer; scan?: Buffer }
function parts(b: Buffer): Part[] {
  const out: Part[] = [];
  let at = 2;
  while (b[at + 1] !== 0xd9) {
    const marker = b[at + 1]!;
    const end = at + 2 + b.readUInt16BE(at + 2);
    const part: Part = { marker, body: b.subarray(at + 4, end) };
    at = end;
    if (marker === 0xda) {
      let i = at;
      while (!(b[i] === 0xff && b[i + 1] !== 0 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
      part.scan = b.subarray(at, i);
      at = i;
    }
    out.push(part);
  }
  return out;
}
function build(ps: Part[], tail: Buffer = Buffer.from([0xff, 0xd9])): Buffer {
  const chunks = [Buffer.from([0xff, 0xd8])];
  for (const p of ps) {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = p.marker;
    head.writeUInt16BE(p.body.length + 2, 2);
    chunks.push(head, p.body);
    if (p.scan) chunks.push(p.scan);
  }
  chunks.push(tail);
  return Buffer.concat(chunks);
}
const segment = (marker: number, body: number[] | Buffer): Part => ({ marker, body: Buffer.from(body) });
/** The real still, with its parts changed by `edit`. */
const edited = (edit: (ps: Part[]) => Part[]) => build(edit(parts(big).map((p) => ({ ...p, body: Buffer.from(p.body) }))));
const sof = (ps: Part[]) => ps.find((p) => p.marker === 0xc0)!;
const sos = (ps: Part[]) => ps.find((p) => p.marker === 0xda)!;
/** The component ids of a still's frame. */
const sofOf = (b: Buffer) => {
  const f = parts(b).find((p) => p.marker === 0xc0 || p.marker === 0xc2)!.body;
  return Array.from({ length: f[5]! }, (_, i) => f[6 + 3 * i]!);
};
const before = (ps: Part[], marker: number, add: Part) => {
  const i = ps.findIndex((p) => p.marker === marker);
  return [...ps.slice(0, i), add, ...ps.slice(i)];
};

describe('readJpegStill — real stills', () => {
  it("passes Chromium 153's canvas JPEGs, at their own size", () => {
    expect(readJpegStill(big)).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(tiny)).toEqual({ width: 1, height: 1 });
  });

  it("passes another encoder's progressive and restart stills (Pillow 12.3, libjpeg-turbo)", () => {
    for (const b of [progressive, restart, restartProgressive]) expect(readJpegStill(b)).toEqual({ width: 48, height: 32 });
  });

  it('round-trips the fixtures through the test builder unchanged', () => {
    for (const b of [big, progressive, restart, restartProgressive]) expect(build(parts(b)).equals(b)).toBe(true);
  });
});

describe('readJpegStill — the walk', () => {
  it('refuses a file that is not a JPEG, or is cut short anywhere', () => {
    expect(readJpegStill(Buffer.alloc(0))).toBeNull();
    expect(readJpegStill(Buffer.from('not a jpeg at all'))).toBeNull();
    for (const cut of [2, 3, 20, 600, big.length - 300, big.length - 2, big.length - 1]) {
      expect(readJpegStill(big.subarray(0, cut)), `cut at ${cut}`).toBeNull();
    }
  });

  it('refuses any byte after EOI, and a second EOI', () => {
    expect(readJpegStill(Buffer.concat([big, Buffer.from([0x00])]))).toBeNull();
    expect(readJpegStill(Buffer.concat([big, Buffer.from([0xff, 0xd9])]))).toBeNull();
    expect(readJpegStill(Buffer.concat([big, Buffer.from('<?xml?>')]))).toBeNull();
  });

  it('refuses EOI before any scan, or a frame', () => {
    expect(readJpegStill(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readJpegStill(build(parts(big).filter((p) => p.marker !== 0xda)))).toBeNull();
  });

  it('refuses a segment whose length runs past the file or is under 2', () => {
    const long = Buffer.from(big);
    long.writeUInt16BE(0xffff, 4); // APP0's length
    expect(readJpegStill(long)).toBeNull();
    const short = Buffer.from(big);
    short.writeUInt16BE(1, 4);
    expect(readJpegStill(short)).toBeNull();
  });

  it('refuses a fill byte before a marker', () => {
    const filled = Buffer.concat([big.subarray(0, 2), Buffer.from([0xff]), big.subarray(2)]);
    expect(readJpegStill(filled)).toBeNull();
  });
});

describe('readJpegStill — what may be in it', () => {
  it('refuses Exif or XMP (APP1), every other APPn, and a comment', () => {
    const exif = segment(0xe1, Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0\0', 'latin1'));
    expect(readJpegStill(edited((ps) => before(ps, 0xdb, exif)))).toBeNull();
    for (const marker of [0xe3, 0xe4, 0xed, 0xee, 0xef, 0xfe]) {
      expect(readJpegStill(edited((ps) => before(ps, 0xdb, segment(marker, [1, 2, 3])))), marker.toString(16)).toBeNull();
    }
  });

  it('refuses arithmetic, lossless, hierarchical and other frames, DNL and the reserved markers', () => {
    for (const marker of [0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xdc, 0xde, 0xdf, 0x01, 0xd0]) {
      expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xc0 ? { ...p, marker } : p)))), marker.toString(16)).toBeNull();
    }
  });

  it('passes without APP0 or the ICC profile, and refuses either twice or after the frame', () => {
    expect(readJpegStill(edited((ps) => ps.filter((p) => p.marker !== 0xe0 && p.marker !== 0xe2)))).toEqual({ width: 640, height: 360 });
    for (const marker of [0xe0, 0xe2]) {
      expect(readJpegStill(edited((ps) => before(ps, 0xdb, ps.find((p) => p.marker === marker)!)))).toBeNull();
      // moved, not copied, so only its place refuses it
      expect(readJpegStill(edited((ps) => before(ps.filter((p) => p.marker !== marker), 0xc4, ps.find((p) => p.marker === marker)!)))).toBeNull();
    }
  });

  it('passes only the 14-byte JFIF header with no thumbnail: a thumbnail, a tail or a short header is refused', () => {
    const app0 = (edit: (body: Buffer) => Buffer) => edited((ps) => ps.map((p) => (p.marker === 0xe0 ? { ...p, body: edit(p.body) } : p)));
    expect(readJpegStill(app0((b) => b))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(app0((b) => Buffer.concat([b.subarray(0, 12), Buffer.from([1, 1, 0, 0, 0])])))).toBeNull(); // a 1 x 1 thumbnail
    expect(readJpegStill(app0((b) => Buffer.concat([b, Buffer.alloc(60)])))).toBeNull();
    expect(readJpegStill(app0((b) => b.subarray(0, 5)))).toBeNull();
    expect(readJpegStill(app0((b) => Buffer.concat([b.subarray(0, 12), Buffer.from([1, 0])])))).toBeNull();
    expect(readJpegStill(app0((b) => Buffer.concat([b.subarray(0, 12), Buffer.from([0, 1])])))).toBeNull();
  });

  it('refuses an APP0 that is not JFIF, and an APP2 that is not one whole ICC profile', () => {
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xe0 ? segment(0xe0, Buffer.from('JFXX\0\x10', 'latin1')) : p))))).toBeNull();
    const icc = (seq: number, count: number) => edited((ps) => ps.map((p) => {
      if (p.marker !== 0xe2) return p;
      p.body[12] = seq;
      p.body[13] = count;
      return p;
    }));
    expect(readJpegStill(icc(1, 1))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(icc(1, 2))).toBeNull();
    expect(readJpegStill(icc(2, 2))).toBeNull();
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xe2 ? segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1')) : p))))).toBeNull();
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xe2 ? segment(0xe2, Buffer.from('MPF\0\x01\x01xx', 'latin1')) : p))))).toBeNull();
  });

  it('refuses an empty DQT or DHT, and a DRI that is not 4 bytes; passes one that is', () => {
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xdb ? segment(0xdb, []) : p))))).toBeNull();
    expect(readJpegStill(edited((ps) => ps.map((p) => (p.marker === 0xc4 ? segment(0xc4, []) : p))))).toBeNull();
    expect(readJpegStill(edited((ps) => before(ps, 0xda, segment(0xdd, [0, 0]))))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(edited((ps) => before(ps, 0xda, segment(0xdd, [0, 0, 0]))))).toBeNull();
  });
});

describe('readJpegStill — the tables', () => {
  /** The still with its `n`th segment of `marker` changed by `edit`. */
  const table = (marker: number, n: number, edit: (body: Buffer) => Buffer | void) => edited((ps) => {
    const p = ps.filter((q) => q.marker === marker)[n]!;
    p.body = edit(p.body) ?? p.body;
    return ps;
  });
  const without = (marker: number, n: number) => edited((ps) => ps.filter((q) => q !== ps.filter((r) => r.marker === marker)[n]));

  it('passes two quantization tables in one DQT, and refuses one that is not 8-bit, numbered over 3, cut short or followed by a byte', () => {
    expect(readJpegStill(edited((ps) => {
      const [a, b] = ps.filter((q) => q.marker === 0xdb);
      a!.body = Buffer.concat([a!.body, b!.body]);
      return ps.filter((q) => q !== b);
    }))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(table(0xdb, 0, (b) => void (b[0] = 0x10)))).toBeNull();
    expect(readJpegStill(table(0xdb, 1, (b) => void (b[0] = 0x04)))).toBeNull();
    // an extra table no component could name
    expect(readJpegStill(table(0xdb, 1, (b) => Buffer.concat([b, Buffer.from([0x04]), b.subarray(1)])))).toBeNull();
    expect(readJpegStill(table(0xdb, 1, (b) => Buffer.concat([b, Buffer.from([0x03]), b.subarray(1)])))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(table(0xdb, 0, (b) => b.subarray(0, 64)))).toBeNull();
    expect(readJpegStill(table(0xdb, 0, (b) => Buffer.concat([b, Buffer.from([0])])))).toBeNull();
  });

  it('refuses a Huffman table of a class over 1, numbered over 3, with no codes or over 256, cut short or followed by a byte', () => {
    expect(readJpegStill(table(0xc4, 0, (b) => void (b[0] = 0x20)))).toBeNull();
    // an extra table beside the real ones: a third class, or a fifth number
    const extra = (tcth: number) => table(0xc4, 0, (b) => Buffer.concat([b, Buffer.from([tcth]), b.subarray(1)]));
    expect(readJpegStill(extra(0x03))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(extra(0x20))).toBeNull();
    expect(readJpegStill(extra(0x04))).toBeNull();
    expect(readJpegStill(table(0xc4, 1, (b) => void (b[0] = 0x14)))).toBeNull();
    expect(readJpegStill(table(0xc4, 0, (b) => Buffer.concat([b.subarray(0, 1), Buffer.alloc(16)])))).toBeNull();
    expect(readJpegStill(table(0xc4, 0, (b) => Buffer.concat([b.subarray(0, 1), Buffer.alloc(16, 17), Buffer.alloc(272)])))).toBeNull();
    expect(readJpegStill(table(0xc4, 1, (b) => b.subarray(0, b.length - 1)))).toBeNull();
    expect(readJpegStill(table(0xc4, 1, (b) => Buffer.concat([b, Buffer.from([0])])))).toBeNull();
    expect(readJpegStill(table(0xc4, 0, (b) => b.subarray(0, 10)))).toBeNull();
  });

  it('refuses a scan that decodes with a table not yet defined', () => {
    // two quantization tables, two DC and two AC Huffman tables: each one is used
    for (const [marker, n] of [[0xdb, 0], [0xdb, 1], [0xc4, 0], [0xc4, 1], [0xc4, 2], [0xc4, 3]] as const) {
      expect(readJpegStill(without(marker, n)), `${marker.toString(16)} ${n}`).toBeNull();
      const late = edited((ps) => {
        const p = ps.filter((q) => q.marker === marker)[n]!;
        const i = ps.indexOf(sos(ps));
        return [...ps.slice(0, i + 1).filter((q) => q !== p), p, ...ps.slice(i + 1)];
      });
      expect(readJpegStill(late), `${marker.toString(16)} ${n} after the scan`).toBeNull();
    }
  });
});

describe('readJpegStill — the frame', () => {
  const frame = (edit: (body: Buffer) => Buffer | void) => edited((ps) => {
    const p = sof(ps);
    p.body = edit(p.body) ?? p.body;
    return ps;
  });

  it('reads the size from the frame, and refuses 0 or more than the cap on either side', () => {
    const sized = (w: number, h: number) => frame((b) => {
      b.writeUInt16BE(h, 1);
      b.writeUInt16BE(w, 3);
    });
    expect(readJpegStill(sized(POSTER_MAX_SIDE, POSTER_MAX_SIDE))).toEqual({ width: POSTER_MAX_SIDE, height: POSTER_MAX_SIDE });
    expect(readJpegStill(sized(1, 1))).toEqual({ width: 1, height: 1 });
    for (const [w, h] of [[0, 360], [640, 0], [POSTER_MAX_SIDE + 1, 360], [640, POSTER_MAX_SIDE + 1], [65535, 65535]] as const) {
      expect(readJpegStill(sized(w, h)), `${w}x${h}`).toBeNull();
    }
  });

  it('refuses a precision other than 8', () => {
    expect(readJpegStill(frame((b) => void (b[0] = 12)))).toBeNull();
  });

  it('refuses 2 or 4 components, and a length that is not its fields', () => {
    expect(readJpegStill(frame((b) => Buffer.concat([b.subarray(0, 5), Buffer.from([2]), b.subarray(6, 12)])))).toBeNull();
    expect(readJpegStill(frame((b) => Buffer.concat([b.subarray(0, 5), Buffer.from([4]), b.subarray(6), Buffer.from([4, 0x11, 0])])))).toBeNull();
    expect(readJpegStill(frame((b) => Buffer.concat([b, Buffer.from([0])])))).toBeNull();
    expect(readJpegStill(frame((b) => b.subarray(0, 14)))).toBeNull();
  });

  it('refuses a repeated component id, a sampling factor of 0 or over 4, and a table over 3', () => {
    // the scan names only ids the frame has, so only the frame's repeat refuses it
    expect(readJpegStill(edited((ps) => {
      const f = sof(ps).body;
      f[9] = f[6]!;
      sos(ps).body = Buffer.from([2, f[6]!, 0, f[12]!, 0x11, 0, 63, 0]);
      return ps;
    }))).toBeNull();
    for (const sampling of [0x01, 0x10, 0x51, 0x15]) expect(readJpegStill(frame((b) => void (b[7] = sampling))), sampling.toString(16)).toBeNull();
    expect(readJpegStill(frame((b) => void (b[8] = 4)))).toBeNull();
  });

  it('refuses a second frame', () => {
    expect(readJpegStill(edited((ps) => before(ps, 0xda, sof(ps))))).toBeNull();
  });

  it('passes a progressive frame with several scans, and refuses a second scan on a baseline frame', () => {
    expect(parts(progressive).filter((p) => p.marker === 0xda).length).toBeGreaterThan(1);
    expect(readJpegStill(edited((ps) => [...ps, { ...sos(ps) }]))).toBeNull();
    // the same scans under a baseline frame
    expect(readJpegStill(build(parts(progressive).map((p) => (p.marker === 0xc2 ? { ...p, marker: 0xc0 } : p))))).toBeNull();
  });
});

describe('readJpegStill — the scan', () => {
  const scan = (edit: (p: Part) => void) => edited((ps) => {
    edit(sos(ps));
    return ps;
  });

  it('refuses a scan before the frame', () => {
    expect(readJpegStill(edited((ps) => before(ps, 0xc0, sos(ps))))).toBeNull();
  });

  it('refuses no components, more than the frame has, one the frame does not name, or one named twice', () => {
    const header = (count: number, ids: number[]) => scan((p) => {
      p.body = Buffer.from([count, ...ids.flatMap((id) => [id, 0]), 0, 63, 0]);
    });
    const ids = [sof(parts(big)).body[6]!, sof(parts(big)).body[9]!, sof(parts(big)).body[12]!];
    expect(readJpegStill(header(3, ids))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(header(0, []))).toBeNull();
    expect(readJpegStill(header(4, [...ids, 9]))).toBeNull();
    expect(readJpegStill(header(1, [9]))).toBeNull();
    expect(readJpegStill(header(2, [ids[0]!, ids[0]!]))).toBeNull();
  });

  it('refuses a table selector over 3, and a baseline scan that is not the whole band at full precision', () => {
    const at = (i: number, v: number) => scan((p) => void (p.body[i] = v));
    expect(readJpegStill(at(2, 0x40))).toBeNull();
    expect(readJpegStill(at(2, 0x04))).toBeNull();
    for (const [i, v] of [[7, 1], [8, 62], [8, 64], [9, 0x10], [9, 0x01]] as const) expect(readJpegStill(at(i, v)), `${i}=${v}`).toBeNull();
  });

  it('refuses a progressive scan outside the spectral and precision rules', () => {
    // the real progressive still, with its nth scan's last three header bytes (Ss, Se, Ah:Al) or count changed
    const scanAt = (n: number, edit: (body: Buffer) => Buffer | void) => build(parts(progressive).map((p) => ({ ...p, body: Buffer.from(p.body) })).map((p, _, ps) => {
      if (p === ps.filter((q) => q.marker === 0xda)[n]) p.body = edit(p.body) ?? p.body;
      return p;
    }));
    const tail = (n: number, ss: number, se: number, ahal: number) => scanAt(n, (b) => {
      b[b.length - 3] = ss;
      b[b.length - 2] = se;
      b[b.length - 1] = ahal;
    });
    const scans = parts(progressive).filter((p) => p.marker === 0xda);
    const ac = scans.findIndex((p) => p.body[p.body.length - 3]! > 0);
    const acSs = scans[ac]!.body[scans[ac]!.body.length - 3]!;
    expect(readJpegStill(tail(ac, acSs, 64, 0))).toBeNull();
    expect(readJpegStill(tail(ac, 5, 4, 0))).toBeNull();
    expect(readJpegStill(tail(ac, acSs, 63, 0xe0))).toBeNull();
    expect(readJpegStill(tail(ac, acSs, 63, 0x0e))).toBeNull();
    expect(readJpegStill(tail(0, 0, 63, 0))).toBeNull();
    // with every table defined: the baseline still's one full scan, under a progressive frame
    expect(readJpegStill(edited((ps) => {
      sof(ps).marker = 0xc2;
      return ps;
    }))).toBeNull();
    expect(readJpegStill(tail(0, 0, 0, 0x01))).toEqual({ width: 48, height: 32 });
    // an AC scan of two components
    const ids = sofOf(progressive);
    const sel = scans[ac]!.body[2]!;
    expect(readJpegStill(scanAt(ac, (b) => Buffer.from([2, ids[0]!, sel, ids[1]!, sel, ...b.subarray(b.length - 3)])))).toBeNull();
    // a selector over 3 is refused even where the scan does not decode with it
    expect(readJpegStill(scanAt(ac, (b) => void (b[2] = 0x40 | (sel & 0x0f))))).toBeNull();
    expect(readJpegStill(scanAt(0, (b) => void (b[2] = (b[2]! & 0xf0) | 0x04)))).toBeNull();
  });

  it('refuses a scan header whose length is not its fields', () => {
    expect(readJpegStill(scan((p) => void (p.body = Buffer.concat([p.body, Buffer.from([0])]))))).toBeNull();
    expect(readJpegStill(scan((p) => void (p.body = p.body.subarray(0, p.body.length - 1))))).toBeNull();
  });

  it('reads stuffed bytes as entropy data, and refuses a scan that never reaches a marker', () => {
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.from([0xff, 0x00]))))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.concat([p.scan!, Buffer.from([0xff, 0x00, 0x12])]))))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(Buffer.concat([build(parts(big), Buffer.alloc(0)), Buffer.from([0x12, 0xff])]))).toBeNull();
  });

  it('reads restart markers only after a nonzero restart interval (Codex P2 on #1166)', () => {
    const rst = Buffer.from([0xff, 0xd0, 0x12]);
    const withRst = (interval: number[] | null) => edited((ps) => {
      sos(ps).scan = Buffer.concat([sos(ps).scan!, rst]);
      return interval ? before(ps, 0xda, segment(0xdd, interval)) : ps;
    });
    expect(readJpegStill(withRst([0, 4]))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(withRst(null))).toBeNull();
    expect(readJpegStill(withRst([0, 0]))).toBeNull();
    // a later DRI of 0 turns restarts off again
    expect(readJpegStill(build(parts(restart).map((p) => (p.marker === 0xdd ? segment(0xdd, [0, 0]) : p))))).toBeNull();
  });

  it('refuses a scan with no coded data, restart markers alone included (Codex P2s on #1166)', () => {
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.alloc(0))))).toBeNull();
    const two = (data: Buffer) => edited((ps) => {
      const id = sof(ps).body[6]!;
      sof(ps).marker = 0xc2;
      const first = sos(ps);
      // a DC first scan of every component (Ss 0, Se 0, Al 1)
      first.body = Buffer.concat([first.body.subarray(0, first.body.length - 3), Buffer.from([0, 0, 0x01])]);
      // the second scan is a DC refinement of one component, whose header is valid on its own
      return [...before(ps, 0xda, segment(0xdd, [0, 1])), { ...first, body: Buffer.from([1, id, 0, 0, 0, 0x10]), scan: data }];
    });
    expect(readJpegStill(two(Buffer.from([0x12])))).toEqual({ width: 640, height: 360 });
    expect(readJpegStill(two(Buffer.alloc(0)))).toBeNull();
    expect(readJpegStill(two(Buffer.from([0xff, 0xd0])))).toBeNull();
    expect(readJpegStill(two(Buffer.from([0xff, 0xd0, 0xff, 0xd1])))).toBeNull();
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.from([0xff, 0xd0]))))).toBeNull();
  });

  it('refuses a marker the walk does not name inside the entropy data', () => {
    expect(readJpegStill(scan((p) => void (p.scan = Buffer.concat([p.scan!, Buffer.from([0xff, 0xfe, 0, 4, 1, 2])]))))).toBeNull();
  });
});
