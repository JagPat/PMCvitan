/**
 * Stage 1 video on site visits (#995) — tiny hand-built clips for `readVideoClip` and the video upload tests, shaped
 * like what Chrome's MediaRecorder writes from a camera: WebM with a VP8 picture track and an Opus sound track
 * (Segment and Clusters of unknown size, SimpleBlocks), and MP4 with an H.264 picture track and a sound track, plain or
 * fragmented. Built on the voice note's fixtures (`voice-files.ts`), with a few placeholder bytes where the encoded
 * picture and sound would be. Real recordings, from Chromium's MediaRecorder, are in ./recordings.
 */
import {
  OPUS_HEAD, WEBM, box, dinf, ebml, fullBox, ftyp, hdlr, mdhd, mvhd, simpleBlock, stco, stsc, stsd, stsz, stts, tkhd, trak,
  trex, webmCluster, webmClusterAt, webmHeader, webmInfo, webmTrack,
} from './voice-files';

const u16 = (...values: number[]) => {
  const out = Buffer.alloc(2 * values.length);
  values.forEach((v, i) => out.writeUInt16BE(v, 2 * i));
  return out;
};
const u32 = (...values: number[]) => {
  const out = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => out.writeUInt32BE(v >>> 0, 4 * i));
  return out;
};

// ── WebM ─────────────────────────────────────────────────────────────────────────────────────

export const CLIP_WEBM = { video: 0xe0, pixelWidth: 0xb0, pixelHeight: 0xba, colour: 0x55b0, maxBlockAdditionId: 0x55ee, defaultDuration: 0x23e383, blockDuration: 0x9b, blockAdditions: 0x75a1 } as const;
/** a VP8 frame's first bytes (a key frame's tag and start code), standing for the picture */
export const PICTURE_FRAME = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]);
/** a picture's Video element: its width and height, and any further fields */
export const videoElement = (width = 320, height = 240, extra: Buffer[] = []) =>
  ebml(CLIP_WEBM.video, Buffer.concat([ebml(CLIP_WEBM.pixelWidth, u16(width)), ebml(CLIP_WEBM.pixelHeight, u16(height)), ...extra]));
/** a picture TrackEntry as Chrome writes it from a camera: number, type 1, MaxBlockAdditionID, codec, Video */
export const pictureTrack = (n = 1, codec = 'V_VP8', fields: Buffer[] = [videoElement()]) =>
  ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([n])), ebml(WEBM.trackType, Buffer.from([1])),
    ebml(CLIP_WEBM.maxBlockAdditionId, Buffer.from([1])), ebml(WEBM.codecId, codec), ...fields]));
/** the sound track a clip carries: Opus, as a voice note's */
export const soundTrack = (n = 2) => webmTrack(n, 2, 'A_OPUS');
/** a picture SimpleBlock `ms` after its Cluster's Timestamp, with no duration, as Chrome writes them */
export const pictureBlock = (track = 1, ms = 0) => {
  const block = simpleBlock(track, PICTURE_FRAME);
  block.writeInt16BE(ms, block.length - PICTURE_FRAME.length - 3); // the block's timecode, after its track number
  return block;
};

/** a clip as Chrome writes it: a picture track and a sound track, then a Cluster of picture and sound blocks, 33 ms apart */
export const clipWebm = (o: { tracks?: Buffer[]; clusters?: Buffer[]; info?: Buffer; docType?: string } = {}): Buffer =>
  Buffer.concat([
    webmHeader(o.docType ?? 'webm'),
    ebml(WEBM.segment, Buffer.concat([
      o.info ?? webmInfo(),
      ebml(WEBM.tracks, Buffer.concat(o.tracks ?? [pictureTrack(), soundTrack()])),
      ...(o.clusters ?? [webmCluster([pictureBlock(), simpleBlock(2), pictureBlock(1, 33)])]),
    ]), true),
  ]);
/** a clip of `seconds`, as its Info Duration says */
export const clipWebmTimed = (seconds: number) => clipWebm({ info: webmInfo(seconds * 1000) });
/** a picture-only clip, as a camera recording with no microphone */
export const silentClipWebm = () => clipWebm({ tracks: [pictureTrack()], clusters: [webmCluster([pictureBlock(), pictureBlock(1, 33)])] });
export { OPUS_HEAD };

// ── MP4 ──────────────────────────────────────────────────────────────────────────────────────

