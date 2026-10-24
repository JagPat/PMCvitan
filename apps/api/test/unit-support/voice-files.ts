/**
 * Stage 1 voice (#482) — tiny hand-built recordings for `isAudioOnlyRecording` and the voice upload tests, shaped like
 * what each browser's MediaRecorder writes: Chrome and Android's WebM with Opus (Segment and Clusters of unknown size,
 * SimpleBlocks), iOS Safari's fragmented MP4 (an empty sample table in moov, the samples in moof > traf > trun), and
 * Firefox's Ogg with Opus (OpusHead, OpusTags, then audio pages). They carry real container headers, track tables,
 * codec configurations (OpusHead, esds, dOps) and sample tables, with a few placeholder bytes where the encoded sound
 * would be. Each container also has its video-only twin and its header-only cut, which the check refuses. Real
 * recordings, from Chromium's MediaRecorder, are in ./recordings.
 */

/** an OpusHead: version 1, one channel, a pre-skip of 312, 48 kHz, no gain, mapping family 0 */
export const OPUS_HEAD = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])]);

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

export const WEBM = { header: 0x1a45dfa3, docType: 0x4282, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, trackEntry: 0xae, trackNumber: 0xd7, trackType: 0x83, codecId: 0x86, cluster: 0x1f43b675, timestamp: 0xe7, simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1, void: 0xec, codecPrivate: 0x63a2 } as const;

export const webmHeader = (docType = 'webm') =>
  ebml(WEBM.header, Buffer.concat([ebml(0x4286, uint(1)), ebml(0x42f7, uint(1)), ebml(WEBM.docType, docType)]));
/** a TrackEntry; an Opus one carries its OpusHead as CodecPrivate, as Chrome writes it */
export const webmTrack = (n: number, type: number, codec: string) =>
  ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, uint(n)), ebml(WEBM.trackType, uint(type)), ebml(WEBM.codecId, codec),
    ...(codec === 'A_OPUS' ? [ebml(WEBM.codecPrivate, OPUS_HEAD)] : [])]));
/** a block's body: its track as an EBML number, a 16-bit timecode, the flags (keyframe), then the frame */
export const blockBody = (track: number, frame: Buffer = Buffer.from([0xfc, 0xff, 0xfe, 1, 2, 3])) =>
  Buffer.concat([Buffer.from([0x80 | track, 0, 0, 0x80]), frame]);
export const simpleBlock = (track = 1, frame?: Buffer) => ebml(WEBM.simpleBlock, blockBody(track, frame));
/** a laced SimpleBlock: flags name the lacing (1 Xiph, 2 fixed-size, 3 EBML), then the frame count less one, the lace table, and the frames */
export const lacedBlock = (track: number, lacing: 1 | 2 | 3, frameCount: number, table: Buffer, frames: Buffer) =>
  ebml(WEBM.simpleBlock, Buffer.concat([Buffer.from([0x80 | track, 0, 0, 0x80 | (lacing << 1), frameCount - 1]), table, frames]));
export const webmCluster = (blocks: Buffer[] = [simpleBlock(), simpleBlock()], unknown = true) =>
  ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, uint(0)), ...blocks]), unknown);

const double = (n: number) => {
  const out = Buffer.alloc(8);
  out.writeDoubleBE(n);
  return out;
};
/** Info: a timestamp scale of 1 ms, and a Duration in those ticks when given (a live recorder writes none) */
export const webmInfo = (durationMs?: number) =>
  ebml(WEBM.info, Buffer.concat([ebml(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])), ...(durationMs !== undefined ? [ebml(0x4489, double(durationMs))] : [])]));
/** a Cluster whose Timestamp is `ticks` (ms), holding `blocks` */
export const webmClusterAt = (ticks: number, blocks: Buffer[] = [simpleBlock()]) => {
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(ticks);
  return ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, ts), ...blocks]));
};

/** a WebM as Chrome's MediaRecorder writes it: Segment and Cluster of unknown size, Tracks first, then the blocks */
export const webmFile = (tracks: Buffer[] = [webmTrack(1, 2, 'A_OPUS')], docType = 'webm', clusters: Buffer[] = [webmCluster()], info = webmInfo()): Buffer =>
  Buffer.concat([
    webmHeader(docType),
    ebml(WEBM.segment, Buffer.concat([info, ebml(WEBM.tracks, Buffer.concat(tracks)), ...clusters]), true),
  ]);
