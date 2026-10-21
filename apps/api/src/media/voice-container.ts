/**
 * Stage 1 voice (#482, Codex P2s on #1010, #1013 and #1019) — is this upload an audio-only recording, with sound in it,
 * in the container its type names, and how long is it?
 *
 * A bounded structural check, not a demuxer: it reads the headers that list a file's tracks and the tables that say
 * where its samples are, and never decodes the sound. Every structure is read against an allow-list of what a
 * browser's recorder writes (Chrome and Android WebM, Firefox Ogg, iOS Safari MP4): an element, box, page flag,
 * stream, track, handler, codec or descriptor it does not name is a refusal, never skipped, and every one it names is
 * read whole by its type, to its last byte: nothing but padding (WebM Void, MP4 free, skip and wide, at most 4 KiB in
 * all) is passed over unread. The rules, with the test pinning each, are in the PR's "Parser rules":
 *  - WebM: an EBML header whose children are known and whose one DocType is "webm", then one Segment and nothing
 *    after it. The Segment holds only Info, Tracks, Cluster and Void (Chrome writes no SeekHead, Cues, Tags or
 *    CRC-32, and each of those is refused); exactly one Info and one Tracks, at Segment level and before any Cluster,
 *    with exactly one TrackEntry: an audio track (TrackType 2) coded A_OPUS, whose fields and Audio fields are known
 *    ones, each once and read by its type (integers of at most 8 bytes, floats of 0, 4 or 8, texts of at most 64 bytes,
 *    a codec or document type of at most 16, SegmentUUID 16 and DateUTC 8, as in every other element), enabled and default (FlagEnabled and FlagDefault 1 when written, FlagForced and FlagLacing 0 or 1), whose
 *    CodecPrivate is a valid OpusHead. A Cluster holds only Timestamp, Position, PrevSize, SimpleBlock, BlockGroup
 *    (Block, BlockDuration, ReferenceBlock, DiscardPadding) and Void; every block is on that track, and every block's
 *    frames, after any lace table, each hold at least one byte, each laced frame counted against the walk's cap. Only
 *    the Segment and a Cluster may be of unknown size, as Chrome writes them; an unknown-size Cluster ends where a
 *    Segment-level element begins.
 *  - Ogg: whole pages to the last byte, each with the capture pattern, version 0, only the defined flags and a
 *    matching CRC; one logical stream, whose first page alone is its beginning-of-stream page and holds exactly its
 *    OpusHead (exactly 19 bytes, version 0.x, mapping family 0 with one or two channels); pages in sequence, continued
 *    exactly when a packet runs on, none after its last; OpusTags next, read whole (at most 4 KiB and 64 `key=value`
 *    comments, no METADATA_BLOCK_PICTURE, nothing after the comments) and the last packet on its page; then an audio
 *    packet of at least one byte.
 *    Vorbis, in Ogg or WebM, is refused: no browser records it.
 *  - MP4: a leading `ftyp` whose major and compatible brands are all MP4 audio brands; at the top only ftyp, one
 *    moov, mdat, moof and padding; in moov one mvhd and exactly one trak, whose tkhd says it is enabled, whose handler
 *    is `soun`, whose minf has smhd and one dinf naming this file, and whose stsd holds exactly one `mp4a` entry with
 *    one esds of AAC-LC (a listed sample-rate index matching the entry's nonzero rate, one or two channels, 1,024
 *    samples a frame) or one `Opus` entry with one 11-byte dOps (version 0, family 0, one or two channels), which every
 *    stsc run, tfhd and trex names (index 1); an edit list only as one elst of one or two entries at rate 1, at most an
 *    empty edit first and exactly one edit of the media; every container's children from its own allow-list, each
 *    table at most once (no udta, meta, iods, sgpd, sbgp, sidx, mfra, stss or elng); every table and full box ending
 *    exactly at its last field for its version (0, or 1 where the box defines it), with only the flags it defines
 *    (none, but tkhd's four track flags, tfhd's and trun's field flags and url's self-contained 1), the handler name at most 64 bytes
 *    ending at its one zero byte, the data reference at most one zero byte; fragments only when moov's mvex has the
 *    track's trex; and the audio samples (stsz/stsc/stco or co64, and each fragment's runs for that track, from its
 *    base with the tfhd and trex defaults) add up to at least one byte, every chunk or run of them inside an mdat's
 *    payload, found by a binary search of the mdat ranges (they are in file order), and together they tile every mdat
 *    payload exactly, so no mdat holds a byte that is not a sample.
 *  - Length: the longest of what the file says and what its frames hold, so it is never shorter than the sound: WebM
 *    Info Duration and the last block's timestamp; Ogg the last granule position (less the pre-skip); MP4 mvhd, mdhd,
 *    the edit list (its empty edit's delay before the media) and the media timeline's end (moov's stts durations, then
 *    each fragment's trun durations from its tfdt start, or from where the one before ended); and for every
 *    container the frames themselves (each Opus packet's length from its TOC byte, 1,024 samples per AAC frame at the
 *    esds rate). A file whose length cannot be read (an MP4 with no media timescale, an edit list with no movie
 *    timescale, an Ogg ending on a page with no granule) is refused, and so is one under half a second: the rules apply
 *    to the length as stored, rounded to the nearest second.
 * Every read is bounds-checked, walks are capped in steps (the structure's depth is fixed by the allow-lists; a laced
 * frame is a step, charged before it is listed, and so is every completed Ogg packet), Ogg pages, samples (a trun's count against what is left, before its samples are
 * read), mdat boxes and fragments are capped well past what two minutes can hold, and anything missing, malformed or
 * unexpected answers null: a parse problem is a refusal, never a pass. The input is already bounded by the base64
 * upload cap, and the caller runs this only after it has checked the uploader may add a file to the visit.
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

/**
 * An accepted recording: its length in seconds, from the file itself (never from the request; Codex P2 on #1013), and
 * the whole seconds it is stored with, the length rounded to the nearest second.
 */
