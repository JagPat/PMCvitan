/**
 * The container walks that the voice-note and video-clip checks share (#482 voice, #995 video): the step, padding,
 * sample and box caps; the Opus packet timing; WebM's EBML reads and allow-lists; MP4's box walk, allow-lists, full-box
 * reads, sample tables, fragments and edit lists. A leaf: it knows no upload kind. What a voice note is lives in
 * `voice-container.ts` and what a video clip is in `video-container.ts`; each reads its file with these parts, so a
 * clip's sound and structures are read exactly as a voice note's are.
 */

/**
 * the most steps one walk takes, so no crafted file can spin the check: a step is a WebM element, a laced WebM frame,
 * an MP4 box or a completed Ogg packet (Ogg pages have their own cap)
 */
const MAX_STEPS = 100_000;
/**
 * the most padding (WebM Void, MP4 free, skip and wide) one file may hold, in all: padding is the one content passed
 * over unread, so it is kept to what a recorder reserves, never room for a payload (#1013 replacement review)
 */
const MAX_PADDING = 4096;

/** A walk's state: the steps it has taken, and the padding bytes it has passed over. */
interface Walk { n: number; padding: number }

/** Count `bytes` of padding against the file's cap. */
function padding(walk: Walk, bytes: number): void {
  walk.padding += bytes;
  if (walk.padding > MAX_PADDING) fail();
}

/** Count `n` steps against the walk's cap before the work they stand for is done. */
function charge(walk: Walk, n: number): void {
  walk.n += n;
  if (walk.n > MAX_STEPS) fail();
}

class Malformed extends Error {}

const fail = (): never => {
  throw new Malformed();
};

// ── Opus packets (any container) ─────────────────────────────────────────────────────────────

/** Opus counts time in 48 kHz samples whatever the recording's rate */
const OPUS_RATE = 48_000;

/**
 * The 48 kHz samples one Opus packet holds, from its TOC byte (RFC 6716 §3.1): the configuration gives the frame
 * length, the code the frame count (code 3 gives it in the next byte). An empty packet holds none; a code-3 packet
 * with no count, or a count of 0, or more than 120 ms in all, is malformed.
 */
function opusPacketSamples(b: Buffer, at: number, size: number): number {
  if (size < 1) return 0;
  const toc = b[at]!;
  const config = toc >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3]! : config < 16 ? [480, 960][config & 1]! : [120, 240, 480, 960][config & 3]!;
  const code = toc & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (size < 2) fail();
    frames = b[at + 1]! & 0x3f;
    if (frames === 0) fail();
  }
  if (frames * frame > 5760) fail();
  return frames * frame;
}

/**
 * Whether these bytes are an OpusHead a decoder reads for a voice note (Codex P2 on #1013 round 3): exactly the
 * 19-byte header, version 0.x, channel mapping family 0 (which RFC 7845 §5.1.1.2 defines for one or two channels only,
 * with no mapping table), one or two channels. Browsers record voice in family 0; any other family is refused.
 */
