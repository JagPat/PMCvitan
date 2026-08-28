import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

/** The exact `phase6_t4a_withdrawn_no_delete` definition a given migration file installs. The
 *  4a migration is deliberately rerunnable for operator repair, so replaying it restores ITS
 *  (older, withdrawn-only) body over the consolidated one 4b writes. Reading both bodies from
 *  the real migration files keeps this probe honest if either ever changes. */
const withdrawnNoDeleteBody = (migration: string): string => {
  const sql = readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
  const match = sql.match(
    /CREATE OR REPLACE FUNCTION phase6_t4a_withdrawn_no_delete\(\)[\s\S]*?END \$fn\$ LANGUAGE plpgsql;/,
  );
  if (!match) throw new Error(`phase6_t4a_withdrawn_no_delete not found in ${migration}`);
  return match[0];
};

const T4A_MIGRATION = '20270810000000_phase6_t4a_withdraw';
const T4B_MIGRATION = '20270826000000_phase6_t4b_approval_attribution';

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
    // an active pmc member — the 4b publication arm requires standing for a pmc-held publication
    await db.user.create({
      data: { id: `${userId}-pmc`, projectId, role: 'pmc', name: 'PMC holder', email: `pmc-${run}@t4b.test` },
    });
    await db.membership.create({
      data: { projectId, userId: `${userId}-pmc`, role: 'pmc', status: 'active' },
    });
  });

  afterAll(async () => {
    await cleanupDecisions();
    await db?.membership.deleteMany({ where: { projectId } });
    await db?.user.deleteMany({ where: { id: { in: [userId, `${userId}-pmc`] } } });
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
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionEvent_no_withdrawn_approval') THEN
          ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4b2_record_no_delete') THEN
          ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b2_record_no_delete";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionOption_t4a_frozen') THEN
          ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen";
        END IF;
      END $do$`),
      db.decisionEvent.deleteMany({ where: { decision: { projectId } } }),
      db.decisionOption.deleteMany({ where: { decision: { projectId } } }),
      db.decision.deleteMany({ where: { projectId } }),
      db.$executeRawUnsafe(`DO $do$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionOption_t4a_frozen') THEN
          ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'Decision_t4b2_record_no_delete') THEN
          ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b2_record_no_delete";
        END IF;
        IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionEvent_no_withdrawn_approval') THEN
          ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval";
        END IF;
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
      approvedById: string | null;
      approver: string | null;
      approvedOption: string | null;
    }> = {},
  ): Promise<string> => {
    const id = nextId('decision');
    const publishedAt = over.publishedAt === undefined ? new Date() : over.publishedAt;
    // re-ordered seed (4b): unpublished birth with 2 options, published in the same transaction —
    // the deferred option floor and the widened option freeze refuse a published+optionless insert
    await db.$transaction(async (tx) => {
      await tx.decision.create({
        data: {
          id,
          projectId,
          title: `Approval attribution ${id}`,
          room: 'Office',
          status: over.status ?? 'pending',
          ageDays: 0,
          photoSwatch: 'blue',
          authorId: userId,
          approvedById: over.approvedById ?? null,
          approver: over.approver ?? null,
          approvedOption: over.approvedOption ?? null,
          publishedAt: null,
          deciderKind: over.deciderKind ?? 'client',
          deciderMembershipId: over.deciderMembershipId ?? null,
          approvedDeciderKind: over.approvedDeciderKind ?? null,
          approvedDeciderMembershipId: over.approvedDeciderMembershipId ?? null,
          approvedDeciderLabel: over.approvedDeciderLabel ?? null,
          options: {
            createMany: {
              data: [
                { label: 'Option A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw-a', order: 0 },
                { label: 'Option B', optionKey: 'b', material: 'Walnut', delta: 100, swatch: 'sw-b', order: 1 },
              ],
            },
          },
        },
      });
      if (publishedAt !== null) {
        await tx.decision.update({ where: { id }, data: { publishedAt } });
      }
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

  // ── Round 1 (Codex) — the two P1 findings on head 32cd6a1 ────────────────────────────────
  describe('round 1 (Codex F1): the holder freeze does not rest on a nullable publication value', () => {
    it('F1: a published decision cannot be un-published, so the two-transaction holder rewrite cannot even start', async () => {
      const id = await seedDecision({ deciderKind: 'member', deciderMembershipId: membershipId });

      // step 1 of the attack: clear the nullable value the freeze used to key on
      await expect(
        db.$executeRawUnsafe(`UPDATE "Decision" SET "publishedAt" = NULL WHERE "id" = $1`, id),
      ).rejects.toThrow(/un-published|publication is permanent/i);
      // step 2 is refused independently — the row is still published and still holds its holder
      await expect(
        db.decision.update({ where: { id }, data: { deciderKind: 'pmc', deciderMembershipId: null } }),
      ).rejects.toThrow(/holder|decider|frozen/i);

      const row = await db.decision.findUniqueOrThrow({ where: { id } });
      expect(row.publishedAt).not.toBeNull();
      expect(row.deciderKind).toBe('member');
      expect(row.deciderMembershipId).toBe(membershipId);
    });

    it('F1: an attributed approval freezes its holder even with no publication fact at all', async () => {
      const id = await seedDecision({ ...attributed(), publishedAt: null });

      await expect(
        db.decision.update({ where: { id }, data: { deciderKind: 'pmc', deciderMembershipId: null } }),
      ).rejects.toThrow(/holder|decider|frozen/i);

      const row = await db.decision.findUniqueOrThrow({ where: { id } });
      expect(row.publishedAt).toBeNull();
      // the frozen approval tuple and the current holder still name the same person
      expect(row.deciderKind).toBe('member');
      expect(row.deciderMembershipId).toBe(membershipId);
      expect(row.approvedDeciderMembershipId).toBe(membershipId);
    });

    it('F1: approval standing and a migration stamp each freeze the holder without publication', async () => {
      const legacyStanding = await seedDecision({
        status: 'approved',
        publishedAt: null,
        deciderKind: 'member',
        deciderMembershipId: membershipId,
        approvedById: userId,
        approver: 'Legacy approver',
        approvedOption: 'Legacy option',
      });
      const stamped = await seedDecision({
        publishedAt: null,
        deciderKind: 'member',
        deciderMembershipId: membershipId,
      });
      await seedLegacyStamp(stamped);

      for (const id of [legacyStanding, stamped]) {
        await expect(
          db.decision.update({ where: { id }, data: { deciderKind: 'client', deciderMembershipId: null } }),
        ).rejects.toThrow(/holder|decider|frozen/i);
      }
      expect(
        await db.decision.count({ where: { id: { in: [legacyStanding, stamped] }, deciderKind: 'member' } }),
      ).toBe(2);
    });

    it('F1 precision: a private, evidence-free draft still designates its holder freely', async () => {
      const id = await seedDecision({ publishedAt: null });

      await db.decision.update({
        where: { id },
        data: { deciderKind: 'member', deciderMembershipId: membershipId },
      });
      await db.decision.update({ where: { id }, data: { deciderKind: 'pmc', deciderMembershipId: null } });
      // and publishing it is still the one-way transition the product performs
      await db.decision.update({ where: { id }, data: { publishedAt: new Date() } });

      const row = await db.decision.findUniqueOrThrow({ where: { id } });
      expect(row.deciderKind).toBe('pmc');
      expect(row.publishedAt).not.toBeNull();
    });
  });

  describe('round 1 (Codex F2): replaying the rerunnable 4a migration cannot reopen evidence deletion', () => {
    it('F2: a compatibility-window tupleless approval survives DELETE after the older 4a body is restored', async () => {
      // exactly the UP4B-OLD shape: the still-serving pre-4b writer approved without the new
      // tuple, and the migration stamp covers only rows that predate the 4b migration
      const id = await seedDecision({
        status: 'approved',
        approvedById: userId,
        approver: 'Legacy approver',
        approvedOption: 'Legacy option',
      });
      expect(
        await db.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT COUNT(*) AS count FROM "DecisionLegacyApproval" WHERE "decisionId" = $1`,
          id,
        ).then((rows) => Number(rows[0]?.count ?? 0)),
        'the fixture must be tupleless AND unstamped — the exact class the finding names',
      ).toBe(0);

      try {
        // an operator replays the rerunnable 4a migration for repair; it restores its own older,
        // withdrawn-only body over the consolidated one this unit installed
        await db.$executeRawUnsafe(withdrawnNoDeleteBody(T4A_MIGRATION));
        const regressed = await db.$queryRawUnsafe<Array<{ def: string }>>(
          `SELECT pg_get_functiondef('phase6_t4a_withdrawn_no_delete()'::regprocedure) AS def`,
        );
        expect(
          regressed[0]?.def ?? '',
          'the replay must really have removed the consolidated approval arm — otherwise this probe proves nothing',
        ).not.toContain('approvedById');

        const error = await db
          .$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = $1`, id)
          .then(() => null, (caught: unknown) => caught);
        expect(error, 'the 4b seal must refuse the DELETE on its own').not.toBeNull();
        expect(String(error)).toMatch(/approval attribution\/evidence is permanent/);
        expect(await db.decision.count({ where: { id } })).toBe(1);
      } finally {
        await db.$executeRawUnsafe(withdrawnNoDeleteBody(T4B_MIGRATION));
      }

      // the consolidated body is back, and it refuses the same DELETE first
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = $1`, id),
      ).rejects.toThrow(/approval evidence is a permanent register entry/);
    });

    it('F2: the 4b seal independently covers every approval signal, and only approval signals', async () => {
      const standing = await seedDecision({ status: 'approved' });
      const legacyColumns = await seedDecision({ approvedById: userId, approver: 'Legacy approver' });
      const event = await seedDecision();
      await db.$executeRawUnsafe(
        `INSERT INTO "DecisionEvent"("id","decisionId","type","actor") VALUES ($1, $2, 'approved', 'legacy writer')`,
        nextId('ev'),
        event,
      );
      const plainDraft = await seedDecision({ publishedAt: null });

      try {
        await db.$executeRawUnsafe(withdrawnNoDeleteBody(T4A_MIGRATION));
        for (const id of [standing, legacyColumns, event]) {
          await expect(
            db.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = $1`, id),
          ).rejects.toThrow(/approval attribution\/evidence is permanent/);
        }
        // precision: a decision carrying no approval signal at all is still deletable
        // (its options go first — an UNPUBLISHED parent's options are not frozen)
        await db.decisionOption.deleteMany({ where: { decisionId: plainDraft } });
        expect(await db.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = $1`, plainDraft)).toBe(1);
      } finally {
        await db.$executeRawUnsafe(withdrawnNoDeleteBody(T4B_MIGRATION));
      }

      expect(await db.decision.count({ where: { id: { in: [standing, legacyColumns, event] } } })).toBe(3);
    });
  });
});
