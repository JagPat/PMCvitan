/**
 * Stage 1 video on site visits (#995) — is this upload a video clip, with a picture in it, in the container its type
 * names, and how long is it?
 *
 * The voice note's check (`voice-container.ts`), widened to a picture track, both reading with the shared walks in
 * `container-walk.ts`: the same bounded structural walk, never a decoder, with the same caps (steps, padding, samples,
 * here counted over every track's frames in WebM too, mdat boxes and fragments) and the same allow-lists for every
 * structure the two share, so a clip's sound is read exactly as a voice note's is. Anything this does not name is a
 * refusal, never skipped; anything it names is read whole. The rules, with the test pinning each, are in the PR's
 * "Parser rules":
 *  - `video/webm`: the voice WebM rules, with one or two TrackEntries: exactly one video track (TrackType 1, V_VP8 or
 *    V_VP9, its Video element of known fields with a nonzero PixelWidth and PixelHeight, a Colour of known integer
 *    fields, no CodecPrivate, CodecDelay, SeekPreRoll or Audio) and at most one sound track, read as a voice note's is
 *    (A_OPUS with its OpusHead, no Video or MaxBlockAdditionID). No laced block on a track whose FlagLacing is 0. One
 *    Cues, after the Tracks, as Safari writes it after its Clusters (V2a): read whole as a voice note's, each point on
 *    a listed track at a Cluster's start. BlockAdditions (an alpha channel) stay refused, as every BlockGroup child but
 *    the voice ones is. A block's end is its timestamp plus, for sound, the longest of its Opus frames, its
 *    BlockDuration and DefaultDuration a frame, and for the picture the last two; the latest picture block with
 *    neither is held for the median interval between picture starts (at most a second), or the last interval if longer;
 *    no picture block starts before the one ahead of it.
 *  - `video/mp4`: the voice MP4 rules, with one or two traks: exactly one `vide` track (a `vmhd` with its one defined
 *    flag; one `avc1` entry with one avcC, or one `vp09` with one version-1 vpcC with no initialization data; at most
 *    one pasp, btrt and nclx colr each; the visual entry's fixed fields as ISO 14496-12 defines them) and at most one
 *    `soun` track read as a voice note's is (its runs give no non-zero composition offset, its frames play one after
 *    another from where each run sits, and its media edit selects some of them; the picture keeps its offsets). An
 *    avc1 sample is its NAL units, each with its length prefix (the avcC's
 *    1, 2 or 4 bytes) and at least one byte, filling the sample exactly. Fragments name a listed track, each with its
 *    own trex; an `mfra` is allowed only as the file's last box, read whole: each tfra once per listed track, every
 *    entry pointing at a moof, and an mfro giving the mfra's own size. Brands: the voice MP4 brands but `M4A `, with
 *    `avc1`, `vp09` and `M4V ` allowed as the major brand too.
 *  - Length: the longest of what the file says and where its last sample ends, over every track, as for a voice note.
 *    The rules apply to the length rounded to the nearest second: under half a second is refused here, and the
 *    upload refuses 60.5 s or more.
 * A parse problem is a refusal, never a pass. The caller runs this only after it has checked the uploader may add a
 * file to the visit.
 */
import {
  MAX_SAMPLES, MAX_MEDIA_BOXES, Malformed, fail, padding, charge, OPUS_RATE, opusPacketSamples,
  EBML_HEADER, DOC_TYPE, SEGMENT, INFO, TRACKS, TRACK_ENTRY, TRACK_NUMBER, TRACK_TYPE, CODEC_ID, AUDIO, CLUSTER, SIMPLE_BLOCK,
  CUES, CUES_CHILDREN, CUE_POINT_CHILDREN, CUE_TIME, CUE_TRACK_POSITIONS, CUE_TRACK_POSITIONS_CHILDREN, CUE_TRACK, CUE_CLUSTER_POSITION,
  BLOCK_GROUP, BLOCK, VOID, TIMESTAMP_SCALE, DURATION, CLUSTER_TIMESTAMP, BLOCK_DURATION, DEFAULT_DURATION,
  EBML_HEADER_CHILDREN, SEGMENT_CHILDREN, SEEK_HEAD, seekHead, INFO_CHILDREN, TRACK_ENTRY_CHILDREN, AUDIO_CHILDREN, CLUSTER_CHILDREN,
  BLOCK_GROUP_CHILDREN, vint, readElement, checkChild, elements, codeOf, uintOf, floatOf, opusTrack, trackFlags, blockTrack,
  boxes, u64, isPadding, MP4_CHILDREN, children, only, tilesMedia, inMedia, fullBoxHead, exactBox,
  MVHD, TKHD, MDHD, MEHD, TFDT, SMHD, MFHD, TREX, TKHD_FLAGS, HANDLER_NAME_MAX, trackId, sampleTable, selfContained,
  TFHD_FLAGS, audioSampleEntry, editList, MP4_BRANDS, timeHeader, trunRun,
  type Walk, type Kind, type Element, type Box, type MediaRanges, type SampleRanges,
} from './container-walk';

/**
 * An accepted clip: its length in seconds, from the file itself (never from the request), and the whole seconds it is
 * stored with, the length rounded to the nearest second.
 */
export interface VideoClip { seconds: number; durationSec: number }

/**
 * The clip's length in seconds when the bytes are a video clip, with a picture in it, in the container its type names;
 * else null. A parse problem is a refusal, never a pass.
 */
export function clipSeconds(mime: string, bytes: Buffer): number | null {
  try {
    const seconds = mime === 'video/webm' ? webmSeconds(bytes) : mime === 'video/mp4' ? mp4Seconds(bytes) : null;
    return seconds !== null && Number.isFinite(seconds) ? seconds : null;
  } catch (err) {
    if (err instanceof Malformed || err instanceof RangeError) return null;
    throw err;
  }
}

