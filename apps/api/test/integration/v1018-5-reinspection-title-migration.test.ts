import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/** #482 V-1018-5 PR 2 — the data migration that removes the English "Re-inspection: " words the server used to store
 *  in a re-inspection's title. It runs from the real migration file, twice, against rows shaped like the ones the
 *  server wrote before #972, beside rows it must leave alone. */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280113000000_v1018_5_reinspection_title_prefix/migration.sql');

describe('V-1018-5 re-inspection title migration (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const P = `it-v10185-${run}`;

  const add = async (id: string, title: string, reinspectionOfId: string | null = null): Promise<void> => {
    await t.prisma.inspection.create({
      data: { id: `${P}-${id}`, projectId: P, kind: 'checklist', title, zone: 'GF', date: '01 Jun 2026', submitted: true, decided: true, reinspectionOfId: reinspectionOfId && `${P}-${reinspectionOfId}` },
    });
  };
  const titles = async (): Promise<Record<string, string>> => {
    const rows = await t.prisma.inspection.findMany({ where: { projectId: P }, select: { id: true, title: true } });
    return Object.fromEntries(rows.map((r) => [r.id.slice(P.length + 1), r.title]));
  };
  const migrate = async (): Promise<void> => {
    await t.prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.project.create({
      data: { id: P, orgId: f.orgA.id, name: P, short: 'V', descriptor: '', stage: 'x', siteCode: 'V', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    // a lineage written before #972: each re-check prefixed its parent's stored title
    await add('root', 'Terrace waterproofing');
    await add('child', 'Re-inspection: Terrace waterproofing', 'root');
    await add('grandchild', 'Re-inspection: Re-inspection: Terrace waterproofing', 'child');
    await add('great', 'Re-inspection: Re-inspection: Re-inspection: Terrace waterproofing', 'grandchild');
    // a re-inspection written after #972 under an old parent: already plain
    await add('old-parent', 'Stair railing');
    await add('old-child', 'Re-inspection: Stair railing', 'old-parent');
    await add('new-child', 'Stair railing', 'old-child');
    // titles someone typed that only look like the old words
    await add('typed', 'Re-inspection: Kitchen tiling');
    await add('typed-child', 'Re-inspection: Kitchen tiling', 'typed');
    // a re-inspection whose words do not match its parent's title exactly
    await add('other-parent', 'Slab casting');
    await add('mismatch', 'Re-inspection: Slab casting (east)', 'other-parent');
    await add('case-parent', 'Slab casting');
    await add('case', 're-inspection: Slab casting', 'case-parent');
  });
  afterAll(async () => {
    await t?.prisma.inspection.deleteMany({ where: { projectId: P } });
    await t?.prisma.project.deleteMany({ where: { id: P } });
    await f?.cleanup();
    await t?.close();
  });

  it('strips the words only where the title is exactly "Re-inspection: " + the parent title, and resolves a chain to its first title', async () => {
    await migrate();
    expect(await titles()).toEqual({
      root: 'Terrace waterproofing',
      child: 'Terrace waterproofing',
      grandchild: 'Terrace waterproofing',
      great: 'Terrace waterproofing',
      'old-parent': 'Stair railing',
      'old-child': 'Stair railing',
      'new-child': 'Stair railing',
      typed: 'Re-inspection: Kitchen tiling',
      'typed-child': 'Re-inspection: Kitchen tiling',
      'other-parent': 'Slab casting',
      mismatch: 'Re-inspection: Slab casting (east)',
      'case-parent': 'Slab casting',
      case: 're-inspection: Slab casting',
    });
  });

  it('a second run changes nothing', async () => {
    const before = await titles();
    await migrate();
    expect(await titles()).toEqual(before);
  });
});
