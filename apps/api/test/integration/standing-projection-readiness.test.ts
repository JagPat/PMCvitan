import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeMembershipTransitionsVia } from './fixtures';
import { readinessLockKey } from '../../src/common/readiness-lock';

/**
 * #1100 — a direct write that changes who holds a role on a project is refused while that project's readiness key
 * is held elsewhere (20280120_standing_projection_readiness), against live PostgreSQL.
 *
 * A holder transaction H takes the project's readiness key, as every decision command does first. While H holds it:
 * 1. a raw `INSERT INTO "Membership"` that would add a holder is refused, and nothing is written;
 * 2. a raw membership removal of a holder is refused, and the holder stays;
 * 3. a raw write that changes no holder (a discipline edit) goes through. (A direct "OrgMembership" write was
 *    already refused under a contended key by 20271015's org-membership guard, before this file.)
 * 4. the same raw insert, once H has released the key, goes through and projects the holder.
 * 5. Every app writer holds the key itself, so the function's try-lock is re-entrant there: a member add, re-role
 *    and removal, and an org admin promotion, all answer as before.
 * 6. The installed body is this file's: a replay of 20271220 must not leave the unguarded body in place.
 * 7. A raw insert over a standing row that a key-holding transaction is deleting is decided after that delete
 *    commits, not from a snapshot that still shows the row: it adds the holder WITH the key (the re-check's probe E).
 *
 * Isolated automated-test fixtures only.
 */
