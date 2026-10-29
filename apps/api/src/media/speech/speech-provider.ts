/**
 * #1177 VT2 — the speech-to-text provider, as the transcript service sees it. One implementation calls Sarvam's batch
 * job API (`sarvam.provider.ts`); tests inject a fake. Every exchange is bounded, and no method holds state: the job
 * id the provider hands back is the only thing that outlives a call, and the caller stores it before anything else.
 */

/** What a provider call ended in, when it did not succeed. `final` means asking again cannot help (a refused file, a
 *  bad key, a job the provider failed); otherwise the try may be repeated, within the caller's bound. `busy` means the
 *  provider refused for its own load (a rate limit, which is account-wide): every note waits, and no note's try is spent. */
export class SpeechProviderError extends Error {
  constructor(message: string, readonly final: boolean, readonly busy = false) {
    super(message);
    this.name = 'SpeechProviderError';
  }
}

/**
 * The bounds of what a provider hands back, which are those of the table it is stored in ("VoiceTranscript", VT1a's
 * `VoiceTranscript_shape_check`, 20280126000000). A provider never hands back a value the table would refuse: an id it
 * cannot store is a final error, and a done result's words and language are made to fit or the job reads as failed.
 */
/** A job id: one run of visible ASCII, at most 200 characters (VT1a: not blank, char_length <= 200). */
export const SPEECH_JOB_ID = /^[\x21-\x7e]{1,200}$/;
/** A done job's words, counted in characters as PostgreSQL counts them (char_length <= 20000). */
export const SPEECH_TEXT_MAX = 20_000;
/** A done job's language, a BCP-47 code in the table's shape. */
export const SPEECH_LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/** A job's state as the provider reports it. A done result always fits the table (see the bounds above). */
export type SpeechJobState =
  /** made, but not started: its recording is not in, or its start was not heard */
  | { state: 'waiting' }
  | { state: 'running' }
  | { state: 'done'; text: string; languageCode: string | null }
  | { state: 'failed'; reason: string };

export interface SpeechProvider {
  /** Make a job and hand back its id, before anything is sent: the caller stores the id first, so a later failure
   *  carries on with this job and never pays for a second one. */
  createJob(): Promise<string>;
  /** Hand a made job its one recording and start it. Asked again for a job still waiting, it sends the recording again. */
  startJob(jobId: string, audio: Buffer, mime: string, fileName: string): Promise<void>;
  /** Ask how a started job is doing; a finished job's words come back with its state. */
  checkJob(jobId: string): Promise<SpeechJobState>;
}

/** The DI token the transcript service asks for. Null when the provider is not configured. */
export const SPEECH_PROVIDER = Symbol('SPEECH_PROVIDER');
