// Runs the PostgreSQL integration suite as parallel shards, one disposable PostgreSQL SERVER per shard
// (owner request 2026-10-27: cut the ~25 minute serial suite without dropping a test).
//
// Each shard gets a whole server, not just a database, because the suite uses cluster-wide state: roles
// (`CREATE ROLE`), `pg_stat_activity` lock-wait barriers that do not filter by database, and fixed scratch
// database names. On its own server every file sees exactly what it saw in the serial run; files inside a
// shard still run one at a time (vitest.integration.config.ts).
//
// Nothing is dropped, and that is checked, not assumed: every file under test/integration lands in exactly
// one shard (`partition` throws otherwise), and after the run each shard's JSON report must name exactly
// the files it was given, every one passed. Any shard failing, or any file missing, extra or unreported,
// fails the step.
//
// Usage (from apps/api): node test/integration-shards.mjs <DATABASE_URL> [<DATABASE_URL> ...]
// One URL per shard, each a migrated disposable database. Durations come from integration-durations.json
// (seconds per file, from a CI run); a file not listed there is weighed at DEFAULT_SECONDS.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUITE_DIR = 'test/integration';
export const DEFAULT_SECONDS = 5;

/** Every integration test file, as a path relative to apps/api, sorted. */
export function listIntegrationFiles(apiRoot = API_ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts')) found.push(relative(apiRoot, path).split('\\').join('/'));
    }
  };
  walk(join(apiRoot, SUITE_DIR));
  return found.sort();
}

/**
 * Longest-first greedy split into `count` shards by recorded duration. Deterministic: ties break on path.
 * Throws unless every file is in exactly one shard.
 */
export function partition(files, durations, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const weight = (file) => (Number.isFinite(durations[file]) ? durations[file] : DEFAULT_SECONDS);
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const file of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min));
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  const placed = shards.flatMap((shard) => shard.files);
  if (placed.length !== files.length || new Set(placed).size !== new Set(files).size) {
    throw new Error('integration shards do not cover every file exactly once');
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** The files a vitest JSON report says ran, and which of them did not pass. Paths relative to apps/api. */
export function reportedFiles(report, apiRoot = API_ROOT) {
  const ran = [];
  const notPassed = [];
  for (const result of report?.testResults ?? []) {
    const file = relative(apiRoot, result.name).split('\\').join('/');
    ran.push(file);
    if (result.status !== 'passed') notPassed.push(file);
  }
  return { ran: ran.sort(), notPassed };
}

/** Problems with one shard's outcome, or an empty list. */
export function shardProblems(expected, exitCode, report, apiRoot = API_ROOT) {
  const problems = [];
  if (exitCode !== 0) problems.push(`vitest exited ${exitCode}`);
  if (!report) return [...problems, 'no JSON report was written'];
  const { ran, notPassed } = reportedFiles(report, apiRoot);
  const want = new Set(expected);
  const got = new Set(ran);
  for (const file of expected) if (!got.has(file)) problems.push(`not run: ${file}`);
  for (const file of ran) if (!want.has(file)) problems.push(`ran but not assigned: ${file}`);
  if (ran.length !== got.size) problems.push('a file was reported twice');
  for (const file of notPassed) problems.push(`did not pass: ${file}`);
  return problems;
}

function runShard(index, files, databaseUrl, outDir) {
  const reportPath = join(outDir, `shard-${index + 1}.json`);
  const logPath = join(outDir, `shard-${index + 1}.log`);
  return new Promise((resolveRun) => {
    const chunks = [];
    const child = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
        '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`, ...files],
      { cwd: API_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('close', (code, signal) => {
      writeFileSync(logPath, Buffer.concat(chunks));
      let report = null;
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch {
        report = null;
      }
      resolveRun({ code: code ?? `signal ${signal}`, report, log: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function main(urls) {
  if (urls.length === 0) throw new Error('give one DATABASE_URL per shard');
  const durations = JSON.parse(readFileSync(new URL('./integration-durations.json', import.meta.url), 'utf8'));
  const files = listIntegrationFiles();
  const shards = partition(files, durations, urls.length);
  const outDir = mkdtempSync(join(tmpdir(), 'integration-shards-'));
  shards.forEach((shard, i) => {
    console.log(`shard ${i + 1}/${shards.length}: ${shard.files.length} files, ~${Math.round(shard.seconds)}s recorded`);
  });
  const started = Date.now();
  const results = await Promise.all(shards.map((shard, i) => runShard(i, shard.files, urls[i], outDir).then((r) => {
    console.log(`shard ${i + 1} finished after ${Math.round((Date.now() - started) / 1000)}s (exit ${r.code})`);
    return r;
  })));
  let failed = false;
  results.forEach((result, i) => {
    console.log(`::group::shard ${i + 1} output`);
    process.stdout.write(result.log);
    console.log('::endgroup::');
    const problems = shardProblems(shards[i].files, result.code, result.report);
    if (problems.length > 0) {
      failed = true;
      for (const problem of problems) console.log(`::error::integration shard ${i + 1}: ${problem}`);
    }
  });
  const total = results.reduce((n, r) => n + reportedFiles(r.report).ran.length, 0);
  console.log(`${total} of ${files.length} integration files ran across ${shards.length} shards in ${Math.round((Date.now() - started) / 1000)}s`);
  // #1147's red job: `process.exit` drops what is still queued for a piped stdout, which on a runner
  // was every shard's output after the second, so set the exit code and let the output drain
  if (failed || total !== files.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
