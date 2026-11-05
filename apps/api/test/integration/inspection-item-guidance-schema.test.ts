import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Guided site inspections, step 1 — `20280210000000_inspection_item_guidance` adds the nullable guidance and record spec
 * to "InspectionItem" ("lookAt", "passRule", "recordKind", "recordCount", "recordWhen", "recordHint") and "workType" to
 * "Inspection", kept by three CHECKs and one trigger. This proves that rows written as the previous release writes them
 * (never naming the columns) still go in and read NULL, and its item updates still go through; that each CHECK holds
 * both ways at its bounds; that an issued item's guidance is never changed afterwards; and that the file re-runs,
 * restoring a loosened CHECK and refusing a same-named column of another type.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280210000000_inspection_item_guidance/migration.sql');
const GUIDANCE = 'InspectionItem_guidance_text';
const SPEC = 'InspectionItem_record_spec';
const WORK_TYPE = 'Inspection_work_type_text';
const WS = ' \t\n\r\f\v ';
const TRIGGER_DEF = 'CREATE TRIGGER "InspectionItem_guidance_fixed" BEFORE UPDATE OF "lookAt", "passRule", "recordKind", "recordCount", "recordWhen", "recordHint" '
  + 'ON public."InspectionItem" FOR EACH ROW EXECUTE FUNCTION inspection_item_guidance_fixed()';

