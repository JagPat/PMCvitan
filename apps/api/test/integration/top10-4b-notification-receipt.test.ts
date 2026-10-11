import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Top 10 #4b (#778) — per-notice read receipts: the storage contract, as the database enforces it on every writer
 * (raw SQL included). Unit A of #785's approved redesign; which receipts get written is units B–D.
 *
 * R1  Tenant binding, continuously: a receipt and its notice share one project at every committed state — a
 *     mismatched insert is refused, a receipted kindless notice cannot move project, an unreceipted one still can,
 *     and a concurrent move and receipt serialize in both orders.
 * R2  Standing at insert, by the existing windowed contract: members in any role (cross-project members included)
 *     and a membership-less org owner — with a fanned-out row AND in the rollout window before re-projection —
 *     are admitted; a member of another project, an owner of an unrelated org, a stranger and an archived project
 *     are refused; a concurrent demotion of the authorizing row serializes in both orders.
 * R3  Immutable: no UPDATE, no direct DELETE, no TRUNCATE (statement seal, bypassed only by the isolated test
 *     reset); the notice, viewer and project cascades remove receipts.
 * Plus: the reset paths, the db-push baseline replay, a dump-and-restore round trip, and previous-release shapes.
 */
describe('Top 10 #4b — NotificationReceipt (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const MIGRATION = '20280109000000_top10_4b_notification_receipt';
  const extraUsers: string[] = [];
  const extraOrgs: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    // receipts go with their notices (the fixture's cleanup deletes the projects' notices), and with their users
    await t.prisma.orgMembership.deleteMany({ where: { orgId: { in: extraOrgs } } });
    await t.prisma.membership.deleteMany({ where: { userId: { in: extraUsers } } });
    await t.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    await t.prisma.org.deleteMany({ where: { id: { in: extraOrgs } } });
    await f?.cleanup();
    await t?.close();
  });

  const notice = async (projectId: string, text = `n-${randomUUID().slice(0, 6)}`) =>
    (await t.prisma.notification.create({ data: { projectId, text, color: '#000', time: 'just now' } })).id;
  const receipt = (notificationId: string, userId: string, projectId: string) =>
    t.prisma.notificationReceipt.create({ data: { notificationId, userId, projectId } });
  const receiptCount = (where: { notificationId?: string; userId?: string; projectId?: string }) =>
    t.prisma.notificationReceipt.count({ where });
  /** A promise resolvable from outside, to hold a transaction open at a known point. */
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));
  /**
   * Deterministic barrier (#785 review 5483343407): wait until a contender tagged with `marker` is BLOCKED on a
   * database lock, as `commercial-deadlock-lockorder.test.ts` does, so a release can never merely run the two
   * operations one after the other.
   */
  const reachesLockWait = async (marker: string, ms = 10_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        `%${marker}%`,
      );
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const marker = (label: string) => `rc-${label}-${randomUUID().slice(0, 8)}`;
  /** A receipt INSERT tagged with `tag`, so `reachesLockWait` can see it waiting. */
  const taggedReceipt = (tag: string, notificationId: string, userId: string, projectId: string) =>
    t.prisma.$executeRawUnsafe(
      `INSERT /* ${tag} */ INTO "NotificationReceipt" ("notificationId","userId","projectId") VALUES ($1, $2, $3)`,
      notificationId, userId, projectId,
    );

  describe('R1 — tenant binding', () => {
    it('refuses a receipt that names another project than its notice, through the client and raw SQL', async () => {
      const n = await notice(f.projectA.id);
      await expect(receipt(n, f.otherUser.id, f.projectB.id)).rejects.toThrow();
      await expect(t.prisma.$executeRaw`INSERT INTO "NotificationReceipt" ("notificationId","userId","projectId") VALUES (${n}, ${f.otherUser.id}, ${f.projectB.id})`).rejects.toThrow();
      expect(await receiptCount({ notificationId: n })).toBe(0);
    });

    it('refuses moving a receipted kindless notice to another project; an unreceipted one stays movable', async () => {
      const held = await notice(f.projectA.id);
      await receipt(held, f.memberUser.id, f.projectA.id);
      await expect(t.prisma.$executeRaw`UPDATE "Notification" SET "projectId" = ${f.projectB.id} WHERE "id" = ${held}`).rejects.toThrow(/foreign key|violates/);
      expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: held } })).projectId).toBe(f.projectA.id);

      const free = await notice(f.projectA.id);
      await t.prisma.$executeRaw`UPDATE "Notification" SET "projectId" = ${f.projectB.id} WHERE "id" = ${free}`;
      expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: free } })).projectId).toBe(f.projectB.id);
    });

    it('serializes a concurrent move and receipt: a move held open first refuses the receipt once it commits', async () => {
      const n = await notice(f.projectA.id);
      const moved = gate(); const release = gate();
      const move = t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "Notification" SET "projectId" = ${f.projectB.id} WHERE "id" = ${n}`;
        moved.open();
        await release.p;
      }, { timeout: 30_000 });
      await moved.p;
      const tag = marker('move-first');
      const insert = settle(taggedReceipt(tag, n, f.memberUser.id, f.projectA.id));
      expect(await reachesLockWait(tag), 'the receipt INSERT is blocked on the moving notice row').toBe(true);
      release.open();
      await move;
      const outcome = await insert;
      expect(outcome.ok).toBe(false);
      expect(await receiptCount({ notificationId: n })).toBe(0);
    });

    it('serializes a concurrent move and receipt: a receipt held open first refuses the move once it commits', async () => {
      const n = await notice(f.projectA.id);
      const inserted = gate(); const release = gate();
      const write = t.prisma.$transaction(async (tx) => {
        await tx.notificationReceipt.create({ data: { notificationId: n, userId: f.memberUser.id, projectId: f.projectA.id } });
        inserted.open();
        await release.p;
      }, { timeout: 30_000 });
      await inserted.p;
      const tag = marker('receipt-first');
      const move = settle(t.prisma.$executeRawUnsafe(`UPDATE /* ${tag} */ "Notification" SET "projectId" = $1 WHERE "id" = $2`, f.projectB.id, n));
      expect(await reachesLockWait(tag), 'the notice move is blocked on the receipted row').toBe(true);
      release.open();
      await write;
      const outcome = await move;
      expect(outcome.ok).toBe(false);
      expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: n } })).projectId).toBe(f.projectA.id);
      expect(await receiptCount({ notificationId: n })).toBe(1);
    });
  });

  describe('R2 — standing at insert (the windowed contract)', () => {
    it('admits members in any role on the project, and a member whose home project is another one', async () => {
      const n = await notice(f.projectA.id);
      await receipt(n, f.memberUser.id, f.projectA.id); // pmc member
      await receipt(n, f.clientUser.id, f.projectA.id); // client member
      // a cross-project member: home project A, active membership on B
      const nb = await notice(f.projectB.id);
      await t.prisma.membership.create({ data: { projectId: f.projectB.id, userId: f.strangerUser.id, role: 'engineer', status: 'active' } });
      try {
        await receipt(nb, f.strangerUser.id, f.projectB.id);
        expect(await receiptCount({ notificationId: nb, userId: f.strangerUser.id })).toBe(1);
      } finally {
        await t.prisma.membership.deleteMany({ where: { projectId: f.projectB.id, userId: f.strangerUser.id } });
      }
    });

    it('admits a membership-less org owner, both with a fanned-out pmc row and in the rollout window without one', async () => {
      const n = await notice(f.projectA.id);
      await receipt(n, f.ownerUser.id, f.projectA.id);
      // the window: the owner's derived row is absent until 4d-iii re-projects. Reproduced inside one transaction
      // (the register's writer seal disabled BY NAME only for the delete), then rolled back.
      const n2 = await notice(f.projectA.id);
      const probe = await settle(t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "ProjectUserStanding" DISABLE TRIGGER "ProjectUserStanding_t4d_writer"');
        await tx.$executeRaw`DELETE FROM "ProjectUserStanding" WHERE "projectId" = ${f.projectA.id} AND "userId" = ${f.ownerUser.id}`;
        await tx.$executeRawUnsafe('ALTER TABLE "ProjectUserStanding" ENABLE TRIGGER "ProjectUserStanding_t4d_writer"');
        const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "ProjectUserStanding" WHERE "projectId" = ${f.projectA.id} AND "userId" = ${f.ownerUser.id}`;
        expect(Number(rows[0]!.n)).toBe(0);
        await tx.notificationReceipt.create({ data: { notificationId: n2, userId: f.ownerUser.id, projectId: f.projectA.id } });
        throw new Error('rollback-window-probe');
      }));
      expect(probe.ok ? '' : probe.e).toContain('rollback-window-probe'); // the receipt was admitted in the window
      expect(await receiptCount({ notificationId: n2 })).toBe(0); // and nothing of the probe persisted
    });

    it('refuses a member of another project, an owner of an unrelated org, a stranger, and an archived project', async () => {
      const n = await notice(f.projectA.id);
      const unrelatedOwner = `rc-own-${run}`;
      extraUsers.push(unrelatedOwner);
      await t.prisma.user.create({ data: { id: unrelatedOwner, projectId: f.projectB.id, role: 'pmc', name: 'Unrelated owner', email: `${unrelatedOwner}@t.local` } });
      await t.prisma.orgMembership.create({ data: { orgId: f.orgB.id, userId: unrelatedOwner, role: 'owner' } });
      for (const userId of [f.otherUser.id, unrelatedOwner, f.strangerUser.id]) {
        await expect(receipt(n, userId, f.projectA.id), userId).rejects.toThrow(/no standing/);
      }
      const archived = await notice(f.projectB.id);
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
      try {
        await expect(receipt(archived, f.otherUser.id, f.projectB.id)).rejects.toThrow(/not operable/);
      } finally {
        await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
      }
      expect(await receiptCount({ notificationId: n })).toBe(0);
    });

    it('serializes a concurrent demotion of the authorizing row in both orders', async () => {
      // the org owner's standing rests on OrgUserAuthority; a demotion writes it (then the fanned-out pmc row)
      const demote = (tx: { orgMembership: TestApp['prisma']['orgMembership'] }) =>
        tx.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } }, data: { role: 'member' } });
      const restore = () => t.prisma.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } }, data: { role: 'owner' } });

      // receipt first: the demotion waits for it, and the receipt (valid when written) stands
      const first = await notice(f.projectA.id);
      const wrote = gate(); const release = gate();
      const write = t.prisma.$transaction(async (tx) => {
        await tx.notificationReceipt.create({ data: { notificationId: first, userId: f.ownerUser.id, projectId: f.projectA.id } });
        wrote.open();
        await release.p;
      }, { timeout: 30_000 });
      await wrote.p;
      const demoteTag = marker('demote-waits');
      // settle() subscribes at once: a Prisma query is lazy and is not sent until something awaits or thens it
      const demotion = settle(t.prisma.$executeRawUnsafe(
        `UPDATE /* ${demoteTag} */ "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, f.ownerUser.id));
      expect(await reachesLockWait(demoteTag), 'the demotion is blocked on the authority row the receipt holds').toBe(true);
      release.open();
      await write;
      expect((await demotion).ok, 'the demotion completes once the receipt commits').toBe(true);
      expect(await receiptCount({ notificationId: first, userId: f.ownerUser.id })).toBe(1);
      await restore();

      // demotion first: the receipt waits for it, then sees no standing and is refused
      const second = await notice(f.projectA.id);
      const held = gate(); const go = gate();
      const demotion2 = t.prisma.$transaction(async (tx) => { await demote(tx); held.open(); await go.p; }, { timeout: 30_000 });
      await held.p;
      const insertTag = marker('receipt-waits');
      const insert = settle(taggedReceipt(insertTag, second, f.ownerUser.id, f.projectA.id));
      expect(await reachesLockWait(insertTag), 'the receipt is blocked on the authority row the demotion holds').toBe(true);
      go.open();
      await demotion2;
      const outcome = await insert;
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.e).toMatch(/no standing/);
      await restore();
    });
  });

  describe('R3 — immutable, and the legitimate cascades', () => {
    it('refuses an UPDATE and a direct DELETE, through the client and raw SQL', async () => {
      const n = await notice(f.projectA.id);
      await receipt(n, f.memberUser.id, f.projectA.id);
      const where = { notificationId_userId: { notificationId: n, userId: f.memberUser.id } };
      await expect(t.prisma.notificationReceipt.update({ where, data: { seenAt: new Date(0) } })).rejects.toThrow(/immutable/);
      await expect(t.prisma.$executeRaw`UPDATE "NotificationReceipt" SET "seenAt" = now() WHERE "notificationId" = ${n}`).rejects.toThrow(/immutable/);
      await expect(t.prisma.notificationReceipt.delete({ where })).rejects.toThrow(/may not be deleted directly/);
      await expect(t.prisma.$executeRaw`DELETE FROM "NotificationReceipt" WHERE "notificationId" = ${n}`).rejects.toThrow(/may not be deleted directly/);
      expect(await receiptCount({ notificationId: n })).toBe(1);
    });

    it('refuses a direct TRUNCATE, alone or reached by a CASCADE, and the isolated test reset still clears it', async () => {
      const n = await notice(f.projectA.id);
      await receipt(n, f.memberUser.id, f.projectA.id);
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE "NotificationReceipt"')).rejects.toThrow(/never truncated/);
      // reached through the notice register: the receipt seal refuses even if the notice seal were bypassed
      await expect(t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "Notification" DISABLE TRIGGER "Notification_t4d_no_truncate"');
        await tx.$executeRawUnsafe('TRUNCATE "Notification" CASCADE');
      })).rejects.toThrow(/receipt register is never truncated/);
      expect(await receiptCount({ notificationId: n })).toBe(1);
      // the sanctioned reset is registered: it disables the seal by name inside its own transaction and clears the
      // register (this suite's own receipts; the shared database's other suites hold none between runs)
      const { sanctionedReset, TRUNCATE_SEALS } = await import('../../prisma/sanctioned-reset');
      expect(TRUNCATE_SEALS).toContainEqual({ table: 'NotificationReceipt', trigger: 'NotificationReceipt_no_truncate' });
      await sanctionedReset(t.prisma, ['NotificationReceipt']);
      expect(await t.prisma.notificationReceipt.count()).toBe(0);
      // and the seal is back afterwards
      await receipt(n, f.memberUser.id, f.projectA.id);
      await expect(t.prisma.$executeRawUnsafe('TRUNCATE "NotificationReceipt"')).rejects.toThrow(/never truncated/);
    });

    it('goes with its notice (the delivered kindless retirement is a row delete), its viewer and its project', async () => {
      const byNotice = await notice(f.projectA.id);
      await receipt(byNotice, f.memberUser.id, f.projectA.id);
      await t.prisma.notification.delete({ where: { id: byNotice } });
      expect(await receiptCount({ notificationId: byNotice })).toBe(0);

      const viewer = `rc-view-${run}`;
      extraUsers.push(viewer);
      await t.prisma.user.create({ data: { id: viewer, projectId: f.projectA.id, role: 'pmc', name: 'Viewer', email: `${viewer}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: viewer, role: 'engineer', status: 'active' } });
      const byViewer = await notice(f.projectA.id);
      await receipt(byViewer, viewer, f.projectA.id);
      await t.prisma.membership.deleteMany({ where: { userId: viewer } });
      await t.prisma.user.delete({ where: { id: viewer } });
      expect(await receiptCount({ userId: viewer })).toBe(0);

      // a project of its own, so the delete is a clean cascade
      const org = `rc-org-${run}`;
      extraOrgs.push(org);
      await t.prisma.org.create({ data: { id: org, name: org, slug: org } });
      const pid = `rc-proj-${run}`;
      await t.prisma.project.create({ data: { id: pid, orgId: org, name: pid, short: 'R', descriptor: '', stage: 'x', siteCode: 'R', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 } });
      await t.prisma.membership.create({ data: { projectId: pid, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
      const byProject = await notice(pid);
      await receipt(byProject, f.memberUser.id, pid);
      await t.prisma.notification.deleteMany({ where: { projectId: pid } });
      await t.prisma.membership.deleteMany({ where: { projectId: pid } });
      await t.prisma.project.delete({ where: { id: pid } });
      expect(await receiptCount({ projectId: pid })).toBe(0);
    });
  });

  describe('deploy paths', () => {
    const url = () => { const u = new URL(process.env.DATABASE_URL!); u.search = ''; return u; };
    const migrationFile = () => join(__dirname, '../../prisma/migrations', MIGRATION, 'migration.sql');
    const guards = async () => (await t.prisma.$queryRaw<Array<{ n: string }>>`
      SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('NotificationReceipt_viewer_standing', 'NotificationReceipt_immutable', 'NotificationReceipt_no_truncate')
      ORDER BY 1`).map((r) => r.n);

    it('is on migrate.sh\'s ALWAYS_EXECUTE and re-runs over a db-push shape, installing both triggers, twice', async () => {
      const runner = readFileSync(join(__dirname, '../../scripts/migrate.sh'), 'utf8');
      const named = /ALWAYS_EXECUTE="([^"]*)"/u.exec(runner)![1]!.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(named).toContain(MIGRATION);
      const all = ['NotificationReceipt_immutable', 'NotificationReceipt_no_truncate', 'NotificationReceipt_viewer_standing'];
      expect(await guards()).toEqual(all);
      const n = await notice(f.projectA.id);
      await receipt(n, f.memberUser.id, f.projectA.id);
      const before = await t.prisma.notificationReceipt.count();
      const psql = () => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-d', url().toString(), '-f', migrationFile()], { encoding: 'utf8', stdio: 'pipe' });
      try {
        // the shape a db push leaves: the modeled table, keys and indexes, none of the triggers
        await t.prisma.$executeRawUnsafe('DROP TRIGGER "NotificationReceipt_viewer_standing" ON "NotificationReceipt"');
        await t.prisma.$executeRawUnsafe('DROP TRIGGER "NotificationReceipt_immutable" ON "NotificationReceipt"');
        await t.prisma.$executeRawUnsafe('DROP TRIGGER "NotificationReceipt_no_truncate" ON "NotificationReceipt"');
        expect(await guards()).toEqual([]);
        psql();
        expect(await guards()).toEqual(all);
        psql(); // and over the complete shape it is a no-op
        expect(await guards()).toEqual(all);
        expect(await t.prisma.notificationReceipt.count()).toBe(before);
      } finally {
        psql(); // never leave the shared database without its guards
      }
    });

    it('survives a dump and restore into a fresh database: the same receipts, every guard standing, nothing re-judged', async () => {
      const n = await notice(f.projectA.id);
      await receipt(n, f.memberUser.id, f.projectA.id);
      await receipt(n, f.clientUser.id, f.projectA.id);
      const restored = `pmcvitan_receipt_restore_${run.replace(/-/g, '')}`;
      const src = url();
      const dst = url(); dst.pathname = `/${restored}`;
      const admin = url(); admin.pathname = '/postgres';
      execFileSync('psql', ['-q', '-d', admin.toString(), '-c', `CREATE DATABASE "${restored}"`], { stdio: 'pipe' });
      try {
        const dump = execFileSync('pg_dump', ['-Fc', '-d', src.toString()], { maxBuffer: 1 << 30 });
        execFileSync('pg_restore', ['--no-owner', '--exit-on-error', '-d', dst.toString()], { input: dump, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
        const q = (sql: string) => execFileSync('psql', ['-At', '-d', dst.toString(), '-c', sql], { encoding: 'utf8' }).trim();
        expect(q(`SELECT string_agg("userId", ',' ORDER BY "userId") FROM "NotificationReceipt" WHERE "notificationId" = '${n}'`))
          .toBe([f.clientUser.id, f.memberUser.id].sort().join(','));
        expect(q(`SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname LIKE 'NotificationReceipt_%'`))
          .toBe('NotificationReceipt_immutable,NotificationReceipt_no_truncate,NotificationReceipt_viewer_standing');
        // the guards stand in the restored database: a stranger is refused, and a receipt is immutable there too
        expect(() => q(`INSERT INTO "NotificationReceipt" ("notificationId","userId","projectId") VALUES ('${n}', '${f.strangerUser.id}', '${f.projectA.id}')`)).toThrow(/no standing/);
        expect(() => q(`DELETE FROM "NotificationReceipt" WHERE "notificationId" = '${n}'`)).toThrow(/may not be deleted directly/);
        expect(() => q('TRUNCATE "NotificationReceipt"')).toThrow(/never truncated/);
      } finally {
        execFileSync('psql', ['-q', '-d', admin.toString(), '-c', `DROP DATABASE IF EXISTS "${restored}" WITH (FORCE)`], { stdio: 'pipe' });
      }
    });

    it('keeps the previous release\'s notice shapes: an insert naming no new column, a receipt-free move and delete', async () => {
      const id = `rc-prev-${run}`;
      await t.prisma.$executeRaw`INSERT INTO "Notification" ("id","projectId","text","color","time") VALUES (${id}, ${f.projectA.id}, 'previous release', '#000', 'just now')`;
      await t.prisma.$executeRaw`UPDATE "Notification" SET "projectId" = ${f.projectB.id} WHERE "id" = ${id}`;
      await t.prisma.$executeRaw`DELETE FROM "Notification" WHERE "id" = ${id}`;
      expect(await t.prisma.notification.count({ where: { id } })).toBe(0);
    });
  });
});
