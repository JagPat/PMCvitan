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
 *    packet of at least one byte; and no packet left open at the file's end.
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
 *  - Length: the longest of what the file says and where its last decodable sample ends, so it is never shorter than
 *    the sound: WebM Info Duration and where the latest block ends (its timestamp, then its frames, every laced one, as
 *    their TOC bytes time them, or its BlockDuration, or DefaultDuration a frame); Ogg the last granule position (less
 *    the pre-skip); MP4 mvhd, mdhd, the edit list (its empty edit's delay before the media) and the media timeline's
 *    end (moov's stts durations, then each fragment's trun durations from its tfdt start, or from where the one before
 *    ended, each sample as presented); and for every
 *    container the frames themselves (each Opus packet's length from its TOC byte, 1,024 samples per AAC frame at the
 *    esds rate). A file whose length cannot be read (an MP4 with no media timescale, an edit list with no movie
 *    timescale, an Ogg ending on a page with no granule) is refused, as is anything unfinished at the file's end (an
 *    element, box or page cut short, an Ogg packet left open), and so is one under half a second: the rules apply
 *    to the length as stored, rounded to the nearest second.
 * Every read is bounds-checked, walks are capped in steps (the structure's depth is fixed by the allow-lists; a laced
 * frame is a step, charged before it is listed, and so is every completed Ogg packet), Ogg pages, samples (a trun's count against what is left, before its samples are
 * read), mdat boxes and fragments are capped well past what two minutes can hold, and anything missing, malformed or
 * unexpected answers null: a parse problem is a refusal, never a pass. The input is already bounded by the base64
 * upload cap, and the caller runs this only after it has checked the uploader may add a file to the visit.
 */

import {
  AUDIO, AUDIO_CHILDREN, BLOCK, BLOCK_DURATION, BLOCK_GROUP, BLOCK_GROUP_CHILDREN, CLUSTER, CLUSTER_CHILDREN,
  CLUSTER_TIMESTAMP, DOC_TYPE, DURATION, EBML_HEADER, EBML_HEADER_CHILDREN, HANDLER_NAME_MAX, INFO, INFO_CHILDREN,
  MAX_MEDIA_BOXES, MAX_SAMPLES, MAX_STEPS, MDHD, MEHD, MFHD, MP4_BRANDS, MP4_CHILDREN, MP4_COMPATIBLE_ONLY, MVHD,
  Malformed, OPUS_RATE, SEGMENT, SEGMENT_CHILDREN, SIMPLE_BLOCK, SMHD, TFDT, TFHD_FLAGS, TIMESTAMP_SCALE, TKHD,
  TKHD_FLAGS, TRACKS, TRACKS_CHILDREN, TRACK_ENTRY, TRACK_ENTRY_CHILDREN, TRACK_TYPE, TREX, VOID, aacRate,
  audioSampleEntry, blockTrack, boxes, checkChild, children, codeOf, editList, elements, exactBox, fail,
  floatOf, fullBoxHead, inMedia, isOpusHead, isPadding, only, opusPacketSamples, opusTrack, padding, readElement,
  sampleTable, selfContained, tilesMedia, timeHeader, trackId, trunRun, u64, uintOf, vint, type Box, type Element,
  type MediaRanges, type SampleRanges, type Walk,
} from './container-walk';

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

// ── WebM (EBML) ──────────────────────────────────────────────────────────────────────────────

/**
 * The number of the one track a Tracks element lists, which must be Opus audio, the one codec a browser records voice
 * in WebM, with only known fields; else a refusal.
 */
function audioTrack(b: Buffer, tracks: Element, steps: Walk): { number: number; frameNs: number } {
  let found: { number: number; frameNs: number } | undefined;
  for (const entry of elements(b, tracks.dataStart, tracks.dataEnd, steps, TRACKS_CHILDREN)) {
    if (entry.id !== TRACK_ENTRY) continue;
    if (found !== undefined) fail(); // one track: a second, of any type, is refused
    const seen = new Map<number, Element>();
    for (const field of elements(b, entry.dataStart, entry.dataEnd, steps, TRACK_ENTRY_CHILDREN)) {
      if (field.id === VOID) continue;
      seen.set(field.id, field); // each field once (checked by the walk)
      if (field.id === AUDIO) for (const _ of elements(b, field.dataStart, field.dataEnd, steps, AUDIO_CHILDREN));
    }
    if (uintOf(b, seen.get(TRACK_TYPE) ?? fail()) !== 2) fail(); // audio
    found = opusTrack(b, seen);
  }
  if (found === undefined) fail();
  return found!;
}

