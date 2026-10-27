import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { clipSeconds, readVideoClip } from './video-container';
import { readVoiceRecording } from './voice-container';
import {
  WEBM, box, ebml, fullBox, ftyp, mp4File, mp4Fragmented, mvhd, sampleEntry, simpleBlock, trak, webmCluster, webmClusterAt, webmFile, webmInfo, webmTrack,
} from '../../test/unit-support/voice-files';
import {
  AVCC_BODY, CLIP_WEBM, NAL_SAMPLE, avcC, btrt, clipFragmented, clipMp4, clipWebm, clipWebmTimed, colr, fixedTable, mfra, mfraFor, SMHD_BOX, VMHD_BOX, moofOf, pasp, pictureBlock,
  pictureTrack, pictureTrak, silentClipWebm, soundTrack, soundTrakOpus, tfhdMoof, tfra, trakOf, trunTimed, videoElement, visualEntry, visualFields, vpcC,
} from '../../test/unit-support/video-files';

/**
 * Stage 1 video on site visits (#995): only a video clip, with a picture in it, in the container its type names passes,
 * and its length is the file's own.
 */
const webm = (b: Buffer) => clipSeconds('video/webm', b);
const mp4 = (b: Buffer) => clipSeconds('video/mp4', b);
const recording = (name: string) => readFileSync(join(__dirname, '..', '..', 'test', 'unit-support', 'recordings', name));
const u32 = (...values: number[]) => {
  const out = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => out.writeUInt32BE(v >>> 0, 4 * i));
  return out;
};
const uint = (n: number) => Buffer.from([n]);

describe('readVideoClip — real recordings', () => {
  it('passes Chromium 153\'s camera recordings, WebM (VP8 with Opus, VP9 alone) and MP4 (H.264 with Opus, VP9 with Opus), at their own 2 s', () => {
    for (const [name, mime] of [
      ['chromium-153-vp8-opus.webm', 'video/webm'], ['chromium-153-vp9.webm', 'video/webm'],
      ['chromium-153-avc1-opus.mp4', 'video/mp4'], ['chromium-153-vp9-opus.mp4', 'video/mp4'],
    ] as const) {
      const clip = readVideoClip(mime, recording(name));
      expect(clip, name).not.toBeNull();
      expect(clip!.durationSec, name).toBe(2);
      expect(clip!.seconds, name).toBeGreaterThan(1.8);
      expect(clip!.seconds, name).toBeLessThan(2.1);
    }
  });

  it('refuses each recording under the other type, as a voice note, and Chrome\'s Matroska H.264 under video/webm', () => {
    expect(clipSeconds('video/mp4', recording('chromium-153-vp8-opus.webm'))).toBeNull();
    expect(clipSeconds('video/webm', recording('chromium-153-avc1-opus.mp4'))).toBeNull();
    for (const name of ['chromium-153-vp8-opus.webm', 'chromium-153-vp9.webm']) expect(readVoiceRecording('audio/webm', recording(name))).toBeNull();
    for (const name of ['chromium-153-avc1-opus.mp4', 'chromium-153-vp9-opus.mp4']) expect(readVoiceRecording('audio/mp4', recording(name))).toBeNull();
    // Chrome names `video/webm;codecs=h264` as video/x-matroska, DocType matroska
    expect(clipSeconds('video/webm', recording('chromium-153-h264-opus.mkv'))).toBeNull();
  });

  it('refuses a voice note as a video: a clip has a picture', () => {
    expect(clipSeconds('video/webm', recording('chromium-141-opus.webm'))).toBeNull();
    expect(clipSeconds('video/mp4', recording('chromium-141-opus.mp4'))).toBeNull();
    expect(webm(webmFile())).toBeNull();
    expect(mp4(mp4File(['soun'], 'isom'))).toBeNull();
    expect(mp4(mp4Fragmented())).toBeNull();
  });

  it('refuses other types and the container signature alone', () => {
    expect(clipSeconds('video/quicktime', clipMp4())).toBeNull();
    expect(clipSeconds('audio/webm', clipWebm())).toBeNull();
    expect(webm(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 1)]))).toBeNull();
    expect(mp4(Buffer.concat([u32(0x20), Buffer.from('ftypisom'), Buffer.alloc(32, 1)]))).toBeNull();
  });
});

