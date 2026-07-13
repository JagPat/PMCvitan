import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 Task 3 — the controlled drawing lifecycle contract, proven against
 * live PostgreSQL (written BEFORE the implementation, per the plan):
 *   - a for_review issue supersedes NOTHING; for_construction supersedes only
 *     the prior for_construction set;
 *   - `current` (the governing revision) is for_construction-or-null — a
 *     drawing whose only revisions are review copies serializes current: null;
 *   - recipients are FROZEN at issue as database rows (active engineer/
 *     contractor members at that moment, stamped even when the set is empty);
 *     membership churn never rewrites them;
 *   - duplicate (drawingId, rev) labels are refused (409 / DB unique);
 *   - the recipient rows are tenant-constrained: PostgreSQL itself rejects a
 *     forged recipient naming another project's revision or a non-member;
 *   - issue/revise/ack are audited with the caller's real identity.
 */
describe('drawing change control (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc on project A
    // the build team on project A: an engineer and a contractor (active members)
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
    await t.prisma.drawingRecipient.deleteMany({ where: { projectId } });
    await t.prisma.drawingAck.deleteMany({ where: { revision: { drawing: { projectId } } } });
    await t.prisma.drawingRevision.deleteMany({ where: { drawing: { projectId } } });
    await t.prisma.drawing.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({
      where: { projectId, userId: { in: [f.ownerUser.id, f.strangerUser.id] } },
    });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const pdf = Buffer.from('%PDF-1.4 task3').toString('base64');
  const issueBody = (number: string, rev: string, status: string, extra: object = {}) => ({
    number, title: 'Controlled Plan', discipline: 'architectural', rev, status, mime: 'application/pdf', data: pdf, publish: true, ...extra,
  });
  const snapshot = async () => {
    const res = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { drawings: Array<{ number: string; current: { rev: string; status: string } | null; revisions: Array<{ rev: string; status: string }> }> };
  };

  /** Test-only barrier on the ACTOR pre-read (user.findUnique) — a rendezvous both
   *  requests pass through before the racing section, effective before AND after the
   *  fix (the fix removes the drawing pre-read, so the barrier lives upstream of it). */
  function actorBarrier(userId: string) {
    const delegate = t.prisma.user as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
    const original = delegate.findUnique.bind(t.prisma.user);
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    delegate.findUnique = async (args: { where: { id?: string } }) => {
      const row = await original(args);
      if (args?.where?.id === userId) {
        reads += 1;
        if (reads === 2) release();
        await both;
      }
      return row;
    };
    return { restore: () => { delegate.findUnique = original; }, reads: () => reads };
  }

  it('GATE FINDING 2: concurrent construction issues leave exactly ONE governing revision', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-310', 'A', 'for_construction'))).status).toBe(201);

    // both racers rendezvous on the actor pre-read, then hit the same drawing together
    const b = actorBarrier(f.memberUser.id);
    let r1, r2;
    try {
      [r1, r2] = await Promise.all([
        post(`/projects/${f.projectA.id}/drawings`, issueBody('A-310', 'B', 'for_construction')),
        post(`/projects/${f.projectA.id}/drawings`, issueBody('A-310', 'C', 'for_construction')),
      ]);
    } finally {
      b.restore();
    }
    expect(b.reads()).toBe(2); // the race really was simultaneous
    for (const r of [r1, r2]) expect([201, 409]).toContain(r.status);

    // the invariant: whatever the interleaving, ONE live for_construction revision
    const d = await t.prisma.drawing.findUniqueOrThrow({
      where: { projectId_number: { projectId: f.projectA.id, number: 'A-310' } },
      include: { revisions: true },
    });
    const live = d.revisions.filter((r) => r.status === 'for_construction');
    expect(live).toHaveLength(1);
  });

  it('GATE FINDING 2b: concurrent publishes of one draft have exactly one winner (no duplicate publication)', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-314', 'A', 'for_construction', { publish: false }))).status).toBe(201);
    const d = await t.prisma.drawing.findUniqueOrThrow({ where: { projectId_number: { projectId: f.projectA.id, number: 'A-314' } } });

    const b = actorBarrier(f.memberUser.id);
    let r1, r2;
    try {
      [r1, r2] = await Promise.all([
        post(`/projects/${f.projectA.id}/drawings/${d.id}/publish`, {}),
        post(`/projects/${f.projectA.id}/drawings/${d.id}/publish`, {}),
      ]);
    } finally {
      b.restore();
    }
    expect([r1.status, r2.status].sort()).toEqual([201, 409]); // one publication, not two
    expect(await t.prisma.auditLog.count({ where: { action: 'drawing.publish', entityId: d.id } })).toBe(1);
  });

  it('GATE FINDING 3: replaying an ack is a command no-op — one ack row AND one audit row', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-311', 'A', 'for_construction'))).status).toBe(201);
    const rev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'A-311' } } });
    const engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');

    const first = await http().post(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`).set('Authorization', `Bearer ${engToken}`).send();
    expect(first.status).toBe(201);
    const replay = await http().post(`/projects/${f.projectA.id}/drawings/rev/${rev.id}/ack`).set('Authorization', `Bearer ${engToken}`).send();
    expect(replay.status).toBe(201); // replay-safe: same result shape
    expect(replay.body).toMatchObject({ ok: true, ackCount: 1 });

    expect(await t.prisma.drawingAck.count({ where: { revisionId: rev.id } })).toBe(1);
    // the audit is written WITH the ack, exactly once — a replay records nothing new
    expect(await t.prisma.auditLog.count({ where: { action: 'drawing.ack', entityId: rev.id } })).toBe(1);
  });

  it('GATE FINDING 4: a legacy revision (recipientsFrozenAt null) OMITS recipientOfCurrent — the client fallback engages', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-312', 'A', 'for_construction'))).status).toBe(201);
    const rev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'A-312' } } });
    // devolve it to the migrated-legacy state: no snapshot ever ran
    await t.prisma.drawingRecipient.deleteMany({ where: { revisionId: rev.id } });
    await t.prisma.drawingRevision.update({ where: { id: rev.id }, data: { recipientsFrozenAt: null } });

    const engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');
    const snap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${engToken}`);
    expect(snap.status).toBe(200);
    const dto = (snap.body.drawings as Array<Record<string, unknown> & { number: string }>).find((x) => x.number === 'A-312');
    expect(dto).toBeDefined();
    // ABSENT, not false — false would silently drop every pre-Task-3 drawing from ack nudges
    expect('recipientOfCurrent' in dto!).toBe(false);
  });

  it('GATE FINDING 5: one-step publish of an existing multi-revision draft freezes EVERY live revision', async () => {
    // a private draft accumulates revisions before it reaches the team
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-313', 'A', 'for_construction', { publish: false }))).status).toBe(201);
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-313', 'B', 'for_review', { publish: false }))).status).toBe(201);
    // ...then a third issue publishes in ONE step through issue(..., publish: true)
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-313', 'C', 'for_review', { publish: true }))).status).toBe(201);

    const d = await t.prisma.drawing.findUniqueOrThrow({
      where: { projectId_number: { projectId: f.projectA.id, number: 'A-313' } },
      include: { revisions: true },
    });
    expect(d.publishedAt).not.toBeNull();
    // published intent has COMPLETE distribution facts: every live revision is frozen
    for (const r of d.revisions.filter((x) => x.status !== 'superseded')) {
      expect(r.recipientsFrozenAt, `rev ${r.rev} must be frozen`).toBeInstanceOf(Date);
    }
  });

  it('a for_review issue supersedes NOTHING; for_construction supersedes only the construction set', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-301', 'A', 'for_construction'))).status).toBe(201);
    // a review copy arrives — the construction set must NOT be displaced
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-301', 'B', 'for_review'))).status).toBe(201);

    const d1 = await t.prisma.drawing.findUniqueOrThrow({
      where: { projectId_number: { projectId: f.projectA.id, number: 'A-301' } },
      include: { revisions: true },
    });
    expect(d1.revisions.find((r) => r.rev === 'A')!.status).toBe('for_construction'); // untouched
    expect(d1.revisions.find((r) => r.rev === 'B')!.status).toBe('for_review'); // coexists

    // the snapshot's governing revision is STILL the construction set
    let dto = (await snapshot()).drawings.find((x) => x.number === 'A-301');
    expect(dto?.current?.rev).toBe('A');
    expect(dto?.current?.status).toBe('for_construction');

    // a new construction issue supersedes ONLY the old construction rev
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-301', 'C', 'for_construction'))).status).toBe(201);
    const d2 = await t.prisma.drawing.findUniqueOrThrow({
      where: { projectId_number: { projectId: f.projectA.id, number: 'A-301' } },
      include: { revisions: true },
    });
    expect(d2.revisions.find((r) => r.rev === 'A')!.status).toBe('superseded');
    expect(d2.revisions.find((r) => r.rev === 'B')!.status).toBe('for_review'); // review copy still coexists
    expect(d2.revisions.find((r) => r.rev === 'C')!.status).toBe('for_construction');
    dto = (await snapshot()).drawings.find((x) => x.number === 'A-301');
    expect(dto?.current?.rev).toBe('C');
  });

  it('a drawing whose only revisions are review copies serializes current: null (never governs the field)', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-302', 'P1', 'for_review'))).status).toBe(201);
    const dto = (await snapshot()).drawings.find((x) => x.number === 'A-302');
    expect(dto).toBeDefined();
    expect(dto!.current).toBeNull();
    expect(dto!.revisions).toHaveLength(1);
  });

  it('recipients are FROZEN at issue: the active engineer/contractor members, stamped; churn never rewrites them', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-303', 'A', 'for_construction'))).status).toBe(201);
    const rev = await t.prisma.drawingRevision.findFirstOrThrow({
      where: { drawing: { projectId: f.projectA.id, number: 'A-303' }, rev: 'A' },
      include: { recipients: true },
    });
    expect(rev.projectId).toBe(f.projectA.id); // backfilled/stamped tenant identity
    expect(rev.recipientsFrozenAt).toBeInstanceOf(Date); // the snapshot RAN
    const byUser = Object.fromEntries(rev.recipients.map((r) => [r.userId, r.roleAtIssue]));
    expect(byUser).toEqual({ [f.ownerUser.id]: 'engineer', [f.strangerUser.id]: 'contractor' });

    // membership churn does NOT rewrite the frozen rows
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.ownerUser.id } },
      data: { status: 'removed' },
    });
    const after = await t.prisma.drawingRecipient.findMany({ where: { revisionId: rev.id } });
    expect(after).toHaveLength(2); // still both — the issue-time fact is preserved
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId: f.projectA.id, userId: f.ownerUser.id } },
      data: { status: 'active' },
    });

    // a revision issued when NO eligible members exist freezes an EMPTY set — but is still stamped
    const bare = t.issueProjectToken(f.otherUser.id, f.projectB.id); // pmc on project B (no engineer/contractor there)
    expect((await http().post(`/projects/${f.projectB.id}/drawings`).set('Authorization', `Bearer ${bare}`).send(issueBody('B-301', 'A', 'for_construction'))).status).toBe(201);
    const bRev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectB.id, number: 'B-301' } }, include: { recipients: true } });
    expect(bRev.recipientsFrozenAt).toBeInstanceOf(Date); // "snapshot ran and was empty" ≠ legacy null
    expect(bRev.recipients).toHaveLength(0);
    await t.prisma.drawingRevision.deleteMany({ where: { drawing: { projectId: f.projectB.id } } });
    await t.prisma.drawing.deleteMany({ where: { projectId: f.projectB.id } });
  });

  it('a duplicate revision label on the same drawing is refused (409) and the DB unique is the backstop', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-304', 'A', 'for_construction'))).status).toBe(201);
    const dup = await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-304', 'A', 'for_construction'));
    expect(dup.status).toBe(409);
    // direct insert: PostgreSQL itself refuses the duplicate label
    const d = await t.prisma.drawing.findUniqueOrThrow({ where: { projectId_number: { projectId: f.projectA.id, number: 'A-304' } } });
    await expect(
      t.prisma.drawingRevision.create({
        data: { projectId: f.projectA.id, drawingId: d.id, rev: 'A', status: 'for_review', mime: 'application/pdf', issuedBy: 'x', issuedAt: 'today' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('FORGERY probes: PostgreSQL rejects a recipient naming another project’s revision, a non-member, or a cross-project revision row', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-305', 'A', 'for_construction'))).status).toBe(201);
    const rev = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'A-305' } } });

    // (a) recipient pointing at project A's revision but claiming project B — the
    // composite FK (projectId, revisionId) finds no such revision identity
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DrawingRecipient" ("id","projectId","revisionId","userId","roleAtIssue") VALUES ('forge-1', $1, $2, $3, 'engineer')`,
        f.projectB.id, rev.id, f.otherUser.id,
      ),
    ).rejects.toThrow(/violates foreign key constraint/);

    // (b) recipient naming a user with NO membership on project A
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DrawingRecipient" ("id","projectId","revisionId","userId","roleAtIssue") VALUES ('forge-2', $1, $2, $3, 'engineer')`,
        f.projectA.id, rev.id, f.otherUser.id,
      ),
    ).rejects.toThrow(/violates foreign key constraint/);

    // (c) a revision row claiming another project than its parent drawing — the
    // containment FK (projectId, drawingId) -> Drawing(projectId, id) refuses it
    const drawing = await t.prisma.drawing.findUniqueOrThrow({ where: { projectId_number: { projectId: f.projectA.id, number: 'A-305' } } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DrawingRevision" ("id","projectId","drawingId","rev","status","mime","issuedBy","issuedAt") VALUES ('forge-3', $1, $2, 'Z', 'for_review', 'application/pdf', 'x', 'today')`,
        f.projectB.id, drawing.id,
      ),
    ).rejects.toThrow(/violates foreign key constraint/);

    // nothing forged persisted
    expect(await t.prisma.drawingRecipient.count({ where: { id: { in: ['forge-1', 'forge-2'] } } })).toBe(0);
  });

  it('issue, revise and ack are audited with the caller’s REAL identity', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-306', 'A', 'for_construction'))).status).toBe(201);
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-306', 'B', 'for_construction'))).status).toBe(201);
    const revB = await t.prisma.drawingRevision.findFirstOrThrow({ where: { drawing: { projectId: f.projectA.id, number: 'A-306' }, rev: 'B' } });

    const engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');
    expect((await http().post(`/projects/${f.projectA.id}/drawings/rev/${revB.id}/ack`).set('Authorization', `Bearer ${engToken}`).send()).status).toBe(201);

    const audits = await t.prisma.auditLog.findMany({
      where: { projectId: f.projectA.id, action: { in: ['drawing.issue', 'drawing.revise', 'drawing.ack'] } },
      orderBy: { at: 'asc' },
    });
    const issue = audits.find((a) => a.action === 'drawing.issue');
    const revise = audits.find((a) => a.action === 'drawing.revise');
    const ack = audits.find((a) => a.action === 'drawing.ack');
    expect(issue?.actorId).toBe(f.memberUser.id);
    expect(issue?.actor).toBe('member'); // the real display name, not a role label
    expect(revise?.actorId).toBe(f.memberUser.id);
    expect(ack?.actorId).toBe(f.ownerUser.id);
    expect(ack?.actor).toBe('owner');
    // GATE FINDING 6 (drawing side): the role held at action time is persisted too
    expect(issue?.actorRole).toBe('pmc');
    expect(revise?.actorRole).toBe('pmc');
    expect(ack?.actorRole).toBe('engineer');
  });

  it('the snapshot tells the viewer whether THEY are a recipient of the governing revision', async () => {
    expect((await post(`/projects/${f.projectA.id}/drawings`, issueBody('A-307', 'A', 'for_construction'))).status).toBe(201);

    // the engineer IS a frozen recipient
    const engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');
    const engSnap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${engToken}`);
    expect(engSnap.status).toBe(200);
    const engDto = (engSnap.body.drawings as Array<{ number: string; recipientOfCurrent: boolean; current: { recipients: Array<{ userName: string; role: string; acked: boolean }> } }>).find((x) => x.number === 'A-307');
    expect(engDto?.recipientOfCurrent).toBe(true);
    // and the distribution list itself is serialized (name + role + ack state)
    const dist = engDto?.current.recipients ?? [];
    expect(dist.map((r) => [r.userName, r.role, r.acked]).sort()).toEqual([
      ['owner', 'engineer', false],
      ['stranger', 'contractor', false],
    ]);

    // the PMC issued it but was NOT frozen into the distribution
    const pmcSnap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`);
    const pmcDto = (pmcSnap.body.drawings as Array<{ number: string; recipientOfCurrent: boolean }>).find((x) => x.number === 'A-307');
    expect(pmcDto?.recipientOfCurrent).toBe(false);
  });
});