function isOpusHead(p: Buffer, at: number, length: number): boolean {
  return length === 19 && p.toString('latin1', at, at + 8) === 'OpusHead' && (p[at + 8]! & 0xf0) === 0
    && (p[at + 9] === 1 || p[at + 9] === 2) && p[at + 18] === 0;
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

/**
 * What an element holds, so every one is read by its type (#1013 replacement review): an unsigned or signed integer of
 * at most 8 bytes, a float of 0, 4 or 8 bytes, a text of at most 64 bytes (a codec or document type, at most 16), a
 * SegmentUUID of exactly 16 bytes, a date of exactly 8; a container (one that may repeat, a CuePoint, is an `entry`), a
 * block or the OpusHead, each read by its caller;
 * or Void, padding no player reads, counted against the file's padding cap. CRC-32 is refused everywhere (Chrome
 * writes none, and an unverified checksum is bytes passed over unread). Each element appears once in its parent, but
 * Void, blocks, BlockGroups and entries.
 */
type Kind = 'uint' | 'int' | 'float' | 'text' | 'code' | 'uuid' | 'date' | 'master' | 'entry' | 'block' | 'group' | 'opushead' | 'void';
/** the longest text element read, and the longest codec or document type (A_OPUS, webm) */
const TEXT_MAX = 64;
const CODE_MAX = 16;
/** EBMLVersion, EBMLReadVersion, EBMLMaxIDLength, EBMLMaxSizeLength, DocType, DocTypeVersion, DocTypeReadVersion */
const EBML_HEADER_CHILDREN = new Map<number, Kind>([
  [0x4286, 'uint'], [0x42f7, 'uint'], [0x42f2, 'uint'], [0x42f3, 'uint'], [DOC_TYPE, 'code'], [0x4287, 'uint'], [0x4285, 'uint'], [VOID, 'void'],
]);
/** Info, Tracks, Cluster: what Chrome writes; no SeekHead, Cues or Tags (which can carry a picture), Attachments or Chapters */
const SEGMENT_CHILDREN = new Set([INFO, TRACKS, CLUSTER, VOID]);
/** TimestampScale, Duration, MuxingApp, WritingApp, SegmentUUID, DateUTC, Title */
const INFO_CHILDREN = new Map<number, Kind>([
  [0x2ad7b1, 'uint'], [0x4489, 'float'], [0x4d80, 'text'], [0x5741, 'text'], [0x73a4, 'uuid'], [0x4461, 'date'], [0x7ba9, 'text'], [VOID, 'void'],
]);
/** the one TrackEntry */
const TRACKS_CHILDREN = new Map<number, Kind>([[TRACK_ENTRY, 'master'], [VOID, 'void']]);
/**
 * TrackNumber, TrackUID, TrackType, FlagEnabled, FlagDefault, FlagForced, FlagLacing, DefaultDuration, CodecID,
 * CodecPrivate, CodecDelay, SeekPreRoll, Name, Language, LanguageBCP47, Audio; no Video, ContentEncodings or other
 */
const TRACK_ENTRY_CHILDREN = new Map<number, Kind>([
  [TRACK_NUMBER, 'uint'], [0x73c5, 'uint'], [TRACK_TYPE, 'uint'], [0xb9, 'uint'], [0x88, 'uint'], [0x55aa, 'uint'], [0x9c, 'uint'],
  [0x23e383, 'uint'], [CODEC_ID, 'code'], [0x63a2, 'opushead'], [0x56aa, 'uint'], [0x56bb, 'uint'], [0x536e, 'text'], [0x22b59c, 'text'],
  [0x22b59d, 'text'], [AUDIO, 'master'], [VOID, 'void'],
]);
/** SamplingFrequency, Channels, BitDepth, OutputSamplingFrequency */
const AUDIO_CHILDREN = new Map<number, Kind>([[0xb5, 'float'], [0x9f, 'uint'], [0x6264, 'uint'], [0x78b5, 'float'], [VOID, 'void']]);
/**
 * Cues, the seek index Safari's recorder (WebKit, libwebm in file mode) writes after the Clusters (#482: an iPhone's
 * voice note was refused for it): CuePoints, each a CueTime and one CueTrackPositions of CueTrack, CueClusterPosition,
 * and at most CueRelativePosition, CueDuration and CueBlockNumber; no CueCodecState or CueReference
 */
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;
const CUES_CHILDREN = new Map<number, Kind>([[CUE_POINT, 'entry'], [VOID, 'void']]);
const CUE_POINT_CHILDREN = new Map<number, Kind>([[CUE_TIME, 'uint'], [CUE_TRACK_POSITIONS, 'master'], [VOID, 'void']]);
const CUE_TRACK_POSITIONS_CHILDREN = new Map<number, Kind>([
  [CUE_TRACK, 'uint'], [CUE_CLUSTER_POSITION, 'uint'], [0xf0, 'uint'], [0xb2, 'uint'], [0x5378, 'uint'], [VOID, 'void'],
]);
/** Timestamp, Position, PrevSize, SimpleBlock, BlockGroup; no SilentTracks or EncryptedBlock */
const CLUSTER_CHILDREN = new Map<number, Kind>([
  [0xe7, 'uint'], [0xa7, 'uint'], [0xab, 'uint'], [SIMPLE_BLOCK, 'block'], [BLOCK_GROUP, 'group'], [VOID, 'void'],
]);
/** Block, BlockDuration, ReferenceBlock, DiscardPadding; no BlockAdditions */
const BLOCK_GROUP_CHILDREN = new Map<number, Kind>([[BLOCK, 'block'], [0x9b, 'uint'], [0xfb, 'int'], [0x75a2, 'int'], [VOID, 'void']]);
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CLUSTER_TIMESTAMP = 0xe7;
const FLAG_ENABLED = 0xb9;
const FLAG_DEFAULT = 0x88;
const FLAG_FORCED = 0x55aa;
const FLAG_LACING = 0x9c;
const CODEC_PRIVATE = 0x63a2;
const DEFAULT_DURATION = 0x23e383;
const BLOCK_DURATION = 0x9b;

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
function readElement(b: Buffer, at: number, end: number, steps: Walk, allowUnknown = false): Element {
  if (++steps.n > MAX_STEPS) fail();
  const id = vint(b, at, end, true);
  const size = vint(b, at + id.length, end, false);
  const dataStart = at + id.length + size.length;
  if (size.unknown && !allowUnknown) fail();
  const dataEnd = size.unknown ? end : dataStart + size.value;
  if (dataEnd > end) fail();
  return { id: id.value, dataStart, dataEnd, unknownSize: size.unknown };
}

/**
 * An element of a container, checked against the container's list: named there, once unless it is Void, a block or a
 * BlockGroup, and read whole by its kind (a container, a block or the OpusHead is left to the caller). Returns its kind.
 */
function checkChild(b: Buffer, e: Element, allowed: Map<number, Kind>, seen: Set<number>, walk: Walk): Kind {
  const kind = allowed.get(e.id);
  if (kind === undefined) fail();
  if (kind !== 'void' && kind !== 'block' && kind !== 'group' && kind !== 'entry') {
    if (seen.has(e.id)) fail();
    seen.add(e.id);
  }
  const width = e.dataEnd - e.dataStart;
  // an integer's value is read where it is used (a TrackUID is a random 64-bit number past what a Number holds)
  if ((kind === 'uint' || kind === 'int') && width > 8) fail();
  else if (kind === 'float') floatOf(b, e);
  else if (kind === 'text' && width > TEXT_MAX) fail();
  else if (kind === 'code' && width > CODE_MAX) fail();
  else if (kind === 'uuid' && width !== 16) fail();
  else if (kind === 'date' && width !== 8) fail();
  else if (kind === 'void') padding(walk, width);
  return kind!;
}

/** Each element in [start, end), every one sized, named in `allowed` and read by its kind (`checkChild`). */
function* elements(b: Buffer, start: number, end: number, steps: Walk, allowed: Map<number, Kind>): Generator<Element> {
  const seen = new Set<number>();
  for (let at = start; at < end;) {
    const e = readElement(b, at, end, steps);
    checkChild(b, e, allowed, seen, steps);
    yield e;
    at = e.dataEnd;
  }
}

/**
 * A short text element (a document type or codec ID, at most 16 bytes, checked before this reads it) with its
 * trailing zero bytes dropped, by a loop: never a pattern match over bytes a file chooses (#1013 replacement review).
 */
function codeOf(b: Buffer, e: Element): string {
  if (e.dataEnd - e.dataStart > CODE_MAX) fail();
  let end = e.dataEnd;
  while (end > e.dataStart && b[end - 1] === 0) end--;
  return b.toString('latin1', e.dataStart, end);
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
 * An audio TrackEntry's fields, each read once by the walk (`seen`, by ID): the track a player plays, Opus with its
 * OpusHead. Returns its number, DefaultDuration and whether its blocks may be laced. Also read for a video clip's sound
 * track (#995).
 */
function opusTrack(b: Buffer, seen: Map<number, Element>): { number: number; frameNs: number; lacing: boolean } {
  const number = seen.get(TRACK_NUMBER);
  const codec = seen.get(CODEC_ID);
  if (!number || !codec) fail();
  // Opus only: Vorbis's length would come from its headers alone, and no browser records it
  if (codeOf(b, codec!) !== 'A_OPUS') fail();
  const { lacing } = trackFlags(b, seen);
  // an Opus track's CodecPrivate is its OpusHead, which Matroska requires and Chrome writes
  const head = seen.get(CODEC_PRIVATE);
  if (!head || !isOpusHead(b, head.dataStart, head.dataEnd - head.dataStart)) fail();
  // DefaultDuration: what the file says each frame lasts, in nanoseconds (0 when not written)
  const each = seen.get(DEFAULT_DURATION);
  const found = { number: uintOf(b, number!), frameNs: each ? uintOf(b, each) : 0, lacing };
  if (found.number < 1) fail();
  return found;
}

/**
 * The track is one a player plays (Codex P2 on #1013 round 3): enabled and default when the flags are written (both
 * default to 1), and the other flags are booleans. Returns FlagLacing (1 when not written): a track that sets it to 0
 * says none of its blocks is laced (#1154).
 */
function trackFlags(b: Buffer, seen: Map<number, Element>): { lacing: boolean } {
  const flag = (id: number, allowed: number[]) => {
    const f = seen.get(id);
    if (f && !allowed.includes(uintOf(b, f))) fail();
  };
  flag(FLAG_ENABLED, [1]);
  flag(FLAG_DEFAULT, [1]);
  flag(FLAG_FORCED, [0, 1]);
  flag(FLAG_LACING, [0, 1]);
  const lacing = seen.get(FLAG_LACING);
  return { lacing: !lacing || uintOf(b, lacing) === 1 };
}

/**
 * A block's track, its timecode and its frames; a malformed block fails. The body is
 * the track number, a 16-bit timecode, the flags, then the frames. A laced block (flags bits 1-2: Xiph, fixed-size or
 * EBML lacing) first gives its frame count and, for Xiph and EBML, every frame's size but the last, which is what
 * remains (Codex P2 on #1013): the lace table is read whole, and the sizes it declares must fit in the block.
 * Every laced frame is a step of the walk, charged as soon as the lace count is read and before any frame is listed
 * (Codex P1 on #1025: a fixed-size lace declares up to 256 frames in one byte; an unlaced block's one frame is paid
 * for by the block element's own step), and every frame holds at least one byte (Codex P2 on #1025): an empty one
 * refuses the file.
 */
function blockTrack(b: Buffer, start: number, end: number, steps: Walk): { track: number; timecode: number; laced: boolean; frames: Array<{ at: number; size: number }> } {
  const track = vint(b, start, end, false);
  if (track.unknown) fail();
  const flagsAt = start + track.length + 2;
  if (flagsAt >= end) fail();
  const timecode = b.readInt16BE(start + track.length); // relative to its Cluster's Timestamp
  const lacing = (b[flagsAt]! >> 1) & 0x03; // 0 none, 1 Xiph, 2 fixed-size, 3 EBML
  let at = flagsAt + 1;
  const sizes: number[] = [];
  if (lacing === 0) {
    sizes.push(end - at); // one frame, paid for by the block's own step
  } else {
    if (at >= end) fail();
    const frames = b[at]! + 1; // at most 256
    charge(steps, frames);
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
  // the frames follow the lace table back to back, to the block's end; each holds at least one byte
  const frames: Array<{ at: number; size: number }> = [];
  for (const size of sizes) {
    if (size < 1) fail();
    frames.push({ at, size });
    at += size;
  }
  return { track: track.value, timecode, laced: lacing !== 0, frames };
}

/** A float element of 0, 4 or 8 bytes; it must be a finite number, not below 0. */
function floatOf(b: Buffer, e: Element): number {
  const width = e.dataEnd - e.dataStart;
  const value = width === 0 ? 0 : width === 4 ? b.readFloatBE(e.dataStart) : width === 8 ? b.readDoubleBE(e.dataStart) : fail();
  if (!Number.isFinite(value) || value < 0) fail();
  return value;
}

// ── MP4 (ISO BMFF) ───────────────────────────────────────────────────────────────────────────

/**
 * the most samples (frames) one track may declare. A frame lasts at least 2.5 ms (Opus's shortest; an AAC frame is
 * 1,024 samples, over 10 ms at any rate a recorder uses), so 48,000 frames already make two minutes: no voice note
 * comes near this, and a chunk holds at least one sample, so it caps the chunks too
 */
const MAX_SAMPLES = 50_000;
/** the most mdat boxes, and the most fragments: a recorder writes one per fragment, a fragment a second or so */
const MAX_MEDIA_BOXES = 10_000;

interface Box { type: string; start: number; dataStart: number; end: number }

/**
 * Each box in [start, end): size 1 is a 64-bit size, size 0 (only where `toEnd` allows it: the file's last box) runs
 * to `end`, and anything smaller than its header fails.
 */
function* boxes(b: Buffer, start: number, end: number, steps: Walk, toEnd = false): Generator<Box> {
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

/** padding a recorder may leave anywhere, counted against the file's padding cap */
const PADDING = ['free', 'skip'];
const isPadding = (type: string) => type === 'free' || type === 'skip' || type === 'wide';
/**
 * the boxes each container may hold; a box not named here is refused. No udta or meta (either can carry a picture),
 * iods, sgpd, sbgp, sidx, mfra, stss or elng: a box this check would pass over unread is refused, not skipped
 */
const MP4_CHILDREN: Record<string, Set<string>> = {
  file: new Set(['ftyp', 'moov', 'mdat', 'moof', 'wide', ...PADDING]),
  moov: new Set(['mvhd', 'trak', 'mvex', ...PADDING]),
  trak: new Set(['tkhd', 'mdia', 'edts', ...PADDING]),
  edts: new Set(['elst']),
  mdia: new Set(['mdhd', 'hdlr', 'minf', ...PADDING]),
  minf: new Set(['smhd', 'dinf', 'stbl', ...PADDING]),
  stbl: new Set(['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', ...PADDING]),
  mvex: new Set(['mehd', 'trex', ...PADDING]),
  moof: new Set(['mfhd', 'traf', ...PADDING]),
  traf: new Set(['tfhd', 'tfdt', 'trun', ...PADDING]),
  // the boxes inside each sample entry: the codec's configuration, and the bitrate box Chrome writes
  mp4a: new Set(['esds', 'btrt']),
  Opus: new Set(['dOps', 'btrt']),
};
/** the sample entries a browser records voice in: AAC and Opus */
const MP4_AUDIO_ENTRIES = new Set(['mp4a', 'Opus']);

/**
 * A container's children by type, every one named in its allow-list (`lists`: a video clip's are its own, #995); a type
 * in `once` that appears twice fails.
 */
function children(b: Buffer, start: number, end: number, container: string, steps: Walk, once: string[] = [], lists = MP4_CHILDREN): Map<string, Box[]> {
  const out = new Map<string, Box[]>();
  for (const x of boxes(b, start, end, steps)) {
    if (!lists[container]!.has(x.type)) fail();
    if (isPadding(x.type)) padding(steps, x.end - x.dataStart);
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

/**
 * The payload ranges of the file's mdat boxes, in file order (so sorted and apart); a sample range counts only when it
 * lies wholly inside one. Found by a binary search for the last range starting at or before it, so a file of many
 * mdat boxes and chunks costs a logarithm per chunk, not a scan (Codex P1 on #1013 round 3).
 */
type MediaRanges = Array<{ from: number; to: number }>;
/** the sample ranges a file's tables and runs put in its mdat payloads: where each starts, and its bytes */
type SampleRanges = Array<{ at: number; bytes: number }>;
/**
 * Whether the chunks and runs tile the mdat payloads exactly (#1013 replacement review): sorted by place, they run
 * back to back from each payload's start to its end, with no byte between, beyond or under two of them, so no mdat
 * holds bytes that are not the track's samples. Each range already lies inside one payload (`inMedia`).
 */
function tilesMedia(media: MediaRanges, ranges: SampleRanges): boolean {
  ranges.sort((x, y) => x.at - y.at);
  let r = 0;
  for (const m of media) {
    let cursor = m.from;
    while (r < ranges.length && ranges[r]!.at < m.to) {
      if (ranges[r]!.at !== cursor) return false;
      cursor += ranges[r]!.bytes;
      r++;
    }
    if (cursor !== m.to) return false;
  }
  return true; // every range lies inside some payload (`inMedia`), so none is left over
}
function inMedia(media: MediaRanges, at: number, bytes: number): boolean {
  let lo = 0;
  let hi = media.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (media[mid]!.from <= at) lo = mid + 1;
    else hi = mid - 1;
  }
  const m = media[hi];
  return m !== undefined && at + bytes <= m.to;
}

/** The first box of this type directly inside [start, end), if any. */
function child(b: Buffer, start: number, end: number, type: string, steps: Walk): Box | undefined {
  for (const x of boxes(b, start, end, steps)) if (x.type === type) return x;
  return undefined;
}

/** A full box's flags (its version and flags word, low 24 bits) and version. */
const fullBoxHead = (b: Buffer, box: Box) => {
  if (box.dataStart + 4 > box.end) fail();
  return { version: b[box.dataStart]!, flags: b.readUInt32BE(box.dataStart) & 0xffffff };
};

/**
 * A full box read whole (#1013 replacement review): a version the box defines (`sizes` gives each one's length, from
 * the version and flags word to its last field; a version it does not list has none, so never matches), exactly that
 * length, so no box carries bytes past its fields, and only the flags it defines (`flags`, 0 for a box with none).
 */
function exactBox(b: Buffer, box: Box, sizes: number[], flags = 0): { version: number; flags: number } {
  const head = fullBoxHead(b, box);
  if (box.end - box.dataStart !== sizes[head.version] || head.flags & ~flags) fail();
  return head;
}
/** mvhd, tkhd, mdhd, mehd and tfdt at versions 0 and 1 (64-bit times), then the boxes defined at version 0 only */
const MVHD = [100, 112];
const TKHD = [84, 96];
const MDHD = [24, 36];
const MEHD = [8, 12];
const TFDT = [8, 12];
const SMHD = [8];
const MFHD = [8];
const TREX = [24];
/** tkhd's defined flags: track_enabled, track_in_movie, track_in_preview, track_size_is_aspect_ratio */
const TKHD_FLAGS = 0x1 | 0x2 | 0x4 | 0x8;
/** the longest handler name read, with its terminating zero byte */
const HANDLER_NAME_MAX = 64;

/** A track's track_ID from its tkhd (version 1 has 64-bit times before it). */
function trackId(b: Buffer, tkhd: Box): number {
  const { version } = fullBoxHead(b, tkhd);
  const id = b.readUInt32BE(tkhd.dataStart + (version === 1 ? 20 : 12)); // read whole by exactBox before this
  if (id === 0) fail(); // ISO 14496-12 §8.3.2: track_ID 0 is reserved and names no track
  return id;
}

/**
 * The bytes a moov sample table puts in the file, after checking every chunk of them lies inside an mdat (Codex P2
 * on #1013): stsz gives each sample's size, stsc how many samples each chunk holds (and which sample entry they use,
 * which must be the one stsd lists), and stco or co64 where each chunk starts. Every table is bounds-checked against
 * its box, the sample count is capped, and the chunks must hold exactly the samples stsz lists. `sample` sees each
 * sample's place and size, and stts must time exactly those samples: their durations' sum, in media ticks, is returned.
 */
function sampleTable(b: Buffer, stbl: Box, media: MediaRanges, ranges: SampleRanges, steps: Walk, sample: (at: number, size: number) => void): { bytes: number; count: number; ticks: number } {
  // every table is version 0 and ends exactly at its last entry (#1013 replacement review)
  const table = (box: Box | undefined) => {
    if (!box || box.dataStart + 8 > box.end || b.readUInt32BE(box.dataStart) !== 0) fail();
    return box!;
  };
  const stsz = table(child(b, stbl.dataStart, stbl.end, 'stsz', steps));
  const at = stsz.dataStart + 4;
  if (at + 8 > stsz.end) fail();
  const fixed = b.readUInt32BE(at);
  const count = b.readUInt32BE(at + 4);
  if (count > MAX_SAMPLES) fail();
  if (at + 8 + (fixed === 0 ? 4 * count : 0) !== stsz.end) fail();
  // stts: entry count, then (sample count, sample delta) pairs, which must cover exactly the samples stsz lists
  const stts = table(child(b, stbl.dataStart, stbl.end, 'stts', steps));
  const timings = b.readUInt32BE(stts.dataStart + 4);
  if (timings > MAX_SAMPLES || stts.dataStart + 8 + 8 * timings !== stts.end) fail();
  let timed = 0;
  let ticks = 0;
  for (let i = 0; i < timings; i++) {
    const n = b.readUInt32BE(stts.dataStart + 8 + 8 * i);
    timed += n;
    ticks += n * b.readUInt32BE(stts.dataStart + 12 + 8 * i);
  }
  if (timed !== count) fail();
  // stsc and stco or co64 are read whole even when empty (a fragmented file's moov lists no samples)
  const stsc = table(child(b, stbl.dataStart, stbl.end, 'stsc', steps));
  const stco = child(b, stbl.dataStart, stbl.end, 'stco', steps);
  const co64 = child(b, stbl.dataStart, stbl.end, 'co64', steps);
  if (stco && co64) fail();
  const offsets = table(stco ?? co64);
  const width = stco ? 4 : 8;
  const chunks = b.readUInt32BE(offsets.dataStart + 4);
  if (chunks > MAX_SAMPLES || offsets.dataStart + 8 + width * chunks !== offsets.end) fail();
  const runs = b.readUInt32BE(stsc.dataStart + 4);
  if (runs > MAX_SAMPLES || stsc.dataStart + 8 + 12 * runs !== stsc.end) fail();
  if (count === 0) {
    if (runs !== 0 || chunks !== 0) fail(); // no chunks of no samples
    return { bytes: 0, count: 0, ticks: 0 };
  }
  if (runs === 0) fail();
  const sizeOf = (i: number) => (fixed !== 0 ? fixed : b.readUInt32BE(at + 8 + 4 * i));
  const chunkAt = (c: number) => {
    const p = offsets.dataStart + 8 + width * (c - 1);
    return width === 4 ? b.readUInt32BE(p) : u64(b, p);
  };
  const run = (r: number) => ({
    first: b.readUInt32BE(stsc.dataStart + 8 + 12 * r),
    perChunk: b.readUInt32BE(stsc.dataStart + 12 + 12 * r),
    entry: b.readUInt32BE(stsc.dataStart + 16 + 12 * r),
  });
  let n = 0;
  let bytes = 0;
  for (let r = 0; r < runs; r++) {
    const { first, perChunk, entry } = run(r);
    // every run uses the one sample entry stsd lists (Codex P2 on #1013 round 3)
    if (entry !== 1) fail();
    const last = r + 1 < runs ? run(r + 1).first - 1 : chunks;
    // runs start at chunk 1, climb, and stay within the chunks stco lists
    if ((r === 0 && first !== 1) || first < 1 || last < first || last > chunks || perChunk === 0) fail();
    for (let c = first; c <= last; c++) {
      if (++steps.n > MAX_STEPS) fail();
      if (n + perChunk > count) fail();
      const start = chunkAt(c);
      let chunkBytes = 0;
      for (let i = n; i < n + perChunk; i++) chunkBytes += sizeOf(i);
      if (chunkBytes > 0) {
        if (!inMedia(media, start, chunkBytes)) fail();
        ranges.push({ at: start, bytes: chunkBytes });
      }
      for (let i = n, p = start; i < n + perChunk; p += sizeOf(i), i++) sample(p, sizeOf(i));
      n += perChunk;
      bytes += chunkBytes;
    }
  }
  if (n !== count) fail();
  return { bytes, count, ticks };
}

/**
 * Whether a track's data reference says its samples are in this file: one dref entry, a `url ` with the
 * self-contained flag. A reference to another file would put the samples beyond this check's reach.
 */
function selfContained(b: Buffer, dinf: Box, steps: Walk): boolean {
  const refs = [...boxes(b, dinf.dataStart, dinf.end, steps)];
  if (refs.length !== 1 || refs[0]!.type !== 'dref') return false;
  const dref = refs[0]!;
  if (dref.dataStart + 8 > dref.end || b.readUInt32BE(dref.dataStart) !== 0 || b.readUInt32BE(dref.dataStart + 4) !== 1) return false;
  const entries = [...boxes(b, dref.dataStart + 8, dref.end, steps)];
  if (entries.length !== 1 || entries[0]!.type !== 'url ') return false;
  // version 0, the self-contained flag, and no location: at most the empty string's zero byte (Chromium writes one)
  const url = entries[0]!;
  const { version, flags } = fullBoxHead(b, url);
  const rest = url.end - url.dataStart - 4;
  return version === 0 && flags === 1 && (rest === 0 || (rest === 1 && b[url.dataStart + 4] === 0));
}

/** tfhd's defined flags: base_data_offset, sample_description_index, default duration, size and flags, duration-is-empty, default-base-is-moof */
const TFHD_FLAGS = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x10000 | 0x20000;
/** trun's defined flags: data_offset, first_sample_flags, and per-sample duration, size, flags and composition offset */
const TRUN_FLAGS = 0x1 | 0x4 | 0x100 | 0x200 | 0x400 | 0x800;

/**
 * An MPEG-4 descriptor (ISO/IEC 14496-1 §8.3.3) at `at`, within `end`: a tag, then its size in one to four bytes of
 * seven bits, each but the last with its high bit set.
 */
function descriptor(b: Buffer, at: number, end: number): { tag: number; dataStart: number; dataEnd: number } {
  if (at >= end) fail();
  let size = 0;
  let i = 0;
  let byte: number;
  do {
    if (++i > 4 || at + i >= end) fail();
    byte = b[at + i]!;
    size = size * 128 + (byte & 0x7f);
  } while (byte & 0x80);
  const dataStart = at + 1 + i;
  if (dataStart + size > end) fail();
  return { tag: b[at]!, dataStart, dataEnd: dataStart + size };
}

/** the AAC sample rates by sampling_frequency_index (ISO/IEC 14496-3 §1.6.3.4); 13 and up are reserved or explicit */
const AAC_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];

/**
 * The sample rate an esds gives an AAC-LC voice recording, read whole: version 0, then one ES_Descriptor (no stream
 * dependence, URL or OCR stream) holding one DecoderConfigDescriptor of MPEG-4 audio (object type 0x40, stream type 5)
 * with exactly one two-byte AudioSpecificConfig (AAC-LC, a listed rate index, one or two channels, 1,024-sample frames,
 * no core coder or extension), then at most the predefined SLConfigDescriptor (2). Anything else is a refusal.
 */
function aacRate(b: Buffer, esds: Box): number {
  const { version, flags } = fullBoxHead(b, esds);
  if (version !== 0 || flags !== 0) fail();
  const es = descriptor(b, esds.dataStart + 4, esds.end);
  if (es.tag !== 0x03 || es.dataEnd !== esds.end || es.dataStart + 3 > es.dataEnd) fail();
  if (b[es.dataStart + 2]! & 0xe0) fail(); // streamDependenceFlag, URL_Flag, OCRstreamFlag
  const config = descriptor(b, es.dataStart + 3, es.dataEnd);
  if (config.tag !== 0x04 || config.dataStart + 13 > config.dataEnd) fail();
  if (b[config.dataStart] !== 0x40 || (b[config.dataStart + 1]! & 0xfe) !== 0x14) fail(); // MPEG-4 audio, audio stream, not upstream
  const info = descriptor(b, config.dataStart + 13, config.dataEnd);
  if (info.tag !== 0x05 || info.dataEnd !== config.dataEnd || info.dataEnd - info.dataStart !== 2) fail();
  if (config.dataEnd < es.dataEnd) {
    const sl = descriptor(b, config.dataEnd, es.dataEnd);
    if (sl.tag !== 0x06 || sl.dataEnd !== es.dataEnd || sl.dataEnd - sl.dataStart !== 1 || b[sl.dataStart] !== 0x02) fail();
  }
  // audioObjectType (5 bits), samplingFrequencyIndex (4), channelConfiguration (4), then GASpecificConfig's
  // frameLengthFlag, dependsOnCoreCoder and extensionFlag, all 0
  const asc = b.readUInt16BE(info.dataStart);
  const index = (asc >> 7) & 0x0f;
  const channels = (asc >> 3) & 0x0f;
  if (asc >> 11 !== 2 || channels < 1 || channels > 2 || (asc & 0x07) !== 0) fail();
  return AAC_RATES[index] ?? fail(); // a listed rate; 13 and 14 are reserved, 15 an explicit rate
}

/**
 * A track's one sample entry, read whole (#1013 replacement review): an `mp4a` whose one esds is AAC-LC at the
 * entry's own nonzero rate, or an `Opus` whose one dOps is the 11-byte family-0 header of a mono or stereo
 * recording; each may carry one btrt. The entry is the version 0 layout naming the one data reference. Returns the
 * AAC rate (0 for Opus). Anything else is a refusal.
 */
function audioSampleEntry(b: Buffer, stsd: Box, steps: Walk): { opus: boolean; rate: number } {
  if (stsd.dataStart + 8 > stsd.end || b.readUInt32BE(stsd.dataStart) !== 0) fail(); // version 0 and no flags, then one entry
  if (b.readUInt32BE(stsd.dataStart + 4) !== 1) fail();
  const entries = [...boxes(b, stsd.dataStart + 8, stsd.end, steps)];
  if (entries.length !== 1 || !MP4_AUDIO_ENTRIES.has(entries[0]!.type)) fail();
  const entry = entries[0]!;
  // six reserved bytes, data_reference_index, then (version 0) eight reserved bytes, channelcount, samplesize,
  // pre_defined, reserved and the 16.16 sample rate; the codec's boxes follow
  if (entry.dataStart + 28 > entry.end) fail();
  if (b.readUInt16BE(entry.dataStart + 6) !== 1 || b.readUInt16BE(entry.dataStart + 8) !== 0) fail();
  const kids = children(b, entry.dataStart + 28, entry.end, entry.type, steps, ['esds', 'dOps', 'btrt']);
  for (const btrt of kids.get('btrt') ?? []) if (btrt.end - btrt.dataStart !== 12) fail(); // buffer size, max and average bitrate
  if (entry.type === 'Opus') {
    // dOps: Version 0, OutputChannelCount, PreSkip, InputSampleRate, OutputGain, ChannelMappingFamily 0 (no table)
    const dOps = only(kids, 'dOps');
    if (dOps.end - dOps.dataStart !== 11 || b[dOps.dataStart] !== 0) fail();
    if ((b[dOps.dataStart + 1] !== 1 && b[dOps.dataStart + 1] !== 2) || b[dOps.dataStart + 10] !== 0) fail();
    return { opus: true, rate: 0 };
  }
  // the entry's rate is the esds rate, which is never 0, so an entry rate of 0 never matches
  const rate = b.readUInt32BE(entry.dataStart + 24) >>> 16;
  if (aacRate(b, only(kids, 'esds')) !== rate) fail();
  return { opus: false, rate };
}

/**
 * A track's edit list, when it has one (#1013 replacement review): exactly one elst of one or two entries, each at
 * rate 1, at most one empty edit (media_time -1) and only first, and exactly one edit of the media, so no edit plays
 * the media twice. Returns the empty edit's delay and the media edit's duration, in movie ticks, and where in the media
 * the edit starts (its media_time), in media ticks (#1141).
 */
function editList(b: Buffer, edts: Box, steps: Walk): { delay: number; edit: number; start: number } {
  const elst = only(children(b, edts.dataStart, edts.end, 'edts', steps, ['elst']), 'elst');
  const { version, flags } = fullBoxHead(b, elst);
  if (version > 1 || flags !== 0 || elst.dataStart + 8 > elst.end) fail();
  const count = b.readUInt32BE(elst.dataStart + 4);
  const width = version === 1 ? 20 : 12;
  if (count < 1 || count > 2 || elst.dataStart + 8 + width * count !== elst.end) fail();
  let delay = 0;
  let edit: number | undefined;
  let start = 0;
  for (let i = 0; i < count; i++) {
    const at = elst.dataStart + 8 + width * i;
    const duration = version === 1 ? u64(b, at) : b.readUInt32BE(at);
    const mediaTime = version === 1 ? b.readBigInt64BE(at + 8) : BigInt(b.readInt32BE(at + 4));
    const rateAt = at + (version === 1 ? 16 : 8);
    if (b.readInt16BE(rateAt) !== 1 || b.readInt16BE(rateAt + 2) !== 0) fail();
    if (mediaTime === -1n) {
      if (i !== 0 || count !== 2) fail(); // an empty edit only before the media
      delay = duration;
    } else {
      if (mediaTime < 0n || mediaTime > BigInt(Number.MAX_SAFE_INTEGER) || edit !== undefined) fail(); // one edit of the media
      edit = duration;
      start = Number(mediaTime);
    }
  }
  return { delay, edit: edit!, start };
}

/**
 * The brands an MP4 audio recording carries (Codex P2 on #1013 round 3): the ISO base and MP4 families, Apple's M4A,
 * and the fragmented and CMAF ones recorders name; `avc1` and `vp09` only as compatible brands, which MP4 writers list
 * whatever the track (Chromium 141's recorder writes isom, iso6, iso2, vp09 and mp41 for an Opus voice note, and its
 * recording is a test). heic, mif1, qt and every brand not named here are refused.
 */
const MP4_BRANDS = new Set(['M4A ', 'mp41', 'mp42', 'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'dash', 'cmfc', 'msdh', 'msix']);
const MP4_COMPATIBLE_ONLY = new Set(['avc1', 'vp09']);

/**
 * An mvhd or mdhd read whole (`sizes`: its length at each version), and its timescale and duration (version 1 has
 * 64-bit times); a duration of all ones is unknown (null).
 */
function timeHeader(b: Buffer, box: Box, sizes: number[]): { scale: number; duration: number | null } {
  const { version } = exactBox(b, box, sizes);
  const at = box.dataStart + (version === 1 ? 20 : 12);
  const scale = b.readUInt32BE(at);
  if (version === 1) {
    const raw = b.readBigUInt64BE(at + 4);
    return { scale, duration: raw === 0xffffffffffffffffn ? null : u64(b, at + 4) };
  }
  const raw = b.readUInt32BE(at + 4);
  return { scale, duration: raw === 0xffffffff ? null : raw };
}

/**
 * One trun: its sample count, its data_offset if it gives one (signed), its bytes and ticks with the defaults applied,
 * where its latest sample ends as presented (after its composition offset), the latest any sample is presented after
 * its decode time (0 when none is later), and each sample's size. A count above `left` (the samples the file may still
 * list) is refused before any sample is read: with default sizes and durations a run's samples take no bytes of their own.
 */
function trunRun(b: Buffer, trun: Box, defaults: { duration: number; size: number }, left: number): { count: number; dataOffset: number | undefined; bytes: number; ticks: number; reach: number; shift: number; sizeOf: (i: number) => number } {
  const { version, flags } = fullBoxHead(b, trun);
  if (version > 1 || flags & ~TRUN_FLAGS) fail(); // version 1 differs only in signed composition offsets
  let at = trun.dataStart + 4;
  if (at + 4 > trun.end) fail();
  const count = b.readUInt32BE(at);
  if (count > left) fail();
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
  if (at + entry * count !== trun.end) fail(); // trun ends at its last sample's fields
  const column = (f: number, fallback: number) => (flags & f ? (i: number) => b.readUInt32BE(at + entry * i + 4 * fields.indexOf(f)) : () => fallback);
  const sizeOf = column(0x200, defaults.size);
  const durationOf = column(0x100, defaults.duration);
  // sample_composition_time_offset: unsigned at version 0, signed at version 1
  const shiftOf = flags & 0x800 ? (i: number) => (version === 1 ? b.readInt32BE : b.readUInt32BE).call(b, at + entry * i + 4 * fields.indexOf(0x800)) : () => 0;
  let bytes = 0;
  let ticks = 0;
  let reach = 0; // where the run's latest sample ends as presented, from the run's start
  let shift = 0; // the latest any sample is presented after its decode time
  for (let i = 0; i < count; i++) {
    bytes += sizeOf(i);
    const duration = durationOf(i);
    reach = Math.max(reach, ticks + shiftOf(i) + duration);
    shift = Math.max(shift, shiftOf(i));
    ticks += duration;
  }
  return { count, dataOffset, bytes, ticks, reach, shift, sizeOf };
}

export type { Walk, Kind, Element, Box, MediaRanges, SampleRanges };
export {
  MAX_STEPS, MAX_PADDING, padding, charge, Malformed, fail, OPUS_RATE, opusPacketSamples, isOpusHead, EBML_HEADER,
  DOC_TYPE, SEGMENT, INFO, TRACKS, CUES, CUE_POINT, CUE_TIME, CUE_TRACK_POSITIONS, CUE_TRACK, CUE_CLUSTER_POSITION,
  CUES_CHILDREN, CUE_POINT_CHILDREN, CUE_TRACK_POSITIONS_CHILDREN, TRACK_ENTRY, TRACK_NUMBER, TRACK_TYPE, CODEC_ID, AUDIO, CLUSTER, SIMPLE_BLOCK,
  BLOCK_GROUP, BLOCK, VOID, TEXT_MAX, CODE_MAX, EBML_HEADER_CHILDREN, SEGMENT_CHILDREN, INFO_CHILDREN,
  TRACKS_CHILDREN, TRACK_ENTRY_CHILDREN, AUDIO_CHILDREN, CLUSTER_CHILDREN, BLOCK_GROUP_CHILDREN, TIMESTAMP_SCALE,
  DURATION, CLUSTER_TIMESTAMP, FLAG_ENABLED, FLAG_DEFAULT, FLAG_FORCED, FLAG_LACING, CODEC_PRIVATE, DEFAULT_DURATION,
  BLOCK_DURATION, vint, readElement, checkChild, elements, codeOf, uintOf, opusTrack, trackFlags, blockTrack,
  floatOf, MAX_SAMPLES, MAX_MEDIA_BOXES, boxes, u64, PADDING, isPadding, MP4_CHILDREN, MP4_AUDIO_ENTRIES, children,
  only, tilesMedia, inMedia, child, fullBoxHead, exactBox, MVHD, TKHD, MDHD, MEHD, TFDT, SMHD, MFHD, TREX,
  TKHD_FLAGS, HANDLER_NAME_MAX, trackId, sampleTable, selfContained, TFHD_FLAGS, TRUN_FLAGS, descriptor, AAC_RATES,
  aacRate, audioSampleEntry, editList, MP4_BRANDS, MP4_COMPATIBLE_ONLY, timeHeader, trunRun,
};