/** a WebM recording of `seconds`, as its Info Duration says */
export const webmTimed = (seconds: number) => webmFile(undefined, 'webm', [webmCluster()], webmInfo(seconds * 1000));
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
export const OPUS_TAGS = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.from([7, 0, 0, 0]), Buffer.from('Mozilla', 'latin1'), Buffer.alloc(4)]);
/** Vorbis I identification (version 0, one channel, 48 kHz, block sizes 256/2048, the framing bit): refused, as no browser records Vorbis */
export const VORBIS_ID = Buffer.concat([Buffer.from([0x01]), Buffer.from('vorbis', 'latin1'), Buffer.from([0, 0, 0, 0, 1, 0x80, 0xbb, 0, 0]), Buffer.alloc(12, 0), Buffer.from([0xb8, 1])]);
export const VORBIS_COMMENT = Buffer.concat([Buffer.from([0x03]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(9, 0)]);
export const VORBIS_SETUP = Buffer.concat([Buffer.from([0x05]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(12, 1)]);
export const THEORA_ID = Buffer.concat([Buffer.from([0x80]), Buffer.from('theora', 'latin1'), Buffer.alloc(35, 0)]);
/** one encoded Opus frame's worth of placeholder bytes */
export const AUDIO_PACKET = Buffer.from([0xfc, 0xff, 0xfe, 1, 2, 3]);

/** the page with this granule position written in, resealed */
export const withGranule = (page: Buffer, granule: bigint): Buffer => {
  const out = Buffer.from(page);
  out.writeBigInt64LE(granule, 6);
  return oggSeal(out);
};
/** OPUS_HEAD's pre-skip */
export const OPUS_PRE_SKIP = 312;
/** an Ogg Opus recording of `seconds`, as its last granule position (less the pre-skip) says */
export const oggTimed = (seconds: number) =>
  Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x00, 1, 1, OPUS_TAGS), withGranule(oggPage(0x04, 1, 2, [AUDIO_PACKET, AUDIO_PACKET]), BigInt(OPUS_PRE_SKIP + 48_000 * seconds))]);

/** an Ogg Opus file as Firefox writes it: OpusHead alone on the first page, OpusTags on the next, then audio */
export const oggFile = (audio: Buffer[] = [AUDIO_PACKET, AUDIO_PACKET]): Buffer =>
  Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x00, 1, 1, OPUS_TAGS), ...(audio.length ? [oggPage(0x04, 1, 2, audio)] : [])]);
/** an Ogg Vorbis file, which the check refuses: the identification header alone, then the comment and setup headers, then audio */
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
/** tkhd version 0, whole (84 bytes): creation and modification times, the track_ID, then the rest of its fields */
export const tkhd = (trackId: number) => fullBox('tkhd', 0, 3, [u32(0, 0, trackId), Buffer.alloc(68)]);
/** stsz: one size for every sample, or (size 0) a table of sizes */
export const stsz = (sizes: number[]) => fullBox('stsz', 0, 0, [u32(0, sizes.length), u32(...sizes)]);
/** stsc: one run, every sample in chunk 1 (none when there are no samples) */
export const stsc = (samples: number) => fullBox('stsc', 0, 0, samples ? u32(1, 1, samples, 1) : u32(0));
/** stco: one chunk at `offset` (none when there are no samples) */
export const stco = (samples: number, offset: number) => fullBox('stco', 0, 0, samples ? u32(1, offset) : u32(0));
/** an MPEG-4 descriptor: its tag, its size (in `sizeBytes` bytes, as some writers pad it to four), then its body */
export const descriptor = (tag: number, body: Buffer | Buffer[], sizeBytes = 1): Buffer => {
  const data = Array.isArray(body) ? Buffer.concat(body) : body;
  const size = Array.from({ length: sizeBytes }, (_, i) => ((data.length >> (7 * (sizeBytes - 1 - i))) & 0x7f) | (i < sizeBytes - 1 ? 0x80 : 0));
  return Buffer.concat([Buffer.from([tag, ...size]), data]);
};
/** the AAC rate indexes the fixtures use */
const AAC_INDEX: Record<number, number> = { 48_000: 3, 44_100: 4, 16_000: 8 };
/** an AAC-LC AudioSpecificConfig: object type 2, the rate index, the channels, 1,024-sample frames */
export const audioSpecificConfig = (rate = 48_000, channels = 1, objectType = 2) => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE((objectType << 11) | ((AAC_INDEX[rate] ?? 15) << 7) | (channels << 3));
  return out;
};
/** esds as an AAC recorder writes it: an ES_Descriptor around the decoder config (MPEG-4 audio) and SLConfig 2 */
export const esds = (config = audioSpecificConfig(), sizeBytes = 1) =>
  fullBox('esds', 0, 0, descriptor(0x03, [Buffer.from([0, 1, 0]),
    descriptor(0x04, [Buffer.from([0x40, 0x15, 0, 0, 0, 0, 0, 0x7d, 0, 0, 0, 0x7d, 0]), descriptor(0x05, config, sizeBytes)], sizeBytes),
    descriptor(0x06, Buffer.from([0x02]), sizeBytes)], sizeBytes));
