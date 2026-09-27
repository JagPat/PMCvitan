import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import {
  createTwoProjectFixture, type TwoProjectFixture, insertRawEventVia, plantUnpairedDecisionState,
  wipeDecisionEvents, wipeDecisionsVia,
} from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { readNotificationFeed } from '../../src/platform/notification-feed';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4c — the feed's KINDED notices, proven against live PostgreSQL
 * (§A.3 obligation 7, "the readers"; P31's reader arms).
 *
 * A kinded notice is bound to the event that announced its act. 4d-i sealed the binding (same
 * transaction, same decision, kind = event type, frozen, undeletable); nothing writes one until A7
 * stamps the decision writers, so each arm plants one beside a real decision, in ONE transaction
 * with its event as the seal demands. The snapshot is the only feed reader, and for a kinded row it:
 *
 * - RENDERS the notice from its kind and event, never from the stored `text` (a forged cache is
 *   served to no one);
 * - serves it only to a viewer who may see its decision, judged on the decision slice read in the
 *   SAME REPEATABLE READ snapshot as the notice;
 * - suppresses an ACTIONABLE kind once the decision is withdrawn, and keeps the row as evidence:
 *   the withdraw's notice retirement now deletes kind-less rows only (at the base it tried to delete
 *   the kinded row too, which the binding seal refuses, so the withdrawal itself failed);
 * - omits a kind this release has no renderer arm for.
 */
