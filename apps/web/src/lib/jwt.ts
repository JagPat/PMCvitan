/**
 * Phase 6 task 4b (§A.3) — read the `sub` (user id) out of a JWT WITHOUT verifying it. The
 * client never treats this as authority (the server verifies every request); it only mirrors
 * the server's viewer/decider filter so a still-loaded store cannot render rows the server
 * would withhold. Returns null for anything that does not parse as a JWT.
 */
export function jwtSub(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}
