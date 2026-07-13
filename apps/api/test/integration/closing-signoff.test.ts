import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 Task 5 — closing sign-off controls activity completion, against live
 * PostgreSQL (written BEFORE the implementation, per the plan):
 *   - complete() is a CAS claim (in_progress → awaiting_signoff) recording the
 *     completer's real identity and creating the LINKED, item-bearing closing
 *     inspection in the same transaction — "done" is no longer written here;
 *   - ONLY the PMC's approval of that closing inspection makes the activity
 *     done (+ doneAt, the sign-off civil day) — same transaction, CAS-guarded;
 *   - rejection returns the activity to execution and assigns the corrective
 *     reinspection to the RECORDED completer — but only while that identity
 *     still holds an ACTIVE, assignment-eligible membership; removal or a role
 *     change between claim and rejection demands an explicit eligible assignee;
 *   - legacy zero-item closings (backfilled `closing=true`) stay decidable:
 *     approve tolerates the already-done activity, reject reopens it by an
 *     attributable PMC decision and needs an explicit assignee;
 *   - concurrency: one completion claim wins; one closing decision wins;
 *   - the completion claim is containment-proven: a completer without a
 *     membership on THIS project is rejected by PostgreSQL itself.
 */
describe('closing sign-off controls activity completion (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc, name 'member'
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer'); // name 'owner'
    await t.prisma.membership.createMany({
      data: [
        // the engineer who claims completion + a second eligible member for the churn paths
        { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' },
        { projectId: f.projectA.id, userId: f.strangerUser.id, role: 'contractor', status: 'active' },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.activity.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { projectId, userId: { in: [f.ownerUser.id, f.strangerUser.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);

  /** Restore the engineer's ACTIVE membership after a churn test mutated it. */
  const restoreEngineer = () =>
    t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.ownerUser.id } },
      data: { role: 'engineer', status: 'active' },
    });

  /** Create + start an activity, then CLAIM completion as the engineer. */
  async function claimedActivity(name: string) {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name, plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${a.id}/start`, {})).status).toBe(201);
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {})).status).toBe(201);
    const closing = await t.prisma.inspection.findFirstOrThrow({
      where: { projectId: f.projectA.id, activityId: a.id, closing: true, decided: false },
      include: { items: true },
    });
    return { activityId: a.id, closingId: closing.id, closing };
  }

  it('the FULL sign-off loop: claim parks the activity awaiting_signoff with a linked closing inspection; ONLY the PMC approval writes done', async () => {
    const { activityId, closingId, closing } = await claimedActivity('Skirting');

    // the claim is an attributable fact — not a completion
    const claimed = await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
    expect(claimed.status).toBe('awaiting_signoff');
    expect(claimed.completionRequestedById).toBe(f.ownerUser.id);
    expect(claimed.completionRequestedByName).toBe('owner');
    expect(claimed.completionRequestedAt).toBeInstanceOf(Date);
    expect(claimed.actualEndDate).toBeInstanceOf(Date); // the CLAIMED work-end day
    expect(claimed.doneAt).toBeNull(); // sign-off has not happened

    // the closing inspection is linked, marked, item-bearing (so it CAN be rejected)
    expect(closing.closing).toBe(true);
    expect(closing.activityId).toBe(activityId);
    expect(closing.kind).toBe('review');
    expect(closing.submitted).toBe(true);
    expect(closing.submittedById).toBe(f.ownerUser.id); // the completer
    expect(closing.items.map((i) => i.name)).toEqual(['Work complete and acceptable']);
    expect(closing.id).not.toBe(`INSP-${activityId}-close`); // id-pattern linkage is retired

    const claimAudit = await t.prisma.auditLog.findFirstOrThrow({ where: { projectId: f.projectA.id, action: 'activity.complete_requested', entityId: activityId } });
    expect(claimAudit.actorId).toBe(f.ownerUser.id);

    // the PMC approves the closing inspection → the activity becomes done, same transaction
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: true })).status).toBe(201);
    const done = await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
    expect(done.status).toBe('done');
    expect(done.doneAt).toBeInstanceOf(Date); // the sign-off civil day
    const signoffAudit = await t.prisma.auditLog.findFirstOrThrow({ where: { projectId: f.projectA.id, action: 'activity.signoff', entityId: activityId } });
    expect(signoffAudit.actorId).toBe(f.memberUser.id); // the PMC's attributable acceptance
  });

  it('REJECTION returns the activity to execution, assigns the corrective work to the RECORDED completer, and a fresh claim starts a NEW closing', async () => {
    const { activityId, closingId } = await claimedActivity('Waterproofing');

    // the PMC rejects the default sign-off item — no explicit assignee given
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'] })).status).toBe(201);

    const reopened = await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
    expect(reopened.status).toBe('in_progress'); // back to execution
    expect(reopened.doneAt).toBeNull();

    // corrective work goes to the recorded completer (still an active engineer)
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: closingId }, include: { items: true } });
    expect(child.assigneeId).toBe(f.ownerUser.id);
    expect(child.closing).toBe(false); // corrective checklist — NOT itself a sign-off
    expect(child.activityId).toBe(activityId); // the requirement edge is inherited
    expect(child.dueDate).toBeInstanceOf(Date);
    expect(child.items.map((i) => i.name)).toEqual(['Work complete and acceptable']);
    const rejAudit = await t.prisma.auditLog.findFirstOrThrow({ where: { projectId: f.projectA.id, action: 'activity.signoff_rejected', entityId: activityId } });
    expect(rejAudit.actorId).toBe(f.memberUser.id);

    // re-claiming completion works and creates a SECOND, distinct closing inspection
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${activityId}/complete`, {})).status).toBe(201);
    const closings = await t.prisma.inspection.findMany({ where: { projectId: f.projectA.id, activityId, closing: true }, orderBy: { id: 'asc' } });
    expect(closings).toHaveLength(2);
    const fresh = closings.find((c) => !c.decided)!;
    expect(fresh.id).not.toBe(closingId);

    // and ONLY its approval writes done
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${fresh.id}/decide`, { approve: true })).status).toBe(201);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } })).status).toBe('done');
  });

  it('claim guards: only a RUNNING activity can be claimed (409); a caller without a membership on this project cannot claim (fail-closed)', async () => {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name: 'Guard rails', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Guard rails' } });

    // not started → the claim conflicts
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {})).status).toBe(409);

    // an org OWNER operating without a project membership has no Membership row —
    // the completion claim would be unattributable to a member, so it is refused
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${a.id}/start`, {})).status).toBe(201);
    const ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: f.ownerUser.id } }, data: { status: 'removed' } });
    try {
      expect((await as(ownerToken)(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {})).status).toBe(400);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('in_progress'); // unchanged
    } finally {
      await restoreEngineer();
    }
  });

  it('membership CHURN (a) — completer REMOVED between claim and rejection: the default is refused; an explicit eligible assignee is required', async () => {
    const { activityId, closingId } = await claimedActivity('Plaster check');
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: f.ownerUser.id } }, data: { status: 'removed' } });

    try {
      // no explicit assignee → the recorded completer is no longer active → 400, nothing changes
      const refused = await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'] });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toMatch(/active|eligible|assignee/i);
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: closingId } })).decided).toBe(false);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } })).status).toBe('awaiting_signoff');

      // naming an ACTIVE contractor explicitly succeeds
      expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'], assigneeId: f.strangerUser.id })).status).toBe(201);
      const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: closingId } });
      expect(child.assigneeId).toBe(f.strangerUser.id);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } })).status).toBe('in_progress');
    } finally {
      await restoreEngineer();
    }
  });

  it('membership CHURN (b) — completer role changed engineer→client: the default is refused; an ineligible explicit assignee is still refused', async () => {
    const { activityId, closingId } = await claimedActivity('Railing check');
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: f.ownerUser.id } }, data: { role: 'client' } });

    try {
      // the completer is still ACTIVE but no longer role-eligible — default refused
      expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'] })).status).toBe(400);
      // naming the (now-client) completer explicitly is refused too
      expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'], assigneeId: f.ownerUser.id })).status).toBe(400);
      // an eligible explicit assignee resolves it
      expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'], assigneeId: f.strangerUser.id })).status).toBe(201);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId } })).status).toBe('in_progress');
    } finally {
      await restoreEngineer();
    }
  });

  it('LEGACY zero-item closings stay decidable: approve tolerates the already-done activity; reject reopens it attributably and needs an explicit assignee', async () => {
    // legacy shape: activity already done (pre-Task-5), zero-item closing linked by backfill
    const mkLegacy = async (suffix: string) => {
      expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name: `Legacy ${suffix}`, plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
      const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: `Legacy ${suffix}` } });
      await t.prisma.activity.update({ where: { id: a.id }, data: { status: 'done' } });
      const insp = await t.prisma.inspection.create({
        data: { id: `INSP-${a.id}-close`, projectId: f.projectA.id, kind: 'review', closing: true, activityId: a.id, title: `Closing inspection: Legacy ${suffix}`, zone: '', date: '05 Jul 2026', submitted: true, decided: false },
      });
      return { activityId: a.id, closingId: insp.id };
    };

    // approve: the activity is ALREADY done (legacy stays done) — the sign-off records, never re-transitions
    const ap = await mkLegacy('approve');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${ap.closingId}/decide`, { approve: true })).status).toBe(201);
    const doneAct = await t.prisma.activity.findUniqueOrThrow({ where: { id: ap.activityId } });
    expect(doneAct.status).toBe('done');
    expect(doneAct.doneAt).toBeInstanceOf(Date); // the sign-off day is now recorded
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: ap.closingId } })).decided).toBe(true);

    // reject: no recorded completer exists → an explicit eligible assignee is REQUIRED
    const rj = await mkLegacy('reject');
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${rj.closingId}/decide`, { approve: false, rejectedItemNames: [] })).status).toBe(400);
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/inspections/${rj.closingId}/decide`, { approve: false, rejectedItemNames: [], assigneeId: f.strangerUser.id })).status).toBe(201);
    // the PMC's rejection is an ATTRIBUTABLE reopening — this is a human decision, not a migration guess
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: rj.activityId } })).status).toBe('in_progress');
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: rj.closingId }, include: { items: true } });
    expect(child.items.map((i) => i.name)).toEqual(['Work complete and acceptable']); // a zero-item legacy closing still yields workable corrective items
    expect(child.assigneeId).toBe(f.strangerUser.id);
  });

  it('CONCURRENCY: two simultaneous completion claims → ONE transition + ONE closing inspection; two closing decides → one winner', async () => {
    function barrierOn(model: 'activity' | 'inspection', id: string) {
      const delegate = t.prisma[model] as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
      const original = delegate.findUnique.bind(t.prisma[model]);
      let release!: () => void;
      const both = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      delegate.findUnique = async (args: { where: { id?: string } }) => {
        const row = await original(args);
        if (args?.where?.id === id) {
          reads += 1;
          if (reads === 2) release();
          await both;
        }
        return row;
      };
      return { restore: () => { delegate.findUnique = original; }, reads: () => reads };
    }

    // race 1: complete vs complete — one claim wins, exactly one closing inspection exists
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name: 'Race complete', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Race complete' } });
    expect((await as(engToken)(`/projects/${f.projectA.id}/activities/${a.id}/start`, {})).status).toBe(201);
    let b = barrierOn('activity', a.id);
    try {
      const [r1, r2] = await Promise.all([
        as(engToken)(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {}),
        as(pmcToken)(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {}),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    } finally {
      b.restore();
    }
    expect(await t.prisma.inspection.count({ where: { projectId: f.projectA.id, activityId: a.id, closing: true } })).toBe(1);
    const claimed = await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } });
    expect(claimed.status).toBe('awaiting_signoff');
    expect(claimed.completionRequestedById).not.toBeNull(); // exactly one recorded claimant

    // race 2: approve vs approve on the closing — one decision wins
    const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, activityId: a.id, closing: true } });
    b = barrierOn('inspection', closing.id);
    try {
      const [r1, r2] = await Promise.all([
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closing.id}/decide`, { approve: true }),
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${closing.id}/decide`, { approve: true }),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    } finally {
      b.restore();
    }
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('done');

    // race 3: approve vs reject on a fresh claim — ONE outcome, never both
    const two = await claimedActivity('Race mixed signoff');
    b = barrierOn('inspection', two.closingId);
    try {
      const [r1, r2] = await Promise.all([
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${two.closingId}/decide`, { approve: true }),
        as(pmcToken)(`/projects/${f.projectA.id}/inspections/${two.closingId}/decide`, { approve: false, rejectedItemNames: ['Work complete and acceptable'] }),
      ]);
      expect(b.reads()).toBe(2);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    } finally {
      b.restore();
    }
    const outcome = await t.prisma.activity.findUniqueOrThrow({ where: { id: two.activityId } });
    const children = await t.prisma.inspection.count({ where: { reinspectionOfId: two.closingId } });
    // approve won → done + no child; reject won → in_progress + one child — never a mixture
    expect(
      (outcome.status === 'done' && children === 0) || (outcome.status === 'in_progress' && children === 1),
    ).toBe(true);
  });

  it('FORGERY probe: a completion claim naming a member of ANOTHER project is rejected by PostgreSQL (composite FK)', async () => {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name: 'Forge claim', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Forge claim' } });

    // otherUser holds a membership ONLY on project B — the claim cannot name them here
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "Activity" SET "completionRequestedById" = $1 WHERE "id" = $2`,
      f.otherUser.id, a.id,
    )).rejects.toThrow(/violates foreign key constraint/);
  });
});
