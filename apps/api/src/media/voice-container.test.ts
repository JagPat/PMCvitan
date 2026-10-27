import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { isAudioOnlyRecording, readVoiceRecording, recordingSeconds } from './voice-container';
import {
  AUDIO_PACKET, blockBody, box, ebml, fragment, ftyp, fullBox, hdlr, lacedBlock, laidOut, mdat, mdhd, moof, mp4File, mp4Fragmented, mp4HeaderOnly, mp4VideoOnly,
  oggFile, oggHeaderOnly, oggPage, oggPageRaw, oggSeal, oggVideoOnly, VORBIS_COMMENT, VORBIS_ID, VORBIS_SETUP, oggVorbisFile, OPUS_HEAD, OPUS_TAGS, simpleBlock, stco, stsd, stsz, stts, tfhd, THEORA_ID, tkhd, trak, trakAround, trex, trun,
  WEBM, webmCluster, webmFile, webmHeader, webmHeaderOnly, webmTrack, webmVideoOnly,
  mp4Timed, oggTimed, webmClusterAt, webmInfo, webmTimed, withGranule, OPUS_PRE_SKIP,
  audioEntryFields, audioSpecificConfig, descriptor, dinf, dOps, DOPS_BODY, esds, mvhd, sampleEntry, stsc,
} from '../../test/unit-support/voice-files';
import { webmOf, oggWithTags, opusTags, plainMp4, fragmentedMp4, grow, MB } from '../../test/unit-support/voice-files';

/**
 * Stage 1 voice (#482, Codex P2s on #1010): only an audio-only recording, with sound in it, in the container its type
 * names passes.
 */
const u32be = (n: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
};
/** a moov with its movie header, around these boxes */
const moovBox = (...kids: Buffer[]) => box('moov', [mvhd(), ...kids]);

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
    expect(webm(webmFile(undefined, 'webm', [webmCluster(undefined, false)]))).toBe(true); // a sized Cluster
    expect(ogg(oggFile())).toBe(true); // Firefox: OpusHead, OpusTags, audio
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
    const head = laidOut((o) => Buffer.concat([ftyp(), moovBox(trak('soun', 1, [4, 4], o))]));
    expect(mp4(Buffer.concat([head, mdat(0)]))).toBe(false); // an empty mdat
    expect(mp4(Buffer.concat([head, mdat(7)]))).toBe(false); // 8 declared, 7 present
    expect(mp4(mp4Fragmented([[0, 0]]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1))]), fragment(1, (o) => [tfhd(1), trun([4, 4], o)]), mdat(5)]))).toBe(false);
  });

  it('WebM: a block counts only on an audio track, inside a Cluster, and in a BlockGroup too', () => {
    expect(webm(webmFile(undefined, 'webm', [webmCluster([simpleBlock(2)])]))).toBe(false); // no such track
    const group = ebml(WEBM.blockGroup, ebml(WEBM.block, blockBody(1)));
    expect(webm(webmFile(undefined, 'webm', [webmCluster([group])]))).toBe(true);
    expect(webm(webmFile(undefined, 'webm', [webmCluster([ebml(WEBM.blockGroup, ebml(WEBM.block, blockBody(1, Buffer.alloc(0))))])]))).toBe(false);
    // a block sitting in the Segment outside any Cluster is not played
    const stray = Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), simpleBlock()]), true)]);
    expect(webm(stray)).toBe(false);
  });

  it('Ogg: the audio comes after that stream\'s own header packets', () => {
    // OpusHead then one packet only: that packet is where OpusTags belongs, so it is not sound
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x04, 1, 1, AUDIO_PACKET)]))).toBe(false);
    // Vorbis is refused, headers alone or with audio
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
      Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1, trexSize))]), fragment(1, traf), mdat(bytes)]);
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
    expect(mp4(Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1))]), moof(1, [tfhd(1), lying]), mdat(4)]))).toBe(false);
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
    const moovFor = (o: number) => Buffer.concat([ftyp(), moovBox(trak('soun', 1, [4, 4], o))]);
    expect(mp4(Buffer.concat([moovFor(0), mdat(64)]))).toBe(false); // the chunk points into ftyp, though an mdat is big enough
    expect(mp4(Buffer.concat([laidOut(moovFor, 8 + 8), mdat(0), mdat(8)]))).toBe(true); // the second mdat holds it
    expect(mp4(Buffer.concat([laidOut((o) => moovFor(o + 1)), mdat(8)]))).toBe(false); // one byte past the payload's end
    // co64: a 64-bit offset is read exactly, and one past what a Number holds is refused, not rounded
    const co64Trak = (offset: bigint) => {
      const at = Buffer.alloc(8);
      at.writeBigUInt64BE(offset);
      return Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(2), fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])),
        fullBox('stsz', 0, 0, Buffer.from([0, 0, 0, 4, 0, 0, 0, 2])), fullBox('co64', 0, 0, Buffer.concat([Buffer.from([0, 0, 0, 1]), at]))]))]);
    };
    const co64At = co64Trak(0n).length + 8;
    expect(mp4(Buffer.concat([co64Trak(BigInt(co64At)), mdat(8)]))).toBe(true);
    expect(mp4(Buffer.concat([co64Trak(2n ** 53n + BigInt(co64At)), mdat(8)]))).toBe(false);
    // stsc must place exactly the samples stsz lists
    const oneOfTwo = (o: number) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(2),
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)]))]);
    const twoOfTwo = (o: number) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(2),
      fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)]))]);
    expect(mp4(Buffer.concat([laidOut(twoOfTwo), mdat(8)]))).toBe(true); // the same table, placing both
    expect(mp4(Buffer.concat([laidOut(oneOfTwo), mdat(8)]))).toBe(false);
    // a fragment's run is at its data_offset from the moof: pointing at the moof itself is refused
    const frag = (traf: (o: number) => Buffer[], bytes = 8) =>
      Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1))]), fragment(1, traf), mdat(bytes)]);
    expect(mp4(frag(() => [tfhd(1), trun([4, 4], 0)], 64))).toBe(false);
    expect(mp4(frag((o) => [tfhd(1), trun([4, 4], o + 1)]))).toBe(false); // runs one byte past the mdat
    expect(mp4(frag(() => [tfhd(1), trun([4, 4], -1)]))).toBe(false); // before the file starts
    // tfhd's base_data_offset is absolute; a run with no data_offset starts at the base
    const head = Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1))])]);
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
    // the sample count is capped, so no table makes the check walk or add without bound: 50,001 one-byte samples,
    // with an mdat that holds every one, are refused for their count alone (50,000 pass the count)
    const manyTable = (many: number) => (o: number) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(many),
      fullBox('stsc', 0, 0, Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.from(u32be(many)), Buffer.from([0, 0, 0, 1])])),
      fullBox('stsz', 0, 0, Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(u32be(many))])), stco(1, o)]))]);
    expect(mp4(Buffer.concat([laidOut(manyTable(50_000)), mdat(50_000)]))).toBe(true);
    const many = 50_001;
    expect(mp4(Buffer.concat([laidOut(manyTable(many)), mdat(many)]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1, 1))]), fragment(1, (o) => [tfhd(1), trun({ count: many }, o)]), mdat(many)]))).toBe(false);
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
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), webmCluster()]), true)]))).toBe(false); // no Tracks
    // a second Tracks, past an unknown-size Cluster, with a picture track
    const hidden = Buffer.concat([
      webmHeader(),
      ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), webmCluster(), ebml(WEBM.tracks, webmTrack(2, 1, 'V_VP8'))]), true),
    ]);
    expect(webm(hidden)).toBe(false);
  });

  it('WebM: only a Segment or a Cluster may be of unknown size, and no element runs past its parent', () => {
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS'), true)]), true)]))).toBe(false);
    expect(webm(Buffer.concat([ebml(WEBM.header, Buffer.alloc(0), true)]))).toBe(false);
    const good = webmFile();
    expect(webm(good.subarray(0, good.length - 3))).toBe(false); // truncated inside a block
    expect(webm(Buffer.concat([webmHeader(), Buffer.from([0x18, 0x53, 0x80, 0x67, 0x00])]))).toBe(false); // a size with no marker bit
  });

  it('WebM: the walk is capped, so a file of endless empty elements is refused rather than walked', () => {
    const voids = Buffer.alloc(2 * 100_001);
    for (let i = 0; i < voids.length; i += 2) voids[i] = WEBM.void, voids[i + 1] = 0x80;
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), webmCluster(), voids]), true)]))).toBe(false);
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
    const head = (sizes: number[], mdatHeader = 8) => laidOut((o) => Buffer.concat([ftyp(), moovBox(trak('soun', 1, sizes, o))]), mdatHeader);
    const toEnd = Buffer.concat([head([4, 4]), Buffer.from([0, 0, 0, 0]), Buffer.from('mdat'), Buffer.alloc(8, 7)]);
    expect(mp4(toEnd)).toBe(true);
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(24n, 8);
    expect(mp4(Buffer.concat([head([4, 4], 16), large, Buffer.alloc(8)]))).toBe(true);
    large.writeBigUInt64BE(2n ** 62n, 8);
    expect(mp4(Buffer.concat([head([4, 4], 16), large, Buffer.alloc(8)]))).toBe(false);
    const tiny = Buffer.from([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]); // size 4 < its own 8-byte header
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), tiny, moovBox(trak('soun', 1, [4], o))])), mdat(4)]))).toBe(false);
    const good = mp4File();
    expect(mp4(good.subarray(0, good.length - 2))).toBe(false);
    expect(mp4(Buffer.concat([moovBox(trak('soun', 1, [4])), ftyp(), mdat(4)]))).toBe(false); // ftyp comes first
  });

  it('MP4: every track names its handler, and a short hdlr fails', () => {
    expect(mp4(Buffer.concat([ftyp(), moovBox(box('trak', box('mdia', box('minf')))), mdat(4)]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp(), moovBox(box('trak', box('mdia', box('hdlr', Buffer.alloc(6))))), mdat(4)]))).toBe(false);
    // one track: even a metadata track beside the sound is refused
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [mvhd(), trak('soun', 1, [4], o), trak('meta', 2, [])])])), mdat(4)]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp(), box('free'), mdat(4)]))).toBe(false); // no moov
  });

  it('MP4: the walk is capped, so a file of endless empty boxes is refused rather than walked', () => {
    const empties = Buffer.concat(Array.from({ length: 100_001 }, () => box('free')));
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), empties, moovBox(trak('soun', 1, [4], o))])), mdat(4)]))).toBe(false);
  });

  // ── Round 2 on #1013: the allow-lists, and proofs on the browser-shaped fixtures ────────────────────────────────

  it('Codex P2s on #1013 round 2: a Tracks inside a Cluster, an Ogg page with a wrong checksum, an auxv track', () => {
    const nested = ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, Buffer.from([0])), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), simpleBlock(1)]));
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), nested]), true)]))).toBe(false);
    const corrupt = oggFile();
    corrupt[corrupt.length - 1] ^= 0xff; // the sole audio page's last byte
    expect(ogg(corrupt)).toBe(false);
    expect(mp4(mp4File(['soun', 'auxv']))).toBe(false);
  });

  it('WebM allow-list: one Segment-level Tracks with one audio TrackEntry in A_OPUS, and only known elements', () => {
    const segment = (children: Buffer[]) => Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), ...children]), true)]);
    const tracks = (entries: Buffer[]) => ebml(WEBM.tracks, Buffer.concat(entries));
    const entry = (extra: Buffer[]) =>
      ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([1])), ebml(WEBM.trackType, Buffer.from([2])), ebml(WEBM.codecId, 'A_OPUS'), ebml(WEBM.codecPrivate, OPUS_HEAD), ...extra]));
    expect(webm(segment([tracks([entry([ebml(0xe1, ebml(0xb5, Buffer.alloc(4)))])]), webmCluster()]))).toBe(true); // an Audio element
    for (const bad of [
      webmFile([webmTrack(1, 2, 'A_OPUS'), webmTrack(2, 2, 'A_OPUS')]), // two audio tracks
      webmFile([webmTrack(1, 0x11, 'S_TEXT/UTF8')]), // subtitles
      webmFile([webmTrack(1, 2, 'A_AAC')]), // a codec a browser does not record voice in
      webmFile([webmTrack(1, 2, 'A_VORBIS')]), // Vorbis, which no browser records
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
      Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), tracks([entry([])]), webmCluster(undefined, false)])), Buffer.from([0xec, 0x80])]), // after the Segment
      Buffer.concat([ebml(WEBM.header, Buffer.concat([ebml(WEBM.docType, 'webm'), ebml(WEBM.docType, 'webm')])), ebml(WEBM.segment, Buffer.concat([webmInfo(), tracks([entry([])]), webmCluster()]), true)]), // two DocTypes
      Buffer.concat([ebml(WEBM.header, Buffer.concat([ebml(WEBM.docType, 'webm'), ebml(0x4fff, Buffer.alloc(1))])), ebml(WEBM.segment, Buffer.concat([webmInfo(), tracks([entry([])]), webmCluster()]), true)]), // an unknown header field
    ]) {
      expect(webm(bad)).toBe(false);
    }
  });

  it('Ogg allow-list: one stream, a well-formed OpusHead alone on its first page', () => {
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
    expect(ogg(vorbis(() => undefined))).toBe(false); // a well-formed Vorbis I stream: no browser records it
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
      Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [mvhd(), trakAround('soun', 1, table(o)), ...extra])])), mdat(8)]);
    const rest = (o: number) => [stts(2), fullBox('stsc', 0, 0, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1])), stsz([4, 4]), stco(1, o)];
    expect(mp4(withTable((o) => [stsd('mp4a'), ...rest(o)]))).toBe(true);
    expect(mp4(withTable((o) => [stsd('Opus'), ...rest(o)]))).toBe(true);
    for (const entry of ['avc1', 'enca', 'alac', 'samr', 'mett']) expect(mp4(withTable((o) => [stsd(entry), ...rest(o)]))).toBe(false);
    const twoEntries = fullBox('stsd', 0, 0, [Buffer.from([0, 0, 0, 2]), sampleEntry('mp4a'), sampleEntry('mp4a')]);
    expect(mp4(withTable((o) => [twoEntries, ...rest(o)]))).toBe(false);
    expect(mp4(withTable((o) => [stsd('mp4a'), box('stz2', Buffer.alloc(12)), ...rest(o)]))).toBe(false); // an unlisted table
    expect(mp4(withTable((o) => [stsd('mp4a'), stsz([4, 4]), ...rest(o)]))).toBe(false); // stsz twice
    expect(mp4(withTable((o) => [stsd('mp4a'), ...rest(o)], [box('trex')]))).toBe(false); // a box out of place
    const noSmhd = Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(box('trak', [tkhd(1), box('mdia', [mdhd(), hdlr('soun'),
      box('minf', [dinf(), box('stbl', [stsd('mp4a'), ...rest(o)])])])]))])), mdat(8)]);
    expect(mp4(noSmhd)).toBe(false); // no sound media header
    // the samples are in this file: a data reference elsewhere is refused
    const withDinf = (selfContained: number) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(box('trak', [tkhd(1), box('mdia', [mdhd(), hdlr('soun'),
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
      Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', mvex)]), fragment(1, traf), mdat(8)]);
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
    plainMp4: { mime: 'audio/mp4', file: mp4File() },
    iosMp4: { mime: 'audio/mp4', file: mp4Fragmented() },
  });

  it('proof: every single-byte change anywhere in an Ogg recording is refused (each page\'s checksum)', () => {
    for (const { file } of [shapes().firefoxOgg]) {
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
        Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), trak('auxv', 2, []), box('mvex', trex(1))]),
          fragment(1, (o) => [tfhd(1), trun([4, 4], o)]), mdat(8)]),
        mp4File(['soun', 'vide']),
      ],
    } as const;
    for (const [mime, files] of Object.entries(picture)) for (const f of files) expect(isAudioOnlyRecording(mime, f), mime).toBe(false);
  });
});

