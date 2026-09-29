import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECISIONS_INBOX_CATALOG_VERSION, DECISIONS_PROJECTION, makeDecisionsProjectionConsumer } from './decisions.projection';
import { WRITER_FENCE_MIGRATION, WRITER_FENCE_REISSUE_MIGRATION, fenceBodyMigration } from '../platform/projections/inbox-repair-seals';

/**
 * Phase 6 task 4d-ii-a / A7c — the `decisions.inbox` contract version is stated in THREE places that
 * cannot be allowed to drift: the compiled consumer (what `syncConsumerCatalog` asserts and the
 * writer declares), the catalog-data migration (what the persisted row is moved to and what the
 * re-issued fence reads), and the verifier's name for the migration whose literal is the fence's
 * current body. Each pair is pinned here, against the migration TEXT, so a future bump that moves one
 * and forgets another fails at unit time rather than at the first upgraded process's startup.
 */
describe('4d-ii-a / A7c — the decisions.inbox contract version is one number in three places', () => {
  const API = join(__dirname, '..', '..');
  const migrationSql = (name: string) => readFileSync(join(API, 'prisma', 'migrations', name, 'migration.sql'), 'utf8');

  it('the compiled consumer declares the constant, and the constant is 3', () => {
    expect(DECISIONS_INBOX_CATALOG_VERSION).toBe(3);
    const consumer = makeDecisionsProjectionConsumer();
    expect(consumer.name).toBe(DECISIONS_PROJECTION);
    expect(consumer.catalogVersion).toBe(DECISIONS_INBOX_CATALOG_VERSION);
  });

  it('the re-issuing migration moves the persisted row FROM the previous version TO the constant, guarded on the version it moves from', () => {
    const sql = migrationSql(WRITER_FENCE_REISSUE_MIGRATION);
    const v = DECISIONS_INBOX_CATALOG_VERSION;
    expect(sql).toContain(`UPDATE "OutboxConsumerCatalog" SET "catalogVersion" = ${v}\n WHERE "consumer" = 'decisions.inbox' AND "catalogVersion" = ${v - 1};`);
    // and its own verification refuses a row left anywhere else
    expect(sql).toContain(`WHERE "consumer" = 'decisions.inbox' AND "catalogVersion" <> ${v};`);
  });

  it('both re-issued fence functions read the constant as the declaration, and nothing else in that file reads the old one', () => {
    const sql = migrationSql(WRITER_FENCE_REISSUE_MIGRATION);
    const declared = [...sql.matchAll(/declared = '(\d+)'/g)].map((m) => m[1]);
    expect(declared, 'one declaration per re-issued function body').toEqual([String(DECISIONS_INBOX_CATALOG_VERSION), String(DECISIONS_INBOX_CATALOG_VERSION)]);
    // the installing migration still reads the version it was written for — it is replayed FIRST on
    // a baseline and this file's later re-issue is what stands, so it must never be edited to agree
    const installing = migrationSql(WRITER_FENCE_MIGRATION);
    expect([...installing.matchAll(/declared = '(\d+)'/g)].map((m) => m[1])).toEqual(['2', '2']);
  });

  it('the verifier reads the two re-issued bodies from the re-issuing migration and the stamp seal from the installing one', () => {
    expect(fenceBodyMigration('fence')).toBe(WRITER_FENCE_REISSUE_MIGRATION);
    expect(fenceBodyMigration('truncate')).toBe(WRITER_FENCE_REISSUE_MIGRATION);
    expect(fenceBodyMigration('sealed')).toBe(WRITER_FENCE_MIGRATION);
    // the re-issuing file carries no `$sealed$` literal: the stamp seal was never re-issued
    expect(migrationSql(WRITER_FENCE_REISSUE_MIGRATION)).not.toMatch(/\$sealed\$/);
  });

  it('the re-issuing migration is on ALWAYS_EXECUTE, after the installing one, and the parse corpus counts it', () => {
    const runner = readFileSync(join(API, 'scripts', 'migrate.sh'), 'utf8');
    const list = /ALWAYS_EXECUTE="([^"]*)"/u.exec(runner);
    expect(list).toBeTruthy();
    const named = list![1].split('\n').map((l) => l.trim()).filter(Boolean);
    expect(named).toContain(WRITER_FENCE_REISSUE_MIGRATION);
    expect(named.indexOf(WRITER_FENCE_REISSUE_MIGRATION)).toBeGreaterThan(named.indexOf(WRITER_FENCE_MIGRATION));
  });
});
