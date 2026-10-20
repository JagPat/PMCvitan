/**
 * Stage 1 voice (#482, Codex P2s on #1010 and #1013) — is this upload an audio-only recording, with sound in it, in
 * the container its type names?
 *
 * A bounded structural check, not a demuxer: it reads the headers that list a file's tracks and the tables that say
 * where its samples are, and never decodes the sound. Every structure is read against an allow-list of what a
 * browser's recorder writes (Chrome and Android WebM, Firefox Ogg, iOS Safari MP4): an element, box, page flag,
 * stream, track, handler or codec it does not name is a refusal, never skipped. The rules, with the test pinning each,
 * are in #1013's "Parser rules":
 *  - WebM: an EBML header whose children are known and whose one DocType is "webm", then one Segment and nothing
 *    after it. The Segment holds only SeekHead, Info, Tracks, Cluster, Cues, Tags, Void and CRC-32; exactly one Tracks,
 *    at Segment level and before any Cluster, with exactly one TrackEntry: an audio track (TrackType 2) coded A_OPUS
 *    or A_VORBIS, whose fields and Audio fields are known ones. A Cluster holds only Timestamp, Position, PrevSize,
 *    SimpleBlock, BlockGroup (Block, BlockDuration, ReferenceBlock, DiscardPadding), Void and CRC-32; every block is
 *    on that track, and some block's frames, after any lace table, each hold at least one byte. Only the Segment and
 *    a Cluster may be of unknown size, as Chrome writes them; an unknown-size Cluster ends where a Segment-level
 *    element begins.
 *  - Ogg: whole pages to the last byte, each with the capture pattern, version 0, only the defined flags and a
 *    matching CRC; one logical stream, whose first page alone is its beginning-of-stream page and holds exactly its
 *    identification header (OpusHead, version 0.x, at least one channel; or Vorbis I, version 0, at least one channel
 *    and a sample rate); pages in sequence, continued exactly when a packet runs on, none after its last; its header
 *    packets in order (OpusTags; or Vorbis comment and setup); then an audio packet of at least one byte.
 *  - MP4: a leading `ftyp`; at the top only ftyp, one moov, mdat, moof, free, skip, wide, sidx and mfra; in moov
 *    exactly one trak, whose handler is `soun`, whose minf has smhd, and whose stsd holds exactly one `mp4a` or `Opus`
 *    entry; every container's children from its own allow-list, each table at most once; and the audio samples
 *    (stsz/stsc/stco or co64, and each fragment's runs for that track, from its base with the tfhd and trex
 *    defaults) add up to at least one byte, every chunk or run of them inside an mdat's payload.
 * Every read is bounds-checked, walks are capped in steps (the structure's depth is fixed by the allow-lists), and
 * anything missing, malformed or unexpected answers false: a parse problem is a refusal, never a pass. The input is
 * already bounded by the base64 upload cap.
 */

/** the most elements, pages or boxes one walk visits, so no crafted file can spin the check */
const MAX_STEPS = 100_000;

class Malformed extends Error {}

const fail = (): never => {
  throw new Malformed();
};

export function isAudioOnlyRecording(mime: string, bytes: Buffer): boolean {
  try {
    if (mime === 'audio/webm') return webmIsAudioOnly(bytes);
    if (mime === 'audio/ogg') return oggIsAudioOnly(bytes);
    if (mime === 'audio/mp4') return mp4IsAudioOnly(bytes);
    return false;
  } catch (err) {
    if (err instanceof Malformed || err instanceof RangeError) return false;
    throw err;
  }
}

// ── WebM (EBML) ──────────────────────────────────────────────────────────────────────────────

const EBML_HEADER = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const AUDIO = 0xe1;
const CLUSTER = 0x1f43b675;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const VOID = 0xec;
const CRC32 = 0xbf;

/** EBMLVersion, EBMLReadVersion, EBMLMaxIDLength, EBMLMaxSizeLength, DocType, DocTypeVersion, DocTypeReadVersion */
const EBML_HEADER_CHILDREN = new Set([0x4286, 0x42f7, 0x42f2, 0x42f3, DOC_TYPE, 0x4287, 0x4285, VOID, CRC32]);
/** SeekHead, Info, Tracks, Cluster, Cues, Tags; no Attachments, Chapters or anything else */
const SEGMENT_CHILDREN = new Set([0x114d9b74, INFO, TRACKS, CLUSTER, 0x1c53bb6b, 0x1254c367, VOID, CRC32]);
/** TimestampScale, Duration, MuxingApp, WritingApp, SegmentUUID, DateUTC, Title */
const INFO_CHILDREN = new Set([0x2ad7b1, 0x4489, 0x4d80, 0x5741, 0x73a4, 0x4461, 0x7ba9, VOID, CRC32]);
/**
 * TrackNumber, TrackUID, TrackType, FlagEnabled, FlagDefault, FlagForced, FlagLacing, DefaultDuration, CodecID,
 * CodecPrivate, CodecDelay, SeekPreRoll, Name, Language, LanguageBCP47, Audio; no Video, ContentEncodings or other
 */
