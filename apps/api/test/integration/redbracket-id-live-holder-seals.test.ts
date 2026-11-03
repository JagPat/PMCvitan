import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';

/**
 * Redbracket ID A4b-m (20280208000000) — the database holder seals count LIVE holders.
 *
 * A retired account (an `IdentityRetirement` row) keeps its seats until the team re-seats the person, and nobody
 * can sign in as it. The delivered seals (`Membership_t4b2_holder_guard`, `OrgMembership_t4b2_holder_guard`) count
 * it, so with one live client and one retired client a direct removal of the live client passed them and left an
 * open client-held decision with nobody who can decide it (#1326, Codex 4452016264). Each arm below fails without
 * this file (the raw write commits) and passes with it.
 *
 * Every write runs in a transaction that is rolled back, so the fixture's world is the same before and after.
 */
describe('Redbracket ID A4b-m — the holder seals count live holders (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  const run = randomUUID().slice(0, 8);
  const retiredClient = `rbid-a4bm-client-${run}`;
  const retiredAdmin = `rbid-a4bm-admin-${run}`;
  const liveAdmin = `rbid-a4bm-live-admin-${run}`;
  const newClientEmail = `rbid-a4bm-new-${run}@test.local`;
  let clientMembershipId = '';
  let retiredMembershipId = '';
  let pmcMembershipId = '';

  const publish = async (deciderKind: 'client' | 'pmc') => {
    const title = `A4b-m ${deciderKind} ${run}`;
    const r = await request(t.app.getHttpServer()).post(`/projects/${f.projectA.id}/decisions`)
      .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({
        title, room: 'Kitchen', publish: true, deciderKind,
        options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ],
      });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };

  const retire = (tx: Prisma.TransactionClient, userId: string) =>
    tx.$executeRawUnsafe(`INSERT INTO "IdentityRetirement" ("userId", "email") SELECT "id", "email" FROM "User" WHERE "id" = $1`, userId);

  /** Runs `body` in a transaction that is always rolled back; returns the error the last statement raised, if any. */
  const rolledBack = async (body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<string | null> => {
    const sentinel = new Error('rollback');
    let raised: string | null = null;
    await expect(t.prisma.$transaction(async (tx) => {
      try {
        await body(tx);
      } catch (e) {
        raised = e instanceof Error ? e.message : String(e);
      }
      throw sentinel;
    })).rejects.toBe(sentinel);
    return raised;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await t.prisma.user.create({ data: { id: retiredClient, projectId: f.projectA.id, role: 'client', name: 'A4b-m retired client', email: `${retiredClient}@test.local` } });
    await t.prisma.user.create({ data: { id: liveAdmin, projectId: f.projectA.id, role: 'pmc', name: 'A4b-m live admin', email: `${liveAdmin}@test.local` } });
    await t.prisma.user.create({ data: { id: retiredAdmin, projectId: f.projectA.id, role: 'pmc', name: 'A4b-m retired admin', email: `${retiredAdmin}@test.local` } });
    retiredMembershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: retiredClient, role: 'client', status: 'active' } })).id;
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: retiredAdmin, role: 'admin' } });
    await t.prisma.$executeRawUnsafe(`INSERT INTO "IdentityRetirement" ("userId", "email") SELECT "id", "email" FROM "User" WHERE "id" IN ($1, $2)`, retiredClient, retiredAdmin);
    clientMembershipId = (await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } })).id;
    pmcMembershipId = (await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.memberUser.id } })).id;
    await publish('client');
    await publish('pmc');
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    const extra = [retiredClient, retiredAdmin, liveAdmin,
      ...(await t.prisma.user.findMany({ where: { email: newClientEmail }, select: { id: true } })).map((u) => u.id)];
    await wipeMembershipTransitionsVia(t.prisma, [...extra, f.clientUser.id, f.memberUser.id, f.ownerUser.id]);
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    // the seats go before the users: a retired user's delete is judged as a live write once its retirement row has
    // cascaded away (the migration's note), so no seat may be left for it to judge
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.orgMembership.deleteMany({ where: { userId: { in: extra } } });
    await t.prisma.user.deleteMany({ where: { id: { in: extra } } }); // cascades the retirement rows
    await f?.cleanup();
    await t?.close();
  });

  it('the seals are installed, with fixed search paths, and fire after the delivered ones', async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ tbl: string; tgname: string }>>(
      `SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgname LIKE '%\\_x\\_live\\_holder\\_guard' ORDER BY 1`);
    expect(rows).toEqual([
      { tbl: 'Membership', tgname: 'Membership_x_live_holder_guard' },
      { tbl: 'OrgMembership', tgname: 'OrgMembership_x_live_holder_guard' },
    ]);
    expect(['Membership_t4b2_holder_guard', 'Membership_t4d_holder_guard'].every((n) => n < 'Membership_x_live_holder_guard')).toBe(true);
    expect('OrgMembership_t4b2_holder_guard' < 'OrgMembership_x_live_holder_guard').toBe(true);
    const fns = await t.prisma.$queryRawUnsafe<Array<{ proname: string; cfg: string[] | null }>>(
      `SELECT p.proname, p.proconfig AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('platform_user_retired', 'phase6_live_role_standing', 'phase6_live_role_held',
          'phase6_live_holder_membership_guard', 'phase6_live_holder_org_membership_guard') ORDER BY 1`);
    expect(fns.map((x) => x.proname)).toHaveLength(5);
    for (const fn of fns) expect(fn.cfg, fn.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
  });

  it('the live count leaves out a retired holder; the effective count still includes it', async () => {
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ eff: bigint; live: bigint; pmcEff: bigint; pmcLive: bigint }>>(
      `SELECT phase6_effective_role_standing($1, 'client') AS eff, phase6_live_role_standing($1, 'client') AS live,
              phase6_effective_role_standing($1, 'pmc') AS "pmcEff", phase6_live_role_standing($1, 'pmc') AS "pmcLive"`, f.projectA.id);
    // client: the fixture's client + the retired client; pmc: memberUser + ownerUser (org owner) + the retired org admin
    expect([Number(row.eff), Number(row.live), Number(row.pmcEff), Number(row.pmcLive)]).toEqual([2, 1, 3, 2]);
  });

  it('a direct removal or re-role of the last LIVE client is refused while a retired client keeps the raw count at one', async () => {
    const removed = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, clientMembershipId).then(() => undefined));
    expect(removed).toMatch(/phase6-4b: this change leaves NO live client holder while a published open decision is held by that role/);
    const reRoled = await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE "Membership" SET "role" = 'engineer' WHERE "id" = $1`, clientMembershipId).then(() => undefined));
    expect(reRoled).toMatch(/NO live client holder/);
  });

  it('removing a RETIRED row is never refused by this seal, even when no live holder is left (not this write\'s shortfall)', async () => {
    // a live client present: the re-seat's last step
    expect(await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, retiredMembershipId).then(() => undefined))).toBeNull();
    // no live client at all (the fixture's client retired too), a second retired client left: the delivered seal sees
    // one effective holder and passes; this seal does not judge a retired user's write
    const second = `rbid-a4bm-client2-${run}`;
    expect(await rolledBack(async (tx) => {
      await tx.user.create({ data: { id: second, projectId: f.projectA.id, role: 'client', name: 'A4b-m second', email: `${second}@test.local` } });
      await tx.membership.create({ data: { projectId: f.projectA.id, userId: second, role: 'client', status: 'active' } });
      await retire(tx, second);
      await retire(tx, f.clientUser.id);
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, retiredMembershipId);
    })).toBeNull();
  });

  it('a zero EFFECTIVE count stays the delivered seal\'s refusal, with its own message', async () => {
    const raised = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, retiredMembershipId);
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, clientMembershipId);
    });
    expect(raised).toMatch(/NO effective client holder/);
  });

  it('a direct demotion of the last LIVE org owner arm is refused while a retired org admin keeps the raw pmc count up', async () => {
    const raised = await rolledBack(async (tx) => {
      // memberUser's explicit pmc seat goes first (ownerUser's org arm is still live), then the owner arm itself
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, pmcMembershipId);
      await tx.$executeRawUnsafe(`UPDATE "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, f.ownerUser.id);
    });
    expect(raised).toMatch(new RegExp(`phase6-4b: this change leaves project ${f.projectA.id} with NO live pmc while a published open decision is pmc-held`));
    // the explicit pmc seat on its own was not refused: the org owner arm was still live
    expect(await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, pmcMembershipId).then(() => undefined))).toBeNull();
    // and the retired org admin's own demotion is never judged here
    expect(await rolledBack((tx) => tx.$executeRawUnsafe(`UPDATE "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, retiredAdmin).then(() => undefined))).toBeNull();
  });

  it('an activation that suppresses the last live org arm is refused while only a retired org admin is left', async () => {
    const raised = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, pmcMembershipId);
      // ownerUser takes an explicit engineer seat: explicit membership wins, so their org-PMC arm no longer counts
      await tx.membership.create({ data: { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' } });
    });
    expect(raised).toMatch(/NO live pmc holder while a published open decision is held by that role/);
  });

  it('a hard DELETE, a multi-row statement and an org-membership DELETE meet the same refusal', async () => {
    // hard DELETE of the last live client's row
    expect(await rolledBack((tx) => tx.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "id" = $1`, clientMembershipId).then(() => undefined)))
      .toMatch(/NO live client holder/);
    // one statement removing two live clients: each row is judged on the end-of-statement state
    const second = `rbid-a4bm-live2-${run}`;
    expect(await rolledBack(async (tx) => {
      await tx.user.create({ data: { id: second, projectId: f.projectA.id, role: 'client', name: 'A4b-m live 2', email: `${second}@test.local` } });
      const m = await tx.membership.create({ data: { projectId: f.projectA.id, userId: second, role: 'client', status: 'active' } });
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" IN ($1, $2)`, clientMembershipId, m.id);
    })).toMatch(/NO live client holder/);
    // an org-membership DELETE of the last live owner arm
    expect(await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, pmcMembershipId);
      await tx.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, f.ownerUser.id);
    })).toMatch(/NO live pmc while a published open decision is pmc-held/);
  });

  it('the org trigger never judges a RETIRED arm\'s loss, even with no live pmc left', async () => {
    // memberUser's seat goes while the owner arm is live, then the owner is retired: live pmc 0, effective 2 (owner +
    // retired admin). Demoting or deleting the retired admin's arm is not this write's shortfall.
    for (const write of [
      `UPDATE "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`,
      `DELETE FROM "OrgMembership" WHERE "orgId" = $1 AND "userId" = $2`,
    ]) {
      expect(await rolledBack(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, pmcMembershipId);
        await retire(tx, f.ownerUser.id);
        await tx.$executeRawUnsafe(write, f.orgA.id, retiredAdmin);
      }), write).toBeNull();
    }
  });

  it('an activation by a RETIRED org admin is never judged, even with no live pmc left', async () => {
    expect(await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, pmcMembershipId);
      await retire(tx, f.ownerUser.id);
      // the retired admin's explicit seat suppresses their (already not live) org arm: live pmc stays 0, effective 2 -> 1
      await tx.membership.create({ data: { projectId: f.projectA.id, userId: retiredAdmin, role: 'engineer', status: 'active' } });
    })).toBeNull();
  });

  it('deleting a RETIRED user is judged as a live write once the cascade removes its retirement row (fail closed)', async () => {
    // The retirement record goes only with its user (ON DELETE CASCADE), and the cascade can remove it before the
    // membership trigger reads it. With only retired client holders left, the delete is refused; no deployed path
    // deletes a user, and the re-seat ends the seats first. A missing user row is NOT treated as not live: that would
    // let a live user's hard delete leave a decision to retired holders alone.
    const second = `rbid-a4bm-gone-${run}`;
    const raised = await rolledBack(async (tx) => {
      await tx.user.create({ data: { id: second, projectId: f.projectA.id, role: 'client', name: 'A4b-m gone', email: `${second}@test.local` } });
      await tx.membership.create({ data: { projectId: f.projectA.id, userId: second, role: 'client', status: 'active' } });
      await retire(tx, second);
      await retire(tx, f.clientUser.id);
      await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, second);
    });
    expect(raised).toMatch(/NO live client holder/);
    // with the seat ended first (the re-seat order), the same delete passes
    expect(await rolledBack(async (tx) => {
      await tx.user.create({ data: { id: second, projectId: f.projectA.id, role: 'client', name: 'A4b-m gone', email: `${second}@test.local` } });
      const m = await tx.membership.create({ data: { projectId: f.projectA.id, userId: second, role: 'client', status: 'active' } });
      await retire(tx, second);
      await retire(tx, f.clientUser.id);
      await tx.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, m.id);
      await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, second);
    })).toBeNull();
  });

  // last: without the seal the command commits the removal, which would change every arm after it
  it('the member command meets the seal as a 409, never a raw error', async () => {
    const r = await request(t.app.getHttpServer()).delete(`/projects/${f.projectA.id}/members/${f.clientUser.id}`)
      .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID());
    expect(r.status, r.text).toBe(409);
    expect((await t.prisma.membership.findUniqueOrThrow({ where: { id: clientMembershipId } })).status).toBe('active');
  });
  it('the org commands meet the seal as a 409, never a raw error', async () => {
    // liveAdmin is the only live pmc: the owner's arm is suppressed by an explicit engineer seat, memberUser's seat ended
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: liveAdmin, role: 'admin' } });
    const ownerSeat = await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' } });
    await t.prisma.membership.update({ where: { id: pmcMembershipId }, data: { status: 'removed' } });
    const ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const removed = await request(t.app.getHttpServer()).delete(`/orgs/${f.orgA.id}/members/${liveAdmin}`).set('Authorization', `Bearer ${ownerToken}`);
    const demoted = await request(t.app.getHttpServer()).patch(`/orgs/${f.orgA.id}/members/${liveAdmin}`).set('Authorization', `Bearer ${ownerToken}`).send({ role: 'member' });
    const still = await t.prisma.orgMembership.findFirst({ where: { orgId: f.orgA.id, userId: liveAdmin } });
    await t.prisma.membership.update({ where: { id: pmcMembershipId }, data: { status: 'active' } });
    await t.prisma.membership.delete({ where: { id: ownerSeat.id } });
    await t.prisma.orgMembership.delete({ where: { orgId_userId: { orgId: f.orgA.id, userId: liveAdmin } } });
    expect(removed.status, removed.text).toBe(409);
    expect(demoted.status, demoted.text).toBe(409);
    expect(still?.role).toBe('admin');
  });

  it('the re-seat through the commands passes when the ONLY client holders are retired: add the new account, then remove the old rows', async () => {
    await retire(t.prisma as unknown as Prisma.TransactionClient, f.clientUser.id); // live client 0, effective 2
    const add = await request(t.app.getHttpServer()).post(`/projects/${f.projectA.id}/members`)
      .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: 'A4b-m new client', role: 'client', email: newClientEmail });
    expect(add.status, add.text).toBe(201);
    for (const userId of [f.clientUser.id, retiredClient]) {
      const rm = await request(t.app.getHttpServer()).delete(`/projects/${f.projectA.id}/members/${userId}`)
        .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID());
      expect(rm.status, rm.text).toBe(200);
    }
  });
});
