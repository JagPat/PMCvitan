import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset, TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';

/**
 * #1118 U1b — a drawing's source and the Hub records of a Hub drawing (`20280122000000_hub_drawing_identity`), against
 * live PostgreSQL. It proves what the database holds on every writer (I1-I7 in the migration): a revision's source is
 * its drawing's, a source never changes, a Hub drawing or revision commits only with its record, the records belong to
 * a Hub drawing and its own revisions by key (#1135 4381565873), a Hub drawing or revision is never deleted while its
 * record exists (#1135 4381565882), the records are sealed, every key is one per Hub file, version and order, and the
 * file re-runs and changes nothing. PMC's own drawings are written, revised, published and deleted as before.
 *
 * Every row is on a project of this file's own. Hub records go only through `project:remove` or the sanctioned reset,
 * so `afterAll` clears them with the reset, then the drawings, then the projects.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280122000000_hub_drawing_identity/migration.sql');
const RECORDS = ['HubGoverningMark', 'HubRevision', 'HubDrawing'] as const;

describe('#1118 U1b — a drawing\'s source and its Hub records (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      await sanctionedReset(t.prisma, [...RECORDS]);
      for (const id of made) {
        await raw(`DELETE FROM "Drawing" WHERE "projectId" = $1`, id);
        await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
      }
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = (file = MIGRATION) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', file], { stdio: 'pipe' });
  const project = async (tag: string) => {
    const id = `it-hubd-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId: f.orgA.id, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  const drawing = (p: string, id: string, source = 'pmc') =>
    raw(`INSERT INTO "Drawing" ("id", "projectId", "number", "title", "discipline", "source") VALUES ($1, $2, $1, 't', 'other', $3)`, id, p, source);
  const revision = (p: string, d: string, id: string, source = 'pmc', rev = id) =>
    raw(`INSERT INTO "DrawingRevision" ("id", "projectId", "drawingId", "rev", "status", "mime", "issuedBy", "issuedAt", "source")
         VALUES ($1, $2, $3, $4, 'for_review', 'application/pdf', 'u', 't', $5)`, id, p, d, rev, source);
  const hubDrawing = (p: string, d: string, hubFileId = `f-${d}`, hubProjectId = 'hp', source = 'hub') =>
    raw(`INSERT INTO "HubDrawing" ("projectId", "drawingId", "source", "hubFileId", "hubProjectId") VALUES ($1, $2, $3, $4, $5)`, p, d, source, hubFileId, hubProjectId);
  const hubRevision = (p: string, d: string, r: string, hubVersionOrder: number, hubVersionId = `v-${r}`, source = 'hub') =>
    raw(`INSERT INTO "HubRevision" ("projectId", "drawingId", "revisionId", "source", "hubVersionId", "hubVersionOrder") VALUES ($1, $2, $3, $4, $5, $6)`,
      p, d, r, source, hubVersionId, hubVersionOrder);
  const mark = (p: string, d: string, order: number) => raw(`INSERT INTO "HubGoverningMark" ("projectId", "drawingId", "order") VALUES ($1, $2, $3)`, p, d, order);
  /** U5's write of a new Hub drawing: the drawing, its first revision, their records and the mark, one transaction. */
  const hub = (p: string, d: string, r = `${d}-r1`, order = 1) => t.prisma.$transaction([
    drawing(p, d, 'hub'), revision(p, d, r, 'hub'), hubDrawing(p, d), hubRevision(p, d, r, order), mark(p, d, order),
  ]);
  /** U5's write of a later Hub version on a Hub drawing: the revision, its record and the mark, one transaction. */
  const hubVersion = (p: string, d: string, r: string, order: number, withMark = true) => t.prisma.$transaction([
    revision(p, d, r, 'hub'), hubRevision(p, d, r, order), ...(withMark ? [mark(p, d, order)] : []),
  ]);
  const sources = async (p: string) => ({
    drawings: await t.prisma.drawing.findMany({ where: { projectId: p }, select: { id: true, source: true }, orderBy: { id: 'asc' } }),
    revisions: await t.prisma.drawingRevision.findMany({ where: { projectId: p }, select: { id: true, source: true }, orderBy: { id: 'asc' } }),
  });

  it('controls: PMC\'s own drawings are issued, revised, published and deleted as before, all \'pmc\'', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('pmc');
    // the service's own shapes: a drawing with its first revision (nested), a revise (a revision by its keys), a publish
    const d = await t.prisma.drawing.create({ data: {
      projectId: p, number: 'A-101', title: 'Plan', discipline: 'architectural',
      revisions: { create: [{ rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'pmc', issuedAt: 't' }] },
    } });
    await t.prisma.$transaction([
      t.prisma.drawingRevision.updateMany({ where: { drawingId: d.id, status: 'for_construction' }, data: { status: 'superseded' } }),
      t.prisma.drawingRevision.create({ data: { projectId: p, drawingId: d.id, rev: 'B', status: 'for_construction', mime: 'application/pdf', issuedBy: 'pmc', issuedAt: 't' } }),
    ]);
    await t.prisma.drawing.update({ where: { id: d.id }, data: { title: 'Plan 2', publishedAt: new Date() } });
    const s = await sources(p);
    expect(s.drawings).toEqual([{ id: d.id, source: 'pmc' }]);
    expect(s.revisions.map((r) => r.source)).toEqual(['pmc', 'pmc']);
    // a same-value write of the source is not a change
    await raw(`UPDATE "Drawing" SET "source" = "source", "title" = 'Plan 3' WHERE "id" = $1`, d.id);
    await raw(`UPDATE "DrawingRevision" SET "source" = 'pmc' WHERE "drawingId" = $1`, d.id);
    // the delete takes the revisions, as before
    await t.prisma.drawing.delete({ where: { id: d.id } });
    expect(await sources(p)).toEqual({ drawings: [], revisions: [] });
  });

  it('controls: a Hub drawing with its revision, records and mark in one transaction commits; a later version and mark too', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('hub');
    await hub(p, `hd-${run}`);
    await hubVersion(p, `hd-${run}`, `hd-${run}-r2`, 2);
    // a SHARED-only version holds no mark
    await hubVersion(p, `hd-${run}`, `hd-${run}-r3`, 3, false);
    const s = await sources(p);
    expect(s.drawings).toEqual([{ id: `hd-${run}`, source: 'hub' }]);
    expect(s.revisions.map((r) => r.source)).toEqual(['hub', 'hub', 'hub']);
    expect(await t.prisma.hubDrawing.findMany({ where: { projectId: p } })).toEqual([
      { projectId: p, drawingId: `hd-${run}`, source: 'hub', hubFileId: `f-hd-${run}`, hubProjectId: 'hp' }]);
    expect((await t.prisma.hubRevision.findMany({ where: { projectId: p }, orderBy: { hubVersionOrder: 'asc' } })).map((r) => r.hubVersionOrder)).toEqual([1, 2, 3]);
    // the mark is the highest order written for construction
    const m = await t.prisma.hubGoverningMark.aggregate({ where: { projectId: p, drawingId: `hd-${run}` }, _max: { order: true } });
    expect(m._max.order).toBe(2);
    // Prisma's own creates, in U5's order, are a writer too
    const d = `hd2-${run}`;
    await t.prisma.$transaction([
      t.prisma.drawing.create({ data: { id: d, projectId: p, number: d, title: 't', discipline: 'other', source: 'hub' } }),
      t.prisma.drawingRevision.create({ data: { id: `${d}-r1`, projectId: p, drawingId: d, rev: 'C01', status: 'for_construction', mime: 'application/pdf', issuedBy: 'hub', issuedAt: 't', source: 'hub' } }),
      t.prisma.hubDrawing.create({ data: { projectId: p, drawingId: d, hubFileId: 'f2', hubProjectId: 'hp' } }),
      t.prisma.hubRevision.create({ data: { projectId: p, drawingId: d, revisionId: `${d}-r1`, hubVersionId: 'v2', hubVersionOrder: 1 } }),
      t.prisma.hubGoverningMark.create({ data: { projectId: p, drawingId: d, order: 1 } }),
    ]);
    expect(await t.prisma.hubGoverningMark.count({ where: { projectId: p } })).toBe(3);
  });

  it('I1: a revision\'s source is its drawing\'s (#1135 4381565873)', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i1');
    await hub(p, `h-${run}`);
    await drawing(p, `m-${run}`);
    const key = /DrawingRevision_projectId_drawingId_source_fkey/;
    // a PMC revision under a Hub drawing: what the previous release's issue by number onto a Hub drawing writes
    await expect(revision(p, `h-${run}`, `x1-${run}`)).rejects.toThrow(key);
    // a Hub revision under a PMC drawing, with or without a record
    await expect(t.prisma.$transaction([revision(p, `m-${run}`, `x2-${run}`, 'hub'), hubRevision(p, `m-${run}`, `x2-${run}`, 9)])).rejects.toThrow(key);
    // a source outside the two
    await expect(drawing(p, `x3-${run}`, 'other')).rejects.toThrow(/Drawing_source_known/);
    await expect(revision(p, `m-${run}`, `x4-${run}`, 'HUB')).rejects.toThrow(/DrawingRevision_source_known|DrawingRevision_projectId_drawingId_source_fkey/);
    expect((await sources(p)).revisions.map((r) => r.id)).toEqual([`h-${run}-r1`]);
    // a PMC drawing with a revision still moves to another project with it, as on main: both keys cascade
    await revision(p, `m-${run}`, `m-${run}-r1`);
    const q = await project('i1q');
    await raw(`UPDATE "Drawing" SET "projectId" = $1 WHERE "id" = $2`, q, `m-${run}`);
    expect(await sources(q)).toEqual({ drawings: [{ id: `m-${run}`, source: 'pmc' }], revisions: [{ id: `m-${run}-r1`, source: 'pmc' }] });
  });

  it('I2: a source never changes, on a drawing with no revisions, one with revisions, a Hub drawing and a revision', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i2');
    await drawing(p, `bare-${run}`);
    await drawing(p, `full-${run}`);
    await revision(p, `full-${run}`, `full-${run}-r`);
    await hub(p, `h-${run}`);
    const fixed = /_source_fixed|source is fixed when it is written/;
    for (const [table, id, to] of [
      ['Drawing', `bare-${run}`, 'hub'], ['Drawing', `full-${run}`, 'hub'], ['Drawing', `h-${run}`, 'pmc'],
      ['DrawingRevision', `full-${run}-r`, 'hub'], ['DrawingRevision', `h-${run}-r1`, 'pmc'],
    ] as const) {
      await expect(raw(`UPDATE "${table}" SET "source" = $1 WHERE "id" = $2`, to, id), `${table} ${id}`).rejects.toThrow(fixed);
    }
    // a drawing and its revisions flipped together, in one statement each, are refused just the same
    await expect(t.prisma.$transaction([
      raw(`UPDATE "DrawingRevision" SET "source" = 'hub' WHERE "drawingId" = $1`, `full-${run}`),
      raw(`UPDATE "Drawing" SET "source" = 'hub' WHERE "id" = $1`, `full-${run}`),
    ])).rejects.toThrow(fixed);
    // an upsert's update is an update
    await expect(raw(`INSERT INTO "Drawing" ("id", "projectId", "number", "title", "discipline") VALUES ($1, $2, $1, 't', 'other')
      ON CONFLICT ("id") DO UPDATE SET "source" = 'hub'`, `bare-${run}`, p)).rejects.toThrow(fixed);
    expect(await sources(p)).toEqual({
      drawings: [{ id: `bare-${run}`, source: 'pmc' }, { id: `full-${run}`, source: 'pmc' }, { id: `h-${run}`, source: 'hub' }],
      revisions: [{ id: `full-${run}-r`, source: 'pmc' }, { id: `h-${run}-r1`, source: 'hub' }],
    });
  });

  it('I3: a Hub drawing commits only with its HubDrawing, a Hub revision only with its HubRevision', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i3');
    const drawingRecord = /Drawing_hub_record|has no HubDrawing record/;
    const revisionRecord = /DrawingRevision_hub_record|has no HubRevision record/;
    // a Hub drawing alone, at commit and at once
    await expect(drawing(p, `a-${run}`, 'hub')).rejects.toThrow(drawingRecord);
    await expect(t.prisma.$transaction([raw(`SET CONSTRAINTS ALL IMMEDIATE`), drawing(p, `a-${run}`, 'hub')])).rejects.toThrow(drawingRecord);
    await expect(t.prisma.$transaction([raw(`SET CONSTRAINTS "Drawing_hub_record" IMMEDIATE`), drawing(p, `a-${run}`, 'hub')])).rejects.toThrow(drawingRecord);
    // with its revision and that revision's record but not its own (the revision's record needs the drawing's: a key)
    await expect(t.prisma.$transaction([drawing(p, `a-${run}`, 'hub'), revision(p, `a-${run}`, `a-${run}-r`, 'hub')])).rejects.toThrow(/_hub_record|has no Hub/);
    // another drawing's record does not stand in for this one's
    await expect(t.prisma.$transaction([drawing(p, `a-${run}`, 'hub'), drawing(p, `b-${run}`, 'hub'), hubDrawing(p, `b-${run}`)])).rejects.toThrow(drawingRecord);
    // a Hub revision alone on a Hub drawing that has its record
    await hub(p, `h-${run}`);
    await expect(revision(p, `h-${run}`, `h2-${run}`, 'hub')).rejects.toThrow(revisionRecord);
    await expect(t.prisma.$transaction([raw(`SET CONSTRAINTS ALL IMMEDIATE`), revision(p, `h-${run}`, `h2-${run}`, 'hub')])).rejects.toThrow(revisionRecord);
    expect(await sources(p)).toEqual({ drawings: [{ id: `h-${run}`, source: 'hub' }], revisions: [{ id: `h-${run}-r1`, source: 'hub' }] });
    // written in one transaction, the check passes deferred or at once after both
    await t.prisma.$transaction([revision(p, `h-${run}`, `h2-${run}`, 'hub'), hubRevision(p, `h-${run}`, `h2-${run}`, 2), raw(`SET CONSTRAINTS ALL IMMEDIATE`)]);
    // a Hub drawing inserted and deleted in one transaction needs no record
    await t.prisma.$transaction([drawing(p, `gone-${run}`, 'hub'), raw(`DELETE FROM "Drawing" WHERE "id" = $1`, `gone-${run}`)]);
  });

  it('I4: a record belongs to a Hub drawing and its own revisions, and its version order is a real Hub version', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i4');
    const q = await project('i4q');
    await drawing(p, `m-${run}`);
    await revision(p, `m-${run}`, `m-${run}-r`);
    await hub(p, `h-${run}`);
    await hub(p, `g-${run}`);
    // a HubDrawing for a PMC drawing, with its source as 'hub' or 'pmc'
    await expect(hubDrawing(p, `m-${run}`)).rejects.toThrow(/HubDrawing_projectId_drawingId_source_fkey/);
    await expect(hubDrawing(p, `m-${run}`, 'f-x', 'hp', 'pmc')).rejects.toThrow(/HubDrawing_source_hub/);
    // a HubDrawing in another project than its drawing's
    await expect(hubDrawing(q, `h-${run}`, 'f-q')).rejects.toThrow(/HubDrawing_projectId_drawingId_source_fkey/);
    // a HubRevision for a PMC revision, for another Hub drawing's revision, or naming another drawing than its revision's
    await expect(hubRevision(p, `m-${run}`, `m-${run}-r`, 5)).rejects.toThrow(/HubRevision_projectId_drawingId_(revisionId_source_)?fkey/);
    await expect(hubRevision(p, `h-${run}`, `m-${run}-r`, 5)).rejects.toThrow(/HubRevision_projectId_drawingId_revisionId_source_fkey/);
    await expect(hubRevision(p, `h-${run}`, `g-${run}-r1`, 5)).rejects.toThrow(/HubRevision_projectId_drawingId_revisionId_source_fkey|23505/);
    await expect(hubRevision(p, `h-${run}`, `h-${run}-r1`, 5, 'v-y', 'pmc')).rejects.toThrow(/HubRevision_source_hub/);
    // a mark naming an order no Hub version of its drawing has, or another drawing's order
    await expect(mark(p, `h-${run}`, 7)).rejects.toThrow(/HubGoverningMark_projectId_drawingId_order_fkey/);
    await hubVersion(p, `g-${run}`, `g-${run}-r2`, 4, false);
    await expect(mark(p, `h-${run}`, 4)).rejects.toThrow(/HubGoverningMark_projectId_drawingId_order_fkey/);
    expect(await t.prisma.hubGoverningMark.count({ where: { projectId: p } })).toBe(2);
  });

  it('I4: a Hub drawing or revision is never deleted or moved while its record exists (#1135 4381565882)', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i4d');
    const q = await project('i4dq');
    await hub(p, `h-${run}`);
    await hubVersion(p, `h-${run}`, `h-${run}-r2`, 2);
    const kept = async () => ({
      drawings: await t.prisma.drawing.count({ where: { projectId: p } }),
      revisions: await t.prisma.drawingRevision.count({ where: { projectId: p } }),
      marks: (await t.prisma.hubGoverningMark.aggregate({ where: { projectId: p }, _max: { order: true } }))._max.order,
    });
    const before = await kept();
    expect(before).toEqual({ drawings: 1, revisions: 2, marks: 2 });
    // the drawing (with the cascade to its revisions), one revision, the Prisma delete the service's remove() uses
    await expect(raw(`DELETE FROM "Drawing" WHERE "id" = $1`, `h-${run}`)).rejects.toThrow(/HubDrawing_projectId_drawingId_source_fkey/);
    await expect(t.prisma.drawing.delete({ where: { id: `h-${run}` } })).rejects.toThrow();
    await expect(raw(`DELETE FROM "DrawingRevision" WHERE "id" = $1`, `h-${run}-r2`)).rejects.toThrow(/HubRevision_projectId_drawingId_revisionId_source_fkey/);
    // moved to another project, renumbered by id, a revision moved to another drawing
    await expect(raw(`UPDATE "Drawing" SET "projectId" = $1 WHERE "id" = $2`, q, `h-${run}`)).rejects.toThrow(/fkey/);
    await expect(raw(`UPDATE "Drawing" SET "id" = 'moved' WHERE "id" = $1`, `h-${run}`)).rejects.toThrow(/fkey/);
    await hub(p, `g-${run}`);
    await expect(raw(`UPDATE "DrawingRevision" SET "drawingId" = $1 WHERE "id" = $2`, `g-${run}`, `h-${run}-r2`)).rejects.toThrow(/fkey/);
    expect(await kept()).toEqual({ ...before, drawings: 2, revisions: 3 });
    // a Hub revision's status still changes: supersede and withdraw are status writes
    await raw(`UPDATE "DrawingRevision" SET "status" = 'superseded' WHERE "id" = $1`, `h-${run}-r1`);
  });

  it('I5: one Hub drawing per Hub file, one revision per Hub version and per order on a drawing, one mark per order', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i5');
    const q = await project('i5q');
    await hub(p, `h-${run}`);
    // the same Hub file again in this project, as a second drawing
    await expect(t.prisma.$transaction([drawing(p, `h2-${run}`, 'hub'), hubDrawing(p, `h2-${run}`, `f-h-${run}`)])).rejects.toThrow(/23505[\s\S]*hubFileId/);
    // a second record for the same drawing
    await expect(hubDrawing(p, `h-${run}`, 'f-other')).rejects.toThrow(/23505/);
    // the same Hub version again, on this drawing or another
    await expect(t.prisma.$transaction([revision(p, `h-${run}`, `dup-${run}`, 'hub'), hubRevision(p, `h-${run}`, `dup-${run}`, 6, `v-h-${run}-r1`)]))
      .rejects.toThrow(/23505[\s\S]*hubVersionId/);
    // the same order again on this drawing
    await expect(t.prisma.$transaction([revision(p, `h-${run}`, `dup2-${run}`, 'hub'), hubRevision(p, `h-${run}`, `dup2-${run}`, 1)]))
      .rejects.toThrow(/23505[\s\S]*hubVersionOrder/);
    // the same mark again
    await expect(mark(p, `h-${run}`, 1)).rejects.toThrow(/23505/);
    // another project holds its own Hub file, version and order ids
    await t.prisma.$transaction([
      drawing(q, `qh-${run}`, 'hub'), revision(q, `qh-${run}`, `qh-${run}-r1`, 'hub'),
      hubDrawing(q, `qh-${run}`, `f-h-${run}`), hubRevision(q, `qh-${run}`, `qh-${run}-r1`, 1, `v-h-${run}-r1`), mark(q, `qh-${run}`, 1),
    ]);
    // the receipt's key (U1a-1): a version, its drawing and its order name exactly one revision
    const keys = await t.prisma.$queryRawUnsafe<Array<{ name: string; def: string }>>(
      `SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'HubRevision' ORDER BY 1`);
    expect(keys.map((k) => k.name).sort()).toEqual([
      'HubRevision_pkey', 'HubRevision_projectId_drawingId_hubVersionOrder_key', 'HubRevision_version_drawing_order_key',
      'HubRevision_projectId_hubVersionId_key'].sort());
    expect(keys.find((k) => k.name === 'HubRevision_version_drawing_order_key')?.def)
      .toMatch(/UNIQUE INDEX .* \("projectId", "hubVersionId", "drawingId", "hubVersionOrder"\)/);
  });

  it('I6: a Hub record is never changed, deleted on its own or truncated; the mark only rises', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i6');
    await hub(p, `h-${run}`);
    await hubVersion(p, `h-${run}`, `h-${run}-r2`, 2);
    const updates: Array<[string, string]> = [
      ['HubDrawing', `"hubFileId" = 'f-moved'`], ['HubDrawing', `"hubProjectId" = 'hp2'`], ['HubDrawing', `"drawingId" = "drawingId"`],
      ['HubRevision', `"hubVersionId" = 'v-moved'`], ['HubRevision', `"hubVersionOrder" = 9`], ['HubRevision', `"hubVersionOrder" = "hubVersionOrder"`],
      ['HubGoverningMark', `"order" = 1`], ['HubGoverningMark', `"at" = now()`],
    ];
    for (const [table, set] of updates) {
      await expect(raw(`UPDATE "${table}" SET ${set} WHERE "projectId" = $1`, p), `${table} ${set}`).rejects.toThrow(/is a record and is never changed/);
    }
    for (const table of RECORDS) {
      await expect(raw(`DELETE FROM "${table}" WHERE "projectId" = $1`, p), table).rejects.toThrow(/never deleted; it goes only with its project/);
      await expect(raw(`TRUNCATE TABLE "${table}" CASCADE`), table).rejects.toThrow(/are records and are never truncated/);
    }
    // the mark is never lowered: the highest stays, and a lower order is only ever another mark
    expect((await t.prisma.hubGoverningMark.aggregate({ where: { projectId: p }, _max: { order: true } }))._max.order).toBe(2);
    expect(await t.prisma.hubGoverningMark.count({ where: { projectId: p } })).toBe(2);
  });

  it('I7: a Hub file, project and version id each hold more than whitespace', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('i7');
    for (const b of ['', ' ', '\t', ' \n\r\f\v ']) {
      const why = JSON.stringify(b);
      await expect(t.prisma.$transaction([drawing(p, `a-${run}`, 'hub'), hubDrawing(p, `a-${run}`, b)]), why).rejects.toThrow(/HubDrawing_hubFileId_present/);
      await expect(t.prisma.$transaction([drawing(p, `a-${run}`, 'hub'), hubDrawing(p, `a-${run}`, 'f', b)]), why).rejects.toThrow(/HubDrawing_hubProjectId_present/);
      await expect(t.prisma.$transaction([
        drawing(p, `a-${run}`, 'hub'), revision(p, `a-${run}`, `a-${run}-r`, 'hub'), hubDrawing(p, `a-${run}`), hubRevision(p, `a-${run}`, `a-${run}-r`, 1, b),
      ]), why).rejects.toThrow(/HubRevision_hubVersionId_present/);
    }
    expect(await sources(p)).toEqual({ drawings: [], revisions: [] });
  });

  it('I6: the sanctioned reset lifts the three TRUNCATE seals by name and puts them back', async () => {
    for (const table of RECORDS) {
      const seals = await t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 32) <> 0`, `"${table}"`);
      expect(seals.map((x) => x.name), table).toEqual([`${table}_no_truncate`]);
      expect(TRUNCATE_SEALS).toContainEqual({ table, trigger: `${table}_no_truncate` });
    }
    const p = await project('rs');
    await hub(p, `h-${run}`);
    await sanctionedReset(t.prisma, [...RECORDS]);
    for (const table of RECORDS) {
      expect(await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}"`), table).toEqual([{ n: 0n }]);
    }
    const states = await t.prisma.$queryRawUnsafe<Array<{ enabled: string }>>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = ANY($1::text[])`, RECORDS.map((s) => `${s}_no_truncate`));
    expect(states.map((x) => x.enabled)).toEqual(['O', 'O', 'O']);
    // the drawing outlives its record only in this reset, and goes as a PMC drawing would
    await raw(`DELETE FROM "Drawing" WHERE "id" = $1`, `h-${run}`);
  });

  it('re-runs: a second and third run of the file leave the same columns, keys, checks, triggers and functions', async () => {
    const tables = ['Drawing', 'DrawingRevision', ...RECORDS];
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ kind: string; name: string; def: string }>>(`
      SELECT 'column' AS kind, table_name || '.' || column_name AS name, data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS def
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name = 'source'
      UNION ALL
      SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid) || ' ' || convalidated::text FROM pg_constraint WHERE conrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'function', p.proname, array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('drawings_hub_record_sealed', 'drawings_hub_record_no_truncate', 'drawings_source_fixed',
         'drawings_hub_drawing_has_record', 'drawings_hub_revision_has_record')
      ORDER BY 1, 2`, tables, tables.map((x) => `"${x}"`));
    const before = await shape();
    expect(before.filter((r) => r.kind === 'column').map((r) => `${r.name} ${r.def}`)).toEqual([
      "Drawing.source text NO 'pmc'::text", "DrawingRevision.source text NO 'pmc'::text", "HubDrawing.source text NO 'hub'::text", "HubRevision.source text NO 'hub'::text"]);
    expect(before.filter((r) => r.kind === 'trigger' && /source_fixed|hub_record|sealed|no_truncate/.test(r.name)).map((r) => r.name).sort()).toEqual([
      'DrawingRevision_hub_record', 'DrawingRevision_source_fixed', 'Drawing_hub_record', 'Drawing_source_fixed',
      'HubDrawing_no_truncate', 'HubDrawing_sealed', 'HubGoverningMark_no_truncate', 'HubGoverningMark_sealed', 'HubRevision_no_truncate', 'HubRevision_sealed',
    ].sort());
    for (const name of ['Drawing_hub_record', 'DrawingRevision_hub_record']) {
      expect(before.find((r) => r.name === name && r.kind === 'trigger')?.def, name).toMatch(/CONSTRAINT TRIGGER .* AFTER INSERT .* DEFERRABLE INITIALLY DEFERRED .* WHEN \(\(new\.source = 'hub'::text\)\)/);
    }
    expect(before.find((r) => r.name === 'DrawingRevision_projectId_drawingId_source_fkey')?.def)
      .toBe('FOREIGN KEY ("projectId", "drawingId", source) REFERENCES "Drawing"("projectId", id, source) ON UPDATE CASCADE ON DELETE CASCADE true');
    expect(before.filter((r) => r.kind === 'constraint' && /^FOREIGN KEY .* (ON UPDATE RESTRICT ON DELETE RESTRICT) true$/.test(r.def)).map((r) => r.name).sort()).toEqual([
      'HubDrawing_projectId_drawingId_source_fkey', 'HubGoverningMark_projectId_drawingId_order_fkey', 'HubRevision_projectId_drawingId_fkey',
      'HubRevision_projectId_drawingId_revisionId_source_fkey']);
    expect(before.filter((r) => r.kind === 'function').map((r) => r.def)).toEqual(Array(5).fill('search_path=pg_catalog, public, pg_temp'));
    replay();
    replay();
    expect(await shape()).toEqual(before);
    // a run that stopped between adding the revision's key NOT VALID and validating it is finished by the next one
    await raw(`ALTER TABLE "DrawingRevision" DROP CONSTRAINT "DrawingRevision_projectId_drawingId_source_fkey"`);
    await raw(`ALTER TABLE "DrawingRevision" ADD CONSTRAINT "DrawingRevision_projectId_drawingId_source_fkey" FOREIGN KEY ("projectId", "drawingId", "source")
      REFERENCES "Drawing"("projectId", "id", "source") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID`);
    replay();
    expect(await shape()).toEqual(before);
    // one transaction: a run that fails at its last statement leaves nothing of itself, its dropped triggers and
    // checks included
    const dir = mkdtempSync(join(tmpdir(), 'hub-drawing-'));
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
