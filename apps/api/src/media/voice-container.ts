/**
 * Stage 1 voice (#482, Codex P2s on #1010) — is this upload an audio-only recording, with sound in it, in the
 * container its type names?
 *
 * A bounded structural check, not a demuxer: it walks the headers that list a file's tracks and the tables that say
 * where its samples are, and never decodes the sound.
 *  - WebM: the EBML header's DocType is "webm"; every Segment > Tracks holds only audio TrackEntries (TrackType 2),
 *    at least one; and some Cluster holds a SimpleBlock or BlockGroup > Block on one of those tracks with a frame of
 *    at least one byte.
 *  - Ogg: whole pages to the last byte; every stream opens with an Opus (`OpusHead`) or Vorbis (`\x01vorbis`)
 *    beginning-of-stream page; its header packets follow in order (OpusTags; or Vorbis comment and setup); and some
 *    stream then carries an audio packet of at least one byte.
 *  - MP4: a leading `ftyp`; every moov > trak > mdia > hdlr names a handler, at least one `soun` and no `vide`; the
 *    audio tracks' samples (moov's `stsz`, and for a fragmented file each moof > traf > trun for an audio track_ID,
 *    with the tfhd and trex default sizes) add up to at least one byte; and that many bytes of `mdat` payload are in
 *    the file.
 * Every read is bounds-checked, walks are capped in steps, and anything missing, malformed or unexpected answers
 * false: a parse problem is a refusal, never a pass. The input is already bounded by the base64 upload cap.
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
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;

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

/** Each element in [start, end). An unknown-size element is allowed only where `allowUnknown` says, and runs to `end`. */
function* elements(b: Buffer, start: number, end: number, steps: { n: number }, allowUnknown: (id: number) => boolean): Generator<Element> {
  let at = start;
  while (at < end) {
    if (++steps.n > MAX_STEPS) fail();
    const id = vint(b, at, end, true);
    const size = vint(b, at + id.length, end, false);
    const dataStart = at + id.length + size.length;
    if (size.unknown && !allowUnknown(id.value)) fail();
    const dataEnd = size.unknown ? end : dataStart + size.value;
    if (dataEnd > end) fail();
    yield { id: id.value, dataStart, dataEnd, unknownSize: size.unknown };
    if (size.unknown) return; // nothing after an element that runs to the end
    at = dataEnd;
  }
}

const CLUSTER = 0x1f43b675;
const TRACK_NUMBER = 0xd7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
/** what a Cluster may hold besides its blocks (Timestamp, Position, PrevSize, SilentTracks, EncryptedBlock, Void, CRC-32) */
const CLUSTER_CHILDREN = new Set([0xe7, 0xa7, 0xab, 0x5854, 0xaf, 0xec, 0xbf, SIMPLE_BLOCK, BLOCK_GROUP]);

/** The track numbers of this Tracks element when every TrackEntry is audio and numbered, at least one; else null. */
function audioTrackNumbers(b: Buffer, tracks: Element, steps: { n: number }): number[] | null {
  const numbers: number[] = [];
  for (const entry of elements(b, tracks.dataStart, tracks.dataEnd, steps, () => false)) {
    if (entry.id !== TRACK_ENTRY) continue;
    let type: number | undefined;
    let number: number | undefined;
    for (const field of elements(b, entry.dataStart, entry.dataEnd, steps, () => false)) {
      if (field.id !== TRACK_TYPE && field.id !== TRACK_NUMBER) continue;
      const width = field.dataEnd - field.dataStart;
      if (width < 1 || width > 6) return null;
      const value = b.readUIntBE(field.dataStart, width);
      if (field.id === TRACK_TYPE) type = value;
      else number = value;
    }
    if (type !== 2 || !number) return null; // video, subtitles, or a track that does not say: not a voice note
    numbers.push(number);
  }
  return numbers.length > 0 ? numbers : null;
}