describe('readVideoClip — WebM', () => {
  it('passes the shapes Chrome writes: picture and sound, picture alone, VP9, a sized Cluster', () => {
    expect(webm(clipWebm())).not.toBeNull();
    expect(webm(silentClipWebm())).not.toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP9'), soundTrack()] }))).not.toBeNull();
    expect(webm(clipWebm({ clusters: [webmCluster([pictureBlock()], false)] }))).not.toBeNull();
    // the sound track first, as Chrome writes a VP9 recording
    expect(webm(clipWebm({ tracks: [soundTrack(1), pictureTrack(2)], clusters: [webmCluster([pictureBlock(2), simpleBlock(1)])] }))).not.toBeNull();
  });

  it('a clip has exactly one picture track and at most one sound track, with distinct numbers', () => {
    expect(webm(clipWebm({ tracks: [soundTrack(1)], clusters: [webmCluster([simpleBlock(1)])] }))).toBeNull(); // sound alone
    expect(webm(clipWebm({ tracks: [pictureTrack(1), pictureTrack(2)] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1), soundTrack(2), soundTrack(3)] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1), soundTrack(1)] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [soundTrack(1), pictureTrack(1)], clusters: [webmCluster([pictureBlock(1)])] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1), soundTrack(), webmTrack(3, 17, 'S_TEXT/UTF8')] }))).toBeNull(); // subtitles
    expect(webm(clipWebm({ tracks: [] }))).toBeNull();
  });

  it('only a picture block makes a clip: a picture track whose blocks are all sound is refused', () => {
    expect(webm(clipWebm({ clusters: [webmCluster([simpleBlock(2), simpleBlock(2)])] }))).toBeNull();
    expect(webm(clipWebm({ clusters: [] }))).toBeNull();
    expect(webm(clipWebm({ clusters: [webmCluster([pictureBlock(), simpleBlock(3)])] }))).toBeNull(); // a track not listed
    expect(webm(clipWebm({ clusters: [webmCluster([simpleBlock(1, Buffer.alloc(0))])] }))).toBeNull(); // an empty frame
  });

  it('the picture is VP8 or VP9, in a WebM', () => {
    for (const codec of ['V_AV1', 'V_MPEG4/ISO/AVC', 'V_THEORA', 'V_VP10', 'A_OPUS']) {
      expect(webm(clipWebm({ tracks: [pictureTrack(1, codec), soundTrack()] })), codec).toBeNull();
    }
    expect(webm(clipWebm({ docType: 'matroska' }))).toBeNull();
    // the sound is Opus, read as a voice note's: Vorbis, and an Opus track with no OpusHead, are refused
    expect(webm(clipWebm({ tracks: [pictureTrack(), webmTrack(2, 2, 'A_VORBIS')] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(), ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, uint(2)), ebml(WEBM.trackType, uint(2)), ebml(WEBM.codecId, 'A_OPUS')]))] }))).toBeNull();
  });

  it('each track holds only the fields of its type, and the picture has a size', () => {
    const head = (extra: Buffer[]) => [videoElement(), ...extra];
    // a picture track with a sound track's fields
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', head([ebml(WEBM.codecPrivate, Buffer.from([1, 2]))])), soundTrack()] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', head([ebml(0x56aa, uint(0))])), soundTrack()] }))).toBeNull(); // CodecDelay
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', head([ebml(0xe1, ebml(0x9f, uint(1)))])), soundTrack()] }))).toBeNull(); // Audio
    // a sound track with a picture's
    const opus = (extra: Buffer[]) => ebml(WEBM.trackEntry, Buffer.concat([ebml(WEBM.trackNumber, uint(2)), ebml(WEBM.trackType, uint(2)), ebml(WEBM.codecId, 'A_OPUS'),
      ebml(WEBM.codecPrivate, Buffer.from('4f707573486561640101380180bb0000000000', 'hex')), ...extra]));
    expect(webm(clipWebm({ tracks: [pictureTrack(), opus([])] }))).not.toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(), opus([videoElement()])] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(), opus([ebml(CLIP_WEBM.maxBlockAdditionId, uint(1))])] }))).toBeNull();
    // no Video, a size of 0, a size missing, a field the Video element does not list, Colour fields
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', []), soundTrack()] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', [videoElement(0, 240)]), soundTrack()] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', [ebml(CLIP_WEBM.video, ebml(CLIP_WEBM.pixelWidth, uint(16)))]), soundTrack()] }))).toBeNull();
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', [videoElement(320, 240, [ebml(0x53b8, uint(1))])]), soundTrack()] }))).toBeNull(); // StereoMode
    const colour = (fields: Buffer[]) => [pictureTrack(1, 'V_VP8', [videoElement(320, 240, [ebml(CLIP_WEBM.colour, Buffer.concat(fields))])]), soundTrack()];
    expect(webm(clipWebm({ tracks: colour([ebml(0x55b1, uint(1)), ebml(0x55b9, uint(2)), ebml(0x55ba, uint(13)), ebml(0x55bb, uint(1))]) }))).not.toBeNull(); // Chrome's
    expect(webm(clipWebm({ tracks: colour([ebml(0x55d0, ebml(0x55d1, Buffer.alloc(4)))]) }))).toBeNull(); // MasteringMetadata
    expect(webm(clipWebm({ tracks: colour([ebml(0x55b1, Buffer.alloc(9))]) }))).toBeNull(); // an integer of 9 bytes
    // flags as for a voice note: a disabled picture track is refused
    expect(webm(clipWebm({ tracks: [pictureTrack(1, 'V_VP8', head([ebml(0xb9, uint(0))])), soundTrack()] }))).toBeNull();
  });

  it('BlockAdditions (an alpha channel) are refused, as every BlockGroup child but the voice ones', () => {
    const block = ebml(WEBM.block, Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), Buffer.from([1, 2, 3])]));
    expect(webm(clipWebm({ clusters: [webmCluster([ebml(WEBM.blockGroup, block)])] }))).not.toBeNull();
    const additions = ebml(CLIP_WEBM.blockAdditions, ebml(0xa6, Buffer.concat([ebml(0xee, uint(1)), ebml(0xa5, Buffer.from([1, 2, 3]))])));
    expect(webm(clipWebm({ clusters: [webmCluster([ebml(WEBM.blockGroup, Buffer.concat([block, additions]))])] }))).toBeNull();
  });

  it('the length is the longest of Info\'s Duration and where the latest block ends, picture or sound', () => {
    expect(webm(clipWebmTimed(42))).toBe(42);
    // a picture block at 59.6 s, with no Duration
    expect(webm(clipWebm({ clusters: [webmClusterAt(0, [pictureBlock()]), webmClusterAt(59_600, [pictureBlock()])] }))).toBeCloseTo(59.6, 6);
    // a picture block's BlockDuration counts, as a sound block's does
    const lasting = ebml(WEBM.blockGroup, Buffer.concat([ebml(WEBM.block, Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), Buffer.from([1, 2, 3])])), ebml(CLIP_WEBM.blockDuration, Buffer.from([0x75, 0x30]))]));
    expect(webm(clipWebm({ clusters: [webmClusterAt(40_000, [lasting])] }))).toBeCloseTo(70, 6);
    // and the picture track's DefaultDuration, a frame
    const timed = pictureTrack(1, 'V_VP8', [videoElement(), ebml(CLIP_WEBM.defaultDuration, u32(1_000_000_000))]);
    expect(webm(clipWebm({ tracks: [timed, soundTrack()], clusters: [webmClusterAt(60_000, [pictureBlock()])] }))).toBeCloseTo(61, 6);
    // a sound block is timed by its Opus frames, as a voice note's: 120 ms of laced frames end after the picture
    expect(webm(clipWebm({ clusters: [webmClusterAt(1_000, [pictureBlock(), simpleBlock(2, Buffer.from([0xfc, 0xff, 0xfe]))])] }))).toBeCloseTo(1.02, 6);
    expect(webm(clipWebm({ info: webmInfo(), clusters: [webmClusterAt(0, [pictureBlock()])] }))).toBe(0);
    // and never less than all its Opus frames together: 100 sound blocks of 20 ms, every one placed at 0, are 2 s
    const stacked = Array.from({ length: 100 }, () => simpleBlock(2, Buffer.from([0xfc, 0xff, 0xfe])));
    expect(webm(clipWebm({ clusters: [webmClusterAt(0, [pictureBlock(), ...stacked])] }))).toBeCloseTo(2, 6);
  });

  it('rounds the length to whole seconds and refuses one that rounds to none', () => {
    expect(readVideoClip('video/webm', clipWebmTimed(59.4))).toEqual({ seconds: 59.4, durationSec: 59 });
    expect(readVideoClip('video/webm', clipWebmTimed(60.5))).toEqual({ seconds: 60.5, durationSec: 61 }); // the caller refuses it
    expect(readVideoClip('video/webm', clipWebmTimed(0.5))).toEqual({ seconds: 0.5, durationSec: 1 });
    expect(readVideoClip('video/webm', clipWebmTimed(0.4))).toBeNull();
  });
});

