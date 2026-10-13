import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { alwaysExecuteReplay, createTwoProjectFixture, insertRawEventVia, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import type { PrismaService } from '../../src/prisma.service';

/**
 * Site Visits (#792) SV1-a — the visit record, as PostgreSQL enforces it on EVERY writer (raw SQL here, because no
 * command exists until SV1-b). Each rule of `20280112000000_site_visits_sv1a_record` is proved beside an accepted,
 * coherent row; the review findings (F45–F61 on #792) are named where they are answered.
 *
 *   V1  tenancy and the project → visit → child cascade (F60)
 *   V2  standing under the envelope's lock order (F55), names copied from the locked identity and node (F57, F61),
 *       only the visitor adds or retires (F46)
 *   V3  accepted time = the claim inside its window, else the receipt; adjusted exactly when they differ (F47, F54)
 *   V4  lifecycle, closed visits and after-end places (F49), a place always names its node (F51)
 *   V5  immutable: no delete, no truncate, node references cleared only by the node's removal (F58)
 *   V6  each change paired with exactly one same-transaction event from the attributed human, and start, end and
 *       close with exactly one notice of that kind (F45, F59)
 */
type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Pair = { type: string; actor: string; role: string; rowId?: string; notice?: boolean; noEnvelope?: boolean };

describe('Site Visits SV1-a — the visit record (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
  const extraProjects: string[] = [];
  const names = new Map<string, string>();
  let consultant: string;
  let n1: { id: string; name: string };
  let n2: { id: string; name: string };
  let draft: string;
  let nodeB: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // the start window is [max(receipt − 7 days, project start), receipt]; give project A a month of history
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    consultant = `sv-cons-${run}`;
    extraUsers.push(consultant);
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    const node = (projectId: string, name: string, published = true) => t.prisma.projectNode.create({
      data: { projectId, name, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: published ? new Date() : null },
    });
    const a = await node(f.projectA.id, `Tower A ${run}`);
    const b = await node(f.projectA.id, `Basement ${run}`);
    n1 = { id: a.id, name: a.name };
    n2 = { id: b.id, name: b.name };
    draft = (await node(f.projectA.id, `Draft ${run}`, false)).id;
    nodeB = (await node(f.projectB.id, `Other site ${run}`)).id;
    const ids = [f.memberUser.id, f.ownerUser.id, f.otherUser.id, f.clientUser.id, consultant];
    const rows = await t.prisma.$queryRawUnsafe<Array<{ userId: string; displayName: string }>>(
      `SELECT "userId","displayName" FROM "UserIdentity" WHERE "userId" = ANY($1::text[])`, ids,
    );
    for (const r of rows) names.set(r.userId, r.displayName);
  });

  afterAll(async () => {
    // the record is immutable; the disposable test DB clears it by the sanctioned reset, before the users it names
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.notification.deleteMany({ where: { projectId: { in: extraProjects } } });
      await t.prisma.membership.deleteMany({ where: { OR: [{ userId: { in: extraUsers } }, { projectId: { in: extraProjects } }] } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: { in: extraProjects } } });
      await t.prisma.project.deleteMany({ where: { id: { in: extraProjects } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  // ── writers ──────────────────────────────────────────────────────────────────────────────────

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const UTC = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;
  const tag = (label: string) => `sv-${label}-${randomUUID().slice(0, 8)}`;
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));
  const reachesLockWait = async (marker: string, ms = 10_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        `%${marker}%`,
      );
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const orgOf = (projectId: string) => (projectId === f.projectB.id ? f.orgB.id : f.orgA.id);
  const projectOf = async (q: Tx, visitId: string) =>
    (await q.$queryRaw<Array<{ projectId: string }>>`SELECT "projectId" FROM "SiteVisit" WHERE "id" = ${visitId}`)[0]?.projectId ?? f.projectA.id;

  /** One `sitevisit.*` event on the visit's stream from a human with their true envelope pair, and its notice. */
  const plant = async (q: Tx, projectId: string, visitId: string, p: Pair): Promise<string> => {
    const eventId = randomUUID();
    const name = (names.get(p.actor) ?? 'unknown').replace(/'/g, "''");
    await insertRawEventVia(q, {
      projectId, organizationId: orgOf(projectId), eventId, eventType: p.type, effectKey: p.type,
      entityType: 'SiteVisit', entityId: visitId, actor: { actorKind: 'human', actorId: p.actor },
      columns: ['"actorRole"', '"actorName"', '"payload"'],
      values: [p.noEnvelope ? 'NULL' : `'${p.role}'`, p.noEnvelope ? 'NULL' : `'${name}'`, p.rowId ? `'${JSON.stringify({ rowId: p.rowId })}'::jsonb` : 'NULL'],
    });
    if (p.notice) {
      await q.$executeRawUnsafe(
        `INSERT INTO "Notification" ("id","projectId","text","color","time","kind","eventId")
         VALUES (gen_random_uuid()::text, $1, 'Site visit', '#000', 'just now', $2, $3)`,
        projectId, p.type, eventId,
      );
    }
    return eventId;
  };

  /** A change and its pairs in ONE transaction: the row first (the deferred half claims) or the event first. */
  const paired = (projectId: string, visitId: string, write: (q: Tx) => Promise<unknown>, pairs: Pair[], eventFirst = false) =>
    t.prisma.$transaction(async (q) => {
      if (!eventFirst) await write(q);
      for (const p of pairs) await plant(q, projectId, visitId, p);
      if (eventFirst) await write(q);
    }, { timeout: 30_000 });

  type StartOpts = { id?: string; projectId?: string; visitor?: string; role?: string; node?: string | null; claimed?: string; device?: boolean; accuracy?: string; tagged?: string };
  /** The raw start: FORGED name, label and accepted/received times, all of which the database must overwrite. */
  const startRow = (q: Tx, o: Required<Omit<StartOpts, 'tagged'>> & { tagged?: string }) =>
    q.$executeRawUnsafe(
      `INSERT /* ${o.tagged ?? ''} */ INTO "SiteVisit" ("id","projectId","visitorId","visitorRole","visitorName","startClaimedAt","startedAt",
         "startTimeAdjusted","startReceivedAt","startNodeId","startPlaceName","locationKind","locLat","locLng","locAccuracyM","locAt")
       VALUES ($1,$2,$3,$4,'Forged Name',${UTC(5)},'2001-01-01',false,'2001-01-01',$6,'Forged Place',$7,
         ${o.device ? `23.02, 72.57, ${o.accuracy}, ${UTC(5)}` : 'NULL,NULL,NULL,NULL'})`,
      o.id, o.projectId, o.visitor, o.role, o.claimed, o.node, o.device ? 'device' : 'none',
    );
  const startOpts = (o: StartOpts) => ({
    id: o.id ?? randomUUID(), projectId: o.projectId ?? f.projectA.id, visitor: o.visitor ?? f.memberUser.id,
    role: o.role ?? 'pmc', node: o.node === undefined ? n1.id : o.node, claimed: o.claimed ?? ago(10), device: o.device ?? true, accuracy: o.accuracy ?? '12.5', tagged: o.tagged,
  });
  const start = async (o: StartOpts = {}, eventFirst = false): Promise<string> => {
    const s = startOpts(o);
    await paired(s.projectId, s.id, (q) => startRow(q, s), [{ type: 'sitevisit.started', actor: s.visitor, role: s.role, notice: true }], eventFirst);
    return s.id;
  };

  const endRow = (q: Tx, id: string, claimed: string, tagged = '') =>
    q.$executeRawUnsafe(
      `UPDATE /* ${tagged} */ "SiteVisit" SET "status" = 'ended', "endClaimedAt" = ${UTC(2)}, "endedAt" = '2001-01-01',
         "endTimeAdjusted" = false, "endReceivedAt" = '2001-01-01' WHERE "id" = $1`, id, claimed);
  const end = async (id: string, claimed = ago(1), by = f.memberUser.id, role = 'pmc', eventFirst = false) =>
    paired(await projectOf(t.prisma as unknown as Tx, id), id, (q) => endRow(q, id, claimed),
      [{ type: 'sitevisit.ended', actor: by, role, notice: true }], eventFirst);

  const closeRow = (q: Tx, id: string, closer: string, reason: string, tagged = '') =>
    q.$executeRawUnsafe(`UPDATE /* ${tagged} */ "SiteVisit" SET "status" = 'closed', "closedById" = $2, "closeReason" = $3, "closedAt" = '2001-01-01' WHERE "id" = $1`, id, closer, reason);
  const close = async (id: string, closer = f.memberUser.id, reason = 'Visitor forgot to end it') =>
    paired(await projectOf(t.prisma as unknown as Tx, id), id, (q) => closeRow(q, id, closer, reason),
      [{ type: 'sitevisit.closed', actor: closer, role: 'pmc', notice: true }]);

  const lateEndRow = (q: Tx, id: string, claimed: string) =>
    q.$executeRawUnsafe(`UPDATE "SiteVisit" SET "lateEndClaimedAt" = ${UTC(2)} WHERE "id" = $1`, id, claimed);
  const lateEnd = async (id: string, visitor: string, role: string, claimed = ago(1)) =>
    paired(await projectOf(t.prisma as unknown as Tx, id), id, (q) => lateEndRow(q, id, claimed),
      [{ type: 'sitevisit.late_end_recorded', actor: visitor, role }]);

  const placeRow = (q: Tx, o: { id: string; projectId: string; visitId: string; nodeId: string | null; by: string; claimed: string; tagged?: string }) =>
    q.$executeRawUnsafe(
      `INSERT /* ${o.tagged ?? ''} */ INTO "SiteVisitPlace" ("id","projectId","visitId","nodeId","placeName","addedById","addedClaimedAt","addedAt","addedReceivedAt")
       VALUES ($1,$2,$3,$4,'Forged Place',$5,${UTC(6)},'2001-01-01','2001-01-01')`,
      o.id, o.projectId, o.visitId, o.nodeId, o.by, o.claimed);
  const addPlace = async (visitId: string, nodeId: string | null, o: { by?: string; role?: string; claimed?: string; projectId?: string } = {}) => {
    const id = randomUUID();
    const projectId = o.projectId ?? f.projectA.id;
    const by = o.by ?? f.memberUser.id;
    await paired(projectId, visitId, (q) => placeRow(q, { id, projectId, visitId, nodeId, by, claimed: o.claimed ?? ago(5) }),
      [{ type: 'sitevisit.place_added', actor: by, role: o.role ?? 'pmc', rowId: id }]);
    return id;
  };

  const attendeeRow = (q: Tx, o: { id: string; projectId: string; visitId: string; by: string; member?: { userId: string; role: string }; guest?: string }) =>
    q.$executeRawUnsafe(
      `INSERT INTO "SiteVisitAttendee" ("id","projectId","visitId","userId","role","guestName","displayName","addedById","addedAt")
       VALUES ($1,$2,$3,$4,$5,$6,'Forged Name',$7,'2001-01-01')`,
      o.id, o.projectId, o.visitId, o.member?.userId ?? null, o.member?.role ?? null, o.guest ?? null, o.by);
  const addAttendee = async (visitId: string, who: { member?: { userId: string; role: string }; guest?: string }, o: { by?: string; role?: string; projectId?: string } = {}) => {
    const id = randomUUID();
    const projectId = o.projectId ?? f.projectA.id;
    const by = o.by ?? f.memberUser.id;
    await paired(projectId, visitId, (q) => attendeeRow(q, { id, projectId, visitId, by, ...who }),
      [{ type: 'sitevisit.attendee_added', actor: by, role: o.role ?? 'pmc', rowId: id }]);
    return id;
  };

  const retireRow = (q: Tx, table: 'SiteVisitPlace' | 'SiteVisitAttendee', id: string, by: string) =>
    q.$executeRawUnsafe(`UPDATE "${table}" SET "retiredById" = $2, "retiredAt" = '2001-01-01' WHERE "id" = $1`, id, by);
  const retire = async (table: 'SiteVisitPlace' | 'SiteVisitAttendee', visitId: string, id: string, by = f.memberUser.id, role = 'pmc') =>
    paired(f.projectA.id, visitId, (q) => retireRow(q, table, id, by),
      [{ type: table === 'SiteVisitPlace' ? 'sitevisit.place_retired' : 'sitevisit.attendee_retired', actor: by, role, rowId: id }]);

  const visit = async (id: string) => (await t.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT *, "startedAt" = "startClaimedAt" AS "startAsClaimed", "endedAt" = "endClaimedAt" AS "endAsClaimed",
            "startReceivedAt" >= ${UTC(2)} AS "receivedNow"
       FROM "SiteVisit" WHERE "id" = $1`, id, ago(1)))[0]!;
  const place = async (id: string) => (await t.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT *, "addedAt" = "addedClaimedAt" AS "asClaimed", "addedAt" = "addedReceivedAt" AS "atReceipt" FROM "SiteVisitPlace" WHERE "id" = $1`, id))[0]!;
  const attendee = async (id: string) => (await t.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT * FROM "SiteVisitAttendee" WHERE "id" = $1`, id))[0]!;
  const raw = (sql: string, ...params: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...params);
  /** End any open visit of the visitor so the next start is not refused by S2 (one open visit per visitor). */
  const endOpen = async (visitor: string, projectId = f.projectA.id, role = 'pmc') => {
    const open = await t.prisma.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "SiteVisit" WHERE "projectId" = ${projectId} AND "visitorId" = ${visitor} AND "status" = 'open'`;
    for (const v of open) await end(v.id, ago(0), visitor, role);
  };

  // ── V2 / V3 — an accepted, coherent record ─────────────────────────────────────────────────

  describe('an accepted visit', () => {
    it('commits start, places, attendees, a retirement and the end, with every derived value the database’s own', async () => {
      const id = await start({ claimed: ago(10) });
      const v = await visit(id);
      // F57 / F61: the frozen name and label are COPIED; the caller's forged values are gone
      expect(v.visitorName).toBe(names.get(f.memberUser.id));
      expect(v.startPlaceName).toBe(n1.name);
      // F54: a claim inside its window is accepted as claimed, and the receipt is the database's clock
      expect(v.startAsClaimed).toBe(true);
      expect(v.startTimeAdjusted).toBe(false);
      expect(v.receivedNow).toBe(true);
      expect(v.locationKind).toBe('device');

      const p = await addPlace(id, n2.id, { claimed: ago(5) });
      expect(await place(p)).toMatchObject({ placeName: n2.name, addedById: f.memberUser.id, asClaimed: true, addedTimeAdjusted: false, addedAfterEnd: false });
      const member = await addAttendee(id, { member: { userId: consultant, role: 'consultant' } });
      const guest = await addAttendee(id, { guest: 'Ravi (site driver)' });
      expect(await attendee(member)).toMatchObject({ displayName: names.get(consultant), addedById: f.memberUser.id, retiredAt: null });
      expect(await attendee(guest)).toMatchObject({ displayName: 'Ravi (site driver)' });
      await retire('SiteVisitAttendee', id, guest);
      expect((await attendee(guest)).retiredById).toBe(f.memberUser.id);

      await end(id, ago(1));
      const e = await visit(id);
      expect(e).toMatchObject({ status: 'ended', endAsClaimed: true, endTimeAdjusted: false });

      // V6: every change claimed exactly one event, and start and end each told the project once
      const claims = await t.prisma.$queryRaw<Array<{ eventType: string; claimedBy: string }>>`
        SELECT e."eventType", k."claimedBy" FROM "DomainEventPairingClaim" k JOIN "DomainEvent" e USING ("projectId","eventId")
         WHERE e."entityType" = 'SiteVisit' AND e."entityId" = ${id} ORDER BY e."streamPosition"`;
      expect(claims.map((c) => c.eventType)).toEqual([
        'sitevisit.started', 'sitevisit.place_added', 'sitevisit.attendee_added', 'sitevisit.attendee_added',
        'sitevisit.attendee_retired', 'sitevisit.ended',
      ]);
      const notices = await t.prisma.$queryRaw<Array<{ kind: string }>>`
        SELECT n."kind" FROM "Notification" n JOIN "DomainEvent" e ON e."eventId" = n."eventId" WHERE e."entityId" = ${id} ORDER BY n."kind"`;
      expect(notices.map((n) => n.kind)).toEqual(['sitevisit.ended', 'sitevisit.started']);
    });

    it('pairs in either order: an event written before its row is claimed by the immediate half', async () => {
      const id = await start({ node: null, device: false }, true);
      expect(await visit(id)).toMatchObject({ startNodeId: null, startPlaceName: null, locationKind: 'none' });
      await end(id, ago(0), f.memberUser.id, 'pmc', true);
      expect((await visit(id)).status).toBe('ended');
    });

    it('admits a consultant visitor, and a membership-less org owner as pmc (S1, the windowed role contract)', async () => {
      const c = await start({ visitor: consultant, role: 'consultant' });
      expect((await visit(c)).visitorName).toBe(names.get(consultant));
      await end(c, ago(0), consultant, 'consultant');
      const o = await start({ visitor: f.ownerUser.id });
      expect((await visit(o)).visitorName).toBe(names.get(f.ownerUser.id));
      await end(o, ago(0), f.ownerUser.id);
    });

    it('allows one open visit per visitor per project (S2)', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      await expect(start()).rejects.toThrow(/\("projectId", "visitorId"\)=.*already exists/);
      await end(id);
      await end(await start());
    });
  });

  // ── V3 — time (F47, F54) ───────────────────────────────────────────────────────────────────

  describe('time: accepted is the claim inside its window, else the receipt; adjusted exactly when they differ', () => {
    it('a start claimed in the future, more than 7 days back, or before the project began is accepted at its receipt', async () => {
      await endOpen(f.memberUser.id);
      for (const claimed of [ago(-60), ago(8 * 24 * 60)]) {
        const id = await start({ claimed });
        const v = await visit(id);
        expect(v.startTimeAdjusted, claimed).toBe(true);
        expect(v.startedAt).toEqual(v.startReceivedAt);
        await end(id, ago(0));
      }
      // project B began just now (the fixture's), so an hour ago is before it
      const b = await start({ projectId: f.projectB.id, visitor: f.otherUser.id, node: nodeB, claimed: ago(60) });
      const vb = await visit(b);
      expect(vb.startTimeAdjusted).toBe(true);
      expect(vb.startedAt).toEqual(vb.startReceivedAt);
      await end(b, ago(0), f.otherUser.id);
    });

    it('an end claimed before the start, before a place walked while open, or in the future is accepted at its receipt', async () => {
      for (const endClaim of [ago(30), ago(4), ago(-60)]) {
        await endOpen(f.memberUser.id);
        const id = await start({ claimed: ago(10) });
        await addPlace(id, n2.id, { claimed: ago(3) });
        await end(id, endClaim);
        const v = await visit(id);
        expect(v.endTimeAdjusted, endClaim).toBe(true);
        expect(v.endedAt).toEqual(v.endReceivedAt);
      }
    });

    it('a place claimed before the start or in the future is accepted at its receipt', async () => {
      await endOpen(f.memberUser.id);
      const id = await start({ claimed: ago(10) });
      for (const [nodeId, claimed] of [[n1.id, ago(20)], [n2.id, ago(-60)]] as const) {
        const p = await place(await addPlace(id, nodeId, { claimed }));
        expect(p.addedTimeAdjusted, claimed).toBe(true);
        expect(p.atReceipt).toBe(true);
      }
      await end(id);
    });

    it('a direct write cannot make a row whose adjusted flag disagrees with its times (the CHECK, beneath the trigger)', async () => {
      await expect(t.prisma.$transaction(async (q) => {
        await q.$executeRawUnsafe('ALTER TABLE "SiteVisit" DISABLE TRIGGER "SiteVisit_insert"');
        await q.$executeRawUnsafe(
          `INSERT INTO "SiteVisit" ("id","projectId","visitorId","visitorRole","visitorName","startClaimedAt","startedAt","startTimeAdjusted","startReceivedAt","locationKind")
           VALUES ($1,$2,$3,'pmc','X',now(),now() - interval '1 hour',false,now(),'none')`, randomUUID(), f.projectA.id, consultant);
      })).rejects.toThrow(/SiteVisit_shape_check/);
    });
  });

  // ── V2 — standing (F55), attribution (F46) ─────────────────────────────────────────────────

  describe('standing: the visitor, a member attendee and the closer hold their role when written', () => {
    it('refuses a stranger, a member of another project, and a role the user does not hold', async () => {
      for (const [visitor, role] of [[f.strangerUser.id, 'pmc'], [f.otherUser.id, 'pmc'], [consultant, 'pmc'], [f.clientUser.id, 'pmc']] as const) {
        await expect(start({ visitor, role }), `${visitor} as ${role}`).rejects.toThrow(/does not hold role/);
      }
      // a client holds `client`, which is not a visiting role (S1)
      await expect(start({ visitor: f.clientUser.id, role: 'client' })).rejects.toThrow(/SiteVisit_shape_check/);
      expect(await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "SiteVisit" WHERE "visitorId" IN (${f.strangerUser.id}, ${f.clientUser.id})`)
        .toEqual([{ n: 0n }]);
    });

    it('refuses a member attendee without standing, and a closer who is not pmc', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      await expect(addAttendee(id, { member: { userId: f.otherUser.id, role: 'pmc' } })).rejects.toThrow(/does not hold role/);
      await expect(addAttendee(id, { member: { userId: consultant, role: 'pmc' } })).rejects.toThrow(/does not hold role/);
      await expect(paired(f.projectA.id, id, (q) => closeRow(q, id, consultant, 'stale'),
        [{ type: 'sitevisit.closed', actor: consultant, role: 'consultant', notice: true }])).rejects.toThrow(/does not hold role pmc/);
      await end(id);
    });

    it('refuses every write on an archived project', async () => {
      await endOpen(f.otherUser.id, f.projectB.id);
      const id = await start({ projectId: f.projectB.id, visitor: f.otherUser.id, node: nodeB });
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
      try {
        await expect(start({ projectId: f.projectB.id, visitor: f.otherUser.id, node: null })).rejects.toThrow(/not operable/);
        await expect(addPlace(id, nodeB, { by: f.otherUser.id, projectId: f.projectB.id })).rejects.toThrow(/not operable/);
        await expect(addAttendee(id, { guest: 'Guest' }, { by: f.otherUser.id, projectId: f.projectB.id })).rejects.toThrow(/not operable/);
        await expect(end(id, ago(0), f.otherUser.id)).rejects.toThrow(/not operable/);
      } finally {
        await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
      }
      await end(id, ago(0), f.otherUser.id);
    });

    it('serializes a concurrent demotion of the visitor’s authority in both orders (F55)', async () => {
      const restore = () => t.prisma.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } }, data: { role: 'owner' } });
      await endOpen(f.ownerUser.id);

      // the start first: the demotion waits for it, and the visit (valid when written) stands
      const wrote = gate(); const release = gate();
      const s = startOpts({ visitor: f.ownerUser.id });
      const write = t.prisma.$transaction(async (q) => {
        await startRow(q, s);
        await plant(q, s.projectId, s.id, { type: 'sitevisit.started', actor: s.visitor, role: 'pmc', notice: true });
        wrote.open();
        await release.p;
      }, { timeout: 30_000 });
      await wrote.p;
      const demoteTag = tag('demote-waits');
      const demotion = settle(raw(`UPDATE /* ${demoteTag} */ "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, f.ownerUser.id));
      expect(await reachesLockWait(demoteTag), 'the demotion is blocked on the authority row the start holds').toBe(true);
      release.open();
      await write;
      expect((await demotion).ok).toBe(true);
      expect((await visit(s.id)).status).toBe('open');
      await restore();
      await end(s.id, ago(0), f.ownerUser.id);

      // the demotion first: the start waits for it, then sees no standing and is refused
      const held = gate(); const go = gate();
      const demotion2 = t.prisma.$transaction(async (q) => {
        await q.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } }, data: { role: 'member' } });
        held.open();
        await go.p;
      }, { timeout: 30_000 });
      await held.p;
      const startTag = tag('start-waits');
      const s2 = startOpts({ visitor: f.ownerUser.id, tagged: startTag });
      const second = settle(t.prisma.$transaction(async (q) => {
        await startRow(q, s2);
        await plant(q, s2.projectId, s2.id, { type: 'sitevisit.started', actor: s2.visitor, role: 'pmc', notice: true });
      }, { timeout: 30_000 }));
      expect(await reachesLockWait(startTag), 'the start is blocked on the authority row the demotion holds').toBe(true);
      go.open();
      await demotion2;
      const outcome = await second;
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.e).toMatch(/does not hold role/);
      await restore();
    });

    it('takes the identity row at the envelope’s strength, so two closes by one PMC serialize instead of deadlocking', async () => {
      await endOpen(consultant, f.projectA.id, 'consultant');
      await endOpen(f.ownerUser.id);
      const v1 = await start({ visitor: consultant, role: 'consultant', node: null });
      const v2 = await start({ visitor: f.ownerUser.id, node: null });
      // the first close holds the closer's identity row from its row write until it commits
      const wrote = gate(); const release = gate();
      const first = t.prisma.$transaction(async (q) => {
        await closeRow(q, v1, f.memberUser.id, 'left open');
        wrote.open();
        await release.p;
        await plant(q, f.projectA.id, v1, { type: 'sitevisit.closed', actor: f.memberUser.id, role: 'pmc', notice: true });
      }, { timeout: 30_000 });
      await wrote.p;
      const secondTag = tag('second-close');
      const second = settle(t.prisma.$transaction(async (q) => {
        await closeRow(q, v2, f.memberUser.id, 'left open', secondTag);
        await plant(q, f.projectA.id, v2, { type: 'sitevisit.closed', actor: f.memberUser.id, role: 'pmc', notice: true });
      }, { timeout: 30_000 }));
      // a share lock would let the second through to its event, where both would wait to upgrade: a deadlock
      expect(await reachesLockWait(secondTag), 'the second close waits on the identity row the first holds').toBe(true);
      release.open();
      await first;
      expect(await second).toMatchObject({ ok: true });
      expect((await visit(v1)).status).toBe('closed');
      expect((await visit(v2)).status).toBe('closed');
    });

    it('every later act of the visitor needs their standing; a removed visitor’s late end is refused and the close stands (F48)', async () => {
      const gone = `sv-cons-gone-${run}`;
      extraUsers.push(gone);
      await t.prisma.user.create({ data: { id: gone, projectId: f.projectA.id, role: 'consultant', name: 'Ravi (Consultant)', email: `${gone}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: gone, role: 'consultant', status: 'active' } });
      const [row] = await t.prisma.$queryRaw<Array<{ displayName: string }>>`SELECT "displayName" FROM "UserIdentity" WHERE "userId" = ${gone}`;
      names.set(gone, row!.displayName);
      const remove = (status: 'removed' | 'active') =>
        t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: gone } }, data: { status } });

      const id = await start({ visitor: gone, role: 'consultant' });
      const p = await addPlace(id, n2.id, { by: gone, role: 'consultant' });
      await remove('removed');
      await expect(addPlace(id, n1.id, { by: gone, role: 'consultant' })).rejects.toThrow(/does not hold role/);
      await expect(addAttendee(id, { guest: 'G' }, { by: gone, role: 'consultant' })).rejects.toThrow(/does not hold role/);
      await expect(retire('SiteVisitPlace', id, p, gone, 'consultant')).rejects.toThrow(/does not hold role/);
      await expect(end(id, ago(0), gone, 'consultant')).rejects.toThrow(/does not hold role/);
      await close(id, f.memberUser.id, 'Visitor left the project');
      await expect(lateEnd(id, gone, 'consultant')).rejects.toThrow(/does not hold role/);
      expect(await visit(id)).toMatchObject({ status: 'closed', lateEndClaimedAt: null, lateEndReceivedAt: null });
      expect((await place(p)).retiredAt).toBeNull();
      await remove('active');
    });

    it('only the visitor adds or retires a child row, and the row records the visitor (F46)', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      await expect(addPlace(id, n2.id, { by: consultant, role: 'consultant' })).rejects.toThrow(/only the visitor adds places/);
      await expect(addAttendee(id, { guest: 'G' }, { by: consultant, role: 'consultant' })).rejects.toThrow(/only the visitor adds attendees/);
      const p = await addPlace(id, n2.id);
      await expect(retire('SiteVisitPlace', id, p, consultant, 'consultant')).rejects.toThrow(/only the visitor retires/);
      await retire('SiteVisitPlace', id, p);
      expect(await place(p)).toMatchObject({ addedById: f.memberUser.id, retiredById: f.memberUser.id });
      await end(id);
    });
  });

  // ── V4 — lifecycle, closed visits, after-end places (F49), a place names its node (F51) ────

  describe('lifecycle', () => {
    it('refuses every move but open → ended, open → closed, and one late end on a closed visit', async () => {
      await expect(raw(
        `INSERT INTO "SiteVisit" ("id","projectId","visitorId","visitorRole","startClaimedAt","locationKind","status","endClaimedAt")
         VALUES ($1,$2,$3,'pmc',now(),'none','ended',now())`, randomUUID(), f.projectA.id, f.memberUser.id,
      )).rejects.toThrow(/must be inserted open/);
      await endOpen(f.memberUser.id);
      const id = await start();
      await expect(raw(`UPDATE "SiteVisit" SET "lateEndClaimedAt" = now() WHERE "id" = $1`, id)).rejects.toThrow(/moves only/);
      await end(id);
      for (const sql of [
        `UPDATE "SiteVisit" SET "status" = 'open', "endClaimedAt" = NULL WHERE "id" = $1`,
        `UPDATE "SiteVisit" SET "status" = 'closed', "closedById" = '${f.memberUser.id}', "closeReason" = 'x' WHERE "id" = $1`,
        `UPDATE "SiteVisit" SET "endClaimedAt" = now() WHERE "id" = $1`,
        `UPDATE "SiteVisit" SET "visitorId" = '${consultant}' WHERE "id" = $1`,
        `UPDATE "SiteVisit" SET "startedAt" = "startedAt" - interval '1 minute' WHERE "id" = $1`,
        `UPDATE "SiteVisit" SET "locLat" = 0 WHERE "id" = $1`,
        `UPDATE "SiteVisit" SET "visitorName" = 'Renamed' WHERE "id" = $1`,
      ]) {
        await expect(raw(sql, id), sql).rejects.toThrow(/site-visits:/);
      }
    });

    it('a closed visit takes no child edit and no end; its late end is recorded once (F49)', async () => {
      await endOpen(consultant, f.projectA.id, 'consultant');
      const id = await start({ visitor: consultant, role: 'consultant' });
      const p = await addPlace(id, n2.id, { by: consultant, role: 'consultant' });
      await close(id, f.memberUser.id);
      expect(await visit(id)).toMatchObject({ status: 'closed', closedById: f.memberUser.id });
      await expect(addPlace(id, n1.id, { by: consultant, role: 'consultant' })).rejects.toThrow(/closed and takes no more edits/);
      await expect(addAttendee(id, { guest: 'G' }, { by: consultant, role: 'consultant' })).rejects.toThrow(/closed and takes no more edits/);
      await expect(retire('SiteVisitPlace', id, p, consultant, 'consultant')).rejects.toThrow(/closed and takes no more edits/);
      await expect(end(id, ago(0), consultant, 'consultant')).rejects.toThrow(/moves only/);
      await lateEnd(id, consultant, 'consultant');
      const v = await visit(id);
      expect(v.lateEndClaimedAt).not.toBeNull();
      expect(v.lateEndReceivedAt).not.toBeNull();
      await expect(lateEnd(id, consultant, 'consultant')).rejects.toThrow(/moves only/);
      await expect(raw(`UPDATE "SiteVisit" SET "status" = 'open', "closedById" = NULL, "closeReason" = NULL, "closedAt" = NULL WHERE "id" = $1`, id))
        .rejects.toThrow(/moves only/);
    });

    it('a place added after the end is marked addedAfterEnd, accepted at its receipt, and leaves the end as it was', async () => {
      await endOpen(f.memberUser.id);
      const id = await start({ claimed: ago(10) });
      await end(id, ago(2));
      const before = await visit(id);
      const p = await place(await addPlace(id, n2.id, { claimed: ago(5) }));
      expect(p).toMatchObject({ addedAfterEnd: true, atReceipt: true, addedTimeAdjusted: true });
      expect((await visit(id)).endedAt).toEqual(before.endedAt);
    });

    it('a place and the end serialize on the visit row in both orders (F49)', async () => {
      // the end first: the place waits for it, then lands as an after-end correction
      await endOpen(f.memberUser.id);
      const a = await start({ claimed: ago(10) });
      const ended = gate(); const release = gate();
      const ending = t.prisma.$transaction(async (q) => {
        await endRow(q, a, ago(2));
        await plant(q, f.projectA.id, a, { type: 'sitevisit.ended', actor: f.memberUser.id, role: 'pmc', notice: true });
        ended.open();
        await release.p;
      }, { timeout: 30_000 });
      await ended.p;
      const placeTag = tag('place-waits');
      const pid = randomUUID();
      const adding = settle(t.prisma.$transaction(async (q) => {
        await placeRow(q, { id: pid, projectId: f.projectA.id, visitId: a, nodeId: n2.id, by: f.memberUser.id, claimed: ago(5), tagged: placeTag });
        await plant(q, f.projectA.id, a, { type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: pid });
      }, { timeout: 30_000 }));
      expect(await reachesLockWait(placeTag), 'the place is blocked on the visit row the end holds').toBe(true);
      release.open();
      await ending;
      expect((await adding).ok).toBe(true);
      expect(await place(pid)).toMatchObject({ addedAfterEnd: true, atReceipt: true });

      // the place first: the end waits for it, and can then never be earlier than the place
      const b = await start({ claimed: ago(10) });
      const added = gate(); const go = gate();
      const pid2 = randomUUID();
      const adding2 = t.prisma.$transaction(async (q) => {
        await placeRow(q, { id: pid2, projectId: f.projectA.id, visitId: b, nodeId: n2.id, by: f.memberUser.id, claimed: ago(1) });
        await plant(q, f.projectA.id, b, { type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: pid2 });
        added.open();
        await go.p;
      }, { timeout: 30_000 });
      await added.p;
      const endTag = tag('end-waits');
      const ending2 = settle(t.prisma.$transaction(async (q) => {
        await endRow(q, b, ago(3), endTag);
        await plant(q, f.projectA.id, b, { type: 'sitevisit.ended', actor: f.memberUser.id, role: 'pmc', notice: true });
      }, { timeout: 30_000 }));
      expect(await reachesLockWait(endTag), 'the end is blocked on the visit row the place holds').toBe(true);
      go.open();
      await adding2;
      expect((await ending2).ok).toBe(true);
      const v = await visit(b);
      const p = await place(pid2);
      expect(p.addedAfterEnd).toBe(false);
      expect(v.endTimeAdjusted).toBe(true);
      expect((v.endedAt as Date).getTime()).toBeGreaterThanOrEqual((p.addedAt as Date).getTime());
    });

    it('a place always names a published node of its own project (F51)', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      await expect(addPlace(id, null)).rejects.toThrow(/must name the node/);
      await expect(addPlace(id, draft)).rejects.toThrow(/unpublished draft/);
      await expect(addPlace(id, nodeB)).rejects.toThrow(/not a place of project/);
      await expect(start({ node: draft })).rejects.toThrow(/unpublished draft/);
      await end(id);
    });

    it('a node rename and a place serialize on the node row in both orders, so the frozen label is the name at the act', async () => {
      const node = await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: `Lift core ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() } });
      await endOpen(f.memberUser.id);
      const id = await start({ node: null });
      const rename = (to: string, tagged: string) => raw(`UPDATE /* ${tagged} */ "ProjectNode" SET "name" = $2 WHERE "id" = $1`, node.id, to);

      // the place first: the rename waits for it, and the place keeps the name it was added under
      const a = randomUUID();
      const wrote = gate(); const release = gate();
      const write = t.prisma.$transaction(async (q) => {
        await placeRow(q, { id: a, projectId: f.projectA.id, visitId: id, nodeId: node.id, by: f.memberUser.id, claimed: ago(1) });
        await plant(q, f.projectA.id, id, { type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: a });
        wrote.open();
        await release.p;
      }, { timeout: 30_000 });
      await wrote.p;
      const renameTag = tag('rename-waits');
      const renamed = settle(rename(`Lift core (east) ${run}`, renameTag));
      expect(await reachesLockWait(renameTag), 'the rename is blocked on the node row the place holds').toBe(true);
      release.open();
      await write;
      expect((await renamed).ok).toBe(true);
      expect((await place(a)).placeName).toBe(`Lift core ${run}`);
      await retire('SiteVisitPlace', id, a);   // one standing place per node per visit

      // the rename first: the place waits for it, then freezes the new name
      const held = gate(); const go = gate();
      const renaming = t.prisma.$transaction(async (q) => {
        await q.$executeRawUnsafe(`UPDATE "ProjectNode" SET "name" = $2 WHERE "id" = $1`, node.id, `Lift core (west) ${run}`);
        held.open();
        await go.p;
      }, { timeout: 30_000 });
      await held.p;
      const placeTag = tag('place-waits-rename');
      const b = randomUUID();
      const second = settle(t.prisma.$transaction(async (q) => {
        await placeRow(q, { id: b, projectId: f.projectA.id, visitId: id, nodeId: node.id, by: f.memberUser.id, claimed: ago(1), tagged: placeTag });
        await plant(q, f.projectA.id, id, { type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: b });
      }, { timeout: 30_000 }));
      expect(await reachesLockWait(placeTag), 'the place is blocked on the node row the rename holds').toBe(true);
      go.open();
      await renaming;
      expect(await second).toMatchObject({ ok: true });
      expect((await place(b)).placeName).toBe(`Lift core (west) ${run}`);
      await end(id);
    });

    it('a device fix carries a finite accuracy: Infinity and NaN are refused', async () => {
      await endOpen(f.memberUser.id);
      for (const accuracy of [`'Infinity'::float8`, `'NaN'::float8`, `-1`]) {
        await expect(start({ accuracy }), accuracy).rejects.toThrow(/SiteVisit_shape_check/);
      }
      const id = await start({ accuracy: '1500' });
      expect((await visit(id)).locAccuracyM).toBe(1500);
      await end(id);
    });

    it('refuses a blank or overlong guest name under the full whitespace set (F61)', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      for (const guest of [' \t\n\x0B\f\r', 'x'.repeat(121)]) {
        await expect(addAttendee(id, { guest })).rejects.toThrow(/SiteVisitAttendee_shape_check/);
      }
      await expect(addAttendee(id, { member: { userId: consultant, role: 'consultant' }, guest: 'Both' })).rejects.toThrow(/SiteVisitAttendee_shape_check/);
      await end(id);
    });
  });

  // ── V5 — immutable (F58) ───────────────────────────────────────────────────────────────────

  describe('immutable', () => {
    it('refuses a direct DELETE and a TRUNCATE of every table, and a second retirement or a frozen-column edit of a child', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      const p = await addPlace(id, n2.id);
      const g = await addAttendee(id, { guest: 'G' });
      for (const [table, rowId] of [['SiteVisit', id], ['SiteVisitPlace', p], ['SiteVisitAttendee', g]] as const) {
        await expect(raw(`DELETE FROM "${table}" WHERE "id" = $1`, rowId), table).rejects.toThrow(/never deleted/);
        await expect(raw(`TRUNCATE "${table}" CASCADE`), table).rejects.toThrow(/never truncated/);
      }
      await expect(raw(`UPDATE "SiteVisitPlace" SET "placeName" = 'Renamed' WHERE "id" = $1`, p)).rejects.toThrow(/frozen/);
      await expect(raw(`UPDATE "SiteVisitAttendee" SET "displayName" = 'Renamed' WHERE "id" = $1`, g)).rejects.toThrow(/frozen/);
      await retire('SiteVisitPlace', id, p);
      await expect(retire('SiteVisitPlace', id, p)).rejects.toThrow(/retired once/);
      await end(id);
    });

    it('clears a node reference only by the node’s removal, keeping the frozen label and every other column (F58)', async () => {
      const gone = await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: `Scaffold ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() } });
      await endOpen(f.memberUser.id);
      const id = await start({ node: gone.id });
      const p = await addPlace(id, gone.id);
      // a direct clear, or a re-point to another node, is refused at depth 1
      await expect(raw(`UPDATE "SiteVisit" SET "startNodeId" = NULL WHERE "id" = $1`, id)).rejects.toThrow(/cleared only when that place is removed/);
      await expect(raw(`UPDATE "SiteVisit" SET "startNodeId" = $2 WHERE "id" = $1`, id, n2.id)).rejects.toThrow(/cleared only when that place is removed/);
      await expect(raw(`UPDATE "SiteVisitPlace" SET "nodeId" = NULL WHERE "id" = $1`, p)).rejects.toThrow(/cleared only when that node is removed/);
      const vBefore = await visit(id);
      const pBefore = await place(p);
      await t.prisma.projectNode.delete({ where: { id: gone.id } });
      const vAfter = await visit(id);
      const pAfter = await place(p);
      expect(vAfter).toEqual({ ...vBefore, startNodeId: null, receivedNow: vAfter.receivedNow });
      expect(pAfter).toEqual({ ...pBefore, nodeId: null });
      expect(vAfter.startPlaceName).toBe(`Scaffold ${run}`);
      expect(pAfter.placeName).toBe(`Scaffold ${run}`);
      await end(id);
    });
  });

  // ── V6 — paired (F45, F59) ─────────────────────────────────────────────────────────────────

  describe('paired: one same-transaction event from the attributed human, and a notice for start, end and close', () => {
    const startWith = (pairs: (s: ReturnType<typeof startOpts>) => Pair[]) => {
      const s = startOpts({});
      return paired(s.projectId, s.id, (q) => startRow(q, s), pairs(s));
    };

    it('refuses a start with no event, two events, the wrong type, the wrong actor, or no notice', async () => {
      await endOpen(f.memberUser.id);
      const ev = (o: Partial<Pair> = {}): Pair => ({ type: 'sitevisit.started', actor: f.memberUser.id, role: 'pmc', notice: true, ...o });
      await expect(startWith(() => [])).rejects.toThrow(/0 matching `sitevisit.started`/);
      await expect(startWith(() => [ev(), ev()])).rejects.toThrow(/2 matching `sitevisit.started`/);
      await expect(startWith(() => [ev({ type: 'sitevisit.ended' })])).rejects.toThrow(/0 matching `sitevisit.started`|requires a pairing claim/);
      await expect(startWith(() => [ev({ actor: consultant, role: 'consultant' })])).rejects.toThrow(/0 matching `sitevisit.started`|requires a pairing claim/);
      await expect(startWith(() => [ev({ notice: false })])).rejects.toThrow(/0 notice\(s\)/);
      expect(await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "SiteVisit" WHERE "visitorId" = ${f.memberUser.id} AND "status" = 'open'`)
        .toEqual([{ n: 0n }]);
    });

    it('the event carries the actor envelope in the role the row attributes, or it does not count', async () => {
      await endOpen(f.memberUser.id);
      await expect(startWith(() => [{ type: 'sitevisit.started', actor: f.memberUser.id, role: 'pmc', notice: true, noEnvelope: true }]))
        .rejects.toThrow(/0 matching `sitevisit.started` event\(s\) from .* as pmc/);
      const id = await start();
      const pid = randomUUID();
      await expect(paired(f.projectA.id, id, (q) => placeRow(q, { id: pid, projectId: f.projectA.id, visitId: id, nodeId: n2.id, by: f.memberUser.id, claimed: ago(1) }),
        [{ type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: pid, noEnvelope: true }])).rejects.toThrow(/0 matching `sitevisit.place_added`/);
      await expect(paired(f.projectA.id, id, (q) => closeRow(q, id, f.memberUser.id, 'x'),
        [{ type: 'sitevisit.closed', actor: f.memberUser.id, role: 'pmc', notice: true, noEnvelope: true }])).rejects.toThrow(/0 matching `sitevisit.closed`/);
      await end(id);
    });

    it('a kind-less notice cannot carry the event, and one that names nothing does not count (F59)', async () => {
      await expect(t.prisma.$transaction(async (q) => {
        const s = startOpts({});
        await startRow(q, s);
        const e = await plant(q, s.projectId, s.id, { type: 'sitevisit.started', actor: s.visitor, role: 'pmc' });
        await q.$executeRawUnsafe(`INSERT INTO "Notification" ("id","projectId","text","color","time","eventId") VALUES (gen_random_uuid()::text,$1,'x','#000','now',$2)`, s.projectId, e);
      })).rejects.toThrow(/Notification_event_binding_pair_check/);
      await expect(t.prisma.$transaction(async (q) => {
        const s = startOpts({});
        await startRow(q, s);
        await plant(q, s.projectId, s.id, { type: 'sitevisit.started', actor: s.visitor, role: 'pmc' });
        await q.$executeRawUnsafe(`INSERT INTO "Notification" ("id","projectId","text","color","time") VALUES (gen_random_uuid()::text,$1,'x','#000','now')`, s.projectId);
      })).rejects.toThrow(/0 notice\(s\)/);
    });

    it('a child event must name its own row, so one event cannot cover two changes', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      const a = randomUUID(); const b = randomUUID();
      await expect(t.prisma.$transaction(async (q) => {
        await placeRow(q, { id: a, projectId: f.projectA.id, visitId: id, nodeId: n1.id, by: f.memberUser.id, claimed: ago(1) });
        await placeRow(q, { id: b, projectId: f.projectA.id, visitId: id, nodeId: n2.id, by: f.memberUser.id, claimed: ago(1) });
        await plant(q, f.projectA.id, id, { type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: a });
      })).rejects.toThrow(/naming this row as payload.rowId/);
      await expect(addPlace(id, n1.id).then(() => 'ok')).resolves.toBe('ok');
      await end(id);
    });

    it('refuses a site-visit event that no change claims', async () => {
      await endOpen(f.memberUser.id);
      const id = await start();
      await expect(t.prisma.$transaction(async (q) => {
        await plant(q, f.projectA.id, id, { type: 'sitevisit.place_added', actor: f.memberUser.id, role: 'pmc', rowId: randomUUID() });
      })).rejects.toThrow(/requires a pairing claim/);
      await end(id);
    });
  });

  // ── V1 — the project cascade (F60) ─────────────────────────────────────────────────────────

  it('a replay over a `db push` baseline replaces the NO ACTION node keys with the column-list SET NULL', async () => {
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    const def = async (name: string) => (await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, name))[0]?.d;
    // what Prisma's `db push` creates for `onDelete: NoAction` under the same names
    await raw(`ALTER TABLE "SiteVisit" DROP CONSTRAINT "SiteVisit_projectId_startNodeId_fkey",
      ADD CONSTRAINT "SiteVisit_projectId_startNodeId_fkey" FOREIGN KEY ("projectId","startNodeId") REFERENCES "ProjectNode"("projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    await raw(`ALTER TABLE "SiteVisitPlace" DROP CONSTRAINT "SiteVisitPlace_projectId_nodeId_fkey",
      ADD CONSTRAINT "SiteVisitPlace_projectId_nodeId_fkey" FOREIGN KEY ("projectId","nodeId") REFERENCES "ProjectNode"("projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    expect(await def('SiteVisitPlace_projectId_nodeId_fkey')).not.toMatch(/SET NULL/);
    for (const m of alwaysExecuteReplay('20280112000000_site_visits_sv1a_record')) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', join(__dirname, '..', '..', 'prisma', 'migrations', m, 'migration.sql')], { stdio: 'pipe' });
    }
    expect(await def('SiteVisit_projectId_startNodeId_fkey')).toMatch(/ON DELETE SET NULL \("startNodeId"\)$/);
    expect(await def('SiteVisitPlace_projectId_nodeId_fkey')).toMatch(/ON DELETE SET NULL \("nodeId"\)$/);
    // and the node's removal then clears only the reference, as on a migrated database
    const gone = await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: `Hoarding ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() } });
    await endOpen(f.memberUser.id);
    const id = await start({ node: gone.id });
    const p = await addPlace(id, gone.id);
    await t.prisma.projectNode.delete({ where: { id: gone.id } });
    expect(await visit(id)).toMatchObject({ startNodeId: null, startPlaceName: `Hoarding ${run}` });
    expect(await place(p)).toMatchObject({ nodeId: null, placeName: `Hoarding ${run}` });
    await end(id);
  });

  it('a project’s deletion removes its visits and their children, and only it (F60)', async () => {
    const pc = `sv-proj-${run}`;
    extraProjects.push(pc);
    await t.prisma.project.create({ data: {
      id: pc, orgId: f.orgA.id, name: `SV cascade ${run}`, short: 'SVC', descriptor: '', stage: 'Planning', siteCode: `SV${run}`.slice(0, 8).toUpperCase(),
      projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    await t.prisma.membership.create({ data: { projectId: pc, userId: consultant, role: 'consultant', status: 'active' } });
    const node = await t.prisma.projectNode.create({ data: { projectId: pc, name: 'Gate', kind: 'zone', order: 0, authorId: consultant, publishedAt: new Date() } });
    const id = await start({ projectId: pc, visitor: consultant, role: 'consultant', node: node.id, claimed: ago(0) });
    await addPlace(id, node.id, { by: consultant, role: 'consultant', projectId: pc, claimed: ago(0) });
    await addAttendee(id, { guest: 'G' }, { by: consultant, role: 'consultant', projectId: pc });
    const elsewhere = await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "SiteVisit" WHERE "projectId" <> ${pc}`;

    // the event log's tenant key is RESTRICT, so the disposable DB clears it first (as every suite's teardown does)
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t.prisma.membership.deleteMany({ where: { projectId: pc } });
    await t.prisma.project.delete({ where: { id: pc } });
    for (const table of ['SiteVisit', 'SiteVisitPlace', 'SiteVisitAttendee']) {
      expect(await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}" WHERE "projectId" = $1`, pc), table).toEqual([{ n: 0n }]);
    }
    expect(await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "SiteVisit" WHERE "projectId" <> ${pc}`).toEqual(elsewhere);
  });
});