/** an H.264 sample: one NAL unit (an IDR slice's header and a byte), after its 4-byte length */
export const NAL_SAMPLE = Buffer.from([0, 0, 0, 2, 0x65, 0x88]);
/** an avcC as Chromium writes it for baseline H.264: one SPS, one PPS, 4-byte NAL lengths */
export const AVCC_BODY = Buffer.from([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, 0x01, 0x00, 0x02, 0x68, 0xce]);
export const avcC = (body: Buffer = AVCC_BODY) => box('avcC', body);
/** a vpcC as Chromium writes it: version 1, profile 0, 8-bit 4:2:0, BT.709-ish colour, no initialization data */
export const vpcC = (body = Buffer.from([0, 0, 0x80, 6, 6, 6, 0, 0]), version = 1) => fullBox('vpcC', version, 0, body);
export const pasp = () => box('pasp', u32(1, 1));
export const btrt = () => box('btrt', Buffer.alloc(12));
export const colr = (type = 'nclx', body = Buffer.from([0, 6, 0, 6, 0, 6, 0])) => box('colr', [Buffer.from(type, 'latin1'), body]);

/**
 * A visual sample entry's 78 bytes (ISO 14496-12 §12.1.3), version 0, as Chromium writes them: data_reference_index 1,
 * QuickTime's revision 1 in the reserved word, the size, 72 dpi, one frame a sample, a compressor name, depth 24, -1.
 */
export const visualFields = (o: { width?: number; height?: number; name?: string; revision?: number } = {}) => {
  const out = Buffer.alloc(78);
  out.writeUInt16BE(1, 6);
  out.writeUInt16BE(o.revision ?? 1, 10);
  out.writeUInt16BE(o.width ?? 320, 24);
  out.writeUInt16BE(o.height ?? 240, 26);
  out.writeUInt32BE(0x00480000, 28);
  out.writeUInt32BE(0x00480000, 32);
  out.writeUInt16BE(1, 40);
  const name = o.name ?? 'AVC Coding';
  out[42] = name.length;
  out.write(name, 43, 'latin1');
  out.writeUInt16BE(0x0018, 74);
  out.writeInt16BE(-1, 76);
  return out;
};
/** a picture sample entry: avc1 with its avcC, pasp, btrt and colr as Chromium writes them; vp09 with vpcC */
export const visualEntry = (type = 'avc1', kids?: Buffer[], fields = visualFields()) =>
  box(type, [fields, ...(kids ?? (type === 'vp09' ? [pasp(), btrt(), vpcC(), colr()] : [pasp(), btrt(), avcC(), colr()]))]);

/** a picture trak whose samples sit in one chunk at `offset`, each `delta` ticks long, with `entry` its sample entry */
export const pictureTrak = (id = 1, sizes: number[] = [], offset = 0, o: { entry?: Buffer; duration?: number; delta?: number; vmhd?: Buffer; extra?: Buffer[] } = {}) =>
  box('trak', [tkhd(id), ...(o.extra ?? []), box('mdia', [mdhd(o.duration ?? 0), hdlr('vide'), box('minf', [
    o.vmhd ?? fullBox('vmhd', 0, 1, Buffer.alloc(8)), dinf(),
    box('stbl', [stsd(o.entry ?? visualEntry()), stts(sizes.length, o.delta ?? 1600), stsc(sizes.length), stsz(sizes), stco(sizes.length, offset)]),
  ])])]);

/** a trak of this handler around `table` (its stbl's boxes): the media header its handler carries, one dinf */
export const trakOf = (handler: string, id: number, table: Buffer[], headers = [handler === 'vide' ? VMHD_BOX : SMHD_BOX]) =>
  box('trak', [tkhd(id), box('mdia', [mdhd(), hdlr(handler), box('minf', [...headers, dinf(), box('stbl', table)])])]);
export const VMHD_BOX = fullBox('vmhd', 0, 1, Buffer.alloc(8));
export const SMHD_BOX = fullBox('smhd', 0, 0, u32(0));
/** a sample table of `count` samples of `size` bytes each (stsz's fixed size), `delta` ticks each, in one chunk at `offset` */
export const fixedTable = (entry: Buffer, count: number, size: number, offset: number, delta: number) => [
  fullBox('stsd', 0, 0, [u32(1), entry]), fullBox('stts', 0, 0, u32(1, count, delta)), fullBox('stsc', 0, 0, u32(1, 1, count, 1)),
  fullBox('stsz', 0, 0, u32(size, count)), fullBox('stco', 0, 0, u32(1, offset)),
];

