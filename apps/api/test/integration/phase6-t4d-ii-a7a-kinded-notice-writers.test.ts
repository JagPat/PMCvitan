import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { readFeedEvents, readNotificationFeed } from '../../src/platform/notification-feed';
import { renderKindedDecisionNotice } from '../../src/decisions/decision-notice';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import {
  APPROVED_DECISION_NOTICE_COLOR, PENDING_DECISION_NOTICE_COLOR, RECORDED_DECISION_NOTICE_COLOR, WITHDRAWN_DECISION_NOTICE_COLOR,
  pendingDecisionNotice, recordedDecisionNotice, withdrawnDecisionNotice,
} from '../../src/domain/notifications';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A7a — the KINDED notice writers, proven against live PostgreSQL
 * (§A.3 obligation 7, "the writers"; the staging document's A7 row: "kinded notice writers minting
 * their event id and stamping `eventId`/`kind`", "the kinded green notice rendering from its event's
 * revision", and the one hostile probe A7 owes, "the late kinded insert against a committed
 * no-notice event").
 *
 * Every decisions notice writer — the one-step issue, publish, approve and withdraw — now mints its
 * event id up front, emits the event FIRST (the notice's binding key is a NOT DEFERRABLE foreign key
 * onto it) and writes the notice bound to it (`eventId`, `kind` = the event's type) in the same
 * transaction, as 4d-i's `Notification_t4d_binding_bound` demands. The row's `text`/`color` remain
 * the cache a previous-release replica serves through the drain; every reader of THIS release
 * renders the notice from its event (A4c), so the arms below hold the cache and the rendering equal.
 *
 * The green approved notice renders from the REVISION its event names (`payload.revisionId`, the
 * exact revision the act wrote) and the event's frozen actor envelope — never the head revision —
 * so an older notice of a twice-approved decision keeps its own option and approver.
 */
describe('4d-ii-a / A7a — the decisions notice writers bind every notice to its event (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshot: SnapshotService;
  let pmcToken: string;
  let clientToken: string;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshot = t.app.get(SnapshotService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    // kinded notices are undeletable by row (their binding seal); the sanctioned reset of the feed
    // and the events is TRUNCATE, as every suite's teardown already does for DomainEvent
    await sanctionedReset(t.prisma, ['Notification', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'DecisionApprovalRevision', 'CommandExecution'], { cascade: true });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await f?.cleanup();
    await t?.close();
  });

  const post = (token: string) => (path: string, body: object) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const asPmc = () => post(pmcToken);
  const asClient = () => post(clientToken);

  const OPTIONS = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  /** A decision through the one-step issue (`publish: true`), or born a draft. */
  const create = async (over: { publish?: boolean; record?: boolean } = {}): Promise<{ id: string; title: string }> => {
    const title = `A7a ${randomUUID().slice(0, 8)}`;
    const r = await asPmc()(`/projects/${f.projectA.id}/decisions`, {
      title, room: 'Kitchen', publish: over.publish ?? true,
      ...(over.record ? { deciderKind: 'none', options: [] } : { options: OPTIONS }),
    });
    expect(r.status, r.text).toBe(201);
    return { id: (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id, title };
  };

  const noticesOf = (decisionId: string) =>
    t.prisma.notification.findMany({ where: { projectId: f.projectA.id, decisionId }, orderBy: { at: 'asc' } });
  const eventOf = (decisionId: string, eventType: string) =>
    t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, entityId: decisionId, eventType }, orderBy: { streamPosition: 'desc' } });
  const feedOf = async (role: 'pmc' | 'client' | 'contractor', userId: string) =>
    (await snapshot.build(f.projectA.id, role, userId)).notifications;

  /** The notice is bound to exactly the event the writer emitted for the act, and its cached
   *  text/colour equal what the kinded renderer produces from that event. */
  const expectBound = async (decisionId: string, eventType: string, cached: { text: string; color: string }) => {
    const event = await eventOf(decisionId, eventType);
    const notice = await t.prisma.notification.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.projectA.id, eventId: event.eventId } } as never }).catch(async () =>
      t.prisma.notification.findFirstOrThrow({ where: { projectId: f.projectA.id, eventId: event.eventId } }),
    );
    expect(notice).toMatchObject({ decisionId, kind: eventType, eventId: event.eventId, text: cached.text, color: cached.color });
    // rendered from the event (and, for a green notice, the revision it names), as the feed reads it
    const events = await readFeedEvents(t.prisma, f.projectA.id, [event.eventId]);
    const revisions = await t.app.get(DecisionsQueryService).kindedNoticeRevisions(t.prisma, f.projectA.id, events);
    expect(renderKindedDecisionNotice(notice.kind!, events.get(event.eventId)!, revisions)).toEqual(cached);
    return { event, notice };
  };

  it('the one-step ISSUE binds its pending notice to its decision.published event, and the feed renders it for the pmc and the decider', async () => {
    const d = await create();
    const { event } = await expectBound(d.id, 'decision.published', { text: pendingDecisionNotice(d.title), color: PENDING_DECISION_NOTICE_COLOR });
    expect((event.dispatchIntent as { effectKey: string }).effectKey).toBe('decision.published');
    expect(await noticesOf(d.id)).toHaveLength(1);
    expect((await feedOf('pmc', f.memberUser.id)).map((n) => n.text)).toContain(pendingDecisionNotice(d.title));
    expect((await feedOf('client', f.clientUser.id)).map((n) => n.text)).toContain(pendingDecisionNotice(d.title));
    // a kinded row is served by RENDERING: the cached colour is the renderer's too
    expect((await feedOf('pmc', f.memberUser.id)).find((n) => n.text === pendingDecisionNotice(d.title))?.color).toBe(PENDING_DECISION_NOTICE_COLOR);
  });

  it('the RECORD issue binds its notice under the record key, rendered as the record, team-visible', async () => {
    const d = await create({ record: true });
    const { event } = await expectBound(d.id, 'decision.published', { text: recordedDecisionNotice(d.title), color: RECORDED_DECISION_NOTICE_COLOR });
    expect((event.dispatchIntent as { effectKey: string }).effectKey).toBe('decision.published.record');
    expect((await feedOf('client', f.clientUser.id)).map((n) => n.text)).toContain(recordedDecisionNotice(d.title));
  });

  it('a DRAFT writes no notice; the two-step PUBLISH binds its pending notice to the publish event', async () => {
    const d = await create({ publish: false });
    expect(await noticesOf(d.id)).toHaveLength(0);
    const p = await asPmc()(`/projects/${f.projectA.id}/decisions/${d.id}/publish`, {});
    expect(p.status, p.text).toBe(201);
    await expectBound(d.id, 'decision.published', { text: pendingDecisionNotice(d.title), color: PENDING_DECISION_NOTICE_COLOR });
    expect(await noticesOf(d.id)).toHaveLength(1);
  });

  it('APPROVE binds the green notice to its event, whose payload names the EXACT revision the act wrote; the client\'s own approval and the pmc\'s on-behalf approval each render as written', async () => {
    // the client approves their own decision
    const own = await create();
    const a = await asClient()(`/projects/${f.projectA.id}/decisions/${own.id}/approve`, { optionIndex: 0 });
    expect(a.status, a.text).toBe(201);
    const { event } = await expectBound(own.id, 'decision.approved', { text: `Client approved ${own.title} — Granite`, color: APPROVED_DECISION_NOTICE_COLOR });
    const head = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: own.id }, orderBy: { version: 'desc' } });
    expect(event.payload).toMatchObject({ option: 'Option A', material: 'Granite', revisionId: head.id, title: own.title, deciderKind: 'client' });
    expect(head.id).toBe(`dar-${own.id}-v1`);
    expect(event.actorRole).toBe('client');
    // served to every role that sees an approved decision
    expect((await feedOf('pmc', f.memberUser.id)).map((n) => n.text)).toContain(`Client approved ${own.title} — Granite`);
    expect((await feedOf('client', f.clientUser.id)).map((n) => n.text)).toContain(`Client approved ${own.title} — Granite`);

    // the pmc approves on the client's behalf: the announcement names who exercised the authority
    const behalf = await create();
    const b = await asPmc()(`/projects/${f.projectA.id}/decisions/${behalf.id}/approve`, { optionIndex: 1 });
    expect(b.status, b.text).toBe(201);
    const ev = await eventOf(behalf.id, 'decision.approved');
    expect(ev.payload).toMatchObject({ onBehalfOf: 'client', revisionId: `dar-${behalf.id}-v1`, material: 'Quartz' });
    expect(ev.actorRole).toBe('pmc');
    await expectBound(behalf.id, 'decision.approved', { text: `${ev.actorName} (PMC) approved ${behalf.title} on behalf of the client — Quartz`, color: APPROVED_DECISION_NOTICE_COLOR });
    expect((await noticesOf(behalf.id)).map((n) => n.text)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Client approved/)]));
  });

  it('a TWICE-approved decision: the older green notice renders ITS revision (option and approver), the reapproval its own; neither reads the head', async () => {
    const d = await create();
    expect((await asClient()(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await asPmc()(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'Client changed their mind', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);
    // the pmc reapproves the OTHER option on the client's behalf
    expect((await asPmc()(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 1 })).status).toBe(201);

    const first = await eventOf(d.id, 'decision.approved');
    const second = await eventOf(d.id, 'decision.reapproved');
    expect(first.payload).toMatchObject({ revisionId: `dar-${d.id}-v1`, material: 'Granite' });
    expect(second.payload).toMatchObject({ revisionId: `dar-${d.id}-v2`, material: 'Quartz', onBehalfOf: 'client' });
    const head = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: d.id }, orderBy: { version: 'desc' } });
    expect(head.id).toBe(`dar-${d.id}-v2`);

    await expectBound(d.id, 'decision.approved', { text: `Client approved ${d.title} — Granite`, color: APPROVED_DECISION_NOTICE_COLOR });
    await expectBound(d.id, 'decision.reapproved', { text: `${second.actorName} (PMC) approved ${d.title} on behalf of the client — Quartz`, color: APPROVED_DECISION_NOTICE_COLOR });
    const feed = (await feedOf('pmc', f.memberUser.id)).map((n) => n.text);
    expect(feed).toContain(`Client approved ${d.title} — Granite`);
    expect(feed).toContain(`${second.actorName} (PMC) approved ${d.title} on behalf of the client — Quartz`);
    // no rendering of the older notice says the head's option
    expect(feed.filter((x) => x.includes(d.title) && x.includes('Quartz'))).toHaveLength(1);
  });

  it('WITHDRAW binds the withdrawal notice to its event and KEEPS the kinded pending notice (hidden by the readers, never deleted); a legacy kind-less pending bell still retires', async () => {
    const d = await create();
    // the previous release's shape: a stamped, kind-less pending bell for the same decision
    await t.prisma.notification.create({ data: { projectId: f.projectA.id, text: pendingDecisionNotice(d.title), color: PENDING_DECISION_NOTICE_COLOR, time: '2d ago', decisionId: d.id } });
    expect(await noticesOf(d.id)).toHaveLength(2);
    const w = await asPmc()(`/projects/${f.projectA.id}/decisions/${d.id}/withdraw`, { reason: 'Client changed scope' });
    expect(w.status, w.text).toBe(201);

    await expectBound(d.id, 'decision.withdrawn', { text: withdrawnDecisionNotice(d.title, 'Client changed scope'), color: WITHDRAWN_DECISION_NOTICE_COLOR });
    const remaining = await noticesOf(d.id);
    expect(remaining.map((n) => n.kind).sort()).toEqual(['decision.published', 'decision.withdrawn']);
    expect(remaining.every((n) => n.eventId !== null)).toBe(true);
    // the pending demand is suppressed for everyone (an actionable kind of a withdrawn decision), the
    // withdrawal notice reaches the pmc alone
    const pmc = (await feedOf('pmc', f.memberUser.id)).map((n) => n.text);
    expect(pmc).toContain(withdrawnDecisionNotice(d.title, 'Client changed scope'));
    expect(pmc).not.toContain(pendingDecisionNotice(d.title));
    const client = (await feedOf('client', f.clientUser.id)).map((n) => n.text);
    expect(client).not.toContain(pendingDecisionNotice(d.title));
    expect(client).not.toContain(withdrawnDecisionNotice(d.title, 'Client changed scope'));
    // the stored feed still carries the kinded pending row's cache: it is hidden by rendering, not erased
    expect((await readNotificationFeed(t.prisma, f.projectA.id)).filter((n) => n.decisionId === d.id && n.text === pendingDecisionNotice(d.title))).toHaveLength(1);
  });

  // ── the hostile probe A7 owes (staging document, A7 row) ──
  it('HOSTILE: a late kinded insert against a COMMITTED no-notice event is refused at commit — the notice must be its act\'s own', async () => {
    // a draft emits `decision.drafted` and writes no notice; the event is committed history now
    const d = await create({ publish: false });
    const drafted = await eventOf(d.id, 'decision.drafted');
    expect(await t.prisma.notification.count({ where: { eventId: drafted.eventId } })).toBe(0);
    // a later transaction minting the notice the act never wrote: kind, project, entity all true
    await expect(
      t.prisma.notification.create({
        data: { projectId: f.projectA.id, text: `LATE-${run}`, color: '#000000', time: 'just now', decisionId: d.id, kind: 'decision.drafted', eventId: drafted.eventId },
      }),
    ).rejects.toThrow(/emitted by an EARLIER transaction/);
    expect(await t.prisma.notification.count({ where: { eventId: drafted.eventId } })).toBe(0);
    // and the same against a committed event that DOES have its notice: the one-notice key and
    // the same-transaction rule both stand between a second notice and the feed
    const p = await create();
    const published = await eventOf(p.id, 'decision.published');
    await expect(
      t.prisma.notification.create({
        data: { projectId: f.projectA.id, text: `LATE-${run}`, color: '#000000', time: 'just now', decisionId: p.id, kind: 'decision.published', eventId: published.eventId },
      }),
    ).rejects.toThrow(/Unique constraint failed|EARLIER transaction/);
    expect(await t.prisma.notification.count({ where: { eventId: published.eventId } })).toBe(1);
  });

  it('a kinded notice is FROZEN and undeletable: the writers\' rows cannot be re-pointed, re-kinded or retired by a direct DELETE', async () => {
    const d = await create();
    const { notice } = await expectBound(d.id, 'decision.published', { text: pendingDecisionNotice(d.title), color: PENDING_DECISION_NOTICE_COLOR });
    await expect(t.prisma.notification.delete({ where: { id: notice.id } })).rejects.toThrow(/may not be DELETED/);
    await expect(t.prisma.notification.update({ where: { id: notice.id }, data: { kind: 'decision.withdrawn' } })).rejects.toThrow(/may not be rewritten/);
    await expect(t.prisma.notification.update({ where: { id: notice.id }, data: { eventId: null, kind: null } })).rejects.toThrow(/may not be re-pointed/);
    expect(await t.prisma.notification.count({ where: { id: notice.id, kind: 'decision.published' } })).toBe(1);
  });
});