export interface VoiceRecording { seconds: number; durationSec: number }

/**
 * The recording's length in seconds when the bytes are an audio-only recording, with sound in it, in the container
 * its type names; else null. A parse problem is a refusal, never a pass.
 */
export function recordingSeconds(mime: string, bytes: Buffer): number | null {
  try {
    const seconds = mime === 'audio/webm' ? webmSeconds(bytes) : mime === 'audio/ogg' ? oggSeconds(bytes) : mime === 'audio/mp4' ? mp4Seconds(bytes) : null;
    return seconds !== null && Number.isFinite(seconds) ? seconds : null;
  } catch (err) {
    if (err instanceof Malformed || err instanceof RangeError) return null;
    throw err;
  }
}

export function readVoiceRecording(mime: string, bytes: Buffer): VoiceRecording | null {
  const seconds = recordingSeconds(mime, bytes);
  if (seconds === null) return null;
  // the rules apply to the length as stored (#1013 replacement review): a recording that rounds to no second at all
  // (under half a second) is no voice note, never stored as 1 s; the two-minute cap is the caller's, on the same value
  const durationSec = Math.round(seconds);
  if (durationSec < 1) return null;
  return { seconds, durationSec };
}

/** Whether the bytes are an audio-only recording with sound in it, of any length (the shape alone). */
export function isAudioOnlyRecording(mime: string, bytes: Buffer): boolean {
  return recordingSeconds(mime, bytes) !== null;
}

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
 * SegmentUUID of exactly 16 bytes, a date of exactly 8; a container, a block or the OpusHead, each read by its caller;
 * or Void, padding no player reads, counted against the file's padding cap. CRC-32 is refused everywhere (Chrome
 * writes none, and an unverified checksum is bytes passed over unread). Each element appears once in its parent, but
 * Void, blocks and BlockGroups.
 */
