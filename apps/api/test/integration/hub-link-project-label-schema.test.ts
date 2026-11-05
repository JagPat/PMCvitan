import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #1118 U7a L0 — `20280209000000_hub_link_project_label` adds the nullable "hubProjectNumber" and "hubProjectName" to
 * "DrawingHubLinkEvent", kept by one CHECK: an unlink carries neither; a link may carry each, never blank and never
 * longer than 128 (number) or 256 (name). This proves that a link event written as the previous release would write it
 * (never naming the columns) still goes in and reads NULL, that the CHECK holds both ways, that the event stays a sealed
 * record with them (no later fill-in), and that the file re-runs, refusing a same-named column of another type.
 *
 * Events name actors homed on a project of their own that holds no Hub rows ("home"), as in hub-link-schema.test.ts:
 * the projects holding events go first (their cascade takes the link and its history), then the actors, then home.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280209000000_hub_link_project_label/migration.sql');
const CHECK_NAME = 'DrawingHubLinkEvent_hubProject_label';

describe('#1118 U7a L0 — the Hub project label on a link event (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];
  const home = `it-hubll-home-${run}`;
  let actor: string;

  const newProject = async (id: string) =>
    t.prisma.project.create({ data: {
      id, orgId: f.orgA.id, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await newProject(home);
    actor = (await t.prisma.user.create({ data: { email: `hubll.actor.${run}@test.local`, name: 'Hub label actor', role: 'pmc', projectId: home } })).id;
  });

  afterAll(async () => {
    if (!t) return;
    try {
      for (const id of made) await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
      if (actor) await t.prisma.user.deleteMany({ where: { id: actor } });
      await raw(`DELETE FROM "Project" WHERE "id" = $1`, home);
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const project = async (tag: string) => {
    const id = `it-hubll-${tag}-${run}`;
    await newProject(id);
    made.push(id);
    return id;
  };
  const linkRow = (projectId: string) => raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId") VALUES ($1, $2)`, projectId, f.orgA.id);
  /** event 1, as the previous release would write it: the label columns are never named */
  const plainLink = (projectId: string) => t.prisma.$transaction([
    linkRow(projectId),
    raw(`INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "byUserId") VALUES ($1, 1, NULL, 'linked', 'hp', $2)`, projectId, actor),
  ]);
  /** event 1 with a label, as U7a L1 will write it: the link and its event 1 in one transaction */
  const labelledLink = (projectId: string, number: string | null, name: string | null) => t.prisma.$transaction([
    linkRow(projectId),
    raw(`INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "hubProjectNumber", "hubProjectName", "byUserId")
         VALUES ($1, 1, NULL, 'linked', 'hp', $2, $3, $4)`, projectId, number, name, actor),
  ]);
  const unlink = (projectId: string, number: string | null, name: string | null) =>
    raw(`INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "hubProjectNumber", "hubProjectName", "byUserId")
         VALUES ($1, 2, 1, 'unlinked', NULL, $2, $3, $4)`, projectId, number, name, actor);
  const labelOf = (projectId: string, seq = 1) => t.prisma.drawingHubLinkEvent.findUniqueOrThrow({
    where: { projectId_seq: { projectId, seq } }, select: { hubProjectNumber: true, hubProjectName: true },
  });
  const checkDef = async () => (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"DrawingHubLinkEvent"'::regclass AND conname = $1`, CHECK_NAME))[0]?.def;
  const runFile = () => {
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  };

  it('a link event written without the label goes in and reads NULL for both', async () => {
    const p = await project('plain');
    await plainLink(p);
    expect(await labelOf(p)).toEqual({ hubProjectNumber: null, hubProjectName: null });
  });

  it('a link may carry a number, a name, both or neither', async () => {
    for (const [tag, number, name] of [['both', '24-017', 'River house'], ['num', '24-018', null], ['name', null, 'Ambli bungalow'], ['none', null, null]] as const) {
      const p = await project(`ok-${tag}`);
      await labelledLink(p, number, name);
      expect(await labelOf(p), tag).toEqual({ hubProjectNumber: number, hubProjectName: name });
    }
  });

  it('a link refuses a blank or an over-long number or name, and nothing of the link stays', async () => {
    const bad: Array<[string, string | null, string | null]> = [
      ['num-empty', '', 'River house'], ['num-space', ' \t', null], ['num-ws', ' \n\r\f\v ', null], ['num-long', 'x'.repeat(129), null],
      ['name-empty', '24-017', ''], ['name-space', null, '   '], ['name-long', null, 'n'.repeat(257)],
    ];
    for (const [tag, number, name] of bad) {
      const p = await project(`bad-${tag}`);
      await expect(labelledLink(p, number, name), tag).rejects.toThrow(new RegExp(CHECK_NAME));
      expect(await t.prisma.drawingHubLink.count({ where: { projectId: p } }), tag).toBe(0);
    }
    // the bounds themselves are accepted
    const edge = await project('edge');
    await labelledLink(edge, 'x'.repeat(128), 'n'.repeat(256));
    expect(await labelOf(edge)).toEqual({ hubProjectNumber: 'x'.repeat(128), hubProjectName: 'n'.repeat(256) });
  });

  it('an unlink carries neither', async () => {
    const p = await project('unlink');
    await labelledLink(p, '24-017', 'River house');
    await expect(unlink(p, '24-017', null)).rejects.toThrow(new RegExp(CHECK_NAME));
    await expect(unlink(p, null, 'River house')).rejects.toThrow(new RegExp(CHECK_NAME));
    expect(await unlink(p, null, null)).toBe(1);
    expect(await labelOf(p, 2)).toEqual({ hubProjectNumber: null, hubProjectName: null });
  });

  it('the event stays a sealed record: a label is never filled in or changed later', async () => {
    const p = await project('sealed');
    await plainLink(p);
    await expect(raw(`UPDATE "DrawingHubLinkEvent" SET "hubProjectNumber" = '24-017' WHERE "projectId" = $1`, p)).rejects.toThrow(/is a record and is never changed/);
    const q = await project('sealed2');
    await labelledLink(q, '24-017', 'River house');
    await expect(raw(`UPDATE "DrawingHubLinkEvent" SET "hubProjectName" = 'Other' WHERE "projectId" = $1`, q)).rejects.toThrow(/is a record and is never changed/);
    expect(await labelOf(q)).toEqual({ hubProjectNumber: '24-017', hubProjectName: 'River house' });
  });

  it('the file re-runs on a database that has it, keeping every label and the exact CHECK', async () => {
    const p = await project('rerun');
    await labelledLink(p, '24-017', 'River house');
    const before = await checkDef();
    expect(before).toMatch(/^CHECK \(/);
    runFile();
    runFile();
    expect(await checkDef()).toBe(before);
    expect(await labelOf(p)).toEqual({ hubProjectNumber: '24-017', hubProjectName: 'River house' });
  });

  it('a re-run restores a loosened CHECK, and refuses a same-named column that is not nullable text', async () => {
    const exact = await checkDef();
    await raw(`ALTER TABLE "DrawingHubLinkEvent" DROP CONSTRAINT "${CHECK_NAME}"`);
    await raw(`ALTER TABLE "DrawingHubLinkEvent" ADD CONSTRAINT "${CHECK_NAME}" CHECK (true)`);
    runFile();
    expect(await checkDef()).toBe(exact);

    // a column of another type under the name stops the file; put the real one back afterwards
    await raw(`ALTER TABLE "DrawingHubLinkEvent" DROP CONSTRAINT "${CHECK_NAME}"`);
    await raw(`ALTER TABLE "DrawingHubLinkEvent" RENAME COLUMN "hubProjectName" TO "hubProjectName_kept"`);
    await raw(`ALTER TABLE "DrawingHubLinkEvent" ADD COLUMN "hubProjectName" INTEGER`);
    try {
      expect(runFile).toThrow(/hubProjectName already stands as integer/);
    } finally {
      await raw(`ALTER TABLE "DrawingHubLinkEvent" DROP COLUMN "hubProjectName"`);
      await raw(`ALTER TABLE "DrawingHubLinkEvent" RENAME COLUMN "hubProjectName_kept" TO "hubProjectName"`);
      runFile();
    }
    expect(await checkDef()).toBe(exact);
  });
});
