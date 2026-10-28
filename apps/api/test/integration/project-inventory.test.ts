import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, statSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, insertRawEvent, type TwoProjectFixture } from './fixtures';
import { buildPaths, inventoryProject, readOnlyTransaction, writeInventoryExport } from '../../src/platform/project-inventory';
import { snapshotDatabase } from '../../src/platform/db-snapshot';

/**
 * #482 — B2, the itemised list the removal of the archived QA project is checked against. It must
 * find every table that can hold the project's rows, list each row by the key `db:snapshot`
 * records, follow references kept without a foreign key, list the users pointing at the project and
 * its stored files, name every table no path reaches, and be unable to change anything.
 */
describe('project:inventory — the itemised list of one project (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = Math.random().toString(36).slice(2, 8);
  const logId = `it-inv-log-${run}`;
  const drawingId = `it-inv-dwg-${run}`;
  const revisionId = `it-inv-rev-${run}`;
  const eventId = randomUUID();
  const receipt = `it-inv-receipt-${run}`;
  let nodeKey = '';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.media.create({
      data: { id: `it-media-${f.projectA.id}`, projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc' },
    });
    // #995 — a video names two stored files, its clip and its still frame; a video without a still frame names one
    await t.prisma.media.create({
      data: { id: `it-video-${f.projectA.id}`, projectId: f.projectA.id, kind: 'progress', mime: 'video/mp4', sizeBytes: 3, uploadedBy: 'pmc',
        durationSec: 12, storageKey: 'site/clip.mp4', posterStorageKey: 'site/clip-poster.jpg' },
    });
    await t.prisma.media.create({
      data: { id: `it-video-bare-${f.projectA.id}`, projectId: f.projectA.id, kind: 'progress', mime: 'video/webm', sizeBytes: 3, uploadedBy: 'pmc',
        durationSec: 5, storageKey: 'site/bare.webm' },
    });
    const node = await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: 'Zone', kind: 'zone' } });
    nodeKey = JSON.stringify([node.id]);
    // a contained row: a crew row belongs to its daily log and has no project column of its own
    await t.prisma.dailyLog.create({ data: { id: logId, projectId: f.projectA.id, date: '01 Jun 2026', logDate: new Date('2026-06-01') } });
    await t.prisma.crewRow.create({ data: { dailyLogId: logId, trade: 'Mason', count: 4, order: 0 } });
    // a drawing file held in object storage, not in Media
    await t.prisma.drawing.create({ data: { id: drawingId, projectId: f.projectA.id, number: 'A-1', title: 'Plan', discipline: 'architectural' } });
    await t.prisma.drawingRevision.create({
      data: { id: revisionId, drawingId, projectId: f.projectA.id, rev: 'A', status: 'issued', mime: 'application/pdf', issuedBy: 'pmc', issuedAt: '01 Jun 2026', storageKey: 'drawings/a-1-a.pdf' },
    });
    // a consumer's receipt names project A's event by id alone, with no foreign key
    await insertRawEvent(t.prisma, { projectId: f.projectA.id, organizationId: f.orgA.id, eventId });
    await t.prisma.processedEvent.create({ data: { id: receipt, consumer: 'it-inventory', eventId } });
    // the other tenant's user last used project A: the pointer must be listed
    await t.prisma.user.update({ where: { id: f.otherUser.id }, data: { lastProjectId: f.projectA.id } });
  });

  afterAll(async () => {
    await t?.prisma.processedEvent.deleteMany({ where: { id: receipt } });
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.crewRow.deleteMany({ where: { dailyLogId: logId } });
    await t?.prisma.dailyLog.deleteMany({ where: { id: logId } });
    await t?.prisma.drawingRevision.deleteMany({ where: { id: revisionId } });
    await t?.prisma.drawing.deleteMany({ where: { id: drawingId } });
    await t?.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  it('finds the project paths from the catalog: direct columns, keys not named projectId, contained tables and hand-listed references', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const cols = inv.paths.map((p) => p.key);
    expect(cols.length).toBeGreaterThan(100);
    for (const c of ['DomainEvent.projectId', 'OutboxDelivery.projectId', 'Membership.projectId', 'Media.projectId', 'Notification.projectId', 'AuditLog.projectId', 'User.projectId', 'User.lastProjectId']) {
      expect(cols, c).toContain(c);
    }
    expect(new Set(cols).size, 'no path listed twice').toBe(cols.length);
    expect(cols, 'a crew row is reached through its daily log').toContain('CrewRow.(dailyLogId)->DailyLog');
    expect(cols, 'a receipt is reached through the event it names').toContain('ProcessedEvent.(eventId)->DomainEvent');
    expect(cols, 'a decision transition is reached through its decision').toContain('_t4d_tx_transition.(decisionId)->Decision');
    expect(inv.paths.some((p) => p.via?.parent === 'User'), 'a user is never followed to its children').toBe(false);
    expect(inv.unlinked.map((u) => u.table), 'a reached table is not listed as unreached').not.toContain('ProcessedEvent');
  });

  it("lists the project's rows by key, table by table, and no other project's", async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(inv.readOnlyVerified).toBe(true);
    expect(inv.schema).toBe('public');
    expect(inv.project).toEqual({ id: f.projectA.id, name: expect.any(String), orgId: expect.any(String), archivedAt: null });
    expect(inv.keys.Project).toEqual([JSON.stringify([f.projectA.id])]);
    expect(inv.keys.ProjectNode).toEqual([nodeKey]);
    expect(inv.counts.Membership).toBe(inv.keys.Membership.length);
    expect(inv.keys.CrewRow, 'the contained crew row is listed').toHaveLength(1);
    expect(inv.keys.DomainEvent).toContain(JSON.stringify([eventId]));
    expect(inv.keys.ProcessedEvent, 'the receipt with no foreign key is listed').toEqual([JSON.stringify([receipt])]);
    const other = await inventoryProject(t.prisma, f.projectB.id);
    expect(other.keys.Project).toEqual([JSON.stringify([f.projectB.id])]);
    expect(other.keys.ProjectNode ?? [], "project B lists none of A's nodes").not.toContain(nodeKey);
    expect(other.keys.ProcessedEvent ?? []).not.toContain(JSON.stringify([receipt]));
  });

  it('lists every key exactly as db:snapshot records it, so the removal run can check one against the other', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const snap = await snapshotDatabase(t.prisma);
    for (const [table, keys] of Object.entries(inv.keys)) {
      const all = new Set(snap.tables[table].keys);
      expect(keys.filter((k) => !all.has(k)), table).toEqual([]);
    }
  });

  it('lists the users pointing at the project and its stored files', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(inv.files).toEqual(expect.arrayContaining([
      { table: 'Media', id: `it-media-${f.projectA.id}`, column: 'storageKey', storageKey: null, url: null, bytesInDatabase: true },
      { table: 'DrawingRevision', id: revisionId, column: 'storageKey', storageKey: 'drawings/a-1-a.pdf', url: null, bytesInDatabase: false },
    ]));
    expect(inv.userPointers.map((u) => u.id)).toEqual(expect.arrayContaining([f.memberUser.id, f.otherUser.id]));
    expect(inv.userPointers.find((u) => u.id === f.otherUser.id))
      .toMatchObject({ key: JSON.stringify([f.otherUser.id]), projectId: f.projectB.id, lastProjectId: f.projectA.id });
  });

  it("lists a video's still frame as a stored file of its own, and only where the video has one (#995)", async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const video = `it-video-${f.projectA.id}`;
    const bare = `it-video-bare-${f.projectA.id}`;
    expect(inv.files).toEqual(expect.arrayContaining([
      { table: 'Media', id: video, column: 'storageKey', storageKey: 'site/clip.mp4', url: null, bytesInDatabase: false },
      { table: 'Media', id: video, column: 'posterStorageKey', storageKey: 'site/clip-poster.jpg', url: null, bytesInDatabase: false },
      { table: 'Media', id: bare, column: 'storageKey', storageKey: 'site/bare.webm', url: null, bytesInDatabase: false },
    ]));
    expect(inv.files.filter((x) => x.column === 'posterStorageKey').map((x) => x.id), 'a null still frame is no file').toEqual([video]);
    const other = await inventoryProject(t.prisma, f.projectB.id);
    expect(other.files.map((x) => x.storageKey), "project B lists none of A's files").not.toContain('site/clip-poster.jpg');
  });

  it('follows contained tables however deep the chain goes, and stops on a cycle', () => {
    // T0 holds the project id; T1..T12 each hang under the one before; T12 points back at T3
    const edges = Array.from({ length: 12 }, (_, i) => ({ child: `T${i + 1}`, columns: ['parentId'], parent: `T${i}`, parentColumns: ['id'] }));
    edges.push({ child: 'T3', columns: ['loopId'], parent: 'T12', parentColumns: ['id'] });
    const paths = buildPaths({ direct: [{ table: 'T0', column: 'projectId' }], edges });
    expect(paths.map((p) => p.table)).toEqual(Array.from({ length: 13 }, (_, i) => `T${i}`));
  });

  it('cannot write: PostgreSQL refuses any change inside the run', async () => {
    await expect(readOnlyTransaction(t.prisma, (tx) =>
      tx.$executeRawUnsafe(`UPDATE "Project" SET name = name WHERE id = '${f.projectA.id}'`))).rejects.toThrow(/read-only/);
  });

  it('writes the file owner-only and whole, and nothing for a project that does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    const out = join(dir, 'a.json');
    writeInventoryExport(await inventoryProject(t.prisma, f.projectA.id), out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const missing = join(dir, 'missing.json');
    const none = await inventoryProject(t.prisma, `no-such-project-${run}`);
    expect(none.project).toBeNull();
    expect(() => writeInventoryExport(none, missing)).toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});
