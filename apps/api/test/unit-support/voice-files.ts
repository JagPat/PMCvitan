/**
 * Stage 1 voice (#482) — tiny hand-built recordings for `isAudioOnlyRecording` and the voice upload tests, shaped like
 * what each browser's MediaRecorder writes: Chrome and Android's WebM with Opus (Segment and Clusters of unknown size,
 * SimpleBlocks), iOS Safari's fragmented MP4 (an empty sample table in moov, the samples in moof > traf > trun), and
 * Firefox's Ogg with Opus (OpusHead, OpusTags, then audio pages). They carry real container headers, track tables and
 * sample tables, with a few placeholder bytes where the encoded sound would be. Each container also has its
 * video-only twin and its header-only cut, which the check refuses.
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

export const WEBM = { header: 0x1a45dfa3, docType: 0x4282, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, trackEntry: 0xae, trackNumber: 0xd7, trackType: 0x83, codecId: 0x86, cluster: 0x1f43b675, timestamp: 0xe7, simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1, void: 0xec } as const;

export const webmHeader = (docType = 'webm') =>
  ebml(WEBM.header, Buffer.concat([ebml(0x4286, uint(1)), ebml(0x42f7, uint(1)), ebml(WEBM.docType, docType)]));
export const webmTrack = (n: number, type: number, codec: string) =>
  ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, uint(n)), ebml(WEBM.trackType, uint(type)), ebml(WEBM.codecId, codec)]));
/** a block's body: its track as an EBML number, a 16-bit timecode, the flags (keyframe), then the frame */
export const blockBody = (track: number, frame: Buffer = Buffer.from([0xfc, 0xff, 0xfe, 1, 2, 3])) =>
  Buffer.concat([Buffer.from([0x80 | track, 0, 0, 0x80]), frame]);
export const simpleBlock = (track = 1, frame?: Buffer) => ebml(WEBM.simpleBlock, blockBody(track, frame));
/** a laced SimpleBlock: flags name the lacing (1 Xiph, 2 fixed-size, 3 EBML), then the frame count less one, the lace table, and the frames */
export const lacedBlock = (track: number, lacing: 1 | 2 | 3, frameCount: number, table: Buffer, frames: Buffer) =>
  ebml(WEBM.simpleBlock, Buffer.concat([Buffer.from([0x80 | track, 0, 0, 0x80 | (lacing << 1), frameCount - 1]), table, frames]));
export const webmCluster = (blocks: Buffer[] = [simpleBlock(), simpleBlock()], unknown = true) =>
  ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, uint(0)), ...blocks]), unknown);

/** a WebM as Chrome's MediaRecorder writes it: Segment and Cluster of unknown size, Tracks first, then the blocks */
export const webmFile = (tracks: Buffer[] = [webmTrack(1, 2, 'A_OPUS')], docType = 'webm', clusters: Buffer[] = [webmCluster()]): Buffer =>
  Buffer.concat([
    webmHeader(docType),
    ebml(WEBM.segment, Buffer.concat([ebml(WEBM.info, ebml(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40]))), ebml(WEBM.tracks, Buffer.concat(tracks)), ...clusters]), true),
  ]);
export const webmVideoOnly = () => webmFile([webmTrack(1, 1, 'V_VP8')]);
/** the header and track table with no Cluster: no sound at all */
export const webmHeaderOnly = () => webmFile(undefined, 'webm', []);

// ── Ogg ──────────────────────────────────────────────────────────────────────────────────────

/** the Ogg page checksum: CRC-32 with polynomial 0x04c11db7, no reflection, initial and final value 0 */
const OGG_CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
/** a page with its checksum written in, as a real recorder leaves it */
export const oggSeal = (page: Buffer): Buffer => {
  const out = Buffer.from(page);
  out.writeUInt32LE(0, 22);
  let crc = 0;
  for (const byte of out) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  out.writeUInt32LE(crc, 22);
  return out;
};