/**
 * A Cluster's children, from `cluster`'s data to its end (an unknown-size Cluster ends where the next Segment-level
 * element begins, or at the Segment's end): only the allowed children, every block on `track`, and its Timestamp
 * before any block. Returns where the Segment walk resumes, whether a block held sound, where its latest block ends
 * (in seconds, `scale` nanoseconds a tick), and the Opus samples its frames hold.
 */
function walkCluster(b: Buffer, cluster: Element, track: { number: number; frameNs: number }, scale: number, steps: Walk): { next: number; sound: boolean; last: number; samples: number } {
  const end = cluster.dataEnd;
  let sound = false;
  let last = 0;
  let samples = 0;
  let base: number | undefined; // the Cluster's Timestamp
  const seen = new Set<number>(); // one Timestamp, Position and PrevSize
  let at = cluster.dataStart;
  while (at < end) {
    if (cluster.unknownSize) {
      const id = vint(b, at, end, true).value;
      if (!CLUSTER_CHILDREN.has(id)) {
        if (SEGMENT_CHILDREN.has(id)) return { next: at, sound, last, samples };
        fail();
      }
    }
    const e = readElement(b, at, end, steps);
    checkChild(b, e, CLUSTER_CHILDREN, seen, steps);
    if (e.id === CLUSTER_TIMESTAMP) base = uintOf(b, e);
    const blocks: Element[] = [];
    let ticks = 0; // a BlockGroup's BlockDuration, in Segment ticks (0 when not written)
    if (e.id === SIMPLE_BLOCK) blocks.push(e);
    if (e.id === BLOCK_GROUP) {
      for (const x of elements(b, e.dataStart, e.dataEnd, steps, BLOCK_GROUP_CHILDREN)) {
        if (x.id === BLOCK) blocks.push(x);
        if (x.id === BLOCK_DURATION) ticks = uintOf(b, x);
      }
      if (blocks.length !== 1) fail(); // a BlockGroup holds exactly one Block
    }
    for (const block of blocks) {
      if (base === undefined) fail(); // a block's time is relative to its Cluster's Timestamp, which comes first
      const r = blockTrack(b, block.dataStart, block.dataEnd, steps);
      if (r.track !== track.number) fail(); // a block on a track the file does not list
      sound = true; // every frame of it holds at least one byte
      let held = 0; // the Opus samples the block's frames hold, every laced frame of it
      for (const f of r.frames) held += opusPacketSamples(b, f.at, f.size);
      samples += held;
      // the block ends where its last frame ends, not where it starts (Codex P2 on #1025 round 2: 256 laced 120 ms
      // frames at 120 s play to 150.7 s): its frames as their TOC bytes time them, or what the file says they last,
      // BlockDuration or each frame's DefaultDuration, whichever is longest
      const start = ((base! + r.timecode) * scale) / 1e9;
      last = Math.max(last, start + Math.max(held / OPUS_RATE, (ticks * scale) / 1e9, (r.frames.length * track.frameNs) / 1e9));
    }
    at = e.dataEnd;
  }
  return { next: end, sound, last, samples };
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
  let track: { number: number; frameNs: number } | undefined; // the one audio track, from the one Segment-level Tracks
  let sound = false;
  let info = false;
  let scale = 1_000_000; // nanoseconds per tick, TimestampScale's default
  let duration = 0; // Info's Duration, in ticks
  let last = 0; // where the latest block ends, in seconds
  let samples = 0; // Opus samples in every frame
  for (let at = segment.dataStart; at < segment.dataEnd;) {
    const id = vint(b, at, segment.dataEnd, true).value;
    const e = readElement(b, at, segment.dataEnd, steps, id === CLUSTER);
    if (!SEGMENT_CHILDREN.has(e.id)) return null;
    if (e.id === CLUSTER) {
      // blocks before the track table that names their track, or before the Info that times them (Chrome writes Info
      // first)
      if (track === undefined || !info) return null;
      const r = walkCluster(b, e, track, scale, steps);
      if (r.sound) sound = true;
      last = Math.max(last, r.last);
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
  return Math.max((duration * scale) / 1e9, last, samples / OPUS_RATE);
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
    // whole pages to the last byte, and every packet finished: one still open at the end never ended, and bytes no
    // decoder reads are refused, not stored (Codex P2 on #1025 round 2)
    if (at === b.length) {
      // the length: the last granule (less the pre-skip), but never less than the frames themselves hold
      if (open || !sound || !timed) return null;
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
      // duration-is-empty says the fragment holds no samples for its time: a track run in it contradicts that
      if (flags & 0x10000 && tr.has('trun')) return null;
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