describe('#1100 — the standing projection refuses a direct write under a foreign readiness key (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
  const http = () => request(t.app.getHttpServer());

  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** H: hold `projectId`'s readiness key until released. */
  const holdReadiness = async (projectId: string) => {
    const ready = gate(); const release = gate();
    const done = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', readinessLockKey(projectId));
      ready.open();
      await release.p;
    }, { timeout: 60_000, maxWait: 10_000 });
    await Promise.race([ready.p, done]);
    return { release: release.open, done };
  };
  const user = async (label: string) => {
    const id = `t1100-${label}-${run}`;
    extraUsers.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'engineer', name: `T1100 ${label}`, email: `${id}@test.local` } });
    return id;
  };
  const standing = (userId: string, projectId = f.projectA.id) =>
    t.prisma.$queryRawUnsafe<Array<{ role: string }>>(
      'SELECT role::text AS role FROM "ProjectUserStanding" WHERE "projectId" = $1 AND "userId" = $2 ORDER BY role', projectId, userId)
      .then((rows) => rows.map((r) => r.role));
  const rawInsert = (userId: string, role = 'engineer') =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "Membership" ("id", "projectId", "userId", "role", "status") VALUES ($1, $2, $3, $4, 'active')`,
      randomUUID(), f.projectA.id, userId, role);
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    try {
      if (t?.prisma && f) {
        await t.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
        await wipeMembershipTransitionsVia(t.prisma, [...extraUsers, f.memberUser.id]);
        await t.prisma.orgMembership.deleteMany({ where: { userId: { in: extraUsers } } });
        await t.prisma.membership.deleteMany({ where: { userId: { in: extraUsers } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: extraUsers } }, { actorUserId: { in: extraUsers } }] } });
        await t.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
      }
    } finally {
      await f?.cleanup();
      await t?.close();
    }
  });

  it('1, 4. a raw insert adding a holder is refused while another transaction holds the key, and goes through after', async () => {
    const u = await user('insert');
    const h = await holdReadiness(f.projectA.id);
    try {
      const r = await settle(rawInsert(u));
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.e).toContain('the project readiness key is held elsewhere');
      expect(await standing(u)).toEqual([]);
      expect(await t.prisma.membership.count({ where: { userId: u } })).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    await rawInsert(u);
    expect(await standing(u)).toEqual(['engineer']);
  }, 60_000);

  it('2. a raw removal of a holder is refused while another transaction holds the key, and the holder stays', async () => {
    const u = await user('remove');
    await rawInsert(u);
    const h = await holdReadiness(f.projectA.id);
    try {
      const r = await settle(t.prisma.$executeRawUnsafe(
        `UPDATE "Membership" SET "status" = 'removed' WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, u));
      expect(r.ok ? '' : r.e).toContain('the project readiness key is held elsewhere');
      expect(await standing(u)).toEqual(['engineer']);
    } finally {
      h.release();
      await h.done;
    }
  }, 60_000);

  it('3. a raw write that changes no holder goes through under a foreign key', async () => {
    const u = await user('noop');
    await rawInsert(u);
    const h = await holdReadiness(f.projectA.id);
    try {
      await t.prisma.$executeRawUnsafe(
        `UPDATE "Membership" SET "discipline" = 'civil' WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, u);
      expect(await standing(u)).toEqual(['engineer']);
    } finally {
      h.release();
      await h.done;
    }
  }, 60_000);

  it('5. the app writers hold the key themselves and answer as before: member add, re-role, removal, org admin promotion', async () => {
    const pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const email = `t1100-app-${run}@test.local`;
    const add = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmc}`).set('Idempotency-Key', randomUUID())
      .send({ name: `T1100 app ${run}`, role: 'engineer', email });
    expect(add.status, add.text).toBe(201);
    const added = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    extraUsers.push(added.id);
    expect(await standing(added.id)).toEqual(['engineer']);
    const reRole = await http().patch(`/projects/${f.projectA.id}/members/${added.id}`).set('Authorization', `Bearer ${pmc}`)
      .set('Idempotency-Key', randomUUID()).send({ role: 'contractor' });
    expect(reRole.status, reRole.text).toBe(200);
    expect(await standing(added.id)).toEqual(['contractor']);
    const gone = await http().delete(`/projects/${f.projectA.id}/members/${added.id}`).set('Authorization', `Bearer ${pmc}`).set('Idempotency-Key', randomUUID());
    expect(gone.status, gone.text).toBe(200);
    expect(await standing(added.id)).toEqual([]);

    const admin = await user('admin');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: admin, role: 'member' } });
    const owner = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const promote = await http().patch(`/orgs/${f.orgA.id}/members/${admin}`).set('Authorization', `Bearer ${owner}`).send({ role: 'admin' });
    expect(promote.status, promote.text).toBe(200);
    expect(await standing(admin)).toEqual(['pmc']);
  }, 60_000);

  it('7. a raw insert over a row a key-holding transaction is deleting adds the holder only with the key', async () => {
    const x = await user('escape');
    // X is an org admin, so X stands as pmc on project A (set up under the key, as the app roster would).
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', readinessLockKey(f.projectA.id));
      await tx.$executeRawUnsafe(`INSERT INTO "OrgMembership" ("id", "orgId", "userId", "role") VALUES ($1, $2, $3, 'admin')`,
        randomUUID(), f.orgA.id, x);
    });
    expect(await standing(x)).toEqual(['pmc']);

    // T1 holds the key and demotes X to member, which deletes X's pmc standing row. It stays open.
    const t1deleted = gate(); const t1release = gate();
    let t1pid = 0;
    const T1 = t.prisma.$transaction(async (tx) => {
      t1pid = Number((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', readinessLockKey(f.projectA.id));
      await tx.$executeRawUnsafe(`UPDATE "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, x);
      t1deleted.open();
      await t1release.p;
    }, { timeout: 60_000, maxWait: 10_000 });
    await Promise.race([t1deleted.p, T1]);

    // T2: a direct write that adds X as a pmc holder. It meets T1's deleted row and waits for T1.
    const t2inserted = gate(); const t2release = gate();
    const T2 = settle(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "projectId", "userId", "role", "status") VALUES ($1, $2, $3, 'pmc', 'active')`,
        randomUUID(), f.projectA.id, x);
      t2inserted.open();
      await t2release.p;
    }, { timeout: 60_000, maxWait: 10_000 }));
    let t2settled = false;
    void T2.then(() => { t2settled = true; });
    try {
      for (;;) {
        if (t2settled) break; // T2 did not wait for T1: asserted below
        const [{ n }] = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          'SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', t1pid);
        if (Number(n) > 0) break;
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      t1release.open();
    }
    await T1;
    const t2 = await Promise.race([t2inserted.p.then(() => null), T2]);
    try {
      expect(t2, 'the raw insert after T1 committed was refused').toBe(null);
      // While T2 is open with its new holder, a forward cannot take the readiness key: T2 holds it.
      const got = await t.prisma.$transaction(async (tx) => (await tx.$queryRawUnsafe<Array<{ got: boolean }>>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got', readinessLockKey(f.projectA.id)))[0]!.got);
      expect(got, 'a real holder add is open without the readiness key held').toBe(false);
    } finally {
      t2release.open();
    }
    expect((await T2).ok).toBe(true);
    expect(await standing(x)).toEqual(['pmc']);
  }, 60_000);

  it('6. the installed body tries the readiness key and refuses', async () => {
    const [{ src }] = await t.prisma.$queryRawUnsafe<Array<{ src: string }>>(
      `SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'platform_user_standing_apply'`);
    expect(src).toContain('phase6_try_readiness(p_project)');
    expect(src).toContain('the project readiness key is held elsewhere');
    expect(src).toMatch(/FOR UPDATE;\s*v_exists := FOUND;/);
  });
});
