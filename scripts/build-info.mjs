// Deploy visibility (owner direction 2026-10-08): the build's commit and time, stamped at BUILD time from
// Coolify's `SOURCE_COMMIT` build argument — never read from git at runtime (the image has no .git).
//
// Only a hex SHA is ever echoed, so no other environment value can reach /health or /version.json.
// An absent or malformed commit is "unknown"; the build never fails for it.
import { pathToFileURL } from 'node:url';

export const UNKNOWN = 'unknown';

export function buildInfo(env = process.env, now = new Date()) {
  const raw = String(env?.SOURCE_COMMIT ?? '').trim().toLowerCase();
  const commit = /^[0-9a-f]{7,40}$/u.test(raw) ? raw : UNKNOWN;
  return {
    commit,
    commitShort: commit === UNKNOWN ? UNKNOWN : commit.slice(0, 7),
    builtAt: now.toISOString(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(`${JSON.stringify(buildInfo())}\n`);
}