/**
 * Codex on #1013 round 3 (#1019): the mdat search is a binary search behind caps, the WebM track is enabled and
 * default, every sample names the one sample entry, fragments need the movie's trex, OpusHead is family 0 mono or
 * stereo, and ftyp names only MP4 audio brands.
 */
describe('isAudioOnlyRecording, Codex round 3 on #1013 (#1019)', () => {
  const webm = (b: Buffer) => isAudioOnlyRecording('audio/webm', b);
  const ogg = (b: Buffer) => isAudioOnlyRecording('audio/ogg', b);
  const mp4 = (b: Buffer) => isAudioOnlyRecording('audio/mp4', b);

  /** an MP4 with `mdats - 1` empty mdat boxes, then one holding `chunks` one-byte chunks, each its own chunk */
  const manyMdats = (mdats: number, chunks: number) => {
    const head = (o: number) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(chunks),
      fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(1), u32be(1)]), fullBox('stsz', 0, 0, [u32be(1), u32be(chunks)]),
      fullBox('stco', 0, 0, [u32be(chunks), ...Array.from({ length: chunks }, (_, c) => u32be(o + c))])]))]);
    const payloadAt = head(0).length + 8 * (mdats - 1) + 8;
    return Buffer.concat([head(payloadAt), ...Array.from({ length: mdats - 1 }, () => mdat(0)), mdat(chunks)]);
  };

  it('P1: many mdat boxes and chunks cost a binary search each, and past the caps are refused at once', () => {
    // the old worst case: every chunk scanned every mdat (10,000 x 49,000 comparisons); now a logarithm per chunk
    // timed as a ratio against the same chunks in one mdat, the fastest of three runs each, not against the clock: on
    // 9f5f03e's scan the many-mdat file took over 50 times as long; a binary search keeps it within a few times
    const fastest = (run: () => void) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        run();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const one = manyMdats(1, 49_000);
    const wide = manyMdats(10_000, 49_000);
    expect(mp4(one)).toBe(true);
    expect(mp4(wide)).toBe(true);
    expect(fastest(() => mp4(wide))).toBeLessThan(10 * fastest(() => mp4(one)));
    // past the caps (10,000 mdat boxes, 50,000 samples) the file is refused before any chunk is walked: without the
    // mdat cap this file (40,000 samples) would pass
    expect(mp4(manyMdats(40_000, 40_000))).toBe(false);
    expect(mp4(manyMdats(2, 50_001))).toBe(false);
  });

  it('P2: a WebM track is enabled and default when those flags are written, and its other flags are booleans', () => {
    const trackWith = (...extra: Buffer[]) => ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([1])), ebml(WEBM.trackType, Buffer.from([2])), ebml(WEBM.codecId, 'A_OPUS'),
      ...(extra.some((e) => e.readUInt16BE(0) === WEBM.codecPrivate) ? [] : [ebml(WEBM.codecPrivate, OPUS_HEAD)]), ...extra]));
    const flag = (id: number, value: number) => ebml(id, Buffer.from([value]));
    expect(webm(webmFile([trackWith(flag(0xb9, 1), flag(0x88, 1), flag(0x55aa, 0), flag(0x9c, 1))]))).toBe(true);
    expect(webm(webmFile([trackWith(flag(0x55aa, 1), flag(0x9c, 0))]))).toBe(true);
    expect(webm(webmFile([trackWith(flag(0xb9, 0))]))).toBe(false); // disabled
    expect(webm(webmFile([trackWith(flag(0x88, 0))]))).toBe(false); // not the default track
    expect(webm(webmFile([trackWith(flag(0x55aa, 2))]))).toBe(false);
    expect(webm(webmFile([trackWith(flag(0x9c, 2))]))).toBe(false);
    // an Opus track's CodecPrivate is the same OpusHead an Ogg file must open with
    const family1 = Buffer.from(OPUS_HEAD);
    family1[18] = 1;
    expect(webm(webmFile([trackWith(ebml(0x63a2, family1))]))).toBe(false);
  });

  it('P2: OpusHead is exactly the 19-byte family-0 header of a mono or stereo recording', () => {
    const withHead = (head: Buffer) => Buffer.concat([oggPage(0x02, 1, 0, head), oggPage(0x00, 1, 1, OPUS_TAGS), oggPage(0x04, 1, 2, [AUDIO_PACKET])]);
    const edit = (at: number, value: number) => {
      const out = Buffer.from(OPUS_HEAD);
      out[at] = value;
      return out;
    };
    expect(ogg(withHead(OPUS_HEAD))).toBe(true);
    expect(ogg(withHead(edit(9, 2)))).toBe(true); // stereo
    expect(ogg(withHead(edit(9, 3)))).toBe(false); // three channels in family 0, which defines one or two
    expect(ogg(withHead(edit(9, 0)))).toBe(false);
    // family 1, with its stream counts and mapping table: browsers record family 0, so it is refused
    expect(ogg(withHead(Buffer.concat([edit(18, 1), Buffer.from([1, 0, 0])])))).toBe(false);
    expect(ogg(withHead(Buffer.concat([OPUS_HEAD, Buffer.from([0])])))).toBe(false); // longer than the header
    expect(ogg(withHead(edit(8, 0x10)))).toBe(false); // version 1.x
  });

  it('P2: every stsc run, tfhd and trex names the one sample entry stsd lists', () => {
    const withEntry = (entry: number) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(2),
      fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(2), u32be(entry)]), stsz([4, 4]), stco(1, o)]))])), mdat(8)]);
    expect(mp4(withEntry(1))).toBe(true);
    expect(mp4(withEntry(0))).toBe(false);
    expect(mp4(withEntry(2))).toBe(false);
    const frag = (tfhdBox: Buffer, trexBox = trex(1)) =>
      Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trexBox)]), fragment(1, (o) => [tfhdBox, trun([4, 4], o)]), mdat(8)]);
    expect(mp4(frag(fullBox('tfhd', 0, 0x020002, [u32be(1), u32be(1)])))).toBe(true);
    expect(mp4(frag(fullBox('tfhd', 0, 0x020002, [u32be(1), u32be(2)])))).toBe(false);
    expect(mp4(frag(tfhd(1), fullBox('trex', 0, 0, [u32be(1), u32be(2), u32be(0), u32be(0), u32be(0)])))).toBe(false);
  });

  it('P2: fragments count only when the movie declares them, with mvex holding the track\'s trex', () => {
    const withMvex = (mvex: Buffer[]) =>
      Buffer.concat([ftyp('iso5'), box('moov', [mvhd(), trak('soun', 1, []), ...mvex]), fragment(1, (o) => [tfhd(1), trun([4, 4], o)]), mdat(8)]);
    expect(mp4(withMvex([box('mvex', trex(1))]))).toBe(true);
    expect(mp4(withMvex([]))).toBe(false); // no mvex: an unfragmented movie with no samples
    expect(mp4(withMvex([box('mvex', fullBox('mehd', 0, 0, u32be(0)))]))).toBe(false); // mvex without the trex
  });

  it('P2: ftyp is whole and names only MP4 audio brands, as major and as compatible brands', () => {
    const withFtyp = (payload: Buffer) => Buffer.concat([laidOut((o) => Buffer.concat([box('ftyp', payload), box('moov', [mvhd(), trak('soun', 1, [4, 4], o)])])), mdat(8)]);
    const brands = (major: string, ...compatible: string[]) => Buffer.concat([Buffer.from(major, 'latin1'), Buffer.alloc(4), ...compatible.map((c) => Buffer.from(c, 'latin1'))]);
    for (const ok of [brands('M4A ', 'M4A ', 'isom'), brands('iso5', 'iso5', 'iso6', 'mp41'), brands('isom', 'isom', 'avc1'), brands('mp42'), brands('dash', 'iso6', 'cmfc')]) {
      expect(mp4(withFtyp(ok)), ok.toString('latin1')).toBe(true);
    }
    for (const bad of [brands('heic', 'mif1', 'heic'), brands('qt  ', 'qt  '), brands('M4A ', 'heic'), brands('mif1', 'isom'), brands('xxxx', 'isom'), brands('avc1', 'isom'), brands('M4V ', 'isom')]) {
      expect(mp4(withFtyp(bad)), bad.toString('latin1')).toBe(false);
    }
    expect(mp4(withFtyp(Buffer.concat([brands('M4A ', 'isom'), Buffer.from([0, 0])])))).toBe(false); // a part-brand
    expect(mp4(withFtyp(Buffer.from('M4A ', 'latin1')))).toBe(false); // no minor version
  });
});

/** Codex P2 on #1013 round 3 (#1019): the length is read from the file, never taken from the request. */
describe('readVoiceRecording — the length is the file\'s own', () => {
  const seconds = (mime: string, b: Buffer) => recordingSeconds(mime, b);
  const many = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

  it('WebM: the longest of Info Duration, where the last block ends and the Opus frames', () => {
    expect(seconds('audio/webm', webmTimed(42))).toBe(42);
    // Chrome writes no Duration: a 20 ms block at 42 s ends at 42.02 s (Codex P2 on #1025 round 2: where it ends, not starts)
    expect(seconds('audio/webm', webmFile(undefined, 'webm', [webmCluster(), webmClusterAt(42_000)]))).toBeCloseTo(42.02, 6);
    expect(seconds('audio/webm', webmFile(undefined, 'webm', [webmClusterAt(200_000)], webmInfo(1000)))).toBeCloseTo(200.02, 6); // a short Duration
    // 7,000 20 ms frames, all stamped 0, with Info saying one second: the frames make 140 s
    expect(seconds('audio/webm', webmFile(undefined, 'webm', [webmCluster(many(7000, () => simpleBlock()))], webmInfo(1000)))).toBe(140);
    // a block in a Cluster with no Timestamp, a block before it, and a second Timestamp, are refused
    expect(seconds('audio/webm', webmFile(undefined, 'webm', [ebml(WEBM.cluster, simpleBlock(), true)]))).toBe(null);
    expect(seconds('audio/webm', webmFile(undefined, 'webm', [ebml(WEBM.cluster, Buffer.concat([simpleBlock(), ebml(WEBM.timestamp, Buffer.from([0]))]), true)]))).toBe(null);
    expect(seconds('audio/webm', webmFile(undefined, 'webm', [ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, Buffer.from([0])), ebml(WEBM.timestamp, Buffer.from([1])), simpleBlock()]), true)]))).toBe(null);
  });

  it('Ogg: the last granule less the pre-skip, never less than the Opus packets hold, and the last page must carry one', () => {
    expect(seconds('audio/ogg', oggTimed(42))).toBe(42);
    const pages = (granules: bigint[], perPage = 250, packets = 7000) => {
      const out = [oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x00, 1, 1, OPUS_TAGS)];
      const count = Math.ceil(packets / perPage);
      for (let p = 0; p < count; p++) {
        const page = oggPage(p === count - 1 ? 0x04 : 0x00, 1, 2 + p, many(Math.min(perPage, packets - p * perPage), () => AUDIO_PACKET));
        out.push(withGranule(page, granules[p] ?? granules[granules.length - 1]!));
      }
      return Buffer.concat(out);
    };
    // 7,000 20 ms packets with every granule at 0: the packets make 140 s
    expect(seconds('audio/ogg', pages([0n]))).toBe(140);
    expect(seconds('audio/ogg', pages([96_000n, 48_000n], 250, 500))).toBe(null); // a granule that goes back
    expect(seconds('audio/ogg', pages([0n, -1n], 250, 500))).toBe(null); // the last page carries no granule
    // Vorbis, whose length would come from its granule alone, is refused
    const vorbis = Buffer.concat([oggPage(0x02, 1, 0, VORBIS_ID), oggPage(0x00, 1, 1, [VORBIS_COMMENT, VORBIS_SETUP]), withGranule(oggPage(0x04, 1, 2, [AUDIO_PACKET]), 48_000n * 42n)]);
    expect(seconds('audio/ogg', vorbis)).toBe(null);
    expect(OPUS_PRE_SKIP).toBe(OPUS_HEAD.readUInt16LE(10));
  });

  it('MP4: the longest of mvhd, mdhd, the sample durations and the AAC or Opus frames; no media timescale is refused', () => {
    expect(seconds('audio/mp4', mp4Timed(42))).toBe(42);
    const movie = mp4File();
    const mvhdAt = movie.indexOf('mvhd', 0, 'latin1') + 4;
    movie.writeUInt32BE(1000, mvhdAt + 12);
    movie.writeUInt32BE(42_000, mvhdAt + 16);
    expect(seconds('audio/mp4', movie)).toBe(42);
    // the trex default duration, and per-sample trun durations, in 48 kHz media ticks
    const frag = (trexDuration: number, run: (o: number) => Buffer) => Buffer.concat([ftyp('iso5'),
      box('moov', [mvhd(), trak('soun', 1, []), box('mvex', fullBox('trex', 0, 0, [u32be(1), u32be(1), u32be(trexDuration), u32be(0), u32be(0)]))]),
      fragment(1, (o) => [tfhd(1), run(o)]), mdat(8)]);
    expect(seconds('audio/mp4', frag(48_000, (o) => trun([4, 4], o)))).toBe(2);
    expect(seconds('audio/mp4', frag(0, (o) => fullBox('trun', 0, 0x000301, [u32be(2), u32be(o), u32be(48_000), u32be(4), u32be(96_000), u32be(4)])))).toBe(3);
    // 6,000 AAC frames at 48 kHz whose stts claims one tick each: the frames make 128 s
    const aac = Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'),
      stts(6000, 1), fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(6000), u32be(1)]), fullBox('stsz', 0, 0, [u32be(1), u32be(6000)]), stco(1, o)]))])), mdat(6000)]);
    expect(seconds('audio/mp4', aac)).toBe(128);
    // stts must time exactly the samples stsz lists
    const untimed = Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(1),
      fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(2), u32be(1)]), stsz([4, 4]), stco(1, o)]))])), mdat(8)]);
    expect(seconds('audio/mp4', untimed)).toBe(null);
    // a media header with no timescale: no length can be read
    const noScale = mp4File();
    noScale.writeUInt32BE(0, noScale.indexOf('mdhd', 0, 'latin1') + 4 + 12);
    expect(seconds('audio/mp4', noScale)).toBe(null);
  });
});