const TRACK_ENTRY_CHILDREN = new Set([
  TRACK_NUMBER, 0x73c5, TRACK_TYPE, 0xb9, 0x88, 0x55aa, 0x9c, 0x23e383, CODEC_ID, 0x63a2, 0x56aa, 0x56bb, 0x536e, 0x22b59c, 0x22b59d, AUDIO, VOID, CRC32,
]);
/** SamplingFrequency, Channels, BitDepth, OutputSamplingFrequency */
const AUDIO_CHILDREN = new Set([0xb5, 0x9f, 0x6264, 0x78b5, VOID, CRC32]);
/** Timestamp, Position, PrevSize, SimpleBlock, BlockGroup; no SilentTracks or EncryptedBlock */
const CLUSTER_CHILDREN = new Set([0xe7, 0xa7, 0xab, SIMPLE_BLOCK, BLOCK_GROUP, VOID, CRC32]);
/** Block, BlockDuration, ReferenceBlock, DiscardPadding; no BlockAdditions */
const BLOCK_GROUP_CHILDREN = new Set([BLOCK, 0x9b, 0xfb, 0x75a2, VOID, CRC32]);
/** the codecs a browser records a voice note in */
const WEBM_AUDIO_CODECS = new Set(['A_OPUS', 'A_VORBIS']);

/** An EBML variable-length integer at `at`, within `end`. An ID keeps its marker bit; a size drops it. */
function vint(b: Buffer, at: number, end: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  if (at >= end) fail();
  const first = b[at]!;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  // IDs are at most 4 bytes; sizes at most 8, and past 2^53 they cannot be a real offset here
  if (length > (keepMarker ? 4 : 8) || at + length > end) fail();
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = b[at + i]!;
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  const unknown = !keepMarker && allOnes;
  if (!unknown && !Number.isSafeInteger(value)) fail();
  return { value: unknown ? 0 : value, length, unknown };
}

interface Element { id: number; dataStart: number; dataEnd: number; unknownSize: boolean }

/** The element at `at`, within `end`; an unknown size is allowed only when `allowUnknown` is set, and runs to `end`. */
function readElement(b: Buffer, at: number, end: number, steps: { n: number }, allowUnknown = false): Element {
  if (++steps.n > MAX_STEPS) fail();
  const id = vint(b, at, end, true);
  const size = vint(b, at + id.length, end, false);
  const dataStart = at + id.length + size.length;
  if (size.unknown && !allowUnknown) fail();
  const dataEnd = size.unknown ? end : dataStart + size.value;
  if (dataEnd > end) fail();
  return { id: id.value, dataStart, dataEnd, unknownSize: size.unknown };
}

/** Each element in [start, end), every one sized and named in `allowed`. */
function* elements(b: Buffer, start: number, end: number, steps: { n: number }, allowed: Set<number>): Generator<Element> {
  for (let at = start; at < end;) {
    const e = readElement(b, at, end, steps);
    if (!allowed.has(e.id)) fail();
    yield e;
    at = e.dataEnd;
  }
}

/** An unsigned integer element of 1 to 8 bytes (EBML allows an empty one, which is 0). */
function uintOf(b: Buffer, e: Element): number {
  const width = e.dataEnd - e.dataStart;
  if (width > 8) fail();
  let value = 0;
  for (let i = e.dataStart; i < e.dataEnd; i++) value = value * 256 + b[i]!;
  if (!Number.isSafeInteger(value)) fail();
  return value;
}

/**
 * The number of the one track a Tracks element lists, which must be audio in a codec a browser records voice in, with
 * only known fields; else a refusal.
 */
