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

## What these recordings do not cover

There are no Firefox (Ogg) or iOS Safari (fragmented MP4, AAC) recordings here. The voice web unit must add real
recordings from both browsers, and prove the parser accepts them, before any client uploads voice notes.
