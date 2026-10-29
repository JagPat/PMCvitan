/**
 * #1177 VT2 — the speech provider's configuration, read from the environment. One variable, `SARVAM_API_KEY`: unset or
 * malformed (not `sk_…`), the feature is CLOSED (H6: the transcript routes answer "not available" and write nothing). The value never
 * leaves this file except as the key the provider sends in its header: not in a result, a log or an error.
 *
 * It reads the environment on every call, so unsetting the variable and restarting closes the feature.
 */
export const SARVAM_ENV = 'SARVAM_API_KEY';

/** Sarvam's keys begin `sk_`; a placeholder such as YOUR_SARVAM_API_KEY keeps the feature closed. */
const KEY = /^sk_[\x21-\x7e]{8,509}$/;

/** The key when it is set and shaped like one (`sk_`, then one run of visible ASCII), else null. */
export function readSarvamKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[SARVAM_ENV]?.trim();
  return raw && KEY.test(raw) ? raw : null;
}
