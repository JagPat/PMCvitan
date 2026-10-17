import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { buildPaths, inventoryProject, readOnlyTransaction, writeInventoryExport } from '../../src/platform/project-inventory';

/**
 * #482 — the inventory Board runs before removing the archived QA project. It must find every table
 * that can hold the project's id, count the target's rows, list the users pointing at it, its storage
 * keys and the delete triggers it would meet, count and hash every project for the before/after
 * proof, read no row into JavaScript, and be unable to change anything.
 */
describe('project:inventory — read-only project inventory (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = Math.random().toString(36).slice(2, 8);
  const logId = `it-inv-log-${run}`;
  const drawingId = `it-inv-dwg-${run}`;
  const revisionId = `it-inv-rev-${run}`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.media.create({
      data: { id: `it-media-${f.projectA.id}`, projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc' },
    });
    await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: 'Zone', kind: 'zone' } });
    // a contained row: a crew row belongs to its daily log and has no project column of its own
    await t.prisma.dailyLog.create({ data: { id: logId, projectId: f.projectA.id, date: '01 Jun 2026', logDate: new Date('2026-06-01') } });
    await t.prisma.crewRow.create({ data: { dailyLogId: logId, trade: 'Mason', count: 4, order: 0 } });
    // a drawing file held in object storage, not in Media
    await t.prisma.drawing.create({ data: { id: drawingId, projectId: f.projectA.id, number: 'A-1', title: 'Plan', discipline: 'architectural' } });
    await t.prisma.drawingRevision.create({
      data: { id: revisionId, drawingId, projectId: f.projectA.id, rev: 'A', status: 'issued', mime: 'application/pdf', issuedBy: 'pmc', issuedAt: '01 Jun 2026', storageKey: 'drawings/a-1-a.pdf' },
    });
    // the other tenant's user last used project A: the pointer must be listed
    await t.prisma.user.update({ where: { id: f.otherUser.id }, data: { lastProjectId: f.projectA.id } });
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.crewRow.deleteMany({ where: { dailyLogId: logId } });
    await t?.prisma.dailyLog.deleteMany({ where: { id: logId } });
    await t?.prisma.drawingRevision.deleteMany({ where: { id: revisionId } });
    await t?.prisma.drawing.deleteMany({ where: { id: drawingId } });
    await f?.cleanup();
    await t?.close();
  });

  it('finds the project paths from the catalog: direct columns, keys not named projectId, and contained tables', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const cols = inv.paths.map((p) => p.key);
    expect(cols.length).toBeGreaterThan(100);
    for (const c of ['DomainEvent.projectId', 'OutboxDelivery.projectId', 'Membership.projectId', 'Media.projectId', 'Notification.projectId', 'AuditLog.projectId', 'User.projectId', 'User.lastProjectId']) {
      expect(cols, c).toContain(c);
    }
    expect(new Set(cols).size, 'no path listed twice').toBe(cols.length);
    expect(cols, 'a crew row is reached through its daily log').toContain('CrewRow.(dailyLogId)->DailyLog');
    expect(inv.paths.some((p) => p.via?.parent === 'User'), 'a user is never followed to its children').toBe(false);
  });

  it("counts the target's rows and lists its user pointers and storage keys, with no row read out", async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(inv.readOnlyVerified).toBe(true);
    expect(inv.project).toEqual({ id: f.projectA.id, name: expect.any(String), orgId: expect.any(String), archivedAt: null });
    expect(inv.counts['Membership.projectId']).toBe(2);
    expect(inv.counts['Media.projectId']).toBe(1);
    expect(inv.counts['ProjectNode.projectId']).toBe(1);
    expect(inv.counts['CrewRow.(dailyLogId)->DailyLog'], 'the contained crew row is counted').toBe(1);
    expect(inv, 'no row values are carried, so none can be rounded').not.toHaveProperty('rows');
    expect(inv.files).toEqual(expect.arrayContaining([
      { table: 'Media', id: `it-media-${f.projectA.id}`, storageKey: null, url: null, bytesInDatabase: true },
      { table: 'DrawingRevision', id: revisionId, storageKey: 'drawings/a-1-a.pdf', url: null, bytesInDatabase: false },
    ]));
    const pointers = inv.userPointers.map((u) => u.id);
    expect(pointers).toEqual(expect.arrayContaining([f.memberUser.id, f.otherUser.id]));
    expect(inv.userPointers.find((u) => u.id === f.otherUser.id)).toMatchObject({ projectId: f.projectB.id, lastProjectId: f.projectA.id });
  });

  it("records every project's count and key hash, so a swapped row shows even when the count holds", async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(inv.byProject[f.projectA.id]['Membership.projectId'].rows).toBe(2);
    expect(inv.byProject[f.projectA.id]['CrewRow.(dailyLogId)->DailyLog'].rows).toBe(1);
    expect(inv.byProject[f.projectB.id]['Membership.projectId'].rows).toBe(1);
    expect(inv.byProject[f.projectB.id]).not.toHaveProperty('Media.projectId');
    // same count, different row: the identity hash changes
    const before = inv.byProject[f.projectA.id]['ProjectNode.projectId'];
    const node = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Zone' } });
    await t.prisma.projectNode.delete({ where: { id: node.id } });
    await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: 'Zone', kind: 'zone' } });
    const after = (await inventoryProject(t.prisma, f.projectA.id)).byProject[f.projectA.id]['ProjectNode.projectId'];
    expect(after.rows).toBe(before.rows);
    expect(after.identity).not.toBe(before.identity);
  });

  it('follows contained tables however deep the chain goes, and stops on a cycle', () => {
    // T0 holds the project id; T1..T12 each hang under the one before; T12 points back at T3
    const edges = Array.from({ length: 12 }, (_, i) => ({ child: `T${i + 1}`, columns: ['parentId'], parent: `T${i}`, parentColumns: ['id'] }));
    edges.push({ child: 'T3', columns: ['loopId'], parent: 'T12', parentColumns: ['id'] });
    const paths = buildPaths({ direct: [{ table: 'T0', column: 'projectId' }], edges });
    expect(paths.map((p) => p.table)).toEqual(Array.from({ length: 13 }, (_, i) => `T${i}`));
  });

  it('gives different key sets different identities even when the keys contain commas', async () => {
    const nodes = async () => (await inventoryProject(t.prisma, f.projectA.id)).byProject[f.projectA.id]['ProjectNode.projectId'];
    const make = (ids: string[]) => t.prisma.projectNode.createMany({ data: ids.map((id) => ({ id, projectId: f.projectA.id, name: id, kind: 'zone' })) });
    const drop = (ids: string[]) => t.prisma.projectNode.deleteMany({ where: { id: { in: ids } } });
    // joined with commas, both sets read "zz-a,zz-b,zz-c"
    const one = [`zz-a-${run}`, `zz-b-${run},zz-c-${run}`];
    const two = [`zz-a-${run},zz-b-${run}`, `zz-c-${run}`];
    await make(one);
    const first = await nodes();
    await drop(one);
    await make(two);
    const second = await nodes();
    await drop(two);
    expect(second.rows).toBe(first.rows);
    expect(second.identity).not.toBe(first.identity);
  });

  it('writes the export owner-only and whole, never over an existing file, and refuses a missing project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const out = join(dir, 'a.json');
    writeInventoryExport(inv, out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, 'utf8')).projectId).toBe(f.projectA.id);
    // an existing file is never replaced, and the temporary file is cleaned up
    const taken = join(dir, 'taken.json');
    writeFileSync(taken, 'keep');
    expect(() => writeInventoryExport(inv, taken)).toThrow(/EEXIST/);
    expect(readFileSync(taken, 'utf8')).toBe('keep');
    // a write that fails part-way (here: the destination directory is missing) leaves nothing behind
    expect(() => writeInventoryExport(inv, join(dir, 'missing', 'c.json'))).toThrow();
    const missing = await inventoryProject(t.prisma, 'no-such-project');
    expect(() => writeInventoryExport(missing, join(dir, 'b.json'))).toThrow(/does not exist/);
    expect(readdirSync(dir).sort(), 'only the finished export and the pre-existing file').toEqual(['a.json', 'taken.json']);
  });

  it("keeps every project's own row in the proof, including a new one whose id is __proto__", async () => {
    const { orgId } = await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id }, select: { orgId: true } });
    const bare = { ...await t.prisma.project.findUniqueOrThrow({ where: { id: f.projectA.id } }), id: '__proto__', siteCode: `PROTO${run}`, orgId };
    await t.prisma.project.deleteMany({ where: { id: '__proto__' } });
    await t.prisma.project.create({ data: bare });
    try {
      const inv = await inventoryProject(t.prisma, f.projectA.id);
      const all = (await t.prisma.project.findMany({ select: { id: true } })).map((p) => p.id).sort();
      expect(Object.keys(inv.byProject).filter((id) => inv.byProject[id]['Project.id']).sort(), 'every project row is in the proof').toEqual(all);
      expect(Object.hasOwn(inv.byProject, '__proto__'), 'a database id is an entry, not the prototype').toBe(true);
      expect(inv.byProject.__proto__['Project.id']).toEqual({ rows: 1, identity: expect.any(String) });
      expect(JSON.parse(JSON.stringify(inv)).byProject.__proto__['Project.id'].rows, 'and it survives the export').toBe(1);
      expect(inv.counts, "the target's own row is not one of its table counts").not.toHaveProperty('Project.id');
    } finally {
      await t.prisma.project.deleteMany({ where: { id: '__proto__' } });
    }
  });

  it('follows a reference kept without a foreign key, and names every table no path reaches', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const reached = new Set(['Project', ...inv.paths.map((p) => p.table)]);
    expect(inv.paths.map((p) => p.key), 'a transition row is reached through its decision').toContain('_t4d_tx_transition.(decisionId)->Decision');
    const unlinked = inv.unlinked.map((u) => u.table);
    expect(unlinked).not.toContain('_t4d_tx_transition');
    expect(unlinked.filter((u) => reached.has(u)), 'a reached table is not also listed as unlinked').toEqual([]);
    const tables = (await t.prisma.$queryRawUnsafe<Array<{ table: string }>>(
      `SELECT c.relname::text AS "table" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition`)).map((r) => r.table);
    expect(tables.filter((tb) => !reached.has(tb) && !unlinked.includes(tb)), 'every table is either reached or listed').toEqual([]);
    const org = inv.unlinked.find((u) => u.table === 'Org');
    expect(org?.rows, 'an unlinked table carries its row count').toBeGreaterThanOrEqual(2);
  });

  it('runs on one repeatable-read snapshot, changes nothing, and a write inside it is refused', async () => {
    const [{ iso }] = await readOnlyTransaction(t.prisma, (tx) =>
      tx.$queryRawUnsafe<Array<{ iso: string }>>("SELECT current_setting('transaction_isolation') AS iso"));
    expect(iso).toBe('repeatable read');
    const before = (await inventoryProject(t.prisma, f.projectA.id)).byProject;
    await expect(readOnlyTransaction(t.prisma, (tx) =>
      tx.projectNode.create({ data: { projectId: f.projectA.id, name: 'should not exist', kind: 'zone' } }),
    )).rejects.toThrow(/read-only transaction/);
    const after = (await inventoryProject(t.prisma, f.projectA.id)).byProject;
    expect(after).toEqual(before);
    expect(await t.prisma.projectNode.count({ where: { projectId: f.projectA.id, name: 'should not exist' } })).toBe(0);
  });

  it('reports an unknown project as not found, and refuses an empty id', async () => {
    const inv = await inventoryProject(t.prisma, 'no-such-project');
    expect(inv.project).toBeNull();
    expect(inv.counts).toEqual({});
    await expect(inventoryProject(t.prisma, ' ')).rejects.toThrow(/project id is required/);
  });
});