type Kind = 'uint' | 'int' | 'float' | 'text' | 'code' | 'uuid' | 'date' | 'master' | 'block' | 'group' | 'opushead' | 'void';
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
  if (kind !== 'void' && kind !== 'block' && kind !== 'group') {
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
 * The number of the one track a Tracks element lists, which must be Opus audio, the one codec a browser records voice
 * in WebM, with only known fields; else a refusal.
 */
function audioTrack(b: Buffer, tracks: Element, steps: Walk): number {
  let found: number | undefined;
  for (const entry of elements(b, tracks.dataStart, tracks.dataEnd, steps, TRACKS_CHILDREN)) {
    if (entry.id !== TRACK_ENTRY) continue;
    if (found !== undefined) fail(); // one track: a second, of any type, is refused
    const seen = new Map<number, Element>();
    for (const field of elements(b, entry.dataStart, entry.dataEnd, steps, TRACK_ENTRY_CHILDREN)) {
      if (field.id === VOID) continue;
      seen.set(field.id, field); // each field once (checked by the walk)
      if (field.id === AUDIO) for (const _ of elements(b, field.dataStart, field.dataEnd, steps, AUDIO_CHILDREN));
    }
    const number = seen.get(TRACK_NUMBER);
    const type = seen.get(TRACK_TYPE);
    const codec = seen.get(CODEC_ID);
    if (!number || !type || !codec) fail();
    if (uintOf(b, type!) !== 2) fail(); // audio
    // Opus only: Vorbis's length would come from its headers alone, and no browser records it
    if (codeOf(b, codec!) !== 'A_OPUS') fail();
    // the one track is one a player plays (Codex P2 on #1013 round 3): enabled and default when the flags are
    // written (both default to 1), and the other flags are booleans
    const flag = (id: number, allowed: number[]) => {
      const f = seen.get(id);
      if (f && !allowed.includes(uintOf(b, f))) fail();
    };
    flag(FLAG_ENABLED, [1]);
    flag(FLAG_DEFAULT, [1]);
    flag(FLAG_FORCED, [0, 1]);
    flag(FLAG_LACING, [0, 1]);
    // an Opus track's CodecPrivate is its OpusHead, which Matroska requires and Chrome writes
    const head = seen.get(CODEC_PRIVATE);
    if (!head || !isOpusHead(b, head.dataStart, head.dataEnd - head.dataStart)) fail();
    found = uintOf(b, number!);
    if (found < 1) fail();
  }
  if (found === undefined) fail();
  return found!;
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
function blockTrack(b: Buffer, start: number, end: number, steps: Walk): { track: number; timecode: number; frames: Array<{ at: number; size: number }> } {
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
  return { track: track.value, timecode, frames };
}

/**
 * A Cluster's children, from `cluster`'s data to its end (an unknown-size Cluster ends where the next Segment-level
 * element begins, or at the Segment's end): only the allowed children, every block on `track`, and its Timestamp
 * before any block. Returns where the Segment walk resumes, whether a block held sound, the latest block timestamp
 * (in Segment ticks), and the Opus samples its frames hold.
 */
function walkCluster(b: Buffer, cluster: Element, track: number, steps: Walk): { next: number; sound: boolean; lastTick: number; samples: number } {
  const end = cluster.dataEnd;
  let sound = false;
  let lastTick = 0;
  let samples = 0;
  let base: number | undefined; // the Cluster's Timestamp
  const seen = new Set<number>(); // one Timestamp, Position and PrevSize
  let at = cluster.dataStart;
  while (at < end) {
    if (cluster.unknownSize) {
      const id = vint(b, at, end, true).value;
      if (!CLUSTER_CHILDREN.has(id)) {
        if (SEGMENT_CHILDREN.has(id)) return { next: at, sound, lastTick, samples };
        fail();
      }
    }
    const e = readElement(b, at, end, steps);
    checkChild(b, e, CLUSTER_CHILDREN, seen, steps);
    if (e.id === CLUSTER_TIMESTAMP) base = uintOf(b, e);
    const blocks: Element[] = [];
    if (e.id === SIMPLE_BLOCK) blocks.push(e);
    if (e.id === BLOCK_GROUP) {
      for (const x of elements(b, e.dataStart, e.dataEnd, steps, BLOCK_GROUP_CHILDREN)) if (x.id === BLOCK) blocks.push(x);
      if (blocks.length !== 1) fail(); // a BlockGroup holds exactly one Block
    }
    for (const block of blocks) {
      if (base === undefined) fail(); // a block's time is relative to its Cluster's Timestamp, which comes first
      const r = blockTrack(b, block.dataStart, block.dataEnd, steps);
      if (r.track !== track) fail(); // a block on a track the file does not list
      sound = true; // every frame of it holds at least one byte
      lastTick = Math.max(lastTick, base! + r.timecode);
      for (const f of r.frames) samples += opusPacketSamples(b, f.at, f.size);
    }
    at = e.dataEnd;
  }
  return { next: end, sound, lastTick, samples };
}

/** A float element of 0, 4 or 8 bytes; it must be a finite number, not below 0. */
function floatOf(b: Buffer, e: Element): number {
  const width = e.dataEnd - e.dataStart;
  const value = width === 0 ? 0 : width === 4 ? b.readFloatBE(e.dataStart) : width === 8 ? b.readDoubleBE(e.dataStart) : fail();
  if (!Number.isFinite(value) || value < 0) fail();
  return value;
}

function webmSeconds(b: Buffer): number | null {
  const steps = { n: 0, padding: 0 };
  const header = readElement(b, 0, b.length, steps);
  if (header.id !== EBML_HEADER) return null;
  const docTypes: string[] = [];
  for (const e of elements(b, header.dataStart, header.dataEnd, steps, EBML_HEADER_CHILDREN)) {
    if (e.id === DOC_TYPE) docTypes.push(codeOf(b, e));
  }
  if (docTypes.length !== 1 || docTypes[0] !== 'webm') return null;
  // one Segment, and nothing after it
  const segment = readElement(b, header.dataEnd, b.length, steps, true);
  if (segment.id !== SEGMENT || segment.dataEnd !== b.length) return null;
  let track: number | undefined; // the one audio track, from the one Segment-level Tracks
  let sound = false;
  let info = false;
  let scale = 1_000_000; // nanoseconds per tick, TimestampScale's default
  let duration = 0; // Info's Duration, in ticks
  let lastTick = 0; // the latest block timestamp
  let samples = 0; // Opus samples in every frame
  for (let at = segment.dataStart; at < segment.dataEnd;) {
    const id = vint(b, at, segment.dataEnd, true).value;
    const e = readElement(b, at, segment.dataEnd, steps, id === CLUSTER);
    if (!SEGMENT_CHILDREN.has(e.id)) return null;
    if (e.id === CLUSTER) {
      // blocks before the track table that names their track, or before the Info that times them (Chrome writes Info
      // first)
      if (track === undefined || !info) return null;
      const r = walkCluster(b, e, track, steps);
      if (r.sound) sound = true;
      lastTick = Math.max(lastTick, r.lastTick);
      samples += r.samples;
      at = r.next;
      continue;
    }
    if (e.id === TRACKS) {
      if (track !== undefined) return null; // one track table
      track = audioTrack(b, e, steps);
    } else if (e.id === INFO) {
      if (info) return null; // one Info
      info = true;
      for (const f of elements(b, e.dataStart, e.dataEnd, steps, INFO_CHILDREN)) {
        if (f.id === TIMESTAMP_SCALE) scale = uintOf(b, f);
        if (f.id === DURATION) duration = floatOf(b, f);
      }
      if (scale < 1) return null;
    } else {
      padding(steps, e.dataEnd - e.dataStart); // what is left is Void
    }
    at = e.dataEnd;
  }
  if (track === undefined || !sound) return null;
  return Math.max((Math.max(duration, lastTick) * scale) / 1e9, samples / OPUS_RATE);
}

// ── Ogg ──────────────────────────────────────────────────────────────────────────────────────

/**
 * the most Ogg pages one walk visits: a recorder writes a page or so a second, and an empty page completes no packet, so
 * pages are capped on their own, well under the 388,000 empty pages the upload's size cap could hold
 */
const MAX_OGG_PAGES = 100_000;

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

/** the most of a packet kept while it is read: enough for OpusHead, the longest header it is matched against */
const OGG_HEAD_BYTES = 19;
/**
 * the longest OpusTags read, and the most comments in it: a recorder writes its name and perhaps an encoder line, so
 * a tags packet past this is room for a payload, not a voice note's header (#1013 replacement review)
 */
const OPUS_TAGS_MAX = 4096;
const OPUS_TAGS_COMMENTS = 64;

/**
 * Whether a packet is an OpusTags read whole (RFC 7845 §5.2): the magic, the vendor string's length and the string,
 * the comment count (at most 64), then each comment's length and the comment, a `key=value` whose key is not
 * METADATA_BLOCK_PICTURE (a picture), ending exactly at the packet's end. No data is allowed after the comments.
 */
function isOpusTags(p: Buffer): boolean {
  if (p.toString('latin1', 0, 8) !== 'OpusTags') return false;
  // a length running past the packet leaves `at` past its end: the next read throws a RangeError, or the end check
  // below fails, and either is a refusal
  let at = 12 + p.readUInt32LE(8);
  const comments = p.readUInt32LE(at);
  at += 4;
  if (comments > OPUS_TAGS_COMMENTS) return false;
  for (let i = 0; i < comments; i++) {
    const length = p.readUInt32LE(at);
    at += 4;
    const comment = p.toString('latin1', at, at + length);
    const equals = comment.indexOf('=');
    if (equals < 1 || comment.slice(0, equals).toUpperCase() === 'METADATA_BLOCK_PICTURE') return false;
    at += length;
  }
  return at === p.length;
}

function oggSeconds(b: Buffer): number | null {
  let at = 0;
  let serial: number | undefined; // the one logical stream
  let packets = 0; // packets the stream has completed
  let head = Buffer.alloc(0); // the first bytes of the packet being read
  let length = 0; // its length so far
  let open = false; // whether the last page left it unfinished
  let next = 0; // the page sequence number the next page must have
  let ended = false;
  let sound = false;
  let granule = -1; // the latest granule position: samples decoded by its page's last finished packet (-1: none yet)
  let timed = false; // whether the page just read carries a granule position
  let preSkip = 0; // samples the decoder drops at the start
  let samples = 0; // Opus samples in every audio packet, from each one's TOC byte
  for (let page = 0; page < MAX_OGG_PAGES; page++) {
    // whole pages to the last byte; a packet still open at the end never ended, so it is not counted
    if (at === b.length) {
      // the length: the last granule (less the pre-skip), but never less than the frames themselves hold
      if (!sound || !timed) return null;
      return Math.max(Math.max(0, granule - preSkip), samples) / OPUS_RATE;
    }
    if (at + 27 > b.length) return null;
    if (b.toString('latin1', at, at + 4) !== 'OggS' || b[at + 4] !== 0) return null;
    const flags = b[at + 5]!;
    if (flags & ~0x07) return null; // only continued (1), first (2) and last (4) are defined
    const segments = b[at + 26]!;
    if (at + 27 + segments > b.length) return null;
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += b[at + 27 + i]!;
    const body = at + 27 + segments;
    const pageEnd = body + payload;
    if (pageEnd > b.length) return null;
    // every page's checksum (Codex P2 on #1013): a page changed in transit or by hand is refused
    if (oggPageCrc(b, at, pageEnd) !== b.readUInt32LE(at + 22)) return null;
    // the granule position: -1 when no packet finishes on the page; otherwise it never goes back
    const pageGranule = b.readBigInt64LE(at + 6);
    if (pageGranule !== -1n) {
      if (pageGranule < 0n || pageGranule > BigInt(Number.MAX_SAFE_INTEGER) || Number(pageGranule) < granule) return null;
      granule = Number(pageGranule);
    }
    timed = pageGranule !== -1n; // the file's last page must carry one (checked at the end)
    const pageSerial = b.readUInt32LE(at + 14);
    const sequence = b.readUInt32LE(at + 18);
    const first = serial === undefined;
    // one stream: its first page alone is the beginning-of-stream page, and every page is that stream's
    if (first !== ((flags & 0x02) !== 0)) return null;
    if (first) serial = pageSerial;
    if (pageSerial !== serial || ended) return null;
    // in sequence, none missing, and continued exactly when the page before left a packet open
    if (!first && sequence !== next) return null;
    next = sequence + 1;
    if (((flags & 0x01) !== 0) !== open) return null;
    // the lacing values split the page into packets; a packet ends at a value under 255 and may run across pages
    let offset = body;
    let completed = 0;
    for (let i = 0; i < segments; i++) {
      const lace = b[at + 27 + i]!;
      // OpusTags is kept whole, to its cap; every other packet only as far as its header or TOC byte
      const keep = packets === 1 ? OPUS_TAGS_MAX : OGG_HEAD_BYTES;
      if (packets === 1 && length + lace > OPUS_TAGS_MAX) return null;
      if (head.length < keep) head = Buffer.concat([head, b.subarray(offset, offset + Math.min(lace, keep - head.length))]);
      length += lace;
      offset += lace;
      if (lace === 255) continue;
      completed++;
      if (packets === 0) {
        // OpusHead: the 19-byte family-0 header of a mono or stereo recording (Codex P2 on #1013 round 3); Vorbis
        // and every other codec are refused
        if (!isOpusHead(head, 0, length)) return null;
        preSkip = head.readUInt16LE(10);
      } else if (packets === 1) {
        // OpusTags read whole, and the last packet on its page: audio starts on a fresh page (RFC 7845 §3)
        if (!isOpusTags(head) || i !== segments - 1) return null;
      } else {
        if (length > 0) sound = true;
        samples += opusPacketSamples(head, 0, length);
      }
      packets++;
      // every packet is a step: two minutes of Opus's shortest 2.5 ms frames is 48,000 packets, and an empty one costs
      // as much to complete as any other
      if (packets > MAX_STEPS) return null;
      head = Buffer.alloc(0);
      length = 0;
    }
    if (segments > 0) open = b[at + 27 + segments - 1] === 255;
    // the beginning-of-stream page holds exactly the identification header
    if (first && (completed !== 1 || open)) return null;
    if (flags & 0x04) ended = true;
    at = pageEnd;
  }
  return null;
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
 * A container's children by type, every one named in its allow-list; a type in `once` that appears twice fails.
 */
function children(b: Buffer, start: number, end: number, container: string, steps: Walk, once: string[] = []): Map<string, Box[]> {
  const out = new Map<string, Box[]>();
  for (const x of boxes(b, start, end, steps)) {
    if (!MP4_CHILDREN[container]!.has(x.type)) fail();
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
  return b.readUInt32BE(tkhd.dataStart + (version === 1 ? 20 : 12)); // read whole by exactBox before this
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
 * the media twice. Returns the empty edit's delay and the media edit's duration, in movie ticks.
 */
function editList(b: Buffer, edts: Box, steps: Walk): { delay: number; edit: number } {
  const elst = only(children(b, edts.dataStart, edts.end, 'edts', steps, ['elst']), 'elst');
  const { version, flags } = fullBoxHead(b, elst);
  if (version > 1 || flags !== 0 || elst.dataStart + 8 > elst.end) fail();
  const count = b.readUInt32BE(elst.dataStart + 4);
  const width = version === 1 ? 20 : 12;
  if (count < 1 || count > 2 || elst.dataStart + 8 + width * count !== elst.end) fail();
  let delay = 0;
  let edit: number | undefined;
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
      if (mediaTime < 0n || edit !== undefined) fail(); // one edit of the media
      edit = duration;
    }
  }
  return { delay, edit: edit! };
}

/**
 * The brands an MP4 audio recording carries (Codex P2 on #1013 round 3): the ISO base and MP4 families, Apple's M4A,
 * and the fragmented and CMAF ones recorders name; `avc1` and `vp09` only as compatible brands, which MP4 writers list
 * whatever the track (Chromium 141's recorder writes isom, iso6, iso2, vp09 and mp41 for an Opus voice note, and its
 * recording is a test). heic, mif1, qt and every brand not named here are refused.
 */
const MP4_BRANDS = new Set(['M4A ', 'mp41', 'mp42', 'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'dash', 'cmfc', 'msdh', 'msix']);
const MP4_COMPATIBLE_ONLY = new Set(['avc1', 'vp09']);

/** Whether an ftyp is whole (major brand, minor version, whole compatible brands) and names only MP4 audio brands. */
function audioBrands(b: Buffer, ftyp: Box): boolean {
  const length = ftyp.end - ftyp.dataStart;
  if (length < 8 || (length - 8) % 4 !== 0) return false;
  if (!MP4_BRANDS.has(b.toString('latin1', ftyp.dataStart, ftyp.dataStart + 4))) return false;
  for (let at = ftyp.dataStart + 8; at < ftyp.end; at += 4) {
    const brand = b.toString('latin1', at, at + 4);
    if (!MP4_BRANDS.has(brand) && !MP4_COMPATIBLE_ONLY.has(brand)) return false;
  }
  return true;
}

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

function mp4Seconds(b: Buffer): number | null {
  const steps = { n: 0, padding: 0 };
  const all = [...boxes(b, 0, b.length, steps, true)];
  if (all[0]?.type !== 'ftyp' || !audioBrands(b, all[0])) return null;
  for (const x of all) {
    if (!MP4_CHILDREN.file!.has(x.type)) return null;
    if (isPadding(x.type)) padding(steps, x.end - x.dataStart);
  }
  if (all.filter((x) => x.type === 'ftyp').length !== 1) return null;
  const moovs = all.filter((x) => x.type === 'moov');
  if (moovs.length !== 1) return null;
  const media: MediaRanges = all.filter((x) => x.type === 'mdat').map((x) => ({ from: x.dataStart, to: x.end }));
  const fragments = all.filter((x) => x.type === 'moof');
  if (media.length > MAX_MEDIA_BOXES || fragments.length > MAX_MEDIA_BOXES) return null;
  const moov = children(b, moovs[0]!.dataStart, moovs[0]!.end, 'moov', steps, ['mvhd', 'mvex']);
  const movie = timeHeader(b, only(moov, 'mvhd'), MVHD);
  // exactly one track, the voice: a second track of any handler (vide, auxv, meta, text, sbtl, hint, soun) is refused
  const trak = only(moov, 'trak');
  const t = children(b, trak.dataStart, trak.end, 'trak', steps, ['tkhd', 'mdia', 'edts']);
  // the track is one a player plays: tkhd's track_enabled flag, MP4's FlagEnabled (#1013 replacement review)
  const tkhd = only(t, 'tkhd');
  if (!(exactBox(b, tkhd, TKHD, TKHD_FLAGS).flags & 0x1)) return null;
  // an edit list is counted in the length, against the movie's timescale
  const edts = t.get('edts')?.[0];
  const edits = edts ? editList(b, edts, steps) : undefined;
  if (edits && movie.scale === 0) return null;
  const mdia = only(t, 'mdia');
  const m = children(b, mdia.dataStart, mdia.end, 'mdia', steps, ['mdhd', 'hdlr', 'minf']);
  // the media timescale times every sample; with none, the recording's length cannot be read
  const mdhd = timeHeader(b, only(m, 'mdhd'), MDHD);
  if (mdhd.scale === 0) return null;
  const hdlr = only(m, 'hdlr');
  // version and flags (4), pre_defined (4), the handler type, three reserved words, then the name: at most 64 bytes,
  // its first zero byte its last, so the box ends there (#1013 replacement review); a box too short for a name has its
  // first zero at or past its end
  const name = hdlr.dataStart + 24;
  const handler = fullBoxHead(b, hdlr);
  if (handler.version !== 0 || handler.flags !== 0) return null;
  if (hdlr.end - name > HANDLER_NAME_MAX || b.indexOf(0, name) !== hdlr.end - 1) return null;
  if (b.toString('latin1', hdlr.dataStart + 8, hdlr.dataStart + 12) !== 'soun') return null;
  const minf = only(m, 'minf');
  const mi = children(b, minf.dataStart, minf.end, 'minf', steps, ['smhd', 'dinf', 'stbl']);
  exactBox(b, only(mi, 'smhd'), SMHD); // the sound media header a sound track carries
  // one data reference, naming this file (#1013 replacement review: a track with none is refused, not passed)
  if (!selfContained(b, only(mi, 'dinf'), steps)) return null;
  const stbl = only(mi, 'stbl');
  const st = children(b, stbl.dataStart, stbl.end, 'stbl', steps, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64']);
  // AAC: every frame decodes to 1,024 samples at the esds rate; Opus: each packet's TOC byte gives its samples
  const { opus, rate: aacRate } = audioSampleEntry(b, only(st, 'stsd'), steps);
  let opusSamples = 0;
  const sample = (at: number, size: number) => {
    if (size < 1) fail(); // every sample holds at least one byte, in moov's table and in every fragment (RFC 6716 §3.4 R1)
    if (opus) opusSamples += opusPacketSamples(b, at, size);
  };
  const id = trackId(b, tkhd);
  const ranges: SampleRanges = []; // every chunk and run, to tile the mdat payloads
  const table = sampleTable(b, stbl, media, ranges, steps, sample); // every chunk checked to lie inside an mdat
  let bytes = table.bytes;
  let frames = table.count;
  // where the track's media timeline ends, in media ticks: after moov's samples, then each fragment's runs from its
  // own start, which is tfdt's baseMediaDecodeTime when the fragment gives one (Codex P2 on #1025: a short run placed
  // minutes in is minutes long), else where the one before ended
  let timeline = table.ticks;
  let ticks = table.ticks;
  // and the plain sum of every sample duration, as a player that ignores tfdt plays them: a tfdt that goes back makes
  // runs overlap on the timeline, and the length is never less than this sum either
  let summed = table.ticks;
  // the track's fragment defaults: needed before any fragment counts (Codex P2 on #1013 round 3)
  let trex: { duration: number; size: number } | undefined;
  // mehd's fragment_duration: the whole fragmented movie's length, in the movie timescale (ISO 14496-12 §8.8.2),
  // counted in the length like mvhd's duration (32 bits at version 0, 64 at version 1)
  let fragmented = 0;
  for (const mvex of moov.get('mvex') ?? []) {
    const mv = children(b, mvex.dataStart, mvex.end, 'mvex', steps, ['mehd']);
    for (const mehd of mv.get('mehd') ?? []) {
      const head = exactBox(b, mehd, MEHD);
      fragmented = Math.max(fragmented, head.version === 1 ? u64(b, mehd.dataStart + 4) : b.readUInt32BE(mehd.dataStart + 4));
      if (movie.scale === 0) return null; // a movie length with no movie timescale cannot be read
    }
    for (const x of mv.get('trex') ?? []) {
      exactBox(b, x, TREX);
      if (b.readUInt32BE(x.dataStart + 4) !== id || trex !== undefined) return null; // defaults for the one track, once
      if (b.readUInt32BE(x.dataStart + 8) !== 1) return null; // the one sample entry
      trex = { duration: b.readUInt32BE(x.dataStart + 12), size: b.readUInt32BE(x.dataStart + 16) };
    }
  }
  if (fragments.length > 0 && trex === undefined) return null; // fragments the movie does not declare
  // a fragmented file (iOS) lists its samples per fragment, each run of them at an offset from its fragment's base
  for (const fragment of fragments) {
    const mo = children(b, fragment.dataStart, fragment.end, 'moof', steps, ['mfhd']);
    exactBox(b, only(mo, 'mfhd'), MFHD);
    let previousEnd: number | undefined; // where the previous traf's data ended, the next one's base by default
    for (const traf of mo.get('traf') ?? []) {
      const tr = children(b, traf.dataStart, traf.end, 'traf', steps, ['tfhd', 'tfdt']);
      let decodeTime: number | undefined; // tfdt's baseMediaDecodeTime: 32 bits at version 0, 64 at version 1
      for (const tfdt of tr.get('tfdt') ?? []) {
        const time = exactBox(b, tfdt, TFDT);
        decodeTime = time.version === 1 ? u64(b, tfdt.dataStart + 4) : b.readUInt32BE(tfdt.dataStart + 4);
      }
      if (decodeTime !== undefined) timeline = decodeTime;
      const tfhd = only(tr, 'tfhd');
      const { version, flags } = fullBoxHead(b, tfhd);
      if (version !== 0 || flags & ~TFHD_FLAGS) return null;
      if (tfhd.dataStart + 8 > tfhd.end) fail();
      if (b.readUInt32BE(tfhd.dataStart + 4) !== id) return null; // a fragment of a track the file does not list
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
      if (flags & 0x2 && field(4) !== 1) return null; // the one sample entry
      const defaults = { duration: flags & 0x8 ? field(4) : trex!.duration, size: flags & 0x10 ? field(4) : trex!.size };
      if (flags & 0x20) field(4); // default_sample_flags
      if (at !== tfhd.end) fail(); // tfhd ends at its last field
      let cursor = base;
      for (const trun of tr.get('trun') ?? []) {
        // the samples left under the cap bound this run's count before any of its samples is read (#1025 audit)
        const run = trunRun(b, trun, defaults, MAX_SAMPLES - frames);
        frames += run.count;
        // a run starts at its data_offset from the base, else right after the previous run
        if (run.dataOffset !== undefined) cursor = base + run.dataOffset;
        if (cursor < 0 || !Number.isSafeInteger(cursor + run.bytes)) fail();
        if (run.bytes > 0) {
          if (!inMedia(media, cursor, run.bytes)) fail();
          ranges.push({ at: cursor, bytes: run.bytes });
        }
        for (let i = 0, p = cursor; i < run.count; p += run.sizeOf(i), i++) sample(p, run.sizeOf(i));
        bytes += run.bytes;
        const runStart = timeline;
        timeline += run.ticks;
        summed += run.ticks;
        if (!Number.isSafeInteger(timeline) || !Number.isSafeInteger(summed)) fail();
        // a sample's composition offset places it later (or, at version 1, earlier) than its decode time: the length
        // counts where the run's latest sample ends as presented (ISO 14496-12 §8.6.1.1)
        ticks = Math.max(ticks, timeline, runStart + run.reach);
        cursor += run.bytes;
      }
      previousEnd = cursor;
    }
  }
  if (bytes === 0 || !tilesMedia(media, ranges)) return null;
  // the length: the longest of the movie header, mehd's movie length and, after any empty edit's delay, the media edit,
  // the media header, the sample durations (the timeline's furthest end, and their plain sum) and what the frames hold
  const played = Math.max(
    edits ? edits.edit / movie.scale : 0,
    mdhd.duration !== null ? mdhd.duration / mdhd.scale : 0,
    Math.max(ticks, summed) / mdhd.scale,
    opus ? opusSamples / OPUS_RATE : (frames * 1024) / aacRate,
  );
  return Math.max(
    movie.scale > 0 && movie.duration !== null ? movie.duration / movie.scale : 0,
    movie.scale > 0 ? fragmented / movie.scale : 0,
    (edits ? edits.delay / movie.scale : 0) + played,
  );
}

/**
 * One trun: its sample count, its data_offset if it gives one (signed), its bytes and ticks with the defaults applied,
 * where its latest sample ends as presented (after its composition offset), and each sample's size. A count above `left` (the samples the file may still list) is refused before any sample is
 * read: with default sizes and durations a run's samples take no bytes of their own.
 */
function trunRun(b: Buffer, trun: Box, defaults: { duration: number; size: number }, left: number): { count: number; dataOffset: number | undefined; bytes: number; ticks: number; reach: number; sizeOf: (i: number) => number } {
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
  for (let i = 0; i < count; i++) {
    bytes += sizeOf(i);
    const duration = durationOf(i);
    reach = Math.max(reach, ticks + shiftOf(i) + duration);
    ticks += duration;
  }
  return { count, dataOffset, bytes, ticks, reach, sizeOf };
}
