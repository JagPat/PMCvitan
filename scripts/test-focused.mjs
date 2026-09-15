// Run ONE test file or directory with the configuration that owns it:
//   pnpm test:focused -- apps/api/test/integration/some.test.ts
// The path must exist inside the repository and select at least one test file; the
// PostgreSQL suites additionally need a disposable *test* database that is ready, migrated
// and not already in use by a live run. The child's exit status is the exit status.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SUITES = [
  { prefix: 'apps/api/test/integration/', cwd: 'apps/api', command: ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts'], pattern: /\.test\.ts$/u, postgres: true },
  { prefix: 'apps/api/src/', cwd: 'apps/api', command: ['pnpm', 'exec', 'vitest', 'run'], pattern: /\.test\.ts$/u },
  { prefix: 'apps/web/src/', cwd: 'apps/web', command: ['pnpm', 'exec', 'vitest', 'run'], pattern: /\.test\.tsx?$/u },
  { prefix: 'scripts/', cwd: '.', command: ['node', '--test'], pattern: /\.test\.mjs$/u },
];
const posix = (path) => path.split(sep).join('/');

function testFiles(absolute, pattern) {
  if (statSync(absolute).isFile()) return pattern.test(absolute) ? [absolute] : [];
  return readdirSync(absolute, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => resolve(entry.parentPath ?? entry.path, entry.name)).sort();
}

export function plan(argv, { root = ROOT, exists = existsSync, files = testFiles } = {}) {
  const args = argv.filter((arg) => arg !== '--');
  if (args.length !== 1 || args[0].startsWith('-')) return { error: 'usage: pnpm test:focused -- <one test file or directory inside the repository>' };
  const absolute = resolve(root, args[0]);
  const rel = posix(relative(root, absolute));
  if (rel === '' || rel.startsWith('..')) return { error: `${args[0]} is outside the repository` };
  if (!exists(absolute)) return { error: `${rel} does not exist` };
  const suite = SUITES.find((candidate) => rel === candidate.prefix.slice(0, -1) || rel.startsWith(candidate.prefix));
  if (!suite) return { error: `${rel} is not under a test root (${SUITES.map((s) => s.prefix).join(', ')})` };
  const matched = files(absolute, suite.pattern);
  if (matched.length === 0) return { error: `${rel} selects no test file matching ${suite.pattern}` };
  const cwd = resolve(root, suite.cwd);
  const selectors = matched.map((file) => posix(relative(cwd, file)));
  return { suite, cwd, argv: [...suite.command, ...selectors], selectors };
}

/** The database NAME (decoded pathname), never the whole URL: a `test` user on a production host is not a test database. */
const database = (url) => { try { return decodeURIComponent(new URL(url).pathname.slice(1)); } catch { return ''; } };

/**
 * One lease per database, held from before the readiness check until the child exits: two
 * runners starting together would otherwise both pass the process scan, migrate and reset the
 * same fixtures. A lease left by a dead process is reclaimed; a live holder is refused.
 */
export function lease(env, { fs = { openSync, writeSync, closeSync, readFileSync, unlinkSync }, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  const path = join(tmpdir(), `pmcvitan-focused-${createHash('sha256').update(env.DATABASE_URL ?? '').digest('hex').slice(0, 16)}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(path, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      return { path, release: () => { try { fs.unlinkSync(path); } catch { /* already gone */ } } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(path, 'utf8'));
      if (alive(holder)) return { path, error: `another focused run (pid ${holder}) holds the database lease ${path}` };
      try { fs.unlinkSync(path); } catch { /* raced with the holder's own cleanup */ }
    }
  }
  return { path, error: `could not take the database lease ${path}` };
}

/** The PostgreSQL prerequisites, or the reason they are not met. */
export function readiness(env, exec) {
  if (!/test/u.test(database(env.DATABASE_URL ?? ''))) return 'DATABASE_URL must name a disposable *test* database';
  const live = String(exec('ps', ['-eo', 'args']).stdout ?? '').split('\n')
    .filter((line) => /vitest\.integration\.config|test-api-e2e/u.test(line));
  if (live.length > 0) return `refusing to reset or share the database beside a live run:\n${live.join('\n')}`;
  const migrated = exec('pnpm', ['--filter', 'api', 'exec', 'prisma', 'migrate', 'deploy']);
  if (migrated.status !== 0) return `PostgreSQL is not ready or migrations did not apply:\n${migrated.stderr ?? ''}`;
  return null;
}

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });

export function main(argv, { exec = run, env = process.env, log = console.error, planImpl = plan, leaseImpl = lease } = {}) {
  const selected = planImpl(argv);
  if (selected.error) { log(selected.error); return 2; }
  let held = { release() {} };
  if (selected.suite.postgres) {
    held = leaseImpl(env);
    if (held.error) { log(held.error); return 2; }
    const problem = readiness(env, exec);
    if (problem) { held.release(); log(problem); return 2; }
  }
  try {
    log(`test-focused: ${selected.argv.join(' ')} (in ${posix(relative(ROOT, selected.cwd)) || '.'})`);
    const child = exec(selected.argv[0], selected.argv.slice(1), { cwd: selected.cwd, stdio: 'inherit', env });
    if (child.error) { log(child.error.message); return 2; }
    return child.status ?? 1;
  } finally { held.release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