export function readVideoClip(mime: string, bytes: Buffer): VideoClip | null {
  const seconds = clipSeconds(mime, bytes);
  if (seconds === null) return null;
  // as for a voice note, the rules apply to the length as stored: a clip that rounds to no second is no clip, and the
  // 60 s cap is the caller's, on the same value
  const durationSec = Math.round(seconds);
  if (durationSec < 1) return null;
  return { seconds, durationSec };
}

// ── WebM (EBML) ──────────────────────────────────────────────────────────────────────────────

const VIDEO = 0xe0;
const CODEC_PRIVATE = 0x63a2;
const CODEC_DELAY = 0x56aa;
const SEEK_PRE_ROLL = 0x56bb;
const MAX_BLOCK_ADDITION_ID = 0x55ee;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const COLOUR = 0x55b0;
/**
 * a clip's Segment children: what Chrome writes, and the Cues Safari writes after its Clusters (WebKit's libwebm writer
 * in file mode, iOS 18.4 and later), as a voice note's (#1165)
 */
const CLIP_SEGMENT_CHILDREN = new Set([...SEGMENT_CHILDREN, CUES]);
/** the picture codecs a browser records WebM in */
const WEBM_VIDEO_CODECS = new Set(['V_VP8', 'V_VP9']);

/**
 * A clip's TrackEntry fields: the voice note's, and MaxBlockAdditionID and Video, which Chrome writes on its picture
 * track. Which of them a track may hold depends on its type (`clipTracks`).
 */
const CLIP_TRACK_ENTRY_CHILDREN = new Map<number, Kind>([...TRACK_ENTRY_CHILDREN, [MAX_BLOCK_ADDITION_ID, 'uint'], [VIDEO, 'master']]);
/**
 * Tracks holds a clip's one or two TrackEntries (read like BlockGroups, the kind a container may hold more than once,
 * each walked by its caller) and Void
 */
const CLIP_TRACKS_CHILDREN = new Map<number, Kind>([[TRACK_ENTRY, 'group'], [VOID, 'void']]);
/** the fields only a sound track has, and the ones only a picture track has */
const SOUND_ONLY = [CODEC_PRIVATE, CODEC_DELAY, SEEK_PRE_ROLL, AUDIO];
const PICTURE_ONLY = [MAX_BLOCK_ADDITION_ID, VIDEO];
/** PixelWidth, PixelHeight, DisplayWidth, DisplayHeight, DisplayUnit, FlagInterlaced, AlphaMode, Colour */
const VIDEO_CHILDREN = new Map<number, Kind>([
  [PIXEL_WIDTH, 'uint'], [PIXEL_HEIGHT, 'uint'], [0x54b0, 'uint'], [0x54ba, 'uint'], [0x54b2, 'uint'], [0x9a, 'uint'], [0x53c0, 'uint'],
  [COLOUR, 'master'], [VOID, 'void'],
]);
/**
 * MatrixCoefficients, BitsPerChannel, the chroma subsampling and siting fields, Range, TransferCharacteristics,
 * Primaries, MaxCLL, MaxFALL: integers; no MasteringMetadata
 */
const COLOUR_CHILDREN = new Map<number, Kind>([
  ...[0x55b1, 0x55b2, 0x55b3, 0x55b4, 0x55b5, 0x55b6, 0x55b7, 0x55b8, 0x55b9, 0x55ba, 0x55bb, 0x55bc, 0x55bd].map((id) => [id, 'uint'] as [number, Kind]),
  [VOID, 'void'],
]);

/** a listed track: its number, DefaultDuration, kind, and whether its blocks may be laced (FlagLacing, 1 when not written) */
interface ClipTrack { number: number; frameNs: number; sound: boolean; lacing: boolean }
/**
 * every picture block's start, in seconds, in file order (never going back), and the latest start of a block that does
 * not say how long it lasts
 */
interface Pictures { starts: number[]; untimed: number }
/** the longest the median holds an untimed last picture (decision 3 of the V2 plan): a second */
const HOLD_MAX = 1;

/**
 * A clip's tracks, by number: exactly one picture track (VP8 or VP9) and at most one sound track (Opus, read as a voice
 * note's is), each with only the fields its type has; a third track, a second of either type, or two with one number
 * is refused.
 */
function clipTracks(b: Buffer, tracks: Element, steps: Walk): Map<number, ClipTrack> {
  const out = new Map<number, ClipTrack>();
  let pictures = 0;
  let sounds = 0;
  for (const entry of elements(b, tracks.dataStart, tracks.dataEnd, steps, CLIP_TRACKS_CHILDREN)) {
    if (entry.id !== TRACK_ENTRY) continue;
    const seen = new Map<number, Element>();
    const picture = new Map<number, Element>(); // the Video element's fields
    for (const field of elements(b, entry.dataStart, entry.dataEnd, steps, CLIP_TRACK_ENTRY_CHILDREN)) {
      if (field.id === VOID) continue;
      seen.set(field.id, field); // each field once (checked by the walk)
      if (field.id === AUDIO) for (const _ of elements(b, field.dataStart, field.dataEnd, steps, AUDIO_CHILDREN));
      if (field.id === VIDEO) {
        for (const v of elements(b, field.dataStart, field.dataEnd, steps, VIDEO_CHILDREN)) {
          picture.set(v.id, v);
          if (v.id === COLOUR) for (const _ of elements(b, v.dataStart, v.dataEnd, steps, COLOUR_CHILDREN));
        }
      }
    }
    const type = uintOf(b, seen.get(TRACK_TYPE) ?? fail());
    let track: ClipTrack;
    if (type === 1) {
      if (++pictures > 1 || SOUND_ONLY.some((id) => seen.has(id))) fail();
      const number = seen.get(TRACK_NUMBER);
      const codec = seen.get(CODEC_ID);
      if (!number || !codec || !seen.has(VIDEO) || !WEBM_VIDEO_CODECS.has(codeOf(b, codec!))) fail();
      // a picture of some size: PixelWidth and PixelHeight are required and never 0
      const width = picture.get(PIXEL_WIDTH);
      const height = picture.get(PIXEL_HEIGHT);
      if (!width || !height || uintOf(b, width) < 1 || uintOf(b, height) < 1) fail();
      const { lacing } = trackFlags(b, seen);
      const each = seen.get(DEFAULT_DURATION);
      track = { number: uintOf(b, number!), frameNs: each ? uintOf(b, each) : 0, sound: false, lacing };
      if (track.number < 1) fail();
    } else if (type === 2) {
      if (++sounds > 1 || PICTURE_ONLY.some((id) => seen.has(id))) fail();
      track = { ...opusTrack(b, seen), sound: true };
    } else {
      fail();
    }
    if (out.has(track!.number)) fail();
    out.set(track!.number, track!);
  }
  return out; // a clip with no picture track has no picture block, which its walk refuses
}