/** The track of a block whose frame holds at least one byte (its body: track number, timecode, flags, frame). */
function blockTrack(b: Buffer, start: number, end: number): number | null {
  const track = vint(b, start, end, false);
  if (track.unknown) return null;
  const flags = start + track.length + 2;
  if (flags >= end) return null;
  const laced = (b[flags]! & 0x06) !== 0;
  // a laced block counts its frames first; a frame of at least one byte must follow either way
  const frame = flags + 1 + (laced ? 1 : 0);
  return frame < end ? track.value : null;
}

function webmIsAudioOnly(b: Buffer): boolean {
  const steps = { n: 0 };
  const top = elements(b, 0, b.length, steps, (id) => id === SEGMENT);
  const header = top.next();
  if (header.done || header.value.id !== EBML_HEADER || header.value.unknownSize) return false;
  let docType: string | undefined;
  for (const e of elements(b, header.value.dataStart, header.value.dataEnd, steps, () => false)) {
    if (e.id === DOC_TYPE) docType = b.toString('latin1', e.dataStart, e.dataEnd).replace(/\0+$/, '');
  }
  if (docType !== 'webm') return false;
  let tracksSeen = 0;
  const audio = new Set<number>();
  const sounding = new Set<number>(); // tracks with a block of at least one byte
  for (const segment of top) {
    if (segment.id !== SEGMENT) continue;
    // Walked flat: a recorder streams Clusters of unknown size, which end only where an element that cannot sit in
    // a Cluster begins, so the walk steps INTO every Cluster and keeps reading. Every Tracks it meets is checked,
    // wherever it sits, and a block counts only while the walk is inside a Cluster. Only a Cluster may be of
    // unknown size.
    let at = segment.dataStart;
    const end = segment.dataEnd;
    let clusterEnd = -1; // the end of the sized Cluster the walk is in, or Infinity inside an unknown-size one
    while (at < end) {
      if (++steps.n > MAX_STEPS) fail();
      const id = vint(b, at, end, true);
      const size = vint(b, at + id.length, end, false);
      const dataStart = at + id.length + size.length;
      if (at >= clusterEnd || (clusterEnd === Infinity && !CLUSTER_CHILDREN.has(id.value))) clusterEnd = -1;
      if (size.unknown) {
        if (id.value !== CLUSTER) return false;
        clusterEnd = Infinity;
        at = dataStart;
        continue;
      }
      const dataEnd = dataStart + size.value;
      if (dataEnd > end) fail();
      if (id.value === CLUSTER) {
        clusterEnd = dataEnd;
        at = dataStart;
        continue;
      }
      if (id.value === TRACKS) {
        const numbers = audioTrackNumbers(b, { id: id.value, dataStart, dataEnd, unknownSize: false }, steps);
        if (!numbers) return false;
        for (const n of numbers) audio.add(n);
        tracksSeen++;
      } else if (clusterEnd !== -1 && dataEnd <= clusterEnd && id.value === SIMPLE_BLOCK) {
        const track = blockTrack(b, dataStart, dataEnd);
        if (track !== null) sounding.add(track);
      } else if (clusterEnd !== -1 && dataEnd <= clusterEnd && id.value === BLOCK_GROUP) {
        for (const child of elements(b, dataStart, dataEnd, steps, () => false)) {
          if (child.id !== BLOCK) continue;
          const track = blockTrack(b, child.dataStart, child.dataEnd);
          if (track !== null) sounding.add(track);
        }
      }
      at = dataEnd;
    }
  }
  return tracksSeen > 0 && [...sounding].some((n) => audio.has(n));
}

// ── Ogg ──────────────────────────────────────────────────────────────────────────────────────

/** the most Ogg pages one walk visits: a page is at least 27 bytes, so this covers any upload the size cap allows */
const MAX_OGG_PAGES = 500_000;

/** One Ogg stream, by serial: its codec, how many packets it has completed, and the packet being carried. */
interface OggStream { codec: 'opus' | 'vorbis'; packets: number; length: number; head: Buffer }

/** the header packets each codec opens with, by their first bytes, before any audio packet */
const OGG_HEADERS: Record<OggStream['codec'], string[]> = {
  opus: ['OpusHead', 'OpusTags'],
  vorbis: ['\x01vorbis', '\x03vorbis', '\x05vorbis'],
};

