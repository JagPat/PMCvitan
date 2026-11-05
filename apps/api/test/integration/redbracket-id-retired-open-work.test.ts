import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Redbracket ID A4b-2 — the operator door's list of retired accounts counts the OPEN WORK still named on each one, per
 * live project, each kind answered by its owning module (inspections, requirements, consultations, drawings), and keeps
 * an account listed until its seats and its open work are both zero. It ends A4b's residual "Open work named on the
 * retired row stays on it" (the re-seat moves it by hand; this list now shows what is left).
 *
 * World (planted, because a retired account cannot act and most of these rows are written by commands it would run):
 * a retired engineer R still seated on project A, with open items of each kind and, beside each, items that must not
 * count because R no longer blocks them or the re-seat could never clear them (Stage 1 gap-check: a submitted
 * assignment, a requirement of finished work, a consultation whose consultee seat is gone); a LIVE engineer L named on
 * an open inspection, who is never listed. The re-seat then removes R's seat and moves or closes the work.
 */
describe('Redbracket ID A4b-2 — open work named on retired accounts (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let projectName = '';
  const OPS = 'rbid-a4b2-ops-token-0123456789abcdef';
  const savedOps = process.env.OPS_TOKEN;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `a4b2-${label}-${run}`;
  const R = id('retired');
  const L = id('live');
  const ids = {
    rSeat: id('rseat'), lSeat: id('lseat'), activity: id('act'), activityDone: id('act-done'), reqDone: id('req-done'),
    inspSubmitted: id('insp-submitted'), inspSubmittedResp: id('insp-submitted-resp'),
    inspOpen: id('insp-open'), inspApproved: id('insp-approved'), inspRejected: id('insp-rejected'), inspReinspect: id('insp-re'), inspLive: id('insp-live'),
    reqOpen: id('req-open'), reqCancelled: id('req-cancelled'),
    decision: id('dec'), named: id('dec-named'), namedApproved: id('dec-named-done'), visitOpen: randomUUID(), visitEnded: randomUUID(), cmdOpen: id('cmd-open'), cmdAnswered: id('cmd-answered'), cmdStale: id('cmd-stale'), cmdResponse: id('cmd-resp'),
    consOpen: id('cons-open'), consAnswered: id('cons-answered'), consStale: id('cons-stale'), response: id('resp'),
    drawing: id('dwg'), drawing2: id('dwg2'), revWaiting: id('rev-waiting'), revSuperseded: id('rev-superseded'), revAcked: id('rev-acked'),
  };

  type OpenWork = { projectId: string; projectName: string; inspections: number; requirements: number; decisions: number; consultations: number; drawings: number; siteVisits: number };
  type Retired = { userId: string; name: string; email: string; projects: unknown[]; companies: unknown[]; openWork: OpenWork[] };
  const retiredList = async (): Promise<Retired[]> => {
    const r = await request(t.app.getHttpServer()).get('/ops/people').set('Authorization', `Bearer ${OPS}`);
    expect(r.status, r.text).toBe(200);
    return r.body.retired as Retired[];
  };
  /** Plant (or close) rows the way history holds them: one transaction with the seals and FK triggers off. */
  const planted = async (statements: Array<[string, ...unknown[]]>) => {
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const [sql, ...args] of statements) await tx.$executeRawUnsafe(sql, ...args);
    });
  };

  beforeAll(async () => {
    process.env.OPS_TOKEN = OPS;
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    projectName = (await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id } })).name;
    const P = f.projectA.id;
    const author = f.memberUser.id;
    await planted([
      // the two engineers, both seated; R is retired
      [`INSERT INTO "User" ("id","projectId","role","name","email") VALUES ($1,$2,'engineer','A4b-2 retired',$3), ($4,$2,'engineer','A4b-2 live',$5)`, R, P, `${R}@test.local`, L, `${L}@test.local`],
      [`INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ($1,$2,$3,'engineer','active'), ($4,$2,$5,'engineer','active')`, ids.rSeat, P, R, ids.lSeat, L],
      [`INSERT INTO "IdentityRetirement" ("userId","email") VALUES ($1,$2)`, R, `${R}@test.local`],
      // inspections. Counted: an unsubmitted one (assignee R AND responsible R: one item), the open re-inspection of a
      // rejected one (assigned R, unsubmitted), and a submitted one naming R RESPONSIBLE (the responsible arm holds at any
      // stage of an unapproved lineage). Not counted: the approved one, the rejected parent and a submitted checklist
      // (their assignee has nothing left to do, and no command moves an assignee), and L's open one
      [`INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","submitted","decided","assigneeId","responsibleMemberId","responsibleStandingMark","reinspectionOfId") VALUES
          ($1,$6,'checklist','open','Z','01 Jan 2026',false,false,$7,$7,0,NULL),
          ($2,$6,'review','approved','Z','01 Jan 2026',true,true,$7,NULL,NULL,NULL),
          ($3,$6,'review','rejected','Z','01 Jan 2026',true,true,$7,NULL,NULL,NULL),
          ($4,$6,'checklist','re-inspection','Z','01 Jan 2026',false,false,$7,NULL,NULL,$3),
          ($5,$6,'checklist','live','Z','01 Jan 2026',false,false,$8,NULL,NULL,NULL),
          ($9,$6,'review','submitted','Z','01 Jan 2026',true,false,$7,NULL,NULL,NULL),
          ($10,$6,'review','submitted, R responsible','Z','01 Jan 2026',true,false,NULL,$7,0,NULL)`,
        ids.inspOpen, ids.inspApproved, ids.inspRejected, ids.inspReinspect, ids.inspLive, P, R, L, ids.inspSubmitted, ids.inspSubmittedResp],
      // requirements: one whose latest revision is open and names R; one named R at revision 1 and cancelled at 2; and
      // one still open and naming R on a DONE activity (finished work waits on nobody)
      [`INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status") VALUES ($1,$3,'A4b-2 activity','Z',0,1,'in_progress'), ($2,$3,'A4b-2 done activity','Z',0,1,'done')`, ids.activity, ids.activityDone, P],
      [`INSERT INTO "ActivityRequirementRoot" ("id","projectId","createdById") VALUES ($1,$4,$5), ($2,$4,$5), ($3,$4,$5)`, ids.reqOpen, ids.reqCancelled, ids.reqDone, P, author],
      [`INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","requiredQty","baseUom","requiredBy","responsibleId","status","createdById") VALUES ($1,$2,$3,1,$4,1,'nos','2026-12-01',$5,'open',$6)`,
        `${ids.reqDone}-1`, P, ids.reqDone, ids.activityDone, R, author],
      [`INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","requiredQty","baseUom","requiredBy","responsibleId","status","createdById") VALUES
          ($1,$4,$5,1,$7,1,'nos','2026-12-01',$8,'open',$9),
          ($2,$4,$6,1,$7,1,'nos','2026-12-01',$8,'open',$9),
          ($3,$4,$6,2,$7,1,'nos','2026-12-01',$8,'cancelled',$9)`,
        `${ids.reqOpen}-1`, `${ids.reqCancelled}-1`, `${ids.reqCancelled}-2`, P, ids.reqOpen, ids.reqCancelled, ids.activity, R, author],
      // consultations on a published pending decision (0 finalized approvals): open, answered, and one frozen in another cycle
      [`INSERT INTO "Decision" ("id","projectId","title","room","status","deciderKind","photoSwatch","publishedAt") VALUES ($1,$2,'A4b-2 decision','Kitchen','pending','pmc','sw1',now())`, ids.decision, P],
      [`INSERT INTO "CommandExecution" ("id","organizationId","projectId","scopeKind","actorId","commandType","idempotencyKey","requestHash","status") VALUES
          ($1,$8,$5,'project',$6,'decisions.consult',$1,'h','succeeded'), ($2,$8,$5,'project',$6,'decisions.consult',$2,'h','succeeded'),
          ($3,$8,$5,'project',$6,'decisions.consult',$3,'h','succeeded'), ($4,$8,$5,'project',$7,'decisions.respond',$4,'h','succeeded')`,
        ids.cmdOpen, ids.cmdAnswered, ids.cmdStale, ids.cmdResponse, P, author, R, f.orgA.id],
      [`INSERT INTO "DecisionConsultation" ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","sourceCommandId") VALUES
          ($1,$4,$5,$6,$7,$8,'open?',0,$9), ($2,$4,$5,$6,$7,$8,'answered?',0,$10), ($3,$4,$5,$6,$7,$8,'stale?',1,$11)`,
        ids.consOpen, ids.consAnswered, ids.consStale, P, ids.decision, author, ids.rSeat, R, ids.cmdOpen, ids.cmdAnswered, ids.cmdStale],
      [`INSERT INTO "DecisionConsultationResponse" ("id","projectId","consultationId","decisionId","respondedById","response","sourceCommandId") VALUES ($1,$2,$3,$4,$5,'advice',$6)`,
        ids.response, P, ids.consAnswered, ids.decision, R, ids.cmdResponse],
      // decisions naming R's membership as decider: one pending (open), one withdrawn (closed); and site visits: R's
      // open visit (only its visitor can end it) and an ended one
      [`INSERT INTO "Decision" ("id","projectId","title","room","status","deciderKind","deciderMembershipId","photoSwatch","publishedAt") VALUES
          ($1,$3,'A4b-2 named','Kitchen','pending','member',$4,'sw1',now()), ($2,$3,'A4b-2 named done','Kitchen','withdrawn','member',$4,'sw1',now())`,
        ids.named, ids.namedApproved, P, ids.rSeat],
      [`INSERT INTO "SiteVisit" ("id","projectId","visitorId","visitorRole","visitorName","startClaimedAt","startedAt","startReceivedAt","locationKind","status") VALUES
          ($1,$2,$3,'consultant','A4b-2 retired',now(),now(),now(),'none','open')`, ids.visitOpen, P, R],
      [`INSERT INTO "SiteVisit" ("id","projectId","visitorId","visitorRole","visitorName","startClaimedAt","startedAt","startReceivedAt","locationKind","status","endClaimedAt","endedAt","endReceivedAt","endTimeAdjusted") VALUES
          ($1,$2,$3,'consultant','A4b-2 retired',now(),now(),now(),'none','ended',now(),now(),now(),false)`, ids.visitEnded, P, R],
      // drawings: a governing revision waiting on R; a superseded one naming R; a governing one R acknowledged
      [`INSERT INTO "Drawing" ("id","projectId","number","title","discipline") VALUES ($1,$3,'A-1','A4b-2 drawing','arch'), ($2,$3,'A-2','A4b-2 drawing 2','arch')`, ids.drawing, ids.drawing2, P],
      [`INSERT INTO "DrawingRevision" ("id","projectId","drawingId","rev","status","mime","issuedBy","issuedAt") VALUES
          ($1,$4,$5,'B','for_construction','application/pdf','PMC','01 Jan 2026'),
          ($2,$4,$5,'A','superseded','application/pdf','PMC','01 Jan 2026'),
          ($3,$4,$6,'A','for_construction','application/pdf','PMC','01 Jan 2026')`,
        ids.revWaiting, ids.revSuperseded, ids.revAcked, P, ids.drawing, ids.drawing2],
      [`INSERT INTO "DrawingRecipient" ("id","projectId","revisionId","userId","roleAtIssue") VALUES ($1,$4,$5,$8,'engineer'), ($2,$4,$6,$8,'engineer'), ($3,$4,$7,$8,'engineer')`,
        id('rcp1'), id('rcp2'), id('rcp3'), P, ids.revWaiting, ids.revSuperseded, ids.revAcked, R],
      [`INSERT INTO "DrawingAck" ("id","revisionId","userId","userName","role") VALUES ($1,$2,$3,'A4b-2 retired','engineer')`, id('ack1'), ids.revAcked, R],
    ]);
  });

  afterAll(async () => {
    if (t) {
      await planted([
        [`DELETE FROM "DrawingAck" WHERE "userId" = $1`, R],
        [`DELETE FROM "DrawingRecipient" WHERE "userId" = $1`, R],
        [`DELETE FROM "DrawingRevision" WHERE "drawingId" = ANY($1::text[])`, [ids.drawing, ids.drawing2]],
        [`DELETE FROM "Drawing" WHERE "id" = ANY($1::text[])`, [ids.drawing, ids.drawing2]],
        [`DELETE FROM "DecisionConsultationResponse" WHERE "decisionId" = $1`, ids.decision],
        [`DELETE FROM "DecisionConsultation" WHERE "decisionId" = $1`, ids.decision],
        [`DELETE FROM "CommandExecution" WHERE "id" = ANY($1::text[])`, [ids.cmdOpen, ids.cmdAnswered, ids.cmdStale, ids.cmdResponse]],
        [`DELETE FROM "Decision" WHERE "id" = ANY($1::text[])`, [ids.decision, ids.named, ids.namedApproved]],
        [`DELETE FROM "SiteVisit" WHERE "id" = ANY($1::text[])`, [ids.visitOpen, ids.visitEnded]],
        [`DELETE FROM "ActivityRequirement" WHERE "activityId" = ANY($1::text[])`, [ids.activity, ids.activityDone]],
        [`DELETE FROM "ActivityRequirementRoot" WHERE "id" = ANY($1::text[])`, [ids.reqOpen, ids.reqCancelled, ids.reqDone]],
        [`DELETE FROM "Activity" WHERE "id" = ANY($1::text[])`, [ids.activity, ids.activityDone]],
        [`DELETE FROM "Inspection" WHERE "projectId" = $1 AND "id" LIKE $2`, f.projectA.id, `a4b2-%-${run}`],
        [`DELETE FROM "IdentityRetirement" WHERE "userId" = $1`, R],
        [`DELETE FROM "Membership" WHERE "userId" = ANY($1::text[])`, [R, L]],
        [`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [R, L]],
      ]);
      await f.cleanup();
      await t.close();
    }
    if (savedOps === undefined) delete process.env.OPS_TOKEN; else process.env.OPS_TOKEN = savedOps;
  });

  it('a retired account is listed with its open work, each kind counted by its owner; work it no longer blocks, closed work and live accounts are not counted', async () => {
    const list = await retiredList();
    expect(list.map((r) => r.userId)).not.toContain(L); // a live account is never listed, whatever is named on it
    const row = list.find((r) => r.userId === R);
    expect(row, 'the retired account is listed').toBeDefined();
    expect(row!.projects.map((p) => (p as { id: string }).id)).toEqual([f.projectA.id]);
    expect(row!.name).toBe('A4b-2 retired');
    expect(row!.openWork).toEqual([{
      projectId: f.projectA.id,
      projectName,
      // the unsubmitted one (named twice, counted once), the open re-inspection, the submitted one R is responsible
      // for; not the approved one, the rejected parent or the submitted checklist R was only assigned
      inspections: 3,
      requirements: 1, // not the cancelled one's earlier revision, nor the one on the done activity
      decisions: 1, // the withdrawn one names R's membership too, and does not count
      consultations: 1, // the answered one and the one asked in another cycle do not count
      drawings: 1, // the superseded and the acknowledged revisions do not count
      siteVisits: 1, // the ended visit does not count
    }]);
  });

  it('the re-seat: with the seat removed, an unanswerable consultation stops counting and the row stays listed by its open work alone; it leaves when none is left', async () => {
    const P = f.projectA.id;
    await planted([
      [`UPDATE "Membership" SET "status" = 'removed' WHERE "id" = $1`, ids.rSeat],
      [`UPDATE "Inspection" SET "decided" = true, "submitted" = true WHERE "id" = ANY($1::text[])`, [ids.inspOpen, ids.inspReinspect, ids.inspSubmittedResp]],
      [`INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","requiredQty","baseUom","requiredBy","responsibleId","status","createdById") VALUES ($1,$2,$3,2,$4,1,'nos','2026-12-01',$5,'open',$5)`,
        `${ids.reqOpen}-2`, P, ids.reqOpen, ids.activity, f.memberUser.id], // the re-seat names someone else
    ]);
    const after = (await retiredList()).find((r) => r.userId === R);
    expect(after, 'still listed: open work names it').toBeDefined();
    expect(after!.projects).toEqual([]);
    expect(after!.name).toBe(`${R}@test.local`); // no seat to name it: the address it was retired from
    // the consultation's consultee seat is gone, so it can never be answered: it is settled at the decision, not here
    expect(after!.openWork).toEqual([{ projectId: P, projectName, inspections: 0, requirements: 0, decisions: 1, consultations: 0, drawings: 1, siteVisits: 1 }]);

    await planted([
      [`INSERT INTO "DrawingAck" ("id","revisionId","userId","userName","role") VALUES ($1,$2,$3,'A4b-2 retired','engineer')`, id('ack2'), ids.revWaiting, R],
      [`UPDATE "Decision" SET "status" = 'withdrawn' WHERE "id" = ANY($1::text[])`, [ids.decision, ids.named]],
      [`UPDATE "SiteVisit" SET "status" = 'ended', "endClaimedAt" = now(), "endedAt" = now(), "endReceivedAt" = now(), "endTimeAdjusted" = false WHERE "id" = $1`, ids.visitOpen],
    ]);
    expect((await retiredList()).map((r) => r.userId)).not.toContain(R);
  });
});