/**
 * A plain clip: ftyp (isom), moov with an H.264 picture track of `pictures` samples and, unless `sound` is false, an
 * AAC sound track of two 4-byte frames, each track in one chunk, then the one mdat holding them.
 */
export const clipMp4 = (o: { pictures?: number; sound?: boolean; brand?: string; duration?: number; entry?: Buffer; sample?: Buffer } = {}): Buffer => {
  const sample = o.sample ?? NAL_SAMPLE;
  const pictures = Array.from({ length: o.pictures ?? 2 }, () => sample);
  const sound = o.sound === false ? [] : [Buffer.alloc(4, 7), Buffer.alloc(4, 7)];
  const head = (offset: number) => Buffer.concat([ftyp(o.brand ?? 'isom'), box('moov', [mvhd(), pictureTrak(1, pictures.map((p) => p.length), offset, { entry: o.entry, duration: o.duration }),
    ...(sound.length ? [trak('soun', 2, sound.map((s) => s.length), offset + pictures.reduce((n, p) => n + p.length, 0))] : [])])]);
  return Buffer.concat([head(head(0).length + 8), box('mdat', [...pictures, ...sound])]);
};

/** a moof holding these trafs, in order */
export const moofOf = (sequence: number, trafs: Buffer[][]) => box('moof', [fullBox('mfhd', 0, 0, u32(sequence)), ...trafs.map((t) => box('traf', t))]);
/** tfhd with default-base-is-moof */
export const tfhdMoof = (trackId: number) => fullBox('tfhd', 0, 0x020000, u32(trackId));
/** trun with a data offset and per-sample durations and sizes */
export const trunTimed = (samples: Array<[duration: number, size: number]>, dataOffset: number) =>
  fullBox('trun', 0, 0x000301, [u32(samples.length, dataOffset), ...samples.map(([d, s]) => u32(d, s))]);

/**
 * A fragmented clip, as Chromium's MP4 recorder writes it: ftyp, a moov with empty tables for the picture (track 1)
 * and Opus sound (track 2) and their trex, then one moof whose two trafs run into one mdat, and (unless `index` is
 * false) a closing mfra with a tfra for the picture pointing at the moof.
 */
export const clipFragmented = (o: { pictures?: number; index?: boolean; mfra?: (moofAt: number) => Buffer } = {}): Buffer => {
  const pictures = Array.from({ length: o.pictures ?? 2 }, () => NAL_SAMPLE);
  const opus = [Buffer.from([0xfc, 0xff, 0xfe]), Buffer.from([0xfc, 0xff, 0xfe])]; // 20 ms each
  const moov = box('moov', [mvhd(), pictureTrak(1, []), soundTrakOpus(2), box('mvex', [trex(1), trex(2)])]);
  const head = Buffer.concat([ftyp('isom'), moov]);
  const trafs = (offset: number) => [
    [tfhdMoof(1), trunTimed(pictures.map((p) => [1600, p.length]), offset)],
    [tfhdMoof(2), trunTimed(opus.map((p) => [960, p.length]), offset + pictures.reduce((n, p) => n + p.length, 0))],
  ];
  const size = moofOf(1, trafs(0)).length;
  const moof = moofOf(1, trafs(size + 8));
  const media = box('mdat', [...pictures, ...opus]);
  const moofAt = head.length;
  const index = o.index === false ? [] : [(o.mfra ?? mfraFor)(moofAt)];
  return Buffer.concat([head, moof, media, ...index]);
};

/** a sound trak (Opus, or AAC with `entry` mp4a) with an empty sample table (its samples are in fragments); `extra` after tkhd */
export const soundTrakOpus = (id: number, extra: Buffer[] = [], entry = 'Opus') =>
  box('trak', [tkhd(id), ...extra, box('mdia', [mdhd(), hdlr('soun'), box('minf', [fullBox('smhd', 0, 0, u32(0)), dinf(),
    box('stbl', [stsd(entry), stts(0), stsc(0), stsz([]), stco(0, 0)])])])]);
/** an edts of one media edit at rate 1: `duration` movie ticks of the media from `mediaTime` (media ticks), version 0 */
export const editOf = (duration: number, mediaTime: number) => box('edts', fullBox('elst', 0, 0, [u32(1, duration, mediaTime), u16(1, 0)]));