function oggIsAudioOnly(b: Buffer): boolean {
  let at = 0;
  const streams = new Map<number, OggStream>();
  let sound = false;
  for (let page = 0; page < MAX_OGG_PAGES; page++) {
    // whole pages to the last byte; every page is read, so a chained stream later in the file is checked too
    if (at === b.length) {
      // a packet still being carried never ended, so it is not counted
      return sound;
    }
    if (at + 27 > b.length) return false;
    if (b.toString('latin1', at, at + 4) !== 'OggS' || b[at + 4] !== 0) return false;
    const headerType = b[at + 5]!;
    const serial = b.readUInt32LE(at + 14);
    const segments = b[at + 26]!;
    if (at + 27 + segments > b.length) return false;
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += b[at + 27 + i]!;
    const body = at + 27 + segments;
    if (body + payload > b.length) return false;
    if (headerType & 0x02) {
      // a beginning-of-stream page opens one stream, and its first packet names the codec
      if (streams.has(serial)) return false;
      const packet = b.subarray(body, body + payload);
      const opus = packet.length >= 19 && packet.toString('latin1', 0, 8) === 'OpusHead';
      const vorbis = packet.length >= 30 && packet[0] === 0x01 && packet.toString('latin1', 1, 7) === 'vorbis';
      if (!opus && !vorbis) return false;
      streams.set(serial, { codec: opus ? 'opus' : 'vorbis', packets: 0, length: 0, head: Buffer.alloc(0) });
    }
    const stream = streams.get(serial);
    if (!stream) return false; // a page for a stream that never began
    // the lacing values split the page into packets; a packet ends at a value under 255 and may run across pages
    let offset = body;
    for (let i = 0; i < segments; i++) {
      const lace = b[at + 27 + i]!;
      if (stream.head.length < 8) stream.head = Buffer.concat([stream.head, b.subarray(offset, offset + Math.min(lace, 8 - stream.head.length))]);
      stream.length += lace;
      offset += lace;
      if (lace === 255) continue;
      const headers = OGG_HEADERS[stream.codec];
      if (stream.packets < headers.length) {
        if (stream.head.toString('latin1', 0, headers[stream.packets]!.length) !== headers[stream.packets]) return false;
      } else if (stream.length > 0) {
        sound = true;
      }
      stream.packets++;
      stream.length = 0;
      stream.head = Buffer.alloc(0);
    }
    at = body + payload;
  }
  return false;
}

// ── MP4 (ISO BMFF) ───────────────────────────────────────────────────────────────────────────

interface Box { type: string; dataStart: number; end: number }

/** Each box in [start, end): size 1 is a 64-bit size, size 0 runs to `end`, anything smaller than its header fails. */
function* boxes(b: Buffer, start: number, end: number, steps: { n: number }): Generator<Box> {
  let at = start;
  while (at < end) {
    if (++steps.n > MAX_STEPS) fail();
    if (at + 8 > end) fail();
    let size = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) fail();
      const big = b.readBigUInt64BE(at + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail();
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) fail();
    yield { type, dataStart: at + header, end: at + size };
    at += size;
  }
}

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

/** The bytes a stsz box declares: one size for every sample, or a table of sizes. */
function stszBytes(b: Buffer, stsz: Box): number {
  const at = stsz.dataStart + 4;
  if (at + 8 > stsz.end) fail();
  const size = b.readUInt32BE(at);
  const count = b.readUInt32BE(at + 4);
  if (size !== 0) return size * count;
  if (at + 8 + 4 * count > stsz.end) fail();
  let total = 0;
  for (let i = 0; i < count; i++) total += b.readUInt32BE(at + 8 + 4 * i);
  return total;
}

