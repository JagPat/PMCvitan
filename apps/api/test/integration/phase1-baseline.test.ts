import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 — INTEGRATION CHARACTERIZATION against live PostgreSQL. One flow per
 * pillar, exactly as the server behaves. Task 1 wrote these at the baseline
 * (main @ 5b101d6); each later task updates ITS pillar in the same PR that
 * changes the behavior. Decision rows reflect Task 2 (change control): approval
 * locks with real identity, exactly one OPEN change request may exist (CAS +
 * partial unique index), and re-approval resolves it. Still pinned as baseline
 * for Tasks 3/4/5:
 *   - reject decides the same row and creates NO reinspection (Task 4);
 *   - complete writes done immediately; the closing inspection has zero items (Task 5);
 *   - a published for_review revision supersedes the for_construction set and
 *     the snapshot serves it as `current` (Task 3).
 */
describe('phase 1 baseline characterization (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc on project A
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.$transaction([
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } }),
      t.prisma.inspection.deleteMany({ where: { projectId } }),
      t.prisma.activity.deleteMany({ where: { projectId } }),
      t.prisma.decision.deleteMany({ where: { projectId } }),
      t.prisma.drawingAck.deleteMany({ where: { revision: { drawing: { projectId } } } }),
      t.prisma.drawingRevision.deleteMany({ where: { drawing: { projectId } } }),
      t.prisma.drawing.deleteMany({ where: { projectId } }),
    ]);
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);

  const decisionInput = (title: string) => ({
    title,
    room: 'Kitchen',
    options: [
      { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
      { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
    ],
    publish: true,
  });

  it('decision pillar: approve locks (409) with real identity — a change request reopens, re-approval RESOLVES it (Task 2)', async () => {
    expect((await post(`/projects/${f.projectA.id}/decisions`, decisionInput('Counter top'))).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Counter top' } });

    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    // locked: a second approval conflicts
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 1 })).status).toBe(409);
    // the recorded approver is the caller's REAL name (fixture user is named 'member'),
    // with id + on-behalf marker — a PMC approving records the client's consent openly
    const locked = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(locked.approver).toBe('member');
    expect(locked.approvedById).toBe(f.memberUser.id);
    expect(locked.onBehalfOf).toBe('client');

    // the change flow reopens the lock…
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'Out of stock', costImpact: 0, timeImpactDays: 2 })).status).toBe(201);
    const reopened = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(reopened.status).toBe('change');
    // …through an OPEN, attributed ChangeRequest
    const cr = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(cr.status).toBe('open');
    expect(cr.requestedById).toBe(f.memberUser.id);

    // mandatory re-approval closes the reopening, attributably
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 1 })).status).toBe(201);
    const resolved = await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: cr.id } });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('reapproved');
    expect(resolved.resolvedById).toBe(f.memberUser.id);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it('CONCURRENCY: two simultaneous change requests have exactly ONE winner — CAS + partial unique index (Task 2)', async () => {
    expect((await post(`/projects/${f.projectA.id}/decisions`, decisionInput('Bath tiles'))).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Bath tiles' } });
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);

    // Test-only BARRIER around the service's pre-read: both requests must observe
    // the SAME approved row before either transaction commits, making the race —
    // and therefore this characterization — deterministic instead of schedule-
    // dependent. Only the two decision.findUnique calls for THIS decision are
    // held; the app, HTTP surface and PostgreSQL stay fully real. The delegate
    // method is restored in the finally block. (Prisma caches the delegate object,
    // so patching the method on it is effective for the app's PrismaService.)
    const delegate = t.prisma.decision as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
    const original = delegate.findUnique.bind(t.prisma.decision);
    let release!: () => void;
    const bothHaveRead = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    delegate.findUnique = async (args: { where: { id?: string } }) => {
      const row = await original(args);
      if (args?.where?.id === d.id) {
        reads += 1;
        if (reads === 2) release();
        await bothHaveRead; // hold BOTH pre-reads until the second has its row
      }
      return row;
    };

    try {
      const [r1, r2] = await Promise.all([
        post(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'racer one', costImpact: 0, timeImpactDays: 0 }),
        post(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'racer two', costImpact: 0, timeImpactDays: 0 }),
      ]);

      // both requests passed the pre-read status guard on the same approved row,
      // but the CAS transition admits exactly one into the changeRequest.create —
      // the loser gets a deterministic 409 and exactly ONE open request persists
      expect(reads).toBe(2); // the barrier really coordinated both pre-reads
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      expect(await t.prisma.changeRequest.count({ where: { decisionId: d.id } })).toBe(1);
      expect(await t.prisma.decisionEvent.count({ where: { decisionId: d.id, type: 'change_requested' } })).toBe(1);
    } finally {
      delegate.findUnique = original;
    }
  });

  it('SUPPLEMENT: the DATABASE itself refuses a second open change request (partial unique index, Task 2)', async () => {
    // deterministic direct-insert proof of the invariant, independent of any request
    // scheduling or service code — the index is the backstop even for raw writes
    expect((await post(`/projects/${f.projectA.id}/decisions`, decisionInput('Veneer finish'))).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Veneer finish' } });
    await t.prisma.changeRequest.create({ data: { decisionId: d.id, reason: 'first open', costImpact: 0, timeImpactDays: 0 } });
    await expect(
      t.prisma.changeRequest.create({ data: { decisionId: d.id, reason: 'second open', costImpact: 0, timeImpactDays: 0 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    const rows = await t.prisma.changeRequest.findMany({ where: { decisionId: d.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open'); // the new default — a request is born open
  });

  it('drawing pillar: a published for_review issue supersedes the for_construction set and the snapshot serves it as current (changed by Task 3)', async () => {
    const pdf = Buffer.from('%PDF-1.4 phase1 baseline').toString('base64');
    // Rev A — the construction set the field builds from
    expect((await post(`/projects/${f.projectA.id}/drawings`, {
      number: 'A-901', title: 'Baseline Plan', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: pdf, publish: true,
    })).status).toBe(201);
    // Rev B — a REVIEW copy of the same drawing
    expect((await post(`/projects/${f.projectA.id}/drawings`, {
      number: 'A-901', title: 'Baseline Plan', discipline: 'architectural', rev: 'B', status: 'for_review', mime: 'application/pdf', data: pdf,
    })).status).toBe(201);

    // the DATABASE marks the construction rev superseded by the review copy
    const drawing = await t.prisma.drawing.findUniqueOrThrow({
      where: { projectId_number: { projectId: f.projectA.id, number: 'A-901' } },
      include: { revisions: true },
    });
    expect(drawing.revisions.find((r) => r.rev === 'A')!.status).toBe('superseded');
    expect(drawing.revisions.find((r) => r.rev === 'B')!.status).toBe('for_review');

    // and the API snapshot serializes the review copy as the CURRENT revision —
    // today `current` is latest-non-superseded regardless of status, so a review
    // copy governs the field (Task 3 makes `current` for_construction-or-null)
    const snap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`);
    expect(snap.status).toBe(200);
    const dto = (snap.body.drawings as Array<{ number: string; current: { rev: string; status: string } | null }>).find((x) => x.number === 'A-901');
    expect(dto?.current?.rev).toBe('B');
    expect(dto?.current?.status).toBe('for_review');
  });

  it('inspection pillar: reject decides the SAME row — no reinspection row, no due date, no assignee', async () => {
    expect((await post(`/projects/${f.projectA.id}/inspections`, { title: 'Ponding test', zone: 'Terrace', items: ['Drain slope'] })).status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Ponding test' } });
    const countBefore = await t.prisma.inspection.count({ where: { projectId: f.projectA.id } });

    expect((await post(`/projects/${f.projectA.id}/inspections/${insp.id}/submit`, { items: [{ name: 'Drain slope', state: 'fail', photos: 1, note: 'pooling NE corner' }] })).status).toBe(201);
    expect((await post(`/projects/${f.projectA.id}/inspections/${insp.id}/decide`, { approve: false, rejectedItemNames: ['Drain slope'] })).status).toBe(201);

    // the "re-inspection task(s) created with due dates" notice has no backing row:
    expect(await t.prisma.inspection.count({ where: { projectId: f.projectA.id } })).toBe(countBefore);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id }, include: { items: true } });
    expect(after.decided).toBe(true); // terminal — the rejection lives and dies on this row
    expect(after.items[0].rejected).toBe(true);
    expect(after.by).toBeNull(); // submit recorded no submitter identity
  });

  it('activity pillar: complete writes done IMMEDIATELY and the zero-item closing inspection is merely queued', async () => {
    expect((await post(`/projects/${f.projectA.id}/activities`, { name: 'Skirting', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Skirting' } });

    expect((await post(`/projects/${f.projectA.id}/activities/${a.id}/start`, {})).status).toBe(201);
    expect((await post(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {})).status).toBe(201);

    // done is unconditional — no sign-off state exists between claim and acceptance
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('done');
    const closing = await t.prisma.inspection.findUniqueOrThrow({ where: { id: `INSP-${a.id}-close` }, include: { items: true } });
    expect(closing.kind).toBe('review');
    expect(closing.submitted).toBe(true);
    expect(closing.decided).toBe(false); // the activity is already done while this waits
    expect(closing.items).toHaveLength(0); // zero items → it can only ever be approved
    // rejecting the zero-item closing is impossible (the Task 5 trap this pins)
    expect((await post(`/projects/${f.projectA.id}/inspections/${closing.id}/decide`, { approve: false, rejectedItemNames: [] })).status).toBe(400);
  });
});
