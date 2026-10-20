import { describe, it, expect } from 'vitest';
import { isAudioOnlyRecording } from './voice-container';
import {
  AUDIO_PACKET, blockBody, box, ebml, fragment, ftyp, fullBox, hdlr, lacedBlock, laidOut, mdat, moof, mp4File, mp4Fragmented, mp4HeaderOnly, mp4VideoOnly,
  oggFile, oggHeaderOnly, oggPage, oggPageRaw, oggSeal, oggVideoOnly, VORBIS_COMMENT, VORBIS_ID, VORBIS_SETUP, oggVorbisFile, OPUS_HEAD, OPUS_TAGS, simpleBlock, stco, stsd, stsz, tfhd, THEORA_ID, tkhd, trak, trakAround, trex, trun,
  WEBM, webmCluster, webmFile, webmHeader, webmHeaderOnly, webmTrack, webmVideoOnly,
} from '../../test/unit-support/voice-files';

/**
 * Stage 1 voice (#482, Codex P2s on #1010): only an audio-only recording, with sound in it, in the container its type
 * names passes.
 */
describe('isAudioOnlyRecording', () => {
  const webm = (b: Buffer) => isAudioOnlyRecording('audio/webm', b);
  const ogg = (b: Buffer) => isAudioOnlyRecording('audio/ogg', b);
  const mp4 = (b: Buffer) => isAudioOnlyRecording('audio/mp4', b);

  // what the first check accepted: the container's first bytes and nothing else
  const signatureOnly = {
    webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 1)]),
    ogg: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32, 1)]),
    mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(32, 1)]),
  };

  it('passes a voice recording shaped like each browser\'s', () => {
    expect(webm(webmFile())).toBe(true); // Chrome and Android: unknown-size Segment and Clusters
    expect(webm(webmFile([webmTrack(1, 2, 'A_VORBIS')]))).toBe(true);
    expect(webm(webmFile(undefined, 'webm', [webmCluster(undefined, false)]))).toBe(true); // a sized Cluster
    expect(ogg(oggFile())).toBe(true); // Firefox: OpusHead, OpusTags, audio
    expect(ogg(oggVorbisFile())).toBe(true);
    expect(mp4(mp4File())).toBe(true);
    expect(mp4(mp4Fragmented())).toBe(true); // iOS Safari: empty moov sample table, samples in moof > traf > trun
  });

  it('refuses the container signature alone, which the first check passed', () => {
    expect(webm(signatureOnly.webm)).toBe(false);
    expect(ogg(signatureOnly.ogg)).toBe(false);
    expect(mp4(signatureOnly.mp4)).toBe(false);
  });

  it('refuses headers with no sound after them, which the second check passed (Codex P2 on 56a33db)', () => {
    expect(webm(webmHeaderOnly())).toBe(false);
    expect(ogg(oggHeaderOnly())).toBe(false);
    expect(ogg(Buffer.concat([oggHeaderOnly(), oggPage(0x04, 1, 2, Buffer.alloc(0))]))).toBe(false); // an empty data page
    expect(mp4(mp4HeaderOnly())).toBe(false);
  });

  it('refuses an empty frame, packet or sample, and media data too short for its samples', () => {
    expect(webm(webmFile(undefined, 'webm', [webmCluster([simpleBlock(1, Buffer.alloc(0))])]))).toBe(false);
    expect(ogg(oggFile([Buffer.alloc(0)]))).toBe(false);
    expect(mp4(mp4File(['soun'], 'M4A ', [0, 0]))).toBe(false);
    const head = laidOut((o) => Buffer.concat([ftyp(), box('moov', trak('soun', 1, [4, 4], o))]));
    expect(mp4(Buffer.concat([head, mdat(0)]))).toBe(false); // an empty mdat
    expect(mp4(Buffer.concat([head, mdat(7)]))).toBe(false); // 8 declared, 7 present
    expect(mp4(mp4Fragmented([[0, 0]]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', trex(1))]), fragment(1, (o) => [tfhd(1), trun([4, 4], o)]), mdat(5)]))).toBe(false);
  });

  it('WebM: a block counts only on an audio track, inside a Cluster, and in a BlockGroup too', () => {
    expect(webm(webmFile(undefined, 'webm', [webmCluster([simpleBlock(2)])]))).toBe(false); // no such track
    const group = ebml(WEBM.blockGroup, ebml(WEBM.block, blockBody(1)));
    expect(webm(webmFile(undefined, 'webm', [webmCluster([group])]))).toBe(true);
    expect(webm(webmFile(undefined, 'webm', [webmCluster([ebml(WEBM.blockGroup, ebml(WEBM.block, blockBody(1, Buffer.alloc(0))))])]))).toBe(false);
    // a block sitting in the Segment outside any Cluster is not played
    const stray = Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), simpleBlock()]), true)]);
    expect(webm(stray)).toBe(false);
  });

  it('Ogg: the audio comes after that stream\'s own header packets', () => {
    // OpusHead then one packet only: that packet is where OpusTags belongs, so it is not sound
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x04, 1, 1, AUDIO_PACKET)]))).toBe(false);
    // Vorbis has three header packets
    expect(ogg(oggVorbisFile([]))).toBe(false);
    // the second Opus packet must be OpusTags
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 1, 1, AUDIO_PACKET), oggPage(0x04, 1, 2, AUDIO_PACKET)]))).toBe(false);
    // a packet carried across pages counts once it ends
    const big = Buffer.alloc(600, 9);
    const first = oggPage(0, 1, 2, big.subarray(0, 510)); // two 255s: the packet continues on the next page
    const lacing = first[26]!;
    first[26] = lacing - 1; // drop the closing 0-lace, so the packet runs on
    const cut = oggSeal(Buffer.concat([first.subarray(0, 27 + lacing - 1), first.subarray(27 + lacing)]));
    const rest = oggPage(0x05, 1, 3, big.subarray(510));
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 1, 1, OPUS_TAGS), cut, rest]))).toBe(true);
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 1, 1, OPUS_TAGS), cut]))).toBe(false); // never ends
    // a page for a stream that never began
    expect(ogg(Buffer.concat([oggFile(), oggPage(0x04, 9, 0, AUDIO_PACKET)]))).toBe(false);
  });

  it('MP4: fragments count only for the audio track, with trex and tfhd defaults applied', () => {
    expect(mp4(mp4Fragmented([[4]], 0))).toBe(true);
    const fragmented = (trexSize: number, traf: (o: number) => Buffer[], bytes: number) =>
      Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', trex(1, trexSize))]), fragment(1, traf), mdat(bytes)]);
    const viaTrex = fragmented(4, (o) => [tfhd(1), trun({ count: 2 }, o)], 8);
    expect(mp4(viaTrex)).toBe(true);
    const viaTfhd = fragmented(0, (o) => [tfhd(1, 3), trun({ count: 2 }, o)], 6);
    expect(mp4(viaTfhd)).toBe(true);
    const noSize = fragmented(0, (o) => [tfhd(1), trun({ count: 2 }, o)], 8);
    expect(mp4(noSize)).toBe(false);
    const otherTrack = fragmented(0, (o) => [tfhd(7), trun([4], o)], 4);
    expect(mp4(otherTrack)).toBe(false);
    // a sample count past what its box can hold
    const lying = fullBox('trun', 0, 0x000201, Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 4]));
    expect(mp4(Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', trex(1))]), moof(1, [tfhd(1), lying]), mdat(4)]))).toBe(false);
  });

  it('WebM: a laced block counts only after its whole lace table, every declared frame inside the block (Codex P2 on #1013)', () => {
    const file = (block: Buffer) => webmFile(undefined, 'webm', [webmCluster([block])]);
    const six = Buffer.from([1, 2, 3, 4, 5, 6]);
    // the finding: header, lace count and one Xiph size byte, no frame at all
    expect(webm(file(lacedBlock(1, 1, 2, Buffer.from([3]), Buffer.alloc(0))))).toBe(false);
    expect(webm(file(lacedBlock(1, 1, 2, Buffer.from([3]), six)))).toBe(true); // Xiph: 3, then the 3 left
    expect(webm(file(lacedBlock(1, 1, 2, Buffer.from([255, 1]), Buffer.alloc(258, 1))))).toBe(true); // a 255 runs on: 256, then 2
    expect(webm(file(lacedBlock(1, 1, 2, Buffer.from([10]), six)))).toBe(false); // declared past the block
    expect(webm(file(lacedBlock(1, 1, 2, Buffer.from([0]), six)))).toBe(false); // an empty frame
    expect(webm(file(lacedBlock(1, 1, 2, Buffer.from([255]), Buffer.alloc(0))))).toBe(false); // the table runs off the end
    expect(webm(file(lacedBlock(1, 2, 2, Buffer.alloc(0), six)))).toBe(true); // fixed-size: 3 and 3
    expect(webm(file(lacedBlock(1, 2, 2, Buffer.alloc(0), six.subarray(1))))).toBe(false); // 5 bytes cannot split in two
    // EBML: the first size as a number, then signed differences (0xbf is 0, 0xba is -5)
    expect(webm(file(lacedBlock(1, 3, 3, Buffer.from([0x82, 0xbf]), six)))).toBe(true); // 2, 2, then the 2 left
    expect(webm(file(lacedBlock(1, 3, 3, Buffer.from([0x82, 0xba]), six)))).toBe(false); // 2, then -3
    expect(webm(file(lacedBlock(1, 3, 2, Buffer.from([0x84]), Buffer.alloc(0))))).toBe(false); // a table and no frames
  });

  it('Ogg: a stream\'s pages come in sequence, and a page continues a packet exactly when the one before left it open (Codex P2 on #1013)', () => {
    const heads = Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 1, 1, OPUS_TAGS)]);
    const big = Buffer.alloc(600, 9);
    const a = oggPageRaw(0, 1, 2, [255], big.subarray(0, 255)); // the packet runs on
    const b = (seq: number) => oggPageRaw(0x01, 1, seq, [255], big.subarray(255, 510)); // continued, still open
    const c = (type: number, seq: number) => oggPageRaw(type, 1, seq, [90], big.subarray(510)); // ends it
    expect(ogg(Buffer.concat([heads, a, b(3), c(0x05, 4)]))).toBe(true); // a packet over three pages
    expect(ogg(Buffer.concat([heads, a, c(0x05, 4)]))).toBe(false); // the middle page is missing
    expect(ogg(Buffer.concat([heads, a, c(0x05, 3)]))).toBe(true); // a two-page packet, in sequence
    expect(ogg(Buffer.concat([heads, a, c(0x04, 3)]))).toBe(false); // the next page does not say it continues
    expect(ogg(Buffer.concat([heads, oggPage(0x05, 1, 2, AUDIO_PACKET)]))).toBe(false); // continues nothing
    expect(ogg(Buffer.concat([oggFile(), oggPage(0, 1, 3, AUDIO_PACKET)]))).toBe(false); // a page after the stream's last
    expect(ogg(Buffer.concat([heads, oggPage(0x0c, 1, 2, AUDIO_PACKET)]))).toBe(false); // an undefined header flag
    // a stream count past the cap
    const opened = Array.from({ length: 9 }, (_, i) => oggPage(0x02, 100 + i, 0, OPUS_HEAD));
    expect(ogg(Buffer.concat([...opened, oggPage(0, 100, 1, OPUS_TAGS), oggPage(0x04, 100, 2, AUDIO_PACKET)]))).toBe(false);
  });

  it('MP4: every audio sample range lies inside an mdat, from stsc and stco or co64, or from the fragment base and data_offset (Codex P2 on #1013)', () => {
    const moovFor = (o: number) => Buffer.concat([ftyp(), box('moov', trak('soun', 1, [4, 4], o))]);
    expect(mp4(Buffer.concat([moovFor(0), mdat(64)]))).toBe(false); // the chunk points into ftyp, though an mdat is big enough
    expect(mp4(Buffer.concat([laidOut(moovFor, 8 + 12), mdat(4), mdat(8)]))).toBe(true); // the second mdat holds it
    expect(mp4(Buffer.concat([laidOut((o) => moovFor(o + 1)), mdat(8)]))).toBe(false); // one byte past the payload's end
    // co64: a 64-bit offset is read exactly, and one past what a Number holds is refused, not rounded
    const co64Trak = (offset: bigint) => {
      const at = Buffer.alloc(8);
      at.writeBigUInt64BE(offset);
      return Buffer.concat([ftyp(), box('moov', trakAround('soun', 1, [stsd('mp4a'), fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])),
        fullBox('stsz', 0, 0, Buffer.from([0, 0, 0, 4, 0, 0, 0, 2])), fullBox('co64', 0, 0, Buffer.concat([Buffer.from([0, 0, 0, 1]), at]))]))]);
    };
    const co64At = co64Trak(0n).length + 8;
    expect(mp4(Buffer.concat([co64Trak(BigInt(co64At)), mdat(8)]))).toBe(true);
    expect(mp4(Buffer.concat([co64Trak(2n ** 53n + BigInt(co64At)), mdat(8)]))).toBe(false);
    // stsc must place exactly the samples stsz lists
    const oneOfTwo = (o: number) => Buffer.concat([ftyp(), box('moov', trakAround('soun', 1, [stsd('mp4a'),
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)]))]);
    const twoOfTwo = (o: number) => Buffer.concat([ftyp(), box('moov', trakAround('soun', 1, [stsd('mp4a'),
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)]))]);
    expect(mp4(Buffer.concat([laidOut(twoOfTwo), mdat(8)]))).toBe(true); // the same table, placing both
    expect(mp4(Buffer.concat([laidOut(oneOfTwo), mdat(8)]))).toBe(false);
    // a fragment's run is at its data_offset from the moof: pointing at the moof itself is refused
    const frag = (traf: (o: number) => Buffer[], bytes = 8) =>
      Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', trex(1))]), fragment(1, traf), mdat(bytes)]);
    expect(mp4(frag(() => [tfhd(1), trun([4, 4], 0)], 64))).toBe(false);
    expect(mp4(frag((o) => [tfhd(1), trun([4, 4], o + 1)]))).toBe(false); // runs one byte past the mdat
    expect(mp4(frag(() => [tfhd(1), trun([4, 4], -1)]))).toBe(false); // before the file starts
    // tfhd's base_data_offset is absolute; a run with no data_offset starts at the base
    const head = Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', trex(1))])]);
    const explicit = (base: number) => {
      const at = Buffer.alloc(8);
      at.writeBigUInt64BE(BigInt(base));
      return moof(1, [fullBox('tfhd', 0, 0x01, [Buffer.from([0, 0, 0, 1]), at]), fullBox('trun', 0, 0x200, Buffer.from([0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0, 4]))]);
    };
    const payloadAt = head.length + explicit(0).length + 8;
    expect(mp4(Buffer.concat([head, explicit(payloadAt), mdat(8)]))).toBe(true);
    expect(mp4(Buffer.concat([head, explicit(0), mdat(8)]))).toBe(false);
    // with neither base flag, a second traf's base is where the first traf's data ended
    const twoTrafs = (o: number) => box('moof', [fullBox('mfhd', 0, 0, Buffer.from([0, 0, 0, 1])),
      box('traf', [fullBox('tfhd', 0, 0, Buffer.from([0, 0, 0, 1])), trun([4], o)]),
      box('traf', [fullBox('tfhd', 0, 0, Buffer.from([0, 0, 0, 1])), fullBox('trun', 0, 0x200, Buffer.from([0, 0, 0, 1, 0, 0, 0, 4]))])]);
    const trafsAt = twoTrafs(0).length + 8;
    expect(mp4(Buffer.concat([head, twoTrafs(trafsAt), mdat(8)]))).toBe(true);
    expect(mp4(Buffer.concat([head, twoTrafs(trafsAt), mdat(7)]))).toBe(false); // the second traf runs past the mdat
    // the sample count is capped, so no table makes the check walk or add without bound: 200,001 one-byte samples,
    // with an mdat that holds every one, are refused for their count alone
    const many = 200_001;
    const manyTable = (o: number) => Buffer.concat([ftyp(), box('moov', trakAround('soun', 1, [stsd('mp4a'),
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0x03, 0x0d, 0x41, 0, 0, 0, 1])),
      fullBox('stsz', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0x03, 0x0d, 0x41])), stco(1, o)]))]);
    expect(mp4(Buffer.concat([laidOut(manyTable), mdat(many)]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', trex(1, 1))]), fragment(1, (o) => [tfhd(1), trun({ count: many }, o)]), mdat(many)]))).toBe(false);
  });

  it('refuses a video-only file, and one with a picture track beside the sound, in each container', () => {
    expect(webm(webmVideoOnly())).toBe(false);
    expect(webm(webmFile([webmTrack(1, 2, 'A_OPUS'), webmTrack(2, 1, 'V_VP8')]))).toBe(false);
    expect(ogg(oggVideoOnly())).toBe(false);
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x02, 2, 0, THEORA_ID), oggPage(0, 1, 1, OPUS_TAGS), oggPage(0x04, 1, 2, AUDIO_PACKET)]))).toBe(false);
    expect(mp4(mp4VideoOnly())).toBe(false);
    expect(mp4(mp4File(['soun', 'vide']))).toBe(false);
  });

  it('refuses a file of another container sent under an audio type', () => {
    expect(webm(oggFile())).toBe(false);
    expect(ogg(webmFile())).toBe(false);
    expect(mp4(webmFile())).toBe(false);
    // an HEIC photo is ISO BMFF with ftyp at offset 4, and has no sound track
    expect(mp4(Buffer.concat([ftyp('heic'), box('meta', Buffer.alloc(16)), mdat(8)]))).toBe(false);
    expect(isAudioOnlyRecording('audio/mpeg', mp4File())).toBe(false);
  });

  it('WebM: the DocType is webm, every track says it is audio, and every Tracks is checked wherever it sits', () => {
    expect(webm(webmFile(undefined, 'matroska'))).toBe(false);
    expect(webm(webmFile([ebml(WEBM.trackEntry, ebml(WEBM.trackNumber, Buffer.from([1])))]))).toBe(false); // no TrackType
    expect(webm(webmFile([]))).toBe(false); // no track at all
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, webmCluster(), true)]))).toBe(false); // no Tracks
    // a second Tracks, past an unknown-size Cluster, with a picture track
    const hidden = Buffer.concat([
      webmHeader(),
      ebml(WEBM.segment, Buffer.concat([ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), webmCluster(), ebml(WEBM.tracks, webmTrack(2, 1, 'V_VP8'))]), true),
    ]);
    expect(webm(hidden)).toBe(false);
  });

  it('WebM: only a Segment or a Cluster may be of unknown size, and no element runs past its parent', () => {
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS'), true), true)]))).toBe(false);
    expect(webm(Buffer.concat([ebml(WEBM.header, Buffer.alloc(0), true)]))).toBe(false);
    const good = webmFile();
    expect(webm(good.subarray(0, good.length - 3))).toBe(false); // truncated inside a block
    expect(webm(Buffer.concat([webmHeader(), Buffer.from([0x18, 0x53, 0x80, 0x67, 0x00])]))).toBe(false); // a size with no marker bit
  });

  it('WebM: the walk is capped, so a file of endless empty elements is refused rather than walked', () => {
    const voids = Buffer.alloc(2 * 100_001);
    for (let i = 0; i < voids.length; i += 2) voids[i] = WEBM.void, voids[i + 1] = 0x80;
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), webmCluster(), voids]), true)]))).toBe(false);
  });

  it('Ogg: whole pages to the last byte, and a chained video stream refused', () => {
    expect(ogg(Buffer.concat([oggFile(), Buffer.from('junk')]))).toBe(false);
    const good = oggFile();
    expect(ogg(good.subarray(0, good.length - 1))).toBe(false);
    expect(ogg(Buffer.concat([oggPage(0x00, 1, 0, Buffer.from([1])), oggFile()]))).toBe(false); // data before any stream
    const chained = Buffer.concat([oggPage(0x02, 2, 0, THEORA_ID), oggPage(0, 2, 1, Buffer.from([0x81])), oggPage(0x04, 2, 2, AUDIO_PACKET)]);
    expect(ogg(Buffer.concat([oggFile(), chained]))).toBe(false);
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD.subarray(0, 12)), oggPage(0, 1, 1, OPUS_TAGS), oggPage(0x04, 1, 2, AUDIO_PACKET)]))).toBe(false); // a cut head
  });

  it('MP4: size 0 runs to the end, size 1 is a 64-bit size, and a box smaller than its header or past its parent fails', () => {
    const head = (sizes: number[], mdatHeader = 8) => laidOut((o) => Buffer.concat([ftyp(), box('moov', trak('soun', 1, sizes, o))]), mdatHeader);
    const toEnd = Buffer.concat([head([4, 4]), Buffer.from([0, 0, 0, 0]), Buffer.from('mdat'), Buffer.alloc(16, 7)]);
    expect(mp4(toEnd)).toBe(true);
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(24n, 8);
    expect(mp4(Buffer.concat([head([4, 4], 16), large, Buffer.alloc(8)]))).toBe(true);
    large.writeBigUInt64BE(2n ** 62n, 8);
    expect(mp4(Buffer.concat([head([4, 4], 16), large, Buffer.alloc(8)]))).toBe(false);
    const tiny = Buffer.from([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]); // size 4 < its own 8-byte header
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), tiny, box('moov', trak('soun', 1, [4], o))])), mdat(4)]))).toBe(false);
    const good = mp4File();
    expect(mp4(good.subarray(0, good.length - 2))).toBe(false);
    expect(mp4(Buffer.concat([box('moov', trak('soun', 1, [4])), ftyp(), mdat(4)]))).toBe(false); // ftyp comes first
  });

  it('MP4: every track names its handler, and a short hdlr fails', () => {
    expect(mp4(Buffer.concat([ftyp(), box('moov', box('trak', box('mdia', box('minf')))), mdat(4)]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp(), box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(6))))), mdat(4)]))).toBe(false);
    // one track: even a metadata track beside the sound is refused
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [trak('soun', 1, [4], o), trak('meta', 2, [])])])), mdat(4)]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp(), box('free'), mdat(4)]))).toBe(false); // no moov
  });

  it('MP4: the walk is capped, so a file of endless empty boxes is refused rather than walked', () => {
    const empties = Buffer.concat(Array.from({ length: 100_001 }, () => box('free')));
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), empties, box('moov', trak('soun', 1, [4], o))])), mdat(4)]))).toBe(false);
  });

  // ── Round 2 on #1013: the allow-lists, and proofs on the browser-shaped fixtures ────────────────────────────────

  it('Codex P2s on #1013 round 2: a Tracks inside a Cluster, an Ogg page with a wrong checksum, an auxv track', () => {
    const nested = ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, Buffer.from([0])), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), simpleBlock(1)]));
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, nested, true)]))).toBe(false);
    const corrupt = oggFile();
    corrupt[corrupt.length - 1] ^= 0xff; // the sole audio page's last byte
    expect(ogg(corrupt)).toBe(false);
    expect(mp4(mp4File(['soun', 'auxv']))).toBe(false);
  });

  it('WebM allow-list: one Segment-level Tracks with one audio TrackEntry in A_OPUS or A_VORBIS, and only known elements', () => {
    const segment = (children: Buffer[]) => Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat(children), true)]);
    const tracks = (entries: Buffer[]) => ebml(WEBM.tracks, Buffer.concat(entries));
    const entry = (extra: Buffer[]) =>
      ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([1])), ebml(WEBM.trackType, Buffer.from([2])), ebml(WEBM.codecId, 'A_OPUS'), ...extra]));
    expect(webm(segment([tracks([entry([ebml(0xe1, ebml(0xb5, Buffer.alloc(4)))])]), webmCluster()]))).toBe(true); // an Audio element
    for (const bad of [
      webmFile([webmTrack(1, 2, 'A_OPUS'), webmTrack(2, 2, 'A_OPUS')]), // two audio tracks
      webmFile([webmTrack(1, 0x11, 'S_TEXT/UTF8')]), // subtitles
      webmFile([webmTrack(1, 2, 'A_AAC')]), // a codec a browser does not record voice in
      webmFile([webmTrack(0, 2, 'A_OPUS')]), // track number 0
      segment([tracks([entry([ebml(0xe0, Buffer.alloc(2))])]), webmCluster()]), // a Video element on the audio track
      segment([tracks([entry([ebml(0x6d80, Buffer.alloc(2))])]), webmCluster()]), // ContentEncodings (encryption)
      segment([tracks([entry([ebml(WEBM.trackType, Buffer.from([2]))])]), webmCluster()]), // TrackType twice
      segment([tracks([entry([ebml(0xe1, ebml(0x7d7b, Buffer.alloc(1)))])]), webmCluster()]), // an unknown Audio field
      segment([ebml(0x1941a469, Buffer.alloc(4)), tracks([entry([])]), webmCluster()]), // Attachments
      segment([ebml(0x1043a770, Buffer.alloc(4)), tracks([entry([])]), webmCluster()]), // Chapters
      segment([webmCluster(), tracks([entry([])])]), // the blocks before the track table
      segment([tracks([entry([])]), webmCluster([simpleBlock(), ebml(0x5854, Buffer.alloc(2))], false)]), // SilentTracks
      segment([tracks([entry([])]), webmCluster([ebml(0xaf, Buffer.alloc(4))], false)]), // EncryptedBlock
      segment([tracks([entry([])]), webmCluster([ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), ebml(0x75a1, Buffer.alloc(2))]))])]), // BlockAdditions
      segment([tracks([entry([])]), webmCluster([ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), ebml(WEBM.block, blockBody(1))]))])]), // two Blocks in a group
      segment([tracks([entry([])]), webmCluster([simpleBlock(1), ebml(0x7fff, Buffer.alloc(1))])]), // an unknown element in an unknown-size Cluster
      Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([tracks([entry([])]), webmCluster(undefined, false)])), Buffer.from([0xec, 0x80])]), // after the Segment
      Buffer.concat([ebml(WEBM.header, Buffer.concat([ebml(WEBM.docType, 'webm'), ebml(WEBM.docType, 'webm')])), ebml(WEBM.segment, Buffer.concat([tracks([entry([])]), webmCluster()]), true)]), // two DocTypes
      Buffer.concat([ebml(WEBM.header, Buffer.concat([ebml(WEBM.docType, 'webm'), ebml(0x4fff, Buffer.alloc(1))])), ebml(WEBM.segment, Buffer.concat([tracks([entry([])]), webmCluster()]), true)]), // an unknown header field
    ]) {
      expect(webm(bad)).toBe(false);
    }
  });

  it('Ogg allow-list: one stream, a well-formed Opus or Vorbis identification header alone on its first page', () => {
    const opusHead = (version: number, channels: number) => Buffer.concat([OPUS_HEAD.subarray(0, 8), Buffer.from([version, channels]), OPUS_HEAD.subarray(10)]);
    const withHead = (head: Buffer) => Buffer.concat([oggPage(0x02, 1, 0, head), oggPage(0, 1, 1, OPUS_TAGS), oggPage(0x04, 1, 2, AUDIO_PACKET)]);
    expect(ogg(withHead(opusHead(1, 2)))).toBe(true); // version 0.1, stereo
    expect(ogg(withHead(opusHead(0x10, 1)))).toBe(false); // version 1.0: not one a decoder may read
    expect(ogg(withHead(opusHead(1, 0)))).toBe(false); // no channels
    const vorbis = (edit: (id: Buffer) => void) => {
      const id = Buffer.from(VORBIS_ID);
      edit(id);
      return Buffer.concat([oggPage(0x02, 1, 0, id), oggPage(0, 1, 1, [VORBIS_COMMENT, VORBIS_SETUP]), oggPage(0x04, 1, 2, AUDIO_PACKET)]);
    };
    expect(ogg(vorbis(() => undefined))).toBe(true);
    expect(ogg(vorbis((id) => id.writeUInt32LE(1, 7)))).toBe(false); // Vorbis version 1
    expect(ogg(vorbis((id) => (id[11] = 0)))).toBe(false); // no channels
    expect(ogg(vorbis((id) => id.writeUInt32LE(0, 12)))).toBe(false); // no sample rate
    expect(ogg(vorbis((id) => (id[29] = 0)))).toBe(false); // no framing bit
    const second = (head: Buffer) => Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x02, 2, 0, head), oggPage(0, 1, 1, OPUS_TAGS), oggPage(0x04, 1, 2, AUDIO_PACKET)]);
    for (const bad of [
      second(OPUS_HEAD), // a second voice stream
      second(THEORA_ID), // a picture stream
      second(Buffer.concat([Buffer.from('fishead\0', 'latin1'), Buffer.alloc(56)])), // an Ogg Skeleton stream
      Buffer.concat([oggPage(0x02, 1, 0, Buffer.concat([Buffer.from('Speex   ', 'latin1'), Buffer.alloc(72)])), oggPage(0x04, 1, 1, AUDIO_PACKET)]), // Speex
      Buffer.concat([oggPage(0x02, 1, 0, [OPUS_HEAD, OPUS_TAGS]), oggPage(0x04, 1, 1, AUDIO_PACKET)]), // a first page holding more than the head
      Buffer.concat([oggFile(), oggPage(0x02, 1, 0, OPUS_HEAD)]), // a beginning-of-stream page later on
      Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 2, 1, OPUS_TAGS), oggPage(0x04, 1, 2, AUDIO_PACKET)]), // a page of another serial
    ]) {
      expect(ogg(bad)).toBe(false);
    }
  });

  it('MP4 allow-list: exactly one trak, a soun handler with smhd and one mp4a or Opus entry, and only known boxes', () => {
    for (const handler of ['vide', 'auxv', 'meta', 'text', 'sbtl', 'subt', 'hint', 'soun']) {
      expect(mp4(mp4File(['soun', handler]))).toBe(false); // a second track of any kind
    }
    for (const handler of ['vide', 'auxv', 'meta', 'text', 'hint']) expect(mp4(mp4File([handler]))).toBe(false);
    const withTable = (table: (o: number) => Buffer[], extra: Buffer[] = []) =>
      Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [trakAround('soun', 1, table(o)), ...extra])])), mdat(8)]);
    const rest = (o: number) => [fullBox('stts', 0, 0, Buffer.alloc(4)), fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)];
    expect(mp4(withTable((o) => [stsd('mp4a'), ...rest(o)]))).toBe(true);
    expect(mp4(withTable((o) => [stsd('Opus'), ...rest(o)]))).toBe(true);
    for (const entry of ['avc1', 'enca', 'alac', 'samr', 'mett']) expect(mp4(withTable((o) => [stsd(entry), ...rest(o)]))).toBe(false);
    const twoEntries = fullBox('stsd', 0, 0, [Buffer.from([0, 0, 0, 2]), box('mp4a', Buffer.alloc(28)), box('mp4a', Buffer.alloc(28))]);
    expect(mp4(withTable((o) => [twoEntries, ...rest(o)]))).toBe(false);
    expect(mp4(withTable((o) => [stsd('mp4a'), box('stz2', Buffer.alloc(12)), ...rest(o)]))).toBe(false); // an unlisted table
    expect(mp4(withTable((o) => [stsd('mp4a'), stsz([4, 4]), ...rest(o)]))).toBe(false); // stsz twice
    expect(mp4(withTable((o) => [stsd('mp4a'), ...rest(o)], [box('trex')]))).toBe(false); // a box out of place
    const noSmhd = Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', box('trak', [tkhd(1), box('mdia', [fullBox('mdhd', 0, 0, Buffer.alloc(20)), hdlr('soun'),
      box('minf', [box('stbl', [stsd('mp4a'), ...rest(o)])])])]))])), mdat(8)]);
    expect(mp4(noSmhd)).toBe(false); // no sound media header
    // the samples are in this file: a data reference elsewhere is refused
    const withDinf = (selfContained: number) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', box('trak', [tkhd(1), box('mdia', [fullBox('mdhd', 0, 0, Buffer.alloc(20)), hdlr('soun'),
      box('minf', [fullBox('smhd', 0, 0, Buffer.alloc(4)), box('dinf', fullBox('dref', 0, 0, [Buffer.from([0, 0, 0, 1]), fullBox('url ', 0, selfContained)])), box('stbl', [stsd('mp4a'), ...rest(o)])])])]))])), mdat(8)]);
    expect(mp4(withDinf(1))).toBe(true);
    expect(mp4(withDinf(0))).toBe(false);
    // a box of size 0 runs to the end only as the file's last box
    const innerToEnd = mp4File();
    const at = innerToEnd.indexOf('mvhd', 0, 'latin1') - 4;
    innerToEnd.writeUInt32BE(0, at);
    expect(mp4(innerToEnd)).toBe(false);
    expect(mp4(Buffer.concat([mp4File(), box('meta', Buffer.alloc(8))]))).toBe(false); // a top-level meta (as in HEIC)
    expect(mp4(Buffer.concat([mp4File(), box('uuid', Buffer.alloc(16))]))).toBe(false);
    expect(mp4(Buffer.concat([mp4File(), box('moov')]))).toBe(false); // a second moov
    const frag = (traf: (o: number) => Buffer[], mvex: Buffer[] = [trex(1)]) =>
      Buffer.concat([ftyp('iso5'), box('moov', [trak('soun', 1, []), box('mvex', mvex)]), fragment(1, traf), mdat(8)]);
    expect(mp4(frag((o) => [tfhd(1), trun([4, 4], o)]))).toBe(true);
    expect(mp4(frag((o) => [tfhd(1), trun([4, 4], o)], [trex(1), trex(2)]))).toBe(false); // defaults for a track that is not there
    expect(mp4(frag((o) => [tfhd(1), box('saiz', Buffer.alloc(8)), trun([4, 4], o)]))).toBe(false); // encryption aux info
    expect(mp4(frag((o) => [tfhd(2), trun([4, 4], o)]))).toBe(false); // a fragment of another track
    const flagged = (box_: Buffer, flag: number) => {
      const out = Buffer.from(box_);
      out.writeUInt32BE(out.readUInt32BE(8) | flag, 8);
      return out;
    };
    expect(mp4(frag((o) => [flagged(tfhd(1), 0x40), trun([4, 4], o)]))).toBe(false); // an undefined tfhd flag
    expect(mp4(frag((o) => [tfhd(1), flagged(trun([4, 4], o), 0x2)]))).toBe(false); // an undefined trun flag
  });

  /** the browser-shaped fixtures every proof below runs over */
  const shapes = () => ({
    chromeWebm: { mime: 'audio/webm', file: webmFile() },
    sizedClusterWebm: { mime: 'audio/webm', file: webmFile(undefined, 'webm', [webmCluster(undefined, false)]) },
    firefoxOgg: { mime: 'audio/ogg', file: oggFile() },
    vorbisOgg: { mime: 'audio/ogg', file: oggVorbisFile() },
    plainMp4: { mime: 'audio/mp4', file: mp4File() },
    iosMp4: { mime: 'audio/mp4', file: mp4Fragmented() },
  });

  it('proof: every single-byte change anywhere in an Ogg recording is refused (each page\'s checksum)', () => {
    for (const { file } of [shapes().firefoxOgg, shapes().vorbisOgg]) {
      expect(ogg(file)).toBe(true);
      for (let i = 0; i < file.length; i++) {
        for (const flip of [0x01, 0x80, 0xff]) {
          const changed = Buffer.from(file);
          changed[i] ^= flip;
          expect(ogg(changed), `byte ${i} ^ ${flip}`).toBe(false);
        }
      }
    }
  });

  it('proof: a recording cut short at any byte counts as sound only when a whole frame or sample remains', () => {
    // where the first whole unit of sound ends in each shape: Chrome's first block (its Cluster is of unknown size, so
    // a cut after it leaves a whole file); otherwise the end of the file, or of iOS's first fragment and its mdat
    const firstSound: Record<string, number> = {
      chromeWebm: webmFile().length - simpleBlock().length,
      sizedClusterWebm: shapes().sizedClusterWebm.file.length,
      firefoxOgg: oggFile().length,
      vorbisOgg: oggVorbisFile().length,
      plainMp4: mp4File().length,
      iosMp4: mp4Fragmented([[4, 4]]).length,
    };
    expect(mp4Fragmented().subarray(0, firstSound.iosMp4!).equals(mp4Fragmented([[4, 4]]))).toBe(true);
    for (const [name, { mime, file }] of Object.entries(shapes())) {
      expect(isAudioOnlyRecording(mime, file), name).toBe(true);
      for (let cut = 0; cut < file.length; cut++) {
        if (isAudioOnlyRecording(mime, file.subarray(0, cut))) expect(cut, `${name} cut at ${cut}`).toBeGreaterThanOrEqual(firstSound[name]!);
      }
    }
    // and a cut right after a whole unit is still a recording
    expect(webm(webmFile().subarray(0, firstSound.chromeWebm))).toBe(true);
    expect(mp4(mp4Fragmented().subarray(0, firstSound.iosMp4))).toBe(true);
  });

  it('proof: a picture, subtitle or second track injected into each browser shape is refused', () => {
    const picture = {
      'audio/webm': [webmFile([webmTrack(1, 2, 'A_OPUS'), webmTrack(2, 1, 'V_VP8')]), webmFile([webmTrack(1, 2, 'A_OPUS'), webmTrack(2, 0x11, 'S_TEXT/UTF8')])],
      'audio/ogg': [Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x02, 2, 0, THEORA_ID), oggPage(0, 1, 1, OPUS_TAGS), oggPage(0x04, 1, 2, AUDIO_PACKET)])],
      'audio/mp4': [
        Buffer.concat([ftyp('iso5'), box('moov', [box('mvhd', Buffer.alloc(100)), trak('soun', 1, []), trak('auxv', 2, []), box('mvex', trex(1))]),
          fragment(1, (o) => [tfhd(1), trun([4, 4], o)]), mdat(8)]),
        mp4File(['soun', 'vide']),
      ],
    } as const;
    for (const [mime, files] of Object.entries(picture)) for (const f of files) expect(isAudioOnlyRecording(mime, f), mime).toBe(false);
  });
});

