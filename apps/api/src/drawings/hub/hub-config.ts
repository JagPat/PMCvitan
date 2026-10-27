/**
 * #1118 U2 — the Hub integration's configuration, read from the environment.
 *
 * Four variables, all required. While any is unset or malformed the integration is CLOSED: `readHubConfig` returns
 * `{ open: false }` and says which variables are at fault, by name only. A value never leaves this file: not in the
 * result, not in a log, not in an error. Nothing is defaulted and nothing is partly open, so a typo in one secret of a
 * rotation pair closes intake rather than quietly dropping that secret (Hub retries for about 27.6 h; plan Q3).
 *
 * - `HUB_BASE_URL`: Hub's origin, `https://host[:port]` with no path, query, fragment or credentials, so the one URL U4
 *   builds (`/api/v2/drawings/{fileId}/content?versionId=…`) is the only one. Plain `http` is accepted only outside
 *   production and only for a loopback host (a local stub Hub).
 * - `HUB_OFFICE_TOKEN`: the office's API token, sent as a header, so it must be one run of visible ASCII.
 * - `HUB_WEBHOOK_SECRET`: one to {@link HUB_WEBHOOK_SECRETS_MAX} Standard Webhooks secrets (`whsec_` + base64 of 24 to 64
 *   bytes), separated by commas or whitespace. Two at once are a rotation's overlap window.
 * - `HUB_ORG_ID`: the PMC org whose projects Hub's events may reach (U3 also checks the route's `:orgId` against it).
 *
 * It reads the environment on every call, so unsetting a variable and restarting closes the integration.
 */
import { isProduction } from '../../config';

export const HUB_ENV = ['HUB_BASE_URL', 'HUB_OFFICE_TOKEN', 'HUB_WEBHOOK_SECRET', 'HUB_ORG_ID'] as const;
export type HubEnvName = (typeof HUB_ENV)[number];

/** The most webhook secrets accepted at once: a rotation needs two; the cap bounds the HMACs one delivery costs. */
export const HUB_WEBHOOK_SECRETS_MAX = 4;
/** Standard Webhooks secret sizes, in decoded bytes. */
export const HUB_WEBHOOK_SECRET_MIN_BYTES = 24;
export const HUB_WEBHOOK_SECRET_MAX_BYTES = 64;

export type HubConfig = {
  /** `https://host[:port]`, no trailing slash */
  baseUrl: string;
  officeToken: string;
  /** decoded secret keys, in the order given, without duplicates */
  webhookSecrets: readonly Buffer[];
  orgId: string;
};

/** Why a variable keeps the integration closed. Names and codes only, never a value. */
export type HubConfigFault = { name: HubEnvName; problem: 'unset' | 'malformed' };

export type HubConfigResult = { open: true; config: HubConfig } | { open: false; faults: HubConfigFault[] };

const TOKEN = /^[\x21-\x7e]+$/;
const SECRET = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function baseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.protocol === 'http:' && !isProduction() && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !local) return null;
  // the value must be the origin written out as itself (an IDN in punycode, an optional trailing `/`). That refuses
  // credentials, a path, a query or a fragment, and also what `new URL` forgives: a bare `?` or `#`, `https:host`,
  // `https://@host`, dot segments, a tab in the host, a default port
  if (raw.replace(/\/$/, '').toLowerCase() !== url.origin) return null;
  return url.origin;
}

function webhookSecrets(raw: string): Buffer[] | null {
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0 || entries.length > HUB_WEBHOOK_SECRETS_MAX) return null;
  const keys: Buffer[] = [];
  for (const entry of entries) {
    const b64 = SECRET.exec(entry)?.[1];
    if (!b64 || b64.length % 4 !== 0) return null;
    const key = Buffer.from(b64, 'base64');
    // a strict round trip: Node's decoder skips characters it can't use, so compare what it kept
    if (key.toString('base64') !== b64) return null;
    if (key.length < HUB_WEBHOOK_SECRET_MIN_BYTES || key.length > HUB_WEBHOOK_SECRET_MAX_BYTES) return null;
    if (!keys.some((k) => k.equals(key))) keys.push(key);
  }
  return keys;
}

/** Reads the four `HUB_*` variables from `env` (the process environment by default). */
export function readHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfigResult {
  const faults: HubConfigFault[] = [];
  const read = <T>(name: HubEnvName, parse: (raw: string) => T | null): T | null => {
    const raw = env[name]?.trim();
    if (!raw) {
      faults.push({ name, problem: 'unset' });
      return null;
    }
    const value = parse(raw);
    if (value === null) faults.push({ name, problem: 'malformed' });
    return value;
  };
  const config = {
    baseUrl: read('HUB_BASE_URL', baseUrl),
    officeToken: read('HUB_OFFICE_TOKEN', (raw) => (TOKEN.test(raw) ? raw : null)),
    webhookSecrets: read('HUB_WEBHOOK_SECRET', webhookSecrets),
    orgId: read('HUB_ORG_ID', (raw) => (TOKEN.test(raw) ? raw : null)),
  };
  if (faults.length) return { open: false, faults };
  return { open: true, config: config as HubConfig };
}
