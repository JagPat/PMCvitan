import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DOMAIN_EVENT_TYPES } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, insertRawEvent, plantLegacyDelivery, plantLegacyEvent, rawDeliveryRowsSql, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { OutboxConsumerActivationService } from '../../src/platform/outbox/consumer-activation.service';
import {
  deliveryRowsFor, dispatchActionFor, pushPayloadFor, persistedRule, registerConsumer, syncConsumerCatalog, unregisterConsumer,
  type CatalogRuleRow, type DispatchIntent, type DispatchRule, type EmittedEventMeta, type OutboxConsumer,
} from '../../src/platform/outbox/registry';
import { PUSH_CONSUMER, SOCKET_CONSUMER } from '../../src/platform/outbox/consumers';
import { effectCoverageVersion } from '../../src/platform/external-effects';
import { sanctionedReset, sanctionedConsumerRemoval, plantDeliveryGap } from '../../prisma/sanctioned-reset';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6d — the DELIVERY ROWS and their SEALS, against live PostgreSQL
 * (the 4d plan §A.3 obligation 7; P37 and P38's barrier arms in both orderings, through the emitter
 * and through a direct receipt-backed writer that never calls `deliveryRowsFor`).
 *
 * What is proven, each arm RED against its own defect:
 *   - the kernel's derivation and projection (`platform_t4d_delivery_action`, `platform_t4d_push_payload`)
 *     equal the TypeScript mirrors over the closed event list and every intent shape;
 *   - the emitter's rows ARE `deliveryRowsFor`'s rows; a DIRECT writer that never calls it writes
 *     the same rows; the expansion scanner re-creates exactly them;
 *   - `DomainEvent_t4d_deliveries` refuses at commit an event owing a row it did not write, names the
 *     consumer, owes nothing to an inactive or rule-less row, and never forbids a row;
 *   - `OutboxDelivery_t4d_bound` binds every row to its rule's action and a push row to the intent's
 *     projection and its subject, admitting the previous release's shape and the born-cancelled tombstone;
 *   - `OutboxDelivery_t4d_frozen` freezes identity and payload, admits the subject stamp, the mark,
 *     the completion and the legacy neutralization, and refuses everything else;
 *   - the barrier: event vs activation and event vs registration, both orderings, the activation and
 *     the registration OBSERVED BLOCKED behind the event, through the emitter AND the direct writer.
 */