/**
 * The review of the #1013 replacement (on 03fba09): every MP4 sample entry is read whole (esds or dOps), no Vorbis, no
 * recording of no time, an edit list only in a form that cannot repeat the media, tkhd's enabled flag, and nothing but
 * padding passed over unread; and real recordings from Chromium's MediaRecorder pass.
 */
describe('isAudioOnlyRecording, review of the #1013 replacement', () => {
  const webm = (b: Buffer) => isAudioOnlyRecording('audio/webm', b);
  const ogg = (b: Buffer) => isAudioOnlyRecording('audio/ogg', b);
  const mp4 = (b: Buffer) => isAudioOnlyRecording('audio/mp4', b);
  const seconds = (mime: string, b: Buffer) => recordingSeconds(mime, b);
  const recording = (name: string) => readFileSync(join(__dirname, '..', '..', 'test', 'unit-support', 'recordings', name));

  /** a plain MP4 whose one track's stsd holds `entry`, with two 4-byte samples in one chunk */
  const withEntry = (entry: Buffer) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd(entry), stts(2),
    fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(2), u32be(1)]), stsz([4, 4]), stco(1, o)]))])), mdat(8)]);
  const aac = (fields: Buffer, ...kids: Buffer[]) => box('mp4a', [fields, ...kids]);
  const opus = (...kids: Buffer[]) => box('Opus', [audioEntryFields(), ...kids]);
  const fields = (edit: (f: Buffer) => void) => {
    const out = audioEntryFields();
    edit(out);
    return out;
  };
  /** an esds whose ES_Descriptor flags, decoder config bytes and trailing descriptors are given */
  const esdsWith = ({ esFlags = 0, objectType = 0x40, streamType = 0x15, config = audioSpecificConfig(), after = [descriptor(0x06, Buffer.from([0x02]))], inConfig = [] as Buffer[], version = 0 }) =>
    fullBox('esds', version, 0, descriptor(0x03, [Buffer.from([0, 1, esFlags]),
      descriptor(0x04, [Buffer.from([objectType, streamType, 0, 0, 0, 0, 0, 0x7d, 0, 0, 0, 0x7d, 0]), descriptor(0x05, config), ...inConfig]), ...after]));
  const asc = (bits: number) => {
    const out = Buffer.alloc(2);
    out.writeUInt16BE(bits);
    return out;
  };

  it('MP4: an mp4a entry holds one esds of AAC-LC at the entry\'s own rate, read whole', () => {
    expect(mp4(withEntry(aac(audioEntryFields(), esds())))).toBe(true);
    expect(mp4(withEntry(aac(audioEntryFields(44_100), esds(audioSpecificConfig(44_100, 2)))))).toBe(true); // 44.1 kHz stereo
    expect(mp4(withEntry(aac(audioEntryFields(), esds(undefined, 4))))).toBe(true); // descriptor sizes padded to four bytes
    expect(mp4(withEntry(aac(audioEntryFields(), box('btrt', Buffer.alloc(12)), esds())))).toBe(true);
    expect(mp4(withEntry(aac(audioEntryFields(), esdsWith({ after: [] }))))).toBe(true); // no SLConfig
    // the frames' length is at the esds rate: two 1,024-sample frames at 44.1 kHz
    expect(seconds('audio/mp4', withEntry(aac(audioEntryFields(44_100), esds(audioSpecificConfig(44_100)))))).toBeCloseTo(2048 / 44_100, 9);
    for (const [why, bad] of [
      ['no esds (03fba09\'s fixture entry, which read as 0 s)', box('mp4a', Buffer.alloc(28))],
      ['no esds, with a valid entry rate', aac(audioEntryFields())],
      ['an entry rate of 0', aac(audioEntryFields(0), esds())],
      ['an entry rate the esds does not give', aac(audioEntryFields(44_100), esds())],
      ['HE-AAC (object type 5)', aac(audioEntryFields(), esds(audioSpecificConfig(48_000, 1, 5)))],
      ['AAC Main (object type 1)', aac(audioEntryFields(), esds(audioSpecificConfig(48_000, 1, 1)))],
      ['no channels', aac(audioEntryFields(), esds(audioSpecificConfig(48_000, 0)))],
      ['three channels', aac(audioEntryFields(), esds(audioSpecificConfig(48_000, 3)))],
      ['a reserved rate index (13)', aac(audioEntryFields(), esds(asc((2 << 11) | (13 << 7) | (1 << 3))))],
      ['an explicit rate (index 15)', aac(audioEntryFields(), esds(asc((2 << 11) | (15 << 7) | (1 << 3))))],
      ['960-sample frames', aac(audioEntryFields(), esds(asc(audioSpecificConfig().readUInt16BE(0) | 0x4)))],
      ['a core coder', aac(audioEntryFields(), esds(asc(audioSpecificConfig().readUInt16BE(0) | 0x2)))],
      ['an extension flag', aac(audioEntryFields(), esds(asc(audioSpecificConfig().readUInt16BE(0) | 0x1)))],
      ['a longer AudioSpecificConfig', aac(audioEntryFields(), esds(Buffer.concat([audioSpecificConfig(), Buffer.from([0x56, 0xe5, 0])])))],
      ['two esds', aac(audioEntryFields(), esds(), esds())],
      ['an unknown box in the entry', aac(audioEntryFields(), esds(), box('chan', Buffer.alloc(12)))],
      ['a dOps in an mp4a', aac(audioEntryFields(), dOps())],
      ['a short btrt', aac(audioEntryFields(), box('btrt', Buffer.alloc(8)), esds())],
      ['two btrt', aac(audioEntryFields(), box('btrt', Buffer.alloc(12)), box('btrt', Buffer.alloc(12)), esds())],
      ['bytes after the ES_Descriptor', aac(audioEntryFields(), box('esds', [esds().subarray(8), Buffer.from([0])]))],
      ['entry version 1', aac(fields((f) => f.writeUInt16BE(1, 8)), esds())],
      ['a second data reference', aac(fields((f) => f.writeUInt16BE(2, 6)), esds())],
      ['esds version 1', aac(audioEntryFields(), esdsWith({ version: 1 }))],
      ['a stream dependence', aac(audioEntryFields(), esdsWith({ esFlags: 0x80 }))],
      ['a URL stream', aac(audioEntryFields(), esdsWith({ esFlags: 0x40 }))],
      ['MP3 (object type 0x6b)', aac(audioEntryFields(), esdsWith({ objectType: 0x6b }))],
      ['a visual stream (type 4)', aac(audioEntryFields(), esdsWith({ streamType: 0x11 }))],
      ['an upstream', aac(audioEntryFields(), esdsWith({ streamType: 0x17 }))],
      ['a descriptor after the decoder info', aac(audioEntryFields(), esdsWith({ inConfig: [descriptor(0x14, Buffer.from([1]))] }))],
      ['SLConfig other than predefined 2', aac(audioEntryFields(), esdsWith({ after: [descriptor(0x06, Buffer.from([0x00]))] }))],
      ['a descriptor after SLConfig', aac(audioEntryFields(), esdsWith({ after: [descriptor(0x06, Buffer.from([0x02])), descriptor(0x0e, Buffer.from([0, 0]))] }))],
      ['a descriptor size past the box', aac(audioEntryFields(), fullBox('esds', 0, 0, Buffer.from([0x03, 0x7f, 0, 1, 0])))],
    ] as const) {
      expect(mp4(withEntry(bad)), why).toBe(false);
    }
  });

  it('MP4: an Opus entry holds one 11-byte dOps of a family-0 mono or stereo recording', () => {
    expect(mp4(withEntry(opus(dOps())))).toBe(true);
    expect(mp4(withEntry(opus(box('btrt', Buffer.alloc(12)), dOps())))).toBe(true);
    const body = (at: number, value: number) => {
      const out = Buffer.from(DOPS_BODY);
      out[at] = value;
      return out;
    };
    expect(mp4(withEntry(opus(dOps(body(1, 2)))))).toBe(true); // stereo
    // the length counts each Opus packet's frames: the fixture's two packets (TOC 0x07, code 3) hold seven 10 ms frames each
    expect(seconds('audio/mp4', withEntry(opus(dOps())))).toBeCloseTo((2 * 7 * 480) / 48_000, 9);
    for (const [why, bad] of [
      ['no dOps', opus()],
      ['two dOps', opus(dOps(), dOps())],
      ['an esds in an Opus entry', opus(esds())],
      ['version 1', opus(dOps(body(0, 1)))],
      ['no channels', opus(dOps(body(1, 0)))],
      ['three channels', opus(dOps(body(1, 3)))],
      ['family 1', opus(dOps(body(10, 1)))],
      ['family 1 with its table', opus(dOps(Buffer.concat([body(10, 1), Buffer.from([1, 0, 0])])))],
      ['a byte past the header', opus(dOps(Buffer.concat([DOPS_BODY, Buffer.from([0])])))],
    ] as const) {
      expect(mp4(withEntry(bad)), why).toBe(false);
    }
  });

  it('Vorbis is refused in WebM and Ogg: no browser records it', () => {
    expect(webm(webmFile([webmTrack(1, 2, 'A_VORBIS')]))).toBe(false);
    expect(ogg(oggVorbisFile())).toBe(false);
  });

  it('a recording of no time is refused, and every accepted shape reads above 0 s', () => {
    // the fragmented file 03fba09 accepted at 0 s (trex duration 0, no trun durations, an mp4a with no esds)
    const zero = Buffer.concat([ftyp('iso5'), moovBox(trakAround('soun', 1, [stsd(box('mp4a', Buffer.alloc(28))), stts(0), stsc(0), stsz([]), stco(0, 0)]),
      box('mvex', trex(1))), fragment(1, (o) => [tfhd(1), trun([4, 4], o)]), mdat(8)]);
    expect(seconds('audio/mp4', zero)).toBe(null);
    for (const [mime, file] of [['audio/webm', webmFile()], ['audio/ogg', oggFile()], ['audio/mp4', mp4File()], ['audio/mp4', mp4Fragmented()]] as const) {
      expect(seconds(mime, file), mime).toBeGreaterThan(0);
    }
  });

  /** a plain MP4 whose trak carries `extra` (an edts) after tkhd, under a movie timescale of `movieScale` */
  const withTrak = (extra: Buffer[], movieScale = 1000) =>
    Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [mvhd(0, movieScale), trak('soun', 1, [4, 4], o, 0, extra)])])), mdat(8)]);
  /** an elst of [segment duration, media time, rate integer, rate fraction] entries */
  const elst = (version: number, entries: Array<[number, number, number?, number?]>, count = entries.length) =>
    fullBox('elst', version, 0, [u32be(count), ...entries.map(([duration, time, rate = 1, fraction = 0]) => {
      const out = Buffer.alloc(version === 1 ? 20 : 12);
      if (version === 1) {
        out.writeBigUInt64BE(BigInt(duration));
        out.writeBigInt64BE(BigInt(time), 8);
      } else {
        out.writeUInt32BE(duration);
        out.writeInt32BE(time, 4);
      }
      out.writeInt16BE(rate, out.length - 4);
      out.writeInt16BE(fraction, out.length - 2);
      return out;
    })]);
  const edts = (...kids: Buffer[]) => box('edts', kids);

  it('MP4: an edit list is one elst of at most an empty edit then one edit of the media, at rate 1, counted in the length', () => {
    expect(seconds('audio/mp4', withTrak([edts(elst(0, [[5000, 0]]))]))).toBe(5);
    expect(seconds('audio/mp4', withTrak([edts(elst(0, [[2000, -1], [5000, 0]]))]))).toBe(7); // 2 s of delay, then 5 s
    expect(seconds('audio/mp4', withTrak([edts(elst(1, [[2000, -1], [5000, 1024]]))]))).toBe(7);
    // the delay comes before the media's own length when the media edit gives none
    expect(seconds('audio/mp4', withTrak([edts(elst(0, [[2000, -1], [0, 0]]))]))).toBeCloseTo(2 + 2048 / 48_000, 9);
    for (const [why, bad] of [
      ['the media twice', [edts(elst(0, [[5000, 0], [5000, 0]]))]],
      ['rate 2', [edts(elst(0, [[5000, 0, 2]]))]],
      ['a rate fraction', [edts(elst(0, [[5000, 0, 1, 0x4000]]))]],
      ['rate 0 (a still)', [edts(elst(0, [[5000, 0, 0]]))]],
      ['only an empty edit', [edts(elst(0, [[2000, -1]]))]],
      ['an empty edit after the media', [edts(elst(0, [[5000, 0], [2000, -1]]))]],
      ['two empty edits', [edts(elst(0, [[2000, -1], [2000, -1]]))]],
      ['three entries', [edts(elst(0, [[2000, -1], [5000, 0], [5000, 0]]))]],
      ['no entries', [edts(elst(0, []))]],
      ['a media time below -1', [edts(elst(0, [[5000, -2]]))]],
      ['elst version 2', [edts(elst(2, [[5000, 0]]))]],
      ['an entry count past the box', [edts(elst(0, [[5000, 0]], 2))]],
      ['a cut elst', [edts(elst(0, [[5000, 0]]).subarray(0, 12))]],
      ['two elst', [edts(elst(0, [[5000, 0]]), elst(0, [[5000, 0]]))]],
      ['an empty edts', [edts()]],
      ['two edts', [edts(elst(0, [[5000, 0]])), edts(elst(0, [[5000, 0]]))]],
      ['a box beside the elst', [edts(elst(0, [[5000, 0]]), box('free'))]],
    ] as const) {
      expect(mp4(withTrak([...bad])), why).toBe(false);
    }
    // an elst with flags, and one with bytes past its entries
    expect(mp4(withTrak([edts(fullBox('elst', 0, 1, elst(0, [[5000, 0]]).subarray(12)))]))).toBe(false);
    expect(mp4(withTrak([edts(box('elst', [elst(0, [[5000, 0]]).subarray(8), Buffer.alloc(4)]))]))).toBe(false);
    // an edit list needs the movie's timescale
    expect(mp4(withTrak([edts(elst(0, [[5000, 0]]))], 0))).toBe(false);
  });

  it('MP4: the track is enabled (tkhd flag 1), MP4\'s FlagEnabled', () => {
    const withFlags = (flags: number) => {
      const file = mp4File();
      file.writeUIntBE(flags, file.indexOf('tkhd', 0, 'latin1') + 5, 3);
      return file;
    };
    expect(mp4(withFlags(3))).toBe(true);
    expect(mp4(withFlags(1))).toBe(true);
    expect(mp4(withFlags(0))).toBe(false); // disabled
    expect(mp4(withFlags(2))).toBe(false); // in the movie but disabled
  });

  it('WebM: SeekHead, Cues, Tags and CRC-32 are refused, not skipped; Void is padding', () => {
    const segment = (children: Buffer[], track = webmTrack(1, 2, 'A_OPUS')) =>
      Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, track), ...children]), true)]);
    const crc = ebml(0xbf, Buffer.alloc(4));
    expect(webm(segment([webmCluster(), ebml(WEBM.void, Buffer.alloc(4))], ebml(WEBM.trackEntry, Buffer.concat([webmTrack(1, 2, 'A_OPUS').subarray(2), ebml(WEBM.void, Buffer.alloc(2))]))))).toBe(true);
    for (const [why, bad] of [
      ['SeekHead', segment([ebml(0x114d9b74, Buffer.alloc(8)), webmCluster()])],
      ['Cues', segment([webmCluster(undefined, false), ebml(0x1c53bb6b, Buffer.alloc(8))])],
      ['Tags, which can carry a picture', segment([webmCluster(undefined, false), ebml(0x1254c367, Buffer.alloc(8))])],
      ['CRC-32 in the Segment', segment([crc, webmCluster()])],
      ['CRC-32 in the EBML header', Buffer.concat([ebml(WEBM.header, Buffer.concat([ebml(WEBM.docType, 'webm'), crc])), ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), webmCluster()]), true)])],
      ['CRC-32 in Info', Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([ebml(WEBM.info, crc), ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), webmCluster()]), true)])],
      ['CRC-32 in Tracks', Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([webmInfo(), ebml(WEBM.tracks, Buffer.concat([webmTrack(1, 2, 'A_OPUS'), crc])), webmCluster()]), true)])],
      ['CRC-32 in a TrackEntry', segment([webmCluster()], ebml(WEBM.trackEntry, Buffer.concat([webmTrack(1, 2, 'A_OPUS').subarray(2), crc])))],
      ['CRC-32 in a Cluster', segment([webmCluster([crc, simpleBlock()], false)])],
      ['CRC-32 in Audio', segment([webmCluster()], ebml(WEBM.trackEntry, Buffer.concat([webmTrack(1, 2, 'A_OPUS').subarray(2), ebml(0xe1, crc)])))],
      ['CRC-32 in a BlockGroup', segment([webmCluster([ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), crc]))])])],
      ['no CodecPrivate', segment([webmCluster()], ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([1])), ebml(WEBM.trackType, Buffer.from([2])), ebml(WEBM.codecId, 'A_OPUS')])))],
    ] as const) {
      expect(webm(bad), why).toBe(false);
    }
  });

  it('MP4: udta, meta, iods, sgpd, sbgp, sidx and mfra are refused, not skipped, and the track has one dinf naming this file', () => {
    const inMoov = (kid: Buffer) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', [mvhd(), trak('soun', 1, [4, 4], o), kid])])), mdat(8)]);
    const inTrak = (kid: Buffer) => withTrak([kid]);
    const inTable = (kid: Buffer) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(trakAround('soun', 1, [stsd('mp4a'), stts(2),
      fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(2), u32be(1)]), stsz([4, 4]), stco(1, o), kid]))])), mdat(8)]);
    const inMdia = (kid: Buffer) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(box('trak', [tkhd(1), box('mdia', [mdhd(), hdlr('soun'),
      box('minf', [fullBox('smhd', 0, 0, Buffer.alloc(4)), dinf(), box('stbl', [stsd('mp4a'), stts(2), fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(2), u32be(1)]),
        stsz([4, 4]), stco(1, o)])]), kid])]))])), mdat(8)]);
    const inTraf = (kid: Buffer) => Buffer.concat([ftyp('iso5'), moovBox(trak('soun', 1, []), box('mvex', trex(1))), fragment(1, (o) => [tfhd(1), kid, trun([4, 4], o)]), mdat(8)]);
    expect(mp4(inMoov(box('free', Buffer.alloc(8))))).toBe(true); // padding
    expect(mp4(inTraf(box('free')))).toBe(true);
    for (const [why, bad] of [
      ['udta in moov', inMoov(box('udta', box('cprt', Buffer.alloc(8))))],
      ['meta in moov, which can carry a picture', inMoov(fullBox('meta', 0, 0, [hdlr('mdir'), box('ilst', Buffer.alloc(8))]))],
      ['iods in moov', inMoov(fullBox('iods', 0, 0, Buffer.alloc(8)))],
      ['udta in trak', inTrak(box('udta'))],
      ['udta in mdia', inMdia(box('udta'))],
      ['sgpd in stbl', inTable(fullBox('sgpd', 0, 0, Buffer.alloc(8)))],
      ['sbgp in stbl', inTable(fullBox('sbgp', 0, 0, Buffer.alloc(8)))],
      ['sgpd in traf', inTraf(fullBox('sgpd', 0, 0, Buffer.alloc(8)))],
      ['sbgp in traf', inTraf(fullBox('sbgp', 0, 0, Buffer.alloc(8)))],
      ['sidx at the top', Buffer.concat([mp4File(), fullBox('sidx', 0, 0, Buffer.alloc(24))])],
      ['mfra at the top', Buffer.concat([mp4File(), box('mfra', fullBox('mfro', 0, 0, Buffer.alloc(4)))])],
    ] as const) {
      expect(mp4(bad), why).toBe(false);
    }
    // dinf: one, naming this file
    const minfWith = (kids: Buffer[]) => Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), moovBox(box('trak', [tkhd(1), box('mdia', [mdhd(), hdlr('soun'),
      box('minf', [fullBox('smhd', 0, 0, Buffer.alloc(4)), ...kids, box('stbl', [stsd('mp4a'), stts(2), fullBox('stsc', 0, 0, [u32be(1), u32be(1), u32be(2), u32be(1)]),
        stsz([4, 4]), stco(1, o)])])])]))])), mdat(8)]);
    expect(mp4(minfWith([dinf()]))).toBe(true);
    expect(mp4(minfWith([]))).toBe(false); // no dinf
    expect(mp4(minfWith([dinf(), dinf()]))).toBe(false);
    expect(mp4(minfWith([dinf(0)]))).toBe(false); // the samples are in another file
    // and the movie has its header
    expect(mp4(Buffer.concat([laidOut((o) => Buffer.concat([ftyp(), box('moov', trak('soun', 1, [4, 4], o))])), mdat(8)]))).toBe(false);
  });

  it('real recordings: Chromium 141\'s MediaRecorder WebM-Opus and MP4-Opus (fake microphone, 3 s) pass at their own length', () => {
    const chromeWebm = recording('chromium-141-opus.webm');
    const chromeMp4 = recording('chromium-141-opus.mp4');
    expect(seconds('audio/webm', chromeWebm)).toBe(3);
    expect(seconds('audio/mp4', chromeMp4)).toBe(3);
    // they are what Chromium wrote: WebM's MuxingApp, and MP4's brands with vp09 listed for an audio-only file
    expect(chromeWebm.includes('Chrome', 0, 'latin1')).toBe(true);
    expect(chromeMp4.subarray(8, 36).toString('latin1')).toBe('isom\0\0\x02\0isomiso6iso2vp09mp41');
    // a Tags element after Chrome's last Cluster (its Segment is of unknown size) is refused
    expect(webm(Buffer.concat([chromeWebm, ebml(0x1254c367, Buffer.alloc(8))]))).toBe(false);
    // vp09 is a compatible brand only: as the major brand it is refused
    const vp09 = Buffer.from(chromeMp4);
    vp09.write('vp09', 8, 'latin1');
    expect(mp4(vp09)).toBe(false);
    // and the wrong type for each
    expect(webm(chromeMp4)).toBe(false);
    expect(mp4(chromeWebm)).toBe(false);
  });
});

