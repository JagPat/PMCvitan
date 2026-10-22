import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitSql } from './phase6-t4c-migration-replay';

/**
 * #482 site photos — the guard's FIRST install (`20280118000000_media_tombstone_guard`, #1032 Codex 4332184418).
 * `media-tombstone-guard.test.ts` covers a database that already has the guard. These start where production is
 * today: 20280117's record and its delete trigger, and no guard. Two things must hold whatever runs the file:
 * - it installs everything or nothing: a run stopped at any point, under psql or `prisma migrate deploy`, commits
 *   nothing, never a function without its trigger;
 * - no row stored before the guard is trusted: a keyed row whose key has a record, committed before the install or
 *   in flight while it starts, stops the install (MTSTO), and a write arriving during the install waits for it and
 *   then meets the guard.
 * They share one database of their own, built from zero for this file and put back to production's state before each
 * test, never the suite's: these drop the guard. Every ordering below is read from pg_locks, never from a clock.
 */
const API = join(__dirname, '../..');
const MIGRATIONS = join(API, 'prisma/migrations');
const NAME = '20280118000000_media_tombstone_guard';
const MIGRATION = join(MIGRATIONS, NAME, 'migration.sql');
const RECORD = join(MIGRATIONS, '20280117000000_media_tombstone/migration.sql');
const DB = 'media_guard_install_test';
/** `scripts/migrate.sh`'s recovery for this file, run from the runner itself (as scripts/ci-migrate-media-guard-report.test.mjs). */
const RUNNER = readFileSync(join(API, 'scripts/migrate.sh'), 'utf8');
const fn = (name: string) => RUNNER.slice(RUNNER.indexOf(`${name}() {`), RUNNER.indexOf('\n}\n', RUNNER.indexOf(`${name}() {`)) + 3);
const REPORT = fn('migration_failed_in_output') + fn('report_media_guard_migration_failure');
const recovery = (output: string) => execFileSync('sh', ['-c', `${REPORT}\nreport_media_guard_migration_failure "$1"`, 'report', output], { encoding: 'utf8' });
const RESOLVE = `npx prisma migrate resolve --rolled-back ${NAME}`;
/** project:remove's own lock on the tables whose triggers it switches off, "Media" among them. */
const REMOVE_LOCK = /IN SHARE ROW EXCLUSIVE MODE NOWAIT/;

const strip = (raw: string) => { const u = new URL(raw); u.search = ''; return u.toString(); };
const at = (raw: string, db: string) => { const u = new URL(raw); u.pathname = `/${db}`; return u.toString(); };