describe('readVideoClip — WebM frames', () => {
  it('Codex round 1 on #1158: caps every track\'s frames together at 50,000, as an MP4\'s samples are', () => {
    const opus = Buffer.from([0xfc, 0xff, 0xfe]); // 20 ms
    const build = (pictures: number, sounds: number) => clipWebm({
      tracks: [pictureTrack(), soundTrack()],
      clusters: [webmCluster([
        ...Array.from({ length: pictures }, () => pictureBlock()),
        ...Array.from({ length: sounds }, () => simpleBlock(2, opus)),
      ])],
    });
    expect(webm(build(25_000, 25_000))).not.toBeNull();
    expect(webm(build(25_000, 25_001))).toBeNull();
    expect(webm(build(50_001, 0))).toBeNull();
  });
});

describe('readVideoClip — MP4', () => {
  it('passes the shapes Chrome and iOS write: plain with AAC sound, picture alone, VP9, fragmented with Opus and its mfra', () => {
    expect(mp4(clipMp4())).not.toBeNull();
    expect(mp4(clipMp4({ sound: false }))).not.toBeNull();
    expect(mp4(clipMp4({ entry: visualEntry('vp09'), sample: Buffer.from([0x82, 0x49, 0x83]) }))).not.toBeNull();
    expect(mp4(clipFragmented())).not.toBeNull();
    expect(mp4(clipFragmented({ index: false }))).not.toBeNull();
  });

  it('brands: the voice note\'s MP4 brands but M4A, with avc1, vp09 and M4V', () => {
    for (const brand of ['isom', 'mp42', 'iso6', 'avc1', 'vp09', 'M4V ']) expect(mp4(clipMp4({ brand })), brand).not.toBeNull();
    for (const brand of ['M4A ', 'qt  ', 'heic', '3gp4', 'XXXX']) expect(mp4(clipMp4({ brand })), brand).toBeNull();
  });

  it('exactly one picture track and at most one sound track, each with its own media header', () => {
    const laid = (traks: (offset: number) => Buffer[], payload: Buffer[]) => {
      const head = (o: number) => Buffer.concat([ftyp('isom'), box('moov', [mvhd(), ...traks(o)])]);
      return Buffer.concat([head(head(0).length + 8), box('mdat', payload)]);
    };
    const n = NAL_SAMPLE.length;
    // two pictures, and a picture with two sounds
    expect(mp4(laid((o) => [pictureTrak(1, [n], o), pictureTrak(2, [n], o + n)], [NAL_SAMPLE, NAL_SAMPLE]))).toBeNull();
    expect(mp4(laid((o) => [pictureTrak(1, [n], o), trak('soun', 2, [4], o + n), trak('soun', 3, [4], o + n + 4)], [NAL_SAMPLE, Buffer.alloc(8, 7)]))).toBeNull();
    // one track id twice
    expect(mp4(laid((o) => [pictureTrak(1, [n], o), trak('soun', 1, [4], o + n)], [NAL_SAMPLE, Buffer.alloc(4, 7)]))).toBeNull();
    // other handlers: an auxiliary picture, a text track, a hint track
    for (const handler of ['auxv', 'text', 'hint', 'meta']) {
      expect(mp4(laid((o) => [pictureTrak(1, [n], o), trak(handler, 2, [4], o + n)], [NAL_SAMPLE, Buffer.alloc(4, 7)])), handler).toBeNull();
    }
    expect(mp4(laid((o) => [pictureTrak(1, [n], o)], [NAL_SAMPLE]))).not.toBeNull();
    // a picture track with a sound media header, with none, or with vmhd's flag not set; a sound track with vmhd
    expect(mp4(laid((o) => [pictureTrak(1, [n], o, { vmhd: fullBox('smhd', 0, 0, u32(0)) })], [NAL_SAMPLE]))).toBeNull();
    expect(mp4(laid((o) => [pictureTrak(1, [n], o, { vmhd: fullBox('vmhd', 0, 0, Buffer.alloc(8)) })], [NAL_SAMPLE]))).toBeNull();
    expect(mp4(laid((o) => [pictureTrak(1, [n], o, { vmhd: fullBox('vmhd', 0, 1, Buffer.alloc(9)) })], [NAL_SAMPLE]))).toBeNull();
    // a picture track with a sound media header too, and a sound track with a picture's
    expect(mp4(laid((o) => [pictureTrak(1, [n], o, { vmhd: Buffer.concat([VMHD_BOX, SMHD_BOX]) })], [NAL_SAMPLE]))).toBeNull();
    const aac = (o: number) => fixedTable(sampleEntry('mp4a'), 1, 4, o, 1024);
    expect(mp4(laid((o) => [pictureTrak(1, [n], o), trakOf('soun', 2, aac(o + n))], [NAL_SAMPLE, Buffer.alloc(4, 7)]))).not.toBeNull();
    expect(mp4(laid((o) => [pictureTrak(1, [n], o), trakOf('soun', 2, aac(o + n), [SMHD_BOX, VMHD_BOX])], [NAL_SAMPLE, Buffer.alloc(4, 7)]))).toBeNull();
    // a track of another handler shaped as a sound track in every other way (a text or subtitle track)
    for (const handler of ['text', 'sbtl', 'subt']) {
      expect(mp4(laid((o) => [pictureTrak(1, [n], o), trakOf(handler, 2, aac(o + n), [SMHD_BOX])], [NAL_SAMPLE, Buffer.alloc(4, 7)])), handler).toBeNull();
    }
    // one track id twice, the picture second
    expect(mp4(laid((o) => [trakOf('soun', 1, aac(o + n)), pictureTrak(1, [n], o)], [NAL_SAMPLE, Buffer.alloc(4, 7)]))).toBeNull();
    // every mdat byte is some track's sample
    expect(mp4(laid((o) => [pictureTrak(1, [n], o)], [NAL_SAMPLE, Buffer.from([0])]))).toBeNull();
    // no picture samples at all, with sound
    expect(mp4(laid((o) => [pictureTrak(1, [], o), trak('soun', 2, [4], o)], [Buffer.alloc(4, 7)]))).toBeNull();
  });

  it('the visual sample entry is read whole, as ISO 14496-12 defines it', () => {
    const entry = (fields: Buffer, kids?: Buffer[], type = 'avc1') => mp4(clipMp4({ entry: visualEntry(type, kids, fields) }));
    expect(entry(visualFields())).not.toBeNull();
    expect(entry(visualFields({ revision: 0 }))).not.toBeNull();
    expect(entry(visualFields({ revision: 2 }))).toBeNull();
    expect(entry(visualFields({ width: 0 }))).toBeNull();
    expect(entry(visualFields({ height: 0 }))).toBeNull();
    expect(entry(visualFields({ name: '' }))).not.toBeNull();
    const at = (offset: number, value: number, width = 2) => {
      const f = visualFields();
      if (width === 1) f[offset] = value;
      else if (width === 2) f.writeUInt16BE(value, offset);
      else f.writeUInt32BE(value, offset);
      return f;
    };
    expect(entry(at(0, 1, 1))).toBeNull(); // reserved
    expect(entry(at(6, 2))).toBeNull(); // data_reference_index
    expect(entry(at(8, 1))).toBeNull(); // pre_defined
    expect(entry(at(16, 1, 1))).toBeNull(); // pre_defined[3]
    expect(entry(at(28, 0x00960000, 4))).toBeNull(); // 150 dpi
    expect(entry(at(36, 1, 4))).toBeNull(); // reserved
    expect(entry(at(40, 2))).toBeNull(); // two frames a sample
    expect(entry(at(42, 32, 1))).toBeNull(); // a compressor name of 32 bytes
    expect(entry(at(60, 1, 1))).toBeNull(); // a byte after the name
    expect(entry(at(74, 0x20))).toBeNull(); // depth 32
    expect(entry(at(76, 0))).toBeNull(); // pre_defined 0
    // the entry's boxes: one avcC (two, none, or a vpcC in avc1 refused), at most one pasp, btrt and colr, nothing else
    expect(entry(visualFields(), [avcC()])).not.toBeNull();
    expect(entry(visualFields(), [])).toBeNull();
    expect(entry(visualFields(), [avcC(), avcC()])).toBeNull();
    expect(entry(visualFields(), [avcC(), vpcC()])).toBeNull();
    expect(entry(visualFields(), [avcC(), pasp(), pasp()])).toBeNull();
    for (const kid of [box('clap', Buffer.alloc(32)), box('fiel', Buffer.from([1, 0])), box('uuid', Buffer.alloc(16)), box('free', Buffer.alloc(4))]) {
      expect(entry(visualFields(), [avcC(), kid])).toBeNull();
    }
    expect(entry(visualFields(), [avcC(), box('pasp', u32(0, 1))])).toBeNull();
    expect(entry(visualFields(), [avcC(), box('btrt', Buffer.alloc(13))])).toBeNull();
    expect(entry(visualFields(), [avcC(), colr('nclc')])).toBeNull();
    expect(entry(visualFields(), [avcC(), colr('prof', Buffer.alloc(7))])).toBeNull();
    expect(entry(visualFields(), [avcC(), colr('nclx', Buffer.from([0, 6, 0, 6, 0, 6, 0x01]))])).toBeNull(); // a reserved bit
    expect(entry(visualFields(), [avcC(), colr('nclx', Buffer.from([0, 6, 0, 6, 0, 6, 0, 0]))])).toBeNull(); // a byte after it
    expect(entry(visualFields(), [avcC(), colr('nclx', Buffer.from([0, 6, 0, 6, 0, 6, 0x80]))])).not.toBeNull(); // full range
    // other picture codecs: avc3 (parameters in band), HEVC, AV1, MPEG-4 Part 2
    for (const type of ['avc3', 'hvc1', 'hev1', 'av01', 'mp4v', 'encv']) expect(entry(visualFields(), [avcC()], type), type).toBeNull();
    expect(entry(visualFields(), [pasp(), btrt(), avcC(), colr()])).not.toBeNull();
  });

  it('avcC is read whole: version 1, the reserved bits, a NAL length of 1, 2 or 4, its parameter sets', () => {
    const with_ = (body: Buffer, sample = NAL_SAMPLE) => mp4(clipMp4({ entry: visualEntry('avc1', [avcC(body)]), sample }));
    expect(with_(AVCC_BODY)).not.toBeNull();
    const edit = (i: number, v: number) => {
      const b = Buffer.from(AVCC_BODY);
      b[i] = v;
      return b;
    };
    expect(with_(edit(0, 2))).toBeNull(); // version
    expect(with_(edit(4, 0x03))).toBeNull(); // reserved bits clear
    expect(with_(edit(4, 0xfe), Buffer.from([0, 0, 2, 0x65, 0x88]))).toBeNull(); // a 3-byte NAL length
    expect(with_(edit(5, 0x01))).toBeNull(); // reserved bits clear
    expect(with_(edit(5, 0xe0))).toBeNull(); // no SPS
    expect(with_(Buffer.from([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x01, 0x00, 0x02, 0x68, 0xce]))).toBeNull(); // no SPS, one PPS
    expect(with_(Buffer.concat([AVCC_BODY.subarray(0, 12), Buffer.from([0])]))).toBeNull(); // an SPS and no PPS
    expect(with_(edit(8, 0x68))).toBeNull(); // the SPS is a PPS
    expect(with_(edit(8, 0xe7))).toBeNull(); // the forbidden bit
    expect(with_(edit(12, 0))).toBeNull(); // no PPS
    expect(with_(edit(15, 0x67))).toBeNull(); // the PPS is an SPS
    expect(with_(edit(7, 0x40))).toBeNull(); // an SPS past the box
    expect(with_(Buffer.concat([AVCC_BODY, Buffer.from([0])]))).toBeNull(); // a byte after it
    // a 2-byte and a 1-byte NAL length, with samples framed to match
    expect(with_(edit(4, 0xfd), Buffer.from([0, 2, 0x65, 0x88]))).not.toBeNull();
    expect(with_(edit(4, 0xfc), Buffer.from([2, 0x65, 0x88]))).not.toBeNull();
    // the high profiles' chroma and bit-depth fields, with or without them, and an SPS extension
    const high = Buffer.from(AVCC_BODY);
    high[1] = 100;
    expect(with_(high)).not.toBeNull();
    expect(with_(Buffer.concat([high, Buffer.from([0xfd, 0xf8, 0xf8, 0])]))).not.toBeNull();
    expect(with_(Buffer.concat([high, Buffer.from([0xfd, 0xf8, 0xf8, 1, 0, 2, 0x6d, 0])]))).not.toBeNull();
    expect(with_(Buffer.concat([high, Buffer.from([0xfd, 0xf8, 0xf8, 1, 0, 2, 0x67, 0])]))).toBeNull(); // not an extension
    expect(with_(Buffer.concat([high, Buffer.from([0x01, 0xf8, 0xf8, 0])]))).toBeNull(); // reserved bits
    expect(with_(Buffer.concat([AVCC_BODY, Buffer.from([0xfd, 0xf8, 0xf8, 0])]))).toBeNull(); // baseline has no such fields
  });

  it('an H.264 sample is its NAL units, each length-prefixed and of at least one byte, filling it exactly', () => {
    const sample = (b: Buffer) => mp4(clipMp4({ sample: b }));
    expect(sample(Buffer.from([0, 0, 0, 1, 0x65, 0, 0, 0, 2, 0x06, 0x05]))).not.toBeNull(); // two NAL units
    expect(sample(Buffer.from([0, 0, 0, 3, 0x65, 0x88]))).toBeNull(); // runs past the sample
    expect(sample(Buffer.from([0, 0, 0, 1, 0x65, 0x88]))).toBeNull(); // a byte left over
    expect(sample(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 0x65]))).toBeNull(); // an empty NAL unit
    expect(sample(Buffer.from([0, 0, 0, 2, 0xe5, 0x88]))).toBeNull(); // the forbidden bit
    expect(sample(Buffer.from([0, 0, 1, 0x65, 0x88]))).toBeNull(); // Annex B start codes, not lengths
  });

  it('vpcC is version 1, with a profile of 0 to 3, a bit depth of 8, 10 or 12, and no initialization data', () => {
    const vp = (box_: Buffer) => mp4(clipMp4({ entry: visualEntry('vp09', [box_]), sample: Buffer.from([0x82, 0x49]) }));
    expect(vp(vpcC())).not.toBeNull();
    expect(vp(vpcC(undefined, 0))).toBeNull();
    expect(vp(vpcC(Buffer.from([4, 0, 0x80, 6, 6, 6, 0, 0])))).toBeNull();
    expect(vp(vpcC(Buffer.from([2, 0, 0xa0, 6, 6, 6, 0, 0])))).not.toBeNull(); // 10-bit
    expect(vp(vpcC(Buffer.from([0, 0, 0x90, 6, 6, 6, 0, 0])))).toBeNull(); // 9-bit
    expect(vp(vpcC(Buffer.from([0, 0, 0x80, 6, 6, 6, 0, 1])))).toBeNull(); // initialization data declared
    expect(vp(vpcC(Buffer.from([0, 0, 0x80, 6, 6, 6, 0, 0, 0])))).toBeNull(); // a byte after it
    expect(vp(avcC())).toBeNull(); // an avcC in vp09
  });

  it('fragments name a listed track, each with its own trex, and are timed per track', () => {
    expect(mp4(clipFragmented())).toBeCloseTo(0.0666, 3); // two 1,600-tick picture samples at 48 kHz
    // a fragment of a track the movie does not list, or one it gives no trex
    const moov = (mvex: Buffer[]) => Buffer.concat([ftyp('isom'), box('moov', [mvhd(), pictureTrak(1, []), soundTrakOpus(2), box('mvex', mvex)])]);
    const withMoov = (head: Buffer, trackIds = [1, 2]) => {
      const trafs = (o: number) => trackIds.map((id, i) => [tfhdMoof(id), trunTimed([[1600, NAL_SAMPLE.length]], o + i * NAL_SAMPLE.length)]);
      const size = moofOf(1, trafs(0)).length;
      return Buffer.concat([head, moofOf(1, trafs(size + 8)), box('mdat', trackIds.map(() => NAL_SAMPLE))]);
    };
    const trex = (id: number) => fullBox('trex', 0, 0, u32(id, 1, 0, 0, 0));
    expect(mp4(withMoov(moov([trex(1), trex(2)]), [1]))).not.toBeNull();
    expect(mp4(withMoov(moov([trex(1), trex(2)]), [1, 3]))).toBeNull();
    expect(mp4(withMoov(moov([trex(1)]), [1, 2]))).toBeNull();
    expect(mp4(withMoov(moov([trex(1), trex(1)]), [1]))).toBeNull();
    expect(mp4(withMoov(moov([trex(1), trex(3)]), [1]))).toBeNull();
    // the sound's runs are Opus packets, timed by their TOC bytes: 0x07 is a code-3 packet of seven 10 ms frames
    const moofSound = (o: number) => [[tfhdMoof(1), trunTimed([[1600, NAL_SAMPLE.length]], o)], [tfhdMoof(2), trunTimed([[1, 2]], o + NAL_SAMPLE.length)]];
    const s = moofOf(1, moofSound(0)).length;
    const file = Buffer.concat([moov([trex(1), trex(2)]), moofOf(1, moofSound(s + 8)), box('mdat', [NAL_SAMPLE, Buffer.from([0x07, 0x07])])]);
    expect(mp4(file)).toBeCloseTo(0.07, 6);
    // a traf's tfdt places its runs on its own track's timeline: the picture's at 50 s
    const placed = (o: number) => [[tfhdMoof(1), fullBox('tfdt', 1, 0, u32(0, 48_000 * 50)), trunTimed([[1600, NAL_SAMPLE.length]], o)]];
    const p = moofOf(1, placed(0)).length;
    expect(mp4(Buffer.concat([moov([trex(1), trex(2)]), moofOf(1, placed(p + 8)), box('mdat', [NAL_SAMPLE])]))).toBeCloseTo(50 + 1600 / 48_000, 6);
  });

  it('an mfra is allowed only as the last box, read whole: each tfra once per listed track, every entry at a moof, an mfro of its size', () => {
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at]), tfra(2, [at])]) }))).not.toBeNull();
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at], { version: 0 })]) }))).not.toBeNull();
    expect(mp4(clipFragmented({ mfra: () => mfra([]) }))).not.toBeNull();
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at + 1])]) }))).toBeNull(); // not at a moof
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(3, [at])]) }))).toBeNull(); // a track not listed
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at]), tfra(1, [at])]) }))).toBeNull(); // twice
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at], { version: 2 })]) }))).toBeNull();
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at], { flags: 1 })]) }))).toBeNull();
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at], { sizes: 0x40 })]) }))).toBeNull(); // reserved bits
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at], { sizes: 0x15 })]) }))).toBeNull(); // wider numbers than the entries hold
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at])], 10) }))).toBeNull(); // mfro's size
    expect(mp4(clipFragmented({ mfra: (at) => box('mfra', [tfra(1, [at])]) }))).toBeNull(); // no mfro
    expect(mp4(clipFragmented({ mfra: (at) => box('mfra', [fullBox('mfro', 0, 0, u32(8 + 16 + tfra(1, [at]).length)), tfra(1, [at])]) }))).toBeNull(); // mfro first
    expect(mp4(clipFragmented({ mfra: (at) => mfra([tfra(1, [at]), box('free', Buffer.alloc(4))]) }))).toBeNull();
    // a box with an mfro's or a tfra's fields under another name
    const named = (b: Buffer, type: string) => {
      const out = Buffer.from(b);
      out.write(type, 4, 'latin1');
      return out;
    };
    expect(mp4(clipFragmented({ mfra: (at) => box('mfra', [tfra(1, [at]), named(fullBox('mfro', 0, 0, u32(8 + tfra(1, [at]).length + 16)), 'mfrx')]) }))).toBeNull();
    expect(mp4(clipFragmented({ mfra: (at) => mfra([named(tfra(1, [at]), 'tfrx')]) }))).toBeNull();
    // anywhere but last, or twice
    const file = clipFragmented({ index: false });
    const index = mfraFor(file.indexOf(Buffer.from('moof')) - 4);
    expect(mp4(Buffer.concat([file, index]))).not.toBeNull();
    expect(mp4(Buffer.concat([file, index, index]))).toBeNull();
    expect(mp4(Buffer.concat([file, index, box('free', Buffer.alloc(4))]))).toBeNull();
    // a tfra's time counts in its track's length
    const late = (at: number) => {
      const t = tfra(1, [at], { version: 0 });
      t.writeUInt32BE(48_000 * 50, 8 + 16); // 50 s at the media timescale
      return mfra([t]);
    };
    expect(mp4(clipFragmented({ mfra: late }))).toBeCloseTo(50, 6);
  });

  it('the length is the longest of every track\'s and the movie\'s, as a voice note\'s is', () => {
    expect(mp4(clipMp4({ duration: 48_000 * 59.6 }))).toBeCloseTo(59.6, 6);
    expect(readVideoClip('video/mp4', clipMp4({ duration: 48_000 * 60.5 }))).toEqual({ seconds: 60.5, durationSec: 61 });
    expect(readVideoClip('video/mp4', clipMp4())).toBeNull(); // 0.07 s
    const movie = (b: Buffer, seconds: number) => {
      const out = Buffer.from(b);
      const at = out.indexOf(Buffer.from('mvhd')) + 4;
      out.writeUInt32BE(1000 * seconds, at + 16);
      return out;
    };
    expect(mp4(movie(clipMp4(), 42))).toBe(42);
  });

  it('caps every track\'s samples together at 50,000', () => {
    // a picture track and an AAC sound track of fixed-size samples, each in one chunk; 2-byte NAL lengths
    const picture = Buffer.from([0, 2, 0x65, 0x88]);
    const short = Buffer.from(AVCC_BODY);
    short[4] = 0xfd;
    const entry = visualEntry('avc1', [avcC(short)]);
    const build = (pictures: number, sounds: number) => {
      const head = (o: number) => Buffer.concat([ftyp('isom'), box('moov', [mvhd(),
        trakOf('vide', 1, fixedTable(entry, pictures, picture.length, o, 1)),
        trakOf('soun', 2, fixedTable(sampleEntry('mp4a'), sounds, 4, o + picture.length * pictures, 1024)),
      ])]);
      return Buffer.concat([head(head(0).length + 8), box('mdat', [Buffer.concat(Array.from({ length: pictures }, () => picture)), Buffer.alloc(4 * sounds, 7)])]);
    };
    expect(mp4(build(25_000, 25_000))).not.toBeNull();
    expect(mp4(build(25_000, 25_001))).toBeNull();
  });

  it('Codex round 1 on #1158: a fragment marked duration-is-empty holds no track run', () => {
    const empty = (b: Buffer) => {
      const out = Buffer.from(b);
      out[out.indexOf(Buffer.from('tfhd')) + 5]! |= 0x01; // tfhd flags 0x010000 on the picture's traf
      return out;
    };
    expect(mp4(clipFragmented())).not.toBeNull();
    expect(mp4(empty(clipFragmented()))).toBeNull();
  });
});
