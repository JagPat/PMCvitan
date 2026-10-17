import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { diffSnapshots, snapshotDatabase, writeJsonAtomically } from '../../src/platform/db-snapshot';

/**
 * #482 — the snapshot Board takes before and after removing the archived QA project. It must cover
 * every table, key rows by PostgreSQL's own text, show any change between two runs (in a table with
 * no foreign key to a project too), take PostgreSQL's time, and be written whole or not at all.
 */
describe('db:snapshot — every table, read-only (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = Math.random().toString(36).slice(2, 8);
  const receipt = `it-snap-receipt-${run}`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await t?.prisma.processedEvent.deleteMany({ where: { id: receipt } });
    await t?.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  it('covers every table with its row count and sorted keys, on one read-only snapshot with PostgreSQL time', async () => {
    const before = new Date(Date.now() - 60_000);
    const snap = await snapshotDatabase(t.prisma);
    expect(snap.readOnlyVerified).toBe(true);
    expect(new Date(snap.takenAt).getTime()).toBeGreaterThan(before.getTime());
    const tables = (await t.prisma.$queryRawUnsafe<Array<{ table: string }>>(
      `SELECT c.relname::text AS "table" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`)).map((r) => r.table);
    expect(Object.keys(snap.tables).sort()).toEqual([...tables].sort());
    for (const table of ['Project', 'Membership', 'ProcessedEvent', '_t4d_tx_transition']) {
      const [{ n }] = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`);
      expect(snap.tables[table].rows, table).toBe(n);
      expect(snap.tables[table].keys, table).toHaveLength(n);
    }
    expect(snap.tables.Project.key).toEqual(['id']);
    expect(snap.tables.Project.keys).toContain(JSON.stringify([f.projectA.id]));
    expect(snap.tables.Membership.keys.length).toBeGreaterThanOrEqual(3);
  });

  it('shows exactly the rows that changed, including a receipt that has no foreign key to any project', async () => {
    const before = await snapshotDatabase(t.prisma);
    const node = await t.prisma.projectNode.create({ data: { projectId: f.projectA.id, name: 'Zone', kind: 'zone' } });
    await t.prisma.processedEvent.create({ data: { id: receipt, consumer: 'it-snapshot', eventId: `evt-${run}` } });
    const after = await snapshotDatabase(t.prisma);
    const changes = diffSnapshots(before, after).filter((c) => c.table === 'ProjectNode' || c.table === 'ProcessedEvent');
    expect(changes).toEqual([
      { table: 'ProcessedEvent', removed: [], added: [JSON.stringify([receipt])] },
      { table: 'ProjectNode', removed: [], added: [JSON.stringify([node.id])] },
    ]);
    await t.prisma.processedEvent.delete({ where: { id: receipt } });
    const back = await snapshotDatabase(t.prisma);
    expect(diffSnapshots(after, back).find((c) => c.table === 'ProcessedEvent')).toEqual({ table: 'ProcessedEvent', removed: [JSON.stringify([receipt])], added: [] });
  });

  it('is unchanged by a run of itself: two snapshots with nothing written between them are equal', async () => {
    const a = await snapshotDatabase(t.prisma);
    const b = await snapshotDatabase(t.prisma);
    expect(diffSnapshots(a, b)).toEqual([]);
  });

  it('writes the file owner-only and whole, never over an existing file, and leaves nothing on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snap-'));
    const snap = await snapshotDatabase(t.prisma);
    const out = join(dir, 'before.json');
    writeJsonAtomically(snap, out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(diffSnapshots(snap, JSON.parse(readFileSync(out, 'utf8')))).toEqual([]);
    const taken = join(dir, 'taken.json');
    writeFileSync(taken, 'keep');
    expect(() => writeJsonAtomically(snap, taken)).toThrow(/EEXIST/);
    expect(readFileSync(taken, 'utf8')).toBe('keep');
    expect(() => writeJsonAtomically(snap, join(dir, 'missing', 'c.json'))).toThrow();
    expect(readdirSync(dir).sort(), 'only the finished snapshot and the pre-existing file').toEqual(['before.json', 'taken.json']);
  });
});
