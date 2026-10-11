import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { readViewerFeed, servedNotifications } from '../../src/snapshot/served-notifications';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import type { Role } from '../../src/common/auth';

/**
 * Top 10 #4b unit B (#778) — CHARACTERIZATION of which notices the feed serves to each viewer.
 *
 * Unit B moves the snapshot's per-viewer notice filter into one shared definition, which unit C's
 * mark endpoint will also use. It is a refactor, so this suite pins what every role is served
 * BEFORE the move, captured on `cb9386d`, and must pass unchanged after it:
 *
 * - one feed exercises every branch of the filter: kinded notices rendered from their events
 *   (published, approved, withdrawn), kind-less pending notices (unlinked, client-held,
 *   member-held), a kind-less withdrawal, notices naming a decided, a draft and no decision, and an
 *   inspection notice;
 * - each of the seven roles is served exactly the pinned list, in the pinned order, with the pinned
 *   text, colour, time and keys, and each served `id` and `at` is the stored row's own.
 *
 * Titles and ids are random per run, so the pin names decisions by label (D1…D5) and notices by
 * what they are; everything else is compared verbatim.
 */
describe('Top 10 #4b unit B — the notices each role is served (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshot: SnapshotService;
  let pmcToken: string;
  let clientToken: string;
  const run = randomUUID().slice(0, 8);
  const users = {
    engineer: `t4bs-eng-${run}`,
    contractor: `t4bs-con-${run}`,
    consultant: `t4bs-cst-${run}`,
    architect: `t4bs-arc-${run}`,
    worker: `t4bs-wkr-${run}`,
  };
  let engineerMembershipId = '';

  /** label → decision id, and label → title (the titles are random per run). */
  const decisions: Record<string, { id: string; title: string }> = {};
  /** stored notice id → its label in the pin */
  const noticeLabel = new Map<string, string>();

  const http = () => request(t.app.getHttpServer());
  const post = (token: string, path: string, body: object) =>
    http().post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const pause = () => new Promise((r) => setTimeout(r, 15));

  const twoOptions = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  /** Create a decision through the real command; published unless `publish: false`. */
  const create = async (label: string, body: Record<string, unknown> = {}): Promise<void> => {
    const title = `T4BS ${label} ${randomUUID().slice(0, 8)}`;
    const r = await post(pmcToken, `/projects/${f.projectA.id}/decisions`, { title, room: 'Kitchen', options: twoOptions, publish: true, ...body });
    expect(r.status, r.text).toBe(201);
    decisions[label] = { id: (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id, title };
    await pause();
  };

  /** A kind-less notice as today's writers file it, at a distinct instant. */
  const kindless = async (label: string, data: { text: string; color: string; decisionId?: string; inspectionId?: string }): Promise<void> => {
    const n = await t.prisma.notification.create({ data: { projectId: f.projectA.id, time: 'just now', ...data } });
    noticeLabel.set(n.id, label);
    await pause();
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshot = t.app.get(SnapshotService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    // the snapshot judges the viewer by the role it is called with; the architect role is not yet
    // writable on a user row (4d-i's door) and `worker` is a token role, so those two rows carry a
    // placeholder role that no filter reads
    for (const [role, id] of Object.entries(users)) {
      const stored = role === 'architect' || role === 'worker' ? 'contractor' : role;
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: stored, name: `T4BS ${role}`, email: `${id}@test.local` } });
    }
    for (const role of ['engineer', 'contractor', 'consultant'] as const) {
      const m = await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: users[role], role, status: 'active' } });
      if (role === 'engineer') engineerMembershipId = m.id;
    }

    // the decisions: D1 client-held pending; D2 held by the engineer member; D3 approved by the
    // client; D4 published then withdrawn; D5 an unpublished draft
    await create('D1');
    await create('D2', { deciderKind: 'member', deciderMembershipId: engineerMembershipId });
    await create('D3');
    const approved = await post(clientToken, `/projects/${f.projectA.id}/decisions/${decisions.D3.id}/approve`, { optionIndex: 0 });
    expect(approved.status, approved.text).toBe(201);
    await pause();
    await create('D4');
    const withdrawn = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${decisions.D4.id}/withdraw`, { reason: 'Scope changed' });
    expect(withdrawn.status, withdrawn.text).toBe(201);
    await pause();
    await create('D5', { publish: false });

    // the kind-less rows every writer files today
    await kindless('plain', { text: `Site note ${run}`, color: '#3F7A54' });
    await kindless('pending-unlinked', { text: `Decision awaiting approval: legacy ${run}`, color: '#C08A2D' });
    await kindless('pending-D1', { text: `Decision awaiting approval: ${decisions.D1.title}`, color: '#C08A2D', decisionId: decisions.D1.id });
    await kindless('pending-D2', { text: `Decision awaiting approval: ${decisions.D2.title}`, color: '#C08A2D', decisionId: decisions.D2.id });
    await kindless('withdrawn-unlinked', { text: `Decision withdrawn: legacy ${run} — gone`, color: '#6B665C' });
    await kindless('note-D3', { text: `Note on ${decisions.D3.title}`, color: '#6B665C', decisionId: decisions.D3.id });
    await kindless('note-D5', { text: `Note on ${decisions.D5.title}`, color: '#6B665C', decisionId: decisions.D5.id });
    await kindless('inspection', { text: `New checklist issued: ${run}`, color: '#C08A2D', inspectionId: `insp-${run}` });

    // the kinded rows the commands wrote, labelled by kind and decision
    const labelOf = new Map(Object.entries(decisions).map(([label, d]) => [d.id, label]));
    for (const n of await t.prisma.notification.findMany({ where: { projectId: f.projectA.id } })) {
      if (!noticeLabel.has(n.id)) noticeLabel.set(n.id, `${n.kind ?? 'kindless'}:${n.decisionId ? labelOf.get(n.decisionId) : '-'}`);
    }
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    // D3's approval wrote immutable register rows; their sanctioned reset is TRUNCATE (as change-control's)
    await sanctionedReset(t.prisma, ['LabourDemandSlice', 'LabourRequirementSpec', 'MaterialRequirementSpec', 'DecisionApprovalRevision'], { cascade: true });
    await sanctionedReset(t.prisma, ['Notification', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await t.prisma.auditLog.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { userId: { in: Object.values(users) } } });
    await t.prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await f?.cleanup();
    await t?.close();
  });

  const viewers: Array<[Role, () => string]> = [
    ['pmc', () => f.memberUser.id],
    ['client', () => f.clientUser.id],
    ['engineer', () => users.engineer],
    ['contractor', () => users.contractor],
    ['consultant', () => users.consultant],
    ['architect', () => users.architect],
    ['worker', () => users.worker],
  ];

  /** One served notice as pinned: labels for the run-random titles and ids, everything else verbatim. */
  interface Pinned { notice: string; text: string; color: string; decisionId?: string; inspectionId?: string }

  /**
   * The feed each role is served, captured on `cb9386d` before the filter moved. Every notice is
   * served with `time: 'just now'` (its stored value) and with exactly the keys shown plus `id`, `at`,
   * `text`, `time` and `color`.
   */
  const PINNED: Record<Role, Pinned[]> = {
    pmc: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C', decisionId: 'D5' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'withdrawn-unlinked', text: "Decision withdrawn: legacy RUN — gone", color: '#6B665C' },
      { notice: 'pending-D2', text: "Decision awaiting approval: D2", color: '#C08A2D', decisionId: 'D2' },
      { notice: 'pending-D1', text: "Decision awaiting approval: D1", color: '#C08A2D', decisionId: 'D1' },
      { notice: 'pending-unlinked', text: "Decision awaiting approval: legacy RUN", color: '#C08A2D' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.withdrawn:D4', text: "Decision withdrawn: D4 — Scope changed", color: '#6B665C', decisionId: 'D4' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
      { notice: 'decision.published:D3', text: "Decision awaiting approval: D3", color: '#C08A2D', decisionId: 'D3' },
      { notice: 'decision.published:D2', text: "Decision awaiting approval: D2", color: '#C08A2D', decisionId: 'D2' },
      { notice: 'decision.published:D1', text: "Decision awaiting approval: D1", color: '#C08A2D', decisionId: 'D1' },
    ],
    client: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'pending-D1', text: "Decision awaiting approval: D1", color: '#C08A2D', decisionId: 'D1' },
      { notice: 'pending-unlinked', text: "Decision awaiting approval: legacy RUN", color: '#C08A2D' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
      { notice: 'decision.published:D3', text: "Decision awaiting approval: D3", color: '#C08A2D', decisionId: 'D3' },
      { notice: 'decision.published:D1', text: "Decision awaiting approval: D1", color: '#C08A2D', decisionId: 'D1' },
    ],
    engineer: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'pending-D2', text: "Decision awaiting approval: D2", color: '#C08A2D', decisionId: 'D2' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
      { notice: 'decision.published:D2', text: "Decision awaiting approval: D2", color: '#C08A2D', decisionId: 'D2' },
    ],
    contractor: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
    ],
    consultant: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
    ],
    architect: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
    ],
    worker: [
      { notice: 'inspection', text: "New checklist issued: RUN", color: '#C08A2D', inspectionId: 'insp-RUN' },
      { notice: 'note-D5', text: "Note on D5", color: '#6B665C' },
      { notice: 'note-D3', text: "Note on D3", color: '#6B665C', decisionId: 'D3' },
      { notice: 'plain', text: "Site note RUN", color: '#3F7A54' },
      { notice: 'decision.approved:D3', text: "Client approved D3 — Granite", color: '#3F7A54', decisionId: 'D3' },
    ],
  };

  /** The served feed with run-random titles and ids replaced by their labels. */
  const served = async (role: Role, userId: string): Promise<Pinned[]> => {
    const rows = new Map((await t.prisma.notification.findMany({ where: { projectId: f.projectA.id } })).map((n) => [n.id, n]));
    const labelOf = new Map(Object.entries(decisions).map(([label, d]) => [d.id, label]));
    const unrun = (s: string) => Object.entries(decisions).reduce((acc, [label, d]) => acc.split(d.title).join(label), s).split(run).join('RUN');
    return (await snapshot.build(f.projectA.id, role, userId)).notifications.map((n) => {
      const row = rows.get(n.id);
      expect(row, `served id ${n.id} is a stored notice`).toBeDefined();
      expect(n.at, 'served at is the stored instant').toBe(row!.at.toISOString());
      expect(n.time).toBe(row!.time);
      const { id, at: _at, time: _time, text, color, decisionId, inspectionId, ...unexpected } = n;
      expect(unexpected, 'no key beyond the delivered shape').toStrictEqual({});
      return {
        notice: noticeLabel.get(id)!,
        text: unrun(text),
        color,
        ...(decisionId !== undefined ? { decisionId: labelOf.get(decisionId) } : {}),
        ...(inspectionId !== undefined ? { inspectionId: unrun(inspectionId) } : {}),
      };
    });
  };

  it.each(viewers)('%s is served exactly the pinned feed', async (role, userId) => {
    expect(await served(role, userId())).toStrictEqual(PINNED[role]);
  });

  // unit B — the snapshot's feed IS the shared definition: called on its own, it serves each role
  // exactly what the snapshot does (the definition unit C will judge confirmed ids against)
  it.each(viewers)('the shared definition serves %s exactly the snapshot feed', async (role, userId) => {
    const decisionsQuery = t.app.get(DecisionsQueryService);
    const shared = servedNotifications(await readViewerFeed(t.prisma, decisionsQuery, f.projectA.id, role, userId()), role, userId(), decisionsQuery);
    expect(shared).toStrictEqual((await snapshot.build(f.projectA.id, role, userId())).notifications);
  });
});