function audioTrack(b: Buffer, tracks: Element, steps: { n: number }): number {
  let found: number | undefined;
  for (const entry of elements(b, tracks.dataStart, tracks.dataEnd, steps, new Set([TRACK_ENTRY, VOID, CRC32]))) {
    if (entry.id !== TRACK_ENTRY) continue;
    if (found !== undefined) fail(); // one track: a second, of any type, is refused
    const seen = new Map<number, Element>();
    for (const field of elements(b, entry.dataStart, entry.dataEnd, steps, TRACK_ENTRY_CHILDREN)) {
      if (field.id === VOID || field.id === CRC32) continue;
      if (seen.has(field.id)) fail(); // each field once
      seen.set(field.id, field);
      if (field.id === AUDIO) for (const _ of elements(b, field.dataStart, field.dataEnd, steps, AUDIO_CHILDREN));
    }
    const number = seen.get(TRACK_NUMBER);
    const type = seen.get(TRACK_TYPE);
    const codec = seen.get(CODEC_ID);
    if (!number || !type || !codec) fail();
    if (uintOf(b, type!) !== 2) fail(); // audio
    if (!WEBM_AUDIO_CODECS.has(b.toString('latin1', codec!.dataStart, codec!.dataEnd).replace(/\0+$/, ''))) fail();
    found = uintOf(b, number!);
    if (found < 1) fail();
  }
  if (found === undefined) fail();
  return found!;
}

/**
 * A block's track, and whether every one of its frames holds at least one byte; a malformed block fails. The body is
 * the track number, a 16-bit timecode, the flags, then the frames. A laced block (flags bits 1-2: Xiph, fixed-size or
 * EBML lacing) first gives its frame count and, for Xiph and EBML, every frame's size but the last, which is what
 * remains (Codex P2 on #1013): the lace table is read whole, and the sizes it declares must fit in the block.
 */
function blockTrack(b: Buffer, start: number, end: number): { track: number; sounding: boolean } {
  const track = vint(b, start, end, false);
  if (track.unknown) fail();
  const flagsAt = start + track.length + 2;
  if (flagsAt >= end) fail();
  const lacing = (b[flagsAt]! >> 1) & 0x03; // 0 none, 1 Xiph, 2 fixed-size, 3 EBML
  let at = flagsAt + 1;
  const sizes: number[] = [];
  if (lacing === 0) {
    sizes.push(end - at);
  } else {
    if (at >= end) fail();
    const frames = b[at]! + 1; // at most 256
    at++;
    if (lacing === 2) {
      const total = end - at;
      if (total % frames !== 0) fail();
      for (let i = 0; i < frames; i++) sizes.push(total / frames);
    } else {
      let declared = 0;
      for (let i = 0; i < frames - 1; i++) {
        let size: number;
        if (lacing === 1) {
          // Xiph: bytes of 255 run on, the first byte under 255 ends the size
          size = 0;
          let byte: number;
          do {
            if (at >= end) fail();
            byte = b[at++]!;
            size += byte;
          } while (byte === 255);
        } else {
          // EBML: the first size as a number, each next one as a signed difference from the one before
          const v = vint(b, at, end, false);
          if (v.unknown) fail();
          at += v.length;
          size = i === 0 ? v.value : sizes[i - 1]! + v.value - (2 ** (7 * v.length - 1) - 1);
        }
        if (size < 0 || !Number.isSafeInteger(size)) fail();
        sizes.push(size);
        declared += size;
      }
      const last = end - at - declared;
      if (last < 0) fail(); // the declared frames run past the block
      sizes.push(last);
    }
  }
  return { track: track.value, sounding: sizes.every((s) => s > 0) };
}

/**
 * A Cluster's children, from `cluster`'s data to its end (an unknown-size Cluster ends where the next Segment-level
 * element begins, or at the Segment's end): only the allowed children, every block on `track`. Returns where the
 * Segment walk resumes, and whether a block held sound.
 */
function walkCluster(b: Buffer, cluster: Element, track: number, steps: { n: number }): { next: number; sound: boolean } {
  const end = cluster.dataEnd;
  let sound = false;
  let at = cluster.dataStart;
  while (at < end) {
    if (cluster.unknownSize) {
      const id = vint(b, at, end, true).value;
      if (!CLUSTER_CHILDREN.has(id)) {
        if (SEGMENT_CHILDREN.has(id)) return { next: at, sound };
        fail();
      }
    }
    const e = readElement(b, at, end, steps);
    if (!CLUSTER_CHILDREN.has(e.id)) fail();
    const blocks: Element[] = [];
    if (e.id === SIMPLE_BLOCK) blocks.push(e);
    if (e.id === BLOCK_GROUP) {
      for (const x of elements(b, e.dataStart, e.dataEnd, steps, BLOCK_GROUP_CHILDREN)) if (x.id === BLOCK) blocks.push(x);
      if (blocks.length !== 1) fail(); // a BlockGroup holds exactly one Block
    }
    for (const block of blocks) {
      const r = blockTrack(b, block.dataStart, block.dataEnd);
      if (r.track !== track) fail(); // a block on a track the file does not list
      if (r.sounding) sound = true;
    }
    at = e.dataEnd;
  }
  return { next: end, sound };
}

