# Voice recordings from a real browser

Stage 1 voice (#482). These are real recordings, written by Chromium's MediaRecorder. The parser tests in
`src/media/voice-container.test.ts` check them alongside the hand-built shapes in `../voice-files.ts`.

| File | Recorder | Type asked for | Length |
| --- | --- | --- | --- |
| `chromium-141-opus.webm` | Chromium 141.0.7390.37, headless, Linux | `audio/webm;codecs=opus` | 3 s |
| `chromium-141-opus.mp4` | Chromium 141.0.7390.37, headless, Linux | `audio/mp4;codecs=opus` | 3 s |

## How they were recorded

Each recording ran in Playwright's Chromium, launched with `--use-fake-device-for-media-stream` and
`--use-fake-ui-for-media-stream`. The fake device's microphone plays a beep. The page was served from
`http://localhost`, so `getUserMedia` was allowed.

The page then ran this script:

```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const rec = new MediaRecorder(stream, { mimeType: type });
const parts = [];
rec.ondataavailable = (e) => parts.push(e.data);
rec.start(1000);
await new Promise((r) => setTimeout(r, 3000));
rec.stop(); // the file is new Blob(parts) once onstop fires
```

This Chromium build does not record AAC (`audio/mp4;codecs=mp4a.40.2` is unsupported).

## As the app records them

The two above used a one-second timeslice. The app's recorder (`apps/web/src/lib/mediaRecorder.ts`) calls
`start()` with none, and the browsers write a different file then: Chromium indexes the Segment with a SeekHead and
writes Cues after the Cluster; Firefox writes an empty SeekHead, an unknown-size Segment and a CodecName in the
TrackEntry. The live site refused both WebM shapes (28 Oct). These four came through the app's own code:

| File | Recorder | Type asked for | Length |
| --- | --- | --- | --- |
| `chromium-141-app-opus.webm` | Chromium 141.0.7390.37, headless, Linux | `audio/webm;codecs=opus` | 3 s |
| `chromium-141-app-opus.mp4` | Chromium 141.0.7390.37, headless, Linux | `audio/mp4` | 3 s |
| `firefox-142-app-opus.webm` | Firefox 142.0.1 (Playwright build 1495), headless, Linux | `audio/webm;codecs=opus` | 3 s |
| `firefox-142-app-opus.ogg` | Firefox 142.0.1 (Playwright build 1495), headless, Linux | `audio/ogg;codecs=opus` | 3 s |

The recorder module was bundled with esbuild and served from `http://localhost`. Chromium ran with the fake-device
flags above; Firefox with the prefs `media.navigator.streams.fake` and `media.navigator.permission.disabled`. The page
called `startRecording('audio', type, 60000)`, waited 3 s and called `stop()`.

## What these recordings do not cover

There are no iOS Safari (fragmented MP4, AAC) recordings here. The voice web unit must add real ones, and prove the
parser accepts them, before any client uploads voice notes from an iPhone.

# Video recordings from a real browser

Stage 1 video on site visits (#995). Real camera recordings, written by Chromium's MediaRecorder. The parser tests in
`src/media/video-container.test.ts` and the upload tests in `test/integration/media-video-visit.test.ts` read them.

| File | Recorder | Type asked for | Type Chromium named | Length |
| --- | --- | --- | --- | --- |
| `chromium-153-vp8-opus.webm` | Chromium 153.0.8010.12, headless, Linux | `video/webm;codecs=vp8,opus` | the same | 2 s |
| `chromium-153-vp9.webm` | Chromium 153.0.8010.12, headless, Linux | `video/webm;codecs=vp9` | the same | 2 s |
| `chromium-153-avc1-opus.mp4` | Chromium 153.0.8010.12, headless, Linux | `video/mp4;codecs=avc1.42E01E,opus` | `video/mp4;codecs=avc1.420015,opus` | 2 s |
| `chromium-153-vp9-opus.mp4` | Chromium 153.0.8010.12, headless, Linux | `video/mp4` | `video/mp4;codecs=vp9,opus` | 2 s |
| `chromium-153-h264-opus.mkv` | Chromium 153.0.8010.12, headless, Linux | `video/webm;codecs=h264,opus` | `video/x-matroska;codecs=avc1,opus` | 2 s |

The last one is a refusal case: Chromium writes H.264 in Matroska (DocType `matroska`), not WebM, so `video/webm`
refuses it. The video web unit asks for VP8 or VP9 in WebM.

`chromium-153-app-vp8-opus.webm` (Chromium 153.0.8010.12, headless, Linux, `video/webm;codecs=vp8,opus`, 2 s) was
recorded as the app records: the same script, but `rec.start()` with no timeslice. Chromium then writes a SeekHead
first in the Segment and Cues after the Cluster, which the reader takes (V2a, after #1188).

## How they were recorded

As the voice recordings above, with the fake camera (a moving test pattern) at 320 × 240 and, for the ones with
sound, the fake microphone:

```js
const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: withSound });
const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
const parts = [];
rec.ondataavailable = (e) => parts.push(e.data);
rec.start(1000);
await new Promise((r) => setTimeout(r, 2000));
rec.stop(); // the file is new Blob(parts) once onstop fires
```

A canvas stream (`canvas.captureStream()`) records differently: Chromium gives its picture an alpha channel and writes
WebM BlockAdditions, which the parser refuses. A camera never has one.

## What these recordings do not cover

There is no Firefox (WebM) or iOS Safari (MP4, H.264 with AAC) clip here, so those shapes are proven on hand-built
fixtures only. The video web unit must add real recordings from both, and prove the parser accepts them, before any
client uploads video.

# Still frames from a real browser

#995 V1b. A clip's still frame is a JPEG the phone draws on a canvas. These were written by Chromium's canvas encoder.
The reader's tests in `src/media/jpeg-still.test.ts` and the poster tests in
`test/integration/media-video-poster.test.ts` read them.

| File | Encoder | Size | Quality |
| --- | --- | --- | --- |
| `chromium-153-still-640x360.jpg` | Chromium 153.0.8010.12, headless, Linux | 640 × 360 | 0.8 |
| `chromium-153-still-1x1.jpg` | Chromium 153.0.8010.12, headless, Linux | 1 × 1 | 0.8 |

## How they were drawn

A gradient and a word were drawn on a canvas of that size, then:

```js
const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
```

Chromium writes SOI, a JFIF APP0, a single-chunk ICC profile in APP2, two DQT, a baseline SOF0, four DHT, one scan
and EOI. It writes no Exif.

## Progressive and restart stills

A browser's canvas writes neither, but the reader admits both, so three small stills from another real encoder pin
that it reads them as the format has them: Pillow 12.3.0 (libjpeg-turbo), quality 80, a 48 × 32 gradient.

| File | Written with | Shape |
| --- | --- | --- |
| `pillow-12.3-progressive-48x32.jpg` | `progressive=True` | SOF2, ten scans, a DHT before most of them |
| `pillow-12.3-restart-48x32.jpg` | `restart_marker_blocks=1` | SOF0, a DRI, one scan with restart markers |
| `pillow-12.3-restart-progressive-48x32.jpg` | `progressive=True, restart_marker_rows=1` | SOF2, a DRI before most scans |

## What these stills do not cover

There is no Firefox or iOS Safari still here. The video web unit must add real ones from both, and prove the reader
accepts them, before any client sends a still frame.
