import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 proof photos, "Who fixes this?": `20280206000000_inspection_responsible_member` adds the nullable
 * "Inspection"."responsibleMemberId", with a composite foreign key to "Membership"("projectId", "userId") and an index
 * for a member's open items. This proves that an inspection written as the previous release writes it (never naming the
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
      select: { id: true, responsibleMemberId: true },
    });
  };
  const setResponsible = (id: string, value: string | null) =>
    t.prisma.$executeRawUnsafe(`UPDATE "Inspection" SET "responsibleMemberId" = $1 WHERE "id" = $2`, value, id);

  it('an inspection written without it goes in and reads NULL', async () => {
    expect((await plainInspection()).responsibleMemberId).toBeNull();
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

  it('has the open-items index, and the file re-runs on a database that has it, changing nothing', async () => {
    const { id } = await plainInspection();
    await setResponsible(id, contractor);
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    const keys = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"Inspection"'::regclass AND conname = 'Inspection_projectId_responsibleMemberId_fkey'`);
    expect(keys[0]!.n).toBe(1);
    const indexes = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'Inspection' AND indexname = 'Inspection_projectId_responsibleMemberId_idx'`);
    expect(indexes[0]!.n).toBe(1);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { responsibleMemberId: true } })).responsibleMemberId).toBe(contractor);
  });
});
