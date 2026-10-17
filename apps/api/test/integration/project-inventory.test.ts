import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { inventoryProject, readOnlyTransaction } from '../../src/platform/project-inventory';

/**
 * #482 — the inventory Board runs before removing the archived QA project. It must find every table
 * that can hold the project's id, export the target's rows (photo bytes as a length only), list the
 * users pointing at it and its storage keys, count every other project for the before/after proof,
 * and be unable to change anything.
 */
describe('project:inventory — read-only project inventory (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.media.create({
      data: { id: `it-media-${f.projectA.id}`, projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: 'pmc' },
    });
    await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: 'Zone', kind: 'zone' } });
    // the other tenant's user last used project A: the pointer must be listed
    await t.prisma.user.update({ where: { id: f.otherUser.id }, data: { lastProjectId: f.projectA.id } });
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  it('finds the project-id columns from the catalog, including keys not named projectId', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    const cols = inv.columns.map((c) => `${c.table}.${c.column}`);
    expect(cols.length).toBeGreaterThan(100);
    for (const c of ['DomainEvent.projectId', 'OutboxDelivery.projectId', 'Membership.projectId', 'Media.projectId', 'Notification.projectId', 'AuditLog.projectId', 'User.projectId', 'User.lastProjectId']) {
      expect(cols, c).toContain(c);
    }
    expect(new Set(cols).size, 'no column listed twice').toBe(cols.length);
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
    expect(inv.media).toEqual([{ id: `it-media-${f.projectA.id}`, kind: 'progress', storageKey: null, url: null, sizeBytes: 3, bytesInDatabase: true }]);
    const pointers = inv.userPointers.map((u) => u.id);
    expect(pointers).toEqual(expect.arrayContaining([f.memberUser.id, f.otherUser.id]));
    expect(inv.userPointers.find((u) => u.id === f.otherUser.id)).toMatchObject({ projectId: f.projectB.id, lastProjectId: f.projectA.id });
  });

  it("counts every project, so a later run can prove the others kept every row", async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(inv.countsByProject[f.projectA.id]).toMatchObject({ 'Membership.projectId': 2, 'Media.projectId': 1 });
    expect(inv.countsByProject[f.projectB.id]).toMatchObject({ 'Membership.projectId': 1, 'User.projectId': 1 });
    expect(inv.countsByProject[f.projectB.id]).not.toHaveProperty('Media.projectId');
    expect(inv.rows['Membership.projectId'].every((r) => r.projectId === f.projectA.id), 'only the target is exported').toBe(true);
  });

  it('names the delete triggers the target would meet', async () => {
    const inv = await inventoryProject(t.prisma, f.projectA.id);
    expect(Object.keys(inv.deleteTriggers)).toContain('Project');
  });

  it('changes nothing, and a write inside its transaction is refused by PostgreSQL', async () => {
    const before = (await inventoryProject(t.prisma, f.projectA.id)).countsByProject;
    await expect(readOnlyTransaction(t.prisma, (tx) =>
      tx.projectNode.create({ data: { projectId: f.projectA.id, name: 'should not exist', kind: 'zone' } }),
    )).rejects.toThrow(/read-only transaction/);
    const after = (await inventoryProject(t.prisma, f.projectA.id)).countsByProject;
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
