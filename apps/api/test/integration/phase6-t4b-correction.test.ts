import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { applyMigrationThroughHead, createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-1 CORRECTION (Codex, twelve findings on head `ed72636`).
 *
 * Every probe here was RED at `ed72636` and is GREEN after `20270816000000` plus its service half.
 * The finding numbers are Codex's, in the order the review posted them.
 */
describe('Phase 6 unit 4b-i round 1 — the twelve Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let members: MembersService;
  let seq = 0;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    members = t.app.get(MembersService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
  });

  /** A published record-only issue, filed by the pmc. */
  const seedRecord = async (): Promise<string> => {
    const id = `DL-t4bc-rec-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Recorded ${id}`, room: 'Kitchen', status: 'recorded',
        ageDays: 0, photoSwatch: 'recorded', authorId: f.memberUser.id, deciderKind: 'none', publishedAt: null,
      },
    });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  /** A published ordinary (client-held) decision with its two options. */
  const seedOrdinary = async (): Promise<string> => {
    const id = `DL-t4bc-ord-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Ordinary ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  // ── F1 ─────────────────────────────────────────────────────────────────────────────────────
  it('F1: a published recorded issue cannot be DELETED — the seal covers the verb it was missing', async () => {
    const id = await seedRecord();
    // at ed72636 the seal fired BEFORE INSERT OR UPDATE only, and 4a's no-delete covers only
    // `withdrawn`, so this DELETE reached no rejecting trigger at all
    await expect(t.prisma.$executeRaw`DELETE FROM "Decision" WHERE "id" = ${id}`)
      .rejects.toThrow(/permanent register entry/);
    expect(await t.prisma.decision.count({ where: { id } })).toBe(1);
    // precision: an UNPUBLISHED record draft is still deletable — the freeze starts at publication
    const draftId = `DL-t4bc-draft-${seq++}`;
    await t.prisma.decision.create({
      data: { id: draftId, projectId: f.projectA.id, title: 'Draft record', room: 'K', status: 'recorded',
        ageDays: 0, photoSwatch: 'recorded', authorId: f.memberUser.id, deciderKind: 'none', publishedAt: null },
    });
    expect(await t.prisma.$executeRaw`DELETE FROM "Decision" WHERE "id" = ${draftId}`).toBe(1);
  });

  // ── F2 ─────────────────────────────────────────────────────────────────────────────────────
  it('F2: approval EVENTS are approval evidence — a draft carrying one cannot become a record, and none can land on a record after', async () => {
    // (a) the conversion counts DecisionEvent, not only DecisionApprovalRevision
    const draftId = `DL-t4bc-conv-${seq++}`;
    await t.prisma.decision.create({
      data: { id: draftId, projectId: f.projectA.id, title: 'Convertible', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
    });
    await t.prisma.decisionEvent.create({ data: { decisionId: draftId, type: 'approved', actor: 'Legacy Client' } });
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = ${draftId}`,
    ).rejects.toThrow(/approval EVENT cannot become a record/);

    // (b) the reverse arm: no approval event may be recorded against a record
    const recId = await seedRecord();
    await expect(
      t.prisma.decisionEvent.create({ data: { decisionId: recId, type: 'approved', actor: 'Hostile' } }),
    ).rejects.toThrow(/no approver/);
    // precision: a NON-approval event on a record is ordinary history and still lands
    await t.prisma.decisionEvent.create({ data: { decisionId: recId, type: 'issued', actor: 'PMC' } });
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: recId } })).toBe(1);
  });

  // ── F4 ─────────────────────────────────────────────────────────────────────────────────────
  it('F4: the approval holder tuple is FROZEN — it cannot be reattributed, nor planted on a row that carries no approval', async () => {
    const id = await seedOrdinary();
    await svc.approve(f.projectA.id, id, { optionIndex: 0 }, pmc());
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.approvedDeciderKind).toBe('client');

    // at ed72636 nothing froze these: direct SQL could reattribute a committed approval
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "approvedDeciderKind"='pmc' WHERE "id" = ${id}`,
    ).rejects.toThrow(/frozen act/);
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "approvedDeciderLabel"='Someone else' WHERE "id" = ${id}`,
    ).rejects.toThrow(/frozen act/);

    // ...nor may the tuple be PLANTED on a row that never carried an approval
    const pendingId = await seedOrdinary();
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "approvedDeciderKind"='client', "approvedDeciderLabel"='Forged' WHERE "id" = ${pendingId}`,
    ).rejects.toThrow(/may only be written by an approval/);
  });

  // ── F5 ─────────────────────────────────────────────────────────────────────────────────────
  it('F5: the correction migration AUDITS already-published decisions that hold fewer than two options', async () => {
    const { execFileSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const migrationPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../prisma/migrations/20270816000000_phase6_t4b_correction/migration.sql',
    );
    const dbUrl = (process.env.DATABASE_URL ?? '').split('?')[0]!;

    // a published ordinary decision with ONE option — the state 20270815 let survive, and then
    // froze beyond repair. Planted through the sanctioned bypass, since the freeze is now live.
    const id = `DL-t4bc-thin-${seq++}`;
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: 'Thin', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
    });
    await t.prisma.decisionOption.create({ data: { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 } });
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_publication_seal"'),
      t.prisma.$executeRaw`UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = ${id}`,
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_publication_seal"'),
    ]);

    // the migration is rerunnable BY DESIGN — run it as the operator would, and it must ABORT
    // NAMING the row rather than freezing an unapprovable decision in place
    let aborted = '';
    try {
      execFileSync('psql', [dbUrl, '-q', '-1', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], { stdio: 'pipe' });
    } catch (e) {
      aborted = String((e as { stderr?: Buffer }).stderr ?? e);
    }
    expect(aborted).toMatch(/fewer than two options/);
    expect(aborted).toContain(id);

    // repair as the diagnostic instructs, and the migration then applies cleanly
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
      t.prisma.decisionOption.create({ data: { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4b_published_frozen"'),
    ]);
    // …and the database is then put BACK AT HEAD. Round 2 found this the way order-dependent
    // defects are always found: two probes in a LATER suite failed, and only when this one had run
    // first. Re-running an earlier migration replays its `CREATE OR REPLACE`, silently undoing
    // every later migration that redefines the same function — for the rest of the process, on a
    // database eleven suites share. See `applyMigrationThroughHead`.
    applyMigrationThroughHead(dbUrl, '20270816000000_phase6_t4b_correction');
    // ASSERTED, not assumed: the round-2 transition guard must be live again
    const restored = await t.prisma.$queryRawUnsafe<Array<{ src: string }>>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname = 'decision_t4b_recorded_seal'`,
    );
    expect(restored[0]!.src).toContain('never onto a row that is already approved');
  });

  // ── F6 ─────────────────────────────────────────────────────────────────────────────────────
  it('F6: the option guard SERIALIZES with publication — a concurrent delete cannot slip past an in-flight publish', async () => {
    const id = `DL-t4bc-race-${seq++}`;
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: 'Race', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });

    const other = new PrismaClient();
    try {
      let release!: () => void;
      const mayCommit = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const isHeld = new Promise<void>((r) => { held = r; });

      // the publisher takes the head row and holds its transaction open
      const publishing = t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = ${id}`;
        held();
        await mayCommit;
      }, { timeout: 30_000 });
      await isHeld;

      // the concurrent delete must NOT read the stale `publishedAt = NULL` and succeed
      const deleting = other.$executeRaw`DELETE FROM "DecisionOption" WHERE "decisionId" = ${id} AND "optionKey" = 'b'`
        .then(() => 'deleted' as const, () => 'refused' as const);

      // CONDITION-BASED, not a sleep: wait until the delete is observably in flight before the
      // publisher commits, so the interleaving is the one under test. With the guard's `FOR SHARE`
      // the delete BLOCKS on the head row and this loop sees the lock wait; at ed72636 the
      // unlocked read let it finish immediately, and the probe records `deleted` — which is the
      // RED this fix exists for. Either way the loop ends, so the probe cannot hang.
      let settled: 'deleted' | 'refused' | 'pending' = 'pending';
      for (let i = 0; i < 60; i++) {
        const waiting = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%DecisionOption%'`,
        );
        if (Number(waiting[0]!.n) > 0) break;
        settled = await Promise.race([deleting, Promise.resolve('pending' as const)]);
        if (settled !== 'pending') break;
        await new Promise((r) => setTimeout(r, 50));
      }

      release();
      await publishing;
      expect(await deleting).toBe('refused');
      expect(await t.prisma.decisionOption.count({ where: { decisionId: id } })).toBe(2);
    } finally {
      await other.$disconnect();
    }
  });

  // ── F7 ─────────────────────────────────────────────────────────────────────────────────────
  it('F7: the DB author predicate matches ROLE_POLICY[decision.create] — an engineer cannot file a record by direct insert', async () => {
    const engId = `t4bc-eng-${Date.now() % 1e6}`;
    await t.prisma.user.create({ data: { id: engId, projectId: f.projectA.id, role: 'engineer', name: 'Eng', email: `${engId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engId, role: 'engineer', status: 'active' } });
    try {
      const id = `DL-t4bc-eng-${seq++}`;
      await expect(t.prisma.decision.create({
        data: { id, projectId: f.projectA.id, title: 'By an engineer', room: 'K', status: 'recorded',
          ageDays: 0, photoSwatch: 'recorded', authorId: engId, deciderKind: 'none', publishedAt: null },
      })).rejects.toThrow(/decision authority/);
      // precision: the PMC, whom the policy DOES admit, still files one
      const ok = `DL-t4bc-pmc-${seq++}`;
      await t.prisma.decision.create({
        data: { id: ok, projectId: f.projectA.id, title: 'By the pmc', room: 'K', status: 'recorded',
          ageDays: 0, photoSwatch: 'recorded', authorId: f.memberUser.id, deciderKind: 'none', publishedAt: null },
      });
      expect(await t.prisma.decision.count({ where: { id: ok } })).toBe(1);
    } finally {
      await t.prisma.membership.deleteMany({ where: { userId: engId } });
      await t.prisma.user.deleteMany({ where: { id: engId } });
    }
  });

  // ── F3 ─────────────────────────────────────────────────────────────────────────────────────
  it('F3: a record-only issue announces to NOBODY — neither the create path nor the publish path sends an approval demand', async () => {
    // (a) one-step issue
    await svc.create(f.projectA.id, { title: 'Recorded now', room: 'Kitchen', options: [], deciderKind: 'none', publish: true } as never, pmc());
    const created = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Recorded now' } });
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: created.id, eventType: 'decision.published' } });
    expect((ev.dispatchIntent as { push?: unknown } | null)?.push ?? null, 'a record pushes nothing').toBeNull();
    const notices = await t.prisma.notification.findMany({ where: { decisionId: created.id } });
    expect(notices[0]?.text).toMatch(/^Issue recorded/);

    // (b) the saved DRAFT record, published later — the path that kept the pending notice AND push
    const draft = await svc.create(f.projectA.id, { title: 'Recorded later', room: 'Kitchen', options: [], deciderKind: 'none' } as never, pmc());
    expect(draft).toBeTruthy();
    const saved = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Recorded later' } });
    await svc.publish(f.projectA.id, saved.id, pmc());
    const ev2 = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: saved.id, eventType: 'decision.published' } });
    expect((ev2.dispatchIntent as { push?: unknown } | null)?.push ?? null).toBeNull();
    const notices2 = await t.prisma.notification.findMany({ where: { decisionId: saved.id } });
    expect(notices2.every((n) => /^Issue recorded/.test(n.text)), 'no pending demand for a record').toBe(true);
  });

  // ── F12 ────────────────────────────────────────────────────────────────────────────────────
  it('F12: removing a member who holds an open decision is a 409 with a repair instruction, not a 500', async () => {
    const holderUser = `t4bc-holder-${Date.now() % 1e6}`;
    await t.prisma.user.create({ data: { id: holderUser, projectId: f.projectA.id, role: 'contractor', name: 'Holder', email: `${holderUser}@t.local` } });
    const m = await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: holderUser, role: 'contractor', status: 'active' } });
    try {
      const id = `DL-t4bc-held-${seq++}`;
      await t.prisma.decision.create({
        data: { id, projectId: f.projectA.id, title: 'Held', room: 'K', status: 'pending', ageDays: 0,
          photoSwatch: 'sw1', authorId: f.memberUser.id, deciderKind: 'member', deciderMembershipId: m.id, publishedAt: null },
      });
      await t.prisma.decisionOption.createMany({ data: [
        { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
        { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
      ] });
      await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

      // at ed72636 this reached the trigger and surfaced as an internal error
      await expect(members.remove(f.projectA.id, pmc(), holderUser)).rejects.toMatchObject({ status: 409 });

      // F11: an ACTIVE role change keeps the membership, so it keeps the holder — and is ALLOWED
      await members.updateRole(f.projectA.id, pmc(), holderUser, { role: 'engineer' } as never);
      expect((await t.prisma.membership.findUniqueOrThrow({ where: { id: m.id } })).role).toBe('engineer');
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).deciderMembershipId).toBe(m.id);
    } finally {
      await wipeDecisions(t.prisma, { projectId: f.projectA.id });
      await t.prisma.membership.deleteMany({ where: { userId: holderUser } });
      await t.prisma.user.deleteMany({ where: { id: holderUser } });
    }
  });
});