/** one Ogg page holding whole packets, with its checksum */
export const oggPage = (headerType: number, serial: number, sequence: number, payload: Buffer | Buffer[]): Buffer => {
  const packets = Array.isArray(payload) ? payload : [payload];
  const lacing: number[] = [];
  for (const p of packets) {
    let left = p.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
  }
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head[4] = 0;
  head[5] = headerType;
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(sequence, 18);
  head[26] = lacing.length;
  return oggSeal(Buffer.concat([head, Buffer.from(lacing), ...packets]));
};
/** one Ogg page with the lacing values given as they are, so a packet can be left open (a last value of 255); sealed */
export const oggPageRaw = (headerType: number, serial: number, sequence: number, lacing: number[], data: Buffer): Buffer => {
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head[5] = headerType;
  head.writeUInt32LE(serial, 14);
  head.writeUInt32LE(sequence, 18);
  head[26] = lacing.length;
  return oggSeal(Buffer.concat([head, Buffer.from(lacing), data]));
};
export const OPUS_HEAD = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])]);
export const OPUS_TAGS = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.from([7, 0, 0, 0]), Buffer.from('Mozilla', 'latin1'), Buffer.alloc(4)]);
/** Vorbis I identification: version 0, one channel, 48 kHz, no bitrates, block sizes 256/2048, the framing bit */
export const VORBIS_ID = Buffer.concat([Buffer.from([0x01]), Buffer.from('vorbis', 'latin1'), Buffer.from([0, 0, 0, 0, 1, 0x80, 0xbb, 0, 0]), Buffer.alloc(12, 0), Buffer.from([0xb8, 1])]);
export const VORBIS_COMMENT = Buffer.concat([Buffer.from([0x03]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(9, 0)]);
export const VORBIS_SETUP = Buffer.concat([Buffer.from([0x05]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(12, 1)]);
export const THEORA_ID = Buffer.concat([Buffer.from([0x80]), Buffer.from('theora', 'latin1'), Buffer.alloc(35, 0)]);
/** one encoded Opus frame's worth of placeholder bytes */
export const AUDIO_PACKET = Buffer.from([0xfc, 0xff, 0xfe, 1, 2, 3]);

/** an Ogg Opus file as Firefox writes it: OpusHead alone on the first page, OpusTags on the next, then audio */
export const oggFile = (audio: Buffer[] = [AUDIO_PACKET, AUDIO_PACKET]): Buffer =>
  Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x00, 1, 1, OPUS_TAGS), ...(audio.length ? [oggPage(0x04, 1, 2, audio)] : [])]);
/** an Ogg Vorbis file: the identification header alone, then the comment and setup headers, then audio */
export const oggVorbisFile = (audio: Buffer[] = [AUDIO_PACKET]): Buffer =>
  Buffer.concat([oggPage(0x02, 1, 0, VORBIS_ID), oggPage(0x00, 1, 1, [VORBIS_COMMENT, VORBIS_SETUP]), ...(audio.length ? [oggPage(0x04, 1, 2, audio)] : [])]);
export const oggVideoOnly = () =>
  Buffer.concat([oggPage(0x02, 1, 0, THEORA_ID), oggPage(0x00, 1, 1, Buffer.from([0x81, 1, 2])), oggPage(0x04, 1, 2, AUDIO_PACKET)]);
/** the header packets with no audio packet after them */
export const oggHeaderOnly = () => oggFile([]);

// ── MP4 (ISO BMFF) ───────────────────────────────────────────────────────────────────────────

export const box = (type: string, payload: Buffer | Buffer[] = Buffer.alloc(0)): Buffer => {
  const data = Array.isArray(payload) ? Buffer.concat(payload) : payload;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data]);
};
const u32 = (...values: number[]) => {
  const out = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => out.writeUInt32BE(v >>> 0, 4 * i));
  return out;
};
/** a full box: version and flags, then its fields */
export const fullBox = (type: string, version: number, flags: number, payload: Buffer | Buffer[] = Buffer.alloc(0)) =>
  box(type, [u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...(Array.isArray(payload) ? payload : [payload])]);
export const ftyp = (brand = 'M4A ') => box('ftyp', Buffer.concat([Buffer.from(brand, 'latin1'), Buffer.alloc(4), Buffer.from(`${brand}isom`, 'latin1')]));
/** a hdlr full box: version and flags, pre_defined, the handler type, three reserved words, an empty name */
export const hdlr = (handler: string) => box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from(handler, 'latin1'), Buffer.alloc(13)]));
/** tkhd version 0: creation and modification times, then the track_ID */
export const tkhd = (trackId: number) => fullBox('tkhd', 0, 3, [u32(0, 0, trackId), Buffer.alloc(72)]);
/** stsz: one size for every sample, or (size 0) a table of sizes */
export const stsz = (sizes: number[]) => fullBox('stsz', 0, 0, [u32(0, sizes.length), u32(...sizes)]);
/** stsc: one run, every sample in chunk 1 (none when there are no samples) */
export const stsc = (samples: number) => fullBox('stsc', 0, 0, samples ? u32(1, 1, samples, 1) : u32(0));
/** stco: one chunk at `offset` (none when there are no samples) */
export const stco = (samples: number, offset: number) => fullBox('stco', 0, 0, samples ? u32(1, offset) : u32(0));
/** stsd with one sample entry of this type (mp4a is AAC; Opus; avc1 a picture) */
export const stsd = (entry: string) => fullBox('stsd', 0, 0, [u32(1), box(entry, Buffer.alloc(28))]);
/** the media header each handler's minf carries: smhd for sound, vmhd for video, nmhd for anything else */
const mediaHeader = (handler: string) => (handler === 'soun' ? fullBox('smhd', 0, 0, u32(0)) : handler === 'vide' || handler === 'auxv' ? fullBox('vmhd', 0, 1, Buffer.alloc(8)) : fullBox('nmhd', 0, 0));
const ENTRY: Record<string, string> = { soun: 'mp4a', vide: 'avc1', auxv: 'avc1' };
export const stbl = (sizes: number[], offset = 0, entry = 'mp4a') =>
  box('stbl', [stsd(entry), fullBox('stts', 0, 0, u32(0)), stsc(sizes.length), stsz(sizes), stco(sizes.length, offset)]);
