import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset, TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';
import { createMediaSchema } from '../../src/contracts';

/**
 * #1118 U1a-3 — the Hub fetched-blob ledger (`20280121200000_hub_fetched_blob`), against live PostgreSQL. It proves what
 * the database holds on every writer (B1-B5 in the migration): the keys, the owner, that a row is never changed or
 * truncated while the sweep's DELETE stays open, that a key is exactly `keyFor(projectId, 'hub', mime)` and so never a
 * native drawing or media key (#1139 r4385819935, A13), that every row is well formed, and that the file re-runs, drops
 * #1139's old key check, and changes nothing else.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280121200000_hub_fetched_blob/migration.sql');
const TABLE = 'HubFetchedBlob';
const UUID = '3f2a9c1e-5b7d-4e2f-8a6c-0d1e2f3a4b5c';

describe('#1118 U1a-3 — the Hub fetched-blob ledger (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];
  const storage = new StorageService();

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      // each project takes its ledger rows with it
      for (const id of made) await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = (file = MIGRATION) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', file], { stdio: 'pipe' });
  // a project of its own per test, so its rows and its delete stay out of the fixture's projects
  const project = async (tag: string) => {
    const id = `it-hubb-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId: f.orgA.id, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  const insert = (id: string, storageKey: string, projectId: string, hubVersionId = 'v') =>
    raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ($1, $2, $3, $4)`, id, storageKey, projectId, hubVersionId);
  const hubKey = (projectId: string, mime = 'application/pdf') => storage.keyFor(projectId, 'hub', mime);

  it('B1 and B2: one row per storage key, a project that exists, and each row goes with its project', async () => {
    const p = await project('b1');
    const key = hubKey(p);
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: key, projectId: p, hubVersionId: 'v' } });
    await expect(t.prisma.hubFetchedBlob.create({ data: { storageKey: key, projectId: p, hubVersionId: 'w' } })).rejects.toThrow();
    await expect(insert(`b1u-${run}`, key, p, 'w')).rejects.toThrow(/23505[\s\S]*Key \(\\?"storageKey\\?"\)/);
    await expect(insert(`b1f-${run}`, `no-such-project/hub/${UUID}.pdf`, 'no-such-project')).rejects.toThrow(/HubFetchedBlob_projectId_fkey/);

    const gone = await project('b1d');
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: hubKey(gone), projectId: gone, hubVersionId: 'v' } });
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, gone);
    expect(await t.prisma.hubFetchedBlob.count({ where: { projectId: gone } })).toBe(0);
    expect(await t.prisma.hubFetchedBlob.count({ where: { projectId: p } })).toBe(1);
  });

  it('B3: a row is never changed or truncated; the sweep\'s DELETE of a row is its one designed delete', async () => {
    const p = await project('b3');
    const other = await project('b3o');
    const key = hubKey(p);
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: key, projectId: p, hubVersionId: 'v' } });
    // never changed, so its project and key never move together into another project's namespace
    for (const set of [
      `"projectId" = '${other}', "storageKey" = '${other}/hub/${UUID}.pdf'`, `"hubVersionId" = 'w'`, `"storageKey" = '${p}/hub/${UUID}.pdf'`,
      `"fetchedAt" = now()`, `"id" = 'moved'`,
      // the same value is still a write, and still refused
      `"hubVersionId" = "hubVersionId"`,
    ]) {
      await expect(raw(`UPDATE "HubFetchedBlob" SET ${set} WHERE "projectId" = $1`, p), set).rejects.toThrow(/HubFetchedBlob row is a record and is never changed/);
    }
    await expect(raw(`TRUNCATE TABLE "${TABLE}" CASCADE`)).rejects.toThrow(/HubFetchedBlob rows are records and are never truncated/);
    expect(await t.prisma.hubFetchedBlob.findMany({ where: { projectId: p } })).toEqual([expect.objectContaining({ storageKey: key, hubVersionId: 'v' })]);
    // the sweep (U5s) deletes a ledger row per blob it removes
    expect(await raw(`DELETE FROM "HubFetchedBlob" WHERE "storageKey" = $1`, key)).toBe(1);
    expect(await t.prisma.hubFetchedBlob.count({ where: { projectId: p } })).toBe(0);
  });

  it('B4: a key is exactly keyFor(projectId, \'hub\', mime), so no native drawing or media key is ever one', async () => {
    const p = await project('b4');
    const q = await project('b4q');
    // accepted: what keyFor makes, for a known mime and for an unknown one (.bin); and a project id with LIKE wildcards,
    // matched exactly (starts_with has none)
    const wild = await project('b4_%');
    const accepted = [hubKey(p), hubKey(p, 'image/vnd.dwg'), hubKey(p, 'application/x-unknown'), hubKey(wild)];
    expect(accepted[2]).toMatch(/\.bin$/);
    for (const [i, key] of accepted.entries()) await insert(`b4a${i}-${run}`, key, key === accepted[3] ? wild : p);

    const refused: Array<[string, string]> = [
      // #1139's namespace, inside the native drawings prefix (r4385819935)
      [`${p}/drawings/hub/${UUID}.pdf`, p],
      // A13: climbing out of the prefix, and any further '/'
      [`${p}/hub/../x.pdf`, p], [`${p}/hub/../../${q}/drawings/${UUID}.pdf`, p], [`${p}/hub/a/${UUID}.pdf`, p],
      // not keyFor's tail: no extension, upper case, a bare or long extension, a '.' before it, no uuid, the bare prefix
      [`${p}/hub/${UUID}`, p], [`${p}/hub/${UUID.toUpperCase()}.pdf`, p], [`${p}/hub/${UUID}.PDF`, p], [`${p}/hub/${UUID}.`, p],
      [`${p}/hub/${UUID}.abcdefghi`, p], [`${p}/hub/x.${UUID}.pdf`, p], [`${p}/hub/x.pdf`, p], [`${p}/hub/`, p], [`${p}/hub/${UUID}.pdf/`, p],
      [`${p}/hub/${UUID}.pdf\n`, p],
      // another project's namespace, a prefix of the project id, a wildcard project's look-alike
      [`${q}/hub/${UUID}.pdf`, p], [`${p.slice(0, -1)}/hub/${UUID}.pdf`, p], [`${wild.replace('_%', 'ab')}/hub/${UUID}.pdf`, wild],
      [`${p.toUpperCase()}/hub/${UUID}.pdf`, p], [`x/${p}/hub/${UUID}.pdf`, p],
      // a media key and blanks
      [`${p}/progress/${UUID}.jpg`, p], ['', p], [' ', p],
    ];
    for (const [key, projectId] of refused) {
      await expect(insert(`b4r-${run}`, key, projectId), JSON.stringify(key)).rejects.toThrow(/HubFetchedBlob_storageKey_shape/);
    }
    // K5: a project id holding '/' could otherwise make a ledger key that the native guard accepts ("q/drawings/" prefix)
    const k5 = `it-hubb-x/drawings/y-${run}`;
    await t.prisma.project.create({ data: {
      id: k5, orgId: f.orgA.id, name: k5, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(k5);
    await expect(insert(`b4k5-${run}`, hubKey(k5), k5)).rejects.toThrow(/HubFetchedBlob_storageKey_shape/);

    // disjoint: every key the app makes for a native drawing or a photo is refused, for every mime keyFor knows
    const kinds = ['drawings', ...createMediaSchema.innerType().shape.kind.options];
    expect(kinds).toEqual(['drawings', 'progress', 'inspection', 'decision', 'attendance', 'material', 'visit']);
    for (const kind of kinds) {
      for (const mime of ['application/pdf', 'image/jpeg', 'image/png', 'image/vnd.dwg', 'application/x-unknown']) {
        const key = storage.keyFor(p, kind, mime);
        await expect(insert(`b4d-${run}`, key, p), key).rejects.toThrow(/HubFetchedBlob_storageKey_shape/);
      }
    }
    expect(await t.prisma.hubFetchedBlob.count({ where: { projectId: { in: [p, wild] } } })).toBe(4);
  });

  it('B5: the id and the Hub version hold more than whitespace', async () => {
    const p = await project('b5');
    for (const b of ['', ' ', '\t', ' \n\r\f\v ']) {
      const why = JSON.stringify(b);
      await expect(insert(b, hubKey(p), p), why).rejects.toThrow(/HubFetchedBlob_id_present/);
      await expect(insert(`b5-${run}`, hubKey(p), p, b), why).rejects.toThrow(/HubFetchedBlob_hubVersionId_present/);
    }
    expect(await t.prisma.hubFetchedBlob.count({ where: { projectId: p } })).toBe(0);
  });

  it('B3: the sanctioned reset lifts the TRUNCATE seal by name and puts it back', async () => {
    const seals = await t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 32) <> 0`, `"${TABLE}"`);
    expect(seals.map((x) => x.name)).toEqual([`${TABLE}_no_truncate`]);
    expect(TRUNCATE_SEALS).toContainEqual({ table: TABLE, trigger: `${TABLE}_no_truncate` });
    await sanctionedReset(t.prisma, [TABLE]);
    expect(await t.prisma.hubFetchedBlob.count()).toBe(0);
    const states = await t.prisma.$queryRawUnsafe<Array<{ enabled: string }>>(`SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = $1`, `${TABLE}_no_truncate`);
    expect(states.map((x) => x.enabled)).toEqual(['O']);
  });

  it('re-runs: a second and third run leave the same keys, checks, triggers and functions, and #1139\'s old key check is dropped', async () => {
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ kind: string; name: string; def: string }>>(`
      SELECT 'index' AS kind, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid::regclass::text = $2
      UNION ALL
      SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = $2
      UNION ALL
      SELECT 'function', p.proname, array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('drawings_hub_record_sealed', 'drawings_hub_record_no_truncate')
      ORDER BY 1, 2`, TABLE, `"${TABLE}"`);
    const before = await shape();
    expect(before.filter((r) => r.kind === 'index')).toHaveLength(3);
    expect(before.filter((r) => r.kind === 'trigger')).toHaveLength(2);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('CHECK'))).toHaveLength(3);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('FOREIGN KEY'))).toHaveLength(1);
    expect(before.filter((r) => r.kind === 'function').map((r) => r.def)).toEqual(Array(2).fill('search_path=pg_catalog, public, pg_temp'));
    replay();
    replay();
    expect(await shape()).toEqual(before);

    // a database that ran a #1139 head holds the old check: the file drops it, and a new key then commits
    await raw(`ALTER TABLE "HubFetchedBlob" ADD CONSTRAINT "HubFetchedBlob_storageKey_in_project" CHECK (
      pg_catalog.starts_with("storageKey", "projectId" || '/drawings/hub/')) NOT VALID`);
    const p = await project('rr');
    await expect(insert(`rr0-${run}`, hubKey(p), p)).rejects.toThrow(/HubFetchedBlob_storageKey_in_project/);
    replay();
    expect(await shape()).toEqual(before);
    await insert(`rr1-${run}`, hubKey(p), p);

    // one transaction: a run that fails at its last statement leaves nothing of itself, its dropped triggers and
    // checks included
    const dir = mkdtempSync(join(tmpdir(), 'hub-blob-'));
    try {
      const sql = readFileSync(MIGRATION, 'utf8');
      expect(sql.trimEnd().endsWith('\nCOMMIT;')).toBe(true);
      const failing = join(dir, 'failing.sql');
      writeFileSync(failing, sql.replace(/\nCOMMIT;\s*$/, '\nSELECT 1 / 0;\nCOMMIT;\n'));
      expect(() => replay(failing)).toThrow(/division by zero/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await shape()).toEqual(before);
  });
});
