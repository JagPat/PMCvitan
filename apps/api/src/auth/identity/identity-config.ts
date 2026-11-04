/**
 * Redbracket ID A2 — the switch and settings for signing in through Redbracket ID (notes/auth/redbracket-id/plan.md).
 *
 * Redbracket ID is the platform's own OpenID Connect issuer (Zitadel, `https://id.vitan.in`). PMC's API, never the
 * browser, talks to it. Five variables, and one more for tests:
 *
 * - `IDENTITY_OIDC`: the switch. ON only when it is exactly `1`. Anything else (unset, `true`, `1 `, `yes`) is OFF,
 *   and OFF means today's sign-in with no call to any issuer.
 * - `IDENTITY_ISSUER`: the issuer, default `https://id.vitan.in`. Always an `https://` host. In production it must be
 *   exactly that, so an id token is only ever accepted from that issuer (and only that issuer is ever linked).
 * - `IDENTITY_ISSUER_ENDPOINT`: outside production only, where a local fake issuer listens (a loopback `http://` host
 *   and port), for tests. The issuer's NAME stays the `https://` one above. In production setting it at all makes
 *   sign-in unavailable: requests always go to the issuer itself.
 * - `IDENTITY_CLIENT_ID`: PMC's own OIDC client at the issuer (public, PKCE). Never Hub's.
 * - `IDENTITY_REDIRECT_URI`: the redirect URI registered for PMC's client, any `https://` URL with no user info or
 *   fragment (PMC does not pin the host here; the issuer refuses a redirect its client does not have registered). The
 *   browser is never sent there; the API reads the code from the issuer's answer itself.
 * - `IDENTITY_SERVICE_TOKEN`: PMC's own service account token at the issuer (a machine user with IAM_LOGIN_CLIENT).
 *   Never Hub's. It is sent as a header, so it must be one run of visible ASCII.
 *
 * With the switch on and any other variable unset or malformed, Redbracket ID sign-in is UNAVAILABLE (not today's
 * sign-in): `readIdentityConfig` says which variables are at fault, by name only. A value never leaves this file: not
 * in the result, not in a log, not in an error. The environment is read on every call.
 */
import { isProduction } from '../../config';

export const REDBRACKET_ISSUER = 'https://id.vitan.in';
/**
 * Every WebAuthn relying party (rp id) a passkey or security key of a Redbracket ID person can be made on: the instance
 * domain (which also stands for legacy keys stored with no rp id) and every `domain` a login UI or app (Hub, rb, the
 * console, PMC) sends when it registers a key. The issuer methods fence (`IdentityClient.fenceOtherMethods`) asks
 * about each one, because Zitadel v4.16 lists a key only for the rp it was made on (internal/webauthn/converter.go:13
 * WebAuthNsToCredentials). A new one is a code change and a deploy, done BEFORE that portal launches (RUNBOOK §RBF).
 */
export const FENCE_RP_IDS = ['id.vitan.in', 'rb.vitan.in', 'pms.vitan.in', 'hub.vitan.in'] as const;
export const IDENTITY_ENV = ['IDENTITY_ISSUER', 'IDENTITY_ISSUER_ENDPOINT', 'IDENTITY_CLIENT_ID', 'IDENTITY_REDIRECT_URI', 'IDENTITY_SERVICE_TOKEN'] as const;
export type IdentityEnvName = (typeof IDENTITY_ENV)[number];

export type IdentityConfig = {
  /** the issuer, no trailing slash; an id token's `iss` must equal it exactly */
  issuer: string;
  /** where requests go: the issuer itself, or (outside production only) a local fake's loopback address */
  endpoint: string;
  clientId: string;
  redirectUri: string;
  serviceToken: string;
};

export type IdentityConfigFault = { name: IdentityEnvName; problem: 'unset' | 'malformed' };

/** `off`: today's sign-in, no issuer call. `on`: Redbracket ID. `broken`: switched on but unusable (unavailable). */
export type IdentityConfigResult =
  | { state: 'off' }
  | { state: 'on'; config: IdentityConfig }
  | { state: 'broken'; faults: IdentityConfigFault[] };

const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,255}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True only when `IDENTITY_OIDC` is exactly `1`. */
export function identitySwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IDENTITY_OIDC === '1';
}

function issuerOf(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === '') return REDBRACKET_ISSUER;
  if (isProduction()) return raw === REDBRACKET_ISSUER ? raw : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const plain = plainOrigin(raw, url);
  return plain && url.protocol === 'https:' ? plain : null;
}

/** `scheme://host[:port]` when `raw` is exactly that (a trailing `/` allowed), else null. */
function plainOrigin(raw: string, url: URL): string | null {
  const plain = `${url.protocol}//${url.host}`;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return raw === plain || raw === `${plain}/` ? plain : null;
}

/** A local fake issuer's address, outside production only: a loopback `http://` host and port. */
function endpointOf(raw: string): string | null {
  if (isProduction()) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const plain = plainOrigin(raw, url);
  return plain && url.protocol === 'http:' && LOOPBACK.has(url.hostname) ? plain : null;
}

function redirectOf(raw: string, local: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  // only the URL exactly as it will be sent: `new URL` quietly drops whitespace, tabs and newlines, which the issuer's
  // registered redirect would then not match (every sign-in down, though the settings looked whole)
  if (raw !== url.href) return null;
  if (url.protocol === 'https:') return raw;
  // a local fake issuer in tests runs over loopback http, and so may its registered redirect
  if (local && !isProduction() && url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return raw;
  return null;
}

/** The switch and settings, read now. Names only in a fault; never a value. */
export function readIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfigResult {
  if (!identitySwitchOn(env)) return { state: 'off' };
  const faults: IdentityConfigFault[] = [];
  const issuer = issuerOf(env.IDENTITY_ISSUER);
  if (!issuer) faults.push({ name: 'IDENTITY_ISSUER', problem: 'malformed' });
  const rawEndpoint = env.IDENTITY_ISSUER_ENDPOINT ?? '';
  const endpoint = rawEndpoint ? endpointOf(rawEndpoint) : issuer;
  if (rawEndpoint && !endpoint) faults.push({ name: 'IDENTITY_ISSUER_ENDPOINT', problem: 'malformed' });
  const clientId = env.IDENTITY_CLIENT_ID ?? '';
  if (!clientId) faults.push({ name: 'IDENTITY_CLIENT_ID', problem: 'unset' });
  else if (!CLIENT_ID.test(clientId)) faults.push({ name: 'IDENTITY_CLIENT_ID', problem: 'malformed' });
  const rawRedirect = env.IDENTITY_REDIRECT_URI ?? '';
  // each variable is judged on its own, so one bad value never hides another: every fault is named at once
  const redirectUri = rawRedirect ? redirectOf(rawRedirect, Boolean(rawEndpoint && endpoint)) : null;
  if (!rawRedirect) faults.push({ name: 'IDENTITY_REDIRECT_URI', problem: 'unset' });
  else if (!redirectUri) faults.push({ name: 'IDENTITY_REDIRECT_URI', problem: 'malformed' });
  const serviceToken = env.IDENTITY_SERVICE_TOKEN ?? '';
  if (!serviceToken) faults.push({ name: 'IDENTITY_SERVICE_TOKEN', problem: 'unset' });
  else if (!TOKEN.test(serviceToken)) faults.push({ name: 'IDENTITY_SERVICE_TOKEN', problem: 'malformed' });
  if (faults.length || !issuer || !endpoint || !redirectUri) return { state: 'broken', faults };
  return { state: 'on', config: { issuer, endpoint, clientId, redirectUri, serviceToken } };
}