/** dOps: version 0, one channel, a pre-skip of 312, 48 kHz, no gain, mapping family 0 */
export const DOPS_BODY = Buffer.from([0, 1, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0]);
export const dOps = (body: Buffer = DOPS_BODY) => box('dOps', body);
/** an audio sample entry's fields (version 0): data_reference_index 1, one channel, 16-bit, the 16.16 sample rate */
export const audioEntryFields = (rate = 48_000) => {
  const out = Buffer.alloc(28);
  out.writeUInt16BE(1, 6);
  out.writeUInt16BE(1, 16);
  out.writeUInt16BE(16, 18);
  out.writeUInt32BE(rate * 65_536, 24);
  return out;
};
/** the sample entry each codec is recorded with: mp4a with its esds (AAC-LC at 48 kHz), Opus with its dOps; else bare */
export const sampleEntry = (entry: string, rate = 48_000) =>
  entry === 'mp4a' ? box('mp4a', [audioEntryFields(rate), esds(audioSpecificConfig(rate))])
    : entry === 'Opus' ? box('Opus', [audioEntryFields(), dOps()])
      : box(entry, Buffer.alloc(28));
/** stsd with one sample entry of this type (mp4a is AAC; Opus; avc1 a picture), or the entry given */
export const stsd = (entry: string | Buffer) => fullBox('stsd', 0, 0, [u32(1), typeof entry === 'string' ? sampleEntry(entry) : entry]);
/** dinf with one data reference: this file (the self-contained flag), or (0) another */
export const dinf = (selfContained = 1) => box('dinf', fullBox('dref', 0, 0, [u32(1), fullBox('url ', 0, selfContained)]));
/** mvhd version 0: creation and modification times, the movie timescale and duration, then the rest of its fields */
export const mvhd = (duration = 0, scale = 1000) => fullBox('mvhd', 0, 0, [u32(0, 0, scale, duration), Buffer.alloc(80)]);
/** the media header each handler's minf carries: smhd for sound, vmhd for video, nmhd for anything else */
const mediaHeader = (handler: string) => (handler === 'soun' ? fullBox('smhd', 0, 0, u32(0)) : handler === 'vide' || handler === 'auxv' ? fullBox('vmhd', 0, 1, Buffer.alloc(8)) : fullBox('nmhd', 0, 0));
const ENTRY: Record<string, string> = { soun: 'mp4a', vide: 'avc1', auxv: 'avc1' };
/** stts: every sample `delta` media ticks long (1,024 for an AAC frame), none when there are no samples */
export const stts = (samples: number, delta = 1024) => fullBox('stts', 0, 0, samples ? u32(1, samples, delta) : u32(0));
/** mdhd version 0: creation and modification times, the media timescale (48 kHz) and duration, then the language */
export const mdhd = (duration = 0, scale = 48_000) => fullBox('mdhd', 0, 0, [u32(0, 0, scale, duration), Buffer.alloc(4)]);
export const stbl = (sizes: number[], offset = 0, entry = 'mp4a') =>
  box('stbl', [stsd(entry), stts(sizes.length), stsc(sizes.length), stsz(sizes), stco(sizes.length, offset)]);