describe('the #1013 replacement, second review: every part read by its type, and the length as stored', () => {
  const webm = (b: Buffer) => isAudioOnlyRecording('audio/webm', b);
  const ogg = (b: Buffer) => isAudioOnlyRecording('audio/ogg', b);
  const mp4 = (b: Buffer) => isAudioOnlyRecording('audio/mp4', b);
  const big = (fill = 0x61) => Buffer.alloc(MB, fill);
  const bytes = (...values: number[]) => Buffer.from(values);

  it('the helpers build files that pass, so each refusal below is its own rule', () => {
    expect(webm(webmOf())).toBe(true);
    expect(ogg(oggWithTags(opusTags()))).toBe(true);
    expect(mp4(plainMp4())).toBe(true);
    expect(mp4(fragmentedMp4())).toBe(true);
  });

  it('Codex round 1 on #1158: a fragment marked duration-is-empty holds no track run', () => {
    const empty = (b: Buffer) => {
      const out = Buffer.from(b);
      out[out.indexOf(Buffer.from('tfhd')) + 5]! |= 0x01; // tfhd flags 0x010000
      return out;
    };
    expect(mp4(empty(fragmentedMp4()))).toBe(false);
  });

  it('Codex round 2 on #1158: an MP4 track has a nonzero track_ID', () => {
    const zero = (b: Buffer) => {
      const out = Buffer.from(b);
      out.writeUInt32BE(0, out.indexOf(Buffer.from('tkhd')) + 4 + 12); // version 0: track_ID after the two times
      return out;
    };
    expect(mp4(plainMp4())).toBe(true);
    expect(mp4(zero(plainMp4()))).toBe(false);
  });

  it('WebM DocType and CodecID: at most 16 bytes, and trailing zeros dropped by a loop, never a pattern (no quadratic time)', () => {
    const nuls = (n: number) => Buffer.concat([Buffer.alloc(n), Buffer.from('x')]);
    // 80,000 zero bytes then one more took 6.7 s on ee78dd1's pattern; the length rule refuses it before reading it
    for (const doc of [webmOf({ docType: nuls(80_000) }), webmOf({ codecId: nuls(80_000) })]) expect(webm(doc)).toBe(false);
    expect(webm(webmOf({ docType: nuls(MB) }))).toBe(false);
    expect(webm(webmOf({ codecId: nuls(MB) }))).toBe(false);
    expect(webm(webmOf({ docType: Buffer.from('webm\0\0\0\0') }))).toBe(true); // zero padding is dropped
    expect(webm(webmOf({ codecId: Buffer.from('A_OPUS\0\0') }))).toBe(true);
    expect(webm(webmOf({ docType: Buffer.from('webm'.padEnd(17, '\0')) }))).toBe(false); // 17 bytes
  });

  it('WebM: every leaf is read by its type, 1 MB in any of them is refused, and each appears once', () => {
    const uint = (n = 1) => Buffer.alloc(n, 1);
    const ok: Array<[string, Buffer]> = [
      ['EBML header fields', webmOf({ header: [ebml(0x42f2, uint()), ebml(0x42f3, uint()), ebml(0x4287, uint()), ebml(0x4285, uint())] })],
      ['Info text, UUID and date', webmOf({ info: [ebml(0x4d80, 'Chrome'), ebml(0x5741, 'Chrome'), ebml(0x7ba9, 'a'.repeat(64)), ebml(0x73a4, Buffer.alloc(16)), ebml(0x4461, Buffer.alloc(8))] })],
      ['a 64-bit TrackUID past what a Number holds', webmOf({ entry: [ebml(0x73c5, Buffer.alloc(8, 0xff))] })],
      ['TrackEntry fields', webmOf({ entry: [ebml(0x23e383, uint(4)), ebml(0x56aa, uint(2)), ebml(0x56bb, uint(4)), ebml(0x536e, 'Voice'), ebml(0x22b59c, 'und'), ebml(0x22b59d, 'en')] })],
      ['Audio fields', webmOf({ entry: [ebml(0xe1, Buffer.concat([ebml(0xb5, Buffer.alloc(8)), ebml(0x9f, uint()), ebml(0x6264, uint()), ebml(0x78b5, Buffer.alloc(4))]))] })],
      ['Cluster Position and PrevSize', webmOf({ cluster: [ebml(0xa7, uint(2)), ebml(0xab, uint(2))] })],
      ['a BlockGroup with its fields', webmOf({ cluster: [ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), ebml(0x9b, uint()), ebml(0xfb, uint(2)), ebml(0x75a2, uint(2))]))] })],
      ['Void up to the 4 KiB cap', webmOf({ segment: [ebml(WEBM.void, Buffer.alloc(4096))] })],
    ];
    for (const [why, file] of ok) expect(webm(file), why).toBe(true);
    const bad: Array<[string, Buffer]> = [
      ['1 MB EBMLVersion', webmOf({ header: [ebml(0x42f2, big())] })],
      ['1 MB DocTypeVersion', webmOf({ header: [ebml(0x4287, big())] })],
      ['1 MB MuxingApp', webmOf({ info: [ebml(0x4d80, big())] })],
      ['1 MB WritingApp', webmOf({ info: [ebml(0x5741, big())] })],
      ['1 MB Title', webmOf({ info: [ebml(0x7ba9, big())] })],
      ['a 65-byte Title', webmOf({ info: [ebml(0x7ba9, 'a'.repeat(65))] })],
      ['1 MB SegmentUUID', webmOf({ info: [ebml(0x73a4, big())] })],
      ['a 17-byte SegmentUUID', webmOf({ info: [ebml(0x73a4, Buffer.alloc(17))] })],
      ['1 MB DateUTC', webmOf({ info: [ebml(0x4461, big())] })],
      ['a 9-byte DateUTC', webmOf({ info: [ebml(0x4461, Buffer.alloc(9))] })],
      ['1 MB Duration', webmOf({ info: [ebml(0x4489, big())] })],
      ['1 MB TrackUID', webmOf({ entry: [ebml(0x73c5, big())] })],
      ['1 MB Name', webmOf({ entry: [ebml(0x536e, big())] })],
      ['1 MB Language', webmOf({ entry: [ebml(0x22b59c, big())] })],
      ['1 MB LanguageBCP47', webmOf({ entry: [ebml(0x22b59d, big())] })],
      ['1 MB DefaultDuration', webmOf({ entry: [ebml(0x23e383, big())] })],
      ['1 MB CodecDelay', webmOf({ entry: [ebml(0x56aa, big())] })],
      ['1 MB SeekPreRoll', webmOf({ entry: [ebml(0x56bb, big())] })],
      ['1 MB SamplingFrequency', webmOf({ entry: [ebml(0xe1, ebml(0xb5, big()))] })],
      ['1 MB Channels', webmOf({ entry: [ebml(0xe1, ebml(0x9f, big()))] })],
      ['1 MB Position', webmOf({ cluster: [ebml(0xa7, big())] })],
      ['1 MB PrevSize', webmOf({ cluster: [ebml(0xab, big())] })],
      ['1 MB BlockDuration', webmOf({ cluster: [ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), ebml(0x9b, big())]))] })],
      ['1 MB ReferenceBlock', webmOf({ cluster: [ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), ebml(0xfb, big())]))] })],
      ['1 MB DiscardPadding', webmOf({ cluster: [ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1)), ebml(0x75a2, big())]))] })],
      ['1 MB Void in the Segment', webmOf({ segment: [ebml(WEBM.void, big())] })],
      ['1 MB Void in a Cluster', webmOf({ cluster: [ebml(WEBM.void, big())] })],
      ['1 MB Void in the EBML header', webmOf({ header: [ebml(WEBM.void, big())] })],
      ['Void past the 4 KiB cap, in small pieces', webmOf({ segment: [ebml(WEBM.void, Buffer.alloc(2048)), ebml(WEBM.void, Buffer.alloc(2049))] })],
      ['two MuxingApps', webmOf({ info: [ebml(0x4d80, 'a'), ebml(0x4d80, 'b')] })],
      ['two Positions', webmOf({ cluster: [ebml(0xa7, uint()), ebml(0xa7, uint())] })],
      ['two Channels', webmOf({ entry: [ebml(0xe1, Buffer.concat([ebml(0x9f, uint()), ebml(0x9f, uint())]))] })],
    ];
    for (const [why, file] of bad) expect(webm(file), why).toBe(false);
  });

  it('WebM: exactly one Info, before any Cluster, as Chrome writes it', () => {
    expect(webm(webmOf({ noInfo: true }))).toBe(false);
    expect(webm(webmOf({ noInfo: true, segment: [ebml(WEBM.info, ebml(0x2ad7b1, bytes(0x0f, 0x42, 0x40)))] }))).toBe(false); // after the Cluster
    expect(webm(webmOf({ segment: [ebml(WEBM.info, ebml(0x2ad7b1, bytes(0x0f, 0x42, 0x40)))] }))).toBe(false); // a second Info
  });

  it('Ogg: OpusTags is read whole, at most 4 KiB and 64 comments, no picture, and ends its page', () => {
    expect(ogg(oggWithTags(opusTags('Mozilla', ['ENCODER=Firefox', 'title=Site visit'])))).toBe(true);
    expect(ogg(oggWithTags(opusTags('Mozilla', Array.from({ length: 64 }, (_, i) => `K${i}=v`))))).toBe(true);
    expect(ogg(oggWithTags(opusTags('v'.repeat(4096 - 16))))).toBe(true); // exactly 4 KiB
    const bad: Array<[string, Buffer]> = [
      ['a 1 MB comment', oggWithTags(opusTags('Mozilla', [`ARTIST=${'a'.repeat(MB)}`]))],
      ['a 1 MB vendor string', oggWithTags(opusTags('v'.repeat(MB)))],
      ['one byte over 4 KiB', oggWithTags(opusTags('v'.repeat(4096 - 15)))],
      ['a picture', oggWithTags(opusTags('Mozilla', ['METADATA_BLOCK_PICTURE=AAAA']))],
      ['a picture, lower case', oggWithTags(opusTags('Mozilla', ['metadata_block_picture=AAAA']))],
      ['65 comments', oggWithTags(opusTags('Mozilla', Array.from({ length: 65 }, (_, i) => `K${i}=v`)))],
      ['a comment with no key', oggWithTags(opusTags('Mozilla', ['=v']))],
      ['a comment with no =', oggWithTags(opusTags('Mozilla', ['novalue']))],
      ['a byte after the comments', oggWithTags(opusTags('Mozilla', [], bytes(1)))],
      ['1 MB after the comments', oggWithTags(opusTags('Mozilla', [], big()))],
      ['a whole 4 KiB OpusTags, then 1 MB more in its packet', oggWithTags(opusTags('v'.repeat(4096 - 16), [], big()))],
      ['a vendor length past the packet', oggWithTags(Buffer.concat([Buffer.from('OpusTags'), bytes(0xff, 0xff, 0, 0), Buffer.alloc(4)]))],
      ['a comment length past the packet', oggWithTags(Buffer.concat([Buffer.from('OpusTags'), bytes(0, 0, 0, 0, 1, 0, 0, 0, 0xff, 0, 0, 0)]))],
      ['a comment count with no comments', oggWithTags(Buffer.concat([Buffer.from('OpusTags'), bytes(0, 0, 0, 0, 1, 0, 0, 0)]))],
      ['the magic alone', oggWithTags(Buffer.from('OpusTags'))],
      ['audio on the OpusTags page', oggWithTags(opusTags(), true)],
    ];
    for (const [why, file] of bad) expect(ogg(file), why).toBe(false);
  });

  it('MP4: every table and full box ends exactly at its last field; 1 MB after any of them is refused', () => {
    const tail = big(0);
    const plainTables = (off: number) => [stsd('mp4a'), stts(2), stsc(2), stsz([4, 4]), stco(2, off)];
    const replace = (i: number, f: (box: Buffer) => Buffer) => (off: number) => plainTables(off).map((x, j) => (j === i ? f(x) : x));
    const co64 = (off: number) => {
      const at = Buffer.alloc(8);
      at.writeBigUInt64BE(BigInt(off));
      return fullBox('co64', 0, 0, [Buffer.from([0, 0, 0, 1]), at]);
    };
    expect(mp4(plainMp4({ table: (off) => [...plainTables(off).slice(0, 4), co64(off)] }))).toBe(true);
    const bad: Array<[string, Buffer]> = [
      ['stts', plainMp4({ table: replace(1, (x) => grow(x, tail)) })],
      ['stsc', plainMp4({ table: replace(2, (x) => grow(x, tail)) })],
      ['stsz', plainMp4({ table: replace(3, (x) => grow(x, tail)) })],
      ['stsz with a fixed size', plainMp4({ table: replace(3, () => grow(fullBox('stsz', 0, 0, [Buffer.from([0, 0, 0, 4, 0, 0, 0, 2])]), tail)) })],
      ['stco', plainMp4({ table: replace(4, (x) => grow(x, tail)) })],
      ['co64', plainMp4({ table: (off) => [...plainTables(off).slice(0, 4), grow(co64(off), tail)] })],
      ['stts version 1', plainMp4({ table: replace(1, (x) => Buffer.concat([x.subarray(0, 8), Buffer.from([1]), x.subarray(9)])) })],
      ['mvhd', plainMp4({ mvhd: grow(mvhd(), tail) })],
      ['tkhd', plainMp4({ tkhd: grow(tkhd(1), tail) })],
      ['mdhd', plainMp4({ mdhd: grow(mdhd(), tail) })],
      ['smhd', plainMp4({ smhd: grow(fullBox('smhd', 0, 0, Buffer.alloc(4)), tail) })],
      ['an empty stsc in a fragmented file', fragmentedMp4({ table: [stsd('mp4a'), stts(0), grow(stsc(0), tail), stsz([]), stco(0, 0)] })],
      ['an empty stco in a fragmented file', fragmentedMp4({ table: [stsd('mp4a'), stts(0), stsc(0), stsz([]), grow(stco(0, 0), tail)] })],
      ['an empty stsc listing a run in a fragmented file', fragmentedMp4({ table: [stsd('mp4a'), stts(0), stsc(2), stsz([]), stco(0, 0)] })],
      ['trex', fragmentedMp4({ trex: grow(trex(1), tail) })],
      ['mehd', fragmentedMp4({ mvex: [grow(fullBox('mehd', 0, 0, Buffer.alloc(4)), tail)] })],
      ['mfhd', fragmentedMp4({ mfhd: grow(fullBox('mfhd', 0, 0, Buffer.alloc(4)), tail) })],
      ['tfdt', fragmentedMp4({ traf: (off) => [tfhd(1), grow(fullBox('tfdt', 0, 0, Buffer.alloc(4)), tail), trun([4, 4], off)] })],
      ['tfhd', fragmentedMp4({ traf: (off) => [grow(tfhd(1), tail), trun([4, 4], off)] })],
      ['trun', fragmentedMp4({ traf: (off) => [tfhd(1), grow(trun([4, 4], off), tail)] })],
    ];
    for (const [why, file] of bad) expect(mp4(file), why).toBe(false);
    // the fields the flags name are read, default_sample_flags too, and version 1 where the box defines it
    expect(mp4(fragmentedMp4({ traf: (off) => [fullBox('tfhd', 0, 0x020020, [Buffer.from([0, 0, 0, 1]), Buffer.alloc(4)]), trun([4, 4], off)] }))).toBe(true);
    expect(mp4(fragmentedMp4({ mvex: [fullBox('mehd', 1, 0, Buffer.alloc(8))], traf: (off) => [tfhd(1), fullBox('tfdt', 1, 0, Buffer.alloc(8)), trun([4, 4], off)] }))).toBe(true);
  });

  it('MP4: tkhd, mvhd and mdhd at version 0 or 1 only, each whole at its version', () => {
    const tkhdV1 = fullBox('tkhd', 1, 1, [Buffer.alloc(16), Buffer.from([0, 0, 0, 1]), Buffer.alloc(72)]);
    expect(mp4(plainMp4({ tkhd: tkhdV1 }))).toBe(true);
    expect(mp4(plainMp4({ mvhd: fullBox('mvhd', 1, 0, [Buffer.alloc(16), Buffer.from([0, 0, 3, 0xe8]), Buffer.alloc(8), Buffer.alloc(80)]) }))).toBe(true);
    expect(mp4(plainMp4({ mdhd: fullBox('mdhd', 1, 0, [Buffer.alloc(16), Buffer.from([0, 0, 0xbb, 0x80]), Buffer.alloc(12)]) }))).toBe(true);
    const bad: Array<[string, Buffer]> = [
      ['tkhd version 2', plainMp4({ tkhd: fullBox('tkhd', 2, 1, [Buffer.alloc(8), Buffer.from([0, 0, 0, 1]), Buffer.alloc(68)]) })],
      ['tkhd version 1 at the version 0 length', plainMp4({ tkhd: fullBox('tkhd', 1, 1, [Buffer.alloc(16), Buffer.from([0, 0, 0, 1]), Buffer.alloc(60)]) })],
      ['mvhd version 7', plainMp4({ mvhd: fullBox('mvhd', 7, 0, [Buffer.alloc(8), Buffer.from([0, 0, 3, 0xe8]), Buffer.alloc(84)]) })],
      ['mdhd version 2', plainMp4({ mdhd: fullBox('mdhd', 2, 0, [Buffer.alloc(8), Buffer.from([0, 0, 0xbb, 0x80]), Buffer.alloc(8)]) })],
      ['tfdt version 2', fragmentedMp4({ traf: (off) => [tfhd(1), fullBox('tfdt', 2, 0, Buffer.alloc(8)), trun([4, 4], off)] })],
      ['tfhd version 1', fragmentedMp4({ traf: (off) => [fullBox('tfhd', 1, 0x020000, Buffer.from([0, 0, 0, 1])), trun([4, 4], off)] })],
    ];
    for (const [why, file] of bad) expect(mp4(file), why).toBe(false);
  });

  it('MP4: trun at version 0 or 1, stsd and hdlr at version 0, and every full box with only the flags it defines', () => {
    /** a box built by the helpers with its version and flags word replaced */
    const head = (built: Buffer, version: number, flags: number) => {
      const out = Buffer.from(built);
      out.writeUInt32BE(((version << 24) | flags) >>> 0, 8);
      return out;
    };
    const traf = (run: (off: number) => Buffer, extra: Buffer[] = []) => (off: number) => [tfhd(1), ...extra, run(off)];
    const ok: Array<[string, Buffer]> = [
      ['trun version 1', fragmentedMp4({ traf: traf((off) => head(trun([4, 4], off), 1, 0x000201)) })],
      ['tkhd with all four track flags', plainMp4({ tkhd: head(tkhd(1), 0, 0xf) })],
      ['tfdt with no flags', fragmentedMp4({ traf: traf((off) => trun([4, 4], off), [fullBox('tfdt', 0, 0, Buffer.alloc(4))]) })],
      ['mehd with no flags', fragmentedMp4({ mvex: [fullBox('mehd', 0, 0, Buffer.alloc(4))] })],
    ];
    for (const [why, file] of ok) expect(mp4(file), why).toBe(true);
    const bad: Array<[string, Buffer]> = [
      ['trun version 2', fragmentedMp4({ traf: traf((off) => head(trun([4, 4], off), 2, 0x000201)) })],
      ['trun version 7', fragmentedMp4({ traf: traf((off) => head(trun([4, 4], off), 7, 0x000201)) })],
      ['stsd version 7 with every flag', plainMp4({ table: (off) => [head(stsd('mp4a'), 7, 0xffffff), stts(2), stsc(2), stsz([4, 4]), stco(2, off)] })],
      ['stsd version 1', plainMp4({ table: (off) => [head(stsd('mp4a'), 1, 0), stts(2), stsc(2), stsz([4, 4]), stco(2, off)] })],
      ['stsd with a flag', plainMp4({ table: (off) => [head(stsd('mp4a'), 0, 1), stts(2), stsc(2), stsz([4, 4]), stco(2, off)] })],
      ['hdlr version 9', plainMp4({ hdlr: head(hdlr('soun'), 9, 0) })],
      ['hdlr with a flag', plainMp4({ hdlr: head(hdlr('soun'), 0, 1) })],
      ['mvhd with every flag', plainMp4({ mvhd: head(mvhd(), 0, 0xffffff) })],
      ['mdhd with every flag', plainMp4({ mdhd: head(mdhd(), 0, 0xffffff) })],
      ['smhd with every flag', plainMp4({ smhd: fullBox('smhd', 0, 0xffffff, Buffer.alloc(4)) })],
      ['tkhd with a flag past the four track flags', plainMp4({ tkhd: head(tkhd(1), 0, 0x13) })],
      ['url with a flag past self-contained', plainMp4({ dinf: dinf(3) })],
      ['mfhd with every flag', fragmentedMp4({ mfhd: fullBox('mfhd', 0, 0xffffff, Buffer.from([0, 0, 0, 1])) })],
      ['trex with every flag', fragmentedMp4({ trex: head(trex(1), 0, 0xffffff) })],
      ['mehd with every flag', fragmentedMp4({ mvex: [fullBox('mehd', 0, 0xffffff, Buffer.alloc(4))] })],
      ['tfdt with every flag', fragmentedMp4({ traf: traf((off) => trun([4, 4], off), [fullBox('tfdt', 0, 0xffffff, Buffer.alloc(4))]) })],
    ];
    for (const [why, file] of bad) expect(mp4(file), why).toBe(false);
  });

  it('MP4: the handler name is at most 64 bytes, ending at its one zero byte; stss and elng are refused', () => {
    const named = (name: Buffer) => box('hdlr', [Buffer.alloc(8), Buffer.from('soun'), Buffer.alloc(12), name]);
    expect(mp4(plainMp4({ hdlr: named(Buffer.from('SoundHandler\0')) }))).toBe(true);
    expect(mp4(plainMp4({ hdlr: named(Buffer.concat([Buffer.alloc(63, 0x61), Buffer.alloc(1)])) }))).toBe(true);
    const bad: Array<[string, Buffer]> = [
      ['a 65-byte name', plainMp4({ hdlr: named(Buffer.concat([Buffer.alloc(64, 0x61), Buffer.alloc(1)])) })],
      ['a 1 MB name', plainMp4({ hdlr: named(Buffer.concat([big(), Buffer.alloc(1)])) })],
      ['no name', plainMp4({ hdlr: named(Buffer.alloc(0)) })],
      ['a name with no zero byte', plainMp4({ hdlr: named(Buffer.from('Sound')) })],
      ['bytes after the zero byte', plainMp4({ hdlr: named(Buffer.from('Sound\0abc\0')) })],
      ['stss in stbl', plainMp4({ table: (off) => [stsd('mp4a'), stts(2), stsc(2), stsz([4, 4]), stco(2, off), fullBox('stss', 0, 0, [Buffer.from([0, 0, 0, 1, 0, 0, 0, 1])])] })],
      ['a 1 MB stss', plainMp4({ table: (off) => [stsd('mp4a'), stts(2), stsc(2), stsz([4, 4]), stco(2, off), fullBox('stss', 0, 0, big())] })],
      ['elng in mdia', plainMp4({ mdia: [fullBox('elng', 0, 0, Buffer.from('en\0'))] })],
      ['a 1 MB elng', plainMp4({ mdia: [fullBox('elng', 0, 0, big())] })],
    ];
    for (const [why, file] of bad) expect(mp4(file), why).toBe(false);
  });

  it('MP4: free, skip and wide hold at most 4 KiB in all', () => {
    expect(mp4(plainMp4({ top: [box('free', Buffer.alloc(4096))] }))).toBe(true); // the payloads count, not the headers
    expect(mp4(plainMp4({ top: [box('wide')] }))).toBe(true);
    const bad: Array<[string, Buffer]> = [
      ['1 MB free at the top', plainMp4({ top: [box('free', big())] })],
      ['1 MB skip at the top', plainMp4({ top: [box('skip', big())] })],
      ['1 MB wide', plainMp4({ top: [box('wide', big())] })],
      ['1 MB free in moov', plainMp4({ moov: [box('free', big())] })],
      ['1 MB free in a traf', fragmentedMp4({ traf: (off) => [tfhd(1), box('free', big()), trun([4, 4], off)] })],
      ['a byte over 4 KiB', plainMp4({ top: [box('free', Buffer.alloc(4097))] })],
      ['over 4 KiB in small pieces', plainMp4({ top: [box('free', Buffer.alloc(2040)), box('skip', Buffer.alloc(2040)), box('free', Buffer.alloc(17))] })],
    ];
    for (const [why, file] of bad) expect(mp4(file), why).toBe(false);
  });

  it('MP4: the chunks and runs tile each mdat payload exactly', () => {
    const twoChunks = (first: (off: number) => number, second: (off: number) => number, mdatBytes = 8) => plainMp4({
      mdatBytes,
      table: (off) => [stsd('mp4a'), stts(2), fullBox('stsc', 0, 0, [Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])]), stsz([4, 4]),
        fullBox('stco', 0, 0, [Buffer.from([0, 0, 0, 2]), ...[first(off), second(off)].map((v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; })])],
    });
    expect(mp4(twoChunks((o) => o, (o) => o + 4))).toBe(true);
    expect(mp4(twoChunks((o) => o + 4, (o) => o))).toBe(true); // in any order
    const bad: Array<[string, Buffer]> = [
      ['1 MB in the mdat that no chunk covers', plainMp4({ mdatBytes: 8 + MB })],
      ['a byte after the chunks', plainMp4({ mdatBytes: 9 })],
      ['a gap between the chunks', twoChunks((o) => o, (o) => o + 5, 9)],
      ['two chunks on the same bytes', twoChunks((o) => o, (o) => o, 4)],
      ['two chunks that overlap, with bytes left after them', twoChunks((o) => o, (o) => o + 2)],
      ['an mdat no chunk reaches', plainMp4({ after: [box('mdat', big())] })],
      ['1 MB in a fragment\'s mdat that no run covers', fragmentedMp4({ mdatBytes: 8 + MB })],
    ];
    for (const [why, file] of bad) expect(mp4(file), why).toBe(false);
  });

  it('MP4: the data reference is version 0, self-contained, with at most one zero byte (Chromium writes a 13-byte url)', () => {
    const withUrl = (url: Buffer) => plainMp4({ dinf: box('dinf', fullBox('dref', 0, 0, [Buffer.from([0, 0, 0, 1]), url])) });
    expect(mp4(withUrl(fullBox('url ', 0, 1)))).toBe(true);
    expect(mp4(withUrl(fullBox('url ', 0, 1, Buffer.alloc(1))))).toBe(true);
    expect(mp4(withUrl(fullBox('url ', 0, 1, Buffer.from([1]))))).toBe(false); // the one trailing byte must be a NUL
    expect(mp4(withUrl(fullBox('url ', 0, 1, Buffer.alloc(2))))).toBe(false);
    expect(mp4(withUrl(fullBox('url ', 0, 1, Buffer.from('a\0'))))).toBe(false);
    expect(mp4(withUrl(fullBox('url ', 0, 1, big())))).toBe(false);
    expect(mp4(withUrl(fullBox('url ', 1, 1)))).toBe(false);
    expect(mp4(plainMp4({ dinf: box('dinf', fullBox('dref', 1, 0, [Buffer.from([0, 0, 0, 1]), fullBox('url ', 0, 1)])) }))).toBe(false); // dref version 1
  });

  it('the length as stored: under half a second is refused, and the stored length is the rounded one', () => {
    expect(recordingSeconds('audio/webm', webmTimed(0.4))).toBeCloseTo(0.4, 9);
    expect(readVoiceRecording('audio/webm', webmTimed(0.4))).toBe(null);
    expect(readVoiceRecording('audio/webm', webmTimed(0.5))).toEqual({ seconds: 0.5, durationSec: 1 });
    expect(readVoiceRecording('audio/webm', webmTimed(1.4))?.durationSec).toBe(1);
    expect(readVoiceRecording('audio/webm', webmTimed(120.4))?.durationSec).toBe(120);
    expect(readVoiceRecording('audio/webm', webmTimed(120.6))?.durationSec).toBe(121); // the caller's cap refuses it
    expect(readVoiceRecording('audio/ogg', oggTimed(0.4))).toBe(null);
    expect(readVoiceRecording('audio/mp4', mp4Timed(0.4))).toBe(null);
    // the browser-shaped fixtures are a fraction of a second: a well-formed shape, but no voice note
    for (const [mime, file] of [['audio/webm', webmFile()], ['audio/ogg', oggFile()], ['audio/mp4', mp4File()], ['audio/mp4', mp4Fragmented()]] as const) {
      expect(isAudioOnlyRecording(mime, file), mime).toBe(true);
      expect(readVoiceRecording(mime, file), mime).toBe(null);
    }
  });
});