/** The bytes one trun declares, with the sample size from the trun, else tfhd's default, else trex's. */
function trunBytes(b: Buffer, trun: Box, defaultSize: number): number {
  const { flags } = fullBoxHead(b, trun);
  let at = trun.dataStart + 4;
  if (at + 4 > trun.end) fail();
  const count = b.readUInt32BE(at);
  at += 4;
  if (flags & 0x1) at += 4; // data_offset
  if (flags & 0x4) at += 4; // first_sample_flags
  const fields = [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f);
  const entry = 4 * fields.length;
  if (at + entry * count > trun.end) fail();
  if (!(flags & 0x200)) return defaultSize * count;
  const sizeAt = 4 * fields.indexOf(0x200);
  let total = 0;
  for (let i = 0; i < count; i++) total += b.readUInt32BE(at + entry * i + sizeAt);
  return total;
}

function mp4IsAudioOnly(b: Buffer): boolean {
  const steps = { n: 0 };
  const top = boxes(b, 0, b.length, steps);
  const first = top.next();
  if (first.done || first.value.type !== 'ftyp') return false;
  const audio = new Set<number>();
  const trexSize = new Map<number, number>();
  let samples = 0; // the audio tracks' declared sample bytes
  let media = 0; // the mdat payload bytes present in the file
  const fragments: Box[] = [];
  for (const box of top) {
    if (box.type === 'mdat') media += box.end - box.dataStart;
    if (box.type === 'moof') fragments.push(box);
    if (box.type !== 'moov') continue;
    for (const part of boxes(b, box.dataStart, box.end, steps)) {
      if (part.type === 'mvex') {
        for (const t of boxes(b, part.dataStart, part.end, steps)) {
          if (t.type !== 'trex') continue;
          if (t.dataStart + 20 > t.end) fail();
          trexSize.set(b.readUInt32BE(t.dataStart + 4), b.readUInt32BE(t.dataStart + 16));
        }
      }
      if (part.type !== 'trak') continue;
      let handler: string | undefined;
      let table: Box | undefined;
      for (const mdia of boxes(b, part.dataStart, part.end, steps)) {
        if (mdia.type !== 'mdia') continue;
        for (const x of boxes(b, mdia.dataStart, mdia.end, steps)) {
          if (x.type === 'hdlr') {
            // version and flags (4), pre_defined (4), then the handler type
            if (x.dataStart + 12 > x.end) return false;
            handler = b.toString('latin1', x.dataStart + 8, x.dataStart + 12);
          } else if (x.type === 'minf') {
            const stbl = child(b, x.dataStart, x.end, 'stbl', steps);
            if (stbl) table = child(b, stbl.dataStart, stbl.end, 'stsz', steps);
          }
        }
      }
      if (handler === 'vide' || handler === undefined) return false;
      // other handlers (hint, metadata) carry no picture and are left alone
      if (handler !== 'soun') continue;
      const tkhd = child(b, part.dataStart, part.end, 'tkhd', steps);
      if (!tkhd) return false;
      audio.add(trackId(b, tkhd));
      if (table) samples += stszBytes(b, table);
    }
  }
  if (audio.size === 0) return false;
  // a fragmented file (iOS) lists its samples per fragment, for the track its tfhd names
  for (const fragment of fragments) {
    for (const traf of boxes(b, fragment.dataStart, fragment.end, steps)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(b, traf.dataStart, traf.end, 'tfhd', steps);
      if (!tfhd) return false;
      const { flags } = fullBoxHead(b, tfhd);
      if (tfhd.dataStart + 8 > tfhd.end) fail();
      const id = b.readUInt32BE(tfhd.dataStart + 4);
      if (!audio.has(id)) continue;
      // tfhd's optional fields, in order: base_data_offset (8), sample_description_index, default duration, size
      const sizeAt = tfhd.dataStart + 8 + (flags & 0x1 ? 8 : 0) + (flags & 0x2 ? 4 : 0) + (flags & 0x8 ? 4 : 0);
      let defaultSize = trexSize.get(id) ?? 0;
      if (flags & 0x10) {
        if (sizeAt + 4 > tfhd.end) fail();
        defaultSize = b.readUInt32BE(sizeAt);
      }
      for (const run of boxes(b, traf.dataStart, traf.end, steps)) {
        if (run.type === 'trun') samples += trunBytes(b, run, defaultSize);
      }
    }
  }
  return samples > 0 && samples <= media;
}