function webmIsAudioOnly(b: Buffer): boolean {
  const steps = { n: 0 };
  const header = readElement(b, 0, b.length, steps);
  if (header.id !== EBML_HEADER) return false;
  const docTypes: string[] = [];
  for (const e of elements(b, header.dataStart, header.dataEnd, steps, EBML_HEADER_CHILDREN)) {
    if (e.id === DOC_TYPE) docTypes.push(b.toString('latin1', e.dataStart, e.dataEnd).replace(/\0+$/, ''));
  }
  if (docTypes.length !== 1 || docTypes[0] !== 'webm') return false;
  // one Segment, and nothing after it
  const segment = readElement(b, header.dataEnd, b.length, steps, true);
  if (segment.id !== SEGMENT || segment.dataEnd !== b.length) return false;
  let track: number | undefined; // the one audio track, from the one Segment-level Tracks
  let sound = false;
  for (let at = segment.dataStart; at < segment.dataEnd;) {
    const id = vint(b, at, segment.dataEnd, true).value;
    const e = readElement(b, at, segment.dataEnd, steps, id === CLUSTER);
    if (!SEGMENT_CHILDREN.has(e.id)) return false;
    if (e.id === CLUSTER) {
      if (track === undefined) return false; // blocks before the track table that names their track
      const r = walkCluster(b, e, track, steps);
      if (r.sound) sound = true;
      at = r.next;
      continue;
    }
    if (e.id === TRACKS) {
      if (track !== undefined) return false; // one track table
      track = audioTrack(b, e, steps);
    } else if (e.id === INFO) {
      for (const _ of elements(b, e.dataStart, e.dataEnd, steps, INFO_CHILDREN));
    }
    // SeekHead, Cues, Tags, Void and CRC-32 are indexes and labels, sized and inside the Segment, with no media
    at = e.dataEnd;
  }
  return track !== undefined && sound;
}

// ── Ogg ──────────────────────────────────────────────────────────────────────────────────────

/** the most Ogg pages one walk visits: a page is at least 27 bytes, so this covers any upload the size cap allows */
const MAX_OGG_PAGES = 500_000;

/** the Ogg page checksum: CRC-32, polynomial 0x04c11db7, no reflection, initial and final value 0 */
const OGG_CRC = Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});

/** The page's checksum over its bytes, with the checksum field (bytes 22-25) read as zero. */
function oggPageCrc(b: Buffer, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = i - start >= 22 && i - start < 26 ? 0 : b[i]!;
    crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc;
}

/** the header packets each codec opens with, by their first bytes, before any audio packet */
const OGG_HEADERS = {
  opus: ['OpusHead', 'OpusTags'],
  vorbis: ['\x01vorbis', '\x03vorbis', '\x05vorbis'],
} as const;

/** The codec an identification header names, from its first bytes and length, if it is a well-formed Opus or Vorbis I one. */
function oggCodec(p: Buffer, length: number): 'opus' | 'vorbis' | null {
  // OpusHead: version 0.x (a major version above 0 is not one a decoder may read), at least one channel
  if (length >= 19 && p.toString('latin1', 0, 8) === 'OpusHead' && (p[8]! & 0xf0) === 0 && p[9]! >= 1) return 'opus';
  // Vorbis I identification: exactly 30 bytes, version 0, channels, a sample rate, the framing bit
  if (length === 30 && p[0] === 0x01 && p.toString('latin1', 1, 7) === 'vorbis' && p.readUInt32LE(7) === 0 && p[11]! >= 1 && p.readUInt32LE(12) > 0 && (p[29]! & 1) === 1) {
    return 'vorbis';
  }
  return null;
}

/** the most of a packet kept while it is read: enough for the longest header it is matched against */
const OGG_HEAD_BYTES = 30;