/** a track, as a recorder writes it, around `table` (the stbl's boxes) */
export const trakAround = (handler: string, trackId: number, table: Buffer[]) =>
  box('trak', [tkhd(trackId), box('mdia', [mdhd(), hdlr(handler), box('minf', [mediaHeader(handler), dinf(), box('stbl', table)])])]);
/** a track whose samples (if any) sit in one chunk at `offset`; `extra` goes in the trak after tkhd (an edts) */
export const trak = (handler: string, trackId = 1, sizes: number[] = [], offset = 0, duration = 0, extra: Buffer[] = []) =>
  box('trak', [tkhd(trackId), ...extra, box('mdia', [mdhd(duration), hdlr(handler), box('minf', [mediaHeader(handler), dinf(), stbl(sizes, offset, ENTRY[handler] ?? 'mett')])])]);
export const mdat = (bytes: number) => box('mdat', Buffer.alloc(bytes, 7));
/**
 * `head(offset)` laid out before an mdat whose header is `mdatHeader` bytes: `offset` is where that mdat's payload
 * starts, for the chunk offsets the head writes (their width does not change the head's length).
 */
export const laidOut = (head: (offset: number) => Buffer, mdatHeader = 8) => head(head(0).length + mdatHeader);

/** a plain MP4: ftyp, moov whose sample table lists the audio samples in one chunk, then the media data holding it */
export const mp4File = (handlers: string[] = ['soun'], brand = 'M4A ', sizes = [4, 4], duration = 0): Buffer =>
  Buffer.concat([
    laidOut((o) => Buffer.concat([ftyp(brand), box('moov', [mvhd(), ...handlers.map((h, i) => trak(h, i + 1, sizes, o, duration))])])),
    mdat(sizes.reduce((a, s) => a + s, 0)),
  ]);
export const mp4VideoOnly = () => mp4File(['vide'], 'isom');
/** a plain MP4 recording of `seconds`, as its media header says (48 kHz ticks) */
export const mp4Timed = (seconds: number) => mp4File(['soun'], 'M4A ', [4, 4], 48_000 * seconds);
/** ftyp and an audio moov whose chunk points past the end, with no media data */
export const mp4HeaderOnly = () =>
  laidOut((o) => Buffer.concat([ftyp(), box('moov', [mvhd(), trak('soun', 1, [4, 4], o)])]));

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
    box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1, trexSize))]),
    ...fragments.flatMap((sizes, i) => [fragment(i + 1, (o) => [tfhd(1), trun(sizes, o)]), mdat(sizes.reduce((a, s) => a + s, 0))]),
  ]);

export const base64 = (b: Buffer) => b.toString('base64');

// ── #1013 replacement, second review: whole files with one part changed ──────────────────────

export const MB = 1 << 20;

/** a box with `extra` bytes appended to its payload, its size rewritten (bytes past its last field) */
export const grow = (b: Buffer, extra: Buffer): Buffer => {
  const out = Buffer.concat([b, extra]);
  out.writeUInt32BE(out.length, 0);
  return out;
};

/**
 * A Chrome-shaped WebM with extra children in one place each: the EBML header, Info, the TrackEntry, the sized
 * Cluster (after its Timestamp and one block), or the Segment (after the Cluster); a DocType or CodecID given as
 * bytes; or no Info at all.
 */
export const webmOf = (o: { docType?: Buffer | string; codecId?: Buffer | string; header?: Buffer[]; info?: Buffer[]; entry?: Buffer[]; cluster?: Buffer[]; segment?: Buffer[]; noInfo?: boolean } = {}): Buffer => {
  const header = ebml(WEBM.header, Buffer.concat([ebml(0x4286, uint(1)), ebml(0x42f7, uint(1)), ebml(WEBM.docType, o.docType ?? 'webm'), ...(o.header ?? [])]));
  const info = ebml(WEBM.info, Buffer.concat([ebml(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])), ...(o.info ?? [])]));
  const entry = ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, uint(1)), ebml(WEBM.trackType, uint(2)), ebml(WEBM.codecId, o.codecId ?? 'A_OPUS'),
    ebml(WEBM.codecPrivate, OPUS_HEAD), ...(o.entry ?? [])]));
  const cluster = ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, uint(0)), simpleBlock(), ...(o.cluster ?? [])]));
  return Buffer.concat([header, ebml(WEBM.segment, Buffer.concat([...(o.noInfo ? [] : [info]), ebml(WEBM.tracks, entry), cluster, ...(o.segment ?? [])]), true)]);
};

