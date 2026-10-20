import { describe, it, expect } from 'vitest';
import { isAudioOnlyRecording } from './voice-container';
import {
  box, ebml, ftyp, mp4File, mp4VideoOnly, oggFile, oggPage, oggVideoOnly, OPUS_HEAD, THEORA_ID, VORBIS_ID, trak,
  WEBM, webmCluster, webmFile, webmHeader, webmTrack, webmVideoOnly,
} from '../../test/unit-support/voice-files';

/** Stage 1 voice (#482, Codex P2 on #1010): only an audio-only recording in the container its type names passes. */
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

  it('passes a voice recording in each container', () => {
    expect(webm(webmFile())).toBe(true);
    expect(webm(webmFile([webmTrack(1, 2, 'A_VORBIS')]))).toBe(true);
    expect(ogg(oggFile())).toBe(true);
    expect(ogg(oggFile([VORBIS_ID]))).toBe(true);
    expect(mp4(mp4File())).toBe(true);
  });

  it('refuses the container signature alone, which the first check passed', () => {
    expect(webm(signatureOnly.webm)).toBe(false);
    expect(ogg(signatureOnly.ogg)).toBe(false);
    expect(mp4(signatureOnly.mp4)).toBe(false);
  });

  it('refuses a video-only file, and one with a picture track beside the sound, in each container', () => {
    expect(webm(webmVideoOnly())).toBe(false);
    expect(webm(webmFile([webmTrack(1, 2, 'A_OPUS'), webmTrack(2, 1, 'V_VP8')]))).toBe(false);
    expect(ogg(oggVideoOnly())).toBe(false);
    expect(ogg(oggFile([OPUS_HEAD, THEORA_ID]))).toBe(false);
    expect(mp4(mp4VideoOnly())).toBe(false);
    expect(mp4(mp4File(['soun', 'vide']))).toBe(false);
  });

  it('refuses a file of another container sent under an audio type', () => {
    expect(webm(oggFile())).toBe(false);
    expect(ogg(webmFile())).toBe(false);
    expect(mp4(webmFile())).toBe(false);
    // an HEIC photo is ISO BMFF with ftyp at offset 4, and has no sound track
    expect(mp4(Buffer.concat([ftyp('heic'), box('meta', Buffer.alloc(16)), box('mdat', Buffer.alloc(8))]))).toBe(false);
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
    expect(webm(Buffer.concat([webmHeader(), ebml(WEBM.segment, Buffer.concat([ebml(WEBM.tracks, webmTrack(1, 2, 'A_OPUS')), voids]), true)]))).toBe(false);
  });

  it('Ogg: whole pages to the last byte, a data page after the headers, and a chained video stream refused', () => {
    expect(ogg(oggPage(0x02, 1, 0, OPUS_HEAD))).toBe(false); // headers only, no sound
    expect(ogg(Buffer.concat([oggFile(), Buffer.from('junk')]))).toBe(false);
    const good = oggFile();
    expect(ogg(good.subarray(0, good.length - 1))).toBe(false);
    expect(ogg(Buffer.concat([oggPage(0x00, 1, 0, Buffer.from([1])), oggFile()]))).toBe(false); // data before any stream
    expect(ogg(Buffer.concat([oggFile(), oggFile([THEORA_ID])]))).toBe(false); // a second, chained stream of video
    expect(ogg(Buffer.concat([oggPage(0x02, 1, 0, OPUS_HEAD.subarray(0, 12)), oggPage(0, 1, 1, Buffer.from([1]))]))).toBe(false); // a cut head
  });

  it('MP4: size 0 runs to the end, size 1 is a 64-bit size, and a box smaller than its header or past its parent fails', () => {
    const toEnd = Buffer.concat([ftyp(), box('moov', trak('soun')), Buffer.from([0, 0, 0, 0]), Buffer.from('mdat'), Buffer.alloc(16, 7)]);
    expect(mp4(toEnd)).toBe(true);
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(20n, 8);
    expect(mp4(Buffer.concat([ftyp(), box('moov', trak('soun')), large, Buffer.alloc(4)]))).toBe(true);
    large.writeBigUInt64BE(2n ** 62n, 8);
    expect(mp4(Buffer.concat([ftyp(), box('moov', trak('soun')), large, Buffer.alloc(4)]))).toBe(false);
    const tiny = Buffer.from([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]); // size 4 < its own 8-byte header
    expect(mp4(Buffer.concat([ftyp(), tiny, box('moov', trak('soun'))]))).toBe(false);
    const good = mp4File();
    expect(mp4(good.subarray(0, good.length - 2))).toBe(false);
    expect(mp4(Buffer.concat([box('moov', trak('soun')), ftyp()]))).toBe(false); // ftyp comes first
  });

  it('MP4: every track names its handler, and a short hdlr fails', () => {
    expect(mp4(Buffer.concat([ftyp(), box('moov', box('trak', box('mdia', box('minf'))))]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp(), box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(6)))))]))).toBe(false);
    expect(mp4(Buffer.concat([ftyp(), box('moov', [trak('soun'), trak('meta')])]))).toBe(true); // a metadata track carries no picture
    expect(mp4(Buffer.concat([ftyp(), box('free')]))).toBe(false); // no moov
  });

  it('MP4: the walk is capped, so a file of endless empty boxes is refused rather than walked', () => {
    const empties = Buffer.concat(Array.from({ length: 100_001 }, () => box('free')));
    expect(mp4(Buffer.concat([ftyp(), empties, box('moov', trak('soun'))]))).toBe(false);
  });
});
