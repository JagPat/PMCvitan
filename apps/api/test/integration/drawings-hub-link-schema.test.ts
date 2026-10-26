import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DrawingsService } from '../../src/drawings/drawings.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset, TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';

/**
 * #1118 U1 — the Hub drawing link schema (`20280121000000_drawings_hub_link`), against live PostgreSQL. It proves what
 * the database holds on every writer (H1-H7 in the migration), that the file re-runs and changes nothing, and that a
 * PMC issue and acknowledge still work with every Hub column NULL.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280121000000_drawings_hub_link/migration.sql');

describe('#1118 U1 — the Hub drawing link schema (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const own = `it-hub1-${run}`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // a project of its own, so its drawings and its delete stay out of the fixture's projects
    await t.prisma.project.create({ data: {
      id: own, orgId: f.orgA.id, name: own, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB',
      projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
  });

  afterAll(async () => {
    if (!t) return;
    try {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'DrawingsProjection'], { cascade: true });
      const pids = { in: [own, f.projectA.id] };
      await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
      await t.prisma.drawingAck.deleteMany({ where: { revision: { projectId: { in: [own, f.projectA.id] } } } });
      await t.prisma.drawingRecipient.deleteMany({ where: { projectId: pids } });
      await t.prisma.drawingRevision.deleteMany({ where: { projectId: pids } });
      await t.prisma.drawing.deleteMany({ where: { projectId: pids } });
      await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
      await t.prisma.project.deleteMany({ where: { id: own } });
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  let seq = 0;
  const drawing = (over: { hubFileId?: string | null; projectId?: string } = {}) => t.prisma.drawing.create({ data: {
    projectId: over.projectId ?? own, number: `H-${run}-${seq++}`, title: 'Hub sheet', discipline: 'architectural',
    hubFileId: over.hubFileId ?? null, publishedAt: new Date(),
  } });
  const revision = (drawingId: string, rev: string, over: { hubVersionId?: string | null; hubVersionOrder?: number | null; projectId?: string } = {}) =>
    t.prisma.drawingRevision.create({ data: {
      drawingId, projectId: over.projectId ?? own, rev, status: 'for_review', mime: 'application/pdf', issuedBy: 'it', issuedAt: '26 Oct 2026',
      hubVersionId: over.hubVersionId ?? null, hubVersionOrder: over.hubVersionOrder ?? null,
    } });

  it('H1: one drawing per Hub file and one revision per Hub version in a project, one revision per order on a drawing; NULLs never collide', async () => {
    const a = await drawing({ hubFileId: `file-${run}` });
    await expect(drawing({ hubFileId: `file-${run}` })).rejects.toThrow(/Drawing_hub_file_per_project|Unique constraint/);
    // the same Hub file in another project is that project's own, and any number of PMC drawings carry none
    await drawing({ hubFileId: `file-${run}`, projectId: f.projectA.id });
    await drawing(); await drawing();

    await revision(a.id, 'A', { hubVersionId: `ver-${run}-1`, hubVersionOrder: 1 });
    const b = await drawing({ hubFileId: `file-${run}-b` });
    await expect(revision(b.id, 'A', { hubVersionId: `ver-${run}-1`, hubVersionOrder: 1 })).rejects.toThrow(/DrawingRevision_hub_version_per_project|Unique constraint/);
    await expect(revision(a.id, 'B', { hubVersionId: `ver-${run}-2`, hubVersionOrder: 1 })).rejects.toThrow(/Unique constraint/);
    await revision(a.id, 'B', { hubVersionId: `ver-${run}-2`, hubVersionOrder: 2 });
    // PMC revisions carry neither, as many as there are
    const pmcDrawing = await drawing();
    await revision(pmcDrawing.id, 'A'); await revision(pmcDrawing.id, 'B');

    await t.prisma.drawingHubLink.create({ data: { projectId: own, orgId: f.orgA.id, hubProjectId: `hp-${run}`, linkedBy: 'it' } });
    await expect(t.prisma.drawingHubLink.create({ data: { projectId: own, orgId: f.orgA.id, hubProjectId: `hp-${run}-2`, linkedBy: 'it' } })).rejects.toThrow(/Unique constraint/);
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `wh-${run}`, eventType: 'drawing.issued', outcome: 'refused' } });
    await expect(t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `wh-${run}`, eventType: 'drawing.issued', outcome: 'applied' } })).rejects.toThrow(/Unique constraint/);
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgB.id, webhookId: `wh-${run}`, eventType: 'drawing.issued', outcome: 'ignored' } });
    await t.prisma.hubVersionTombstone.create({ data: { projectId: own, hubVersionId: `ver-${run}-9`, hubFileId: `file-${run}`, versionSeq: 9 } });
    await expect(t.prisma.hubVersionTombstone.create({ data: { projectId: own, hubVersionId: `ver-${run}-9`, hubFileId: `file-${run}` } })).rejects.toThrow(/Unique constraint/);
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${own}/drawings/hub/${run}`, projectId: own, hubVersionId: `ver-${run}-1` } });
    await expect(t.prisma.hubFetchedBlob.create({ data: { storageKey: `${own}/drawings/hub/${run}`, projectId: own, hubVersionId: `ver-${run}-2` } })).rejects.toThrow(/Unique constraint/);
  });

  it('H2: a link\'s org is its project\'s org, every row names a project or org that exists, and each goes with its project', async () => {
    await expect(raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "hubProjectId", "linkedBy") VALUES ($1, $2, 'hp', 'it')`, f.projectA.id, f.orgB.id))
      .rejects.toThrow(/DrawingHubLink_orgId_projectId_fkey/);
    await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ('no-such-org', 'w', 'e', 'applied')`))
      .rejects.toThrow(/HubWebhookReceipt_orgId_fkey/);
    await expect(raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId") VALUES ('no-such-project', 'v', 'f')`))
      .rejects.toThrow(/HubVersionTombstone_projectId_fkey/);
    await expect(raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ('b', 'k', 'no-such-project', 'v')`))
      .rejects.toThrow(/HubFetchedBlob_projectId_fkey/);

    const id = `it-hub1-gone-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId: f.orgA.id, name: id, short: 'Gone', descriptor: '', stage: 'x', siteCode: 'G', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    await t.prisma.drawingHubLink.create({ data: { projectId: id, orgId: f.orgA.id, hubProjectId: 'hp', linkedBy: 'it' } });
    await t.prisma.hubVersionTombstone.create({ data: { projectId: id, hubVersionId: 'v', hubFileId: 'f' } });
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${id}/drawings/hub/x`, projectId: id, hubVersionId: 'v' } });
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: id } })).toBe(0);
    expect(await t.prisma.hubVersionTombstone.count({ where: { projectId: id } })).toBe(0);
    expect(await t.prisma.hubFetchedBlob.count({ where: { projectId: id } })).toBe(0);
  });

  it('H3: a Hub id never changes once the row exists, a PMC drawing never becomes a Hub one, and other columns stay writable', async () => {
    const pmcDrawing = await drawing();
    await expect(raw(`UPDATE "Drawing" SET "hubFileId" = 'attach' WHERE "id" = $1`, pmcDrawing.id)).rejects.toThrow(/hubFileId is a Hub id/);
    const hub = await drawing({ hubFileId: `file-${run}-h3` });
    await expect(raw(`UPDATE "Drawing" SET "hubFileId" = 'other' WHERE "id" = $1`, hub.id)).rejects.toThrow(/hubFileId is a Hub id/);
    await expect(raw(`UPDATE "Drawing" SET "hubFileId" = NULL WHERE "id" = $1`, hub.id)).rejects.toThrow(/hubFileId is a Hub id/);
    // writing the same value, and every other column, is untouched
    await raw(`UPDATE "Drawing" SET "hubFileId" = "hubFileId", "title" = 'Renamed', "zone" = 'Z1' WHERE "id" = $1`, hub.id);
    expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: hub.id } })).title).toBe('Renamed');

    const r = await revision(hub.id, 'A', { hubVersionId: `ver-${run}-h3`, hubVersionOrder: 3 });
    await expect(raw(`UPDATE "DrawingRevision" SET "hubVersionId" = 'other' WHERE "id" = $1`, r.id)).rejects.toThrow(/hubVersionId is a Hub id/);
    await expect(raw(`UPDATE "DrawingRevision" SET "hubVersionOrder" = 4 WHERE "id" = $1`, r.id)).rejects.toThrow(/hubVersionOrder is a Hub id/);
    // a promotion or a supersede changes the status in place
    await raw(`UPDATE "DrawingRevision" SET "status" = 'superseded' WHERE "id" = $1`, r.id);
    const pr = await revision(pmcDrawing.id, 'A');
    await expect(raw(`UPDATE "DrawingRevision" SET "hubVersionId" = 'attach' WHERE "id" = $1`, pr.id)).rejects.toThrow(/hubVersionId is a Hub id/);

    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${own}/drawings/hub/h3-${run}`, projectId: own, hubVersionId: 'v' } });
    // the project too, so a fetched blob is never counted against, or swept from, another project
    for (const set of [`"id" = 'other'`, `"storageKey" = 'k2'`, `"hubVersionId" = 'w'`, `"projectId" = '${f.projectA.id}'`]) {
      await expect(raw(`UPDATE "HubFetchedBlob" SET ${set} WHERE "storageKey" = $1`, `${own}/drawings/hub/h3-${run}`), set).rejects.toThrow(/is a Hub id/);
    }

    // the link's lifecycle stays writable: U7 unlinks and relinks through its one row
    await raw(`UPDATE "DrawingHubLink" SET "unlinkedAt" = now(), "linkedBy" = 'it-2' WHERE "projectId" = $1`, own);
  });

  it('H4: a drawing\'s Hub governed order only rises', async () => {
    const d = await drawing({ hubFileId: `file-${run}-h4` });
    const mark = (v: number | null) => raw(`UPDATE "Drawing" SET "hubGovernedOrder" = $2 WHERE "id" = $1`, d.id, v);
    await mark(5);
    await mark(5);
    await mark(7);
    await expect(mark(6)).rejects.toThrow(/only rises/);
    await expect(mark(null)).rejects.toThrow(/only rises/);
    expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: d.id } })).hubGovernedOrder).toBe(7);
  });

  it('H5: every Hub row is well formed: ids hold more than whitespace, a known outcome, a link never unlinked before it was linked, an order only beside its id', async () => {
    const blanks = ['', ' ', '\t', ' \n\r\f\v '];
    for (const b of blanks) {
      const why = JSON.stringify(b);
      await expect(raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "hubProjectId", "linkedBy") VALUES ($1, $2, $3, 'it')`, f.projectA.id, f.orgA.id, b), why)
        .rejects.toThrow(/DrawingHubLink_hubProjectId_present/);
      await expect(raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "hubProjectId", "linkedBy") VALUES ($1, $2, 'hp', $3)`, f.projectA.id, f.orgA.id, b), why)
        .rejects.toThrow(/DrawingHubLink_linkedBy_present/);
      await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'e', 'applied')`, f.orgA.id, b), why)
        .rejects.toThrow(/HubWebhookReceipt_webhookId_present/);
      await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, $3, 'applied')`, f.orgA.id, `wh5-${run}`, b), why)
        .rejects.toThrow(/HubWebhookReceipt_eventType_present/);
      await expect(raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId") VALUES ($1, $2, 'f')`, own, b), why)
        .rejects.toThrow(/HubVersionTombstone_hubVersionId_present/);
      await expect(raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId") VALUES ($1, $2, $3)`, own, `ver5-${run}`, b), why)
        .rejects.toThrow(/HubVersionTombstone_hubFileId_present/);
      await expect(raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ($1, $2, $3, 'v')`, `b5-${run}`, b, own), why)
        .rejects.toThrow(/HubFetchedBlob_storageKey_present/);
      await expect(raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ($1, $2, $3, $4)`, `b5-${run}`, `${own}/k5`, own, b), why)
        .rejects.toThrow(/HubFetchedBlob_hubVersionId_present/);
      await expect(drawing({ hubFileId: b }), why).rejects.toThrow(/Drawing_hubFileId_present/);
      const d = await drawing();
      await expect(revision(d.id, 'A', { hubVersionId: b }), why).rejects.toThrow(/DrawingRevision_hubVersionId_present/);
    }
    for (const outcome of ['apply', 'Applied', 'done', '']) {
      await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'e', $3)`, f.orgA.id, `wh5o-${run}`, outcome), outcome)
        .rejects.toThrow(/HubWebhookReceipt_outcome_known/);
    }
    await expect(raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "hubProjectId", "linkedBy", "linkedAt", "unlinkedAt")
                      VALUES ($1, $2, 'hp', 'it', '2026-10-26 10:00', '2026-10-26 09:59')`, f.projectA.id, f.orgA.id)).rejects.toThrow(/DrawingHubLink_unlinked_after_linked/);
    // U7's order: link, unlink, then relink, which moves linkedAt forward and clears unlinkedAt in the same UPDATE.
    // A relink that moves linkedAt past the kept unlink time without clearing it is refused.
    const linked = `it-hub1-link5-${run}`;
    await t.prisma.project.create({ data: {
      id: linked, orgId: f.orgA.id, name: linked, short: 'L', descriptor: '', stage: 'x', siteCode: 'L', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    try {
      await raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "hubProjectId", "linkedBy", "linkedAt") VALUES ($1, $2, 'hp', 'it', '2026-10-26 10:00')`, linked, f.orgA.id);
      await raw(`UPDATE "DrawingHubLink" SET "unlinkedAt" = '2026-10-26 10:30' WHERE "projectId" = $1`, linked);
      await expect(raw(`UPDATE "DrawingHubLink" SET "unlinkedAt" = '2026-10-26 09:59' WHERE "projectId" = $1`, linked)).rejects.toThrow(/DrawingHubLink_unlinked_after_linked/);
      await expect(raw(`UPDATE "DrawingHubLink" SET "linkedAt" = '2026-10-26 11:00', "linkedBy" = 'it2' WHERE "projectId" = $1`, linked))
        .rejects.toThrow(/DrawingHubLink_unlinked_after_linked/);
      await raw(`UPDATE "DrawingHubLink" SET "linkedAt" = '2026-10-26 11:00', "linkedBy" = 'it2', "unlinkedAt" = NULL WHERE "projectId" = $1`, linked);
      await raw(`UPDATE "DrawingHubLink" SET "unlinkedAt" = '2026-10-26 11:00' WHERE "projectId" = $1`, linked);
    } finally {
      await raw(`DELETE FROM "Project" WHERE "id" = $1`, linked);
    }

    // an order with no id identifies nothing, and H3 would keep the id from ever being added
    const pmc = await drawing();
    await expect(raw(`UPDATE "Drawing" SET "hubGovernedOrder" = 1 WHERE "id" = $1`, pmc.id)).rejects.toThrow(/Drawing_hub_order_needs_file/);
    await expect(raw(`INSERT INTO "Drawing" ("id", "projectId", "number", "title", "discipline", "hubGovernedOrder") VALUES ($1, $2, $3, 'x', 'architectural', 1)`,
      `d5-${run}`, own, `H5-${run}`)).rejects.toThrow(/Drawing_hub_order_needs_file/);
    await expect(revision(pmc.id, 'A', { hubVersionOrder: 1 })).rejects.toThrow(/DrawingRevision_hub_order_needs_version/);
    const hub = await drawing({ hubFileId: `file-${run}-h5` });
    await raw(`UPDATE "Drawing" SET "hubGovernedOrder" = 1 WHERE "id" = $1`, hub.id);
    await revision(hub.id, 'A', { hubVersionId: `ver-${run}-h5`, hubVersionOrder: 1 });
  });

  it('H6: a receipt and a tombstone are never changed, deleted or truncated on their own, and go with their org or project', async () => {
    await t.prisma.hubVersionTombstone.create({ data: { projectId: own, hubVersionId: `ver-${run}-t`, hubFileId: 'f', versionSeq: 5 } });
    for (const set of [`"hubFileId" = 'g'`, `"versionSeq" = 6`, `"versionSeq" = NULL`, `"hubVersionId" = 'w'`, `"projectId" = '${f.projectA.id}'`, `"withdrawnAt" = now()`]) {
      await expect(raw(`UPDATE "HubVersionTombstone" SET ${set} WHERE "projectId" = $1 AND "hubVersionId" = $2`, own, `ver-${run}-t`), set).rejects.toThrow(/is a record and is never changed/);
    }
    await expect(raw(`DELETE FROM "HubVersionTombstone" WHERE "projectId" = $1`, own)).rejects.toThrow(/never deleted; it goes only with its project/);
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `wh6-${run}`, eventType: 'drawing.issued', outcome: 'applied' } });
    for (const set of [`"outcome" = 'refused'`, `"eventType" = 'x'`, `"webhookId" = 'w'`, `"orgId" = '${f.orgB.id}'`, `"receivedAt" = now()`]) {
      await expect(raw(`UPDATE "HubWebhookReceipt" SET ${set} WHERE "orgId" = $1 AND "webhookId" = $2`, f.orgA.id, `wh6-${run}`), set).rejects.toThrow(/is a record and is never changed/);
    }
    await expect(raw(`DELETE FROM "HubWebhookReceipt" WHERE "orgId" = $1`, f.orgA.id)).rejects.toThrow(/never deleted; it goes only with its org/);
    expect(await t.prisma.hubVersionTombstone.count({ where: { projectId: own, hubVersionId: `ver-${run}-t` } })).toBe(1);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { orgId: f.orgA.id, webhookId: `wh6-${run}` } })).toBe(1);
    // the allowed write paths: U5 writes each receipt once and a tombstone only if absent, by INSERT … ON CONFLICT DO NOTHING
    expect(await raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'drawing.issued', 'refused')
                      ON CONFLICT ("orgId", "webhookId") DO NOTHING`, f.orgA.id, `wh6-${run}`)).toBe(0);
    expect(await raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'drawing.issued', 'applied')
                      ON CONFLICT ("orgId", "webhookId") DO NOTHING`, f.orgA.id, `wh6b-${run}`)).toBe(1);
    expect(await raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId", "versionSeq") VALUES ($1, $2, 'g', 7)
                      ON CONFLICT ("projectId", "hubVersionId") DO NOTHING`, own, `ver-${run}-t`)).toBe(0);
    expect(await raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId", "versionSeq") VALUES ($1, $2, 'g', 7)
                      ON CONFLICT ("projectId", "hubVersionId") DO NOTHING`, own, `ver-${run}-t2`)).toBe(1);
    expect((await t.prisma.hubWebhookReceipt.findUniqueOrThrow({ where: { orgId_webhookId: { orgId: f.orgA.id, webhookId: `wh6-${run}` } } })).outcome).toBe('applied');
    expect((await t.prisma.hubVersionTombstone.findUniqueOrThrow({ where: { projectId_hubVersionId: { projectId: own, hubVersionId: `ver-${run}-t` } } })).versionSeq).toBe(5);
    // the ledger is not sealed: the sweep (U5s) deletes a row per blob it removes
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${own}/drawings/hub/h6-${run}`, projectId: own, hubVersionId: 'v' } });
    expect(await raw(`DELETE FROM "HubFetchedBlob" WHERE "storageKey" = $1`, `${own}/drawings/hub/h6-${run}`)).toBe(1);

    for (const [table, owner] of [['HubWebhookReceipt', 'org'], ['HubVersionTombstone', 'project']] as const) {
      await expect(raw(`TRUNCATE TABLE "${table}"`), table).rejects.toThrow(new RegExp(`never truncated; each goes only with its ${owner}`));
    }

    // the org's own delete takes its receipts (the project cascade is H2's)
    const org = `it-hub1-org6-${run}`;
    await t.prisma.org.create({ data: { id: org, name: org, slug: org } });
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: org, webhookId: `wh6-${run}`, eventType: 'drawing.issued', outcome: 'ignored' } });
    await raw(`DELETE FROM "Org" WHERE "id" = $1`, org);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { orgId: org } })).toBe(0);

    // every statement seal on the two tables is registered for the sanctioned reset, which empties them and puts the seals back
    for (const table of ['HubWebhookReceipt', 'HubVersionTombstone']) {
      const seals = await t.prisma.$queryRawUnsafe<Array<{ name: string; enabled: string }>>(
        `SELECT tgname::text AS name, tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 32) <> 0`, `"${table}"`);
      expect(seals.map((x) => x.name)).toEqual([`${table}_no_truncate`]);
      expect(TRUNCATE_SEALS).toContainEqual({ table, trigger: `${table}_no_truncate` });
    }
    await sanctionedReset(t.prisma, ['HubWebhookReceipt', 'HubVersionTombstone']);
    expect(await t.prisma.hubWebhookReceipt.count()).toBe(0);
    expect(await t.prisma.hubVersionTombstone.count()).toBe(0);
    const states = await t.prisma.$queryRawUnsafe<Array<{ enabled: string }>>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname IN ('HubWebhookReceipt_no_truncate', 'HubVersionTombstone_no_truncate')`);
    expect(states.map((x) => x.enabled)).toEqual(['O', 'O']);
  });

  it('H7: a Hub row never leaves its project; a PMC drawing or revision is not judged', async () => {
    // the link: neither its project, its org nor its Hub project moves, within its org or to another one; only its
    // lifecycle columns (linkedAt, linkedBy, unlinkedAt) stay writable
    const p7 = `it-hub1-p7-${run}`;
    await t.prisma.project.create({ data: {
      id: p7, orgId: f.orgA.id, name: p7, short: 'P7', descriptor: '', stage: 'x', siteCode: 'P7', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    try {
      await t.prisma.drawingHubLink.create({ data: { projectId: p7, orgId: f.orgA.id, hubProjectId: `hp7-${run}`, linkedBy: 'it' } });
      await expect(raw(`UPDATE "DrawingHubLink" SET "projectId" = $2 WHERE "projectId" = $1`, p7, f.projectA.id)).rejects.toThrow(/DrawingHubLink\.projectId places a Hub row/);
      await expect(raw(`UPDATE "DrawingHubLink" SET "projectId" = $2, "orgId" = $3 WHERE "projectId" = $1`, p7, f.projectB.id, f.orgB.id)).rejects.toThrow(/places a Hub row/);
      await expect(raw(`UPDATE "DrawingHubLink" SET "hubProjectId" = 'hp-other' WHERE "projectId" = $1`, p7)).rejects.toThrow(/DrawingHubLink\.hubProjectId places a Hub row/);
      await raw(`UPDATE "DrawingHubLink" SET "projectId" = "projectId", "orgId" = "orgId", "hubProjectId" = "hubProjectId", "unlinkedAt" = now() WHERE "projectId" = $1`, p7);
      // a relink while unlinked still keeps its Hub project
      await expect(raw(`UPDATE "DrawingHubLink" SET "linkedAt" = now(), "unlinkedAt" = NULL, "hubProjectId" = 'hp7-other' WHERE "projectId" = $1`, p7)).rejects.toThrow(/hubProjectId places a Hub row/);
      await raw(`UPDATE "DrawingHubLink" SET "linkedAt" = now(), "linkedBy" = 'it-relink', "unlinkedAt" = NULL WHERE "projectId" = $1`, p7);
      expect((await t.prisma.drawingHubLink.findUniqueOrThrow({ where: { projectId: p7 } })).orgId).toBe(f.orgA.id);

      // a Hub drawing and its revisions stay in their project and on their drawing
      const hub = await drawing({ hubFileId: `file-${run}-h7`, projectId: p7 });
      const other = await drawing({ hubFileId: `file-${run}-h7b`, projectId: p7 });
      const r = await revision(hub.id, 'A', { hubVersionId: `ver-${run}-h7`, hubVersionOrder: 1, projectId: p7 });
      await expect(raw(`UPDATE "Drawing" SET "projectId" = $2 WHERE "id" = $1`, hub.id, f.projectA.id)).rejects.toThrow(/Drawing\.projectId places a Hub row/);
      await expect(raw(`UPDATE "Drawing" SET "id" = 'moved' WHERE "id" = $1`, hub.id)).rejects.toThrow(/Drawing\.id places a Hub row/);
      await expect(raw(`UPDATE "DrawingRevision" SET "drawingId" = $2 WHERE "id" = $1`, r.id, other.id)).rejects.toThrow(/DrawingRevision\.drawingId places a Hub row/);
      await expect(raw(`UPDATE "DrawingRevision" SET "id" = 'moved' WHERE "id" = $1`, r.id)).rejects.toThrow(/DrawingRevision\.id places a Hub row/);
      await expect(raw(`UPDATE "DrawingRevision" SET "projectId" = $2 WHERE "id" = $1`, r.id, f.projectA.id)).rejects.toThrow(/DrawingRevision\.projectId places a Hub row/);
      // no bypass by clearing the Hub id first (H3 refuses the clear), or by clearing it and moving in one statement
      await expect(raw(`UPDATE "Drawing" SET "hubFileId" = NULL WHERE "id" = $1`, hub.id)).rejects.toThrow(/hubFileId is a Hub id/);
      await expect(raw(`UPDATE "Drawing" SET "hubFileId" = NULL, "projectId" = $2 WHERE "id" = $1`, hub.id, f.projectA.id)).rejects.toThrow(/is a Hub id|places a Hub row/);
      await expect(raw(`UPDATE "DrawingRevision" SET "hubVersionId" = NULL, "hubVersionOrder" = NULL WHERE "id" = $1`, r.id)).rejects.toThrow(/is a Hub id/);
      await expect(raw(`UPDATE "DrawingRevision" SET "hubVersionId" = NULL, "hubVersionOrder" = NULL, "drawingId" = $2 WHERE "id" = $1`, r.id, other.id))
        .rejects.toThrow(/is a Hub id|places a Hub row/);
      // the guard reads the row's Hub id as it was (OLD), so even with the id-freeze off a one-statement clear-and-move is refused
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "Drawing" DISABLE TRIGGER "Drawing_hub_ids_immutable"`);
        await expect(tx.$executeRawUnsafe(`SAVEPOINT s1`).then(() => tx.$executeRawUnsafe(`UPDATE "Drawing" SET "hubFileId" = NULL, "projectId" = $2 WHERE "id" = $1`, hub.id, f.projectA.id)))
          .rejects.toThrow(/Drawing\.projectId places a Hub row/);
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT s1`);
        await tx.$executeRawUnsafe(`ALTER TABLE "Drawing" ENABLE TRIGGER "Drawing_hub_ids_immutable"`);
      });
      // a PMC drawing or revision never gains a Hub id after insert (H3), so it never becomes a frozen Hub row late
      const pmcLate = await drawing({ projectId: p7 });
      await expect(raw(`UPDATE "Drawing" SET "hubFileId" = 'late' WHERE "id" = $1`, pmcLate.id)).rejects.toThrow(/hubFileId is a Hub id/);
      // a project's own id change would carry its Hub rows with it, so it is refused
      await expect(raw(`UPDATE "Project" SET "id" = $2 WHERE "id" = $1`, p7, `${p7}-moved`)).rejects.toThrow(/places a Hub row/);
      // the same values, and every other column, still write
      await raw(`UPDATE "Drawing" SET "id" = "id", "projectId" = "projectId", "title" = 'Kept' WHERE "id" = $1`, hub.id);
      await raw(`UPDATE "DrawingRevision" SET "id" = "id", "projectId" = "projectId", "drawingId" = "drawingId", "status" = 'superseded' WHERE "id" = $1`, r.id);

      // PMC rows are not judged: a PMC revision moves to another PMC drawing, and a PMC drawing to another project
      const pmcA = await drawing({ projectId: p7 });
      const pmcB = await drawing({ projectId: p7 });
      const pr = await revision(pmcA.id, 'A', { projectId: p7 });
      await raw(`UPDATE "DrawingRevision" SET "drawingId" = $2 WHERE "id" = $1`, pr.id, pmcB.id);
      await raw(`UPDATE "Drawing" SET "projectId" = $2 WHERE "id" = $1`, pmcA.id, f.projectA.id);
      expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: pmcA.id } })).projectId).toBe(f.projectA.id);
    } finally {
      await t.prisma.drawingRevision.deleteMany({ where: { projectId: p7 } });
      await t.prisma.drawing.deleteMany({ where: { projectId: p7 } });
      await raw(`DELETE FROM "Project" WHERE "id" = $1`, p7);
    }
  });

  it('a PMC issue and acknowledge work as before, with every Hub column NULL', async () => {
    const p = f.projectA.id;
    const svc = t.app.get(DrawingsService);
    const pmc = { sub: f.memberUser.id, role: 'pmc', projectId: p } as AuthUser;
    const engineer = `it-hub1-eng-${run}`;
    await t.prisma.user.create({ data: { id: engineer, projectId: p, role: 'engineer', name: 'Eng', email: `${engineer}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: p, userId: engineer, role: 'engineer', status: 'active' } });
    try {
      const issued = await svc.issue(p, pmc, {
        number: `P-${run}`, title: 'Plan', discipline: 'architectural', rev: 'A', status: 'for_construction',
        mime: 'application/pdf', data: Buffer.from('%PDF-1.4 hub').toString('base64'), publish: true,
      } as never);
      const ack = await svc.acknowledge(p, issued.revisionId, { sub: engineer, role: 'engineer', projectId: p } as AuthUser);
      expect(ack.ok).toBe(true);
      const d = await t.prisma.drawing.findUniqueOrThrow({ where: { id: issued.drawingId } });
      const r = await t.prisma.drawingRevision.findUniqueOrThrow({ where: { id: issued.revisionId } });
      expect({ hubFileId: d.hubFileId, hubGovernedOrder: d.hubGovernedOrder, hubVersionId: r.hubVersionId, hubVersionOrder: r.hubVersionOrder })
        .toEqual({ hubFileId: null, hubGovernedOrder: null, hubVersionId: null, hubVersionOrder: null });
      expect(createHash('sha256').update(r.data ?? Buffer.alloc(0)).digest('hex')).toBe(createHash('sha256').update(Buffer.from('%PDF-1.4 hub')).digest('hex'));
    } finally {
      await t.prisma.drawingAck.deleteMany({ where: { userId: engineer } });
      await t.prisma.drawingRecipient.deleteMany({ where: { userId: engineer } });
      await t.prisma.membership.deleteMany({ where: { userId: engineer } });
      await t.prisma.user.deleteMany({ where: { id: engineer } });
    }
  });

  it('re-runs: a second and third run of the file leave the same uniques, keys, triggers and functions', async () => {
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ kind: string; name: string; def: string }>>(`
      SELECT 'index' AS kind, indexname AS name, indexdef AS def FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('Drawing', 'DrawingRevision', 'DrawingHubLink', 'HubWebhookReceipt', 'HubVersionTombstone', 'HubFetchedBlob')
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid IN ('public."DrawingHubLink"'::regclass, 'public."HubWebhookReceipt"'::regclass, 'public."HubVersionTombstone"'::regclass, 'public."HubFetchedBlob"'::regclass)
          OR (conrelid IN ('public."Drawing"'::regclass, 'public."DrawingRevision"'::regclass) AND conname LIKE '%hub%')
      UNION ALL
      SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger
       WHERE NOT tgisinternal AND tgname IN ('Drawing_hub_ids_immutable', 'Drawing_hub_mark_rises', 'DrawingRevision_hub_ids_immutable', 'HubFetchedBlob_ids_immutable',
                                             'HubWebhookReceipt_sealed', 'HubWebhookReceipt_no_truncate', 'HubVersionTombstone_sealed', 'HubVersionTombstone_no_truncate',
                                             'DrawingHubLink_owner_frozen', 'Drawing_hub_owner_frozen', 'DrawingRevision_hub_owner_frozen')
      UNION ALL
      SELECT 'function', p.proname, array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('drawings_hub_ids_immutable', 'drawings_hub_mark_rises', 'drawings_hub_record_sealed', 'drawings_hub_record_no_truncate', 'drawings_hub_owner_frozen')
      ORDER BY 1, 2`);
    const before = await shape();
    expect(before.filter((r) => r.kind === 'trigger')).toHaveLength(11);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('CHECK'))).toHaveLength(14);
    expect(before.filter((r) => r.kind === 'function').map((r) => r.def)).toEqual(Array(5).fill('search_path=pg_catalog, public, pg_temp'));
    expect(before.find((r) => r.name === 'Drawing_hub_file_per_project')?.def).toMatch(/WHERE \("hubFileId" IS NOT NULL\)/);
    replay();
    replay();
    expect(await shape()).toEqual(before);
  });
});