/** a tfra (version 1, one-byte numbers) for `trackId` with one entry per moof offset, at time 0 */
export const tfra = (trackId: number, moofs: number[], o: { version?: number; sizes?: number; flags?: number } = {}) => {
  const version = o.version ?? 1;
  const entries = moofs.map((at) => (version === 1 ? Buffer.concat([Buffer.alloc(8), Buffer.from(u32(0, at)), Buffer.from([1, 1, 1])]) : Buffer.concat([u32(0, at), Buffer.from([1, 1, 1])])));
  return fullBox('tfra', version, o.flags ?? 0, [u32(trackId, o.sizes ?? 0, moofs.length), ...entries]);
};
/** an mfra around `kids`, closed by an mfro giving its size (or `size`) */
export const mfra = (kids: Buffer[], size?: number) => {
  const length = 8 + kids.reduce((n, k) => n + k.length, 0) + 16;
  return box('mfra', [...kids, fullBox('mfro', 0, 0, u32(size ?? length))]);
};
/** the mfra Chromium writes: a tfra for the picture track, pointing at the one moof */
export const mfraFor = (moofAt: number) => mfra([tfra(1, [moofAt])]);

// ── The layouts phones record (V2a) ──────────────────────────────────────────────────────────

/** an Opus packet of one 20 ms frame (TOC 0xfc: CELT fullband, 20 ms, code 0) */
export const OPUS_20MS = Buffer.from([0xfc, 0xff, 0xfe]);
const CUES_ID = 0x1c53bb6b;
/** a CuePoint: its CueTime (ms) and one CueTrackPositions of CueTrack and CueClusterPosition, with any other fields */
export const cuePoint = (o: { time?: number; track?: number; cluster: number; extra?: Buffer[]; fields?: Buffer[] }) =>
  ebml(0xbb, Buffer.concat(o.fields ?? [
    ...(o.time !== undefined ? [ebml(0xb3, u32(o.time))] : []),
    ebml(0xb7, Buffer.concat([ebml(0xf7, Buffer.from([o.track ?? 1])), ebml(0xf1, u32(o.cluster)), ...(o.extra ?? [])])),
  ]));
export const cuesOf = (points: Buffer[]) => ebml(CUES_ID, Buffer.concat(points));

/**
 * A clip in the layout Safari records WebM in (WebKit's libwebm writer in file mode, iOS 18.4 and later): a picture
 * track (VP8, with a TrackUID, as libwebm writes it) and an Opus sound track, then a Cluster of known size a second,
 * each holding 30 picture blocks 33 ms apart with no duration and 50 sound blocks of 20 ms; then the Cues, one point a
 * Cluster on the picture track (or `cues` built from the Clusters' positions, from the Segment's data; `first` puts
 * them before the Tracks; `unknown` writes the Clusters with an unknown size).
 */
export const safariClipWebm = (seconds: number, o: { cues?: (clusters: number[]) => Buffer; first?: boolean; tracks?: Buffer[]; unknown?: boolean } = {}): Buffer => {
  const uid = ebml(0x73c5, Buffer.from([0x2a, 0x91, 0x07, 0x3c, 0x5e, 0x11, 0x42]));
  const picture = ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([1])), uid, ebml(WEBM.trackType, Buffer.from([1])),
    ebml(WEBM.codecId, 'V_VP8'), videoElement(640, 480)]));
  const tracks = ebml(WEBM.tracks, Buffer.concat(o.tracks ?? [picture, soundTrack(2)]));
  // `unknown`: Clusters of unknown size, as Chrome writes them, each ending where the next Segment child starts
  const cluster = (ms: number, blocks: Buffer[]) => (o.unknown ? ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, u32(ms)), ...blocks]), true) : webmClusterAt(ms, blocks));
  const clusters = Array.from({ length: seconds }, (_, s) => cluster(s * 1000, [
    ...Array.from({ length: 30 }, (_, i) => pictureBlock(1, i * 33)),
    ...Array.from({ length: 50 }, (_, i) => {
      const block = simpleBlock(2, OPUS_20MS);
      block.writeInt16BE(i * 20, block.length - OPUS_20MS.length - 3);
      return block;
    }),
  ]));
  const cues = o.cues ?? ((at: number[]) => cuesOf(at.map((cluster, s) => cuePoint({ time: s * 1000, cluster }))));
  const head = (lead: number) => Buffer.concat([webmInfo(), ...(o.first ? [cues(positions(lead))] : []), tracks]);
  const positions = (lead: number) => {
    const out: number[] = [];
    let at = webmInfo().length + lead + tracks.length;
    for (const c of clusters) {
      out.push(at);
      at += c.length;
    }
    return out;
  };
  // the Cues' own length moves the Clusters on when they come first; their offsets do not change that length
  const lead = o.first ? cues(positions(0)).length : 0;
  return Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([head(lead), ...clusters, ...(o.first ? [] : [cues(positions(0))])]))]);
};

