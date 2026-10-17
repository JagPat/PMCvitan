import { TOKEN_ROLES, type Role } from '@vitan/shared';

/** the roles a signed-in web session can hold (a `worker` device token never signs in here) */
const SESSION_ROLES: readonly string[] = TOKEN_ROLES.filter((r) => r !== 'worker');

/**
 * Stage 1 live check (#482 6227430525) — a browser reload no longer signs the person out.
 *
 * The signed-in session lived only in memory, so every reload (and every reload with no signal on
 * site) landed on the sign-in screen. The adopted server auth result is now kept in this TAB's
 * `sessionStorage`: it survives a reload, and closing the tab ends it. Nothing new is trusted: the
 * token is the server's own, every request still carries it for the server to check, an expired one
 * is dropped before it is used, and a server that refuses it (401) signs the person out. Storage may
 * be absent (private mode, a blocked quota): every read then fails closed to "signed out".
 */

const KEY = 'vitan.session.v1';
/** a token this close to expiry is not restored: the next request would refuse it anyway */
const EXPIRY_MARGIN_MS = 60_000;

export interface SavedSession {
  token: string;
  role: Role;
  name?: string;
  projectId?: string;
}

/** The token's `exp` (seconds since the epoch), or null when it carries none or is not a JWT. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function saveSession(session: SavedSession): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable — this session still works until the next reload */
  }
}

export function clearSession(): void {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/** The session this tab saved, when it is well formed and its token has not expired; else null (and cleared). */
export function loadSession(now: number = Date.now()): SavedSession | null {
  let raw: string | null = null;
  try {
    raw = globalThis.sessionStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedSession>;
    const exp = typeof v.token === 'string' ? tokenExpiry(v.token) : null;
    if (
      typeof v.token === 'string' && typeof v.role === 'string' && SESSION_ROLES.includes(v.role) && exp !== null && exp * 1000 > now + EXPIRY_MARGIN_MS
      && (v.name === undefined || typeof v.name === 'string')
      && (v.projectId === undefined || typeof v.projectId === 'string')
    ) {
      return { token: v.token, role: v.role as Role, name: v.name, projectId: v.projectId };
    }
  } catch {
    /* malformed — dropped below */
  }
  clearSession();
  return null;
}