describe('#482 the deleted-photo guard\'s first install (live PG, its own database)', () => {
  const base = process.env.DATABASE_URL ?? '';
  const prismaUrl = at(base, DB);
  const url = strip(prismaUrl);
  const psql = (sql: string, db = url) => execFileSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-d', db],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const fails = (fn: () => unknown): string => {
    try { fn(); } catch (e) { const x = e as { stdout?: string; stderr?: string }; return `${x.stdout ?? ''}${x.stderr ?? ''}`; }
    return '';
  };
  const deploy = (schema?: string) => execFileSync('npx', ['prisma', 'migrate', 'deploy', ...(schema ? ['--schema', schema] : [])],
    { cwd: API, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DATABASE_URL: prismaUrl }, timeout: 90_000 });
  const file = () => readFileSync(MIGRATION, 'utf8');

  /** 20280117's own writer, as production has it today: unqualified, with no search_path of its own. */
  const recordWriter = splitSql(readFileSync(RECORD, 'utf8')).find((s) => /FUNCTION media_tombstone_on_delete\(\)/.test(s))!;
  /** Back to production's state: the record and its writer as 20280117 left them, no guard, the guard's file pending. */
  const preInstall = () => psql(`
    DELETE FROM public."Media" WHERE "projectId" = 'pg-install';
    DROP TRIGGER IF EXISTS "Media_tombstone_guard" ON public."Media";
    DROP FUNCTION IF EXISTS public.media_tombstone_guard();
    ${recordWriter};
    DELETE FROM public._prisma_migrations WHERE migration_name = '${NAME}';`);
  const state = () => psql(`SELECT
      (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public."Media"'::regclass AND tgname = 'Media_tombstone_guard')
      || ' ' || (SELECT count(*) FROM pg_proc WHERE proname = 'media_tombstone_guard')
      || ' ' || coalesce((SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.media_tombstone_on_delete()'::regprocedure), 'none')`);
  const PRE = '0 0 none';
  const FULL = '1 1 search_path=pg_catalog, public, pg_temp';

  let seq = 0;
  const insert = (k: string) => `INSERT INTO public."Media" ("id", "projectId", "kind", "mime", "data", "sizeBytes", "uploadedBy", "clientKey")
    VALUES ('pg-install-${k}-${++seq}', 'pg-install', 'progress', 'image/png', '\\x61'::bytea, 1, 'pmc', '${k}')`;
  /** A key whose photo was stored and deleted before the guard: the database recorded it (20280117). */
  const deletedKey = () => {
    const k = `k${++seq}`;
    psql(`${insert(k)}; DELETE FROM public."Media" WHERE "clientKey" = '${k}';`);
    expect(psql(`SELECT count(*) FROM public."MediaTombstone" WHERE "projectId" = 'pg-install' AND "clientKey" = '${k}'`)).toBe('1');
    return k;
  };
  const rows = (k: string) => psql(`SELECT count(*) FROM public."Media" WHERE "projectId" = 'pg-install' AND "clientKey" = '${k}'`);

  /** A psql session held open on stdin, named so the lock tables can find it. */
  const session = (name: string) => {
    const p: ChildProcessWithoutNullStreams = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url],
      { env: { ...process.env, PGAPPNAME: name } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const exited = new Promise<{ code: number | null; out: string }>((r) => p.on('close', (code) => r({ code, out })));
    return { send: (sql: string) => p.stdin.write(`${sql}\n`), end: () => { p.stdin.end(); return exited; }, kill: () => p.kill('SIGKILL') };
  };
  const count = (sql: string) => Number(psql(sql));
  /** Polls the server's own lock and session tables; the cap only stops a hung run. */
  const until = async (what: string, cond: () => boolean) => {
    for (let i = 0; !cond(); i++) {
      if (i > 800) throw new Error(`never: ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /** The session holds this lock on "Media", granted. */
  const holdsMedia = (name: string, mode: string) => () => count(
    `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.application_name = '${name}' AND l.granted AND l.mode = '${mode}' AND l.relation = 'public."Media"'::regclass`) === 1;
  /** The session's transaction is open and has finished every statement sent to it. */
  const idleInTransaction = (name: string) => () => count(
    `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${name}' AND state = 'idle in transaction'`) === 1;
  const waitingOnMedia = (name: string) => () => count(
    `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.application_name = '${name}' AND NOT l.granted AND l.relation = 'public."Media"'::regclass`) === 1;

  beforeAll(() => {
    expect(base, 'these need a server to create their own database on').toBeTruthy();
    psql(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`, strip(at(base, 'postgres')));
    psql(`CREATE DATABASE "${DB}"`, strip(at(base, 'postgres')));
    deploy();
    psql(`INSERT INTO public."Org" ("id", "name", "slug") VALUES ('pg-install-org', 'Install', 'pg-install-org');
      INSERT INTO public."Project" ("id", "orgId", "name", "short", "descriptor", "stage", "siteCode", "projStart", "projEnd", "elapsedPct", "todayDay", "milestonePct")
      VALUES ('pg-install', 'pg-install-org', 'Install', 'Install', '', 'Planning', 'PGINST', '01 Jan 2026', '31 Dec 2026', 0, 0, 0);`);
  }, 300_000);

  afterAll(() => {
    if (base) psql(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`, strip(at(base, 'postgres')));
  });

  /** Every point a run can stop: between top-level statements, and inside the install block before each step. */
  const stops = (sql: string) => {
    const points: Array<{ at: number; inject: string }> = [];
    let cursor = 0;
    splitSql(sql).forEach((stmt, i) => {
      const start = sql.indexOf(stmt, cursor);
      cursor = start + stmt.length;
      if (i > 0) points.push({ at: start, inject: '\nSELECT 1/0;\n' });
    });
    for (const m of sql.matchAll(/^ {2}(EXECUTE \$|SELECT count\(\*\) INTO)/gm)) points.push({ at: m.index!, inject: '  PERFORM 1/0;\n' });
    return points;
  };

  it('a run stopped at any point under psql, with no transaction around it, commits nothing', () => {
    const sql = file();
    const points = stops(sql);
    expect(points.length).toBeGreaterThan(0);
    const partial: string[] = [];
    for (const p of points) {
      preInstall();
      const broken = `${sql.slice(0, p.at)}${p.inject}${sql.slice(p.at)}`;
      expect(fails(() => psql(broken))).toMatch(/division by zero/);
      const s = state();
      if (s !== PRE) partial.push(`stopped before ${JSON.stringify(sql.slice(p.at, p.at + 40))}: ${s}`);
    }
    expect(partial, 'a stopped run left part of the install committed').toEqual([]);
    preInstall();
    psql(sql);
    expect(state()).toBe(FULL);
  });

  it('a run stopped under prisma migrate deploy commits nothing and keeps its own cause in the log', () => {
    const sql = file();
    const tmp = mkdtempSync(join(tmpdir(), 'guard-install-'));
    try {
      cpSync(join(API, 'prisma/schema.prisma'), join(tmp, 'schema.prisma'));
      cpSync(MIGRATIONS, join(tmp, 'migrations'), { recursive: true });
      for (const p of stops(sql)) {
        preInstall();
        writeFileSync(join(tmp, 'migrations', NAME, 'migration.sql'), `${sql.slice(0, p.at)}${p.inject}${sql.slice(p.at)}`);
        expect(fails(() => deploy(join(tmp, 'schema.prisma')))).toMatch(/P3018|failed to apply/);
        expect(state()).toBe(PRE);
        expect(psql(`SELECT logs FROM public._prisma_migrations WHERE migration_name = '${NAME}'`)).toMatch(/division by zero/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 300_000);

  it('a stored row under a deleted photo\'s key stops the install under psql and under prisma, and installs nothing', () => {
    preInstall();
    const k = deletedKey();
    psql(insert(k)); // stored again before any guard, as a late copy could have been since #1022
    expect(fails(() => psql(file()))).toMatch(/1 stored photo\(s\) carry the key of a deleted photo/);
    expect(state()).toBe(PRE);
    const failed = fails(() => deploy());
    expect(failed).toMatch(/carry the key of a deleted photo/);
    expect(recovery(failed)).toContain(RESOLVE);
    expect(state()).toBe(PRE);
    expect(rows(k)).toBe('1');
    // once the owner has decided the row, the recorded failure is rolled back and the deploy installs the guard
    psql(`DELETE FROM public."Media" WHERE "projectId" = 'pg-install' AND "clientKey" = '${k}'`);
    execFileSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', NAME],
      { cwd: API, stdio: 'pipe', env: { ...process.env, DATABASE_URL: prismaUrl } });
    deploy();
    expect(state()).toBe(FULL);
    expect(fails(() => psql(insert(k)))).toMatch(/this photo was deleted/);
  }, 300_000);

  it('a write of a deleted photo\'s key in flight when the install starts is waited for, then stops the install', async () => {
    preInstall();
    const k = deletedKey();
    const writer = session('guard-install-old-writer');
    const install = session('guard-install-run');
    try {
      writer.send('BEGIN;');
      writer.send(`${insert(k)};`); // the previous release's send, not yet committed
      await until('the old release\'s write is in flight', holdsMedia('guard-install-old-writer', 'RowExclusiveLock'));
      install.send(file());
      const done = install.end();
      await until('the install waits for the write in flight', waitingOnMedia('guard-install-run'));
      writer.send('COMMIT;');
      expect((await writer.end()).code).toBe(0);
      const result = await done;
      expect(result.code, result.out).not.toBe(0);
      expect(result.out).toMatch(/carry the key of a deleted photo/);
      expect(state()).toBe(PRE);
      expect(rows(k)).toBe('1');
    } finally {
      writer.kill();
      install.kill();
    }
  }, 120_000);

  it('a write of a deleted photo\'s key that arrives during the install waits for it, then is refused', async () => {
    preInstall();
    const k = deletedKey();
    const install = session('guard-install-held');
    const writer = session('guard-install-late-writer');
    try {
      // the install, held open after its last statement so the write arrives while it runs
      install.send('BEGIN;');
      install.send(file());
      await until('the install holds its lock on "Media"', holdsMedia('guard-install-held', 'ShareRowExclusiveLock'));
      await until('the install has run every step, uncommitted', idleInTransaction('guard-install-held'));
      // on the record it holds only ACCESS SHARE, which conflicts with nothing but ACCESS EXCLUSIVE: it can be read
      expect(psql(`SELECT string_agg(l.mode, ',') FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = 'guard-install-held' AND l.relation = 'public."MediaTombstone"'::regclass`)).toBe('AccessShareLock');
      expect(psql(`SELECT count(*) FROM public."MediaTombstone" WHERE "projectId" = 'pg-install' AND "clientKey" = '${k}'`)).toBe('1');
      writer.send(`${insert(k)};`);
      const written = writer.end();
      await until('the write waits for the install', waitingOnMedia('guard-install-late-writer'));
      install.send('COMMIT;');
      expect((await install.end()).code).toBe(0);
      const result = await written;
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/this photo was deleted/);
      expect(state()).toBe(FULL);
      expect(rows(k)).toBe('0');
    } finally {
      writer.kill();
      install.kill();
    }
  }, 120_000);

  it('a holder of "Media" past 15 s makes the install fail with nothing installed; once it lets go, resolve and redeploy install', async () => {
    preInstall();
    const holder = session('guard-install-long-holder');
    try {
      // a write lock held past any app write, as a stray open session holds it
      holder.send('BEGIN;');
      holder.send(`${insert(`hold${++seq}`)};`);
      await until('the holder has its write lock', holdsMedia('guard-install-long-holder', 'RowExclusiveLock'));
      const failed = fails(() => deploy());
      expect(failed).toMatch(/lock timeout/);
      expect(state()).toBe(PRE);
      expect(recovery(failed)).toContain(RESOLVE);
      // the next deploy stops at the recorded failure until it is resolved
      holder.send('ROLLBACK;');
      expect((await holder.end()).code).toBe(0);
      const stopped = fails(() => deploy());
      expect(stopped).toMatch(/P3009/);
      expect(recovery(stopped)).toContain(RESOLVE);
      execFileSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', NAME],
        { cwd: API, stdio: 'pipe', env: { ...process.env, DATABASE_URL: prismaUrl } });
      deploy();
      expect(state()).toBe(FULL);
    } finally {
      holder.kill();
    }
  }, 120_000);

  it('the install and project:remove\'s lock on "Media" never wait in a cycle: whichever holds it first, the other waits or refuses', async () => {
    const removeLock = readFileSync(join(API, 'src/platform/project-remove.ts'), 'utf8');
    expect(removeLock).toMatch(REMOVE_LOCK);
    const lockAsRemove = 'LOCK TABLE public."Media" IN SHARE ROW EXCLUSIVE MODE NOWAIT';

    // the install first: project:remove's NOWAIT refuses at once, and changes nothing
    preInstall();
    const install = session('guard-install-before-remove');
    try {
      install.send('BEGIN;');
      install.send(file());
      await until('the install holds its lock on "Media"', holdsMedia('guard-install-before-remove', 'ShareRowExclusiveLock'));
      expect(fails(() => psql(`BEGIN; ${lockAsRemove}; COMMIT;`))).toMatch(/could not obtain lock on relation/);
      install.send('COMMIT;');
      expect((await install.end()).code).toBe(0);
      expect(state()).toBe(FULL);
    } finally {
      install.kill();
    }

    // project:remove first: the install waits for its run to end, then installs
    preInstall();
    const remove = session('guard-install-remove');
    const late = session('guard-install-after-remove');
    try {
      remove.send('BEGIN;');
      remove.send(`${lockAsRemove};`);
      await until('project:remove holds "Media"', holdsMedia('guard-install-remove', 'ShareRowExclusiveLock'));
      late.send(file());
      const done = late.end();
      await until('the install waits for project:remove', waitingOnMedia('guard-install-after-remove'));
      remove.send('COMMIT;');
      expect((await remove.end()).code).toBe(0);
      expect((await done).code).toBe(0);
      expect(state()).toBe(FULL);
    } finally {
      remove.kill();
      late.kill();
    }
  }, 120_000);
});
