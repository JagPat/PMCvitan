import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { computeInspectionsBase } from '../../src/inspections/inspections-serialize';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { INSPECTIONS_PROJECTION } from '../../src/inspections/inspections.projection';

/** #482 V-1018-5 PR 2 — the data migration that removes the English "Re-inspection: " words the server used to store
 *  in a re-inspection's title. It runs from the real migration file, twice, against rows shaped like the ones the
 *  server wrote before #972, beside rows it must leave alone. */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280113000000_v1018_5_reinspection_title_prefix/migration.sql');

describe('V-1018-5 re-inspection title migration (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const P = `it-v10185-${run}`;
  /** a project with no old titles: its read model must go on being served */
  const Q = `it-v10185q-${run}`;
  let query: InspectionsQueryService;
  /** the read model as the projection wrote it before the migration, i.e. what a late stale upsert writes back */
  let staleDto: object;

  const add = async (id: string, title: string, reinspectionOfId: string | null = null): Promise<void> => {
    await t.prisma.inspection.create({
      data: { id: `${P}-${id}`, projectId: P, kind: 'checklist', title, zone: 'GF', date: '01 Jun 2026', submitted: true, decided: true, reinspectionOfId: reinspectionOfId && `${P}-${reinspectionOfId}` },
    });
  };
  const titles = async (): Promise<Record<string, string>> => {
    const rows = await t.prisma.inspection.findMany({ where: { projectId: P }, select: { id: true, title: true } });
    return Object.fromEntries(rows.map((r) => [r.id.slice(P.length + 1), r.title]));
  };
  /** what the app serves: which path, and the title of every inspection it lists */
  const served = async (projectId: string): Promise<{ source: string; titles: Record<string, string> }> => {
    const mod = await query.moduleInspections(projectId, 'pmc');
    return { source: mod.source, titles: Object.fromEntries(mod.placedInspections.map((i) => [i.id.slice(projectId.length + 1), i.title])) };
  };
  /** a quiet project's read model as the projection leaves it: one active, caught-up generation holding the base */
  const project = async (projectId: string): Promise<object> => {
    const gen = await t.prisma.projectionGeneration.create({
      data: { consumer: INSPECTIONS_PROJECTION, projectId, generation: 1, status: 'active', appliedPosition: 0n, catalogVersion: 2 },
    });
    const dto = JSON.parse(JSON.stringify(await computeInspectionsBase(t.prisma, projectId))) as object;
    await t.prisma.inspectionsProjection.create({ data: { generationId: gen.id, projectId, dto } });
    return dto;
  };
  const migrate = async (): Promise<void> => {
    await t.prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
  };

  beforeAll(async () => {
    t = await createTestApp();
    query = t.app.get(InspectionsQueryService);
    f = await createTwoProjectFixture(t.prisma);
    for (const id of [P, Q]) {
      await t.prisma.project.create({
        data: { id, orgId: f.orgA.id, name: id, short: 'V', descriptor: '', stage: 'x', siteCode: 'V', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      });
    }
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
    // the other project: an ordinary inspection and its re-check, already plain
    await t.prisma.inspection.create({ data: { id: `${Q}-a`, projectId: Q, kind: 'checklist', title: 'Lift shaft', zone: 'GF', date: '01 Jun 2026', submitted: true, decided: true } });
    await t.prisma.inspection.create({ data: { id: `${Q}-b`, projectId: Q, kind: 'checklist', title: 'Lift shaft', zone: 'GF', date: '01 Jun 2026', submitted: true, decided: true, reinspectionOfId: `${Q}-a` } });
    // both quiet projects' read models, written by the projection before the migration (Codex 4308535200)
    staleDto = await project(P);
    await project(Q);
  });
  afterAll(async () => {
    await t?.prisma.inspectionsProjection.deleteMany({ where: { projectId: { in: [P, Q] } } });
    await t?.prisma.projectionGeneration.deleteMany({ where: { projectId: { in: [P, Q] } } });
    await t?.prisma.inspection.deleteMany({ where: { projectId: { in: [P, Q] } } });
    await t?.prisma.project.deleteMany({ where: { id: { in: [P, Q] } } });
    await f?.cleanup();
    await t?.close();
  });

  it('before the migration the read model serves the old words', async () => {
    const before = await served(P);
    expect(before.source).toBe('projection');
    expect(before.titles.grandchild).toBe('Re-inspection: Re-inspection: Terrace waterproofing');
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

  it('the app serves the fixed titles at once: the old read model is no longer served (Codex 4308535200)', async () => {
    const after = await served(P);
    expect(after.source).toBe('live');
    expect(after.titles).toEqual(await titles());
    const gen = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: INSPECTIONS_PROJECTION, projectId: P, status: 'active' } });
    expect(gen.catalogVersion).toBe(1);
  });

  it('a stale write from an old API after the migration is never served (Codex 4308738421)', async () => {
    // the relay's refresh read the old titles before the migration committed and upserts them after it
    const gen = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: INSPECTIONS_PROJECTION, projectId: P, status: 'active' } });
    await t.prisma.inspectionsProjection.update({ where: { generationId_projectId: { generationId: gen.id, projectId: P } }, data: { dto: staleDto } });
    await t.prisma.projectionGeneration.update({ where: { id: gen.id }, data: { appliedPosition: 0n, cursorStatus: 'live' } });
    const after = await served(P);
    expect(after.source).toBe('live');
    expect(after.titles.grandchild).toBe('Terrace waterproofing');
  });

  it('a project with no old titles keeps its read model', async () => {
    const q = await served(Q);
    expect(q.source).toBe('projection');
    const gen = await t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: INSPECTIONS_PROJECTION, projectId: Q, status: 'active' } });
    expect(gen.catalogVersion).toBe(2);
  });

  it('a second run changes nothing', async () => {
    const before = await titles();
    const gens = await t.prisma.projectionGeneration.findMany({ where: { projectId: { in: [P, Q] } }, orderBy: { id: 'asc' } });
    await migrate();
    expect(await titles()).toEqual(before);
    expect(await t.prisma.projectionGeneration.findMany({ where: { projectId: { in: [P, Q] } }, orderBy: { id: 'asc' } })).toEqual(gens);
  });
});
