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
      t.prisma.decisionApprovalRevision.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [projectId, projectBId] } } } }),
      t.prisma.activity.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [projectId, projectBId] } } }),
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
    // settle the obligation so later audience/count probes start from a clean register
    expect((await post(engAToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
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
    // the org OWNER's arm is SUPPRESSED on project B by an explicit non-pmc membership (the
    // precedence rule) — users.orgAdmin's membership-less admin row is then the ONLY effective
    // pmc standing. Inserted before any decision exists, so the activation-displacement arm of
    // the guard has nothing to judge.
    await t.prisma.membership.create({ data: { projectId: projectBId, userId: users.orgOwner, role: 'engineer', status: 'active' } });
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
    const addClient = await post(adminToken)(`/projects/${projectBId}/members`, { name: 'U admin', email: `${users.orgAdmin}@t.local`, role: 'client' });
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
    // THIS decision's notice (by title) — earlier probes' settled decisions keep their notices
    // as history for the member who decided them, exactly like the legacy client's bell
    const { title } = await t.prisma.decision.findUniqueOrThrow({ where: { id: did }, select: { title: true } });
    const isForThis = (n: { text: string }) => n.text.startsWith('Decision awaiting approval') && n.text.includes(title);
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
  // ── round-1 Codex corrections (the finding-bearing head f99634f4) ──────────────────────────

  it('R1-F3: a decision INSERTED already-published is judged by the SAME holder arms as publication — role standing included', async () => {
    // project B has NO client standing — the hostile INSERT of a published OPEN client-held row
    // previously slipped past the member-only check; it is now refused like the publish door
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "Decision"("id","projectId","title","room","status","ageDays","photoSwatch","publishedAt","deciderKind","createdAt")
         VALUES ('t4bd-f3-hostile-${run}','${projectBId}','Holderless import','K','pending',0,'sw',now(),'client',now())`,
      ),
    ).rejects.toThrow(/no active client holder/i);
    // precision: an UNPUBLISHED draft insert stays free — the new arms fire only at the
    // published door (drafts block nothing and hold nothing)
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Decision"("id","projectId","title","room","status","ageDays","photoSwatch","publishedAt","deciderKind","createdAt")
       VALUES ('t4bd-f3-draft-${run}','${projectBId}','Free draft','K','pending',0,'sw',NULL,'client',now())`,
    );
    await t.prisma.decision.deleteMany({ where: { id: `t4bd-f3-draft-${run}` } });
  });

  it('R1-F8: converting a draft whose author LOST standing into a record is refused — command AND database', async () => {
    // a temporary pmc authors a choice draft, then loses their standing
    const tempId = id('f8auth');
    await t.prisma.user.create({ data: { id: tempId, projectId, role: 'pmc', name: 'Departed PMC', email: `${tempId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId, userId: tempId, role: 'pmc', status: 'active' } });
    const tempToken = t.issueProjectToken(tempId, projectId, 'pmc');
    const res = await post(tempToken)(`/projects/${projectId}/decisions`, { title: 'Departed author draft', room: 'K', options: twoOptions, publish: false });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: 'Departed author draft' } });
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: tempId } }, data: { status: 'removed' } });

    // command layer: the one drafting door refuses the conversion with the reason
    const conv = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'none', options: [] });
    expect(conv.status).toBe(409);
    expect(conv.body.message).toContain('author');

    // DB layer: the hostile direct conversion is refused by the recorded-entry authority arm
    await t.prisma.decisionOption.deleteMany({ where: { decisionId: d.id } }); // an unpublished parent's options are deletable
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "deciderKind" = 'none', "status" = 'recorded', "photoSwatch" = NULL WHERE "id" = '${d.id}'`),
    ).rejects.toThrow(/authority/i);

    // precision: restore the author's standing and the SAME conversion lands
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: tempId } }, data: { status: 'active' } });
    const ok = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'none', options: [] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('recorded');
    // cleanup: the unpublished record draft is discardable (its drafted/draft_updated events
    // are not approval evidence); the temp identity leaves
    await t.prisma.decisionEvent.deleteMany({ where: { decisionId: d.id } });
    await t.prisma.decision.delete({ where: { id: d.id } });
    await t.prisma.membership.delete({ where: { projectId_userId: { projectId, userId: tempId } } });
    await t.prisma.user.delete({ where: { id: tempId } });
  });
  it('R2-F1: a client that has NOT declared the decisions contract never receives a recorded row — the previous bundle cannot crash on it', async () => {
    const did = await issue({ deciderKind: 'none', options: [] });
    // a 4b-aware client declares the contract and receives the full register
    const aware = await http().get(`/projects/${projectId}/snapshot`)
      .set('Authorization', `Bearer ${pmcToken}`)
      .set('X-Vitan-Decisions-Contract', 'recorded-v1');
    expect(aware.status).toBe(200);
    expect(aware.body.decisions.map((d: { id: string }) => d.id)).toContain(did);
    // the PREVIOUS bundle (no header) has the record stripped at the transport boundary —
    // its four-entry chip map is never asked to render a status it does not know
    const legacy = await http().get(`/projects/${projectId}/snapshot`).set('Authorization', `Bearer ${pmcToken}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.decisions.map((d: { id: string }) => d.id)).not.toContain(did);
    expect(legacy.body.decisions.some((d: { status: string }) => d.status === 'recorded')).toBe(false);
    // precision: every other row is untouched by the shim
    const awareIds = aware.body.decisions.filter((d: { status: string }) => d.status !== 'recorded').map((d: { id: string }) => d.id).sort();
    expect(legacy.body.decisions.map((d: { id: string }) => d.id).sort()).toEqual(awareIds);
  });

  // ── round-3 Codex corrections (the replacement head a13c3454) ──────────────────────────────

  it('R3-F2: archiving the project drops a queued decider push at claim — a demand nobody could open is cancelled, not sent', async () => {
    const did = await issue({}); // client-held, published, pending
    const query = t.app.get(DecisionsQueryService);
    expect(await query.deciderPushTarget(projectId, did)).toEqual({ actionable: true, roles: ['client'] });
    // archival keeps the decision pending and every membership intact — only the project closes
    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    try {
      expect(await query.deciderPushTarget(projectId, did)).toEqual({ actionable: false });
    } finally {
      await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    }
    // precision: un-archiving restores the claim, and the obligation is releasable
    expect(await query.deciderPushTarget(projectId, did)).toEqual({ actionable: true, roles: ['client'] });
    expect((await post(clientToken)(`/projects/${projectId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
  });

  it('R3-F3: converting a record draft to a choice WITHOUT a usable option payload is a deliberate 400, never a DB abort', async () => {
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: `R3F3 record ${run}`, room: 'K', options: [], publish: false, deciderKind: 'none' });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R3F3 record ${run}` } });
    // options OMITTED → the service's deliberate refusal (only it knows the draft's current kind)
    const bare = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'client' });
    expect(bare.status, JSON.stringify(bare.body)).toBe(400);
    expect(JSON.stringify(bare.body.message)).toContain('2–4 options');
    // an EXPLICITLY empty payload beside a choice kind → the contract half refuses
    const empty = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'client', options: [] });
    expect(empty.status).toBe(400);
    // and options planted beside `none` are refused too (the create door's rule, now on the edit door)
    const optioned = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'none', options: twoOptions });
    expect(optioned.status).toBe(400);
    // precision: the SAME conversion carrying its 2–4 options lands, lead swatch installed
    const ok = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'client', options: twoOptions });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('pending');
    expect(after.photoSwatch).toBe('sw1');
  });

  it('R3-F4: an unpublished record create and a draft→record conversion SERIALIZE behind a held readiness key instead of failing on the seal', async () => {
    // hold the project readiness key from a SECOND session, fire the command, prove it WAITS
    // (the trigger's try-acquire must never fail a valid write), release, prove it lands
    const runHeld = async (fire: () => Promise<{ status: number; body: unknown }>, expected: number) => {
      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let held!: () => void;
      const heldP = new Promise<void>((r) => { held = r; });
      const holder = t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('readiness:${projectId}', 0))`);
        held();
        await released;
      });
      await heldP;
      const cmd = fire();
      const raced = await Promise.race([
        cmd.then((r) => r.status),
        new Promise((r) => setTimeout(() => r('blocked'), 400)),
      ]);
      expect(raced, 'the command must WAIT on the readiness key, not fail on the seal').toBe('blocked');
      release();
      await holder;
      const res = await cmd;
      expect(res.status, JSON.stringify(res.body)).toBe(expected);
    };

    // the record BIRTH door with publish: false — the seal's recorded-birth arm still fires
    await runHeld(
      () => post(pmcToken)(`/projects/${projectId}/decisions`, { title: `R3F4 record ${run}`, room: 'K', options: [], publish: false, deciderKind: 'none' }),
      201,
    );

    // the draft → record CONVERSION door — the seal's conversion arm fires on entry
    const resDraft = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: `R3F4 choice ${run}`, room: 'K', options: twoOptions, publish: false });
    expect(resDraft.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R3F4 choice ${run}` } });
    await runHeld(
      () => patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'none', options: [] }),
      200,
    );
  });

  // ── round-4 Codex corrections (the replacement head 8e69603b → PR #465 lineage) ────────────

  it('R4-F1: overlapping draft edits derive the conversion from the LOCKED row — the stale-read interleaving is a deliberate 400, never a CHECK abort', async () => {
    // a choice draft; session A converts it to a RECORD while holding the row, and session B's
    // PATCH {deciderKind:'client'} does its pre-transaction read against the still-choice state
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: `R4F1 draft ${run}`, room: 'K', options: twoOptions, publish: false });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R4F1 draft ${run}` } });

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let aHolds!: () => void;
    const aHolding = new Promise<void>((r) => { aHolds = r; });
    const aTx = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('readiness:${projectId}', 0))`);
      await tx.$executeRawUnsafe(`SELECT 1 FROM "Decision" WHERE "id" = '${d.id}' FOR UPDATE`);
      aHolds();
      await gateA; // B has read the CHOICE state and is blocked on our locks
      await tx.decisionOption.deleteMany({ where: { decisionId: d.id } });
      await tx.decision.update({ where: { id: d.id }, data: { deciderKind: 'none', status: 'recorded', photoSwatch: null } });
    });
    await aHolding;

    // B starts: its pre-transaction read sees the CHOICE draft; its transaction then waits on
    // the locks A holds and resumes only AFTER A committed the conversion to a record
    const b = patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { deciderKind: 'client' });
    const bStarted = b.then((r) => r.status);
    // condition-based barrier: wait until B's backend is BLOCKED on a lock, not a fixed sleep
    for (;;) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND pid <> pg_backend_pid()`,
      );
      if (Number(rows[0]!.n) > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    releaseA();
    await aTx;

    // judged against the LOCKED truth (now a record), B's optionless re-point is the same
    // deliberate refusal the sequential conversion door gives — never an uncaught DB abort
    const status = await bStarted;
    const body = (await b).body as { message?: unknown };
    expect(status, JSON.stringify(body)).toBe(400);
    expect(JSON.stringify(body.message)).toContain('2–4 options');
    // and the record itself is untouched by the refused edit
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('recorded');
    expect(after.deciderKind).toBe('none');
    expect(after.photoSwatch).toBeNull();
    // cleanup: the unpublished record draft is discardable (no approval evidence)
    await t.prisma.decisionEvent.deleteMany({ where: { decisionId: d.id } });
    await t.prisma.decision.delete({ where: { id: d.id } });
  });

  it('R4-F2: the statement-level TRUNCATE seal covers published records (the widened 20271015 body is what is deployed)', async () => {
    // the behavioural proof runs in upgrade-proof.sh over a RECORDS-ONLY scratch register (this
    // shared database carries approval evidence, which the OLD arms already refuse); here the
    // DEPLOYED body is pinned to carry the widened recorded arm and its naming message
    const rows = await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_functiondef('decision_t4b_no_truncate()'::regprocedure) AS def`,
    );
    expect(rows[0]!.def).toContain(`'recorded'`);
    expect(rows[0]!.def).toContain('"publishedAt" IS NOT NULL');
    expect(rows[0]!.def).toContain('published records');
  });

  it('R4-F3: user linkage requires an UNLINK-CAPABLE bundle — an undeclared authenticated subscribe stays unlinked and severs a lingering link', async () => {
    const endpoint = `https://push.example/r4f3-${run}`;
    const subscription = { endpoint, keys: { p256dh: 'k1', auth: 'a1' } };
    // the 4b bundle declares the decisions contract on every request → the endpoint is linked
    const aware = await http().post(`/projects/${projectId}/push/subscribe`)
      .set('Authorization', `Bearer ${pmcToken}`)
      .set('X-Vitan-Decisions-Contract', 'recorded-v1')
      .send({ subscription });
    expect(aware.status, JSON.stringify(aware.body)).toBe(201);
    let row = await t.prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } });
    expect(row.linkedUserId).toBe(users.pmc);
    // a cached PRE-4b bundle has no unlink in its sign-out, so its authenticated subscribe
    // (no declaration — the header did not exist there) must NOT attribute the device; the
    // link-less upsert also SEVERS the lingering link the 4b session left on this browser
    const legacy = await http().post(`/projects/${projectId}/push/subscribe`)
      .set('Authorization', `Bearer ${pmcToken}`)
      .send({ subscription });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    row = await t.prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } });
    expect(row.linkedUserId).toBeNull();
    expect(row.role).toBe('pmc'); // role-level delivery is untouched — only the attribution is withheld
    await t.prisma.pushSubscription.delete({ where: { endpoint } }); // keep the suite's project teardown clean
  });

  // ── round-5 Codex corrections (the #465 head f49a0547) ─────────────────────────────────────

  it('R5-F6: an options-ONLY edit on a record draft is a deliberate 400, never a DB seal abort', async () => {
    const res = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: `R5F6 record ${run}`, room: 'K', options: [], publish: false, deciderKind: 'none' });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R5F6 record ${run}` } });
    // deciderKind omitted → the contract's record-takes-no-options refinement never sees it;
    // the service judges the RESULTING kind (still a record) against the payload
    const planted = await patch(pmcToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { options: twoOptions });
    expect(planted.status, JSON.stringify(planted.body)).toBe(400);
    expect(JSON.stringify(planted.body.message)).toContain('takes no options');
    // the record is untouched — still zero options, still a record
    expect(await t.prisma.decisionOption.count({ where: { decisionId: d.id } })).toBe(0);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('recorded');
    // precision: an options-only edit on a CHOICE draft still works (the legal replace)
    const resC = await post(pmcToken)(`/projects/${projectId}/decisions`, { title: `R5F6 choice ${run}`, room: 'K', options: twoOptions, publish: false });
    expect(resC.status).toBe(201);
    const c = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R5F6 choice ${run}` } });
    const replaced = await patch(pmcToken)(`/projects/${projectId}/decisions/${c.id}/draft`, { options: twoOptions.slice().reverse() });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  });

  it('R5-F5: the DecisionOption statement-level TRUNCATE seal is deployed (the behavioural cycle runs in upgrade-proof)', async () => {
    // the shared register here carries approval evidence the OLD arms already refuse, so the
    // records-only behavioural proof lives in upgrade-proof.sh; the DEPLOYED trigger + body
    // are pinned here so a drift cannot pass silently
    const trig = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM pg_trigger WHERE tgname = 'DecisionOption_t4b2_no_truncate' AND tgenabled = 'O'`,
    );
    expect(Number(trig[0]!.n)).toBe(1);
    const rows = await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_functiondef('phase6_t4b2_option_no_truncate()'::regprocedure) AS def`,
    );
    expect(rows[0]!.def).toContain('"publishedAt" IS NOT NULL');
    expect(rows[0]!.def).toContain('published options');
  });

  it('R5-F1: the decider claim predicate judges operability and the decision in ONE transaction (the project lock covers the read)', async () => {
    // the interleaving window (archival committing BETWEEN a standalone operability statement
    // and the decision read) cannot be paused from outside the service, so the pin is
    // structural: the predicate's reads share one $transaction — the FOR UPDATE the orgs
    // answer takes is then held until the decision read has happened — plus the behavioural
    // arm (R3-F2 above) that an archived project drops the claim.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/decisions/decisions.query.ts'), 'utf8');
    const start = src.indexOf('async deciderPushTarget(');
    const end = src.indexOf('\n  async ', start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).toContain('this.prisma.$transaction');
    expect(body).toContain('isProjectOperable(tx, projectId)');
    expect(body).toContain('tx.decision.findFirst');
    // and no read in the predicate escapes the transaction back to the pooled client
    expect(body).not.toContain('this.prisma.decision.findFirst');
  });

  // ── round-6 Codex corrections (the #465 head d64ccc5a) ─────────────────────────────────────

  it('R6-F2: re-adding an existing org admin with a LOWER role rides the holder guard — a deliberate 409, never an unhandled trigger error', async () => {
    // project B: users.orgAdmin's membership-less admin row is again the ONLY effective pmc
    // (orgOwner's arm stays suppressed by the explicit engineer membership the P39 probe added)
    const adminToken = t.issueOrgOwnerToken(users.orgAdmin, projectBId, orgBId);
    const res = await post(adminToken)(`/projects/${projectBId}/decisions`, {
      title: `R6F2 pmc-held ${run}`, room: 'K', options: twoOptions, publish: true, deciderKind: 'pmc',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: projectBId, title: `R6F2 pmc-held ${run}` } });

    const ownerToken = t.issueProjectToken(users.orgOwner, projectBId, 'pmc');
    // the upsert's UPDATE arm is a demotion — the SAME deliberate refusal as PATCH/DELETE
    const readd = await post(ownerToken)(`/orgs/${orgBId}/members`, { name: 'U admin', email: `${users.orgAdmin}@t.local`, role: 'member' });
    expect(readd.status, JSON.stringify(readd.body)).toBe(409);
    expect(JSON.stringify(readd.body.message)).toContain('effective PMC');
    // the admin row is untouched
    expect((await t.prisma.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId: orgBId, userId: users.orgAdmin } } })).role).toBe('admin');
    // precision: a NON-reducing re-add (same role) still lands while the decision is open
    const same = await post(ownerToken)(`/orgs/${orgBId}/members`, { name: 'U admin', email: `${users.orgAdmin}@t.local`, role: 'admin' });
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    // release the hold and the SAME demoting re-add lands; restore the admin arm
    expect((await post(adminToken)(`/projects/${projectBId}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await post(ownerToken)(`/orgs/${orgBId}/members`, { name: 'U admin', email: `${users.orgAdmin}@t.local`, role: 'member' })).status).toBe(201);
    await t.prisma.orgMembership.update({ where: { orgId_userId: { orgId: orgBId, userId: users.orgAdmin } }, data: { role: 'admin' } });
  });

  it('R6-F3: the OrgMembership statement-level TRUNCATE seal is deployed (the behavioural cycle runs in upgrade-proof)', async () => {
    const trig = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM pg_trigger WHERE tgname = 'OrgMembership_t4b2_no_truncate' AND tgenabled = 'O'`,
    );
    expect(Number(trig[0]!.n)).toBe(1);
    const rows = await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_functiondef('phase6_t4b2_org_membership_no_truncate()'::regprocedure) AS def`,
    );
    expect(rows[0]!.def).toContain(`"deciderKind"::text = 'pmc'`);
    expect(rows[0]!.def).toContain('last effective PMC');
  });

  // ── round-7 Codex corrections (the #466 head f92ac84f) ─────────────────────────────────────

  it('R7-F1: a draft author REASSIGNED off pmc still reaches their own draft — the route ceiling admits them, the service narrows by identity', async () => {
    // a second pmc authors a draft, then is re-roled to engineer (they are not the last pmc —
    // users.pmc remains — and no open decision names their membership, so the guards permit it)
    const tempId = id('r7auth');
    await t.prisma.user.create({ data: { id: tempId, projectId, role: 'pmc', name: 'Re-roled author', email: `${tempId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId, userId: tempId, role: 'pmc', status: 'active' } });
    let tok = t.issueProjectToken(tempId, projectId, 'pmc');
    const res = await post(tok)(`/projects/${projectId}/decisions`, { title: `R7F1 draft ${run}`, room: 'K', options: twoOptions, publish: false });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R7F1 draft ${run}` } });
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: tempId } }, data: { role: 'engineer' } });
    tok = t.issueProjectToken(tempId, projectId, 'engineer');

    // the AUTHOR edits their own private draft from their new role — the service's identity rule
    const edit = await patch(tok)(`/projects/${projectId}/decisions/${d.id}/draft`, { title: `R7F1 renamed ${run}` });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).title).toBe(`R7F1 renamed ${run}`);
    // precision: a DIFFERENT engineer passes the widened ceiling but is refused by the service
    const other = await patch(engBToken)(`/projects/${projectId}/decisions/${d.id}/draft`, { title: 'not yours' });
    expect(other.status).toBe(403);
    // cleanup (an unpublished draft is discardable)
    await t.prisma.decisionEvent.deleteMany({ where: { decisionId: d.id } });
    await t.prisma.decisionOption.deleteMany({ where: { decisionId: d.id } });
    await t.prisma.decision.delete({ where: { id: d.id } });
    await t.prisma.membership.delete({ where: { projectId_userId: { projectId, userId: tempId } } });
    await t.prisma.user.delete({ where: { id: tempId } });
  });

  it('R7-F2: publishing a record whose AUTHOR lost standing is refused — command AND database; restored standing publishes', async () => {
    const tempId = id('r7rec');
    await t.prisma.user.create({ data: { id: tempId, projectId, role: 'pmc', name: 'Departed record author', email: `${tempId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId, userId: tempId, role: 'pmc', status: 'active' } });
    const tok = t.issueProjectToken(tempId, projectId, 'pmc');
    const res = await post(tok)(`/projects/${projectId}/decisions`, { title: `R7F2 record ${run}`, room: 'K', options: [], publish: false, deciderKind: 'none' });
    expect(res.status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId, title: `R7F2 record ${run}` } });
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: tempId } }, data: { status: 'removed' } });

    // command layer: another PMC cannot publish the revoked author's record — the register
    // entry would be attributed to someone with no standing (re-issue it yourself instead)
    const pub = await post(pmcToken)(`/projects/${projectId}/decisions/${d.id}/publish`);
    expect(pub.status, JSON.stringify(pub.body)).toBe(409);
    expect(JSON.stringify(pub.body.message)).toContain('author');
    // DB layer: the hostile direct publication is refused by the publication arm's author check
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = '${d.id}'`),
    ).rejects.toThrow(/authority/i);

    // precision: restored standing lets the SAME publish land
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: tempId } }, data: { status: 'active' } });
    const ok = await post(pmcToken)(`/projects/${projectId}/decisions/${d.id}/publish`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).publishedAt).not.toBeNull();
    // the published record is permanent and stays on the register (the suite's sanctioned
    // afterAll wipe removes it); the temp identity leaves now (`authorId` carries no FK)
    await t.prisma.membership.delete({ where: { projectId_userId: { projectId, userId: tempId } } });
    await t.prisma.user.delete({ where: { id: tempId } });
  });

  // ── round-8 Codex corrections (the #466 head 999b9344) ─────────────────────────────────────

  it('R8-F2: the org-membership guard serializes on the readiness key BEFORE consulting decision existence — a concurrent pmc-held publish cannot slip past it', async () => {
    // Codex race at 999b9344: T1 publishes a pmc-held decision on project B holding the
    // readiness key; T2 deletes the org-admin row whose arm is the ONLY effective pmc there.
    // The old guard PREFILTERED its loop on `phase6_decisions_hold_role`, and T1's decision is
    // uncommitted — invisible to T2 — so the loop was EMPTY, never touched the key, and BOTH
    // committed: a holderless published decision. The key must be taken per covered project
    // FIRST, so T2 either refuses as contended (T1 holds the key) or, retried after T1's
    // commit, sees the decision and refuses as holderless. Deterministic: T1 is a held-open
    // transaction, so every interleaving step is externally sequenced.
    const did = id('r8f2');
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let holderReady!: () => void;
    const holderHolds = new Promise<void>((r) => { holderReady = r; });
    const t1 = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('readiness:${projectBId}', 0))`);
      // the direct publish path the service takes, under the SAME key it holds
      await tx.$executeRawUnsafe(
        `INSERT INTO "Decision"("id","projectId","title","room","status","ageDays","authorId","deciderKind","photoSwatch")
         VALUES ('${did}','${projectBId}','R8F2 pmc-held ${run}','Hall','pending',0,'${users.orgAdmin}','pmc','sw1')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","recommended","order")
         VALUES ('${did}-a','${did}','A','a','Kota',0,'sw1',true,0), ('${did}-b','${did}','B','b','Granite',100,'sw2',false,1)`,
      );
      await tx.$executeRawUnsafe(`UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = '${did}'`);
      holderReady();
      await released; // T2 runs its hostile delete HERE, against our uncommitted decision
    });
    await holderHolds;

    // T2 — the org-membership DELETE while T1 holds the key and its decision is uncommitted:
    // the covered project's key is taken FIRST, so this refuses as CONTENDED (the old guard
    // committed here, orphaning the decision the moment T1 landed)
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "orgId" = '${orgBId}' AND "userId" = '${users.orgAdmin}'`),
    ).rejects.toThrow(/contended/i);

    release();
    await t1;

    // committed-truth barrier: the second arm's claim is about a delete against COMMITTED
    // pmc-held demand, so pin that the publish IS pooled-visible committed truth first
    const [{ holds }] = await t.prisma.$queryRawUnsafe<Array<{ holds: boolean }>>(
      `SELECT phase6_decisions_hold_role('${projectBId}','pmc') AS holds`,
    );
    expect(holds).toBe(true);

    // T1 has committed: the SAME delete now takes the key freely, SEES the published pmc-held
    // decision, and refuses as holderless — never a silent success on either side of the race
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "OrgMembership" WHERE "orgId" = '${orgBId}' AND "userId" = '${users.orgAdmin}'`),
    ).rejects.toThrow(/NO effective pmc/i);
    expect((await t.prisma.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId: orgBId, userId: users.orgAdmin } } })).role).toBe('admin');

    // drift pin: the deployed guard's CODE takes the key BEFORE it consults decision existence
    // (compare call sites with the SQL comments stripped — the rationale comment names both)
    const def = (await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_functiondef('phase6_t4b2_org_membership_guard()'::regprocedure) AS def`,
    ))[0]!.def;
    const code = def.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code.indexOf('phase6_try_readiness')).toBeGreaterThan(-1);
    expect(code.indexOf('phase6_decisions_hold_role')).toBeGreaterThan(code.indexOf('phase6_try_readiness'));

    // release the hold (the effective pmc approves) so the register closes for the suite wipe
    const adminToken = t.issueOrgOwnerToken(users.orgAdmin, projectBId, orgBId);
    expect((await post(adminToken)(`/projects/${projectBId}/decisions/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
  });

  it('R7-F4/R8-F1: the migration acquires its four-table lock FIRST and ALL-OR-NOTHING — NOWAIT in a retried subtransaction, before any table ALTER', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20271015000000_phase6_t4b_decider/migration.sql'),
      'utf8',
    );
    const lockAt = sql.indexOf('LOCK TABLE "Decision", "Membership", "OrgMembership", "Project"');
    const firstAlterAt = sql.search(/^ALTER TABLE /m);
    expect(lockAt).toBeGreaterThan(-1);
    expect(firstAlterAt).toBeGreaterThan(-1);
    // R7-F4 — the four-table wait must happen while the transaction holds NOTHING: an ALTER's
    // ACCESS EXCLUSIVE held while waiting on Membership deadlocks against an old membership
    // writer whose holder trigger reads Decision
    expect(lockAt).toBeLessThan(firstAlterAt);
    // and exactly ONE such acquisition exists (no second, later re-lock to regress the order)
    expect(sql.indexOf('LOCK TABLE', lockAt + 1)).toBe(-1);
    // R8-F1 — a comma-separated LOCK TABLE acquires its relations ONE BY ONE, so "first
    // statement" alone still holds Decision while waiting on Membership (the same cycle
    // against an old writer that holds Membership and then inserts a Decision). The
    // acquisition must be ALL-OR-NOTHING: NOWAIT inside a subtransaction whose
    // lock_not_available rollback RELEASES any partial set before the retry.
    const stmt = sql.slice(lockAt, sql.indexOf(';', lockAt) + 1);
    expect(stmt).toContain('NOWAIT');
    expect(stmt).toContain('SHARE ROW EXCLUSIVE');
    // the NOWAIT failure is caught (subtransaction rollback → partial set released) and retried
    // with a bounded cap that FAILS CLOSED rather than waiting forever holding a partial set
    const block = sql.slice(Math.max(0, lockAt - 400), lockAt + 800);
    expect(block).toContain('EXCEPTION WHEN lock_not_available');
    expect(block).toMatch(/pg_sleep/);
    expect(block).toMatch(/RAISE EXCEPTION/);
  });

  it('R8-F3: the P3005 baseline path EXECUTES 20271015 rather than resolving it as applied (a db-push database has the schema but none of the raw seals)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const sh = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../scripts/migrate.sh'),
      'utf8',
    );
    // the migration is in the ALWAYS_EXECUTE set…
    const m = sh.match(/ALWAYS_EXECUTE="([^"]+)"/);
    expect(m, 'migrate.sh must declare ALWAYS_EXECUTE').not.toBeNull();
    const entries = m![1].split('\n').map((s) => s.trim());
    expect(entries).toContain('20271015000000_phase6_t4b_decider');
    // …and the baseline loop consults that set to leave its members pending for the deploy
    expect(sh).toContain('printf \'%s\\n\' "$ALWAYS_EXECUTE" | grep -qx "$name"');
  });
});