/**
 * A Cluster's children, as a voice note's are walked, with every block on one of the clip's tracks. Returns where the
 * Segment walk resumes, whether a block held a picture, where its latest block ends (in seconds), and the Opus samples
 * its sound frames hold. Every frame is counted into `frames`, the whole file's, refused past the sample cap.
 */
function walkCluster(b: Buffer, cluster: Element, tracks: Map<number, ClipTrack>, scale: number, steps: Walk, frames: { n: number }, pictures: Pictures): { next: number; picture: boolean; last: number; samples: number } {
  const end = cluster.dataEnd;
  let picture = false;
  let last = 0;
  let samples = 0;
  let base: number | undefined; // the Cluster's Timestamp
  const seen = new Set<number>(); // one Timestamp, Position and PrevSize
  let at = cluster.dataStart;
  while (at < end) {
    if (cluster.unknownSize) {
      const id = vint(b, at, end, true).value;
      if (!CLUSTER_CHILDREN.has(id)) {
        if (CLIP_SEGMENT_CHILDREN.has(id)) return { next: at, picture, last, samples };
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
      const track = tracks.get(r.track);
      if (!track) fail(); // a block on a track the file does not list
      if (r.laced && !track!.lacing) fail(); // a laced block on a track whose FlagLacing 0 says none is (#1154, as voice)
      // every frame of either track counts toward the samples a clip may hold, as an MP4's do
      frames.n += r.frames.length;
      if (frames.n > MAX_SAMPLES) fail();
      // a block ends where its last frame ends: a sound block's frames as their TOC bytes time them, and for either
      // track what the file says the block lasts, BlockDuration or each frame's DefaultDuration, whichever is longest
      let held = 0;
      if (track!.sound) for (const f of r.frames) held += opusPacketSamples(b, f.at, f.size);
      else picture = true; // every frame of it holds at least one byte
      samples += held;
      const start = ((base! + r.timecode) * scale) / 1e9;
      if (!track!.sound) {
        // VP8 and VP9 never reorder frames, so no recorder writes a picture before the one ahead of it in the file; and
        // Firefox holds the last picture for the interval before it in file order, which a picture placed back would
        // hide from the hold (Stage 1's r2 check: 0 s, 59.4 s, then 59.39 s read 60.4 s and played 118.8 s)
        if (pictures.starts.length > 0 && start < pictures.starts[pictures.starts.length - 1]!) fail();
        pictures.starts.push(start);
        // a picture block with no BlockDuration and no DefaultDuration says where it starts, not where it ends
        if (ticks === 0 && track!.frameNs === 0) pictures.untimed = Math.max(pictures.untimed, start);
      }
      last = Math.max(last, start + Math.max(held / OPUS_RATE, (ticks * scale) / 1e9, (r.frames.length * track!.frameNs) / 1e9));
    }
    at = e.dataEnd;
  }
  return { next: end, picture, last, samples };
}

/**
 * The Cues, read whole as a voice note's are (#1165): CuePoints, each a CueTime and one CueTrackPositions on a listed
 * track, at most with the cue fields the voice reader names. Returns the Cluster positions they point at, from the
 * Segment's data, for the caller to check against where Clusters start; null when it is not such a Cues. libwebm cues
 * the picture track when there is one, but a cue on the sound track points into the same Clusters, so either listed
 * track is read.
 */
function cuedClusters(b: Buffer, cues: Element, tracks: Map<number, ClipTrack>, steps: Walk): number[] | null {
  const out: number[] = [];
  for (const point of elements(b, cues.dataStart, cues.dataEnd, steps, CUES_CHILDREN)) {
    if (point.id === VOID) continue;
    const fields = new Map<number, Element>();
    for (const f of elements(b, point.dataStart, point.dataEnd, steps, CUE_POINT_CHILDREN)) fields.set(f.id, f);
    const positions = fields.get(CUE_TRACK_POSITIONS);
    if (!fields.has(CUE_TIME) || !positions) return null;
    const place = new Map<number, Element>();
    for (const f of elements(b, positions.dataStart, positions.dataEnd, steps, CUE_TRACK_POSITIONS_CHILDREN)) place.set(f.id, f);
    const track = place.get(CUE_TRACK);
    const cluster = place.get(CUE_CLUSTER_POSITION);
    if (!track || !cluster || !tracks.has(uintOf(b, track))) return null;
    out.push(uintOf(b, cluster));
  }
  return out.length > 0 ? out : null;
}

function webmSeconds(b: Buffer): number | null {
  const steps = { n: 0, padding: 0 };
  const header = readElement(b, 0, b.length, steps);
  if (header.id !== EBML_HEADER) return null;
  const docTypes: string[] = [];
  for (const e of elements(b, header.dataStart, header.dataEnd, steps, EBML_HEADER_CHILDREN)) {
    if (e.id === DOC_TYPE) docTypes.push(codeOf(b, e));
  }
  // Chrome names an H.264 recording `x-matroska` with DocType matroska: refused, as the type says WebM
  if (docTypes.length !== 1 || docTypes[0] !== 'webm') return null;
  // one Segment, and nothing after it
  const segment = readElement(b, header.dataEnd, b.length, steps, true);
  if (segment.id !== SEGMENT || segment.dataEnd !== b.length) return null;
  let tracks: Map<number, ClipTrack> | undefined; // from the one Segment-level Tracks
  let picture = false;
  let info = false;
  let seek = false; // one SeekHead
  let scale = 1_000_000; // nanoseconds per tick, TimestampScale's default
  let duration = 0; // Info's Duration, in ticks
  let last = 0; // where the latest block ends, in seconds
  let samples = 0; // Opus samples in every sound frame
  const frames = { n: 0 }; // frames of both tracks, capped together
  const pictures: Pictures = { starts: [], untimed: -1 };
  const clusters = new Set<number>(); // where each Cluster starts, from the Segment's data
  let cued: number[] | undefined; // the Clusters the one Cues points at
  for (let at = segment.dataStart; at < segment.dataEnd;) {
    const id = vint(b, at, segment.dataEnd, true).value;
    const e = readElement(b, at, segment.dataEnd, steps, id === CLUSTER);
    if (!CLIP_SEGMENT_CHILDREN.has(e.id)) return null;
    if (e.id === CLUSTER) {
      clusters.add(at - segment.dataStart);
      // blocks before the track table that names their tracks, or before the Info that times them
      if (tracks === undefined || !info) return null;
      const r = walkCluster(b, e, tracks, scale, steps, frames, pictures);
      if (r.picture) picture = true;
      last = Math.max(last, r.last);
      samples += r.samples;
      at = r.next;
      continue;
    }
    if (e.id === TRACKS) {
      if (tracks !== undefined) return null; // one track table
      tracks = clipTracks(b, e, steps);
    } else if (e.id === SEEK_HEAD) {
      // the seek index, read whole and never followed: once, first (Chromium and Firefox write it before Info), and
      // pointing only at what this walk takes (the Cues too, which Chromium indexes when it records with no timeslice)
      if (seek || info || tracks !== undefined) return null;
      seek = true;
      seekHead(b, e, steps, CLIP_SEGMENT_CHILDREN, segment.dataEnd - segment.dataStart);
    } else if (e.id === CUES) {
      // the seek index: one, after the track table it names tracks from; it times nothing, so it is not in the length
      if (cued !== undefined || tracks === undefined) return null;
      const points = cuedClusters(b, e, tracks, steps);
      if (points === null) return null;
      cued = points;
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
  // a clip has a picture: a file whose only blocks are sound is a voice note, not a video
  if (tracks === undefined || !picture) return null;
  if (cued && !cued.every((p) => clusters.has(p))) return null; // a cue at no Cluster's start
  // Chromium writes no durations for picture blocks. The latest one is held for the median interval between picture
  // blocks (at most a second), or the last interval if that is longer, whatever else starts with it or after it, unless
  // Info's Duration reaches past its start (V2 plan, decision 3: one stall mid-clip no longer lengthens it). Firefox
  // holds the last picture for the last interval, so the length is never less than it plays. With no interval to go
  // by, the end is unknown: refused
  if (pictures.untimed >= 0 && (duration * scale) / 1e9 <= pictures.untimed) {
    const hold = heldFor(pictures.starts);
    if (hold === 0) return null;
    last = Math.max(last, pictures.untimed + hold);
  }
  return Math.max((duration * scale) / 1e9, last, samples / OPUS_RATE);
}

/**
 * How long an untimed last picture is held: the median of the intervals between successive picture starts (the longer
 * middle one of an even count), at most HOLD_MAX, or the last interval, the one before the latest start, if that is
 * longer (Firefox plays the last picture for it: a lone frame at 59.4 s after one at 0 plays to 118.8 s, so it reads
 * that long and is refused); 0 when no two pictures start apart. Blocks that start together are one picture time, so
 * no zero interval pulls the median down or stands as the last.
 */
function heldFor(starts: number[]): number {
  // the starts are in file order and never go back (walkCluster), so the last interval is the one before the last start
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) if (starts[i]! > starts[i - 1]!) gaps.push(starts[i]! - starts[i - 1]!);
  if (gaps.length === 0) return 0;
  const lastGap = gaps[gaps.length - 1]!;
  gaps.sort((x, y) => x - y);
  return Math.max(Math.min(gaps[Math.floor(gaps.length / 2)]!, HOLD_MAX), lastGap);
}

// ── MP4 (ISO BMFF) ───────────────────────────────────────────────────────────────────────────

/**
 * A clip's boxes: the voice note's, and a picture track's `vmhd`, its two sample entries' boxes, and a closing `mfra`
 * (Chrome writes one when its recorder stops).
 */
const CLIP_MP4_CHILDREN: Record<string, Set<string>> = {
  ...MP4_CHILDREN,
  file: new Set([...MP4_CHILDREN.file!, 'mfra']),
  minf: new Set([...MP4_CHILDREN.minf!, 'vmhd']),
  avc1: new Set(['avcC', 'pasp', 'btrt', 'colr']),
  vp09: new Set(['vpcC', 'pasp', 'btrt', 'colr']),
  mfra: new Set(['tfra', 'mfro']),
};
/** the MP4 video brands: the voice note's but Apple's audio M4A, with the picture codecs' and Apple's M4V */
const CLIP_BRANDS = new Set([...[...MP4_BRANDS].filter((brand) => brand !== 'M4A '), 'avc1', 'vp09', 'M4V ']);
/** vmhd at version 0, and its one defined flag (ISO 14496-12 §12.1.2: it is always 1) */
const VMHD = [12];
/** vpcC at version 1 (its only defined version), with no codec initialization data */
const VPCC = [-1, 12];
/** mfro at version 0 */
const MFRO = [8];
/** the H.264 profiles whose avcC carries the chroma and bit-depth fields (ISO 14496-15 §5.3.3.1.2) */
const HIGH_PROFILES = new Set([100, 110, 122, 144]);

/** Whether an ftyp is whole and names only MP4 video brands. */
function clipBrands(b: Buffer, ftyp: Box): boolean {
  const length = ftyp.end - ftyp.dataStart;
  if (length < 8 || (length - 8) % 4 !== 0) return false;
  if (!CLIP_BRANDS.has(b.toString('latin1', ftyp.dataStart, ftyp.dataStart + 4))) return false;
  for (let at = ftyp.dataStart + 8; at < ftyp.end; at += 4) {
    if (!CLIP_BRANDS.has(b.toString('latin1', at, at + 4))) return false;
  }
  return true;
}

/**
 * An avcC read whole (ISO 14496-15 §5.3.3.1): version 1, the reserved bits set, a NAL length of 1, 2 or 4 bytes, at
 * least one sequence and one picture parameter set, each a NAL unit of its own type with the forbidden bit clear, and,
 * for the high profiles, the chroma and bit-depth fields with any parameter set extensions; nothing after. Returns the
 * NAL length size.
 */
function avcConfig(b: Buffer, avcC: Box): number {
  const end = avcC.end;
  let at = avcC.dataStart;
  const need = (n: number) => {
    if (at + n > end) fail();
  };
  need(6);
  if (b[at] !== 1 || (b[at + 4]! & 0xfc) !== 0xfc || (b[at + 5]! & 0xe0) !== 0xe0) fail();
  const profile = b[at + 1]!;
  const lengthSize = (b[at + 4]! & 0x03) + 1;
  if (lengthSize === 3) fail();
  const sets = (count: number, type: number) => {
    for (let i = 0; i < count; i++) {
      need(2);
      const length = b.readUInt16BE(at);
      at += 2;
      if (length < 1 || at + length > end || b[at]! & 0x80 || (b[at]! & 0x1f) !== type) fail();
      at += length;
    }
  };
  const sps = b[at + 5]! & 0x1f;
  at += 6;
  if (sps < 1) fail();
  sets(sps, 7);
  need(1);
  const pps = b[at++]!;
  if (pps < 1) fail();
  sets(pps, 8);
  if (at < end && HIGH_PROFILES.has(profile)) {
    need(4);
    if ((b[at]! & 0xfc) !== 0xfc || (b[at + 1]! & 0xf8) !== 0xf8 || (b[at + 2]! & 0xf8) !== 0xf8) fail();
    const extensions = b[at + 3]!;
    at += 4;
    sets(extensions, 13);
  }
  if (at !== end) fail();
  return lengthSize;
}

/**
 * An H.264 sample: its NAL units back to back, each a length prefix of `lengthSize` bytes and at least one byte with
 * the forbidden bit clear, filling the sample exactly. Every NAL unit is a step of the walk.
 */
function nalUnits(b: Buffer, at: number, size: number, lengthSize: number, steps: Walk): void {
  const end = at + size;
  for (let p = at; p < end;) {
    charge(steps, 1);
    if (p + lengthSize > end) fail();
    const length = b.readUIntBE(p, lengthSize);
    p += lengthSize;
    if (length < 1 || p + length > end || b[p]! & 0x80) fail();
    p += length;
  }
}

/**
 * A picture track's one sample entry, read whole: the version 0 visual layout (ISO 14496-12 §12.1.3) naming the one
 * data reference, a nonzero width and height, 72 dpi, one frame a sample, a compressor name of at most 31 bytes with
 * zeros after it, depth 24 and pre_defined -1; then one avcC (avc1) or one vpcC (vp09), and at most one pasp, btrt and
 * nclx colr. Returns the NAL length size (0 for VP9).
 */
function visualSampleEntry(b: Buffer, stsd: Box, steps: Walk): number {
  if (stsd.dataStart + 8 > stsd.end || b.readUInt32BE(stsd.dataStart) !== 0) fail(); // version 0 and no flags
  if (b.readUInt32BE(stsd.dataStart + 4) !== 1) fail(); // one entry
  const entries = [...boxes(b, stsd.dataStart + 8, stsd.end, steps)];
  if (entries.length !== 1 || (entries[0]!.type !== 'avc1' && entries[0]!.type !== 'vp09')) fail();
  const entry = entries[0]!;
  const at = entry.dataStart;
  if (at + 78 > entry.end) fail();
  const zero = (from: number, to: number) => {
    for (let i = at + from; i < at + to; i++) if (b[i] !== 0) fail();
  };
  zero(0, 6);
  if (b.readUInt16BE(at + 6) !== 1) fail(); // data_reference_index
  // pre_defined, reserved and pre_defined[3]: zeros, but Chromium's recorder writes 1 in the reserved word (QuickTime's
  // revision level), so that word may be 0 or 1
  zero(8, 10);
  if (b.readUInt16BE(at + 10) > 1) fail();
  zero(12, 24);
  if (b.readUInt16BE(at + 24) < 1 || b.readUInt16BE(at + 26) < 1) fail(); // width, height
  if (b.readUInt32BE(at + 28) !== 0x00480000 || b.readUInt32BE(at + 32) !== 0x00480000) fail(); // 72 dpi
  zero(36, 40);
  if (b.readUInt16BE(at + 40) !== 1) fail(); // frame_count
  const name = b[at + 42]!;
  if (name > 31) fail();
  zero(43 + name, 74);
  if (b.readUInt16BE(at + 74) !== 0x0018 || b.readInt16BE(at + 76) !== -1) fail(); // depth, pre_defined
  const kids = children(b, at + 78, entry.end, entry.type, steps, ['avcC', 'vpcC', 'pasp', 'btrt', 'colr'], CLIP_MP4_CHILDREN);
  for (const btrt of kids.get('btrt') ?? []) if (btrt.end - btrt.dataStart !== 12) fail(); // buffer size, max and average bitrate
  for (const pasp of kids.get('pasp') ?? []) {
    if (pasp.end - pasp.dataStart !== 8 || b.readUInt32BE(pasp.dataStart) < 1 || b.readUInt32BE(pasp.dataStart + 4) < 1) fail();
  }
  for (const colr of kids.get('colr') ?? []) {
    // nclx: colour primaries, transfer and matrix, then the full-range bit and seven reserved zero bits
    if (colr.end - colr.dataStart !== 11 || b.toString('latin1', colr.dataStart, colr.dataStart + 4) !== 'nclx' || b[colr.dataStart + 10]! & 0x7f) fail();
  }
  if (entry.type === 'avc1') return avcConfig(b, only(kids, 'avcC'));
  // vpcC: profile 0 to 3, level, a bit depth of 8, 10 or 12 with the chroma and range bits, colour primaries, transfer
  // and matrix, and no codec initialization data, which VP9 never has
  const vpcC = only(kids, 'vpcC');
  exactBox(b, vpcC, VPCC);
  const depth = b[vpcC.dataStart + 6]! >> 4;
  if (b[vpcC.dataStart + 4]! > 3 || ![8, 10, 12].includes(depth) || b.readUInt16BE(vpcC.dataStart + 10) !== 0) fail();
  return 0;
}

/** One trak of a clip, as read so far: what it is, its timing, and the samples its tables and fragments list. */
interface Mp4Track {
  id: number;
  picture: boolean;
  /** Opus sound, or the AAC rate (0 for Opus and for the picture) */
  opus: boolean;
  aacRate: number;
  edits: { delay: number; edit: number; start: number } | undefined;
  scale: number;
  duration: number | null;
  trex: { duration: number; size: number } | undefined;
  /** the media timeline's furthest end, where the last run ended, and the plain sum of sample durations, in ticks */
  ticks: number;
  timeline: number;
  summed: number;
  frames: number;
  bytes: number;
  opusSamples: number;
  /**
   * for sound: where its frames end as decoded, in seconds (moov's from 0, then each fragment run's from where it sits
   * and no earlier than the frames before it end), and each stretch of decoded sound, [from, to), for the edit's check
   */
  heard: number;
  sounds: Array<[number, number]>;
  sample: (at: number, size: number) => void;
}

/**
 * A trak read whole: enabled; an edit list as for a voice note; a nonzero media timescale; a handler of `vide` (with a
 * vmhd) or `soun` (with an smhd, its entry read as a voice note's); one dinf naming this file; and its moov sample
 * table, every chunk inside an mdat. Every sample holds at least one byte, an Opus packet is timed by its TOC byte, and
 * an H.264 sample is its NAL units.
 */
function readTrak(b: Buffer, trak: Box, movieScale: number, media: MediaRanges, ranges: SampleRanges, steps: Walk): Mp4Track {
  const t = children(b, trak.dataStart, trak.end, 'trak', steps, ['tkhd', 'mdia', 'edts'], CLIP_MP4_CHILDREN);
  const tkhd = only(t, 'tkhd');
  if (!(exactBox(b, tkhd, TKHD, TKHD_FLAGS).flags & 0x1)) fail(); // track_enabled
  const edts = t.get('edts')?.[0];
  const edits = edts ? editList(b, edts, steps) : undefined;
  if (edits && movieScale === 0) fail();
  const mdia = only(t, 'mdia');
  const m = children(b, mdia.dataStart, mdia.end, 'mdia', steps, ['mdhd', 'hdlr', 'minf'], CLIP_MP4_CHILDREN);
  const mdhd = timeHeader(b, only(m, 'mdhd'), MDHD);
  if (mdhd.scale === 0) fail();
  const hdlr = only(m, 'hdlr');
  const name = hdlr.dataStart + 24;
  const handler = fullBoxHead(b, hdlr);
  if (handler.version !== 0 || handler.flags !== 0) fail();
  if (hdlr.end - name > HANDLER_NAME_MAX || b.indexOf(0, name) !== hdlr.end - 1) fail();
  const type = b.toString('latin1', hdlr.dataStart + 8, hdlr.dataStart + 12);
  if (type !== 'vide' && type !== 'soun') fail();
  const picture = type === 'vide';
  // the picture is shown: a picture track left out of the movie (track_in_movie clear) plays as sound alone
  if (picture && !(b.readUInt32BE(tkhd.dataStart) & 0x2)) fail();
  const minf = only(m, 'minf');
  const mi = children(b, minf.dataStart, minf.end, 'minf', steps, ['smhd', 'vmhd', 'dinf', 'stbl'], CLIP_MP4_CHILDREN);
  // the media header its handler carries, and not the other one
  if (picture) {
    if (mi.has('smhd') || exactBox(b, only(mi, 'vmhd'), VMHD, 0x1).flags !== 0x1) fail();
  } else {
    if (mi.has('vmhd')) fail();
    exactBox(b, only(mi, 'smhd'), SMHD);
  }
  if (!selfContained(b, only(mi, 'dinf'), steps)) fail();
  const stbl = only(mi, 'stbl');
  const st = children(b, stbl.dataStart, stbl.end, 'stbl', steps, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64'], CLIP_MP4_CHILDREN);
  const nal = picture ? visualSampleEntry(b, only(st, 'stsd'), steps) : 0;
  const sound = picture ? { opus: false, rate: 0 } : audioSampleEntry(b, only(st, 'stsd'), steps);
  const track: Mp4Track = {
    id: trackId(b, tkhd), picture, opus: sound.opus, aacRate: sound.rate, edits, scale: mdhd.scale, duration: mdhd.duration,
    trex: undefined, ticks: 0, timeline: 0, summed: 0, frames: 0, bytes: 0, opusSamples: 0, heard: 0, sounds: [],
    sample: (at, size) => {
      if (size < 1) fail(); // every sample holds at least one byte
      if (track.opus) track.opusSamples += opusPacketSamples(b, at, size);
      if (nal > 0) nalUnits(b, at, size, nal, steps);
    },
  };
  const table = sampleTable(b, stbl, media, ranges, steps, track.sample);
  track.ticks = track.timeline = track.summed = table.ticks;
  track.frames = table.count;
  track.bytes = table.bytes;
  if (!picture) {
    track.heard = decodedSeconds(track, table.count, track.opusSamples);
    if (table.count > 0) track.sounds.push([0, track.heard]);
  }
  return track;
}

/** what `frames` sound frames holding `opusSamples` Opus samples decode to, in seconds: 1,024 samples an AAC frame */
function decodedSeconds(track: Mp4Track, frames: number, opusSamples: number): number {
  return track.opus ? opusSamples / OPUS_RATE : (frames * 1024) / track.aacRate;
}

/**
 * The closing mfra, read whole (ISO 14496-12 §8.8.9-11): at most one tfra for each listed track, version 0 or 1 with no
 * flags, the reserved bits clear, ending exactly at its last entry, every entry pointing at the start of a moof of
 * this file, at a time inside the track's samples; then exactly one mfro, last, giving the mfra's own size.
 */
function frameIndex(b: Buffer, mfra: Box, tracks: Map<number, Mp4Track>, moofs: Set<number>, steps: Walk): void {
  const kids = [...boxes(b, mfra.dataStart, mfra.end, steps)];
  const mfro = kids.pop();
  if (!mfro || mfro.type !== 'mfro') fail();
  exactBox(b, mfro!, MFRO);
  if (b.readUInt32BE(mfro!.dataStart + 4) !== mfra.end - mfra.start) fail();
  const indexed = new Set<number>();
  for (const tfra of kids) {
    if (tfra.type !== 'tfra') fail();
    const { version, flags } = fullBoxHead(b, tfra);
    if (version > 1 || flags !== 0 || tfra.dataStart + 16 > tfra.end) fail();
    const track = tracks.get(b.readUInt32BE(tfra.dataStart + 4));
    if (!track || indexed.has(track.id)) fail();
    indexed.add(track!.id);
    const sizes = b.readUInt32BE(tfra.dataStart + 8);
    if (sizes >>> 6 !== 0) fail(); // reserved
    const widths = [(sizes >> 4) & 3, (sizes >> 2) & 3, sizes & 3].map((w) => w + 1); // traf, trun and sample numbers
    const count = b.readUInt32BE(tfra.dataStart + 12);
    const wide = version === 1 ? 8 : 4;
    const entry = 2 * wide + widths[0]! + widths[1]! + widths[2]!;
    if (tfra.dataStart + 16 + entry * count !== tfra.end) fail();
    for (let i = 0, at = tfra.dataStart + 16; i < count; i++) {
      charge(steps, 1);
      const time = wide === 8 ? u64(b, at) : b.readUInt32BE(at);
      const moof = wide === 8 ? u64(b, at + 8) : b.readUInt32BE(at + 4);
      if (!moofs.has(moof)) fail();
      // an index over the samples, not a length of its own: an entry past where the track's samples end is refused
      if (time > track!.ticks) fail();
      at += entry;
    }
  }
}

function mp4Seconds(b: Buffer): number | null {
  const steps = { n: 0, padding: 0 };
  const all = [...boxes(b, 0, b.length, steps, true)];
  if (all[0]?.type !== 'ftyp' || !clipBrands(b, all[0])) return null;
  for (const x of all) {
    if (!CLIP_MP4_CHILDREN.file!.has(x.type)) return null;
    if (isPadding(x.type)) padding(steps, x.end - x.dataStart);
  }
  if (all.filter((x) => x.type === 'ftyp').length !== 1) return null;
  const moovs = all.filter((x) => x.type === 'moov');
  if (moovs.length !== 1) return null;
  // an mfra only as the file's last box: it indexes the fragments before it
  const mfras = all.filter((x) => x.type === 'mfra');
  if (mfras.length > 1 || (mfras.length === 1 && all[all.length - 1] !== mfras[0])) return null;
  const media: MediaRanges = all.filter((x) => x.type === 'mdat').map((x) => ({ from: x.dataStart, to: x.end }));
  const fragments = all.filter((x) => x.type === 'moof');
  if (media.length > MAX_MEDIA_BOXES || fragments.length > MAX_MEDIA_BOXES) return null;
  const moov = children(b, moovs[0]!.dataStart, moovs[0]!.end, 'moov', steps, ['mvhd', 'mvex'], CLIP_MP4_CHILDREN);
  const movie = timeHeader(b, only(moov, 'mvhd'), MVHD);
  // one picture track and at most one sound track: a third track, or a second picture, is refused
  const traks = moov.get('trak') ?? [];
  const ranges: SampleRanges = []; // every chunk and run of every track, to tile the mdat payloads
  const tracks = new Map<number, Mp4Track>();
  for (const trak of traks) {
    if (tracks.size === 2) return null; // a third track, of any handler
    const track = readTrak(b, trak, movie.scale, media, ranges, steps);
    if (tracks.has(track.id)) return null;
    tracks.set(track.id, track);
  }
  const list = [...tracks.values()];
  // with at most two tracks, exactly one picture leaves at most one sound
  if (list.filter((t) => t.picture).length !== 1) return null;
  let frames = list.reduce((n, t) => n + t.frames, 0); // every track's samples, against the one cap
  if (frames > MAX_SAMPLES) return null;
  let fragmented = 0; // mehd's movie length, in the movie timescale
  for (const mvex of moov.get('mvex') ?? []) {
    const mv = children(b, mvex.dataStart, mvex.end, 'mvex', steps, ['mehd'], CLIP_MP4_CHILDREN);
    for (const mehd of mv.get('mehd') ?? []) {
      const head = exactBox(b, mehd, MEHD);
      fragmented = Math.max(fragmented, head.version === 1 ? u64(b, mehd.dataStart + 4) : b.readUInt32BE(mehd.dataStart + 4));
      if (movie.scale === 0) return null;
    }
    for (const x of mv.get('trex') ?? []) {
      exactBox(b, x, TREX);
      const track = tracks.get(b.readUInt32BE(x.dataStart + 4));
      if (!track || track.trex !== undefined) return null; // defaults for a listed track, once each
      if (b.readUInt32BE(x.dataStart + 8) !== 1) return null; // the one sample entry
      track.trex = { duration: b.readUInt32BE(x.dataStart + 12), size: b.readUInt32BE(x.dataStart + 16) };
    }
  }
  for (const fragment of fragments) {
    const mo = children(b, fragment.dataStart, fragment.end, 'moof', steps, ['mfhd'], CLIP_MP4_CHILDREN);
    exactBox(b, only(mo, 'mfhd'), MFHD);
    let previousEnd: number | undefined; // where the previous traf's data ended, the next one's base by default
    for (const traf of mo.get('traf') ?? []) {
      const tr = children(b, traf.dataStart, traf.end, 'traf', steps, ['tfhd', 'tfdt'], CLIP_MP4_CHILDREN);
      const tfhd = only(tr, 'tfhd');
      const { version, flags } = fullBoxHead(b, tfhd);
      if (version !== 0 || flags & ~TFHD_FLAGS) return null;
      // duration-is-empty says the fragment holds no samples for its time: a track run in it contradicts that
      if (flags & 0x10000 && tr.has('trun')) return null;
      if (tfhd.dataStart + 8 > tfhd.end) fail();
      // a fragment of a listed track, which the movie declares fragments for
      const track = tracks.get(b.readUInt32BE(tfhd.dataStart + 4));
      if (!track || track.trex === undefined) return null;
      for (const tfdt of tr.get('tfdt') ?? []) {
        const time = exactBox(b, tfdt, TFDT);
        track.timeline = time.version === 1 ? u64(b, tfdt.dataStart + 4) : b.readUInt32BE(tfdt.dataStart + 4);
      }
      let at = tfhd.dataStart + 8;
      const field = (width: number) => {
        if (at + width > tfhd.end) fail();
        const value = width === 8 ? u64(b, at) : b.readUInt32BE(at);
        at += width;
        return value;
      };
      const base = flags & 0x1 ? field(8) : flags & 0x20000 ? fragment.start : (previousEnd ?? fragment.start);
      if (flags & 0x2 && field(4) !== 1) return null; // the one sample entry
      const defaults = { duration: flags & 0x8 ? field(4) : track.trex.duration, size: flags & 0x10 ? field(4) : track.trex.size };
      if (flags & 0x20) field(4); // default_sample_flags
      if (at !== tfhd.end) fail();
      let cursor = base;
      for (const trun of tr.get('trun') ?? []) {
        const run = trunRun(b, trun, defaults, MAX_SAMPLES - frames);
        // sound frames are presented in the order they decode (AAC and Opus have no frame reordering), so a sound run
        // presenting one at any other time is refused, as a voice note's is (#1165) and as moov's ctts is; the picture
        // keeps its composition offsets (H.264 may reorder), counted where its latest sample ends as presented
        if (!track.picture && run.shifted) return null;
        frames += run.count;
        track.frames += run.count;
        if (run.dataOffset !== undefined) cursor = base + run.dataOffset;
        if (cursor < 0 || !Number.isSafeInteger(cursor + run.bytes)) fail();
        if (run.bytes > 0) {
          if (!inMedia(media, cursor, run.bytes)) fail();
          ranges.push({ at: cursor, bytes: run.bytes });
        }
        const before = track.opusSamples;
        for (let i = 0, p = cursor; i < run.count; p += run.sizeOf(i), i++) track.sample(p, run.sizeOf(i));
        track.bytes += run.bytes;
        const runStart = track.timeline;
        // a sound run's frames play one after another from its start, no earlier than the frames before it end, and a run
        // with none moves nothing, as a voice note's (#1165: zero-duration frames placed late play past where they sit)
        const decoded = track.picture ? 0 : decodedSeconds(track, run.count, track.opusSamples - before);
        if (decoded > 0) {
          const from = Math.max(runStart / track.scale, track.heard);
          track.heard = from + decoded;
          track.sounds.push([from, track.heard]);
        }
        track.timeline += run.ticks;
        track.summed += run.ticks;
        if (!Number.isSafeInteger(track.timeline) || !Number.isSafeInteger(track.summed)) fail();
        track.ticks = Math.max(track.ticks, track.timeline, runStart + run.reach);
        cursor += run.bytes;
      }
      previousEnd = cursor;
    }
  }
  if (mfras.length === 1) frameIndex(b, mfras[0]!, tracks, new Set(fragments.map((f) => f.start)), steps);
  // a clip has a picture, and no mdat holds a byte that is not some track's sample
  if (!list.some((t) => t.picture && t.bytes > 0) || !tilesMedia(media, ranges)) return null;
  // the sound's media edit plays some of its sound, as a voice note's (#1141, #1165): the media it selects, from its
  // media_time for its duration, overlaps a stretch of decoded frames. A duration of 0 runs to the end only in a movie
  // that declares fragments (ISO/IEC 14496-12 §8.6.6.1: the fragments supply its media); in a plain movie it is an edit
  // of no length, which selects nothing (Codex P2 on #1186). Durations the file states past its frames are silence, so
  // they never count as sound here
  const fragmentable = (moov.get('mvex') ?? []).length > 0;
  for (const t of list) {
    if (t.picture || !t.edits) continue;
    const start = t.edits.start / t.scale;
    if (t.edits.edit === 0 && !fragmentable) return null;
    const end = t.edits.edit > 0 ? start + t.edits.edit / movie.scale : Infinity;
    if (!t.sounds.some(([from, to]) => from < end && to > start)) return null;
  }
  // each track's length as a voice note's is reckoned (the edit list, the media header, the timeline and the summed
  // durations, and for sound what its frames hold), the longest of them, and the movie's own
  let longest = 0;
  for (const t of list) {
    // for sound, where its frames end as decoded: each run's from where it sits, and all of them from 0
    const held = t.picture ? 0 : Math.max(t.heard, decodedSeconds(t, t.frames, t.opusSamples));
    const played = Math.max(
      t.edits ? t.edits.edit / movie.scale : 0,
      t.duration !== null ? t.duration / t.scale : 0,
      Math.max(t.ticks, t.summed) / t.scale,
      held,
    );
    longest = Math.max(longest, (t.edits ? t.edits.delay / movie.scale : 0) + played);
  }
  return Math.max(
    movie.scale > 0 && movie.duration !== null ? movie.duration / movie.scale : 0,
    movie.scale > 0 ? fragmented / movie.scale : 0,
    longest,
  );
}