describe('4d-ii-a / A6d — the delivery rows and their seals (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let activation: OutboxConsumerActivationService;
  const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };
  const KEY = "hashtext('OutboxConsumerCatalog:registration')";
  const SENTINEL = new Error('rollback');
  type Tx = Parameters<Parameters<TestApp['prisma']['$transaction']>[0]>[0];

  // the ad-hoc consumers: one of each rule kind, plus an inactive one, a push-rule one kept inactive
  // (so the emitter writes it no row and the binding can be probed with planted rows), a rule-less one
  const ALL = 'test.a6d.all';
  const TYPES = 'test.a6d.types';
  const OFF = 'test.a6d.off';
  const PUSHY = 'test.a6d.push';
  const NORULE = 'test.a6d.norule';
  const AD_HOC = [ALL, TYPES, OFF, PUSHY, NORULE];
  const adHoc = (name: string, kind: 'ordered' | 'unordered', dispatchRule: DispatchRule): OutboxConsumer =>
    ({ name, kind, effect: kind === 'ordered' ? 'db' : 'external', catalogVersion: 1, dispatchRule, handle: async () => {} });

  const rolledBack = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
    let thrown: unknown = null;
    await t.prisma.$transaction(async (tx) => {
      try { await body(tx); } catch (e) { thrown = e; }
      throw SENTINEL;
    }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    if (thrown) throw thrown;
  };
  let savepoints = 0;
  /** run one statement under a savepoint; the refusal's message, or null when admitted */
  const attempt = async (tx: Tx, sql: string, ...params: unknown[]): Promise<string | null> => {
    const sp = `a6d_${++savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await tx.$executeRawUnsafe(sql, ...params);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return null;
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return e instanceof Error ? e.message : String(e);
    }
  };
  /** run one statement under a savepoint and ALWAYS roll it back: the refusal's message, or null
   *  when it would have been admitted — so one event can be probed with many rows for one consumer */
  const probe = async (tx: Tx, sql: string, ...params: unknown[]): Promise<string | null> => {
    const sp = `a6d_p${++savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await tx.$executeRawUnsafe(sql, ...params);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    }
  };
  const waitFor = async (label: string, probe: () => Promise<boolean>, ms = 15_000): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const keyLocks = async (mode: 'ShareLock' | 'ExclusiveLock', granted: boolean): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pg_locks
        WHERE locktype = 'advisory' AND mode = $1 AND granted = $2
          AND objid = (${KEY}::bigint & 4294967295) AND classid = ((${KEY}::bigint >> 32) & 4294967295)`, mode, granted);
    return Number(rows[0].n);
  };
  const blockedOn = async (queryLike: string): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`, queryLike);
    return Number(rows[0]!.c);
  };

  const catalog = (): Promise<CatalogRuleRow[]> => t.prisma.outboxConsumerCatalog.findMany({
    orderBy: { consumer: 'asc' }, select: { consumer: true, consumerKind: true, active: true, dispatchRule: true, subscribedEventTypes: true },
  });
  const metaOf = (eventId: string): Promise<EmittedEventMeta> => metaOfVia(t.prisma, eventId);
  const metaOfVia = async (client: Tx | TestApp['prisma'], eventId: string): Promise<EmittedEventMeta> => {
    const e = await client.domainEvent.findUniqueOrThrow({ where: { eventId } });
    return { eventId: e.eventId, eventType: e.eventType, projectId: e.projectId, organizationId: e.organizationId, streamPosition: e.streamPosition, entityType: e.entityType, entityId: e.entityId, payload: e.payload, dispatchIntent: e.dispatchIntent as unknown as DispatchIntent | null };
  };
  /** the rows an event carries, in the comparable shape `deliveryRowsFor` produces */
  const rowsOf = async (eventId: string) => (await t.prisma.outboxDelivery.findMany({ where: { eventId }, orderBy: { consumer: 'asc' } }))
    .map((r) => ({ eventId: r.eventId, projectId: r.projectId, consumer: r.consumer, consumerKind: r.consumerKind, streamPosition: r.streamPosition, deliveryAction: r.deliveryAction, status: r.status, ...(r.payload !== null ? { payload: r.payload, subject: r.subject } : {}) }));
  const expectedRowsOf = async (eventId: string) => deliveryRowsFor(await metaOf(eventId), await catalog()).sort((a, b) => a.consumer.localeCompare(b.consumer));

  const publish = (entityId: string, body = `Decision ${entityId} awaits you`) =>
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId: f.projectA.id, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId, effectKey: 'decision.published', dispatch: { push: { body } } }));
  const draft = (entityId: string) =>
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId: f.projectA.id, actor: human, eventType: 'decision.drafted', entityType: 'Decision', entityId, effectKey: 'decision.drafted', dispatch: {} }));
  const entity = () => `D-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    activation = t.app.get(OutboxConsumerActivationService);
    human.actorId = f.memberUser.id;
    await sanctionedConsumerRemoval(t.prisma, AD_HOC);
    registerConsumer(adHoc(ALL, 'unordered', { kind: 'all' }));
    registerConsumer(adHoc(TYPES, 'ordered', { kind: 'types', eventTypes: ['decision.published'] }));
    registerConsumer(adHoc(OFF, 'unordered', { kind: 'all' }));
    registerConsumer(adHoc(PUSHY, 'unordered', { kind: 'push' }));
    await syncConsumerCatalog(t.prisma);
    await activation.request({ consumer: OFF, active: false, reason: 'probe: an inactive consumer owes nothing', actorId: 'a6d', requestToken: randomUUID() });
    await activation.request({ consumer: PUSHY, active: false, reason: 'probe: a push-rule consumer whose rows are planted by hand', actorId: 'a6d', requestToken: randomUUID() });
    // planted history: a row no migration knew, carrying no rule
    await t.prisma.outboxConsumerCatalog.create({ data: { consumer: NORULE, consumerKind: 'unordered', consumerEffect: 'external', catalogVersion: 1 } });
  });
  afterEach(async () => {
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
  });
  afterAll(async () => {
    for (const c of AD_HOC) unregisterConsumer(c);
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await sanctionedConsumerRemoval(t?.prisma, [...AD_HOC, 'test.a6d.late', 'test.a6d.reg', 'test.a6d.reg2', 'test.a6d.hold', 'test.a6d.unhandled']);
    await f?.cleanup();
    await t?.close();
  });

  // ── the derivation and the projection: ONE truth, mirrored ───────────────────────────────────
  it('the kernel\'s `platform_t4d_delivery_action` equals `dispatchActionFor` for every persisted rule over the closed event list and every intent shape', async () => {
    const intents: Array<DispatchIntent | null> = [
      null,
      { effectKey: 'k', coverageVersion: 'v', invalidate: false },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true },
      { effectKey: 'k', coverageVersion: 'v', invalidate: false, push: { body: 'hi' } },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: 'hi', roles: ['client'], targetUserId: 'u' } },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: '' } },
    ];
    const rules: CatalogRuleRow[] = [...(await catalog()).filter((r) => r.dispatchRule !== null).map((r) => ({ ...r, active: true })), { consumer: 'x', consumerKind: 'ordered', active: true, dispatchRule: 'types', subscribedEventTypes: [] }];
    expect(rules.length).toBeGreaterThan(10);
    for (const r of rules) {
      for (const intent of intents) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ t: string; a: string }>>(
          `SELECT t, platform_t4d_delivery_action($1, $2::text[], t, $3::jsonb) AS a FROM unnest($4::text[]) AS t`,
          r.dispatchRule, r.subscribedEventTypes, intent === null ? null : JSON.stringify(intent), [...DOMAIN_EVENT_TYPES]);
        for (const { t: type, a } of rows) {
          const [row] = deliveryRowsFor({ eventId: 'e', eventType: type, projectId: 'p', organizationId: 'o', streamPosition: 0n, entityType: 'X', entityId: 'x', payload: null, dispatchIntent: intent }, [r]);
          expect(a, `${r.consumer} (${r.dispatchRule}) × ${type} × ${JSON.stringify(intent)}`).toBe(row!.deliveryAction);
        }
      }
    }
    // a rule-less row derives nothing, in both
    expect((await t.prisma.$queryRawUnsafe<Array<{ a: string | null }>>(`SELECT platform_t4d_delivery_action(NULL, NULL, 'x', NULL) AS a`))[0].a).toBeNull();
    expect(deliveryRowsFor({ eventId: 'e', eventType: 'x', projectId: 'p', organizationId: 'o', streamPosition: 0n, entityType: 'X', entityId: 'x', payload: null, dispatchIntent: null }, [{ consumer: 'n', consumerKind: 'unordered', active: true, dispatchRule: null, subscribedEventTypes: [] }])).toEqual([]);
  });

  it('the kernel\'s `platform_t4d_push_payload` equals `pushPayloadFor`: null-coalesced body/roles/targetUserId, targetUserIds sorted-distinct only where carried, NULL without a body', async () => {
    const intents: Array<DispatchIntent | null> = [
      null,
      { effectKey: 'k', coverageVersion: 'v', invalidate: true },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: '' } },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: 'b' } },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: 'b', roles: ['pmc', 'client'], targetUserId: 'u1' } },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: 'b', roles: null, targetUserId: null, targetUserIds: ['u2', 'u1', 'u2', 'U0'] } },
      { effectKey: 'k', coverageVersion: 'v', invalidate: true, push: { body: 'b', targetUserIds: [] } },
    ];
    for (const intent of intents) {
      const [{ p }] = await t.prisma.$queryRawUnsafe<Array<{ p: unknown }>>(`SELECT platform_t4d_push_payload($1::jsonb) AS p`, intent === null ? null : JSON.stringify(intent));
      expect(p, JSON.stringify(intent)).toEqual(pushPayloadFor(intent));
    }
  });

  // ── P37: every writer writes the same rows ───────────────────────────────────────────────────
  it('the emitter\'s rows ARE `deliveryRowsFor`\'s rows over the persisted catalog: one per active ruled row, the push row carrying the projection and its subject, nothing for the inactive or rule-less rows', async () => {
    const id = entity();
    const { eventId } = await publish(id);
    const rows = await rowsOf(eventId);
    expect(rows).toEqual(await expectedRowsOf(eventId));
    const by = Object.fromEntries(rows.map((r) => [r.consumer, r]));
    expect(by[SOCKET_CONSUMER]).toMatchObject({ deliveryAction: 'dispatch', status: 'pending' });
    expect(by[PUSH_CONSUMER]).toMatchObject({ deliveryAction: 'dispatch', status: 'pending', subject: id, payload: { body: `Decision ${id} awaits you`, roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant'], targetUserId: null } });
    expect(by[ALL]).toMatchObject({ deliveryAction: 'dispatch', status: 'pending' });
    expect(by[TYPES]).toMatchObject({ deliveryAction: 'dispatch', status: 'pending', consumerKind: 'ordered' });
    expect(by['decisions.inbox']).toMatchObject({ deliveryAction: 'dispatch' });
    expect(by['labour.readiness']).toMatchObject({ deliveryAction: 'noop', status: 'pending' }); // an ordered no-op waits for its cursor
    expect(by[OFF]).toBeUndefined();
    expect(by[PUSHY]).toBeUndefined();
    expect(by[NORULE]).toBeUndefined();
    // a drafted decision: nobody but `all` dispatches; the push row is an unordered no-op, done
    const { eventId: e2 } = await draft(entity());
    const rows2 = await rowsOf(e2);
    expect(rows2).toEqual(await expectedRowsOf(e2));
    const by2 = Object.fromEntries(rows2.map((r) => [r.consumer, r]));
    expect(by2[PUSH_CONSUMER]).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    expect(by2[PUSH_CONSUMER]).not.toHaveProperty('payload');
    expect(by2[SOCKET_CONSUMER]).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    expect(by2[TYPES]).toMatchObject({ deliveryAction: 'noop', status: 'pending' });
    expect(by2[ALL]).toMatchObject({ deliveryAction: 'dispatch' });
  });

  it('a DIRECT writer that never calls `deliveryRowsFor` (the raw plant, from the catalog and the kernel\'s own derivation) writes the SAME rows; the expansion scanner re-creates exactly them', async () => {
    const eventId = `a6d-direct-${randomUUID().slice(0, 8)}`;
    await insertRawEvent(t.prisma, { projectId: f.projectA.id, organizationId: f.orgA.id, eventId, effectKey: 'decision.published.record', entityId: 'D-direct' });
    const expected = await expectedRowsOf(eventId);
    expect(expected.length).toBeGreaterThan(10);
    expect(await rowsOf(eventId)).toEqual(expected);
    // the scanner: every row deleted, every row re-created identically (payload and subject included)
    const { eventId: pushed } = await publish(entity());
    const expectedPush = await expectedRowsOf(pushed);
    // a delivery is never DELETED (`OutboxDelivery_t4d_retained`): the gap is planted by name
    await expect(t.prisma.outboxDelivery.deleteMany({ where: { eventId } })).rejects.toThrow(/durable delivery obligation — cancelled and RECORDED, never deleted/);
    expect(await rowsOf(eventId)).toEqual(expected);
    await plantDeliveryGap(t.prisma, { eventId: { in: [eventId, pushed] } });
    expect(await rowsOf(eventId)).toEqual([]);
    await relay.expandMissingDeliveries();
    expect(await rowsOf(eventId)).toEqual(expected);
    expect(await rowsOf(pushed)).toEqual(expectedPush);
  });

  // ── the obligation: DomainEvent_t4d_deliveries ───────────────────────────────────────────────
  const rawEvent = async (tx: Tx, eventId: string, entityId = 'D-raw'): Promise<void> => {
    await tx.$executeRawUnsafe(`UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = $1`, f.projectA.id);
    await tx.$executeRawUnsafe(
      `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
       SELECT $1,'decision.published',1,$2,$3,s."nextPosition" - 1,'system','system:a6d','Decision',$4,
              jsonb_build_object('effectKey','decision.published.record','coverageVersion',c."coverageVersion",'invalidate',c."invalidate")
         FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
        WHERE s."projectId" = $3 AND c."effectKey" = 'decision.published.record' AND c."coverageVersion" = $5`,
      eventId, f.orgA.id, f.projectA.id, entityId, effectCoverageVersion());
  };

  it('an event committed with NO delivery rows is refused at commit, naming the first consumer it owes; with every row but one, naming that one; with a wrong action, naming the derivation', async () => {
    const id = `a6d-owe-${randomUUID().slice(0, 8)}`;
    await expect(t.prisma.$transaction(async (tx) => { await rawEvent(tx, id); }, { timeout: 30_000 }))
      .rejects.toThrow(/owes consumer "activities\.material-readiness" a delivery row — its catalog row is ACTIVE and carries rule types/);
    expect(await t.prisma.domainEvent.findUnique({ where: { eventId: id } })).toBeNull();
    // every row but the socket's (a writer's own row cannot be deleted either — the rows are written without it)
    await expect(t.prisma.$transaction(async (tx) => {
      await rawEvent(tx, id);
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(id, { except: SOCKET_CONSUMER }));
    }, { timeout: 30_000 })).rejects.toThrow(/owes consumer "socket\.invalidation" a delivery row — its catalog row is ACTIVE and carries rule invalidate/);
    // a wrong action — the binding refuses it at the row, before the obligation ever judges
    await expect(t.prisma.$transaction(async (tx) => {
      await rawEvent(tx, id);
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(id, { except: SOCKET_CONSUMER }));
      await tx.$executeRawUnsafe(
        `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","updatedAt")
         SELECT gen_random_uuid()::text, e."eventId", e."projectId", $2, 'unordered', 'noop', e."streamPosition", 'succeeded', now() FROM "DomainEvent" e WHERE e."eventId" = $1`, id, SOCKET_CONSUMER);
    }, { timeout: 30_000 })).rejects.toThrow(/carries action `noop`, but the consumer's persisted rule invalidate derives `dispatch`/);
    // (#662 round 1, finding 1) a forged cancellation — the socket's row written as a marked `noop` — is
    // refused: the tombstone shape is the push rule's alone, so no bundle suppresses an invalidation
    await expect(t.prisma.$transaction(async (tx) => {
      await rawEvent(tx, id);
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(id, { except: SOCKET_CONSUMER }));
      await tx.$executeRawUnsafe(
        `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","cancelledAt","updatedAt")
         SELECT gen_random_uuid()::text, e."eventId", e."projectId", $2, 'unordered', 'noop', e."streamPosition", 'succeeded', now(), now() FROM "DomainEvent" e WHERE e."eventId" = $1`, id, SOCKET_CONSUMER);
    }, { timeout: 30_000 })).rejects.toThrow(/carries action `noop`, but the consumer's persisted rule invalidate derives `dispatch`/);
    // the complete set commits
    await t.prisma.$transaction(async (tx) => {
      await rawEvent(tx, id);
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(id));
    }, { timeout: 30_000 });
    expect(await rowsOf(id)).toEqual(await expectedRowsOf(id));
  });

  // (#662 round 1, finding 3) a consumer with rows but no handler in this process
  it('the relay CLAIMS the rows of an active consumer whose code this process lacks and dead-letters them by name — never leaves them pending in silence', async () => {
    const UNHANDLED = 'test.a6d.unhandled';
    await sanctionedConsumerRemoval(t.prisma, [UNHANDLED]);
    // an ORDERED consumer: always the relay's to claim, whatever the sender mode (an external one's
    // fresh first attempt belongs to the immediate dispatcher in legacy mode, and reaches the relay
    // only as recovery)
    await t.prisma.outboxConsumerCatalog.create({ data: { consumer: UNHANDLED, consumerKind: 'ordered', consumerEffect: 'db', catalogVersion: 1, dispatchRule: 'all' } });
    try {
      const { eventId } = await draft(entity());
      const before = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: UNHANDLED } });
      expect(before).toMatchObject({ deliveryAction: 'dispatch', status: 'pending', consumerKind: 'ordered' });
      await relay.runOnce();
      const after = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.status).toBe('dead');
      expect(after.lastError).toMatch(/no consumer registered: test\.a6d\.unhandled/);
    } finally {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
      await sanctionedConsumerRemoval(t.prisma, [UNHANDLED]);
    }
  });

  it('the obligation is the ACTIVE, RULED set: nothing is owed to an inactive row or a rule-less row, and a row written for the inactive consumer is admitted — the seal never forbids one', async () => {
    const id = `a6d-set-${randomUUID().slice(0, 8)}`;
    await t.prisma.$transaction(async (tx) => {
      await rawEvent(tx, id);
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(id)); // writes nothing for OFF, PUSHY or NORULE
      // a row for the INACTIVE consumer, with the action its rule derives: admitted
      await tx.$executeRawUnsafe(
        `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","updatedAt")
         SELECT gen_random_uuid()::text, e."eventId", e."projectId", $2, 'unordered', 'dispatch', e."streamPosition", 'pending', now() FROM "DomainEvent" e WHERE e."eventId" = $1`, id, OFF);
    }, { timeout: 30_000 });
    const rows = await rowsOf(id);
    expect(rows.find((r) => r.consumer === OFF)).toMatchObject({ deliveryAction: 'dispatch' });
    expect(rows.find((r) => r.consumer === NORULE)).toBeUndefined();
    expect(rows.find((r) => r.consumer === PUSHY)).toBeUndefined();
    // and the scanner owes them nothing either
    expect(await relay.expandMissingDeliveries()).toBe(0);
  });

  it('the seals are on ALWAYS_EXECUTE and re-applied over the migrated database they rewrite nothing and stand', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const MIGRATION = '20271231000000_phase6_t4d_ii_a6d_delivery_seals';
    const list = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate.sh'), 'utf8').match(/ALWAYS_EXECUTE="([^"]+)"/)?.[1] ?? '';
    const entries = list.split('\n').map((l) => l.trim());
    expect(entries).toContain(MIGRATION);
    const { eventId } = await publish(entity());
    const before = await rowsOf(eventId);
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    for (const m of entries.filter((m) => m >= MIGRATION).sort()) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', join(__dirname, '..', '..', 'prisma', 'migrations', m, 'migration.sql')], { stdio: 'pipe' });
    }
    expect(await rowsOf(eventId)).toEqual(before);
    const triggers = await t.prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('DomainEvent_t4d_deliveries','OutboxDelivery_t4d_bound','OutboxDelivery_t4d_frozen','OutboxDelivery_t4d_retained') ORDER BY tgname`;
    expect(triggers.map((x) => x.tgname)).toEqual(['DomainEvent_t4d_deliveries', 'OutboxDelivery_t4d_bound', 'OutboxDelivery_t4d_frozen', 'OutboxDelivery_t4d_retained']);
  });

  // ── the binding: OutboxDelivery_t4d_bound ───────────────────────────────────────────────────
  const plantRow = (tx: Tx, eventId: string, consumer: string, kind: string, action: string, extra: { status?: string; payload?: string | null; subject?: string | null; cancelled?: boolean } = {}) =>
    probe(tx,
      `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","payload","subject","cancelledAt","updatedAt")
       SELECT gen_random_uuid()::text, e."eventId", e."projectId", $2, $3, $4, e."streamPosition", $5, $6::jsonb, $7, ${extra.cancelled ? 'now()' : 'NULL'}, now()
         FROM "DomainEvent" e WHERE e."eventId" = $1`,
      eventId, consumer, kind, action, extra.status ?? (action === 'dispatch' ? 'pending' : 'succeeded'), extra.payload ?? null, extra.subject ?? null);

  it('every row carries the action its rule derives, whatever the activation state; a rule-less consumer\'s row is refused; the push projection and subject are bound; the previous release\'s shape and the born-cancelled tombstone are admitted', async () => {
    const id = entity();
    const body = `Decision ${id} awaits you`;
    const { eventId } = await publish(id); // the compiled rows exist; PUSHY (inactive, push) and OFF (inactive, all) have none
    const projection = JSON.stringify({ body, roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant'], targetUserId: null });
    await rolledBack(async (tx) => {
      // the inactive `all` consumer: the action is judged all the same
      expect(await plantRow(tx, eventId, OFF, 'unordered', 'noop')).toMatch(/carries action `noop`, but the consumer's persisted rule all derives `dispatch`/);
      expect(await plantRow(tx, eventId, OFF, 'unordered', 'dispatch')).toBeNull();
      // (#662 round 1, finding 1) the born-cancelled tombstone is the PUSH rule's alone: a marked `noop`
      // for an `all` or `types` consumer is a forged cancellation of a socket invalidation or a projection
      expect(await plantRow(tx, eventId, OFF, 'unordered', 'noop', { status: 'succeeded', cancelled: true })).toMatch(/persisted rule all derives `dispatch`/);
      expect(await plantRow(tx, eventId, OFF, 'unordered', 'noop', { status: 'succeeded', cancelled: true, subject: id })).toMatch(/persisted rule all derives `dispatch`/);
      // a rule-less consumer derives nothing: refused by name
      expect(await plantRow(tx, eventId, NORULE, 'unordered', 'dispatch')).toMatch(/consumer "test\.a6d\.norule" carries NO persisted dispatch rule/);
      expect(await plantRow(tx, eventId, NORULE, 'unordered', 'noop')).toMatch(/NO persisted dispatch rule/);
      // the push-rule consumer: the projection, field by field
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: projection, subject: id })).toBeNull();
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body: 'a body of the writer\'s choosing', roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant'], targetUserId: null }), subject: id })).toMatch(/not the PROJECTION of the event's immutable intent/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body, roles: ['client'], targetUserId: null }), subject: id })).toMatch(/not the PROJECTION/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body, roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant'], targetUserId: 'one-chosen-user' }), subject: id })).toMatch(/not the PROJECTION/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body, roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant'], targetUserId: null, targetUserIds: ['u'] }), subject: id })).toMatch(/not the PROJECTION/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body, roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant'], targetUserId: null, title: 'foreign' }), subject: id })).toMatch(/not the PROJECTION/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: null, subject: id })).toMatch(/not the PROJECTION/);
      // the subject is the event's entityId
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: projection, subject: 'D-other' })).toMatch(/carries subject D-other but the event is about entity/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: projection, subject: null })).toMatch(/carries subject <null>/);
      // the previous release's shape for an intent it can emit: roles present, targetUserId null — admitted (the projection above IS that shape)
      // a no-op push row carries no payload
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'noop')).toMatch(/carries action `noop`, but the consumer's persisted rule push derives `dispatch`/);
      // the born-cancelled tombstone: noop, marked, succeeded, no payload, its subject — admitted
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'noop', { status: 'succeeded', subject: id, cancelled: true })).toBeNull();
      // a marked noop carrying a payload, or a foreign subject, is not the tombstone shape: the action arm refuses it
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'noop', { status: 'succeeded', subject: id, cancelled: true, payload: projection })).toMatch(/persisted rule push derives `dispatch`/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'noop', { status: 'succeeded', subject: 'D-other', cancelled: true })).toMatch(/persisted rule push derives `dispatch`/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'noop', { status: 'pending', subject: id, cancelled: true })).toMatch(/derives `dispatch`/);
      // any other rule: neither payload nor subject
      expect(await plantRow(tx, eventId, OFF, 'unordered', 'dispatch', { payload: '{"legacy":"body"}' })).toMatch(/carries a payload or a subject — only a push-rule delivery projects the intent/);
      expect(await plantRow(tx, eventId, OFF, 'unordered', 'dispatch', { subject: id })).toMatch(/only a push-rule delivery projects the intent/);
    });
    // a drafted event carries no push: the push consumer's noop row carries no payload, and a dispatch is refused
    const { eventId: drafted } = await draft(entity());
    await rolledBack(async (tx) => {
      expect(await plantRow(tx, drafted, PUSHY, 'unordered', 'noop')).toBeNull();
      expect(await plantRow(tx, drafted, PUSHY, 'unordered', 'noop', { payload: '{"body":"x"}' })).toMatch(/carries a payload or a foreign subject/);
      expect(await plantRow(tx, drafted, PUSHY, 'unordered', 'dispatch', { payload: '{"body":"invented","roles":null,"targetUserId":null}', subject: 'D-x' })).toMatch(/carries action `dispatch`, but the consumer's persisted rule push derives `noop`/);
    });
  });

  it('a targeted SET (`targetUserIds`) is projected as the canonical sorted distinct array, and bound as such', async () => {
    // No compiled effect key resolves a FROZEN audience yet (4d-ii's countersign demand is A7's),
    // so `DomainEvent_t4d_envelope` refuses the shape on every current family; the event is planted
    // under that seal's NAMED bypass, inside one rolled-back transaction, and what is probed is the
    // BINDING of the push row — which judges the row against the intent as written.
    const id = entity();
    const eventId = `a6d-set-${randomUUID().slice(0, 8)}`;
    const intent = { effectKey: 'decision.published', coverageVersion: effectCoverageVersion(), invalidate: true, push: { body: 'to the set', roles: ['pmc'], targetUserIds: ['u-b', 'u-a', 'u-b'] } };
    await rolledBack(async (tx) => {
      // transactional DDL: the ROLLBACK that ends `rolledBack` puts the seal back (a re-enable here
      // would be refused — the event's deferred seals are pending on the same table)
      await tx.$executeRawUnsafe(`ALTER TABLE "DomainEvent" DISABLE TRIGGER "DomainEvent_t4d_envelope"`);
      await tx.$executeRawUnsafe(`UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = $1`, f.projectA.id);
      await tx.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
         SELECT $1,'decision.published',1,$2,$3,s."nextPosition" - 1,'system','system:a6d','Decision',$4,$5::jsonb FROM "ProjectEventStream" s WHERE s."projectId" = $3`,
        eventId, f.orgA.id, f.projectA.id, id, JSON.stringify(intent));
      // the direct writer's rows: the push row carries the canonical set
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(eventId));
      const push = await tx.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: PUSH_CONSUMER } });
      expect(push).toMatchObject({ deliveryAction: 'dispatch', subject: id, payload: { body: 'to the set', roles: ['pmc'], targetUserId: null, targetUserIds: ['u-a', 'u-b'] } });
      expect(push.payload).toEqual(pushPayloadFor(intent as DispatchIntent));
      expect(deliveryRowsFor(await metaOfVia(tx, eventId), [{ consumer: PUSH_CONSUMER, consumerKind: 'unordered', active: true, dispatchRule: 'push', subscribedEventTypes: [] }])[0]).toMatchObject({ payload: push.payload, subject: id });
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body: 'to the set', roles: ['pmc'], targetUserId: null, targetUserIds: ['u-a', 'u-b'] }), subject: id })).toBeNull();
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body: 'to the set', roles: ['pmc'], targetUserId: null, targetUserIds: ['u-b', 'u-a'] }), subject: id })).toMatch(/not the PROJECTION/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body: 'to the set', roles: ['pmc'], targetUserId: null, targetUserIds: ['u-a'] }), subject: id })).toMatch(/not the PROJECTION/);
      expect(await plantRow(tx, eventId, PUSHY, 'unordered', 'dispatch', { payload: JSON.stringify({ body: 'to the set', roles: ['pmc'], targetUserId: null }), subject: id })).toMatch(/not the PROJECTION/);
    });
  });

  // ── the freeze: OutboxDelivery_t4d_frozen ────────────────────────────────────────────────────
  it('identity and payload are FROZEN; subject moves only NULL -> the event\'s entityId; noop never becomes dispatch; a bare dispatch -> noop is refused; the operational columns move', async () => {
    const id = entity();
    const { eventId } = await publish(id);
    const { eventId: other } = await draft(entity());
    const push = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: PUSH_CONSUMER } });
    const socket = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: SOCKET_CONSUMER } });
    const noop = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: other, consumer: PUSH_CONSUMER } });
    const otherEvent = await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId: other } });
    await rolledBack(async (tx) => {
      const up = (set: string, rowId = push.id) => attempt(tx, `UPDATE "OutboxDelivery" SET ${set} WHERE "id" = $1`, rowId);
      expect(await up(`"eventId" = '${other}', "projectId" = '${otherEvent.projectId}', "streamPosition" = ${otherEvent.streamPosition}`)).toMatch(/FROZEN/);
      expect(await up(`"consumer" = '${ALL}'`)).toMatch(/FROZEN|foreign key/);
      expect(await up(`"consumerKind" = 'ordered'`)).toMatch(/FROZEN|foreign key/);
      expect(await up(`"payload" = '{"body":"rewritten"}'::jsonb`)).toMatch(/FROZEN/);
      expect(await up(`"payload" = NULL`)).toMatch(/FROZEN/);
      expect(await up(`"id" = 'other-id'`)).toMatch(/FROZEN/);
      expect(await up(`"subject" = 'D-other'`)).toMatch(/subject may move only from NULL to the row's own event's entityId/);
      expect(await up(`"subject" = NULL`)).toMatch(/subject may move only/);
      expect(await up(`"deliveryAction" = 'dispatch'`, noop.id)).toMatch(/deliveryAction moves only dispatch -> noop, never noop -> dispatch/);
      expect(await up(`"deliveryAction" = 'noop', "status" = 'succeeded'`, socket.id)).toMatch(/dispatch -> noop is admitted only as the cancellation MARK/);
      // the operationally mutable set
      expect(await up(`"status" = 'leased', "leaseOwner" = 'w1', "leaseExpiresAt" = now() + interval '30 seconds', "attempts" = 1, "nextAttemptAt" = now(), "lastError" = 'x'`, socket.id)).toBeNull();
      expect(await up(`"status" = 'dead'`, socket.id)).toBeNull();
      expect(await up(`"status" = 'succeeded', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL`, socket.id)).toBeNull();
    });
    // the 4a subject stamp: a row an old instance wrote subjectless (planted by name) takes its own entityId, and only that
    await plantLegacyDelivery(t.prisma, (tx) => tx.outboxDelivery.update({ where: { id: push.id }, data: { subject: null } }));
    await rolledBack(async (tx) => {
      expect(await attempt(tx, `UPDATE "OutboxDelivery" SET "subject" = 'D-invented' WHERE "id" = $1`, push.id)).toMatch(/subject may move only from NULL/);
      expect(await attempt(tx, `UPDATE "OutboxDelivery" d SET "subject" = e."entityId" FROM "DomainEvent" e WHERE e."eventId" = d."eventId" AND d."id" = $1`, push.id)).toBeNull();
      expect((await tx.outboxDelivery.findUniqueOrThrow({ where: { id: push.id } })).subject).toBe(id);
    });
  });

  it('dispatch -> noop through the three transitions: the MARK in its own statement, the COMPLETION of a marked row, the LEGACY neutralization; the mark is never cleared or rewritten', async () => {
    const id = entity();
    const { eventId } = await publish(id);
    const push = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: PUSH_CONSUMER } });
    const socket = await t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId, consumer: SOCKET_CONSUMER } });
    await rolledBack(async (tx) => {
      const up = (set: string, rowId: string) => attempt(tx, `UPDATE "OutboxDelivery" SET ${set} WHERE "id" = $1`, rowId);
      // the MARK: `cancelQueuedPushBySubject`'s neutralization of a pending row — payload preserved
      expect(await up(`"status" = 'succeeded', "deliveryAction" = 'noop', "cancelledAt" = now(), "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL`, push.id)).toBeNull();
      const marked = await tx.outboxDelivery.findUniqueOrThrow({ where: { id: push.id } });
      expect(marked).toMatchObject({ deliveryAction: 'noop', status: 'succeeded', payload: push.payload });
      expect(marked.cancelledAt).not.toBeNull();
      // never cleared, never rewritten
      expect(await up(`"cancelledAt" = NULL`, push.id)).toMatch(/never cleared or rewritten/);
      expect(await up(`"cancelledAt" = now() + interval '1 hour'`, push.id)).toMatch(/never cleared or rewritten/);
      // the COMPLETION: the mark-only arm on a LEASED row (the sender owns it), then the sender's own neutralization
      expect(await up(`"status" = 'leased', "leaseOwner" = 'sender', "leaseExpiresAt" = now() + interval '30 seconds'`, socket.id)).toBeNull();
      expect(await up(`"cancelledAt" = now()`, socket.id)).toBeNull(); // the mark alone, status unchanged
      expect(await up(`"status" = 'succeeded', "deliveryAction" = 'noop', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL`, socket.id)).toBeNull();
      expect(await tx.outboxDelivery.findUniqueOrThrow({ where: { id: socket.id } })).toMatchObject({ deliveryAction: 'noop', status: 'succeeded' });
    });
    // the LEGACY neutralization: a pre-intent event (NULL intent) and a pre-cutover one (a coverage no
    // catalog row holds), each planted with a `dispatch` socket row under the named bypass — the
    // relay's `dispatchExternal` and the cutover seal retire them, and only them
    const legacy = async (coverage: string | null): Promise<string> => {
      const ev = `a6d-legacy-${randomUUID().slice(0, 8)}`;
      const del = `${ev}-socket`;
      const pos = Number((await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: f.projectA.id } })).nextPosition);
      const intent = coverage === null ? 'NULL' : `'${JSON.stringify({ effectKey: 'compat.task6', coverageVersion: coverage, invalidate: true })}'::jsonb`;
      await plantLegacyEvent(t.prisma, f.projectA.id, pos, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
           VALUES ('${ev}','decision.approved',1,'${f.orgA.id}','${f.projectA.id}',${pos},'system','system:seed','Decision','D',${intent})`);
        await tx.$executeRawUnsafe(
          `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","updatedAt")
           VALUES ('${del}','${ev}','${f.projectA.id}','${SOCKET_CONSUMER}','unordered','dispatch',${pos},'pending', now())`);
      });
      return del;
    };
    const nullIntent = await legacy(null);
    const oldCoverage = await legacy('old-coverage');
    await rolledBack(async (tx) => {
      const up = (set: string, rowId: string) => attempt(tx, `UPDATE "OutboxDelivery" SET ${set} WHERE "id" = $1`, rowId);
      const neutralize = `"status" = 'succeeded', "deliveryAction" = 'noop', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL`;
      expect(await up(neutralize, nullIntent)).toBeNull();
      expect(await up(neutralize, oldCoverage)).toBeNull();
      expect(await up(neutralize, socket.id)).toMatch(/dispatch -> noop is admitted only as/); // a CURRENT event's row: refused
    });
  });

  // ── P38: the barrier ─────────────────────────────────────────────────────────────────────────
  it('event vs ACTIVATION: an activation of an INACTIVE row waits behind an in-flight event\'s catalog read (observed BLOCKED), commits after it, and the next event carries the row', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let emitted!: (id: string) => void;
    const emittedP = new Promise<string>((r) => { emitted = r; });
    // A: the emitter, held open after its rows are written (every catalog row FOR SHARE, OFF's included)
    const a = t.prisma.$transaction(async (tx) => {
      const m = await emitEvent(tx, { projectId: f.projectA.id, actor: human, eventType: 'decision.published', entityType: 'Decision', entityId: entity(), effectKey: 'decision.published.record', dispatch: {} });
      emitted(m.eventId);
      await held;
    }, { timeout: 60_000 });
    const first = await emittedP;
    // B: the activation of the INACTIVE consumer takes its row FOR UPDATE — behind A's share lock
    const b = activation.request({ consumer: OFF, active: true, reason: 'probe: activate while an event is in flight', actorId: 'a6d', requestToken: randomUUID() });
    try {
      await waitFor('the activation waiting on the catalog row', async () => (await blockedOn('%"OutboxConsumerCatalog"%FOR UPDATE%')) >= 1);
      expect((await t.prisma.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer: OFF } })).active).toBe(false);
      release();
      await a;
      await b;
      expect((await t.prisma.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer: OFF } })).active).toBe(true);
      // the event that read the catalog before the activation carries no row for OFF — the
      // activation waited for its commit, so OFF's obligations start with the next event
      expect((await rowsOf(first)).find((r) => r.consumer === OFF)).toBeUndefined();
      const { eventId: next } = await draft(entity());
      expect((await rowsOf(next)).find((r) => r.consumer === OFF)).toMatchObject({ deliveryAction: 'dispatch' });
      expect(await rowsOf(next)).toEqual(await expectedRowsOf(next));
    } finally {
      release();
      await activation.request({ consumer: OFF, active: false, reason: 'probe: back to inactive', actorId: 'a6d', requestToken: randomUUID() });
    }
  });

  it('event vs REGISTRATION through the EMITTER: a new consumer\'s registration waits behind the in-flight event (observed BLOCKED on the key), and the next event carries its row', async () => {
    const LATE = 'test.a6d.late';
    await sanctionedConsumerRemoval(t.prisma, [LATE]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let emitted!: (id: string) => void;
    const emittedP = new Promise<string>((r) => { emitted = r; });
    const a = t.prisma.$transaction(async (tx) => {
      const m = await emitEvent(tx, { projectId: f.projectA.id, actor: human, eventType: 'decision.drafted', entityType: 'Decision', entityId: entity(), effectKey: 'decision.drafted', dispatch: {} });
      emitted(m.eventId);
      await held;
    }, { timeout: 60_000 });
    const first = await emittedP;
    await waitFor('A to hold the key SHARED', async () => (await keyLocks('ShareLock', true)) >= 1);
    registerConsumer(adHoc(LATE, 'unordered', { kind: 'all' }));
    const b = syncConsumerCatalog(t.prisma);
    try {
      await waitFor('the registration waiting for the key EXCLUSIVE', async () => (await keyLocks('ExclusiveLock', false)) === 1);
      expect(await t.prisma.outboxConsumerCatalog.findUnique({ where: { consumer: LATE } })).toBeNull();
      release();
      await a;
      await b;
      expect((await rowsOf(first)).find((r) => r.consumer === LATE)).toBeUndefined();
      const { eventId: next } = await draft(entity());
      expect((await rowsOf(next)).find((r) => r.consumer === LATE)).toMatchObject({ deliveryAction: 'dispatch' });
    } finally {
      release();
      unregisterConsumer(LATE);
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
      await sanctionedConsumerRemoval(t.prisma, [LATE]);
    }
  });

  it('event vs REGISTRATION through a DIRECT writer that never calls `deliveryRowsFor`: a consumer registered between its rows and its commit makes the commit REFUSED, never admitted without the row', async () => {
    const REG = 'test.a6d.reg';
    await sanctionedConsumerRemoval(t.prisma, [REG]);
    const id = `a6d-reg-${randomUUID().slice(0, 8)}`;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let written!: () => void;
    const writtenP = new Promise<void>((r) => { written = r; });
    // A: the direct writer — event and rows from the catalog AS IT WAS, holding no key (it never
    // called the helper), then held before its commit
    const a = t.prisma.$transaction(async (tx) => {
      await rawEvent(tx, id);
      await tx.$executeRawUnsafe(rawDeliveryRowsSql(id));
      written();
      await held;
    }, { timeout: 60_000 });
    await writtenP;
    // B: a registration — uncontended, since A holds no key yet — commits an ACTIVE, RULED consumer
    registerConsumer(adHoc(REG, 'unordered', { kind: 'all' }));
    try {
      await syncConsumerCatalog(t.prisma);
      expect((await t.prisma.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer: REG } })).active).toBe(true);
      release();
      // A commits: the seal takes the key SHARED, scans the catalog it now sees, and finds REG owed and unpaid
      await expect(a).rejects.toThrow(/owes consumer "test\.a6d\.reg" a delivery row/);
      expect(await t.prisma.domainEvent.findUnique({ where: { eventId: id } })).toBeNull();
    } finally {
      release();
      unregisterConsumer(REG);
      await sanctionedConsumerRemoval(t.prisma, [REG]);
    }
  });

  it('the reverse through the DIRECT writer: an uncommitted registration holds the key EXCLUSIVE, so the writer\'s COMMIT waits at the seal (observed BLOCKED on the key); when the registration rolls back the event commits with the rows it wrote', async () => {
    const HOLD = 'test.a6d.hold';
    await sanctionedConsumerRemoval(t.prisma, [HOLD]);
    const id = `a6d-hold-${randomUUID().slice(0, 8)}`;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // B: a catalog INSERT through the barrier trigger, held open
    const b = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "OutboxConsumerCatalog" ("consumer","consumerKind","consumerEffect","catalogVersion","active","dispatchRule","updatedAt") VALUES ($1,'unordered','external',1,true,'all',now()) /* a6d-hold */`, HOLD);
      await held;
      throw SENTINEL;
    }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    await waitFor('B to hold the key EXCLUSIVE', async () => (await keyLocks('ExclusiveLock', true)) === 1);
    // A: the direct writer commits — the deferred seal's SHARED acquisition waits behind B
    const a = (async () => {
      await t.prisma.$transaction(async (tx) => {
        await rawEvent(tx, id);
        await tx.$executeRawUnsafe(rawDeliveryRowsSql(id));
      }, { timeout: 60_000 });
    })();
    try {
      await waitFor('the writer\'s commit waiting for the key SHARED', async () => (await keyLocks('ShareLock', false)) === 1);
      expect(await t.prisma.domainEvent.findUnique({ where: { eventId: id } })).toBeNull(); // not committed
      release();
      await b; // rolled back: HOLD never existed
      await a; // admitted: the catalog it scans is the one it wrote for
      expect(await rowsOf(id)).toEqual(await expectedRowsOf(id));
      expect(await t.prisma.outboxConsumerCatalog.findUnique({ where: { consumer: HOLD } })).toBeNull();
    } finally {
      release();
      await sanctionedConsumerRemoval(t.prisma, [HOLD]);
    }
  });

  it('the compiled consumers\' rules are what the rows derive from: for every compiled consumer, its row\'s persisted rule equals its declaration', async () => {
    const rows = await catalog();
    for (const c of ['socket.invalidation', 'webpush.notify', 'decisions.inbox', 'daily-log.inbox', 'drawings.inbox', 'inspections.inbox', 'activities.schedule', 'activities.material-readiness', 'labour.readiness', 'commercial.cash-forecast']) {
      const row = rows.find((r) => r.consumer === c);
      expect(row, c).toBeDefined();
      expect(row!.dispatchRule, c).not.toBeNull();
    }
    // and the declaration round-trips through `persistedRule`
    expect(persistedRule({ kind: 'types', eventTypes: ['b', 'a', 'b'] })).toEqual({ dispatchRule: 'types', subscribedEventTypes: ['a', 'b'] });
    expect(dispatchActionFor({ kind: 'types', eventTypes: ['a'] }, { eventType: 'a', dispatchIntent: null })).toBe('dispatch');
  });
});