describe('guided site inspections step 1 — item guidance and record spec (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  let seq = 0;
  const inspections: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      if (inspections.length) {
        await t.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspections } } });
        await t.prisma.inspection.deleteMany({ where: { id: { in: inspections } } });
      }
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  /** an inspection as the previous release writes it: "workType" is never named */
  const inspection = async (workType?: string | null) => {
    const id = `INSP-guide-${run}-${++seq}`;
    if (workType === undefined) {
      await raw(`INSERT INTO "Inspection" ("id", "projectId", "kind", "title", "zone", "date") VALUES ($1, $2, 'checklist', 'Slab before pour', 'GF', 'today')`, id, f.projectA.id);
    } else {
      await raw(`INSERT INTO "Inspection" ("id", "projectId", "kind", "title", "zone", "date", "workType") VALUES ($1, $2, 'checklist', 'Slab before pour', 'GF', 'today', $3)`, id, f.projectA.id, workType);
    }
    inspections.push(id);
    return id;
  };
  /** an item as the previous release writes it: none of the guidance columns is named */
  const plainItem = async (inspectionId: string) => {
    const id = `it-guide-${run}-${++seq}`;
    await raw(`INSERT INTO "InspectionItem" ("id", "inspectionId", "name", "order") VALUES ($1, $2, 'Cover blocks', 0)`, id, inspectionId);
    return id;
  };
  type Guidance = { lookAt?: string | null; passRule?: string | null; recordKind?: string | null; recordCount?: number | null; recordWhen?: string | null; recordHint?: string | null };
  const guidedItem = async (inspectionId: string, g: Guidance) => {
    const id = `it-guide-${run}-${++seq}`;
    await raw(
      `INSERT INTO "InspectionItem" ("id", "inspectionId", "name", "order", "lookAt", "passRule", "recordKind", "recordCount", "recordWhen", "recordHint")
       VALUES ($1, $2, 'Cover blocks', 0, $3, $4, $5, $6, $7, $8)`,
      id, inspectionId, g.lookAt ?? null, g.passRule ?? null, g.recordKind ?? null, g.recordCount ?? null, g.recordWhen ?? null, g.recordHint ?? null,
    );
    return id;
  };
  const guidanceOf = (id: string) => t.prisma.inspectionItem.findUniqueOrThrow({
    where: { id }, select: { lookAt: true, passRule: true, recordKind: true, recordCount: true, recordWhen: true, recordHint: true },
  });
  const checkDefs = async () => t.prisma.$queryRawUnsafe<Array<{ name: string; def: string }>>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('${GUIDANCE}', '${SPEC}', '${WORK_TYPE}') ORDER BY conname`);
  const runFile = () => {
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    const host = new URLSearchParams((process.env.DATABASE_URL ?? '').split('?')[1] ?? '').get('host');
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(host ? ['-h', host] : []), '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  };
  const triggerDef = async () => (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = '"InspectionItem"'::regclass AND tgname = 'InspectionItem_guidance_fixed'`))[0]?.def;
  /** the SQLSTATE a statement fails with, read straight from PostgreSQL */
  const sqlstate = async (sql: string, ...values: unknown[]) => {
    try {
      await raw(sql, ...values);
    } catch (e) {
      const meta = (e as { meta?: { code?: string } }).meta;
      return meta?.code ?? String(e).match(/Code: `(\w+)`/)?.[1] ?? String(e);
    }
    return 'no error';
  };
  const full: Guidance = { lookAt: 'Lift the steel at three spots', passRule: 'A block under each, gap at least 25 mm', recordKind: 'photo', recordCount: 1, recordWhen: 'always', recordHint: 'Hold a tape against the steel' };

  it('rows written as the previous release writes them go in, read NULL, and its item updates still go through', async () => {
    const i = await inspection();
    const item = await plainItem(i);
    expect(await guidanceOf(item)).toEqual({ lookAt: null, passRule: null, recordKind: null, recordCount: null, recordWhen: null, recordHint: null });
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: i }, select: { workType: true } })).workType).toBeNull();
    // the previous release's submit and decide writes on an item: state, photos, note, then result and rejected
    await t.prisma.inspectionItem.updateMany({ where: { id: item, inspectionId: i }, data: { state: 'fail', photos: 1, note: 'one block missing' } });
    await t.prisma.inspectionItem.update({ where: { id: item }, data: { rejected: true } });
    // and on a guided item too: those writes never touch its guidance
    const guided = await guidedItem(i, full);
    await t.prisma.inspectionItem.updateMany({ where: { id: guided, inspectionId: i }, data: { state: 'pass', photos: 1, note: '' } });
    expect(await guidanceOf(guided)).toEqual(full);
  });

  it('an item may carry guidance, a whole record spec, both or neither, at the bounds', async () => {
    const i = await inspection();
    const cases: Guidance[] = [
      full,
      { lookAt: 'Look along the edges' },
      { passRule: 'No gaps over 3 mm' },
      { recordKind: 'video', recordCount: 10, recordWhen: 'fail' },
      { recordKind: 'voice', recordCount: 1, recordWhen: 'always', recordHint: 'h'.repeat(300) },
      { lookAt: 'l'.repeat(500), passRule: 'p'.repeat(500) },
      // the bounds count characters, not bytes: Gujarati and Hindi text is three bytes a character
      { lookAt: 'જ'.repeat(500), passRule: 'ज'.repeat(500), recordKind: 'photo', recordCount: 1, recordWhen: 'fail', recordHint: 'ટ'.repeat(300) },
    ];
    for (const g of cases) {
      const item = await guidedItem(i, g);
      expect(await guidanceOf(item)).toEqual({ lookAt: null, passRule: null, recordKind: null, recordCount: null, recordWhen: null, recordHint: null, ...g });
    }
  });

  it('refuses blank or over-long guidance', async () => {
    const i = await inspection();
    const bad: Guidance[] = [
      { lookAt: '' }, { lookAt: WS }, { lookAt: 'l'.repeat(501) }, { lookAt: 'જ'.repeat(501) },
      { passRule: '' }, { passRule: WS }, { passRule: 'p'.repeat(501) }, { passRule: 'ज'.repeat(501) },
    ];
    for (const g of bad) await expect(guidedItem(i, g), JSON.stringify(g)).rejects.toThrow(new RegExp(GUIDANCE));
  });

  it('refuses a partial record spec, an unknown kind or when, a count out of 1-10, and a blank, long or orphan hint', async () => {
    const i = await inspection();
    const bad: Guidance[] = [
      { recordKind: 'photo' }, { recordKind: 'photo', recordCount: 1 }, { recordCount: 1, recordWhen: 'always' }, { recordWhen: 'fail' },
      { recordKind: 'drawing', recordCount: 1, recordWhen: 'always' }, { recordKind: 'Photo', recordCount: 1, recordWhen: 'always' },
      { recordKind: 'photo', recordCount: 1, recordWhen: 'sometimes' },
      { recordKind: 'photo', recordCount: 0, recordWhen: 'always' }, { recordKind: 'photo', recordCount: 11, recordWhen: 'always' },
      { recordKind: 'photo', recordCount: -1, recordWhen: 'always' },
      { recordKind: 'photo', recordCount: 1, recordWhen: 'always', recordHint: '' },
      { recordKind: 'photo', recordCount: 1, recordWhen: 'always', recordHint: WS },
      { recordKind: 'photo', recordCount: 1, recordWhen: 'always', recordHint: 'h'.repeat(301) },
      { recordHint: 'Hold a tape' },
    ];
    for (const g of bad) await expect(guidedItem(i, g), JSON.stringify(g)).rejects.toThrow(new RegExp(SPEC));
  });

  it('a work type is optional, never blank and at most 64 characters', async () => {
    for (const ok of [null, 'RCC slab', 'w'.repeat(64), 'સ'.repeat(64)]) {
      const i = await inspection(ok);
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: i }, select: { workType: true } })).workType).toBe(ok);
    }
    for (const bad of ['', WS, 'w'.repeat(65)]) await expect(inspection(bad), JSON.stringify(bad)).rejects.toThrow(new RegExp(WORK_TYPE));
    // it may be set later, as a label
    const later = await inspection();
    await t.prisma.inspection.update({ where: { id: later }, data: { workType: 'Waterproofing' } });
    await expect(t.prisma.inspection.update({ where: { id: later }, data: { workType: ' ' } })).rejects.toThrow(new RegExp(WORK_TYPE));
  });

  it('an issued item keeps its guidance: it is never set later, changed or cleared', async () => {
    const i = await inspection();
    const plain = await plainItem(i);
    await expect(raw(`UPDATE "InspectionItem" SET "lookAt" = 'Look' WHERE "id" = $1`, plain)).rejects.toThrow(/keeps the guidance it was issued with/);
    const guided = await guidedItem(i, full);
    for (const sql of [
      `UPDATE "InspectionItem" SET "passRule" = 'Any gap' WHERE "id" = $1`,
      `UPDATE "InspectionItem" SET "lookAt" = NULL WHERE "id" = $1`,
      `UPDATE "InspectionItem" SET "recordKind" = 'video' WHERE "id" = $1`,
      `UPDATE "InspectionItem" SET "recordCount" = 2 WHERE "id" = $1`,
      `UPDATE "InspectionItem" SET "recordWhen" = 'fail' WHERE "id" = $1`,
      `UPDATE "InspectionItem" SET "recordHint" = NULL WHERE "id" = $1`,
      `UPDATE "InspectionItem" SET "recordKind" = NULL, "recordCount" = NULL, "recordWhen" = NULL, "recordHint" = NULL WHERE "id" = $1`,
    ]) await expect(raw(sql, guided), sql).rejects.toThrow(/keeps the guidance it was issued with/);
    expect(await guidanceOf(guided)).toEqual(full);
    expect(await sqlstate(`UPDATE "InspectionItem" SET "passRule" = 'Any gap' WHERE "id" = $1`, guided)).toBe('23514');
    // an upsert that would rewrite it is refused too
    await expect(raw(`INSERT INTO "InspectionItem" ("id", "inspectionId", "name", "order") VALUES ($1, $2, 'Cover blocks', 0)
                      ON CONFLICT ("id") DO UPDATE SET "lookAt" = 'Other'`, guided, i)).rejects.toThrow(/keeps the guidance it was issued with/);
    // a write that names a column but keeps its value is not a change
    expect(await raw(`UPDATE "InspectionItem" SET "lookAt" = "lookAt", "note" = 'kept' WHERE "id" = $1`, guided)).toBe(1);
  });

  it('the file re-runs on a database that has it, keeping every row and the exact CHECKs and trigger', async () => {
    const i = await inspection('Tiling');
    const item = await guidedItem(i, full);
    const before = await checkDefs();
    expect(before.map((r) => r.name)).toEqual([WORK_TYPE, GUIDANCE, SPEC].sort());
    runFile();
    runFile();
    expect(await checkDefs()).toEqual(before);
    expect(await guidanceOf(item)).toEqual(full);
    const triggers = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = '"InspectionItem"'::regclass AND tgname = 'InspectionItem_guidance_fixed' AND NOT tgisinternal`);
    expect(Number(triggers[0]!.n)).toBe(1);
    const fn = await t.prisma.$queryRawUnsafe<Array<{ cfg: string[] }>>(`SELECT proconfig AS cfg FROM pg_proc WHERE proname = 'inspection_item_guidance_fixed'`);
    expect(fn).toEqual([{ cfg: ['search_path=pg_catalog, public, pg_temp'] }]);
    expect(await triggerDef()).toBe(TRIGGER_DEF);
  });

  it('a re-run restores a loosened CHECK and a dropped trigger, and refuses a same-named column that is not of its type', async () => {
    const exact = await checkDefs();
    await raw(`ALTER TABLE "InspectionItem" DROP CONSTRAINT "${SPEC}"`);
    await raw(`ALTER TABLE "InspectionItem" ADD CONSTRAINT "${SPEC}" CHECK (true)`);
    await raw(`DROP TRIGGER "InspectionItem_guidance_fixed" ON "InspectionItem"`);
    runFile();
    expect(await checkDefs()).toEqual(exact);
    const i = await inspection();
    const guided = await guidedItem(i, full);
    await expect(raw(`UPDATE "InspectionItem" SET "lookAt" = 'Other' WHERE "id" = $1`, guided)).rejects.toThrow(/keeps the guidance it was issued with/);

    await raw(`ALTER TABLE "InspectionItem" DROP CONSTRAINT "${SPEC}"`);
    await raw(`ALTER TABLE "InspectionItem" RENAME COLUMN "recordCount" TO "recordCount_kept"`);
    await raw(`ALTER TABLE "InspectionItem" ADD COLUMN "recordCount" TEXT`);
    try {
      expect(runFile).toThrow(/InspectionItem\.recordCount already stands as text/);
    } finally {
      await raw(`ALTER TABLE "InspectionItem" DROP COLUMN "recordCount"`);
      await raw(`ALTER TABLE "InspectionItem" RENAME COLUMN "recordCount_kept" TO "recordCount"`);
      runFile();
    }
    expect(await checkDefs()).toEqual(exact);
  });

  it('a re-run refuses a same-named column that is NOT NULL or has a default, on either table', async () => {
    const exact = await checkDefs();
    const swaps: Array<[string, string, string, RegExp]> = [
      ['InspectionItem', 'recordHint', `TEXT NOT NULL DEFAULT 'x'`, /InspectionItem\.recordHint already stands as text \(not null: t, default: t\)/],
      ['Inspection', 'workType', `TEXT DEFAULT 'RCC slab'`, /Inspection\.workType already stands as text \(not null: f, default: t\)/],
    ];
    for (const [tbl, col, decl, err] of swaps) {
      const checks = tbl === 'Inspection' ? [WORK_TYPE] : [GUIDANCE, SPEC];
      for (const c of checks) await raw(`ALTER TABLE "${tbl}" DROP CONSTRAINT "${c}"`);
      if (tbl === 'InspectionItem') await raw(`DROP TRIGGER "InspectionItem_guidance_fixed" ON "InspectionItem"`);
      await raw(`ALTER TABLE "${tbl}" RENAME COLUMN "${col}" TO "${col}_kept"`);
      await raw(`ALTER TABLE "${tbl}" ADD COLUMN "${col}" ${decl}`);
      try {
        expect(runFile, col).toThrow(err);
      } finally {
        await raw(`ALTER TABLE "${tbl}" DROP COLUMN "${col}"`);
        await raw(`ALTER TABLE "${tbl}" RENAME COLUMN "${col}_kept" TO "${col}"`);
        runFile();
      }
    }
    expect(await checkDefs()).toEqual(exact);
    expect(await triggerDef()).toBe(TRIGGER_DEF);
  });
});
