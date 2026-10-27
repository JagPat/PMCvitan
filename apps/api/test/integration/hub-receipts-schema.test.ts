import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset, TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';

/**
 * #1118 U1a-1 — Hub's delivery receipts and withdrawn versions (`20280123000000_hub_receipts`), against live PostgreSQL.
 * It proves what the database holds on every writer (W1-W6 in the migration): one applied receipt per delivery and any
 * number of refused or ignored ones; a receipt's project is of its org; an applied receipt names a fact its event type
 * allows; an applied receipt and the fact its own delivery wrote name each other by key, checked at commit, so a fact a
 * re-sync or an earlier delivery wrote never backs a new claim (#1139 r4385819940); the records are sealed; and the file
 * re-runs and changes nothing.
 *
 * Every row is on a project of this file's own, in the fixture's org A. Hub records go only through `project:remove` or
 * the sanctioned reset, so `afterAll` clears them with the reset, then the drawings, then the projects.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280123000000_hub_receipts/migration.sql');
const SEALED = ['HubWebhookReceipt', 'HubVersionTombstone'] as const;
const RECORDS = ['HubGoverningMark', 'HubRevision', 'HubDrawing', ...SEALED] as const;

describe('#1118 U1a-1 — Hub delivery receipts bound to the fact their delivery wrote (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    if (!t) return;
    try {
      await sanctionedReset(t.prisma, [...RECORDS]);
      for (const id of made) {
        await raw(`DELETE FROM "Drawing" WHERE "projectId" = $1`, id);
        await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
      }
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = (file = MIGRATION) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', file], { stdio: 'pipe' });
  const project = async (tag: string, orgId = f.orgA.id) => {
    const id = `it-hubr-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  /** the next receipt id, so a receipt and its fact can be written in either order in one transaction */
  const nextId = async () => (await t.prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
    `SELECT nextval(pg_get_serial_sequence('"HubWebhookReceipt"', 'id')) AS id`))[0]!.id;
  type Receipt = { id?: bigint; org?: string; webhookId: string; eventType: string; outcome: string; p?: string | null; v?: string | null;
    fact?: string | null; markDrawing?: string | null; markOrder?: number | null };
  const receipt = (r: Receipt) => raw(
    `INSERT INTO "HubWebhookReceipt" ("id", "orgId", "webhookId", "eventType", "outcome", "projectId", "hubVersionId", "appliedFact", "markDrawingId", "markOrder")
     VALUES (coalesce($1::bigint, nextval(pg_get_serial_sequence('"HubWebhookReceipt"', 'id'))), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    r.id ?? null, r.org ?? f.orgA.id, r.webhookId, r.eventType, r.outcome, r.p ?? null, r.v ?? null, r.fact ?? null, r.markDrawing ?? null, r.markOrder ?? null);
  const tombstone = (p: string, v: string, source: bigint | null = null, file = `f-${v}`) =>
    raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId", "sourceReceiptId") VALUES ($1, $2, $3, $4)`, p, v, file, source);
  /** a Hub drawing with one revision of version `v` at `order`, written whole (U1b), with the revision's source */
  const hubDrawing = (p: string, d: string, v: string, order: number, source: bigint | null = null, status = 'for_review') => [
    raw(`INSERT INTO "Drawing" ("id", "projectId", "number", "title", "discipline", "source") VALUES ($1, $2, $1, 't', 'other', 'hub')`, d, p),
    raw(`INSERT INTO "HubDrawing" ("projectId", "drawingId", "hubFileId", "hubProjectId") VALUES ($1, $2, $3, 'hp')`, p, d, `f-${d}`),
    ...hubVersion(p, d, v, order, source, status),
  ];
  /** a later Hub version on a Hub drawing: its revision and record */
  const hubVersion = (p: string, d: string, v: string, order: number, source: bigint | null = null, status = 'for_review') => [
    raw(`INSERT INTO "DrawingRevision" ("id", "projectId", "drawingId", "rev", "status", "mime", "issuedBy", "issuedAt", "source")
         VALUES ($1, $2, $3, $4, $5, 'application/pdf', 'hub', 't', 'hub')`, `${d}-${v}`, p, d, `${v}`, status),
    raw(`INSERT INTO "HubRevision" ("projectId", "drawingId", "revisionId", "hubVersionId", "hubVersionOrder", "sourceReceiptId") VALUES ($1, $2, $3, $4, $5, $6)`,
      p, d, `${d}-${v}`, v, order, source),
  ];
  const mark = (p: string, d: string, order: number, source: bigint | null = null) =>
    raw(`INSERT INTO "HubGoverningMark" ("projectId", "drawingId", "order", "sourceReceiptId") VALUES ($1, $2, $3, $4)`, p, d, order, source);
  const receipts = (webhookId: string) => t.prisma.$queryRawUnsafe<Array<{ outcome: string }>>(
    `SELECT "outcome" FROM "HubWebhookReceipt" WHERE "webhookId" = $1 ORDER BY "id"`, webhookId);

  it('controls: each applied outcome of U5\'s decision table commits with the fact its delivery wrote, in either order', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('ctl');
    await t.prisma.$transaction(hubDrawing(p, `d-${run}`, `v1-${run}`, 1));
    // withdrawal: the receipt, then its tombstone
    const r1 = await nextId();
    await t.prisma.$transaction([
      receipt({ id: r1, webhookId: `w1-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `vt-${run}`, fact: 'tombstone' }),
      tombstone(p, `vt-${run}`, r1),
    ]);
    // governing, new for_construction: the revision, its record and the mark, then the receipt (written last)
    const r2 = await nextId();
    await t.prisma.$transaction([
      ...hubVersion(p, `d-${run}`, `v2-${run}`, 2, r2, 'for_construction'), mark(p, `d-${run}`, 2, r2),
      receipt({ id: r2, webhookId: `w2-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: `v2-${run}`, fact: 'mark', markDrawing: `d-${run}`, markOrder: 2 }),
    ]);
    // governing, promotion in place of version 1 (its revision already there): the mark only, by the optional event type
    const r3 = await nextId();
    await t.prisma.$transaction([
      receipt({ id: r3, webhookId: `w3-${run}`, eventType: 'drawing.status_changed', outcome: 'applied', p, v: `v1-${run}`, fact: 'mark', markDrawing: `d-${run}`, markOrder: 1 }),
      mark(p, `d-${run}`, 1, r3),
    ]);
    // a new history or SHARED revision: the revision and its record
    const r4 = await nextId();
    await t.prisma.$transaction([
      receipt({ id: r4, webhookId: `w4-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: `v3-${run}`, fact: 'revision' }),
      ...hubVersion(p, `d-${run}`, `v3-${run}`, 3, r4),
    ]);
    // a re-sync's facts name no receipt (U7r)
    await t.prisma.$transaction([...hubVersion(p, `d-${run}`, `v4-${run}`, 4), mark(p, `d-${run}`, 4), tombstone(p, `vs-${run}`)]);
    // Prisma's own create of a refused, an ignored and an org-only receipt
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `w5-${run}`, eventType: 'drawing.issued', outcome: 'refused' } });
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `w5-${run}`, eventType: 'drawing.issued', outcome: 'ignored', projectId: p, hubVersionId: `v2-${run}` } });
    expect(await t.prisma.hubWebhookReceipt.count({ where: { projectId: p, outcome: 'applied' } })).toBe(4);
    const sources = await t.prisma.$queryRawUnsafe<Array<{ kind: string; n: bigint }>>(`
      SELECT 'tombstone' AS kind, count(*) AS n FROM "HubVersionTombstone" WHERE "projectId" = $1 AND "sourceReceiptId" IS NOT NULL
      UNION ALL SELECT 'revision', count(*) FROM "HubRevision" WHERE "projectId" = $1 AND "sourceReceiptId" IS NOT NULL
      UNION ALL SELECT 'mark', count(*) FROM "HubGoverningMark" WHERE "projectId" = $1 AND "sourceReceiptId" IS NOT NULL ORDER BY 1`, p);
    expect(sources).toEqual([{ kind: 'mark', n: 2n }, { kind: 'revision', n: 2n }, { kind: 'tombstone', n: 1n }]);
  });

  it('W1/C2: one applied receipt per delivery; a refused or ignored delivery is judged again, and a repeat is recorded ignored', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w1');
    // a forged refused row first (naming the project), then the real delivery applied with its tombstone
    await receipt({ webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'refused', p });
    await receipt({ webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'ignored' });
    const r = await nextId();
    await t.prisma.$transaction([receipt({ id: r, webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `v-${run}`, fact: 'tombstone' }), tombstone(p, `v-${run}`, r)]);
    // a second applied row for the same delivery, with its own tombstone, is refused whole
    const r2 = await nextId();
    await expect(t.prisma.$transaction([
      receipt({ id: r2, webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `v2-${run}`, fact: 'tombstone' }), tombstone(p, `v2-${run}`, r2),
    // HubWebhookReceipt_one_applied, the only unique over these two columns (Prisma's message names the key, not the index)
    ])).rejects.toThrow(/23505[\s\S]*Key \(\\?"orgId\\?", \\?"webhookId\\?"\)/);
    // the repeat Hub sends again is recorded ignored
    await receipt({ webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'ignored', p, v: `v-${run}` });
    expect((await receipts(`w-${run}`)).map((x) => x.outcome)).toEqual(['refused', 'ignored', 'applied', 'ignored']);
    expect((await t.prisma.hubVersionTombstone.findUniqueOrThrow({ where: { projectId_hubVersionId: { projectId: p, hubVersionId: `v-${run}` } } })).sourceReceiptId).toBe(r);
    expect(await t.prisma.hubVersionTombstone.count({ where: { projectId: p } })).toBe(1);
    // the same webhook id in another org is another delivery
    const q = await project('w1b', f.orgB.id);
    const r3 = await nextId();
    await t.prisma.$transaction([
      receipt({ id: r3, org: f.orgB.id, webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p: q, v: `v-${run}`, fact: 'tombstone' }), tombstone(q, `v-${run}`, r3),
    ]);
    // one tombstone per (project, version)
    await expect(tombstone(p, `v-${run}`)).rejects.toThrow(/23505[\s\S]*Key \(\\?"projectId\\?", \\?"hubVersionId\\?"\)/);
  });

  it('W2: a receipt names an org that exists and a project of that org; a tombstone names a project that exists', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w2');
    await expect(receipt({ org: 'no-such-org', webhookId: `w-${run}`, eventType: 'drawing.issued', outcome: 'refused' })).rejects.toThrow(/HubWebhookReceipt_orgId_fkey/);
    await expect(receipt({ org: f.orgB.id, webhookId: `w-${run}`, eventType: 'drawing.issued', outcome: 'refused', p })).rejects.toThrow(/HubWebhookReceipt_orgId_projectId_fkey/);
    await expect(receipt({ webhookId: `w-${run}`, eventType: 'drawing.issued', outcome: 'refused', p: 'no-such-project' })).rejects.toThrow(/HubWebhookReceipt_orgId_projectId_fkey/);
    await expect(tombstone('no-such-project', `v-${run}`)).rejects.toThrow(/HubVersionTombstone_projectId_fkey/);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { webhookId: `w-${run}` } })).toBe(0);
  });

  it('W3: an applied receipt names a project, a version and a fact its event type allows; only an applied receipt names a fact', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w3');
    const base = { webhookId: `w-${run}`, p, v: `v-${run}` };
    const refusals: Array<[Receipt, RegExp]> = [
      // applied with something missing
      [{ ...base, eventType: 'drawing.superseded', outcome: 'applied', p: null, fact: 'tombstone' }, /HubWebhookReceipt_applied_has_fact/],
      [{ ...base, eventType: 'drawing.superseded', outcome: 'applied', v: null, fact: 'tombstone' }, /HubWebhookReceipt_applied_has_fact/],
      [{ ...base, eventType: 'drawing.superseded', outcome: 'applied' }, /HubWebhookReceipt_applied_has_fact/],
      // refused or ignored naming all three, or a fact alone
      [{ ...base, eventType: 'drawing.superseded', outcome: 'refused', fact: 'tombstone' }, /HubWebhookReceipt_applied_has_fact|HubWebhookReceipt_fact_only_applied/],
      [{ ...base, eventType: 'drawing.issued', outcome: 'ignored', p: null, fact: 'revision' }, /HubWebhookReceipt_fact_only_applied/],
      // a mark's drawing and order exactly with a mark
      [{ ...base, eventType: 'drawing.issued', outcome: 'applied', fact: 'mark', markOrder: 1 }, /HubWebhookReceipt_mark_cols/],
      [{ ...base, eventType: 'drawing.issued', outcome: 'applied', fact: 'mark', markDrawing: 'd' }, /HubWebhookReceipt_mark_cols/],
      [{ ...base, eventType: 'drawing.issued', outcome: 'applied', fact: 'revision', markDrawing: 'd', markOrder: 1 }, /HubWebhookReceipt_mark_cols/],
      [{ ...base, eventType: 'drawing.issued', outcome: 'refused', markDrawing: 'd', markOrder: 1 }, /HubWebhookReceipt_mark_cols/],
      // the event type allows the fact (#1139 Stage 1 R2: a withdrawal claimed as a revision)
      [{ ...base, eventType: 'drawing.superseded', outcome: 'applied', fact: 'revision' }, /HubWebhookReceipt_event_fact/],
      [{ ...base, eventType: 'drawing.superseded', outcome: 'applied', fact: 'mark', markDrawing: 'd', markOrder: 1 }, /HubWebhookReceipt_event_fact/],
      [{ ...base, eventType: 'drawing.issued', outcome: 'applied', fact: 'tombstone' }, /HubWebhookReceipt_event_fact/],
      [{ ...base, eventType: 'drawing.status_changed', outcome: 'applied', fact: 'revision' }, /HubWebhookReceipt_event_fact/],
      [{ ...base, eventType: 'drawing.deleted', outcome: 'applied', fact: 'tombstone' }, /HubWebhookReceipt_event_fact/],
      // lists
      [{ ...base, eventType: 'drawing.issued', outcome: 'done' }, /HubWebhookReceipt_outcome_known/],
      [{ ...base, eventType: 'drawing.issued', outcome: 'applied', fact: 'drawing' }, /HubWebhookReceipt_appliedFact_known|HubWebhookReceipt_event_fact/],
    ];
    for (const [r, why] of refusals) await expect(receipt(r), JSON.stringify(r)).rejects.toThrow(why);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { webhookId: `w-${run}` } })).toBe(0);
  });

  it('W4: an applied receipt commits only with the fact written with its own id (#1139 r4385819940)', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w4');
    const d = `d-${run}`;
    // version 1 on d, and its mark, written by a re-sync (no receipt)
    await t.prisma.$transaction([...hubDrawing(p, d, `v1-${run}`, 1), mark(p, d, 1)]);
    await t.prisma.$transaction(hubVersion(p, d, `v2-${run}`, 2));
    const claims: Array<[Receipt, RegExp]> = [
      // Stage 1 R1: a withdrawal applied with no tombstone
      [{ webhookId: `w1-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `v1-${run}`, fact: 'tombstone' }, /HubWebhookReceipt_tombstone_fact_fkey/],
      // Stage 1 R4: a promotion claimed against the revision a re-sync wrote
      [{ webhookId: `w2-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: `v2-${run}`, fact: 'revision' }, /HubWebhookReceipt_revision_fact_fkey/],
      // R4b: the same claimed as a mark with no mark row
      [{ webhookId: `w3-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: `v2-${run}`, fact: 'mark', markDrawing: d, markOrder: 2 }, /HubWebhookReceipt_mark_fact_fkey/],
      // R4c: the mark a re-sync wrote, claimed by a webhook
      [{ webhookId: `w4-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: `v1-${run}`, fact: 'mark', markDrawing: d, markOrder: 1 }, /HubWebhookReceipt_mark_fact_fkey/],
    ];
    for (const [r, why] of claims) {
      await expect(receipt(r), r.webhookId).rejects.toThrow(why);
      // asking for the check at once refuses it too
      await expect(t.prisma.$transaction([raw('SET CONSTRAINTS ALL IMMEDIATE'), receipt(r)]), `${r.webhookId} immediate`).rejects.toThrow(why);
    }
    // a pre-existing tombstone, a re-sync's, backs no claim either
    await tombstone(p, `vt-${run}`);
    await expect(receipt({ webhookId: `w5-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `vt-${run}`, fact: 'tombstone' }))
      .rejects.toThrow(/HubWebhookReceipt_tombstone_fact_fkey/);
    // a mark with its receipt whose order is another version's on that drawing (version 1 is order 1; the claim names version 2)
    const r6 = await nextId();
    await t.prisma.$transaction(hubVersion(p, d, `v3-${run}`, 3));
    await expect(t.prisma.$transaction([
      receipt({ id: r6, webhookId: `w6-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: `v2-${run}`, fact: 'mark', markDrawing: d, markOrder: 3 }), mark(p, d, 3, r6),
    ])).rejects.toThrow(/HubWebhookReceipt_mark_version_fkey/);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { projectId: p } })).toBe(0);
    expect(await t.prisma.hubGoverningMark.count({ where: { projectId: p } })).toBe(1);
  });

  it('W4: a fact\'s source is an applied receipt of its project that wrote that kind of fact for that row', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w4s');
    const q = await project('w4q');
    const d = `d-${run}`;
    await t.prisma.$transaction(hubDrawing(p, d, `v1-${run}`, 1));
    const refused = await nextId();
    await receipt({ id: refused, webhookId: `wr-${run}`, eventType: 'drawing.superseded', outcome: 'refused', p, v: `v9-${run}` });
    const tomb = await nextId();
    await t.prisma.$transaction([receipt({ id: tomb, webhookId: `wt-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `v8-${run}`, fact: 'tombstone' }), tombstone(p, `v8-${run}`, tomb)]);
    const other = await nextId();
    await t.prisma.$transaction([
      receipt({ id: other, webhookId: `wq-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p: q, v: `v7-${run}`, fact: 'tombstone' }), tombstone(q, `v7-${run}`, other),
    ]);
    const sources: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['a delivery that does not exist', () => tombstone(p, `v9-${run}`, 424242424n), /HubVersionTombstone_source_fkey/],
      ['a refused receipt', () => tombstone(p, `v9-${run}`, refused), /HubVersionTombstone_source_fkey/],
      ['another project\'s receipt', () => tombstone(p, `v7-${run}`, other), /HubVersionTombstone_source_fkey/],
      ['another version\'s tombstone receipt', () => tombstone(p, `v9-${run}`, tomb), /HubVersionTombstone_source_fkey/],
      ['a tombstone receipt for a revision', () => t.prisma.$transaction(hubVersion(p, d, `v8-${run}`, 8, tomb)), /HubRevision_source_fkey/],
      ['a tombstone receipt for a mark', () => mark(p, d, 1, tomb), /HubGoverningMark_source_fkey/],
    ];
    for (const [why, write, error] of sources) await expect(write(), why).rejects.toThrow(error);
    expect(await t.prisma.hubVersionTombstone.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.hubGoverningMark.count({ where: { projectId: p } })).toBe(0);
  });

  it('W5: a receipt and a tombstone are never changed, deleted on their own or truncated; a fact is never re-pointed at a receipt', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w5');
    const d = `d-${run}`;
    await t.prisma.$transaction(hubDrawing(p, d, `v1-${run}`, 1));
    const r = await nextId();
    await t.prisma.$transaction([receipt({ id: r, webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `vt-${run}`, fact: 'tombstone' }), tombstone(p, `vt-${run}`, r)]);
    await receipt({ webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'refused' });
    const updates: Array<[string, string]> = [
      ['HubWebhookReceipt', `"outcome" = 'refused'`], ['HubWebhookReceipt', `"projectId" = NULL`], ['HubWebhookReceipt', `"webhookId" = "webhookId"`],
      ['HubVersionTombstone', `"sourceReceiptId" = NULL`], ['HubVersionTombstone', `"hubFileId" = 'g'`], ['HubVersionTombstone', `"versionSeq" = 3`],
      // a re-sync's revision claimed after the fact by re-pointing it (U1b's seal)
      ['HubRevision', `"sourceReceiptId" = ${r}`],
    ];
    for (const [table, set] of updates) {
      await expect(raw(`UPDATE "${table}" SET ${set} WHERE "projectId" = $1 OR ("projectId" IS NULL AND $2 = 'HubWebhookReceipt')`, p, table), `${table} ${set}`)
        .rejects.toThrow(/is a record and is never changed/);
    }
    await expect(raw(`DELETE FROM "HubWebhookReceipt" WHERE "webhookId" = $1`, `w-${run}`)).rejects.toThrow(/never deleted; it goes only with its project or org/);
    await expect(raw(`DELETE FROM "HubVersionTombstone" WHERE "projectId" = $1`, p)).rejects.toThrow(/never deleted; it goes only with its project/);
    for (const table of SEALED) await expect(raw(`TRUNCATE TABLE "${table}" CASCADE`), table).rejects.toThrow(/are records and are never truncated/);
    expect((await receipts(`w-${run}`)).map((x) => x.outcome)).toEqual(['applied', 'refused']);
  });

  it('W6: every id and event type holds more than whitespace', async () => {
    const run = randomUUID().slice(0, 8);
    const p = await project('w6');
    for (const b of ['', ' ', '\t', ' \n\r\f\v ']) {
      const why = JSON.stringify(b);
      await expect(receipt({ webhookId: b, eventType: 'drawing.issued', outcome: 'refused' }), why).rejects.toThrow(/HubWebhookReceipt_webhookId_present/);
      await expect(receipt({ webhookId: `w-${run}`, eventType: b, outcome: 'refused' }), why).rejects.toThrow(/HubWebhookReceipt_eventType_present/);
      await expect(receipt({ webhookId: `w-${run}`, eventType: 'drawing.issued', outcome: 'ignored', p, v: b }), why).rejects.toThrow(/HubWebhookReceipt_hubVersionId_present/);
      await expect(receipt({ webhookId: `w-${run}`, eventType: 'drawing.issued', outcome: 'applied', p, v: 'v', fact: 'mark', markDrawing: b, markOrder: 1 }), why)
        .rejects.toThrow(/HubWebhookReceipt_markDrawingId_present/);
      await expect(tombstone(p, b), why).rejects.toThrow(/HubVersionTombstone_hubVersionId_present/);
      await expect(tombstone(p, `v-${run}`, null, b), why).rejects.toThrow(/HubVersionTombstone_hubFileId_present/);
    }
    expect(await t.prisma.hubWebhookReceipt.count({ where: { webhookId: `w-${run}` } })).toBe(0);
  });

  it('W5: the records go with their project or org: a delete cascades past the seal', async () => {
    const run = randomUUID().slice(0, 8);
    // a project with no drawings, holding an applied withdrawal and its tombstone, beside a refused receipt of its org
    const p = await project('cas');
    const r = await nextId();
    await t.prisma.$transaction([receipt({ id: r, webhookId: `wa-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `v-${run}`, fact: 'tombstone' }), tombstone(p, `v-${run}`, r)]);
    await receipt({ webhookId: `wo-${run}`, eventType: 'drawing.issued', outcome: 'refused' });
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, p);
    expect(await receipts(`wa-${run}`)).toEqual([]);
    expect(await t.prisma.hubVersionTombstone.count({ where: { projectId: p } })).toBe(0);
    expect(await receipts(`wo-${run}`)).toEqual([{ outcome: 'refused' }]);
    // an org with no project and one refused receipt
    const o = `it-hubr-org-${run}`;
    await t.prisma.org.create({ data: { id: o, name: o, slug: o } });
    await receipt({ org: o, webhookId: `we-${run}`, eventType: 'drawing.issued', outcome: 'refused' });
    await raw(`DELETE FROM "Org" WHERE "id" = $1`, o);
    expect(await receipts(`we-${run}`)).toEqual([]);
  });

  it('W5: the sanctioned reset lifts the two TRUNCATE seals by name and puts them back', async () => {
    const run = randomUUID().slice(0, 8);
    for (const table of SEALED) {
      const seals = await t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 32) <> 0`, `"${table}"`);
      expect(seals.map((x) => x.name), table).toEqual([`${table}_no_truncate`]);
      expect(TRUNCATE_SEALS).toContainEqual({ table, trigger: `${table}_no_truncate` });
    }
    const p = await project('rs');
    const r = await nextId();
    await t.prisma.$transaction([receipt({ id: r, webhookId: `w-${run}`, eventType: 'drawing.superseded', outcome: 'applied', p, v: `v-${run}`, fact: 'tombstone' }), tombstone(p, `v-${run}`, r)]);
    // a receipt and the facts reference each other, so they go in one statement
    await sanctionedReset(t.prisma, [...RECORDS]);
    for (const table of SEALED) {
      expect(await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}"`), table).toEqual([{ n: 0n }]);
    }
    const states = await t.prisma.$queryRawUnsafe<Array<{ enabled: string }>>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = ANY($1::text[])`, SEALED.map((s) => `${s}_no_truncate`));
    expect(states.map((x) => x.enabled)).toEqual(['O', 'O']);
  });

  it('re-runs: a second and third run of the file leave the same columns, keys, checks, triggers and functions', async () => {
    const run = randomUUID().slice(0, 8);
    const tables = [...RECORDS];
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ kind: string; name: string; def: string }>>(`
      SELECT 'column' AS kind, table_name || '.' || column_name AS name,
             data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') || ' ' || coalesce(generation_expression, '') AS def
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      UNION ALL
      SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid) || ' ' || convalidated::text FROM pg_constraint WHERE conrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'function', p.proname, array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('drawings_hub_record_sealed', 'drawings_hub_record_no_truncate')
      ORDER BY 1, 2`, tables, tables.map((x) => `"${x}"`));
    const before = await shape();
    // the three derived columns are generated, and set only on an applied receipt of their kind
    expect(before.filter((r) => r.kind === 'column' && /VersionId$/.test(r.name) && /CASE/.test(r.def)).map((r) => r.name).sort()).toEqual([
      'HubWebhookReceipt.revisionVersionId', 'HubWebhookReceipt.tombstoneVersionId', 'HubWebhookReceipt.writtenVersionId']);
    expect(before.find((r) => r.name === 'HubWebhookReceipt_one_applied')?.def).toMatch(/UNIQUE INDEX .* \("orgId", "webhookId"\) WHERE \(outcome = 'applied'::text\)/);
    // the seven binding keys are deferrable, checked at commit
    expect(before.filter((r) => r.kind === 'constraint' && /DEFERRABLE INITIALLY DEFERRED true$/.test(r.def)).map((r) => r.name).sort()).toEqual([
      'HubGoverningMark_source_fkey', 'HubRevision_source_fkey', 'HubVersionTombstone_source_fkey', 'HubWebhookReceipt_mark_fact_fkey',
      'HubWebhookReceipt_mark_version_fkey', 'HubWebhookReceipt_revision_fact_fkey', 'HubWebhookReceipt_tombstone_fact_fkey']);
    expect(before.filter((r) => r.kind === 'trigger' && /HubWebhookReceipt|HubVersionTombstone/.test(r.name)).map((r) => r.name).sort()).toEqual([
      'HubVersionTombstone_no_truncate', 'HubVersionTombstone_sealed', 'HubWebhookReceipt_no_truncate', 'HubWebhookReceipt_sealed']);
    expect(before.filter((r) => r.kind === 'function').map((r) => r.def)).toEqual(Array(2).fill('search_path=pg_catalog, public, pg_temp'));
    replay();
    replay();
    expect(await shape()).toEqual(before);
    // one transaction: a run that fails at its last statement leaves nothing of itself, its dropped triggers and
    // checks included
    const dir = mkdtempSync(join(tmpdir(), 'hub-receipts-'));
    try {
      const sql = readFileSync(MIGRATION, 'utf8');
      expect(sql.trimEnd().endsWith('\nCOMMIT;')).toBe(true);
      const failing = join(dir, 'failing.sql');
      writeFileSync(failing, sql.replace(/\nCOMMIT;\s*$/, '\nSELECT 1 / 0;\nCOMMIT;\n'));
      expect(() => replay(failing)).toThrow(/division by zero/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await shape()).toEqual(before);
  });
});
