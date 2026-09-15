// Run ONE test file or directory with the configuration that owns it:
//   pnpm test:focused -- apps/api/test/integration/some.test.ts
// The path must exist inside the repository and select at least one test file; the
// PostgreSQL suites additionally need a disposable *test* database that is ready, migrated
// and not already in use by a live run. The child's exit status is the exit status.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
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
  const suite = SUITES.find((candidate) => rel.startsWith(candidate.prefix));
  if (!suite) return { error: `${rel} is not under a test root (${SUITES.map((s) => s.prefix).join(', ')})` };
  const matched = files(absolute, suite.pattern);
  if (matched.length === 0) return { error: `${rel} selects no test file matching ${suite.pattern}` };
  const cwd = resolve(root, suite.cwd);
  const selectors = matched.map((file) => posix(relative(cwd, file)));
  return { suite, cwd, argv: [...suite.command, ...selectors], selectors };
}

/** The PostgreSQL prerequisites, or the reason they are not met. */
export function readiness(env, exec) {
  if (!/test/u.test(env.DATABASE_URL ?? '')) return 'DATABASE_URL must name a disposable *test* database';
  const live = String(exec('ps', ['-eo', 'args']).stdout ?? '').split('\n')
    .filter((line) => /vitest\.integration\.config|test-api-e2e/u.test(line));
  if (live.length > 0) return `refusing to reset or share the database beside a live run:\n${live.join('\n')}`;
  const migrated = exec('pnpm', ['--filter', 'api', 'exec', 'prisma', 'migrate', 'deploy']);
  if (migrated.status !== 0) return `PostgreSQL is not ready or migrations did not apply:\n${migrated.stderr ?? ''}`;
  return null;
}

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });

export function main(argv, { exec = run, env = process.env, log = console.error, planImpl = plan } = {}) {
  const selected = planImpl(argv);
  if (selected.error) { log(selected.error); return 2; }
  if (selected.suite.postgres) {
    const problem = readiness(env, exec);
    if (problem) { log(problem); return 2; }
  }
  log(`test-focused: ${selected.argv.join(' ')} (in ${posix(relative(ROOT, selected.cwd)) || '.'})`);
  const child = exec(selected.argv[0], selected.argv.slice(1), { cwd: selected.cwd, stdio: 'inherit', env });
  if (child.error) { log(child.error.message); return 2; }
  return child.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