/** a track, as a recorder writes it, around `table` (the stbl's boxes) */
export const trakAround = (handler: string, trackId: number, table: Buffer[]) =>
  box('trak', [tkhd(trackId), box('mdia', [fullBox('mdhd', 0, 0, Buffer.alloc(20)), hdlr(handler), box('minf', [mediaHeader(handler), box('stbl', table)])])]);
/** a track whose samples (if any) sit in one chunk at `offset` */
export const trak = (handler: string, trackId = 1, sizes: number[] = [], offset = 0) =>
  box('trak', [tkhd(trackId), box('mdia', [fullBox('mdhd', 0, 0, Buffer.alloc(20)), hdlr(handler), box('minf', [mediaHeader(handler), stbl(sizes, offset, ENTRY[handler] ?? 'mett')])])]);
export const mdat = (bytes: number) => box('mdat', Buffer.alloc(bytes, 7));
/**
 * `head(offset)` laid out before an mdat whose header is `mdatHeader` bytes: `offset` is where that mdat's payload
 * starts, for the chunk offsets the head writes (their width does not change the head's length).
 */
export const laidOut = (head: (offset: number) => Buffer, mdatHeader = 8) => head(head(0).length + mdatHeader);

/** a plain MP4: ftyp, moov whose sample table lists the audio samples in one chunk, then the media data holding it */
export const mp4File = (handlers: string[] = ['soun'], brand = 'M4A ', sizes = [4, 4]): Buffer =>
  Buffer.concat([
    laidOut((o) => Buffer.concat([ftyp(brand), box('moov', [box('mvhd', Buffer.alloc(100)), ...handlers.map((h, i) => trak(h, i + 1, sizes, o))])])),
    mdat(sizes.reduce((a, s) => a + s, 0)),
  ]);
export const mp4VideoOnly = () => mp4File(['vide'], 'isom');
/** ftyp and an audio moov whose chunk points past the end, with no media data */
export const mp4HeaderOnly = () =>
  laidOut((o) => Buffer.concat([ftyp(), box('moov', [box('mvhd', Buffer.alloc(100)), trak('soun', 1, [4, 4], o)])]));

/** trex: the track's defaults for its fragments */
export const trex = (trackId: number, defaultSize = 0) => fullBox('trex', 0, 0, u32(trackId, 1, 0, defaultSize, 0));
/** tfhd with default-base-is-moof, and a default sample size when given */
export const tfhd = (trackId: number, defaultSize?: number) =>
  fullBox('tfhd', 0, 0x020000 | (defaultSize !== undefined ? 0x10 : 0), u32(trackId, ...(defaultSize !== undefined ? [defaultSize] : [])));
/** trun with a data offset from its base, and per-sample sizes when given (else the defaults apply to `count` samples) */
export const trun = (sizes: number[] | { count: number }, dataOffset = 0) =>
  Array.isArray(sizes)
    ? fullBox('trun', 0, 0x000201, [u32(sizes.length, dataOffset), u32(...sizes)])
    : fullBox('trun', 0, 0x000001, u32(sizes.count, dataOffset));
export const moof = (sequence: number, traf: Buffer[]) => box('moof', [fullBox('mfhd', 0, 0, u32(sequence)), box('traf', traf)]);
/** a moof whose trafs are `traf(offset)`, where `offset` is the distance from the moof's start to the next mdat's payload */
export const fragment = (sequence: number, traf: (offset: number) => Buffer[]) => {
  const size = moof(sequence, traf(0)).length;
  return moof(sequence, traf(size + 8));
};

/** a fragmented MP4 as iOS Safari's MediaRecorder writes it: an empty sample table, mvex/trex, then moof + mdat pairs */
export const mp4Fragmented = (fragments: number[][] = [[4, 4], [4]], trexSize = 0): Buffer =>
  Buffer.concat([
    ftyp('iso5'),
    box('moov', [box('mvhd', Buffer.alloc(100)), trak('soun', 1, []), box('mvex', trex(1, trexSize))]),
    ...fragments.flatMap((sizes, i) => [fragment(i + 1, (o) => [tfhd(1), trun(sizes, o)]), mdat(sizes.reduce((a, s) => a + s, 0))]),
  ]);

export const base64 = (b: Buffer) => b.toString('base64');
