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
 * #1118 U1a-2 — a project's Hub link and its history (`20280121300000_hub_link`), against live PostgreSQL. It proves what
 * the database holds on every writer (L1-L6 in the migration): the keys, the owners, that both are sealed and go only
 * with their project, that the history is a chain by its keys and checks alone, that a link commits only with its event 1,
 * and that the file re-runs and changes nothing.
 *
 * Every event here names a user this file makes, homed on a project of its own that holds no Hub rows ("home"). An event
 * names its actor through a NO ACTION key and goes only with its project, while a user goes before its home project
 * (`User.projectId` has no cascade): so the projects that hold events go first, then the actors, then their home. The
 * shared fixture's users never act here, and its cleanup runs unchanged.
 *
 * Isolated automated-test fixtures only.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280121300000_hub_link/migration.sql');
const SEALED = ['DrawingHubLink', 'DrawingHubLinkEvent'] as const;

describe('#1118 U1a-2 — the Hub link and its history (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];
  const home = `it-hubl-home-${run}`;
  const actors: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.project.create({ data: {
      id: home, orgId: f.orgA.id, name: home, short: 'Home', descriptor: '', stage: 'x', siteCode: 'HOM', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    for (const n of [1, 2, 3, 4]) {
      const u = await t.prisma.user.create({ data: { email: `hubl.actor${n}.${run}@test.local`, name: `Hub actor ${n}`, role: 'pmc', projectId: home } });
      actors.push(u.id);
    }
  });

  afterAll(async () => {
    if (!t) return;
    try {
      // the projects holding events first (their cascade takes the link and its history), then the actors, then home
      for (const id of made) await raw(`DELETE FROM "Project" WHERE "id" = $1`, id);
      await t.prisma.user.deleteMany({ where: { id: { in: actors } } });
      await raw(`DELETE FROM "Project" WHERE "id" = $1`, home);
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = (file = MIGRATION) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', file], { stdio: 'pipe' });
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** Subscribe at once (Prisma is lazy) and never reject. */
  const settle = <T>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e: String(e) }));
  const until = async (probe: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier not reached: ${what}`);
  };
  // a project of its own per test, so its records and its delete stay out of the fixture's projects
  const project = async (tag: string, orgId = f.orgA.id) => {
    const id = `it-hubl-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  const linkSql = (projectId: string, orgId = f.orgA.id) => raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId") VALUES ($1, $2)`, projectId, orgId);
  const event = (projectId: string, seq: number, prevSeq: number | null, kind: string, hubProjectId: string | null, by = actors[0]!) =>
    raw(`INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "byUserId") VALUES ($1, $2, $3, $4, $5, $6)`, projectId, seq, prevSeq, kind, hubProjectId, by);
  /** U7's link: the link and its event 1, one transaction (L5). */
  const link = (projectId: string, hubProjectId = 'hp', by = actors[0]!, orgId = f.orgA.id) =>
    t.prisma.$transaction([linkSql(projectId, orgId), event(projectId, 1, null, 'linked', hubProjectId, by)]);
  /** A link whose event 1 is refused: the transaction fails on the event, and nothing of it stays. */
  const linkWith = (projectId: string, seq: number, prevSeq: number | null, kind: string, hubProjectId: string | null, by = actors[0]!) =>
    t.prisma.$transaction([linkSql(projectId), event(projectId, seq, prevSeq, kind, hubProjectId, by)]);

  it('L1/L2: one link per project and one event per seq, each owned by a project that exists, a link\'s org its project\'s own', async () => {
    const p = await project('l12');
    await link(p);
    await expect(linkSql(p)).rejects.toThrow(/23505/);
    await expect(event(p, 1, null, 'linked', 'hp')).rejects.toThrow(/23505/);

    const q = await project('l12b');
    await expect(linkSql(q, f.orgB.id)).rejects.toThrow(/DrawingHubLink_orgId_projectId_fkey/);
    await expect(event(q, 1, null, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_projectId_fkey/);
    await expect(raw(`INSERT INTO "DrawingHubLink" ("projectId", "orgId") VALUES ('no-such-project', $1)`, f.orgA.id)).rejects.toThrow(/DrawingHubLink_orgId_projectId_fkey/);
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: q } })).toBe(0);
  });

  it('L3: a link and an event are never changed, deleted or truncated on their own; each goes with its project', async () => {
    const p = await project('l3');
    const other = await project('l3o');
    await link(p);

    const updates: Array<[string, string]> = [
      ['DrawingHubLink', `"projectId" = '${other}'`], ['DrawingHubLink', `"orgId" = '${f.orgB.id}'`], ['DrawingHubLink', `"orgId" = "orgId"`],
      ['DrawingHubLinkEvent', `"hubProjectId" = 'hp2'`], ['DrawingHubLinkEvent', `"byUserId" = '${actors[1]}'`], ['DrawingHubLinkEvent', `"at" = now()`],
      ['DrawingHubLinkEvent', `"seq" = 3, "prevSeq" = 2`], ['DrawingHubLinkEvent', `"projectId" = '${other}'`],
      // the same value is still a write, and still refused: a record is never rewritten
      ['DrawingHubLinkEvent', `"kind" = "kind"`],
    ];
    for (const [table, set] of updates) {
      await expect(raw(`UPDATE "${table}" SET ${set} WHERE "projectId" = $1`, p), `${table} ${set}`).rejects.toThrow(/is a record and is never changed/);
    }
    for (const table of ['DrawingHubLinkEvent', 'DrawingHubLink']) {
      await expect(raw(`DELETE FROM "${table}" WHERE "projectId" = $1`, p), table).rejects.toThrow(/never deleted; it goes only with its project/);
    }
    for (const table of SEALED) {
      await expect(raw(`TRUNCATE TABLE "${table}" CASCADE`), table).rejects.toThrow(/are records and are never truncated/);
    }
    // nothing moved
    expect(await t.prisma.drawingHubLink.findMany({ where: { projectId: p } })).toEqual([{ projectId: p, orgId: f.orgA.id }]);
    expect(await t.prisma.drawingHubLinkEvent.findMany({ where: { projectId: p } })).toEqual([expect.objectContaining({ seq: 1, kind: 'linked', hubProjectId: 'hp', byUserId: actors[0] })]);

    // the project's delete takes its link and its history
    await event(p, 2, 1, 'unlinked', null);
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, p);
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: p } })).toBe(0);
    expect(await t.prisma.drawingHubLinkEvent.count({ where: { projectId: p } })).toBe(0);
  });

  it('L4/L6: the history is a chain: event 1 links, links and unlinks alternate, each names the one before it, a link names its Hub project', async () => {
    const p = await project('l4');
    // event 1 is a link with no previous event
    await expect(linkWith(p, 1, null, 'unlinked', null)).rejects.toThrow(/DrawingHubLinkEvent_kind_alternates/);
    await expect(linkWith(p, 1, 0, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(linkWith(p, 0, null, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(linkWith(p, -1, null, 'linked', 'hp')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    // a later event needs the one before it, in the same project
    await expect(linkWith(p, 2, 1, 'unlinked', null)).rejects.toThrow(/DrawingHubLinkEvent_projectId_prevSeq_fkey/);
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: p } })).toBe(0);
    await link(p, 'hp-a');
    // no gap, no second link or unlink in a row, no event without its previous one
    await expect(event(p, 3, 1, 'linked', 'hp-b')).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(event(p, 3, 2, 'linked', 'hp-b')).rejects.toThrow(/DrawingHubLinkEvent_projectId_prevSeq_fkey/);
    await expect(event(p, 2, null, 'unlinked', null)).rejects.toThrow(/DrawingHubLinkEvent_chain/);
    await expect(event(p, 2, 1, 'linked', 'hp-b')).rejects.toThrow(/DrawingHubLinkEvent_kind_alternates/);
    // an unlink names no Hub project; a link always names one (L6: more than whitespace)
    await expect(event(p, 2, 1, 'unlinked', 'hp-a')).rejects.toThrow(/DrawingHubLinkEvent_hubProjectId_on_link/);
    for (const b of [null, '', ' ', '\t', ' \n\r\f\v ']) {
      const q = await project(`l4b${made.length}`);
      await expect(linkWith(q, 1, null, 'linked', b), JSON.stringify(b)).rejects.toThrow(/DrawingHubLinkEvent_hubProjectId_on_link/);
    }
    // the actor is a real user: a name, a blank or an unknown id is refused, and a user with history is never deleted
    for (const b of ['it', '', ' ', `no-such-user-${run}`]) {
      await expect(event(p, 2, 1, 'unlinked', null, b), JSON.stringify(b)).rejects.toThrow(/DrawingHubLinkEvent_byUserId_fkey/);
    }
    const actor = await t.prisma.user.create({ data: { email: `hubl.actor.del.${run}@test.local`, name: 'Hub actor', role: 'pmc', projectId: home } });
    const q2 = await project('l4u');
    await link(q2, 'hp', actor.id);
    await expect(raw(`DELETE FROM "User" WHERE "id" = $1`, actor.id)).rejects.toThrow(/DrawingHubLinkEvent_byUserId_fkey/);
    await raw(`DELETE FROM "Project" WHERE "id" = $1`, q2);
    expect(await raw(`DELETE FROM "User" WHERE "id" = $1`, actor.id)).toBe(1);
    await expect(event(p, 2, 1, 'paused', null)).rejects.toThrow(/DrawingHubLinkEvent_(kind_alternates|hubProjectId_on_link)/);
    // U7's order: link, unlink, then relink (to another Hub project too); each is its own attributed record
    await event(p, 2, 1, 'unlinked', null, actors[1]);
    // two writers that read the same head race for the next event: both insert event 3 from it, the second waits on
    // the first's key entry, and when the first commits the second is refused; exactly one event 3 stands
    const readA = gate(), readB = gate(), insertedA = gate(), commitA = gate();
    let pidA = 0;
    const head = async (tx: Pick<typeof t.prisma, '$queryRawUnsafe'>) =>
      Number((await tx.$queryRawUnsafe<Array<{ head: number }>>(`SELECT max("seq")::int AS head FROM "DrawingHubLinkEvent" WHERE "projectId" = $1`, p))[0]!.head);
    const next = `INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "byUserId") VALUES ($1, $2, $3, 'linked', $4, $5)`;
    const txOptions = { maxWait: 10_000, timeout: 30_000 };
    const a = settle(t.prisma.$transaction(async (tx) => {
      pidA = Number((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      const h = await head(tx);
      readA.open();
      await readB.p;
      await tx.$executeRawUnsafe(next, p, h + 1, h, 'hp-b', actors[2]);
      insertedA.open();
      await commitA.p;
    }, txOptions));
    const b = settle(t.prisma.$transaction(async (tx) => {
      await readA.p;
      const h = await head(tx);
      readB.open();
      await insertedA.p;
      await tx.$executeRawUnsafe(next, p, h + 1, h, 'hp-c', actors[3]);
    }, txOptions));
    await insertedA.p;
    await until(async () => (await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', pidA))[0]!.n > 0n, 'the second writer waits on the first');
    commitA.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ ok: true, v: undefined });
    expect(rb.ok).toBe(false);
    expect(rb.ok ? '' : rb.e).toMatch(/23505/);
    const history = await t.prisma.drawingHubLinkEvent.findMany({ where: { projectId: p }, orderBy: { seq: 'asc' } });
    expect(history.map((e) => [e.seq, e.prevSeq, e.kind, e.hubProjectId, e.byUserId])).toEqual([
      [1, null, 'linked', 'hp-a', actors[0]], [2, 1, 'unlinked', null, actors[1]], [3, 2, 'linked', 'hp-b', actors[2]],
    ]);
    // the active link is the latest event when it is a link
    const active = (projectId: string) => t.prisma.$queryRawUnsafe<Array<{ hubProjectId: string | null }>>(
      `SELECT "hubProjectId" FROM "DrawingHubLinkEvent" WHERE "projectId" = $1 ORDER BY "seq" DESC LIMIT 1`, projectId);
    expect(await active(p)).toEqual([{ hubProjectId: 'hp-b' }]);
  });

  it('L5: a link commits only with its event 1 (#1139 r4385819929)', async () => {
    const constraint = /DrawingHubLink_first_event|has no first event/;
    // a link alone is refused at commit, and nothing of it stays
    const p = await project('l5');
    await expect(linkSql(p)).rejects.toThrow(constraint);
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: p } })).toBe(0);
    // asking for the check at once, before event 1 is written, is refused too
    await expect(t.prisma.$transaction([raw(`SET CONSTRAINTS "DrawingHubLink_first_event" IMMEDIATE`), linkSql(p)])).rejects.toThrow(constraint);
    await expect(t.prisma.$transaction([raw(`SET CONSTRAINTS ALL IMMEDIATE`), linkSql(p)])).rejects.toThrow(constraint);
    // another project's event 1 does not stand in for this one's, and the whole transaction goes
    const q = await project('l5q');
    await expect(t.prisma.$transaction([linkSql(p), linkSql(q), event(q, 1, null, 'linked', 'hp')])).rejects.toThrow(constraint);
    expect(await t.prisma.drawingHubLink.count({ where: { projectId: { in: [p, q] } } })).toBe(0);
    expect(await t.prisma.drawingHubLinkEvent.count({ where: { projectId: q } })).toBe(0);
    // the link and its event 1 in one transaction commit, in either order of the check: deferred, or at once after both
    await link(p);
    await t.prisma.$transaction([linkSql(q), event(q, 1, null, 'linked', 'hp'), raw(`SET CONSTRAINTS ALL IMMEDIATE`)]);
    const firsts = await t.prisma.drawingHubLinkEvent.findMany({ where: { projectId: { in: [p, q] } }, select: { projectId: true, seq: true } });
    expect(firsts).toHaveLength(2);
    expect(firsts).toEqual(expect.arrayContaining([{ projectId: p, seq: 1 }, { projectId: q, seq: 1 }]));
    // Prisma's own create, with the event in the same transaction, is the writer U7 will use
    const r = await project('l5r');
    await t.prisma.$transaction([
      t.prisma.drawingHubLink.create({ data: { projectId: r, orgId: f.orgA.id } }),
      t.prisma.drawingHubLinkEvent.create({ data: { projectId: r, seq: 1, kind: 'linked', hubProjectId: 'hp', byUserId: actors[0]! } }),
    ]);
    await expect(t.prisma.drawingHubLink.create({ data: { projectId: (await project('l5s')), orgId: f.orgA.id } })).rejects.toThrow(constraint);
  });

  it('L3: the sanctioned reset lifts both TRUNCATE seals by name and puts them back', async () => {
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
    expect(states.map((x) => x.enabled)).toEqual(['O', 'O']);
  });

  it('re-runs: a second and third run of the file leave the same keys, checks, triggers and functions', async () => {
    const tables = [...SEALED];
    const shape = async () => t.prisma.$queryRawUnsafe<Array<{ kind: string; name: string; def: string }>>(`
      SELECT 'index' AS kind, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      UNION ALL
      SELECT 'constraint', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($2::text[])
      UNION ALL
      SELECT 'function', p.proname, array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('drawings_hub_record_sealed', 'drawings_hub_record_no_truncate', 'drawings_hub_link_has_first_event')
      ORDER BY 1, 2`, tables, tables.map((x) => `"${x}"`));
    const before = await shape();
    expect(before.filter((r) => r.kind === 'trigger').map((r) => r.name).sort()).toEqual([
      'DrawingHubLinkEvent_no_truncate', 'DrawingHubLinkEvent_sealed', 'DrawingHubLink_first_event', 'DrawingHubLink_no_truncate', 'DrawingHubLink_sealed',
    ].sort());
    expect(before.find((r) => r.name === 'DrawingHubLink_first_event' && r.kind === 'trigger')?.def).toMatch(/CONSTRAINT TRIGGER .* AFTER INSERT .* DEFERRABLE INITIALLY DEFERRED/);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('CHECK'))).toHaveLength(3);
    expect(before.filter((r) => r.kind === 'constraint' && r.def.startsWith('FOREIGN KEY'))).toHaveLength(4);
    expect(before.filter((r) => r.kind === 'function').map((r) => r.def)).toEqual(Array(3).fill('search_path=pg_catalog, public, pg_temp'));
    replay();
    replay();
    expect(await shape()).toEqual(before);
    // one transaction: a run that fails at its last statement leaves nothing of itself, its dropped triggers and
    // checks included
    const dir = mkdtempSync(join(tmpdir(), 'hub-link-'));
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
