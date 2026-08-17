import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

describe('Phase 6 unit 4b — approval attribution expansion (live PG)', () => {
  let db: PrismaClient;
  let writer: PrismaClient;
  let eraser: PrismaClient;
  let orgId: string;
  let projectId: string;
  let userId: string;
  let membershipId: string;
  let seq = 0;

  const nextId = (label: string): string => `it-t4b-${label}-${seq++}`;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    writer = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    eraser = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await Promise.all([db.$connect(), writer.$connect(), eraser.$connect()]);

    const run = randomUUID().slice(0, 8);
    orgId = `it-t4b-org-${run}`;
    projectId = `it-t4b-project-${run}`;
    userId = `it-t4b-user-${run}`;
    await db.org.create({ data: { id: orgId, name: `T4B Org ${run}`, slug: orgId } });
    await db.project.create({
      data: {
        id: projectId,
        orgId,
        name: `T4B Project ${run}`,
        short: 'T4B',
        descriptor: '',
        stage: 'Planning',
        siteCode: `T4B${run}`.slice(0, 8),
        projStart: '01 Jan 2026',
        projEnd: '31 Dec 2026',
        elapsedPct: 0,
        todayDay: 0,
        milestonePct: 0,
      },
    });
    await db.user.create({
      data: { id: userId, projectId, role: 'client', name: 'Approval holder', email: `${run}@t4b.test` },
    });
    const membership = await db.membership.create({
      data: { projectId, userId, role: 'client', status: 'active' },
    });
    membershipId = membership.id;
  });

  afterAll(async () => {
    await cleanupDecisions();
    await db?.membership.deleteMany({ where: { projectId } });
    await db?.user.deleteMany({ where: { id: userId } });
    await db?.project.deleteMany({ where: { id: projectId } });
    await db?.org.deleteMany({ where: { id: orgId } });
    await Promise.all([db?.$disconnect(), writer?.$disconnect(), eraser?.$disconnect()]);
  });

  afterEach(async () => cleanupDecisions());

  const cleanupDecisions = async (): Promise<void> => {
    if (!db || !projectId) return;
    await db.$transaction([
      db.$executeRawUnsafe(`DO $do$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4a_d_no_delete') THEN
          ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4b_evidence_no_delete') THEN
          ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_evidence_no_delete";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionLegacyApproval_sealed') THEN
          ALTER TABLE "DecisionLegacyApproval" DISABLE TRIGGER "DecisionLegacyApproval_sealed";
        END IF;
      END $do$`),
      db.decision.deleteMany({ where: { projectId } }),
      db.$executeRawUnsafe(`DO $do$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionLegacyApproval_sealed') THEN
          ALTER TABLE "DecisionLegacyApproval" ENABLE TRIGGER "DecisionLegacyApproval_sealed";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4b_evidence_no_delete') THEN
          ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_evidence_no_delete";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4a_d_no_delete') THEN
          ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete";
        END IF;
      END $do$`),
    ]);
  };

  const seedDecision = async (
    over: Partial<{
      status: 'pending' | 'approved' | 'change';
      publishedAt: Date | null;
      deciderKind: 'client' | 'pmc' | 'member';
      deciderMembershipId: string | null;
      approvedDeciderKind: 'client' | 'pmc' | 'member' | null;
      approvedDeciderMembershipId: string | null;
      approvedDeciderLabel: string | null;
    }> = {},
  ): Promise<string> => {
    const id = nextId('decision');
    await db.decision.create({
      data: {
        id,
        projectId,
        title: `Approval attribution ${id}`,
        room: 'Office',
        status: over.status ?? 'pending',
        ageDays: 0,
        photoSwatch: 'blue',
        authorId: userId,
        publishedAt: over.publishedAt === undefined ? new Date() : over.publishedAt,
        deciderKind: over.deciderKind ?? 'client',
        deciderMembershipId: over.deciderMembershipId ?? null,
        approvedDeciderKind: over.approvedDeciderKind ?? null,
        approvedDeciderMembershipId: over.approvedDeciderMembershipId ?? null,
        approvedDeciderLabel: over.approvedDeciderLabel ?? null,
      },
    });
    return id;
  };

  const attributed = () => ({
    status: 'approved' as const,
    deciderKind: 'member' as const,
    deciderMembershipId: membershipId,
    approvedDeciderKind: 'member' as const,
    approvedDeciderMembershipId: membershipId,
    approvedDeciderLabel: 'Approval holder',
  });

  const waitForBlocked = async (queryLike: string): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = await db.$queryRawUnsafe<Array<{ blocked: number }>>(
        `SELECT COUNT(*)::int AS blocked
           FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND state = 'active'
            AND query ILIKE $1`,
        queryLike,
      );
      if (Number(rows[0]?.blocked ?? 0) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`barrier timeout waiting for ${queryLike}`);
  };

  const seedLegacyStamp = async (decisionId: string): Promise<void> => {
    await db.$transaction([
      db.$executeRawUnsafe(`DO $do$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionLegacyApproval_sealed') THEN
          ALTER TABLE "DecisionLegacyApproval" DISABLE TRIGGER "DecisionLegacyApproval_sealed";
        END IF;
      END $do$`),
      db.$executeRawUnsafe(
        `INSERT INTO "DecisionLegacyApproval"("decisionId") VALUES ($1)`,
        decisionId,
      ),
      db.$executeRawUnsafe(`DO $do$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionLegacyApproval_sealed') THEN
          ALTER TABLE "DecisionLegacyApproval" ENABLE TRIGGER "DecisionLegacyApproval_sealed";
        END IF;
      END $do$`),
    ]);
  };

  it('installs the holder tuple and migration-owned legacy evidence shape', async () => {
    const columns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Decision'
          AND column_name IN (
            'deciderKind',
            'deciderMembershipId',
            'approvedDeciderKind',
            'approvedDeciderMembershipId',
            'approvedDeciderLabel'
          )
        ORDER BY column_name`,
    );
    const legacyTable = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('public."DecisionLegacyApproval"') IS NOT NULL AS present`,
    );

    expect(columns.map(({ column_name }) => column_name)).toEqual([
      'approvedDeciderKind',
      'approvedDeciderLabel',
      'approvedDeciderMembershipId',
      'deciderKind',
      'deciderMembershipId',
    ]);
    expect(legacyTable[0]?.present).toBe(true);
  });

  it('keeps the still-serving old approval writer valid while the tuple is nullable', async () => {
    const id = await seedDecision();

    await db.decision.update({
      where: { id },
      data: {
        status: 'approved',
        approvedOption: 'Legacy option',
        approver: 'Legacy approver',
        approvedById: userId,
      },
    });

    const decision = await db.decision.findUniqueOrThrow({ where: { id } });
    expect(decision.status).toBe('approved');
    expect(decision.approvedDeciderKind).toBeNull();
    expect(decision.approvedDeciderMembershipId).toBeNull();
    expect(decision.approvedDeciderLabel).toBeNull();
  });

  it('freezes the current holder after publication and freezes attribution once written', async () => {
    const holderId = await seedDecision({
      deciderKind: 'member',
      deciderMembershipId: membershipId,
    });
    const approvalId = await seedDecision(attributed());

    await expect(
      db.decision.update({
        where: { id: holderId },
        data: { deciderKind: 'client', deciderMembershipId: null },
      }),
    ).rejects.toThrow(/holder|decider|published/i);
    await expect(
      db.decision.update({
        where: { id: approvalId },
        data: { approvedDeciderLabel: 'Someone else' },
      }),
    ).rejects.toThrow(/attribution|approval|frozen/i);
    await expect(
      db.$executeRawUnsafe(`UPDATE "Decision" SET "id" = $2 WHERE "id" = $1`, approvalId, nextId('rekeyed')),
    ).rejects.toThrow(/identity|frozen/i);
    await expect(
      db.$executeRawUnsafe(`UPDATE "Decision" SET "projectId" = $2 WHERE "id" = $1`, approvalId, 'missing-project'),
    ).rejects.toThrow(/identity|frozen/i);
  });

  it('keeps the migration-owned legacy set closed to application writers', async () => {
    const id = await seedDecision();

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "DecisionLegacyApproval"("decisionId") VALUES ($1)`,
        id,
      ),
    ).rejects.toThrow(/migration|legacy|evidence/i);
    const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "DecisionLegacyApproval" WHERE "decisionId" = $1`,
      id,
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  it('refuses DELETE for both an attributed approval and a migration-stamped legacy approval', async () => {
    const attributedId = await seedDecision(attributed());
    const legacyId = await seedDecision({ status: 'approved' });
    await seedLegacyStamp(legacyId);

    for (const id of [attributedId, legacyId]) {
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = $1`, id),
      ).rejects.toThrow(/approval|evidence|permanent/i);
    }
    expect(await db.decision.count({ where: { id: { in: [attributedId, legacyId] } } })).toBe(2);
  });

  it('serializes attribution with DELETE so committed evidence cannot be erased', async () => {
    const id = await seedDecision({ deciderKind: 'member', deciderMembershipId: membershipId });
    let releaseWriter!: () => void;
    let writerUpdated!: () => void;
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const updated = new Promise<void>((resolve) => { writerUpdated = resolve; });

    const writing = writer.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "Decision"
            SET "status" = 'approved',
                "approvedDeciderKind" = 'member',
                "approvedDeciderMembershipId" = $2,
                "approvedDeciderLabel" = 'Approval holder'
          WHERE "id" = $1`,
        id,
        membershipId,
      );
      writerUpdated();
      await release;
    }, { timeout: 30_000, maxWait: 5_000 });
    await updated;

    const deleting = eraser.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = $1`, id)
      .then(() => null, (error: unknown) => error);
    await waitForBlocked('%DELETE FROM "Decision" WHERE "id"%');
    releaseWriter();
    await writing;
    const deleteError = await deleting;

    expect(deleteError, 'DELETE must re-evaluate after the attribution writer commits').not.toBeNull();
    expect(await db.decision.count({ where: { id } })).toBe(1);
  });

  it('serializes attribution with TRUNCATE so the whole register cannot erase committed evidence', async () => {
    const id = await seedDecision({ deciderKind: 'member', deciderMembershipId: membershipId });
    let releaseWriter!: () => void;
    let writerUpdated!: () => void;
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const updated = new Promise<void>((resolve) => { writerUpdated = resolve; });

    const writing = writer.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "Decision"
            SET "status" = 'approved',
                "approvedDeciderKind" = 'member',
                "approvedDeciderMembershipId" = $2,
                "approvedDeciderLabel" = 'Approval holder'
          WHERE "id" = $1`,
        id,
        membershipId,
      );
      writerUpdated();
      await release;
    }, { timeout: 30_000, maxWait: 5_000 });
    await updated;

    const truncating = eraser.$executeRawUnsafe('TRUNCATE "Decision" CASCADE')
      .then(() => null, (error: unknown) => error);
    await waitForBlocked('%TRUNCATE "Decision" CASCADE%');
    releaseWriter();
    await writing;
    const truncateError = await truncating;

    expect(truncateError, 'TRUNCATE must inspect the register after the writer commits').not.toBeNull();
    expect(await db.decision.count({ where: { id } })).toBe(1);
  });
});
