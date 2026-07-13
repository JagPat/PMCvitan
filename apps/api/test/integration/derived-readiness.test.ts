import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 Task 6 — readiness derived from explicit links, against live
 * PostgreSQL (written BEFORE the implementation):
 *   - the Decision gate follows the linked decision's lock state (a change
 *     request reverts readiness automatically);
 *   - the Inspection gate follows inspections LINKED to the activity — an open
 *     correction chain reads FAIL until its reinspection is accepted, and an
 *     unrelated inspection sharing only the room is invisible;
 *   - the Drawing gate follows the governing revision's FROZEN recipients ∩
 *     active members, aggregated worst-wins across linked drawings; membership
 *     churn behaves per the truth-table rows;
 *   - start() requires all FIVE readiness values (ok|na), overrides considered;
 *   - a GateOverride is an attributable, evidenced, EXPIRING record (pmc only),
 *     audited on create and revoke, containment-proven by raw-SQL probes;
 *   - no route can set gateInspection any more (the stored column is retired
 *     from the contract and from the start guard).
 */
describe('derived readiness + gate overrides (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;
  let conToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc, name 'member'
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer'); // name 'owner'
    conToken = t.issueProjectToken(f.strangerUser.id, f.projectA.id, 'contractor'); // name 'stranger'
    await t.prisma.membership.createMany({
      data: [
        { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' },
        { projectId: f.projectA.id, userId: f.strangerUser.id, role: 'contractor', status: 'active' },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.media.deleteMany({ where: { projectId: { in: [projectId, f.projectB.id] } } });
    await t.prisma.gateOverride.deleteMany({ where: { projectId } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.drawingAck.deleteMany({ where: { revision: { drawing: { projectId } } } });
    await t.prisma.drawingRecipient.deleteMany({ where: { projectId } });
    await t.prisma.drawingRevision.deleteMany({ where: { drawing: { projectId } } });
    await t.prisma.drawing.deleteMany({ where: { projectId } });
    await t.prisma.activity.deleteMany({ where: { projectId } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } });
    await t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId } } });
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId } } });
    await t.prisma.decision.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { projectId, userId: { in: [f.ownerUser.id, f.strangerUser.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const pdf = Buffer.from('%PDF-1.4 readiness').toString('base64');

  async function makeActivity(name: string, extra: object = {}): Promise<string> {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name, plannedStart: 0, plannedEnd: 5, ...extra })).status).toBe(201);
    return (await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name } })).id;
  }

  /** The activity's serialized readiness, as the PMC's snapshot delivers it. */
  async function readiness(activityId: string) {
    const snap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${pmcToken}`);
    expect(snap.status).toBe(200);
    const act = (snap.body.activities as Array<{ id: string; readiness?: Record<string, { v: string; source: string; reason: string }>; overrides?: Array<{ id: string; gate: string; state: string; expiresAt: string }> }>).find((a) => a.id === activityId);
    expect(act?.readiness).toBeTruthy();
    return { readiness: act!.readiness!, overrides: act!.overrides ?? [] };
  }

  it('DECISION gate: derives live from the linked lock state — approval flips it, a change request reverts it', async () => {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions`, {
      title: 'Readiness counter', room: 'Kitchen', publish: true,
      options: [
        { label: 'A', material: 'Granite', delta: 0, swatch: 's1', recommended: true },
        { label: 'B', material: 'Quartz', delta: 15000, swatch: 's2', recommended: false },
      ],
    })).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Readiness counter' } });
    const actId = await makeActivity('Decision gated', { decisionId: d.id });

    expect((await readiness(actId)).readiness.decision).toMatchObject({ v: 'wait', source: 'derived' });
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await readiness(actId)).readiness.decision.v).toBe('ok');
    // Task 2's reopening reverts readiness automatically
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'supply issue', costImpact: 0, timeImpactDays: 1 })).status).toBe(201);
    expect((await readiness(actId)).readiness.decision.v).toBe('wait');
  });

  it('INSPECTION gate: linked chain reads wait → FAIL on rejection → stays FAIL through the open reinspection → ok once accepted; an unrelated same-room inspection never moves it', async () => {
    const actId = await makeActivity('Inspection gated');
    expect((await readiness(actId)).readiness.inspection.v).toBe('na'); // row 1

    // an inspection sharing only the ROOM (no requirement edge) is invisible
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title: 'Unrelated check', zone: 'Terrace', items: ['Other work'] })).status).toBe(201);
    expect((await readiness(actId)).readiness.inspection.v).toBe('na');

    // the LINKED requirement appears → open requirement (row 3)
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections`, { title: 'Linked check', zone: 'Terrace', items: ['Slope'], activityId: actId })).status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Linked check' }, include: { items: true } });
    expect((await readiness(actId)).readiness.inspection.v).toBe('wait');

    // engineer fails the item WITH evidence; PMC rejects → the chain is OPEN (row 2)
    expect((await as(engToken)(`/projects/${f.projectA.id}/media`, { kind: 'inspection', mime: 'image/png', data: px, inspectionId: insp.id, inspectionItemId: insp.items[0].id, clientKey: 'rd-ev-1' })).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${insp.id}/submit`, { items: [{ name: 'Slope', state: 'fail', photos: 1, note: 'ponding' }] })).status).toBe(201);
    expect((await readiness(actId)).readiness.inspection.v).toBe('wait'); // submitted, undecided — still row 3
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${insp.id}/decide`, { approve: false, rejectedItemNames: ['Slope'] })).status).toBe(201);
    expect((await readiness(actId)).readiness.inspection.v).toBe('fail');

    // the open reinspection child keeps it FAIL (row 2 over row 3), even once submitted
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: insp.id } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/inspections/${child.id}/submit`, { items: [{ name: 'Slope', state: 'pass', photos: 0, note: '' }] })).status).toBe(201);
    expect((await readiness(actId)).readiness.inspection.v).toBe('fail');

    // acceptance of the correction closes the chain → ok (row 4)
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${child.id}/decide`, { approve: true })).status).toBe(201);
    expect((await readiness(actId)).readiness.inspection.v).toBe('ok');
    await t.prisma.media.deleteMany({ where: { projectId: f.projectA.id, clientKey: 'rd-ev-1' } });
  });

  it('DRAWING gate + START guard: the unacked governing set blocks start; both frozen recipients acknowledging unblocks it', async () => {
    const actId = await makeActivity('Drawing gated');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/drawings`, {
      number: 'RD-100', title: 'Plan', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: pdf, publish: true, activityId: actId,
    })).status).toBe(201);
    const r = await readiness(actId);
    expect(r.readiness.drawing).toMatchObject({ v: 'wait', source: 'derived' }); // frozen {engineer, contractor}, no acks

    const start = await as(engToken)(`/projects/${f.projectA.id}/activities/${actId}/start`, {});
    expect(start.status).toBe(409); // readiness derived at the server — not a stored flag

    const rev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'RD-100' }, status: 'for_construction' } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`, {})).status).toBe(201);
    expect((await readiness(actId)).readiness.drawing.v).toBe('wait'); // partial acknowledgement (row 4)
    expect((await as(conToken)(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`, {})).status).toBe(201);
    expect((await readiness(actId)).readiness.drawing.v).toBe('ok'); // row 5
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${actId}/start`, {})).status).toBe(201);
  });

  it('membership churn rows: a recipient REMOVED after issue cannot block; a member ADDED after issue is not required', async () => {
    const actId = await makeActivity('Churn gated');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/drawings`, {
      number: 'RD-200', title: 'Churn plan', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: pdf, publish: true, activityId: actId,
    })).status).toBe(201);
    const rev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'RD-200' }, status: 'for_construction' } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`, {})).status).toBe(201);
    expect((await readiness(actId)).readiness.drawing.v).toBe('wait'); // the contractor still owes an ack

    // the contractor leaves the project → drops out of active(P) → cannot block (row 3–5 inputs)
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: f.strangerUser.id } }, data: { status: 'removed' } });
    try {
      expect((await readiness(actId)).readiness.drawing.v).toBe('ok');

      // a NEW engineer joining after issue is not in the frozen set → not required
      const newbie = await t.prisma.user.create({ data: { id: `rd-new-${f.projectA.id}`, projectId: f.projectA.id, role: 'engineer', name: 'newbie', email: `rd-new-${f.projectA.id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: newbie.id, role: 'engineer', status: 'active' } });
      try {
        expect((await readiness(actId)).readiness.drawing.v).toBe('ok');
      } finally {
        await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: newbie.id } });
        await t.prisma.user.delete({ where: { id: newbie.id } });
      }
    } finally {
      await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: f.strangerUser.id } }, data: { status: 'active' } });
    }
  });

  it('MULTI-DRAWING aggregation is worst-wins: adding a review-only drawing degrades an acknowledged gate to fail', async () => {
    const actId = await makeActivity('Aggregation gated');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/drawings`, {
      number: 'RD-300', title: 'Acked plan', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: pdf, publish: true, activityId: actId,
    })).status).toBe(201);
    const rev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'RD-300' }, status: 'for_construction' } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`, {})).status).toBe(201);
    expect((await as(conToken)(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`, {})).status).toBe(201);
    expect((await readiness(actId)).readiness.drawing.v).toBe('ok');

    // a second linked drawing whose only revision is a REVIEW copy governs nothing → per-drawing fail → aggregate fail
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/drawings`, {
      number: 'RD-301', title: 'Review only', discipline: 'architectural', rev: 'A', status: 'for_review', mime: 'application/pdf', data: pdf, publish: true, activityId: actId,
    })).status).toBe(201);
    expect((await readiness(actId)).readiness.drawing.v).toBe('fail');
  });

  it('OVERRIDE lifecycle: pmc-only, future expiry, attributable + audited; it admits a blocked start, lapses on expiry, and can be revoked early', async () => {
    const actId = await makeActivity('Override gated');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/drawings`, {
      number: 'RD-400', title: 'Blocking review copy', discipline: 'architectural', rev: 'A', status: 'for_review', mime: 'application/pdf', data: pdf, publish: true, activityId: actId,
    })).status).toBe(201);
    expect((await readiness(actId)).readiness.drawing.v).toBe('fail');
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${actId}/start`, {})).status).toBe(409);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // only the PMC may override
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'drawing', state: 'ok', reason: 'x', expiresAt: future })).status).toBe(403);
    // an expiry in the past is refused — an override always lapses forward
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'drawing', state: 'ok', reason: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);

    // a real override: attributable, reasoned, expiring
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'drawing', state: 'ok', reason: 'Construction set carried on site in print', expiresAt: future })).status).toBe(201);
    const r1 = await readiness(actId);
    expect(r1.readiness.drawing).toMatchObject({ v: 'ok', source: 'override', reason: 'Construction set carried on site in print' });
    expect(r1.overrides).toHaveLength(1);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { projectId: f.projectA.id, action: 'activity.override', entityId: actId } });
    expect(audit.actorId).toBe(f.memberUser.id);
    // the override ADMITS the start the derivation blocked
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${actId}/start`, {})).status).toBe(201);

    // EXPIRY restores the derived value (time-travel the row — no service writes involved)
    const row = await t.prisma.gateOverride.findFirstOrThrow({ where: { projectId: f.projectA.id, activityId: actId } });
    await t.prisma.gateOverride.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await readiness(actId)).readiness.drawing).toMatchObject({ v: 'fail', source: 'derived' });

    // REVOKE early: delete + audit; the derivation rules again
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'inspection', state: 'ok', reason: 'temp', expiresAt: future })).status).toBe(201);
    const row2 = await t.prisma.gateOverride.findFirstOrThrow({ where: { projectId: f.projectA.id, activityId: actId, gate: 'inspection' } });
    const del = await http().delete(`/projects/${f.projectA.id}/activities/${actId}/override/${row2.id}`).set('Authorization', `Bearer ${pmcToken}`);
    expect([200, 201].includes(del.status)).toBe(true);
    expect(await t.prisma.gateOverride.count({ where: { id: row2.id } })).toBe(0);
    const revoke = await t.prisma.auditLog.findFirstOrThrow({ where: { projectId: f.projectA.id, action: 'activity.override_revoke', entityId: actId } });
    expect(revoke.actorId).toBe(f.memberUser.id);
  });

  it('override EVIDENCE must belong to THIS project — service refusal and raw-SQL forgery probes (activity + evidence)', async () => {
    const actId = await makeActivity('Forgery gated');
    const future = new Date(Date.now() + 3600_000).toISOString();
    // evidence from ANOTHER project is refused by the service…
    const foreign = await t.prisma.media.create({ data: { projectId: f.projectB.id, kind: 'progress', mime: 'image/png', uploadedBy: 'x' } });
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'material', state: 'ok', reason: 'x', expiresAt: future, evidenceMediaId: foreign.id })).status).toBe(400);
    // …and by PostgreSQL on a direct write (composite FK)
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "GateOverride" ("id","projectId","activityId","gate","state","reason","actorId","actorName","evidenceMediaId","expiresAt") VALUES ('forge-o1',$1,$2,'material','ok','x','x','x',$3, now() + interval '1 hour')`,
      f.projectA.id, actId, foreign.id,
    )).rejects.toThrow(/violates foreign key constraint/);
    // a cross-project ACTIVITY reference is equally impossible
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "GateOverride" ("id","projectId","activityId","gate","state","reason","actorId","actorName","expiresAt") VALUES ('forge-o2',$1,$2,'material','ok','x','x','x', now() + interval '1 hour')`,
      f.projectB.id, actId,
    )).rejects.toThrow(/violates foreign key constraint/);
    // valid same-project evidence is accepted and surfaced
    const local = await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: 'x' } });
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'material', state: 'ok', reason: 'delivery note photographed', expiresAt: future, evidenceMediaId: local.id })).status).toBe(201);
  });

  it('NO route can set gateInspection any more: it left the create/update contracts, and the stored legacy column no longer gates start', async () => {
    // update: alone it is an empty update (400); alongside a real field it is IGNORED
    const actId = await makeActivity('Contract gated');
    expect((await http().patch(`/projects/${f.projectA.id}/activities/${actId}`).set('Authorization', `Bearer ${pmcToken}`).send({ gateInspection: 'ok' })).status).toBe(400);
    expect((await http().patch(`/projects/${f.projectA.id}/activities/${actId}`).set('Authorization', `Bearer ${pmcToken}`).send({ name: 'Contract gated 2', gateInspection: 'ok' })).status).toBe(200);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).gateInspection).toBe('na');

    // create: the field is not accepted either
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name: 'Create gated', plannedStart: 0, plannedEnd: 5, gateInspection: 'fail' })).status).toBe(201);
    const created = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Create gated' } });
    expect(created.gateInspection).toBe('na');

    // a legacy stored 'fail' (written directly, pre-Task-6) does NOT block start:
    // readiness derives from LINKED inspections (none → na), never the stored flag
    await t.prisma.activity.update({ where: { id: created.id }, data: { gateInspection: 'fail' } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${created.id}/start`, {})).status).toBe(201);
  });
});
