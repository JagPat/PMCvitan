/**
 * Stage 1 voice (#482, Codex P2 on #1010) — is this upload an audio-only recording in the container its type names?
 *
 * A bounded structural check, not a demuxer: it walks only the headers that say what tracks a file holds.
 *  - WebM: the EBML header's DocType is "webm", and every Segment > Tracks holds only audio TrackEntries
 *    (TrackType 2), at least one.
 *  - Ogg: whole pages to the last byte; every beginning-of-stream page opens an Opus (`OpusHead`) or Vorbis
 *    (`\x01vorbis`) stream, and at least one page after it carries data.
 *  - MP4: a leading `ftyp`, then every moov > trak > mdia > hdlr names a handler, at least one `soun` and no
 *    `vide`.
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

/** Every TrackEntry in this Tracks element is audio, and there is at least one. */
function tracksAreAudio(b: Buffer, tracks: Element, steps: { n: number }): boolean {
  let audio = 0;
  for (const entry of elements(b, tracks.dataStart, tracks.dataEnd, steps, () => false)) {
    if (entry.id !== TRACK_ENTRY) continue;
    let type: number | undefined;
    for (const field of elements(b, entry.dataStart, entry.dataEnd, steps, () => false)) {
      if (field.id !== TRACK_TYPE) continue;
      const width = field.dataEnd - field.dataStart;
      if (width < 1 || width > 8) return false;
      type = b.readUIntBE(field.dataStart + Math.max(0, width - 6), Math.min(width, 6));
    }
    if (type !== 2) return false; // video, subtitles, or a track that does not say: not a voice note
    audio++;
  }
  return audio > 0;
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
  for (const segment of top) {
    if (segment.id !== SEGMENT) continue;
    // Walked flat: a recorder streams Clusters of unknown size, which end only where the next non-Cluster element
    // begins, so the walk steps INTO an unknown-size Cluster and keeps reading; every Tracks it meets is checked,
    // wherever it sits. Only a Cluster may be of unknown size.
    let at = segment.dataStart;
    const end = segment.dataEnd;
    while (at < end) {
      if (++steps.n > MAX_STEPS) fail();
      const id = vint(b, at, end, true);
      const size = vint(b, at + id.length, end, false);
      const dataStart = at + id.length + size.length;
      if (size.unknown) {
        if (id.value !== CLUSTER) return false;
        at = dataStart;
        continue;
      }
      const dataEnd = dataStart + size.value;
      if (dataEnd > end) fail();
      if (id.value === TRACKS) {
        if (!tracksAreAudio(b, { id: id.value, dataStart, dataEnd, unknownSize: false }, steps)) return false;
        tracksSeen++;
      }
      at = dataEnd;
    }
  }
  return tracksSeen > 0;
}

// ── Ogg ──────────────────────────────────────────────────────────────────────────────────────

/** the most Ogg pages one walk visits: a page is at least 27 bytes, so this covers any upload the size cap allows */
const MAX_OGG_PAGES = 500_000;

function oggIsAudioOnly(b: Buffer): boolean {
  let at = 0;
  let streams = 0;
  let dataPages = 0;
  for (let page = 0; page < MAX_OGG_PAGES; page++) {
    // whole pages to the last byte; every page is read, so a chained stream later in the file is checked too
    if (at === b.length) return streams > 0 && dataPages > 0;
    if (at + 27 > b.length) return false;
    if (b.toString('latin1', at, at + 4) !== 'OggS' || b[at + 4] !== 0) return false;
    const headerType = b[at + 5]!;
    const segments = b[at + 26]!;
    if (at + 27 + segments > b.length) return false;
    let payload = 0;
    for (let i = 0; i < segments; i++) payload += b[at + 27 + i]!;
    const body = at + 27 + segments;
    if (body + payload > b.length) return false;
    if (headerType & 0x02) {
      // a beginning-of-stream page opens one stream, and its first packet names the codec
      const packet = b.subarray(body, body + payload);
      const opus = packet.length >= 19 && packet.toString('latin1', 0, 8) === 'OpusHead';
      const vorbis = packet.length >= 30 && packet[0] === 0x01 && packet.toString('latin1', 1, 7) === 'vorbis';
      if (!opus && !vorbis) return false;
      streams++;
    } else {
      if (streams === 0) return false;
      dataPages++;
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

function mp4IsAudioOnly(b: Buffer): boolean {
  const steps = { n: 0 };
  const top = boxes(b, 0, b.length, steps);
  const first = top.next();
  if (first.done || first.value.type !== 'ftyp') return false;
  let sound = 0;
  for (const box of top) {
    if (box.type !== 'moov') continue;
    for (const trak of boxes(b, box.dataStart, box.end, steps)) {
      if (trak.type !== 'trak') continue;
      let handler: string | undefined;
      for (const mdia of boxes(b, trak.dataStart, trak.end, steps)) {
        if (mdia.type !== 'mdia') continue;
        for (const hdlr of boxes(b, mdia.dataStart, mdia.end, steps)) {
          if (hdlr.type !== 'hdlr') continue;
          // version and flags (4), pre_defined (4), then the handler type
          if (hdlr.dataStart + 12 > hdlr.end) return false;
          handler = b.toString('latin1', hdlr.dataStart + 8, hdlr.dataStart + 12);
        }
      }
      if (handler === 'soun') sound++;
      else if (handler === 'vide' || handler === undefined) return false;
      // other handlers (hint, metadata) carry no picture and are left alone
    }
  }
  return sound > 0;
}