/**
 * Codex round 1 on #1025 (daf6bea): declared frames are charged to the walk before they are listed, every WebM frame
 * holds a byte, and a fragment's runs start where tfdt places them.
 */
describe('Codex round 1 on #1025', () => {
  const webm = (b: Buffer) => isAudioOnlyRecording('audio/webm', b);
  const mp4 = (b: Buffer) => isAudioOnlyRecording('audio/mp4', b);
  const ogg = (b: Buffer) => isAudioOnlyRecording('audio/ogg', b);
  /** big-endian 32-bit words */
  const be = (...values: number[]) => {
    const out = Buffer.alloc(4 * values.length);
    values.forEach((v, i) => out.writeUInt32BE(v, 4 * i));
    return out;
  };

  /** the list entries a parse makes (each declared frame is listed twice: its size, then its place), counted as work
   *  done, not timed: a fixed-size lace's frames take no lace table bytes, so only a count shows what they cost */
  const listed = (parse: () => boolean) => {
    const push = Array.prototype.push;
    let n = 0;
    Array.prototype.push = function counted(this: unknown[], ...items: unknown[]) {
      n += items.length;
      return push.apply(this, items);
    };
    try {
      return { result: parse(), n };
    } finally {
      Array.prototype.push = push;
    }
  };

  it('P1: every declared lace frame is a step of the walk, charged before it is listed, so the work stays within the cap', () => {
    // 1,500 fixed-size laced blocks of 256 one-byte Opus packets: about 390 KB declaring 384,000 frames. On daf6bea it
    // passed after listing every frame (over 768,000 entries); charged at one step a frame, it is refused once the
    // walk's 100,000 steps are spent, having listed 199,559. Charged after its frames are listed instead, the last
    // block's 256 frames are listed first (200,071), so the bound sits between the two and pins the order
    const block = lacedBlock(1, 2, 256, Buffer.alloc(0), Buffer.alloc(256, 0xfc));
    const many = webmFile(undefined, 'webm', [webmCluster(Array.from({ length: 1500 }, () => block))]);
    const r = listed(() => webm(many));
    expect(r.result).toBe(false);
    expect(r.n).toBeLessThan(200_000);
    // 300 such blocks still pass the shape check: the charge refuses volume, not lacing (they read 1,536 s, which the
    // upload refuses over its 120 s cap)
    expect(webm(webmFile(undefined, 'webm', [webmCluster(Array.from({ length: 300 }, () => block))]))).toBe(true);
    // and an unlaced recording of 6,000 blocks (two minutes of 20 ms frames) is well inside the cap
    expect(webm(webmFile(undefined, 'webm', [webmCluster(Array.from({ length: 6000 }, () => simpleBlock()))]))).toBe(true);
  });

  it('P2: a WebM frame of no bytes refuses the file, wherever it is, laced or not', () => {
    const six = Buffer.from([1, 2, 3, 4, 5, 6]);
    const withSound = (empty: Buffer) => webmFile(undefined, 'webm', [webmCluster([simpleBlock(), empty, simpleBlock()])]);
    expect(webm(withSound(simpleBlock()))).toBe(true);
    // on daf6bea each of these passed: the empty frame only marked its own block as not sounding
    expect(webm(withSound(simpleBlock(1, Buffer.alloc(0))))).toBe(false); // an unlaced block with no frame bytes
    expect(webm(withSound(lacedBlock(1, 1, 2, Buffer.from([0]), six)))).toBe(false); // Xiph: 0, then 6
    expect(webm(withSound(lacedBlock(1, 3, 2, Buffer.from([0x80]), six)))).toBe(false); // EBML: 0, then 6
    expect(webm(withSound(lacedBlock(1, 2, 2, Buffer.alloc(0), Buffer.alloc(0))))).toBe(false); // fixed-size: two of 0
  });

  it('P2: a fragment starts where its tfdt places it, so a short run minutes in is minutes long', () => {
    const at = (version: 0 | 1, ticks: number) => {
      const time = Buffer.alloc(version === 1 ? 8 : 4);
      if (version === 1) time.writeBigUInt64BE(BigInt(ticks));
      else time.writeUInt32BE(ticks);
      return fragmentedMp4({ traf: (off) => [tfhd(1), fullBox('tfdt', version, 0, time), trun([4, 4], off)] });
    };
    // two AAC frames (about 43 ms) placed 10 minutes into the 48 kHz media timeline: on daf6bea, 0.043 s
    expect(recordingSeconds('audio/mp4', at(0, 48_000 * 600))).toBeGreaterThanOrEqual(600);
    expect(recordingSeconds('audio/mp4', at(1, 48_000 * 600))).toBeGreaterThanOrEqual(600);
    expect(readVoiceRecording('audio/mp4', at(0, 48_000 * 600))!.durationSec).toBeGreaterThan(120); // past the caller's cap
    // a fragment at 0 is as long as its frames, as before
    expect(recordingSeconds('audio/mp4', at(0, 0))).toBeCloseTo((2 * 1024) / 48_000, 6);
  });

  it('P2: a tfdt that goes back is accepted, and the length is the furthest end and never less than the summed durations', () => {
    // a tfdt may go back, so runs can overlap on the media timeline; the parser does not refuse that, and the length
    // is the larger of where the timeline reached and the plain sum of every sample duration
    const timed = (rows: Array<[number, number]>, off: number) => fullBox('trun', 0, 0x000301, [be(rows.length, off), be(...rows.flat())]);
    const fragments = (runs: Array<{ at: number; seconds: number }>) => Buffer.concat([
      ftyp('iso5'),
      box('moov', [mvhd(), trak('soun', 1, []), box('mvex', trex(1))]),
      ...runs.flatMap(({ at, seconds }, i) => [fragment(i + 1, (o) => [tfhd(1), fullBox('tfdt', 0, 0, be(48_000 * at)), timed([[48_000 * seconds, 4]], o)]), mdat(4)]),
    ]);
    // a 1 s sample placed at 200 s, then a tfdt back to 0 and another 1 s sample: the timeline reached 201 s, so the
    // file is 201 s and the upload refuses it; read from the last end it would be 1 s (and the sum is 2 s)
    const back = fragments([{ at: 200, seconds: 1 }, { at: 0, seconds: 1 }]);
    expect(mp4(back)).toBe(true);
    expect(recordingSeconds('audio/mp4', back)).toBeGreaterThanOrEqual(201);
    expect(readVoiceRecording('audio/mp4', back)!.durationSec).toBeGreaterThan(120); // past the caller's cap
    // three fragments each at tfdt 0 with one 100 s sample overlap on the timeline (furthest end 100 s), but their
    // durations sum to 300 s, as daf6bea read them: the file is 300 s and the upload refuses it
    const overlapping = fragments([{ at: 0, seconds: 100 }, { at: 0, seconds: 100 }, { at: 0, seconds: 100 }]);
    expect(mp4(overlapping)).toBe(true);
    expect(recordingSeconds('audio/mp4', overlapping)).toBeGreaterThanOrEqual(300);
    expect(readVoiceRecording('audio/mp4', overlapping)!.durationSec).toBeGreaterThan(120);
  });

  it('pre-existing, same class as tfdt: mehd\'s movie length counts, at version 0 and 1', () => {
    // mehd's fragment_duration is the whole fragmented movie's length in the movie timescale (mvhd's 1,000 here): 600 s
    // over two AAC frames read 0.0427 s on e2cd3a7
    const long = (version: 0 | 1) => {
      const value = Buffer.alloc(version === 1 ? 8 : 4);
      if (version === 1) value.writeBigUInt64BE(600_000n);
      else value.writeUInt32BE(600_000);
      return fragmentedMp4({ mvex: [fullBox('mehd', version, 0, value)] });
    };
    for (const version of [0, 1] as const) {
      expect(recordingSeconds('audio/mp4', long(version))).toBeGreaterThanOrEqual(600);
      expect(readVoiceRecording('audio/mp4', long(version))!.durationSec).toBeGreaterThan(120);
    }
    // a mehd of 0 is the frames' length, as before
    expect(recordingSeconds('audio/mp4', fragmentedMp4({ mvex: [fullBox('mehd', 0, 0, Buffer.alloc(4))] }))).toBeCloseTo((2 * 1024) / 48_000, 6);
    // with no movie timescale, mehd's length cannot be read, so the file is refused
    const unscaled = fragmentedMp4({ mvex: [fullBox('mehd', 0, 0, be(600_000))] });
    const scaleAt = unscaled.indexOf('mvhd') + 4 + 12; // version and flags, creation and modification times
    unscaled.writeUInt32BE(0, scaleAt);
    expect(mp4(unscaled)).toBe(false);
  });

  it('pre-existing, same class as the empty frame: an MP4 sample of no bytes refuses the file, in moov or a fragment', () => {
    expect(mp4(plainMp4({ table: (off) => [stsd('mp4a'), stts(3), stsc(3), stsz([4, 4, 4]), stco(3, off)], mdatBytes: 12 }))).toBe(true);
    expect(mp4(plainMp4({ table: (off) => [stsd('mp4a'), stts(3), stsc(3), stsz([4, 0, 4]), stco(3, off)] }))).toBe(false);
    expect(mp4(fragmentedMp4({ traf: (off) => [tfhd(1), trun([4, 4, 4], off)], mdatBytes: 12 }))).toBe(true);
    expect(mp4(fragmentedMp4({ traf: (off) => [tfhd(1), trun([4, 0, 4], off)] }))).toBe(false);
    // a run on trex's or tfhd's default size of 0 beside a sized run: the file has bytes, so only the sample guard
    // refuses it (with the guard removed, both pass)
    expect(mp4(fragmentedMp4({ trex: trex(1, 0), traf: (off) => [tfhd(1), trun([4, 4], off), trun({ count: 1 }, off + 8)] }))).toBe(false);
    expect(mp4(fragmentedMp4({ trex: trex(1, 4), traf: (off) => [tfhd(1, 0), trun([4, 4], off), trun({ count: 1 }, off + 8)] }))).toBe(false);
  });

  it('pre-existing, same class as the empty frame: an empty Ogg packet adds nothing to the length', () => {
    // the length is the last granule position (less the pre-skip) or the samples the packets' TOC bytes give, the
    // larger; an empty packet has no TOC byte and counts no samples, and a page's granule position is the same claim
    // whatever its packets hold. So an empty packet cannot lengthen or shorten the file, and it is not refused here:
    // the voice web unit's real Firefox recordings decide whether Firefox writes one (RFC 6716 §3.4 R1 says a packet
    // is at least one byte)
    const sound = oggFile([AUDIO_PACKET, AUDIO_PACKET]);
    const gap = oggFile([AUDIO_PACKET, Buffer.alloc(0), AUDIO_PACKET]);
    expect(ogg(gap)).toBe(true);
    expect(recordingSeconds('audio/ogg', gap)).toBe(recordingSeconds('audio/ogg', sound));
    const granule = (file: Buffer) => {
      const page = file.lastIndexOf('OggS');
      return Buffer.concat([file.subarray(0, page), withGranule(file.subarray(page), 48_000n + BigInt(OPUS_PRE_SKIP))]);
    };
    expect(recordingSeconds('audio/ogg', granule(gap))).toBe(recordingSeconds('audio/ogg', granule(sound)));
  });

  it('audit: a trun whose samples take no bytes of their own is refused past the sample cap before any sample is read', () => {
    // with trex's default size and duration, a trun lists its samples in its count alone, so the cap applies to the
    // count before its samples are summed (the same class as P1). This pins the cap across runs; the next test pins
    // that the count is checked before the sum
    const runs = (counts: number[]) => fragmentedMp4({ trex: trex(1, 1), mdatBytes: counts.reduce((a, c) => a + c, 0),
      traf: (off) => [tfhd(1), ...counts.map((count, i) => trun({ count }, i === 0 ? off : off + counts.slice(0, i).reduce((a, c) => a + c, 0)))] });
    expect(mp4(runs([25_000, 25_000]))).toBe(true);
    expect(mp4(runs([50_000, 50_000]))).toBe(false);
    expect(mp4(runs([25_000, 25_001]))).toBe(false);
  });

  it('pre-existing, same class as P1: Ogg packets count against the step cap as each completes, empty ones too', () => {
    // pages of 255 empty audio packets after one sounding one: every packet completes with its own work, so 100,000
    // in a file are the cap. The Buffer allocations the parse makes are counted, not timed: on daf6bea a file of
    // 300,000 empty packets was accepted after an allocation or more per packet
    const empties = (n: number) => {
      const pages = [oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x00, 1, 1, OPUS_TAGS), oggPage(0x00, 1, 2, AUDIO_PACKET)];
      for (let left = n, seq = 3; left > 0; left -= 255, seq++) {
        pages.push(oggPage(left <= 255 ? 0x04 : 0x00, 1, seq, Array.from({ length: Math.min(255, left) }, () => Buffer.alloc(0))));
      }
      return Buffer.concat(pages);
    };
    const allocations = (parse: () => boolean) => {
      const alloc = Buffer.alloc;
      let n = 0;
      Buffer.alloc = function counted(...args: Parameters<typeof Buffer.alloc>) {
        n++;
        return alloc.apply(Buffer, args);
      };
      try {
        return { result: parse(), n };
      } finally {
        Buffer.alloc = alloc;
      }
    };
    expect(ogg(empties(99_990))).toBe(true); // headers, one sounding packet and the empties: under the cap
    expect(ogg(empties(100_000))).toBe(false);
    // the edge: the two header packets are steps too, so 99,998 audio packets (one sounding, 99,997 empty) are the most
    expect(ogg(empties(99_997))).toBe(true);
    expect(ogg(empties(99_998))).toBe(false);
    const file = empties(300_000);
    const many = allocations(() => ogg(file));
    expect(many.result).toBe(false);
    expect(many.n).toBeLessThan(110_000);
  });

  it('Ogg pages are capped at 100,000: a page completes no packet when it holds none, so pages are capped on their own', () => {
    const pages = (n: number) => {
      const out = [oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0x00, 1, 1, OPUS_TAGS), oggPage(0x00, 1, 2, AUDIO_PACKET)];
      for (let i = 0; i < n; i++) out.push(oggPage(i === n - 1 ? 0x04 : 0x00, 1, 3 + i, []));
      return Buffer.concat(out);
    };
    // with the three pages before them, 99,996 empty pages make 99,999, the most a walk reads to its end; 99,997 make
    // 100,000, and the walk stops at its cap before the end
    expect(ogg(pages(99_996))).toBe(true);
    expect(ogg(pages(99_997))).toBe(false);
  });

  it('pre-existing, same class as tfdt: a trun sample\'s composition offset counts in the length, at version 0 and 1', () => {
    // two 1 s samples, the second presented 600 s after its decode time (CT = DT + offset, ISO 14496-12 §8.6.1.1): a
    // player shows it ten minutes in, so the file is 602 s and the upload refuses it; 442d7d1 read 2 s
    const offsets = (version: 0 | 1, shifts: [number, number]) => fragmentedMp4({ traf: (off) => [tfhd(1),
      fullBox('trun', version, 0x000b01, [be(2, off), be(48_000, 4, shifts[0] >>> 0, 48_000, 4, shifts[1] >>> 0)])] });
    for (const version of [0, 1] as const) {
      const late = offsets(version, [0, 48_000 * 600]);
      expect(mp4(late)).toBe(true);
      expect(recordingSeconds('audio/mp4', late)).toBeCloseTo(602, 6); // the shifted sample's own second counts
      expect(readVoiceRecording('audio/mp4', late)!.durationSec).toBeGreaterThan(120);
      // offsets of 0 read the durations, as before
      expect(recordingSeconds('audio/mp4', offsets(version, [0, 0]))).toBeCloseTo(2, 6);
    }
    // a negative offset (version 1) presents a sample earlier; it cannot shorten the file below its durations
    expect(recordingSeconds('audio/mp4', offsets(1, [0, -24_000]))).toBeCloseTo(2, 6);
    // at version 0 the offset is unsigned: 2^31 ticks is over 44,000 s, never a negative shift
    expect(recordingSeconds('audio/mp4', offsets(0, [0, 2 ** 31]))).toBeGreaterThan(44_000);
    // a run tfdt places 600 s in, with a negative offset on its last sample: the length is still where the timeline
    // reaches, 602 s, not where the shifted sample is presented
    const placed = fragmentedMp4({ traf: (off) => [tfhd(1), fullBox('tfdt', 0, 0, be(48_000 * 600)),
      fullBox('trun', 1, 0x000b01, [be(2, off), be(48_000, 4, 0, 48_000, 4, -24_000 >>> 0)])] });
    expect(recordingSeconds('audio/mp4', placed)).toBeCloseTo(602, 6);
  });

  it('audit: a trun past the samples left is refused before any of its sample fields is read', () => {
    // a run of 25,000 default-sized samples, then one listing 25,001 sizes: daf6bea capped each run at 50,000, summed
    // the second run's 25,001 sizes and then refused; here its count is refused first. The 32-bit reads the parse makes
    // are counted, not timed
    const reads = (parse: () => boolean) => {
      const read = Buffer.prototype.readUInt32BE;
      let n = 0;
      Buffer.prototype.readUInt32BE = function counted(this: Buffer, offset?: number) {
        n++;
        return read.call(this, offset);
      };
      try {
        return { result: parse(), n };
      } finally {
        Buffer.prototype.readUInt32BE = read;
      }
    };
    const twoRuns = (second: number) => fragmentedMp4({ trex: trex(1, 1), mdatBytes: 25_000 + second,
      traf: (off) => [tfhd(1), trun({ count: 25_000 }, off), trun(Array.from({ length: second }, () => 1), off + 25_000)] });
    const fits = reads(() => mp4(twoRuns(25_000)));
    expect(fits.result).toBe(true);
    expect(fits.n).toBeGreaterThan(25_000); // the counter sees a run's sizes being read
    const over = reads(() => mp4(twoRuns(25_001)));
    expect(over.result).toBe(false);
    expect(over.n).toBeLessThan(1_000);
  });
});

