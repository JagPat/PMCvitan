import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { readServableGeneration } from '../../src/platform/projections/generation';

/**
 * Every projection generation records the serializer version that built it (live PG).
 *
 * Replaces the generation-fence half of the closed PR #497, carrying only the two findings that
 * unit never resolved. The shape under test is deliberately NOT the obvious one — a NOT NULL
 * column with no default, which rejects any writer that does not know it exists — because that
 * shape breaks two ordinary, documented operations:
 *
 *   P1  an ALREADY-RUNNING previous release. `migrate.sh` applies migrations before the new
 *       processes start, so there is a window in which this column exists and the OLD binary is
 *       still serving; its `lockActiveGeneration` lazily bootstraps a generation with an INSERT
 *       naming no version, and rejecting that stalls an ordered projection mid-deploy.
 *
 *   P2  the rerunnable 4a repair, whose explicit column list cannot name a column added later.
 *       That one needs no probe of its own here: `phase6-t4a-withdraw.test.ts` already replays
 *       that migration with a bare `psql -f`, exactly as the RUNBOOK tells an operator to, so it
 *       goes red on its own if this migration breaks the replay. Its replacement generation must
 *       also be stamped USEFULLY — see the inheritance probe below — or a correctly repaired
 *       projection is left permanently unservable.
 */
describe('projection generation catalog version (live PG)', () => {
  let t: TestApp;
  const run = randomUUID().slice(0, 8);
  const orgId = `pgv-org-${run}`;
  const projectId = `pgv-proj-${run}`;
  const CONSUMER = 'decisions.inbox';

  const mk = (id: string, generation: number, status: string, version?: number) =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt"${version === undefined ? '' : ',"catalogVersion"'})
       VALUES ($1,$2,$3,$4,$5,'live',now(),now()${version === undefined ? '' : ',$6'})`,
      ...[id, CONSUMER, projectId, generation, status, ...(version === undefined ? [] : [version])],
    );

  const versionOf = async (id: string): Promise<number> =>
    (await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id } })).catalogVersion;

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma.org.create({ data: { id: orgId, name: `PGV ${run}`, slug: orgId } });
    await t.prisma.project.create({
      data: {
        id: projectId, orgId, name: projectId, short: 'PGV', descriptor: '', stage: 'Planning',
        siteCode: projectId.slice(-8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
        elapsedPct: 0, todayDay: 0, milestonePct: 0,
      },
    });
  });

  afterAll(async () => {
    await t?.prisma.projectionGeneration.deleteMany({ where: { projectId } });
    await t?.prisma.projectEventStream.deleteMany({ where: { projectId } });
    await t?.prisma.project.deleteMany({ where: { id: projectId } });
    await t?.prisma.org.deleteMany({ where: { id: orgId } });
    await t?.close();
  });

  it('P1: an un-versioned INSERT — the previous release’s lazy bootstrap — SUCCEEDS, stamped 1', async () => {
    // The exact shape the old `lockActiveGeneration` writes. A no-default NOT NULL rejects this and
    // stalls that ordered projection for the whole migrate-before-restart window.
    await mk(`pgv-boot-${run}`, 1, 'building');
    // 1 is not a convenience: it is the truth about a row written by something that does not know
    // this column exists, so it is the only version its contents can have.
    expect(await versionOf(`pgv-boot-${run}`)).toBe(1);
  });

  it('the column is NOT NULL with NO DEFAULT — the stamp is a trigger, so nothing acquires a version by omission', async () => {
    const col = await t.prisma.$queryRawUnsafe<Array<{ is_nullable: string; column_default: string | null }>>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'ProjectionGeneration' AND column_name = 'catalogVersion'`,
    );
    expect(col[0]?.is_nullable, 'every generation carries a version').toBe('NO');
    // A DEFAULT would fix P1 too, but silently: the trigger exists so the value is DECIDED (and,
    // for the 4a repair, inherited) rather than fallen into.
    expect(col[0]?.column_default).toBeNull();
  });

  it('P2: the stamp INHERITS only inside the retiring transaction — a rebuild cannot launder a version', async () => {
    // The 4a repair retires a generation and inserts its replacement in ONE transaction, COPYING
    // the retired generation's rows — so the replacement's true version is the retired one's.
    // Stamping it 1 would leave a correctly repaired projection permanently unservable, turning a
    // targeted repair into "repair, then rebuild as well".
    //
    // A REBUILD inserts in one transaction and retires in a LATER one, so it must NOT inherit —
    // otherwise the previous release's CLI would launder an old-serializer rebuild into a current
    // stamp and walk straight through the serve gate. Both halves are asserted on one fixture.
    await mk(`pgv-inc-${run}`, 10, 'retired', 2);

    // (1) the REBUILD shape: a separate transaction, beside an ALREADY-retired v2 sibling → 1
    await mk(`pgv-rebuild-${run}`, 11, 'building');
    expect(
      await versionOf(`pgv-rebuild-${run}`),
      'a rebuild beside an already-retired sibling must not inherit its version',
    ).toBe(1);

    // (2) the 4a-REPAIR shape: retire and insert in ONE transaction → inherits
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ProjectionGeneration" SET "status"='retired', "catalogVersion"=2 WHERE "id"=$1`, `pgv-rebuild-${run}`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "ProjectionGeneration" ("id","consumer","projectId","generation","status","cursorStatus","createdAt","updatedAt")
         VALUES ($1,$2,$3,12,'building','live',now(),now())`,
        `pgv-repair-${run}`, CONSUMER, projectId,
      );
    });
    expect(
      await versionOf(`pgv-repair-${run}`),
      'the repair copies the retired generation’s rows, so it carries its version',
    ).toBe(2);
  });

  it('the SERVE gate refuses a generation built by an older serializer, and only that', async () => {
    // Where the harm is. The previous release's standalone rebuild CLI registers consumers directly
    // and never calls `syncConsumerCatalog`, so it can still BUILD and ACTIVATE an old-serializer
    // generation. What it must not be able to do is get that served.
    await t.prisma.projectEventStream.upsert({
      where: { projectId }, create: { projectId, nextPosition: 1n }, update: { nextPosition: 1n },
    });
    await t.prisma.projectionGeneration.deleteMany({ where: { projectId } });
    // healthy and caught up, so the VERSION is the only thing left to judge
    await t.prisma.projectionGeneration.create({
      data: { id: `pgv-serve-${run}`, consumer: CONSUMER, projectId, generation: 20, status: 'active', cursorStatus: 'live', appliedPosition: 0n, catalogVersion: 1 },
    });
    expect(
      await readServableGeneration(t.prisma, CONSUMER, projectId),
      'at the consumer’s CURRENT compiled version it serves',
    ).not.toBeNull();

    // now exactly what an older release's CLI leaves behind: the same healthy, caught-up
    // generation, stamped below the running code's version
    await t.prisma.projectionGeneration.update({ where: { id: `pgv-serve-${run}` }, data: { catalogVersion: 0 } });
    expect(
      await readServableGeneration(t.prisma, CONSUMER, projectId),
      'refused — the caller falls back to the canonical live read, which is always current',
    ).toBeNull();
  });
});
