import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * Phase 6 task 4b — the decision-workflow decider model (server arms, live PG).
 *
 * §A.1 the decider model (client/pmc/member/none; the named member's ACTIVE standing; the holder
 * write-once FROM PUBLICATION; the approve ceiling narrowed to the actual decider; the
 * holder-orphan guards at BOTH layers), §A.2 the record-only issue (`none` ⟺ `recorded`; exactly
 * zero options; born terminal; the recorded gate arm), §A.3 the audience-follows-decider server
 * arms (visibility, bell stripping, viewer-scoped countPending, the targeted push intent + the
 * decider family's claim predicate). Probes P16–P18, P39 and the server halves of P20/P21/P22.
 *
 * Every fixture write follows the RE-ORDERED create the seals enforce (unpublished birth →
 * options → same-tx publication) or goes through the real HTTP commands; hostile arms are raw
 * SQL expected to be REFUSED by the DB seal network the 20271015 migration installs.
 */
describe('Phase 6 task 4b — decider model + record-only + audience (live PG)', () => {
  let t: TestApp;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4bd-${label}-${run}`;

  const orgId = id('org');
  const projectId = id('proj');
  // a SECOND project whose org-admin arm the org-write guard probes
  const orgBId = id('orgb');
  const projectBId = id('projb');

  const users = {
    pmc: id('pmc'),
    client: id('client'),
    engA: id('enga'),
    engB: id('engb'),
    orgOwner: id('owner'),
    orgAdmin: id('admin'),
  };
  const membership: Record<string, string> = {};
  let pmcToken = '';
  let clientToken = '';
  let engAToken = '';
  let engBToken = '';

  const http = () => request(t.app.getHttpServer());
  const post = (token: string) => (path: string, body: object = {}) =>
    http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (token: string) => (path: string, body: object = {}) =>
    http().patch(path).set('Authorization', `Bearer ${token}`).send(body);

  const twoOptions = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  /** Issue a decision through the REAL command; returns the created decision id. */
  const issue = async (body: Record<string, unknown>, expectStatus = 201): Promise<string> => {
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, {
      title: `T ${randomUUID().slice(0, 6)}`,
      room: 'Kitchen',
      options: twoOptions,
      publish: true,
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
    if (expectStatus !== 201) return '';
    const row = await t.prisma.decision.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    return row.id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma.org.create({ data: { id: orgId, name: `T4BD ${run}`, slug: orgId } });
    await t.prisma.org.create({ data: { id: orgBId, name: `T4BD B ${run}`, slug: orgBId } });
    const projectData = (pid: string, oid: string) => ({
      id: pid, orgId: oid, name: pid, short: 'T4BD', descriptor: '', stage: 'Planning', siteCode: pid.slice(-8),
      projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    });
    await t.prisma.project.create({ data: projectData(projectId, orgId) });
    await t.prisma.project.create({ data: projectData(projectBId, orgBId) });
    for (const [key, uid] of Object.entries(users)) {
      await t.prisma.user.create({ data: { id: uid, projectId, role: key.startsWith('eng') ? 'engineer' : key === 'client' ? 'client' : 'pmc', name: `U ${key}`, email: `${uid}@t.local` } });
    }
    for (const [key, role] of [['pmc', 'pmc'], ['client', 'client'], ['engA', 'engineer'], ['engB', 'engineer']] as const) {
      const m = await t.prisma.membership.create({ data: { projectId, userId: users[key], role, status: 'active' } });
      membership[key] = m.id;
    }
    // org roster: an owner (the caller) and an admin (the membership-less effective PMC of project B)
    await t.prisma.orgMembership.create({ data: { orgId, userId: users.orgOwner, role: 'owner' } });
    await t.prisma.orgMembership.create({ data: { orgId: orgBId, userId: users.orgOwner, role: 'owner' } });
    await t.prisma.orgMembership.create({ data: { orgId: orgBId, userId: users.orgAdmin, role: 'admin' } });
    pmcToken = t.issueProjectToken(users.pmc, projectId, 'pmc');
    clientToken = t.issueProjectToken(users.client, projectId, 'client');
    engAToken = t.issueProjectToken(users.engA, projectId, 'engineer');
    engBToken = t.issueProjectToken(users.engB, projectId, 'engineer');
  });

  afterAll(async () => {
    // the sanctioned destructive reset: decisions carry append-only registers + delete seals
    await t?.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER USER'),
      t.prisma.decisionApprovalRevision.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.activity.deleteMany({ where: { projectId } }),
      t.prisma.decision.deleteMany({ where: { projectId } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
    ]);
    // the fixture-cleanup discipline (fixtures.ts): append-only platform tables truncate, then
    // reverse-FK-order deletes so a failed test never strands rows for the next suite
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor" CASCADE');
    await t?.prisma.$transaction([
      t.prisma.commandExecution.deleteMany({ where: { OR: [{ projectId: { in: [projectId, projectBId] } }, { organizationId: { in: [orgId, orgBId] } }] } }),
      t.prisma.auditLog.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.notification.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.membership.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.orgMembership.deleteMany({ where: { orgId: { in: [orgId, orgBId] } } }),
      t.prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } }),
      t.prisma.project.deleteMany({ where: { id: { in: [projectId, projectBId] } } }),
      t.prisma.org.deleteMany({ where: { id: { in: [orgId, orgBId] } } }),
    ]);
    await t?.close();
  });

  // ── P16 — §A.2 the record-only issue ───────────────────────────────────────────────────────

  it('P16: a `none` issue is born a PUBLISHED terminal record — zero options, "Issue recorded" notice, no push, nothing approvable', async () => {
    const did = await issue({ deciderKind: 'none', options: [] });
    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id: did }, include: { options: true } });
    expect(d.status).toBe('recorded');
    expect(d.publishedAt).not.toBeNull();
    expect(d.deciderKind).toBe('none');
    expect(d.options).toHaveLength(0);
    expect(d.photoSwatch).toBeNull();

    // the announcement is a team record, deliberately NOT a pending-approval shape
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { projectId, decisionId: did } });
    expect(notice.text.startsWith('Issue recorded')).toBe(true);

    // the published event carries NO push intent — a record demands nothing of anyone
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId, entityId: did, eventType: 'decision.published' } });
    expect((ev.dispatchIntent as { push?: unknown })?.push).toBeUndefined();

    // approvable by NOBODY — a deliberate 409, never the terminal trigger
    const approve = await post(clientToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 });
    expect(approve.status).toBe(409);
  });

  it('P16: the contract refuses an optioned record and an optionless choice (exactly-zero / 2-4 floors)', async () => {
    await issue({ deciderKind: 'none', options: twoOptions }, 400);
    await issue({ deciderKind: 'client', options: [] }, 400);
    await issue({ deciderKind: 'member', options: twoOptions }, 400); // member without its membership id
  });

  it('P16 (DB): a published record with a planted option cannot COMMIT, and a published record is frozen (no edit, no delete)', async () => {
    // hostile: one transaction inserts a published record AND an option — the deferred
    // exactly-zero floor refuses the commit
    await expect(
      t.prisma.$transaction([
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "Decision" ("id","projectId","title","room","status","ageDays","authorId","deciderKind","publishedAt")
           VALUES ('${id('hr1')}','${projectId}','H','R','recorded',0,'${users.pmc}','none',now())`,
        ),
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","recommended","order")
           VALUES ('${id('hro')}','${id('hr1')}','A','a','M',0,'sw',false,0)`,
        ),
      ]),
    ).rejects.toThrow(/record takes no options|published/i);

    const did = await issue({ deciderKind: 'none', options: [] });
    // published-record evidence freeze: the title is part of the permanent entry
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "title" = 'edited' WHERE "id" = '${did}'`),
    ).rejects.toThrow(/frozen|record|published/i);
    // and a published record row is permanent — DELETE refused
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" = '${did}'`),
    ).rejects.toThrow(/permanent|record|delete/i);
  });

  it('P16/P18 (ordering): planting approval evidence on a pending draft and THEN converting it to a record is refused', async () => {
    // a private pending draft
    const draftRes = await post(pmcToken)(`/projects/${projectId}/decisions`, {
      title: 'Plant-then-convert', room: 'K', options: twoOptions, publish: false,
    });
    expect(draftRes.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: 'Plant-then-convert' } });
    // plant an approval-shaped DecisionEvent while the head is still 'pending' (no reverse seal fires)
    await t.prisma.decisionEvent.create({ data: { decisionId: d.id, type: 'approved', actor: 'X', actorName: 'X', actorRole: 'pmc' } });
    // the ENTRY into `recorded` verifies zero approval children — the conversion is refused
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "deciderKind" = 'none', "status" = 'recorded', "photoSwatch" = NULL WHERE "id" = '${d.id}'`),
    ).rejects.toThrow(/approval/i);
  });

  it('P16/P20: updateDraft converts a draft to a record (options shed in the SAME edit) and back; a published decision refuses the door', async () => {
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: 'Convertible', room: 'K', options: twoOptions, publish: false });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: 'Convertible' } });

    // converting WITHOUT shedding options names the fix
    const keepOpts = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'none' });
    expect(keepOpts.status).toBe(400);
    expect(keepOpts.body.message).toContain('options: []');

    // the coherent pair: kind + status + options move together
    const conv = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'none', options: [] });
    expect(conv.status).toBe(200);
    const asRecord = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id }, include: { options: true } });
    expect(asRecord.status).toBe('recorded');
    expect(asRecord.options).toHaveLength(0);

    // back to a choice (recorded → pending is the ONE unpublished door)
    const back = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'client', options: twoOptions });
    expect(back.status).toBe(200);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('pending');

    // publication freezes the holder: the draft door closes
    expect((await post(pmcToken)(`/projects/${projectId}/decisions/${d.id}/publish`)).status).toBe(201);
    const closed = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'pmc' });
    expect(closed.status).toBe(409);
    // settle the obligation so later audience/count probes start from a clean register
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
  });

  // ── P17 — §A.1 the decider model on the approve path ───────────────────────────────────────

  it('P17: a NAMED member-decider approves; a same-role non-decider and the client are refused; the PMC acts on-behalf, recorded', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: membership.engA });

    // the same-role NON-decider is not the decider — 403 at the command, whatever the route admits
    expect((await post(engBToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(403);
    // the client no longer decides a decision they do not hold
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(403);

    // the named decider approves — direct, no on-behalf marker
    expect((await post(engAToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    const approved = await t.prisma.decision.findUniqueOrThrow({ where: { id: did } });
    expect(approved.status).toBe('approved');
    expect(approved.onBehalfOf).toBeNull();

    // the PMC approves ON BEHALF of a member-held decision — attributed, never disguised
    const did2 = await issue({ deciderKind: 'member', deciderMembershipId: membership.engA });
    expect((await post(pmcToken)(`/projects/${projectId}/decisions/${did2}/approve`, { optionIndex: 0 })).status).toBe(201);
    const onBehalf = await t.prisma.decision.findUniqueOrThrow({ where: { id: did2 } });
    expect(onBehalf.onBehalfOf).toBe('member');
  });

  it('P17: a pmc-held decision is decided by the pmc role, and a client-held one keeps the pre-4b audience byte-identically', async () => {
    const pmcHeld = await issue({ deciderKind: 'pmc' });
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${pmcHeld}/approve`, { optionIndex: 0 })).status).toBe(403);
    expect((await post(pmcToken)(`/projects/${projectId}/decisions/${pmcHeld}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: pmcHeld } })).onBehalfOf).toBeNull();

    const clientHeld = await issue({}); // deciderKind defaults to 'client'
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: clientHeld } })).deciderKind).toBe('client');
    expect((await post(engAToken)(`/projects/${projectId}/decisions/${clientHeld}/approve`, { optionIndex: 0 })).status).toBe(403);
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${clientHeld}/approve`, { optionIndex: 0 })).status).toBe(201);
  });

  it('P17 (DB): the frozen holder — a direct decider re-point on a PUBLISHED decision is refused', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: membership.engA });
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "deciderKind" = 'client', "deciderMembershipId" = NULL WHERE "id" = '${did}'`),
    ).rejects.toThrow(/holder|frozen|publication/i);
  });

  it('P17: publishing a stranded draft (named member no longer active) refuses and NAMES the draft-edit door', async () => {
    // a temporary member the draft names, revoked while the draft is still private
    const tempUser = id('temp');
    await t.prisma.user.create({ data: { id: tempUser, projectId, role: 'engineer', name: 'Temp', email: `${tempUser}@t.local` } });
    const tempM = await t.prisma.membership.create({ data: { projectId, userId: tempUser, role: 'engineer', status: 'active' } });
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, {
      title: 'Stranded draft', room: 'K', options: twoOptions, publish: false, deciderKind: 'member', deciderMembershipId: tempM.id,
    });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: 'Stranded draft' } });

    // P39's DRAFT arm: a private draft naming the member does NOT block their removal
    const remove = await http().delete(`/projects/${projectId}/members/${tempUser}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(remove.status).toBe(200);

    // publication re-validates the holder — refused, with the fix by name
    const pub = await post(pmcToken)(`/projects/${projectId}/decisions/${d.id}/publish`);
    expect(pub.status).toBe(409);
    expect(pub.body.message).toContain('updateDraft');

    // the stranded draft is fixed by editing its holder — then it publishes
    expect((await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'member', deciderMembershipId: membership.engA })).status).toBe(200);
    expect((await post(pmcToken)(`/projects/${projectId}/decisions/${d.id}/publish`)).status).toBe(201);
    // leave no open obligation behind for later probes
    expect((await post(engAToken)(`/projects/${projectId}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    await t.prisma.user.deleteMany({ where: { id: tempUser } });
  });

  // ── P39 — the holder-orphan guard, BOTH designations, BOTH layers ──────────────────────────

  it('P39: removing the NAMED decider of a published open decision is refused at the command AND at the database; approval releases them', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: membership.engB });

    // command layer: 409
    const remove = await http().delete(`/projects/${projectId}/members/${users.engB}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(remove.status).toBe(409);

    // DB layer: the hostile DIRECT soft-removal is refused by the orgs-owned membership seal
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = '${membership.engB}'`),
    ).rejects.toThrow(/decider|holder|open decision/i);

    // the register's answer: the act closes the obligation, then the member may leave
    expect((await post(engBToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    const removeNow = await http().delete(`/projects/${projectId}/members/${users.engB}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(removeNow.status).toBe(200);
    // restore for later probes
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Membership" DISABLE TRIGGER USER'),
      t.prisma.membership.update({ where: { id: membership.engB }, data: { status: 'active' } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Membership" ENABLE TRIGGER USER'),
    ]);
  });

  it('P39: removing or re-roling the LAST holder of a ROLE named by an open decision is refused; a non-holder still leaves', async () => {
    const did = await issue({}); // client-held, published pending — users.client is the LAST active client

    const remove = await http().delete(`/projects/${projectId}/members/${users.client}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(remove.status).toBe(409);
    const rerole = await patch(pmcToken)(`/projects/${projectId}/members/${users.client}`, { role: 'engineer' });
    expect(rerole.status).toBe(409);

    // a NON-holder member (engineer; no engineer-held open decision here) still removes cleanly
    const removeEng = await http().delete(`/projects/${projectId}/members/${users.engB}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(removeEng.status).toBe(200);
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Membership" DISABLE TRIGGER USER'),
      t.prisma.membership.update({ where: { id: membership.engB }, data: { status: 'active' } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Membership" ENABLE TRIGGER USER'),
    ]);

    // close the obligation so later probes start clean
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
  });

  it('P39 (org arm): demoting the LAST effective PMC (a membership-less org admin) while a pmc-held decision is open is refused at both layers', async () => {
    // project B: no explicit memberships at all — users.orgAdmin's admin row is the ONLY pmc standing
    const adminToken = t.issueOrgOwnerToken(users.orgAdmin, projectBId, orgBId);
    const res = await post(adminToken)(`/projects/${projectBId}/decisions`, {
      title: 'PMC-held on B', room: 'K', options: twoOptions, publish: true, deciderKind: 'pmc',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: projectBId } });

    const ownerToken = t.issueProjectToken(users.orgOwner, projectBId, 'pmc');
    // command layer: the org-membership write walks every covered project
    const demote = await patch(ownerToken)(`/orgs/${orgBId}/members/${users.orgAdmin}`, { role: 'member' });
    expect(demote.status).toBe(409);
    const removeAdmin = await http().delete(`/orgs/${orgBId}/members/${users.orgAdmin}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(removeAdmin.status).toBe(409);

    // DB layer: the hostile DIRECT demotion is refused by the org-membership seal
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "OrgMembership" SET "role" = 'member' WHERE "orgId" = '${orgBId}' AND "userId" = '${users.orgAdmin}'`),
    ).rejects.toThrow(/pmc|holder|effective/i);

    // P39 activation-displacement arm: an explicit NON-pmc membership for the same user would
    // re-classify them by precedence and orphan the pmc holder — refused
    const addClient = await post(ownerToken)(`/projects/${projectBId}/members`, { name: 'U admin', email: `${users.orgAdmin}@t.local`, role: 'client' });
    expect(addClient.status).toBe(409);

    // approve (as the effective pmc) to release the hold, then the demotion lands
    expect((await post(adminToken)(`/projects/${projectBId}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await patch(ownerToken)(`/orgs/${orgBId}/members/${users.orgAdmin}`, { role: 'member' })).status).toBe(200);
    // restore the admin arm for any later probe
    await t.prisma.orgMembership.update({ where: { orgId_userId: { orgId: orgBId, userId: users.orgAdmin } }, data: { role: 'admin' } });
  });

  it('P39 (birth arm): publishing a role-held decision into a project with NO active holder of that role is refused', async () => {
    // project B has no client at all — a client-held publish would birth the zero-holder state
    const adminToken = t.issueOrgOwnerToken(users.orgAdmin, projectBId, orgBId);
    const res = await post(adminToken)(`/projects/${projectBId}/decisions`, {
      title: 'No client here', room: 'K', options: twoOptions, publish: true, deciderKind: 'client',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('client');
  });

  // ── P21/P22 server arms — the audience follows the decider ─────────────────────────────────

  it('P22: visibility + bell + viewer-scoped countPending distinguish the named decider from a same-role non-decider (projection path included)', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: membership.engA });
    const query = t.app.get(DecisionsQueryService);
    const snapshot = t.app.get(SnapshotService);

    // the named decider sees the pending row; the same-role non-decider does not; the client does not
    const forDecider = await query.snapshotSlice(projectId, 'engineer', users.engA);
    const forOther = await query.snapshotSlice(projectId, 'engineer', users.engB);
    const forClient = await query.snapshotSlice(projectId, 'client', users.client);
    expect(forDecider.decisions.map((d) => d.id)).toContain(did);
    expect(forOther.decisions.map((d) => d.id)).not.toContain(did);
    expect(forClient.decisions.map((d) => d.id)).not.toContain(did);
    // the dto carries the RESOLVED decider user, the one value every predicate compares
    expect(forDecider.decisions.find((d) => d.id === did)?.deciderUserId).toBe(users.engA);

    // the bell notice follows the same audience
    const bellDecider = await snapshot.build(projectId, 'engineer', users.engA);
    const bellOther = await snapshot.build(projectId, 'engineer', users.engB);
    const bellClient = await snapshot.build(projectId, 'client', users.client);
    const isForThis = (n: { text: string }) => n.text.startsWith('Decision awaiting approval');
    expect(bellDecider.notifications.some(isForThis)).toBe(true);
    expect(bellOther.notifications.some(isForThis)).toBe(false);
    expect(bellClient.notifications.some(isForThis)).toBe(false);

    // countPending counts the decisions THAT VIEWER decides (pmc seeing all)
    expect(await query.countPending(projectId, { role: 'engineer', userId: users.engA })).toBe(1);
    expect(await query.countPending(projectId, { role: 'engineer', userId: users.engB })).toBe(0);
    expect(await query.countPending(projectId, { role: 'client', userId: users.client })).toBe(0);
    expect(await query.countPending(projectId, { role: 'pmc', userId: users.pmc })).toBe(1);

    // release the obligation
    expect((await post(engAToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
  });

  it('P21 (server half): the published intent TARGETS the named decider, and the claim-time family predicate re-judges it', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: membership.engA });

    // the persisted push intent narrows to the decider: their role + their USER
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId, entityId: did, eventType: 'decision.published' } });
    const push = (ev.dispatchIntent as { push?: { roles?: string[]; targetUserId?: string } }).push;
    expect(push?.roles).toEqual(['engineer']);
    expect(push?.targetUserId).toBe(users.engA);

    // claim-time: still the holder, still demanded → actionable at the target user
    const query = t.app.get(DecisionsQueryService);
    expect(await query.deciderPushTarget(projectId, did)).toEqual({ actionable: true, targetUserId: users.engA });

    // the status ceasing to demand a decision drops the push (never a stale "decide this")
    expect((await post(engAToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect(await query.deciderPushTarget(projectId, did)).toEqual({ actionable: false });

    // a role-held decision claims at its role, and a record at nobody
    const clientHeld = await issue({});
    expect(await query.deciderPushTarget(projectId, clientHeld)).toEqual({ actionable: true, roles: ['client'] });
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${clientHeld}/approve`, { optionIndex: 0 })).status).toBe(201);
    const record = await issue({ deciderKind: 'none', options: [] });
    expect(await query.deciderPushTarget(projectId, record)).toEqual({ actionable: false });
  });

  // ── P20 — the recorded gate arm ────────────────────────────────────────────────────────────

  it('P20: an activity linked to a DRAFT record refuses to start (wait — publish it); the PUBLISHED record gates na and the start lands', async () => {
    // a private draft record
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: 'Gate record', room: 'K', options: [], publish: false, deciderKind: 'none' });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: 'Gate record' } });
    const actId = id('act');
    await t.prisma.activity.create({
      data: { id: actId, projectId, name: 'Gated work', zone: 'Z', plannedStart: 0, plannedEnd: 5, gateMaterial: 'ok', gateTeam: 'ok', decisionId: d.id },
    });

    const refused = await post(engAToken)(`/projects/${projectId}/activities/${actId}/start`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('unpublished');

    expect((await post(pmcToken)(`/projects/${projectId}/decisions/${d.id}/publish`)).status).toBe(201);
    const started = await post(engAToken)(`/projects/${projectId}/activities/${actId}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
  });
});