/** an OpusTags packet: the vendor string, then each comment, then any `extra` bytes */
export const opusTags = (vendor = 'Mozilla', comments: string[] = [], extra: Buffer = Buffer.alloc(0)): Buffer => {
  const le = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(n);
    return out;
  };
  return Buffer.concat([Buffer.from('OpusTags', 'latin1'), le(vendor.length), Buffer.from(vendor, 'latin1'), le(comments.length),
    ...comments.flatMap((c) => [le(c.length), Buffer.from(c, 'latin1')]), extra]);
};

/** one packet over as many pages as its lacing needs (255 values a page), each after the first continuing it */
const packetPages = (packet: Buffer, sequence: number): Buffer[] => {
  const lacing: number[] = [];
  for (let left = packet.length; ; left -= 255) {
    if (left < 255) {
      lacing.push(left);
      break;
    }
    lacing.push(255);
  }
  const pages: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < lacing.length; i += 255) {
    const part = lacing.slice(i, i + 255);
    const size = part.reduce((a, v) => a + v, 0);
    pages.push(oggPageRaw(i === 0 ? 0 : 0x01, 1, sequence + pages.length, part, packet.subarray(at, at + size)));
    at += size;
  }
  return pages;
};

/** a Firefox-shaped Ogg Opus file with this OpusTags packet; `sharePage` puts an audio packet on the tags' own page */
export const oggWithTags = (tags: Buffer, sharePage = false): Buffer => {
  const middle = sharePage ? [oggPage(0x00, 1, 1, [tags, AUDIO_PACKET])] : packetPages(tags, 1);
  return Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), ...middle, oggPage(0x04, 1, 1 + middle.length, [AUDIO_PACKET, AUDIO_PACKET])]);
};

/** a plain AAC MP4 (two 4-byte samples in one chunk) with any of its boxes replaced, or boxes added at the top, in moov or in mdia */
export const plainMp4 = (o: { mvhd?: Buffer; tkhd?: Buffer; mdhd?: Buffer; hdlr?: Buffer; smhd?: Buffer; dinf?: Buffer; table?: (offset: number) => Buffer[];
  mdia?: Buffer[]; moov?: Buffer[]; top?: Buffer[]; after?: Buffer[]; mdatBytes?: number } = {}): Buffer =>
  Buffer.concat([
    laidOut((offset) => Buffer.concat([ftyp(), ...(o.top ?? []), box('moov', [o.mvhd ?? mvhd(), box('trak', [o.tkhd ?? tkhd(1), box('mdia', [o.mdhd ?? mdhd(),
      o.hdlr ?? hdlr('soun'), ...(o.mdia ?? []), box('minf', [o.smhd ?? fullBox('smhd', 0, 0, u32(0)), o.dinf ?? dinf(),
        box('stbl', o.table ? o.table(offset) : [stsd('mp4a'), stts(2), stsc(2), stsz([4, 4]), stco(2, offset)])])])]), ...(o.moov ?? [])])])),
    mdat(o.mdatBytes ?? 8),
    ...(o.after ?? []),
  ]);

/** an iOS-shaped fragmented MP4 (one fragment of two 4-byte samples) with any of its boxes replaced */
export const fragmentedMp4 = (o: { table?: Buffer[]; trex?: Buffer; mvex?: Buffer[]; mfhd?: Buffer; traf?: (offset: number) => Buffer[]; mdatBytes?: number } = {}): Buffer => {
  const traf = o.traf ?? ((offset: number) => [tfhd(1), trun([4, 4], offset)]);
  const moofOf = (offset: number) => box('moof', [o.mfhd ?? fullBox('mfhd', 0, 0, u32(1)), box('traf', traf(offset))]);
  return Buffer.concat([
    ftyp('iso5'),
    box('moov', [mvhd(), o.table ? trakAround('soun', 1, o.table) : trak('soun', 1, []), box('mvex', [...(o.mvex ?? []), o.trex ?? trex(1)])]),
    moofOf(moofOf(0).length + 8),
    mdat(o.mdatBytes ?? 8),
  ]);
};
