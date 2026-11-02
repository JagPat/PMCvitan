import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 proof photos, "Who fixes this?": `20280206000000_inspection_responsible_member` adds the nullable
 * "Inspection"."responsibleMemberId", with a composite foreign key to "Membership"("projectId", "userId") and an index
 * for a member's open items, and the nullable "responsibleStandingMark" beside it, kept whole with the id by a CHECK.
 * This proves that an inspection written as the previous release writes it (never naming the
 * column) still goes in and reads NULL, that the key takes a member of the inspection's own project and refuses anyone
 * else (another project's member, or nobody's), that a soft-removed membership is never blocked by it, and that the file
 * re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280206000000_inspection_responsible_member/migration.sql');

describe('#482: the inspection\'s responsible member column (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const made: string[] = [];
  const users: string[] = [];
  let contractor: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    contractor = `${f.projectA.id}-resp-contractor`;
    await t.prisma.user.create({ data: { id: contractor, projectId: f.projectA.id, role: 'contractor', name: 'A contractor', email: `${contractor}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractor, role: 'contractor', status: 'active' } });
    users.push(contractor);
  });
  afterAll(async () => {
    await t?.prisma.inspection.deleteMany({ where: { id: { in: made } } });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: users } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: users } } });
    await f?.cleanup();
    await t?.close();
  });

  /** an inspection as the previous release writes it: it never names the column */
  const plainInspection = async () => {
    const id = `${f.projectA.id}-resp-${made.length}`;
    made.push(id);
    return t.prisma.inspection.create({
      data: { id, projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '2 Nov' },
      select: { id: true, responsibleMemberId: true, responsibleStandingMark: true },
    });
  };
  /** names a member with a mark, or clears both, as the API writes them: always together */
  const setResponsible = (id: string, value: string | null, mark: number | null = value === null ? null : 0) =>
    t.prisma.$executeRawUnsafe(`UPDATE "Inspection" SET "responsibleMemberId" = $1, "responsibleStandingMark" = $2 WHERE "id" = $3`, value, mark, id);

  it('an inspection written without them goes in and reads NULL for both', async () => {
    const row = await plainInspection();
    expect(row.responsibleMemberId).toBeNull();
    expect(row.responsibleStandingMark).toBeNull();
  });

  it('the pair CHECK refuses a name without a mark, a mark without a name, and a negative mark', async () => {
    const { id } = await plainInspection();
    await expect(setResponsible(id, contractor, null)).rejects.toThrow(/Inspection_responsible_mark_pair_check/);
    await expect(setResponsible(id, null, 3)).rejects.toThrow(/Inspection_responsible_mark_pair_check/);
    await expect(setResponsible(id, contractor, -1)).rejects.toThrow(/Inspection_responsible_mark_pair_check/);
    expect(await setResponsible(id, contractor, 4)).toBe(1);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { responsibleStandingMark: true } })).responsibleStandingMark).toBe(4);
    expect(await setResponsible(id, null)).toBe(1);
  });

  it('names a member of the inspection\'s own project, and back to nobody', async () => {
    const { id } = await plainInspection();
    expect(await setResponsible(id, contractor)).toBe(1);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { responsibleMemberId: true } })).responsibleMemberId).toBe(contractor);
    expect(await setResponsible(id, null)).toBe(1);
  });

  it('refuses another project\'s member and a user with no membership at all', async () => {
    const { id } = await plainInspection();
    await expect(setResponsible(id, f.otherUser.id)).rejects.toThrow(/Inspection_projectId_responsibleMemberId_fkey/);
    await expect(setResponsible(id, `${f.projectA.id}-nobody`)).rejects.toThrow(/Inspection_projectId_responsibleMemberId_fkey/);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { responsibleMemberId: true } })).responsibleMemberId).toBeNull();
  });

  it('a named member is soft-removed as usual: the key never blocks it, and the name stays', async () => {
    const removed = `${f.projectA.id}-resp-removed`;
    await t.prisma.user.create({ data: { id: removed, projectId: f.projectA.id, role: 'consultant', name: 'A consultant', email: `${removed}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: removed, role: 'consultant', status: 'active' } });
    users.push(removed);
    const { id } = await plainInspection();
    expect(await setResponsible(id, removed)).toBe(1);
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: removed } }, data: { status: 'removed' } });
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { responsibleMemberId: true } })).responsibleMemberId).toBe(removed);
  });

  const keyDef = async () => (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"Inspection"'::regclass AND conname = 'Inspection_projectId_responsibleMemberId_fkey'`))[0]?.def;
  const indexDef = async () => (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_indexdef('"Inspection_projectId_responsibleMemberId_idx"'::regclass) AS def`))[0]?.def;
  const checkDef = async () => (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '"Inspection"'::regclass AND conname = 'Inspection_responsible_mark_pair_check'`))[0]?.def;
  const runFile = () => {
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  };
  const KEY = 'FOREIGN KEY ("projectId", "responsibleMemberId") REFERENCES "Membership"("projectId", "userId")';
  const CHECK = 'CHECK (((("responsibleMemberId" IS NULL) AND ("responsibleStandingMark" IS NULL)) OR (("responsibleMemberId" IS NOT NULL) AND ("responsibleStandingMark" IS NOT NULL) AND ("responsibleStandingMark" >= 0))))';
  const INDEX = 'CREATE INDEX "Inspection_projectId_responsibleMemberId_idx" ON public."Inspection" USING btree ("projectId", "responsibleMemberId")';

  it('the key is exactly the two-column key with NO ACTION, and the index exactly the two-column btree', async () => {
    expect(await keyDef()).toBe(KEY);
    const rule = await t.prisma.$queryRawUnsafe<Array<{ del: string; upd: string }>>(
      `SELECT confdeltype AS del, confupdtype AS upd FROM pg_constraint WHERE conname = 'Inspection_projectId_responsibleMemberId_fkey'`);
    expect(rule[0]).toEqual({ del: 'a', upd: 'a' }); // 'a' = NO ACTION
    expect((await indexDef())?.replace(/ public\./, ' ')).toBe(INDEX.replace(/ public\./, ' '));
    expect(await checkDef()).toBe(CHECK);
  });

  it('a hard delete of a membership named as responsible is refused (23503); the row and the name stay', async () => {
    const named = `${f.projectA.id}-resp-hard`;
    await t.prisma.user.create({ data: { id: named, projectId: f.projectA.id, role: 'contractor', name: 'Another contractor', email: `${named}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: named, role: 'contractor', status: 'active' } });
    users.push(named);
    const { id } = await plainInspection();
    await setResponsible(id, named);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, named))
      .rejects.toThrow(/23503|Inspection_projectId_responsibleMemberId_fkey/);
    expect(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId: named } })).toBe(1);
    await setResponsible(id, null);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    const { id } = await plainInspection();
    await setResponsible(id, contractor);
    runFile();
    expect(await keyDef()).toBe(KEY);
    expect(await indexDef()).toBe(INDEX);
    expect(await checkDef()).toBe(CHECK);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { responsibleMemberId: true } })).responsibleMemberId).toBe(contractor);
  });

  it('a re-run refuses a same-named key or index that is not this file\'s, rather than keeping it', async () => {
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Inspection" DROP CONSTRAINT "Inspection_projectId_responsibleMemberId_fkey"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_projectId_responsibleMemberId_fkey"
      FOREIGN KEY ("projectId", "responsibleMemberId") REFERENCES "Membership"("projectId", "userId") ON DELETE CASCADE`);
    expect(runFile).toThrow(/already stands as something else/);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Inspection" DROP CONSTRAINT "Inspection_projectId_responsibleMemberId_fkey"`);
    runFile();
    expect(await keyDef()).toBe(KEY);

    await t.prisma.$executeRawUnsafe(`DROP INDEX "Inspection_projectId_responsibleMemberId_idx"`);
    await t.prisma.$executeRawUnsafe(`CREATE INDEX "Inspection_projectId_responsibleMemberId_idx" ON "Inspection"("responsibleMemberId")`);
    expect(runFile).toThrow(/already stands as something else/);
    await t.prisma.$executeRawUnsafe(`DROP INDEX "Inspection_projectId_responsibleMemberId_idx"`);
    runFile();
    expect(await indexDef()).toBe(INDEX);

    // a looser check under the same name (no lower bound on the mark) is refused too
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Inspection" DROP CONSTRAINT "Inspection_responsible_mark_pair_check"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_responsible_mark_pair_check"
      CHECK (("responsibleMemberId" IS NULL) = ("responsibleStandingMark" IS NULL))`);
    expect(runFile).toThrow(/already stands as something else/);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "Inspection" DROP CONSTRAINT "Inspection_responsible_mark_pair_check"`);
    runFile();
    expect(await checkDef()).toBe(CHECK);
  });
});
