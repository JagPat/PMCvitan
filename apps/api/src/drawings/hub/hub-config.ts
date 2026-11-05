/**
 * #1118 U2 — the Hub integration's configuration, read from the environment.
 *
 * Five variables, all required. While any is unset or malformed the integration is CLOSED: `readHubConfig` returns
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
 * - `HUB_OFFICE_ID`: the Hub office (Hub's `companyId`, from `GET /api/v2/me`) this PMC org is connected to. An event
 *   whose `data.office.id` names another office is refused (U3o); it is Hub's id, separate from `HUB_ORG_ID`. It is
 *   compared as written, so copy `companyId` exactly (`7`, never `007`): a mismatch refuses every event with a 2xx.
 *
 * It reads the environment on every call, so unsetting a variable and restarting closes the integration.
 */
import { isProduction } from '../../config';

export const HUB_ENV = ['HUB_BASE_URL', 'HUB_OFFICE_TOKEN', 'HUB_WEBHOOK_SECRET', 'HUB_ORG_ID', 'HUB_OFFICE_ID'] as const;
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
  /** the Hub office id events must name when they name one (`data.office.id`) */
  officeId: string;
};

/** Why a variable keeps the integration closed. Names and codes only, never a value. */
export type HubConfigFault = { name: HubEnvName; problem: 'unset' | 'malformed' };

export type HubConfigResult = { open: true; config: HubConfig } | { open: false; faults: HubConfigFault[] };

const TOKEN = /^[\x21-\x7e]+$/;
/** a Hub id as `hub-event.ts` reads one: visible ASCII, at most 256 */
const HUB_OFFICE = /^[\x21-\x7e]{1,256}$/;
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

/** One variable's reader: its value, or null with the fault pushed onto `faults`. */
function reader(env: NodeJS.ProcessEnv, faults: HubConfigFault[]) {
  return <T>(name: HubEnvName, parse: (raw: string) => T | null): T | null => {
    const raw = env[name]?.trim();
    if (!raw) {
      faults.push({ name, problem: 'unset' });
      return null;
    }
    const value = parse(raw);
    if (value === null) faults.push({ name, problem: 'malformed' });
    return value;
  };
}

/** The variables in {@link HUB_ENV}'s order (faults are reported in it); the secret only when `withSecret`. */
function readAll(read: ReturnType<typeof reader>, withSecret: boolean) {
  const base = read('HUB_BASE_URL', baseUrl);
  const officeToken = read('HUB_OFFICE_TOKEN', (raw) => (TOKEN.test(raw) ? raw : null));
  const secrets = withSecret ? read('HUB_WEBHOOK_SECRET', webhookSecrets) : null;
  const orgId = read('HUB_ORG_ID', (raw) => (TOKEN.test(raw) ? raw : null));
  const officeId = read('HUB_OFFICE_ID', (raw) => (HUB_OFFICE.test(raw) ? raw : null));
  return { client: { baseUrl: base, officeToken, orgId, officeId }, secrets };
}

/** Reads the five `HUB_*` variables from `env` (the process environment by default). */
export function readHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfigResult {
  const faults: HubConfigFault[] = [];
  const { client, secrets } = readAll(reader(env, faults), true);
  if (faults.length) return { open: false, faults };
  return { open: true, config: { ...client, webhookSecrets: secrets } as HubConfig };
}

/**
 * #1118 U7a — what PMC needs to CALL Hub (list its projects, link and unlink one): the four variables other than
 * `HUB_WEBHOOK_SECRET`, read and checked exactly as {@link readHubConfig} reads them. Linking works with these alone, so
 * the receiver can stay closed (no secret, no Hub webhook) until PMC can apply Hub's events (notes/hub/u7a/plan.md §4).
 */
export type HubClientConfig = Omit<HubConfig, 'webhookSecrets'>;
export type HubClientConfigResult = { open: true; config: HubClientConfig } | { open: false; faults: HubConfigFault[] };

export function readHubClientConfig(env: NodeJS.ProcessEnv = process.env): HubClientConfigResult {
  const faults: HubConfigFault[] = [];
  const { client } = readAll(reader(env, faults), false);
  if (faults.length) return { open: false, faults };
  return { open: true, config: client as HubClientConfig };
}
