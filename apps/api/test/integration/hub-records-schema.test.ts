import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset, TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';

/**
 * #1118 U1a — the Hub records (`20280121000000_hub_records`), against live PostgreSQL. It proves what the database holds
 * on every writer (R1-R5 in the migration): the keys, the owners, that every record is sealed and goes only with its
 * project or org, that the link history is a chain by its keys and checks alone, that every row is well formed, and that
 * the file re-runs and changes nothing.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280121000000_hub_records/migration.sql');
const SEALED = ['HubWebhookReceipt', 'HubVersionTombstone', 'DrawingHubLink', 'DrawingHubLinkEvent'] as const;

describe('#1118 U1a — the Hub records (live PG)', () => {
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
      for (const id of made) await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  // a project of its own per test, so its records and its delete stay out of the fixture's projects
  const project = async (tag: string, orgId = f.orgA.id) => {
    const id = `it-hubr-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  const link = (projectId: string, orgId = f.orgA.id) => raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "createdBy") VALUES ($1, $2, 'it')`, projectId, orgId);
  const event = (projectId: string, seq: number, prevSeq: number | null, kind: string, hubProjectId: string | null, by = 'it') =>
    raw(`INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "by") VALUES ($1, $2, $3, $4, $5, $6)`, projectId, seq, prevSeq, kind, hubProjectId, by);

  it('R1/R2: one record per key, each owned by a project or org that exists, a link\'s org its project\'s own', async () => {
    const p = await project('r12');
    await link(p);
    await expect(link(p)).rejects.toThrow(/23505/);
    await event(p, 1, null, 'linked', 'hp');
    await expect(event(p, 1, null, 'linked', 'hp')).rejects.toThrow(/23505/);
    await t.prisma.hubVersionTombstone.create({ data: { projectId: p, hubVersionId: 'v', hubFileId: 'f' } });
    await expect(t.prisma.hubVersionTombstone.create({ data: { projectId: p, hubVersionId: 'v', hubFileId: 'g' } })).rejects.toThrow();
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `wh1-${run}`, eventType: 'drawing.issued', outcome: 'applied' } });
    await expect(t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `wh1-${run}`, eventType: 'drawing.issued', outcome: 'refused' } })).rejects.toThrow();
    // the same webhook id in another org is that org's own
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgB.id, webhookId: `wh1-${run}`, eventType: 'drawing.issued', outcome: 'applied' } });
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${p}/drawings/hub/a`, projectId: p, hubVersionId: 'v' } });
    await expect(t.prisma.hubFetchedBlob.create({ data: { storageKey: `${p}/drawings/hub/a`, projectId: p, hubVersionId: 'w' } })).rejects.toThrow();

    const q = await project('r12b');
    await expect(link(q, f.orgB.id)).rejects.toThrow(/DrawingHubLink_orgId_projectId_fkey/);
    await expect(event(q, 1, null, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_projectId_fkey/);
    await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ('no-such-org', 'w', 'e', 'applied')`))
      .rejects.toThrow(/HubWebhookReceipt_orgId_fkey/);
    await expect(raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId") VALUES ('no-such-project', 'v', 'f')`))
      .rejects.toThrow(/HubVersionTombstone_projectId_fkey/);
    await expect(raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ('b', 'no-such-project/drawings/hub/x', 'no-such-project', 'v')`))
      .rejects.toThrow(/HubFetchedBlob_projectId_fkey/);
  });

  it('R3: a receipt, a tombstone, a link and an event are never changed, deleted or truncated on their own; a ledger row is never changed', async () => {
    const p = await project('r3');
    const other = await project('r3o');
    await link(p);
    await event(p, 1, null, 'linked', 'hp');
    await t.prisma.hubVersionTombstone.create({ data: { projectId: p, hubVersionId: 'v', hubFileId: 'f', versionSeq: 5 } });
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: f.orgA.id, webhookId: `wh3-${run}`, eventType: 'drawing.issued', outcome: 'applied' } });
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${p}/drawings/hub/r3`, projectId: p, hubVersionId: 'v' } });

    const updates: Array<[string, string, unknown[]]> = [
      ['DrawingHubLink', `"createdBy" = 'x'`, [p]], ['DrawingHubLink', `"createdAt" = now()`, [p]],
      ['DrawingHubLink', `"projectId" = '${other}'`, [p]], ['DrawingHubLink', `"orgId" = '${f.orgB.id}'`, [p]],
      ['DrawingHubLinkEvent', `"hubProjectId" = 'hp2'`, [p]], ['DrawingHubLinkEvent', `"by" = 'x'`, [p]], ['DrawingHubLinkEvent', `"at" = now()`, [p]],
      ['DrawingHubLinkEvent', `"seq" = 3, "prevSeq" = 2`, [p]], ['DrawingHubLinkEvent', `"projectId" = '${other}'`, [p]],
      ['HubVersionTombstone', `"hubFileId" = 'g'`, [p]], ['HubVersionTombstone', `"versionSeq" = NULL`, [p]], ['HubVersionTombstone', `"projectId" = '${other}'`, [p]],
      // the same value is still a write, and still refused: a record is never rewritten
      ['HubVersionTombstone', `"hubFileId" = "hubFileId"`, [p]],
    ];
    for (const [table, set, values] of updates) {
      await expect(raw(`UPDATE "${table}" SET ${set} WHERE "projectId" = $1`, ...values), `${table} ${set}`).rejects.toThrow(/is a record and is never changed/);
    }
    for (const set of [`"outcome" = 'refused'`, `"eventType" = 'x'`, `"orgId" = '${f.orgB.id}'`]) {
      await expect(raw(`UPDATE "HubWebhookReceipt" SET ${set} WHERE "orgId" = $1 AND "webhookId" = $2`, f.orgA.id, `wh3-${run}`), set).rejects.toThrow(/is a record and is never changed/);
    }
    // the ledger: never changed, so its project and key never move together into another project's Hub prefix
    for (const set of [`"projectId" = '${other}', "storageKey" = '${other}/drawings/hub/r3'`, `"hubVersionId" = 'w'`, `"storageKey" = '${p}/drawings/hub/r3b'`]) {
      await expect(raw(`UPDATE "HubFetchedBlob" SET ${set} WHERE "projectId" = $1`, p), set).rejects.toThrow(/HubFetchedBlob row is a record and is never changed/);
    }

    for (const table of ['DrawingHubLinkEvent', 'DrawingHubLink', 'HubVersionTombstone']) {
      await expect(raw(`DELETE FROM "${table}" WHERE "projectId" = $1`, p), table).rejects.toThrow(/never deleted; it goes only with its project/);
    }
    await expect(raw(`DELETE FROM "HubWebhookReceipt" WHERE "orgId" = $1 AND "webhookId" = $2`, f.orgA.id, `wh3-${run}`)).rejects.toThrow(/never deleted; it goes only with its org/);
    for (const table of SEALED) {
      await expect(raw(`TRUNCATE TABLE "${table}" CASCADE`), table).rejects.toThrow(/are records and are never truncated/);
    }
    // nothing moved
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.drawingHubLinkEvent.findMany({ where: { projectId: p } })).toEqual([expect.objectContaining({ seq: 1, kind: 'linked', hubProjectId: 'hp', by: 'it' })]);
    expect((await t.prisma.hubVersionTombstone.findUniqueOrThrow({ where: { projectId_hubVersionId: { projectId: p, hubVersionId: 'v' } } })).versionSeq).toBe(5);
    expect((await t.prisma.hubWebhookReceipt.findUniqueOrThrow({ where: { orgId_webhookId: { orgId: f.orgA.id, webhookId: `wh3-${run}` } } })).outcome).toBe('applied');
    expect(await t.prisma.hubFetchedBlob.findMany({ where: { projectId: p } })).toEqual([expect.objectContaining({ storageKey: `${p}/drawings/hub/r3`, hubVersionId: 'v' })]);

    // the allowed write paths: U5 writes each receipt once and a tombstone only if absent (INSERT … ON CONFLICT DO
    // NOTHING); a repeat writes nothing and leaves the first row as it was
    expect(await raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'drawing.issued', 'refused')
                      ON CONFLICT ("orgId", "webhookId") DO NOTHING`, f.orgA.id, `wh3-${run}`)).toBe(0);
    expect(await raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId", "versionSeq") VALUES ($1, 'v', 'g', 7)
                      ON CONFLICT ("projectId", "hubVersionId") DO NOTHING`, p)).toBe(0);
    // the sweep (U5s) deletes a ledger row per blob it removes
    expect(await raw(`DELETE FROM "HubFetchedBlob" WHERE "storageKey" = $1`, `${p}/drawings/hub/r3`)).toBe(1);

    // each goes with its owner: the project's delete takes its link, history, tombstone and ledger; the org's its receipts
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${p}/drawings/hub/r3c`, projectId: p, hubVersionId: 'v' } });
    await event(p, 2, 1, 'unlinked', null);
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, p);
    for (const n of await Promise.all([
      t.prisma.drawingHubLink.count({ where: { projectId: p } }), t.prisma.drawingHubLinkEvent.count({ where: { projectId: p } }),
      t.prisma.hubVersionTombstone.count({ where: { projectId: p } }), t.prisma.hubFetchedBlob.count({ where: { projectId: p } }),
    ])) expect(n).toBe(0);
    const org = `it-hubr-org-${run}`;
    await t.prisma.org.create({ data: { id: org, name: org, slug: org } });
    await t.prisma.hubWebhookReceipt.create({ data: { orgId: org, webhookId: `wh3-${run}`, eventType: 'drawing.issued', outcome: 'ignored' } });
    await raw(`DELETE FROM "Org" WHERE "id" = $1`, org);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { orgId: org } })).toBe(0);
  });

  it('R4: the link history is a chain: event 1 links, links and unlinks alternate, each names the one before it, a link names its Hub project', async () => {
    const p = await project('r4');
    await link(p);
    // event 1 is a link with no previous event
    await expect(event(p, 1, null, 'unlinked', null)).rejects.toThrow(/DrawingHubLinkEvent_kind_alternates/);
    await expect(event(p, 1, 0, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(event(p, 0, null, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(event(p, -1, null, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    // a later event needs the one before it, in the same project
    await expect(event(p, 2, 1, 'unlinked', null)).rejects.toThrow(/DrawingHubLinkEvent_projectId_prevSeq_fkey/);
    await event(p, 1, null, 'linked', 'hp-a');
    // no gap, no second link or unlink in a row, no event without its previous one
    await expect(event(p, 3, 1, 'linked', 'hp-b')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(event(p, 3, 2, 'linked', 'hp-b')).rejects.toThrow(/DrawingHubLinkEvent_projectId_prevSeq_fkey/);
    await expect(event(p, 2, null, 'unlinked', null)).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(event(p, 2, 1, 'linked', 'hp-b')).rejects.toThrow(/DrawingHubLinkEvent_kind_alternates/);
    // an unlink names no Hub project; a link always names one
    await expect(event(p, 2, 1, 'unlinked', 'hp-a')).rejects.toThrow(/DrawingHubLinkEvent_hubProjectId_on_link/);
    for (const b of [null, '', ' ', '\t', ' \n\r\f\v ']) {
      const q = await project(`r4b${made.length}`);
      await link(q);
      await expect(event(q, 1, null, 'linked', b), JSON.stringify(b)).rejects.toThrow(/DrawingHubLinkEvent_hubProjectId_on_link/);
    }
    await expect(event(p, 2, 1, 'unlinked', null, ' ')).rejects.toThrow(/DrawingHubLinkEvent_by_present/);
    await expect(event(p, 2, 1, 'paused', null)).rejects.toThrow(/DrawingHubLinkEvent_(kind_alternates|hubProjectId_on_link)/);
    // U7's order: link, unlink, then relink (to another Hub project too); each is its own attributed record
    await event(p, 2, 1, 'unlinked', null, 'it-unlink');
    await event(p, 3, 2, 'linked', 'hp-b', 'it-relink');
    // two writers racing for the next event: the key lets one win
    await expect(event(p, 3, 2, 'linked', 'hp-c')).rejects.toThrow(/23505/);
    const history = await t.prisma.drawingHubLinkEvent.findMany({ where: { projectId: p }, orderBy: { seq: 'asc' } });
    expect(history.map((e) => [e.seq, e.prevSeq, e.kind, e.hubProjectId, e.by])).toEqual([
      [1, null, 'linked', 'hp-a', 'it'], [2, 1, 'unlinked', null, 'it-unlink'], [3, 2, 'linked', 'hp-b', 'it-relink'],
    ]);
    // the active link is the latest event when it is a link; a link row with no event is not linked
    const active = (projectId: string) => t.prisma.$queryRawUnsafe<Array<{ hubProjectId: string | null }>>(
      `SELECT "hubProjectId" FROM "DrawingHubLinkEvent" WHERE "projectId" = $1 ORDER BY "seq" DESC LIMIT 1`, projectId);
    expect(await active(p)).toEqual([{ hubProjectId: 'hp-b' }]);
    const bare = await project('r4c');
    await link(bare);
    expect(await active(bare)).toEqual([]);
  });

  it('R5: every record is well formed, and a ledger key sits under its own project\'s Hub prefix', async () => {
    const p = await project('r5');
    const q = await project('r5q');
    for (const b of ['', ' ', '\t', ' \n\r\f\v ']) {
      const why = JSON.stringify(b);
      await expect(raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId", "createdBy") VALUES ($1, $2, $3)`, p, f.orgA.id, b), why)
        .rejects.toThrow(/DrawingHubLink_createdBy_present/);
      await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'e', 'applied')`, f.orgA.id, b), why)
        .rejects.toThrow(/HubWebhookReceipt_webhookId_present/);
      await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, $3, 'applied')`, f.orgA.id, `wh5-${run}`, b), why)
        .rejects.toThrow(/HubWebhookReceipt_eventType_present/);
      await expect(raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId") VALUES ($1, $2, 'f')`, p, b), why)
        .rejects.toThrow(/HubVersionTombstone_hubVersionId_present/);
      await expect(raw(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId") VALUES ($1, 'v', $2)`, p, b), why)
        .rejects.toThrow(/HubVersionTombstone_hubFileId_present/);
      await expect(raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ($1, $2, $3, $4)`, `b5-${run}`, `${p}/drawings/hub/k`, p, b), why)
        .rejects.toThrow(/HubFetchedBlob_hubVersionId_present/);
    }
    for (const outcome of ['apply', 'Applied', 'done', '']) {
      await expect(raw(`INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome") VALUES ($1, $2, 'e', $3)`, f.orgA.id, `wh5o-${run}`, outcome), outcome)
        .rejects.toThrow(/HubWebhookReceipt_outcome_known/);
    }
    // a ledger key names a Hub object of its own project: not another project's, not a PMC upload, not the bare prefix,
    // and the project id is matched exactly (no LIKE wildcards)
    const wild = await project('r5_%');
    const keys = [
      `${q}/drawings/hub/x`, `${p}/drawings/x`, `${p}/progress/x.jpg`, `${p}/drawings/hub/`, `${p}/drawings/hubx`, `x/${p}/drawings/hub/x`, '',
      `${wild.replace('_%', 'ab')}/drawings/hub/x`, `${p.toUpperCase()}/drawings/hub/x`,
    ];
    for (const key of keys) {
      const projectId = key.startsWith(wild.replace('_%', 'ab')) ? wild : p;
      await expect(raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ($1, $2, $3, 'v')`, `b5k-${run}`, key, projectId), key)
        .rejects.toThrow(/HubFetchedBlob_storageKey_in_project/);
    }
    await raw(`INSERT INTO "HubFetchedBlob" ("id", "storageKey", "projectId", "hubVersionId") VALUES ($1, $2, $3, 'v')`, `b5w-${run}`, `${wild}/drawings/hub/x.pdf`, wild);
    await t.prisma.hubFetchedBlob.create({ data: { storageKey: `${p}/drawings/hub/3f2a.pdf`, projectId: p, hubVersionId: 'v' } });
  });

  it('R3: the sanctioned reset lifts every Hub TRUNCATE seal by name and puts it back', async () => {
    for (const table of SEALED) {
      const seals = await t.prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT tgname::text AS name FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 32) <> 0`, `"${table}"`);
      expect(seals.map((x) => x.name), table).toEqual([`${table}_no_truncate`]);
      expect(TRUNCATE_SEALS).toContainEqual({ table, trigger: `${table}_no_truncate` });
    }
    await sanctionedReset(t.prisma, [...SEALED]);
    for (const table of SEALED) {
      expect(await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}"`), table).toEqual([{ n: 0n }]);
    }
    const states = await t.prisma.$queryRawUnsafe<Array<{ enabled: string }>>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = ANY($1::text[])`, SEALED.map((s) => `${s}_no_truncate`));
    expect(states.map((x) => x.enabled)).toEqual(['O', 'O', 'O', 'O']);
  });

  it('re-runs: a second and third run of the file leave the same keys, checks, triggers and functions', async () => {
    const tables = [...SEALED, 'HubFetchedBlob'];
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ kind: string; name: string; def: string }>>(`
      SELECT 'index' AS kind, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'function', p.proname, array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('drawings_hub_record_sealed', 'drawings_hub_record_no_truncate')
      ORDER BY 1, 2`, tables, tables.map((x) => `"${x}"`));
    const before = await shape();
    expect(before.filter((r) => r.kind === 'trigger')).toHaveLength(9);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('CHECK'))).toHaveLength(12);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('FOREIGN KEY'))).toHaveLength(6);
    expect(before.filter((r) => r.kind === 'function').map((r) => r.def)).toEqual(Array(2).fill('search_path=pg_catalog, public, pg_temp'));
    replay();
    replay();
    expect(await shape()).toEqual(before);
  });
});