/** one traf's run: its track, its tfdt (media ticks) when given, its samples' bytes and durations, and any composition offsets */
export interface FragmentRun { track: number; time?: number; data: Buffer[]; durations: number[]; offsets?: number[]; version?: number; sampleFlags?: boolean }
const runOf = (r: FragmentRun, dataOffset: number) => {
  const flags = 0x1 | 0x100 | 0x200 | (r.sampleFlags ? 0x400 : 0) | (r.offsets ? 0x800 : 0);
  // sample flags as an encoder writes them: the first a sync sample, the rest depending on others
  const rows = r.data.map((d, i) => u32(r.durations[i]!, d.length, ...(r.sampleFlags ? [i === 0 ? 0x02000000 : 0x01010000] : []), ...(r.offsets ? [r.offsets[i]!] : [])));
  return fullBox('trun', r.version ?? 0, flags, [u32(r.data.length, dataOffset), ...rows]);
};
/** a moof of one traf a run (tfhd default-base-is-moof, tfdt version 1 when timed, trun), then one mdat of their data */
export const fragmentOf = (sequence: number, runs: FragmentRun[]): Buffer => {
  const trafs = (base: number) => {
    let at = base;
    return runs.map((r) => {
      const traf = [tfhdMoof(r.track), ...(r.time !== undefined ? [fullBox('tfdt', 1, 0, u32(Math.floor(r.time / 2 ** 32), r.time % 2 ** 32))] : []), runOf(r, at)];
      at += r.data.reduce((n, d) => n + d.length, 0);
      return traf;
    });
  };
  const size = moofOf(sequence, trafs(0)).length;
  return Buffer.concat([moofOf(sequence, trafs(size + 8)), box('mdat', runs.flatMap((r) => r.data))]);
};

/**
 * A clip in the fragmented layout Safari's MP4 recorder writes: ftyp (mp42), a moov first with empty tables for the
 * H.264 picture (track 1) and AAC sound (track 2) and their trex, then a moof and mdat a second. Each traf gives its
 * tfdt; the picture's run is 30 samples of 1,600 ticks at 48 kHz with sample flags and version 1 composition offsets
 * (all 0 unless `offsets` gives them), the sound's the second's 1,024-sample AAC frames. `sound` changes each sound run.
 */
export const safariClipMp4 = (seconds: number, o: { offsets?: (s: number) => number[]; sound?: (run: FragmentRun, s: number) => FragmentRun; soundExtra?: Buffer[] } = {}): Buffer => {
  const head = Buffer.concat([ftyp('mp42'), box('moov', [mvhd(), pictureTrak(1, []), soundTrakOpus(2, o.soundExtra ?? [], 'mp4a'), box('mvex', [trex(1), trex(2)])])]);
  const frame = (n: number) => Math.floor((n * 48_000) / 1024); // the AAC frames that start before n seconds
  const fragments = Array.from({ length: seconds }, (_, s) => {
    const sound: FragmentRun = {
      track: 2, time: frame(s) * 1024, data: Array.from({ length: frame(s + 1) - frame(s) }, () => Buffer.alloc(6, 0x21)),
      durations: Array.from({ length: frame(s + 1) - frame(s) }, () => 1024),
    };
    return fragmentOf(s + 1, [
      { track: 1, time: s * 48_000, data: Array.from({ length: 30 }, () => NAL_SAMPLE), durations: Array.from({ length: 30 }, () => 1600),
        offsets: o.offsets?.(s) ?? Array.from({ length: 30 }, () => 0), version: 1, sampleFlags: true },
      o.sound ? o.sound(sound, s) : sound,
    ]);
  });
  return Buffer.concat([head, ...fragments]);
};
