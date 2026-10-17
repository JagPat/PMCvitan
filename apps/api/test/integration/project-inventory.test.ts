import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { buildPaths, inventoryProject, readOnlyTransaction, writeInventoryExport } from '../../src/platform/project-inventory';

/**
 * #482 — the inventory Board runs before removing the archived QA project. It must find every table
 * that can hold the project's id, export the target's rows (photo bytes as a length only), list the
 * users pointing at it and its storage keys, count every other project for the before/after proof,
 * and be unable to change anything.
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

  it("exports the target's rows, user pointers and storage keys, with photo bytes as a length only", async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(inv.readOnlyVerified).toBe(true);
    expect(inv.project?.id).toBe(f.projectA.id);
    expect(inv.counts['Membership.projectId']).toBe(2);
    expect(inv.counts['Media.projectId']).toBe(1);
    expect(inv.counts['ProjectNode.projectId']).toBe(1);
    const media = inv.rows['Media.projectId'][0];
    expect(media).not.toHaveProperty('data');
    expect(media.dataBytes).toBe(3);
    expect(media._table).toBe('Media');
    expect(inv.counts['CrewRow.(dailyLogId)->DailyLog'], 'the contained crew row is exported').toBe(1);
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
    expect(inv.rows['Membership.projectId'].every((r) => r.projectId === f.projectA.id), 'only the target is exported').toBe(true);
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

  it('keeps exact numbers exact: bigint and numeric are exported as strings', async () => {
    // beyond 2^53: as a JavaScript number this would round to ...992
    await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: f.memberUser.id }, data: { approvalLimit: '9007199254740993.01' } });
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const member = inv.rows['Membership.projectId'].find((r) => r.userId === f.memberUser.id)!;
    expect(member.approvalLimit).toBe('9007199254740993.01');
  });

  it('writes the export owner-only and never over an existing file, and refuses a missing project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const out = join(dir, 'a.json');
    writeInventoryExport(inv, out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, 'utf8')).projectId).toBe(f.projectA.id);
    expect(() => writeInventoryExport(inv, out), 'never overwritten').toThrow();
    const missing = await inventoryProject(t.prisma, 'no-such-project');
    expect(() => writeInventoryExport(missing, join(dir, 'b.json'))).toThrow(/does not exist/);
    expect(existsSync(join(dir, 'b.json')), 'nothing written').toBe(false);
  });

  it('names the delete triggers the target would meet', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(Object.keys(inv.deleteTriggers)).toContain('Project');
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