function oggIsAudioOnly(b: Buffer): boolean {
  let at = 0;
  let serial: number | undefined; // the one logical stream
  let codec: 'opus' | 'vorbis' | undefined;
  let packets = 0; // packets the stream has completed
  let head = Buffer.alloc(0); // the first bytes of the packet being read
  let length = 0; // its length so far
  let open = false; // whether the last page left it unfinished
  let next = 0; // the page sequence number the next page must have
  let ended = false;
  let sound = false;
  for (let page = 0; page < MAX_OGG_PAGES; page++) {
    // whole pages to the last byte; a packet still open at the end never ended, so it is not counted
    if (at === b.length) return sound;
    if (at + 27 > b.length) return false;
    if (b.toString('latin1', at, at + 4) !== 'OggS' || b[at + 4] !== 0) return false;
    const flags = b[at + 5]!;
    if (flags & ~0x07) return false; // only continued (1), first (2) and last (4) are defined
    const segments = b[at + 26]!;
    if (at + 27 + segments > b.length) return false;
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += b[at + 27 + i]!;
    const body = at + 27 + segments;
    const pageEnd = body + payload;
    if (pageEnd > b.length) return false;
    // every page's checksum (Codex P2 on #1013): a page changed in transit or by hand is refused
    if (oggPageCrc(b, at, pageEnd) !== b.readUInt32LE(at + 22)) return false;
    const pageSerial = b.readUInt32LE(at + 14);
    const sequence = b.readUInt32LE(at + 18);
    const first = serial === undefined;
    // one stream: its first page alone is the beginning-of-stream page, and every page is that stream's
    if (first !== ((flags & 0x02) !== 0)) return false;
    if (first) serial = pageSerial;
    if (pageSerial !== serial || ended) return false;
    // in sequence, none missing, and continued exactly when the page before left a packet open
    if (!first && sequence !== next) return false;
    next = sequence + 1;
    if (((flags & 0x01) !== 0) !== open) return false;
    // the lacing values split the page into packets; a packet ends at a value under 255 and may run across pages
    let offset = body;
    let completed = 0;
    for (let i = 0; i < segments; i++) {
      const lace = b[at + 27 + i]!;
      if (head.length < OGG_HEAD_BYTES) head = Buffer.concat([head, b.subarray(offset, offset + Math.min(lace, OGG_HEAD_BYTES - head.length))]);
      length += lace;
      offset += lace;
      if (lace === 255) continue;
      completed++;
      if (packets === 0) {
        // the identification header names the codec
        codec = oggCodec(head, length) ?? undefined;
        if (!codec) return false;
      } else if (packets < OGG_HEADERS[codec!].length) {
        const want = OGG_HEADERS[codec!][packets]!;
        if (head.toString('latin1', 0, want.length) !== want) return false;
      } else if (length > 0) {
        sound = true;
      }
      packets++;
      head = Buffer.alloc(0);
      length = 0;
    }
    if (segments > 0) open = b[at + 27 + segments - 1] === 255;
    // the beginning-of-stream page holds exactly the identification header
    if (first && (completed !== 1 || open)) return false;
    if (flags & 0x04) ended = true;
    at = pageEnd;
  }
  return false;
}

// ── MP4 (ISO BMFF) ───────────────────────────────────────────────────────────────────────────

/** the most samples one track may declare: well past two minutes of any audio codec's frames */
const MAX_SAMPLES = 200_000;

interface Box { type: string; start: number; dataStart: number; end: number }

/**
 * Each box in [start, end): size 1 is a 64-bit size, size 0 (only where `toEnd` allows it: the file's last box) runs
 * to `end`, and anything smaller than its header fails.
 */
function* boxes(b: Buffer, start: number, end: number, steps: { n: number }, toEnd = false): Generator<Box> {
  let at = start;
  while (at < end) {
    if (++steps.n > MAX_STEPS) fail();
    if (at + 8 > end) fail();
    let size = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) fail();
      size = u64(b, at + 8);
      header = 16;
    } else if (size === 0) {
      if (!toEnd) fail();
      size = end - at;
    }
    if (size < header || at + size > end) fail();
    yield { type, start: at, dataStart: at + header, end: at + size };
    at += size;
  }
}

/** A 64-bit field, refused (never rounded) past what a Number holds exactly. */
function u64(b: Buffer, at: number): number {
  const big = b.readBigUInt64BE(at);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(big);
}