describe('4d-ii-a / A4c — the snapshot serves kinded notices by rendering, visibility and withdrawal (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshot: SnapshotService;
  let pmcToken: string;
  let contractorId: string;
  const run = randomUUID().slice(0, 8);
  const FORGED = `FORGED-CACHE-${run}`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshot = t.app.get(SnapshotService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    contractorId = `a4c-con-${run}`;
    await t.prisma.user.create({ data: { id: contractorId, projectId: f.projectA.id, role: 'contractor', name: 'A4c Contractor', email: `${contractorId}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractorId, role: 'contractor', status: 'active' } });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    // kinded notices are undeletable by row (their binding seal); the sanctioned reset of the feed
    // and the events is TRUNCATE, as every suite's teardown already does for DomainEvent
    await sanctionedReset(t.prisma, ['Notification', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { userId: contractorId } });
    await t.prisma.user.deleteMany({ where: { id: contractorId } });
    await f?.cleanup();
    await t?.close();
  });

  const post = (path: string, body: object) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);

  /** A published, client-held pending decision; returns its id and title. */
  const publish = async (): Promise<{ id: string; title: string }> => {
    const title = `A4c ${randomUUID().slice(0, 8)}`;
    const r = await post(`/projects/${f.projectA.id}/decisions`, {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(r.status, r.text).toBe(201);
    return { id: (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id, title };
  };

  /**
   * Plant a KINDED notice and the event it is bound to, in ONE transaction (the binding seal admits a
   * kinded notice only beside its own event). Its stored `text` is a forged cache; the event says what
   * really happened. Declared through the fixtures' named bypass for decision events with no bundle.
   *
   * The event's intent is COPIED from the one the service emitted for the same act on this decision
   * (a published or withdrawn decision already has it), so the plant carries exactly what a current
   * writer's does, push included: the catalog seal refuses an announcing branch without its push.
   * A key with no such event (`decision.drafted`) takes the catalog's own intent.
   */
  const plantKinded = async (decisionId: string, effectKey: string, payload: object): Promise<string> => {
    const eventId = randomUUID();
    const real = await t.prisma.domainEvent.findFirst({
      where: { projectId: f.projectA.id, entityId: decisionId, dispatchIntent: { path: ['effectKey'], equals: effectKey } },
      select: { eventType: true, dispatchIntent: true },
    });
    await plantUnpairedDecisionState(t.prisma, async (tx) => {
      await insertRawEventVia(tx, {
        projectId: f.projectA.id, organizationId: f.orgA.id, eventId, entityType: 'Decision', entityId: decisionId, effectKey,
        ...(real ? { eventType: real.eventType } : {}),
        columns: ['"payload"', ...(real ? ['"dispatchIntent"'] : [])],
        values: [`'${JSON.stringify(payload)}'::jsonb`, ...(real ? [`'${JSON.stringify(real.dispatchIntent).replace(/'/g, "''")}'::jsonb`] : [])],
      });
      const event = await tx.domainEvent.findUniqueOrThrow({ where: { eventId }, select: { eventType: true } });
      await tx.notification.create({
        data: { projectId: f.projectA.id, text: FORGED, color: '#000000', time: 'just now', decisionId, eventId, kind: event.eventType },
      });
    });
    return eventId;
  };

  const feedOf = async (role: 'pmc' | 'client' | 'contractor', userId: string) =>
    (await snapshot.build(f.projectA.id, role, userId)).notifications.map((n) => n.text);

  it('a kinded notice is RENDERED from its event: the pmc and the decider read the act, and the forged cache reaches no one', async () => {
    const d = await publish();
    await plantKinded(d.id, 'decision.published', { title: d.title });
    const pmc = await feedOf('pmc', f.memberUser.id);
    expect(pmc).not.toContain(FORGED);
    expect(pmc.filter((text) => text === `Decision awaiting approval: ${d.title}`).length, 'the kind-less cache and the kinded rendering both announce it').toBe(2);
    expect(await feedOf('client', f.clientUser.id)).toContain(`Decision awaiting approval: ${d.title}`);
  });

  it('a kinded notice is served only to a viewer who may see its decision', async () => {
    const d = await publish();
    await plantKinded(d.id, 'decision.published', { title: d.title });
    // a client-held pending decision is hidden from a contractor, and so is its kinded notice,
    // whatever its stored text says (at the base the forged cache matched no text filter and leaked)
    const contractor = await feedOf('contractor', contractorId);
    expect(contractor).not.toContain(FORGED);
    expect(contractor.some((text) => text.includes(d.title))).toBe(false);
  });

  it('WITHDRAWN: the actionable kinded notice is suppressed, the withdrawal notice stands, and the kinded row is kept as evidence', async () => {
    const d = await publish();
    const eventId = await plantKinded(d.id, 'decision.published', { title: d.title });
    // the withdraw retires kind-less notices only; at the base it also tried to delete this kinded
    // row, which the binding seal refuses, and the withdrawal failed
    const w = await post(`/projects/${f.projectA.id}/decisions/${d.id}/withdraw`, { reason: 'Client changed scope' });
    expect(w.status, w.text).toBe(201);

    const pmc = await feedOf('pmc', f.memberUser.id);
    expect(pmc).toContain(`Decision withdrawn: ${d.title} — Client changed scope`);
    expect(pmc.some((text) => text.startsWith('Decision awaiting approval') && text.includes(d.title)), 'no demand for a withdrawn decision').toBe(false);
    expect(pmc).not.toContain(FORGED);
    // the row and its event remain
    expect(await t.prisma.notification.count({ where: { eventId } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { eventId } })).toBe(1);
  });

  it('an INFORMATIONAL kind of a withdrawn decision stands for the pmc and stays hidden from everyone else', async () => {
    const d = await publish();
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/withdraw`, { reason: 'Superseded' })).status).toBe(201);
    await plantKinded(d.id, 'decision.withdrawn', { title: d.title, reason: 'Superseded', pushIntentsCancelled: 0 });
    const pmc = await feedOf('pmc', f.memberUser.id);
    expect(pmc.filter((text) => text === `Decision withdrawn: ${d.title} — Superseded`).length).toBe(2);
    expect(await feedOf('client', f.clientUser.id)).not.toContain(`Decision withdrawn: ${d.title} — Superseded`);
  });

  // #651's review, finding 4117114385 — a pending decision's `decision.published` event emitted under
  // the RECORD catalog key (which the envelope seal admits for the type) is not a team-visible record
  it('a notice whose catalog key disagrees with its decision is served to no one', async () => {
    const d = await publish();
    await plantKinded(d.id, 'decision.published.record', { title: d.title });
    for (const [role, user] of [['pmc', f.memberUser.id], ['client', f.clientUser.id], ['contractor', contractorId]] as const) {
      const feed = await feedOf(role, user);
      expect(feed, `${role}: no "record" for a decision awaiting approval`).not.toContain(`Issue recorded: ${d.title}`);
      expect(feed).not.toContain(FORGED);
    }
  });

  it('a kind this release has no renderer arm for is omitted, never served from its stored text', async () => {
    const d = await publish();
    await plantKinded(d.id, 'decision.drafted', { title: d.title });
    expect(await feedOf('pmc', f.memberUser.id)).not.toContain(FORGED);
  });

  it('ONE SNAPSHOT: inside the REPEATABLE READ transaction, a withdrawal committed after the slice read is invisible to the feed read', async () => {
    const d = await publish();
    const query = t.app.get(DecisionsQueryService);
    let sliceStatus: string | undefined;
    let feedTexts: string[] = [];
    await t.prisma.$transaction(async (tx) => {
      const slice = await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id, tx);
      sliceStatus = slice.decisions.find((x) => x.id === d.id)?.status;
      // the withdrawal commits on another connection between the two reads
      const w = await post(`/projects/${f.projectA.id}/decisions/${d.id}/withdraw`, { reason: 'Mid-read' });
      expect(w.status, w.text).toBe(201);
      feedTexts = (await readNotificationFeed(tx, f.projectA.id)).map((n) => n.text);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(sliceStatus).toBe('pending');
    // the feed read sees the same moment the slice did: no withdrawal notice yet, the pending one still there
    expect(feedTexts).not.toContain(`Decision withdrawn: ${d.title} — Mid-read`);
    expect(feedTexts).toContain(`Decision awaiting approval: ${d.title}`);
  });
});