describe('Codex round 2 on #1025: the length is where the last decodable sample ends, and nothing is left unfinished', () => {
  const ogg = (b: Buffer) => isAudioOnlyRecording('audio/ogg', b);
  const seconds = (mime: string, b: Buffer) => recordingSeconds(mime, b);
  const recording = (name: string) => readFileSync(join(__dirname, '..', '..', 'test', 'unit-support', 'recordings', name));
  /** a big-endian 32-bit word */
  const be4 = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n);
    return out;
  };
  /** Opus packets by their TOC byte: 20 ms (CELT, code 0), 60 ms (SILK, code 0) and 120 ms (SILK 60 ms, code 3 of 2) */
  const P20 = AUDIO_PACKET;
  const P60 = Buffer.from([0x18, 0x00]);
  const P120 = Buffer.from([0x1b, 0x02, 0x00]);
  /** a WebM with no Duration, its one unknown-size Cluster at `at` ticks of `scale` ns holding `blocks`, and any `entry` fields on the track */
  const webmAt = (at: number, blocks: Buffer[], o: { scale?: number; entry?: Buffer[] } = {}) => {
    const info = ebml(WEBM.info, ebml(0x2ad7b1, be4(o.scale ?? 1_000_000)));
    const entry = ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, Buffer.from([1])), ebml(WEBM.trackType, Buffer.from([2])),
      ebml(WEBM.codecId, 'A_OPUS'), ebml(WEBM.codecPrivate, OPUS_HEAD), ...(o.entry ?? [])]));
    const cluster = ebml(WEBM.cluster, Buffer.concat([ebml(WEBM.timestamp, be4(at)), ...blocks]), true);
    return Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([info, ebml(WEBM.tracks, entry), cluster]), true)]);
  };

  it('P2-a: a WebM block ends where its frames end, not where it starts', () => {
    // one unlaced 120 ms packet at 120.4 s ends at 120.52 s, stored as 121 s, which the upload refuses; 89ae0ae read
    // 120.4 s (the block's start) and stored 120
    const late = webmAt(120_400, [simpleBlock(1, P120)]);
    expect(seconds('audio/webm', late)).toBeCloseTo(120.52, 6);
    expect(readVoiceRecording('audio/webm', late)?.durationSec).toBe(121);
    // the timestamp is in ticks of the TimestampScale, the frames in Opus samples: the same block in ticks of 100 µs
    expect(seconds('audio/webm', webmAt(1_204_000, [simpleBlock(1, P120)], { scale: 100_000 }))).toBeCloseTo(120.52, 6);
    // a 60 ms packet at 0.47 s ends at 0.53 s and is stored as 1 s (89ae0ae read 0.47 s and refused it as under half a second)
    expect(seconds('audio/webm', webmAt(470, [simpleBlock(1, P60)]))).toBeCloseTo(0.53, 6);
    expect(readVoiceRecording('audio/webm', webmAt(470, [simpleBlock(1, P60)]))?.durationSec).toBe(1);
    // a block at 0 reads its frames, as before
    expect(seconds('audio/webm', webmAt(0, [simpleBlock(1, P60)]))).toBeCloseTo(0.06, 6);
  });

  it('P2-a: a laced block ends where its last laced frame ends, in every lacing', () => {
    // Codex's example: 256 fixed-size laced 120 ms packets at 120 s, no Duration, play to 150.72 s (89ae0ae read 120 s)
    const fixed = lacedBlock(1, 2, 256, Buffer.alloc(0), Buffer.concat(Array.from({ length: 256 }, () => P120)));
    const codex = webmAt(120_000, [fixed]);
    expect(seconds('audio/webm', codex)).toBeCloseTo(150.72, 6);
    expect(readVoiceRecording('audio/webm', codex)?.durationSec).toBe(151);
    // three 120 ms packets at 120 s end at 120.36 s in Xiph lacing (3, 3, then the 3 left) and EBML lacing (3, +0)
    const three = Buffer.concat([P120, P120, P120]);
    expect(seconds('audio/webm', webmAt(120_000, [lacedBlock(1, 1, 3, Buffer.from([3, 3]), three)]))).toBeCloseTo(120.36, 6);
    expect(seconds('audio/webm', webmAt(120_000, [lacedBlock(1, 3, 3, Buffer.from([0x83, 0xbf]), three)]))).toBeCloseTo(120.36, 6);
  });

  it('pre-existing, same class as P2-a: a BlockGroup\'s BlockDuration counts in where its block ends', () => {
    const group = (ticks: number) => ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, blockBody(1, P20)), ebml(0x9b, be4(ticks))]));
    // a 20 ms frame at 100 s that its BlockDuration says lasts 30 s ends at 130 s (89ae0ae read 100 s)
    expect(seconds('audio/webm', webmAt(100_000, [group(30_000)]))).toBeCloseTo(130, 6);
    // BlockDuration is in ticks of the TimestampScale
    expect(seconds('audio/webm', webmAt(1_000_000, [group(300_000)], { scale: 100_000 }))).toBeCloseTo(130, 6);
    // a BlockDuration shorter than the frame never shortens it: the frame's 20 ms
    expect(seconds('audio/webm', webmAt(100_000, [group(0)]))).toBeCloseTo(100.02, 6);
  });

  it('pre-existing, same class as P2-a: the track\'s DefaultDuration counts for every frame of a block', () => {
    const thirty = lacedBlock(1, 2, 30, Buffer.alloc(0), Buffer.concat(Array.from({ length: 30 }, () => P20)));
    const each = (ns: number) => [ebml(0x23e383, be4(ns))];
    // 30 laced 20 ms packets at 100 s that the track says last 1 s a frame end at 130 s (89ae0ae read 100 s)
    expect(seconds('audio/webm', webmAt(100_000, [thirty], { entry: each(1_000_000_000) }))).toBeCloseTo(130, 6);
    // at 20 ms a frame, or with no DefaultDuration, they end where their frames do: 100.6 s
    expect(seconds('audio/webm', webmAt(100_000, [thirty], { entry: each(20_000_000) }))).toBeCloseTo(100.6, 6);
    expect(seconds('audio/webm', webmAt(100_000, [thirty]))).toBeCloseTo(100.6, 6);
  });

  it('P2-b: an Ogg packet left open at the end of the file refuses it, with or without the end-of-stream flag', () => {
    const heads = Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 1, 1, OPUS_TAGS)]);
    const granule = (n: number) => BigInt(OPUS_PRE_SKIP + 960 * n);
    // Codex's example: 25 finished 20 ms packets, then 255 bytes of a 26th the file never finishes. 89ae0ae stored it
    // as 1 s (0.5 s rounded)
    const lacing = [...Array.from({ length: 25 }, () => P20.length), 255];
    const data = Buffer.concat([...Array.from({ length: 25 }, () => P20), Buffer.alloc(255, 0xfc)]);
    for (const type of [0x00, 0x04]) expect(ogg(Buffer.concat([heads, withGranule(oggPageRaw(type, 1, 2, lacing, data), granule(25))]))).toBe(false);
    // the 25 packets alone, finished, pass: 0.5 s, stored as 1 s
    const finished = Buffer.concat([heads, withGranule(oggPage(0x04, 1, 2, Array.from({ length: 25 }, () => P20)), granule(25))]);
    expect(seconds('audio/ogg', finished)).toBeCloseTo(0.5, 6);
    // an empty page after the open one continues it but finishes nothing: still open at the end
    const open = withGranule(oggPageRaw(0, 1, 2, [P20.length, 255], Buffer.concat([P20, Buffer.alloc(255, 0xfc)])), granule(1));
    expect(ogg(Buffer.concat([heads, open, withGranule(oggPageRaw(0x05, 1, 3, [], Buffer.alloc(0)), granule(1))]))).toBe(false);
    // the same packet finished on the next page passes
    expect(ogg(Buffer.concat([heads, open, withGranule(oggPageRaw(0x05, 1, 3, [10], Buffer.alloc(10, 1)), granule(2))]))).toBe(true);
  });

  it('audit: a recording cut short inside an element, page or box is refused; cut at a boundary it is a whole, shorter one', () => {
    const cuts = (mime: string, file: Buffer, from: number) => {
      const accepted: Array<{ at: number; seconds: number }> = [];
      for (let at = from; at < file.length; at++) {
        const s = seconds(mime, file.subarray(0, at));
        if (s !== null) accepted.push({ at, seconds: s });
      }
      return accepted;
    };
    // Chromium's WebM (unknown-size Segment and Clusters, 60 ms SimpleBlocks): over its last 4,000 bytes, a cut is read
    // only where a SimpleBlock begins, as the blocks before it, 60 ms apart; anywhere inside an element it is refused
    const chromeWebm = recording('chromium-141-opus.webm');
    const w = cuts('audio/webm', chromeWebm, chromeWebm.length - 4_000);
    expect(w.length).toBeGreaterThan(2);
    for (const c of w) expect(chromeWebm[c.at]).toBe(WEBM.simpleBlock);
    for (let i = 1; i < w.length; i++) expect(w[i]!.seconds - w[i - 1]!.seconds).toBeCloseTo(0.06, 6);
    // Chromium's fragmented MP4: a cut anywhere in its last 4,000 bytes (inside its last fragment) is refused
    const chromeMp4 = recording('chromium-141-opus.mp4');
    expect(cuts('audio/mp4', chromeMp4, chromeMp4.length - 4_000)).toEqual([]);
    // an Ogg of three audio pages: read only where a page ends, as the pages before it
    const pages = [oggPage(0x02, 1, 0, OPUS_HEAD), oggPage(0, 1, 1, OPUS_TAGS), ...[1, 2, 3].map((k) =>
      withGranule(oggPage(k === 3 ? 0x04 : 0, 1, 1 + k, [P20, P20]), BigInt(OPUS_PRE_SKIP + 1920 * k)))];
    const o = Buffer.concat(pages);
    const ends = pages.map((_, i) => Buffer.concat(pages.slice(0, i + 1)).length);
    expect(cuts('audio/ogg', o, 1)).toEqual([{ at: ends[2], seconds: 0.04 }, { at: ends[3], seconds: 0.08 }]);
    expect(seconds('audio/ogg', o)).toBeCloseTo(0.12, 6);
  });
});