/** padding a recorder may leave anywhere */
const PADDING = ['free', 'skip'];
/** the boxes each container may hold; a box not named here is refused */
const MP4_CHILDREN: Record<string, Set<string>> = {
  file: new Set(['ftyp', 'moov', 'mdat', 'moof', 'wide', 'sidx', 'mfra', ...PADDING]),
  moov: new Set(['mvhd', 'trak', 'mvex', 'udta', 'iods', 'meta', ...PADDING]),
  trak: new Set(['tkhd', 'mdia', 'edts', 'udta', ...PADDING]),
  mdia: new Set(['mdhd', 'hdlr', 'minf', 'elng', 'udta', ...PADDING]),
  minf: new Set(['smhd', 'dinf', 'stbl', ...PADDING]),
  stbl: new Set(['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'sgpd', 'sbgp', ...PADDING]),
  mvex: new Set(['mehd', 'trex', ...PADDING]),
  moof: new Set(['mfhd', 'traf', ...PADDING]),
  traf: new Set(['tfhd', 'tfdt', 'trun', 'sgpd', 'sbgp', ...PADDING]),
};
/** the sample entries a browser records voice in: AAC and Opus */
const MP4_AUDIO_ENTRIES = new Set(['mp4a', 'Opus']);

/**
 * A container's children by type, every one named in its allow-list; a type in `once` that appears twice fails.
 */
function children(b: Buffer, start: number, end: number, container: string, steps: { n: number }, once: string[] = []): Map<string, Box[]> {
  const out = new Map<string, Box[]>();
  for (const x of boxes(b, start, end, steps)) {
    if (!MP4_CHILDREN[container]!.has(x.type)) fail();
    const list = out.get(x.type) ?? [];
    list.push(x);
    if (list.length > 1 && once.includes(x.type)) fail();
    out.set(x.type, list);
  }
  return out;
}

/** The only box of this type in `kids`, which must be there. */
function only(kids: Map<string, Box[]>, type: string): Box {
  const list = kids.get(type);
  if (!list || list.length !== 1) fail();
  return list![0]!;
}

/** The payload ranges of the file's mdat boxes; a sample range counts only when it lies wholly inside one. */
type MediaRanges = Array<{ from: number; to: number }>;
const inMedia = (media: MediaRanges, at: number, bytes: number) => media.some((m) => at >= m.from && at + bytes <= m.to);

/** The first box of this type directly inside [start, end), if any. */
function child(b: Buffer, start: number, end: number, type: string, steps: { n: number }): Box | undefined {
  for (const x of boxes(b, start, end, steps)) if (x.type === type) return x;
  return undefined;
}

/** A full box's flags (its version and flags word, low 24 bits) and version. */
const fullBoxHead = (b: Buffer, box: Box) => {
  if (box.dataStart + 4 > box.end) fail();
  return { version: b[box.dataStart]!, flags: b.readUInt32BE(box.dataStart) & 0xffffff };
};

/** A track's track_ID from its tkhd (version 1 has 64-bit times before it). */
function trackId(b: Buffer, tkhd: Box): number {
  const { version } = fullBoxHead(b, tkhd);
  const at = tkhd.dataStart + (version === 1 ? 20 : 12);
  if (at + 4 > tkhd.end) fail();
  return b.readUInt32BE(at);
}

/**
 * The bytes a moov sample table puts in the file, after checking every chunk of them lies inside an mdat (Codex P2
 * on #1013): stsz gives each sample's size, stsc how many samples each chunk holds, and stco or co64 where each chunk
 * starts. Every table is bounds-checked against its box, the sample count is capped, and the chunks must hold
 * exactly the samples stsz lists.
 */
function tableBytes(b: Buffer, stbl: Box, media: MediaRanges, steps: { n: number }): number {
  const stsz = child(b, stbl.dataStart, stbl.end, 'stsz', steps);
  if (!stsz) fail();
  const at = stsz!.dataStart + 4;
  if (at + 8 > stsz!.end) fail();
  const fixed = b.readUInt32BE(at);
  const count = b.readUInt32BE(at + 4);
  if (count > MAX_SAMPLES) fail();
  if (fixed === 0 && at + 8 + 4 * count > stsz!.end) fail();
  if (count === 0) return 0;
  const sizeOf = (i: number) => (fixed !== 0 ? fixed : b.readUInt32BE(at + 8 + 4 * i));
  const stsc = child(b, stbl.dataStart, stbl.end, 'stsc', steps);
  const stco = child(b, stbl.dataStart, stbl.end, 'stco', steps);
  const co64 = child(b, stbl.dataStart, stbl.end, 'co64', steps);
  const offsets = stco ?? co64;
  if (!stsc || !offsets || (stco && co64)) fail();
  const width = stco ? 4 : 8;
  if (offsets!.dataStart + 8 > offsets!.end) fail();
  const chunks = b.readUInt32BE(offsets!.dataStart + 4);
  if (offsets!.dataStart + 8 + width * chunks > offsets!.end) fail();
  const chunkAt = (c: number) => {
    const p = offsets!.dataStart + 8 + width * (c - 1);
    return width === 4 ? b.readUInt32BE(p) : u64(b, p);
  };
  if (stsc!.dataStart + 8 > stsc!.end) fail();
  const runs = b.readUInt32BE(stsc!.dataStart + 4);
  if (runs === 0 || stsc!.dataStart + 8 + 12 * runs > stsc!.end) fail();
  const run = (r: number) => ({
    first: b.readUInt32BE(stsc!.dataStart + 8 + 12 * r),
    perChunk: b.readUInt32BE(stsc!.dataStart + 12 + 12 * r),
  });
  let sample = 0;
  let bytes = 0;
  for (let r = 0; r < runs; r++) {
    const { first, perChunk } = run(r);
    const last = r + 1 < runs ? run(r + 1).first - 1 : chunks;
    // runs start at chunk 1, climb, and stay within the chunks stco lists
    if ((r === 0 && first !== 1) || first < 1 || last < first || last > chunks || perChunk === 0) fail();
    for (let c = first; c <= last; c++) {
      if (++steps.n > MAX_STEPS) fail();
      if (sample + perChunk > count) fail();
      let chunkBytes = 0;
      for (let i = sample; i < sample + perChunk; i++) chunkBytes += sizeOf(i);
      if (chunkBytes > 0 && !inMedia(media, chunkAt(c), chunkBytes)) fail();
      sample += perChunk;
      bytes += chunkBytes;
    }
  }
  if (sample !== count) fail();
  return bytes;
}

/**
 * Whether a track's data reference says its samples are in this file: one dref entry, a `url ` with the
 * self-contained flag. A reference to another file would put the samples beyond this check's reach.
 */
function selfContained(b: Buffer, dinf: Box, steps: { n: number }): boolean {
  const refs = [...boxes(b, dinf.dataStart, dinf.end, steps)];
  if (refs.length !== 1 || refs[0]!.type !== 'dref') return false;
  const dref = refs[0]!;
  if (dref.dataStart + 8 > dref.end || b.readUInt32BE(dref.dataStart + 4) !== 1) return false;
  const entries = [...boxes(b, dref.dataStart + 8, dref.end, steps)];
  return entries.length === 1 && entries[0]!.type === 'url ' && (fullBoxHead(b, entries[0]!).flags & 1) === 1;
}

/** tfhd's defined flags: base_data_offset, sample_description_index, default duration, size and flags, duration-is-empty, default-base-is-moof */
const TFHD_FLAGS = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x10000 | 0x20000;
/** trun's defined flags: data_offset, first_sample_flags, and per-sample duration, size, flags and composition offset */
const TRUN_FLAGS = 0x1 | 0x4 | 0x100 | 0x200 | 0x400 | 0x800;

/** Whether a track's stsd lists exactly one sample entry, of an audio codec a browser records voice in. */
function audioSampleEntry(b: Buffer, stsd: Box, steps: { n: number }): boolean {
  if (stsd.dataStart + 8 > stsd.end) fail();
  if (b.readUInt32BE(stsd.dataStart + 4) !== 1) return false;
  const entries = [...boxes(b, stsd.dataStart + 8, stsd.end, steps)];
  return entries.length === 1 && MP4_AUDIO_ENTRIES.has(entries[0]!.type);
}

function mp4IsAudioOnly(b: Buffer): boolean {
  const steps = { n: 0 };
  const all = [...boxes(b, 0, b.length, steps, true)];
  if (all[0]?.type !== 'ftyp') return false;
  for (const x of all) if (!MP4_CHILDREN.file!.has(x.type)) return false;
  if (all.filter((x) => x.type === 'ftyp').length !== 1) return false;
  const moovs = all.filter((x) => x.type === 'moov');
  if (moovs.length !== 1) return false;
  const moov = children(b, moovs[0]!.dataStart, moovs[0]!.end, 'moov', steps, ['mvhd', 'mvex', 'iods', 'meta']);
  // exactly one track, the voice: a second track of any handler (vide, auxv, meta, text, sbtl, hint, soun) is refused
  const trak = only(moov, 'trak');
  const t = children(b, trak.dataStart, trak.end, 'trak', steps, ['tkhd', 'mdia', 'edts']);
  const mdia = only(t, 'mdia');
  const m = children(b, mdia.dataStart, mdia.end, 'mdia', steps, ['mdhd', 'hdlr', 'minf', 'elng']);
  only(m, 'mdhd');
  const hdlr = only(m, 'hdlr');
  // version and flags (4), pre_defined (4), then the handler type
  if (hdlr.dataStart + 12 > hdlr.end) return false;
  if (b.toString('latin1', hdlr.dataStart + 8, hdlr.dataStart + 12) !== 'soun') return false;
  const minf = only(m, 'minf');
  const mi = children(b, minf.dataStart, minf.end, 'minf', steps, ['smhd', 'dinf', 'stbl']);
  only(mi, 'smhd'); // the sound media header a sound track carries
  for (const dinf of mi.get('dinf') ?? []) if (!selfContained(b, dinf, steps)) return false;
  const stbl = only(mi, 'stbl');
  const st = children(b, stbl.dataStart, stbl.end, 'stbl', steps, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'stss']);
  if (!audioSampleEntry(b, only(st, 'stsd'), steps)) return false;
  const id = trackId(b, only(t, 'tkhd'));
  const media: MediaRanges = all.filter((x) => x.type === 'mdat').map((x) => ({ from: x.dataStart, to: x.end }));
  let samples = tableBytes(b, stbl, media, steps); // the audio sample bytes, each range checked to lie inside an mdat
  let trexSize: number | undefined;
  for (const mvex of moov.get('mvex') ?? []) {
    for (const trex of children(b, mvex.dataStart, mvex.end, 'mvex', steps, ['mehd']).get('trex') ?? []) {
      if (trex.dataStart + 20 > trex.end) fail();
      if (b.readUInt32BE(trex.dataStart + 4) !== id || trexSize !== undefined) return false; // defaults for the one track, once
      trexSize = b.readUInt32BE(trex.dataStart + 16);
    }
  }
  // a fragmented file (iOS) lists its samples per fragment, each run of them at an offset from its fragment's base
  let fragmentSamples = 0;
  for (const fragment of all) {
    if (fragment.type !== 'moof') continue;
    const mo = children(b, fragment.dataStart, fragment.end, 'moof', steps, ['mfhd']);
    only(mo, 'mfhd');
    let previousEnd: number | undefined; // where the previous traf's data ended, the next one's base by default
    for (const traf of mo.get('traf') ?? []) {
      const tr = children(b, traf.dataStart, traf.end, 'traf', steps, ['tfhd', 'tfdt']);
      const tfhd = only(tr, 'tfhd');
      const { flags } = fullBoxHead(b, tfhd);
      if (flags & ~TFHD_FLAGS) return false;
      if (tfhd.dataStart + 8 > tfhd.end) fail();
      if (b.readUInt32BE(tfhd.dataStart + 4) !== id) return false; // a fragment of a track the file does not list
      // tfhd's optional fields, in order: base_data_offset (8), sample_description_index, default duration, size, flags
      let at = tfhd.dataStart + 8;
      const field = (width: number) => {
        if (at + width > tfhd.end) fail();
        const value = width === 8 ? u64(b, at) : b.readUInt32BE(at);
        at += width;
        return value;
      };
      // the base: base_data_offset when given; else the moof itself when default-base-is-moof says so, or for the
      // first traf; else where the previous traf's data ended
      const base = flags & 0x1 ? field(8) : flags & 0x20000 ? fragment.start : (previousEnd ?? fragment.start);
      if (flags & 0x2) field(4);
      if (flags & 0x8) field(4);
      const defaultSize = flags & 0x10 ? field(4) : (trexSize ?? 0);
      let cursor = base;
      for (const trun of tr.get('trun') ?? []) {
        const run = trunRun(b, trun, defaultSize);
        fragmentSamples += run.count;
        if (fragmentSamples > MAX_SAMPLES) fail();
        // a run starts at its data_offset from the base, else right after the previous run
        if (run.dataOffset !== undefined) cursor = base + run.dataOffset;
        if (cursor < 0 || !Number.isSafeInteger(cursor + run.bytes)) fail();
        if (run.bytes > 0 && !inMedia(media, cursor, run.bytes)) fail();
        samples += run.bytes;
        cursor += run.bytes;
      }
      previousEnd = cursor;
    }
  }
  return samples > 0;
}

/** One trun: its sample count, its data_offset if it gives one (signed), and its bytes with the default sample size. */
function trunRun(b: Buffer, trun: Box, defaultSize: number): { count: number; dataOffset: number | undefined; bytes: number } {
  const { flags } = fullBoxHead(b, trun);
  if (flags & ~TRUN_FLAGS) fail();
  let at = trun.dataStart + 4;
  if (at + 4 > trun.end) fail();
  const count = b.readUInt32BE(at);
  if (count > MAX_SAMPLES) fail();
  at += 4;
  let dataOffset: number | undefined;
  if (flags & 0x1) {
    if (at + 4 > trun.end) fail();
    dataOffset = b.readInt32BE(at);
    at += 4;
  }
  if (flags & 0x4) at += 4; // first_sample_flags
  if (at > trun.end) fail();
  const fields = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f);
  const entry = 4 * fields.length;
  if (at + entry * count > trun.end) fail();
  if (!(flags & 0x200)) return { count, dataOffset, bytes: defaultSize * count };
  const sizeAt = 4 * fields.indexOf(0x200);
  let bytes = 0;
  for (let i = 0; i < count; i++) bytes += b.readUInt32BE(at + entry * i + sizeAt);
  return { count, dataOffset, bytes };
}
