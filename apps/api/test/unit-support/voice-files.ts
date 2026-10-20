/**
 * Stage 1 voice (#482) — tiny hand-built recordings that are structurally valid in each container the upload
 * accepts, and their video-only twins, for `isAudioOnlyRecording` and the voice upload tests. They carry real
 * container headers and track tables, with a few placeholder bytes where the encoded sound would be.
 */

// ── WebM (EBML) ──────────────────────────────────────────────────────────────────────────────

const idBytes = (id: number): Buffer => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Buffer.from(out);
};
const sizeBytes = (n: number): Buffer => {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  const out = Buffer.alloc(8);
  out[0] = 0x01;
  out.writeUIntBE(n, 2, 6);
  return out;
};
/** an EBML element; `unknown` writes the all-ones "unknown size" a live recorder uses */
export const ebml = (id: number, payload: Buffer | string, unknown = false): Buffer => {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
  return Buffer.concat([idBytes(id), unknown ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : sizeBytes(data.length), data]);
};
const uint = (n: number) => Buffer.from([n]);

export const WEBM = { header: 0x1a45dfa3, docType: 0x4282, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, trackEntry: 0xae, trackNumber: 0xd7, trackType: 0x83, codecId: 0x86, cluster: 0x1f43b675, timestamp: 0xe7, simpleBlock: 0xa3, void: 0xec } as const;

export const webmHeader = (docType = 'webm') =>
  ebml(WEBM.header, Buffer.concat([ebml(0x4286, uint(1)), ebml(0x42f7, uint(1)), ebml(WEBM.docType, docType)]));
export const webmTrack = (n: number, type: number, codec: string) =>
  ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, uint(n)), ebml(WEBM.trackType, uint(type)), ebml(WEBM.codecId, codec)]));
export const webmCluster = (unknown = true) =>
  ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, uint(0)), ebml(WEBM.simpleBlock, Buffer.from([0x81, 0, 0, 0x80, 1, 2, 3, 4]))]), unknown);

/** a WebM as Chrome's MediaRecorder writes it: Segment and Cluster of unknown size, Tracks first */
export const webmFile = (tracks: Buffer[] = [webmTrack(1, 2, 'A_OPUS')], docType = 'webm'): Buffer =>
  Buffer.concat([
    webmHeader(docType),
    ebml(WEBM.segment, Buffer.concat([ebml(WEBM.info, ebml(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40]))), ebml(WEBM.tracks, Buffer.concat(tracks)), webmCluster()]), true),
  ]);
export const webmVideoOnly = () => webmFile([webmTrack(1, 1, 'V_VP8')]);

// ── Ogg ──────────────────────────────────────────────────────────────────────────────────────

/** one Ogg page; the checksum is left zero, which the check does not read */
export const oggPage = (headerType: number, serial: number, sequence: number, payload: Buffer): Buffer => {
  const lacing: number[] = [];
  let left = payload.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head[4] = 0;
  head[5] = headerType;
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(sequence, 18);
  head[26] = lacing.length;
  return Buffer.concat([head, Buffer.from(lacing), payload]);
};
export const OPUS_HEAD = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])]);
export const VORBIS_ID = Buffer.concat([Buffer.from([0x01]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(23, 0)]);
export const THEORA_ID = Buffer.concat([Buffer.from([0x80]), Buffer.from('theora', 'latin1'), Buffer.alloc(35, 0)]);

/** an Ogg file: one beginning-of-stream page per stream, then a data page for each */
export const oggFile = (heads: Buffer[] = [OPUS_HEAD]): Buffer =>
  Buffer.concat([
    ...heads.map((h, i) => oggPage(0x02, i + 1, 0, h)),
    ...heads.map((_, i) => oggPage(0x00, i + 1, 1, Buffer.from([1, 2, 3, 4]))),
  ]);
export const oggVideoOnly = () => oggFile([THEORA_ID]);

// ── MP4 (ISO BMFF) ───────────────────────────────────────────────────────────────────────────

export const box = (type: string, payload: Buffer | Buffer[] = Buffer.alloc(0)): Buffer => {
  const data = Array.isArray(payload) ? Buffer.concat(payload) : payload;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data]);
};
export const ftyp = (brand = 'M4A ') => box('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from(`${brand}isom`, 'latin1')]));
/** a hdlr full box: version and flags, pre_defined, the handler type, three reserved words, an empty name */
export const hdlr = (handler: string) => box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(13)]));
export const trak = (handler: string) => box('trak', [box('tkhd', Buffer.alloc(84)), box('mdia', [box('mdhd', Buffer.alloc(24)), hdlr(handler), box('minf')])]);

/** an MP4 as Safari's MediaRecorder writes it: ftyp, moov with its tracks, then the media data */
export const mp4File = (handlers: string[] = ['soun'], brand = 'M4A '): Buffer =>
  Buffer.concat([ftyp(brand), box('moov', [box('mvhd', Buffer.alloc(100)), ...handlers.map(trak)]), box('mdat', Buffer.from([1, 2, 3, 4]))]);
export const mp4VideoOnly = () => mp4File(['vide'], 'isom');

export const base64 = (b: Buffer) => b.toString('base64');
