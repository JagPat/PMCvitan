import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { CONSULTATION_CAPABILITY } from '../../src/platform/capabilities.service';

/**
 * Phase 6 unit 4c-iii — the ENABLEMENT TRANSITION (plan §D, rounds 18/20/21/24/26).
 *
 * ONE migration, in ONE transaction, doing three inseparable things in a mandated order: replace
 * the reservation with a PRESERVATION seal, install the `AFTER INSERT` trigger on `Project`, and
 * THEN backfill every existing project. What is probed here is the TERMINAL STATE that ordering
 * exists to guarantee — every project has the row, whichever mechanism produced it — plus each
 * arm of the seal that replaces the reservation.
 *
 * Every probe below FAILS at `main` 2cec61f: there the reservation is still armed (so a
 * `consultation` row cannot exist at all), no `Project` trigger exists, and no seal does.
 */
describe('Phase 6 unit 4c-iii — the enablement transition (live PG)', () => {
  let t: TestApp;
  let raceDb: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4ciii-${label}-${run}`;
  const orgId = id('org');
  const made: string[] = [];

  const projectData = (pid: string) => ({
    id: pid, orgId, name: pid, short: 'T4C3', descriptor: '', stage: 'Planning',
    siteCode: pid.slice(-8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
    elapsedPct: 0, todayDay: 0, milestonePct: 0,
  });

  const makeProject = async (label: string): Promise<string> => {
    const pid = id(label);
    await t.prisma.project.create({ data: projectData(pid) });
    made.push(pid);
    return pid;
  };

  const capRow = (projectId: string) =>
    t.prisma.projectCapability.findUnique({
      where: { projectId_capability: { projectId, capability: CONSULTATION_CAPABILITY } },
    });

  beforeAll(async () => {
    t = await createTestApp();
    raceDb = new PrismaClient();
    await t.prisma.org.create({ data: { id: orgId, name: `T4CIII ${run}`, slug: orgId } });
    // Created HERE, before the first assertion, so the database-wide invariant below is not
    // vacuously true on an empty database — at the base head these projects hold no row and the
    // probe fails on them.
    await makeProject('pre-a');
    await makeProject('pre-b');
  });

  afterAll(async () => {
    await raceDb?.$disconnect();
    // the project delete CASCADES to its capability rows — which is the seal's permitted arm,
    // and the reason this teardown needs no bypass
    await t?.prisma.project.deleteMany({ where: { orgId } });
    await t?.prisma.org.deleteMany({ where: { id: orgId } });
    await t?.close();
  });

  // ═══ THE EVERY-PROJECT GUARANTEE ═════════════════════════════════════════════════════════════

  it('every project this suite created carries the row — none left behind', async () => {
    // SCOPED TO THIS SUITE'S ORG, deliberately — and the first draft of this probe was not, which
    // is why the scoping is explained rather than just applied. Asserting the invariant over the
    // WHOLE database looks stronger and is in fact unsound in the shared battery: `sanctionedReset`
    // disables every seal in `TRUNCATE_SEALS` wholesale (it must, because cascades reach tables the
    // caller never names), so any concurrently running suite may legitimately clear
    // `ProjectCapability` for projects it does not own. A database-wide count therefore measures
    // other suites' teardown timing, not this unit's guarantee — it failed in the full battery for
    // exactly that reason while the trigger was installed, enabled and working.
    //
    // What this probe holds is the guarantee itself, over projects whose whole lifetime this suite
    // controls, and it is not vacuous: `pre-a` and `pre-b` are created in `beforeAll`, and at the
    // base head they hold no row and this fails.
    //
    // The EVERY-PROJECT and BACKFILL claims are proven where the database is exclusively ours:
    // `scripts/upgrade-proof.sh` migrates a legacy fixture holding `p1`/`p2` — projects that
    // existed BEFORE the transition, which no suite can create — and asserts a database-wide count
    // of zero plus the trigger, seal and cascade arms on the migrated result.
    const missing = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "Project" p
        WHERE p."orgId" = $1
          AND NOT EXISTS (SELECT 1 FROM "ProjectCapability" c
                           WHERE c."projectId" = p."id" AND c."capability" = 'consultation')`,
      orgId,
    );
    expect(Number(missing[0]?.n ?? -1), 'no project of this org may lack the consultation row').toBe(0);
    expect(made.length, 'and the check is not vacuous — projects exist to fail it').toBeGreaterThan(0);
  });

  it('a project created AFTER the transition carries the row, with no application involvement', async () => {
    // The row is produced by a DATABASE trigger, so it appears for a create path that knows
    // nothing about it — which is the whole reason §D refused to put this in `projects.create`.
    // This insert is a raw Prisma create with no capability field anywhere in it.
    const pid = await makeProject('new');
    const row = await capRow(pid);
    expect(row, 'the AFTER INSERT trigger must have produced the row').not.toBeNull();
    expect(row!.enabledById, 'the DB enablement records itself, never a borrowed human identity')
      .toBe('system:phase6-4c-iii');
  });

  it('a concurrent create racing the transition still ends with its row — whichever side won', async () => {
    // §D's barrier-controlled probe. The transition has already committed here, so what this
    // asserts is the property that ordering bought: the trigger covers a create the backfill
    // could never have seen, and the terminal state is the same either way. Two sessions create
    // simultaneously on separate connections; both projects must hold the row.
    const a = id('race-a');
    const b = id('race-b');
    made.push(a, b);
    await Promise.all([
      t.prisma.project.create({ data: projectData(a) }),
      raceDb.project.create({ data: projectData(b) }),
    ]);
    expect(await capRow(a)).not.toBeNull();
    expect(await capRow(b)).not.toBeNull();
  });

  // ═══ THE RESERVATION IS GONE ═════════════════════════════════════════════════════════════════

  it('the reservation no longer refuses the capability — the gate it latched is now open', async () => {
    // 4c-i/4c-ii's reservation rejected every INSERT and re-key naming `consultation`. Its whole
    // purpose was the dark window, and that window closed with the drain. The row now simply
    // exists for every project, and the generic writer can idempotently re-enable it.
    const pid = await makeProject('reserv');
    await expect(
      t.prisma.projectCapability.upsert({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
        create: { projectId: pid, capability: CONSULTATION_CAPABILITY, enabledById: 'op' },
        update: {},
      }),
    ).resolves.toBeTruthy();

    const trg = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM pg_trigger WHERE tgname = 'ProjectCapability_t4c_reserved'`,
    );
    expect(Number(trg[0]?.n ?? -1), 'the reservation trigger is dropped, not merely bypassed').toBe(0);
  });

  // ═══ THE PRESERVATION SEAL — all three arms of the completeness rule ══════════════════════════

  it('ARM 1 — a direct DELETE of a live project’s consultation row is REFUSED', async () => {
    const pid = await makeProject('del');
    await expect(
      t.prisma.projectCapability.delete({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
      }),
    ).rejects.toThrow(/may not be DELETED while that project exists/u);
    expect(await capRow(pid), 'the row survives the attempt').not.toBeNull();
  });

  it('ARM 2 — RE-KEYING the row off `consultation` is REFUSED', async () => {
    // `capability` is a mutable key with no freeze trigger, so a DELETE-only seal would leave the
    // same gate-closed state reachable by renaming the row.
    const pid = await makeProject('rekey');
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'materials' WHERE "projectId" = $1 AND "capability" = 'consultation'`,
        pid,
      ),
    ).rejects.toThrow(/may not be RE-KEYED/u);
    expect(await capRow(pid)).not.toBeNull();
  });

  it('ARM 3 — TRUNCATE is REFUSED, because a row trigger never fires for it', async () => {
    // Stated by enumeration over the mechanism rather than because a reviewer tried it: a seal
    // that must keep a row PRESENT is complete only when it covers row DELETE, row UPDATE of the
    // sealed key, and statement TRUNCATE.
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE "ProjectCapability"`))
      .rejects.toThrow(/never truncated/u);
  });

  it('the seal is PRECISE — every other capability is untouched by all three arms', async () => {
    // The Board pin stands: no CHECK on `capability`, no vocabulary whitelist. A seal that
    // refused every capability would be an outage wearing a seal's clothes.
    const pid = await makeProject('precise');
    await t.prisma.projectCapability.create({ data: { projectId: pid, capability: 'materials', enabledById: 'op' } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'labour' WHERE "projectId" = $1 AND "capability" = 'materials'`,
        pid,
      ),
    ).resolves.toBe(1);
    await expect(
      t.prisma.projectCapability.delete({
        where: { projectId_capability: { projectId: pid, capability: 'labour' } },
      }),
    ).resolves.toBeTruthy();
  });

  it('the seal is SCOPED TO A LIVE PROJECT — deleting the project cascades the row away', async () => {
    // The deliberate deviation from §D's "every way", argued in the packet. The invariant the
    // seal protects is the split brain between gate-reading and gate-blind instances FOR A
    // PROJECT; a project that no longer exists has no such state. Under CASCADE the child delete
    // runs in a later command than the parent's, so the trigger sees the parent already gone —
    // an exact discriminator, not a heuristic, and the arm-1 probe above is its other side.
    const pid = await makeProject('cascade');
    expect(await capRow(pid)).not.toBeNull();
    await expect(t.prisma.project.delete({ where: { id: pid } })).resolves.toBeTruthy();
    expect(await capRow(pid), 'the row went with the project it belonged to').toBeNull();
    expect(await t.prisma.project.findUnique({ where: { id: pid } })).toBeNull();
  });
});
