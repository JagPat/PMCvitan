/**
 * #1177 VT2 — the speech-to-text provider, as the transcript service sees it. One implementation calls Sarvam's batch
 * job API (`sarvam.provider.ts`); tests inject a fake. Every method is one bounded network exchange and holds no
 * state: the job id the provider hands back is the only thing that outlives a call, and the caller stores it.
 */

/** What a provider call ended in, when it did not succeed. `final` means asking again cannot help (a refused file, a
 *  bad key, a job the provider failed); otherwise the try may be repeated, within the caller's bound. */
export class SpeechProviderError extends Error {
  constructor(message: string, readonly final: boolean) {
    super(message);
    this.name = 'SpeechProviderError';
  }
}

/** A job's state as the provider reports it. */
export type SpeechJobState =
  | { state: 'running' }
  | { state: 'done'; text: string; languageCode: string | null }
  | { state: 'failed'; reason: string };

export interface SpeechProvider {
  /** Hand the provider one recording and start its job; resolves to the provider's job id. */
  startJob(audio: Buffer, mime: string, fileName: string): Promise<string>;
  /** Ask how a started job is doing; a finished job's words come back with its state. */
  checkJob(jobId: string): Promise<SpeechJobState>;
}

/** The DI token the transcript service asks for. Null when the provider is not configured. */
export const SPEECH_PROVIDER = Symbol('SPEECH_PROVIDER');
