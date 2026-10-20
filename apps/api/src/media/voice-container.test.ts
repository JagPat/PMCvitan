import { describe, it, expect } from 'vitest';
import { isAudioOnlyRecording } from './voice-container';
import {
  AUDIO_PACKET, blockBody, box, ebml, fragment, ftyp, fullBox, hdlr, lacedBlock, laidOut, mdat, moof, mp4File, mp4Fragmented, mp4HeaderOnly, mp4VideoOnly,
  oggFile, oggHeaderOnly, oggPage, oggPageRaw, oggVideoOnly, oggVorbisFile, OPUS_HEAD, OPUS_TAGS, simpleBlock, stco, stsz, tfhd, THEORA_ID, tkhd, trak, trex, trun,
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
    const cut = Buffer.concat([first.subarray(0, 27 + lacing - 1), first.subarray(27 + lacing)]);
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
      const table = box('stbl', [box('stsd', Buffer.alloc(8)), fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])),
        fullBox('stsz', 0, 0, Buffer.from([0, 0, 0, 4, 0, 0, 0, 2])), fullBox('co64', 0, 0, Buffer.concat([Buffer.from([0, 0, 0, 1]), at]))]);
      return Buffer.concat([ftyp(), box('moov', box('trak', [fullBox('tkhd', 0, 3, [Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), Buffer.alloc(72)]),
        box('mdia', [hdlr('soun'), box('minf', table)])]))]);
    };
    const co64At = co64Trak(0n).length + 8;
    expect(mp4(Buffer.concat([co64Trak(BigInt(co64At)), mdat(8)]))).toBe(true);
    expect(mp4(Buffer.concat([co64Trak(2n ** 53n + BigInt(co64At)), mdat(8)]))).toBe(false);
    // stsc must place exactly the samples stsz lists
    const oneOfTwo = (o: number) => Buffer.concat([ftyp(), box('moov', box('trak', [tkhd(1), box('mdia', [hdlr('soun'), box('minf', box('stbl', [
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)]))])]))]);
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
    const manyTable = (o: number) => Buffer.concat([ftyp(), box('moov', box('trak', [tkhd(1), box('mdia', [hdlr('soun'), box('minf', box('stbl', [
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0x03, 0x0d, 0x41, 0, 0, 0, 1])),
      fullBox('stsz', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0x03, 0x0d, 0x41])), stco(1, o)]))])]))]);
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
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [trak('soun', 1, [4], o), trak('meta', 2, [])])])), mdat(4)]))).toBe(true); // a metadata track carries no picture
    expect(mp4(Buffer.concat([ftyp(), box('free'), mdat(4)]))).toBe(false); // no moov
  });

  it('MP4: the walk is capped, so a file of endless empty boxes is refused rather than walked', () => {
    const empties = Buffer.concat(Array.from({ length: 100_001 }, () => box('free')));
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), empties, box('moov', trak('soun', 1, [4], o))])), mdat(4)]))).toBe(false);
  });
});
