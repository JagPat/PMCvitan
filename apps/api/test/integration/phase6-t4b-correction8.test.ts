import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-8 CORRECTION (Codex, three findings on `90ec557`).
 *
 * Two P1 and one P2. Every probe here was RED at `90ec557` with `20270823000000` AND the service
 * half of its finding reverted, on a scratch database migrated only to `20270822000000`.
 *
 * **Classification, stated because the trend matters more than any one finding:** none of the
 * three is a SEAM finding. R8-1 is round 7's own over-reach (it fixed round 6's over-reach by
 * widening, and widened too far). R8-3 is round 5's. R8-2 is older and latent — round 3's R3-7
 * established that a transaction must act on the row it LOCKED and fixed `isRecord` that way,
 * leaving the holder read on the unlocked path, where rounds 4 and 6 then built three authority
 * decisions on top of it.
 *
 * All three are one shape: **a value read outside the lock that makes reading it a decision.**
 */
describe('Phase 6 unit 4b-i round 8 — the three Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let seq = 0;
  let raceDb: PrismaClient;
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.commandExecution.deleteMany({ where: { projectId: f.projectA.id } });
    for (const [userId, role] of [[f.memberUser.id, 'pmc'], [f.clientUser.id, 'client']] as const) {
      if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId } }))) {
        await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId, role, status: 'active' } });
      } else {
        await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId }, data: { role, status: 'active' } });
      }
    }
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: { startsWith: `r8-${run}` } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: `r8-${run}` } } });
  });

  const seedPublished = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `DL-t4bc8-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Draft ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null, ...over,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  // ── R8-1 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R8-1: the restoration exemption is for a WITHDRAWAL of a real approval — not any arrival at `approved`', async () => {
    // The forged shape the exemption admitted at `90ec557`: a published PENDING row with the
    // approval columns planted, never actually approved. Flipping only its status satisfied every
    // equality round 7 checked, so the completeness demand was skipped and the unattributed
    // approval became permanent (R2-1 forbids filling the tuple afterwards).
    const forged = `DL-t4bc8-${run}-forged-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id: forged, projectId: f.projectA.id, title: 'Planted evidence', room: 'Kitchen',
        status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
        publishedAt: null, approvedOption: 'A', material: 'Teak', approver: 'Nobody',
        approvedById: f.clientUser.id, date: '01 Jan 2026',
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: forged, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: forged, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id: forged }, data: { publishedAt: new Date() } });

    await expect(
      t.prisma.decision.update({ where: { id: forged }, data: { status: 'approved' } }),
    ).rejects.toThrow(/records WHO approved it/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: forged } })).status).toBe('pending');

    // …and the same forgery routed through `change` is refused too, because no approval ever
    // happened: `approve()` writes an `approved` DecisionEvent, and this row has none
    await t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status"='change' WHERE "id" = $1`, forged);
    await expect(
      t.prisma.decision.update({ where: { id: forged }, data: { status: 'approved' } }),
    ).rejects.toThrow(/records WHO approved it/);

    // PRECISION — a GENUINE legacy withdrawal still restores.
    //
    // ROUND 10 moved this arm, and its old shape is the clearest illustration of why. It built its
    // "legacy" row by DISABLING `Decision_t4b_recorded_seal` and stripping the tuple from a
    // properly attributed approval — that is, by switching off the seal in order to demonstrate
    // that the seal behaves correctly. It passed because rounds 7-9 recognised a legacy row from
    // evidence any writer can produce, which is exactly the property R10-1 found forgeable.
    //
    // After `20270827000000` a legacy row is one the migration STAMPED, and nothing minted here
    // can be in that set. The arm therefore lives in `scripts/upgrade-proof.sh`, which plants
    // `UP4B2-D1` before the migration and then upgrades — a genuine pre-migration approval,
    // restored with no trigger disabled anywhere.
    //
    // What is provable here is the stronger half this round makes true: the same tupleless arrival
    // on a row minted AFTER the migration is refused no matter what evidence accompanies it.
    const real = await seedPublished();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='change', "approvedById"=$2, "approvedOption"='A',
              "approver"='Client', "material"='Teak', "date"='01 Jan 2026' WHERE "id" = $1`,
      real, f.clientUser.id,
    );
    await t.prisma.decisionEvent.create({
      data: { decisionId: real, type: 'approved', actor: 'Client', actorId: f.clientUser.id },
    });
    await expect(
      t.prisma.decision.update({ where: { id: real }, data: { status: 'approved' } }),
    ).rejects.toThrow(/records WHO approved it/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: real } })).status).toBe('change');
  });

  // ── R8-2 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R8-2: publish LOCKS the draft before judging its holder — the gate cannot be outrun', async () => {
    // At `90ec557` the holder and the surface gate were applied to an UNLOCKED pre-read. A
    // client-held draft could pass the gate, be converted to member-held by a concurrent writer
    // before the CAS, and publish anyway — after which the post-update branch sends the legacy
    // client approval push for a holder the gate exists to refuse.
    const userId = `r8-${run}-h-${seq++}`;
    await t.prisma.user.create({
      data: { id: userId, projectId: f.projectA.id, role: 'contractor', name: 'Named holder', email: `${userId}@t4bc8.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId, role: 'contractor', status: 'active' },
    });
    const id = `DL-t4bc8-${run}-race-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'Raced draft', room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });

    // A second session HOLDS the decision row and re-points it to the member holder — the edit the
    // gate must not be able to miss. `publish` must WAIT for that row rather than judging a copy
    // of it taken beforehand.
    const g = (() => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; })();
    let held!: () => void;
    const heldP = new Promise<void>((r) => (held = r));
    const holdTx = raceDb.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT 1 FROM "Decision" WHERE "id" = $1 FOR UPDATE`, id);
      await tx.$executeRawUnsafe(
        `UPDATE "Decision" SET "deciderKind"='member', "deciderMembershipId"=$1 WHERE "id" = $2`,
        holder.id, id,
      );
      held();
      await g.p;
    }, { timeout: 20_000, maxWait: 10_000 });
    await heldP;

    let settled = false;
    const publishing = svc.publish(f.projectA.id, id, pmc()).then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 30 && !settled; i++) await new Promise((r) => setTimeout(r, 50));
    expect(settled, 'publish must WAIT for the row it is about to judge').toBe(false);

    g.open();
    await holdTx;
    await expect(publishing.then(() => t.prisma.decision.findUniqueOrThrow({ where: { id } }))).resolves.toBeDefined();
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.deciderKind, 'the concurrent edit landed…').toBe('member');
    expect(after.publishedAt, '…and publish saw it, so the gate refused rather than publishing a holder it cannot route').toBeNull();
  });

  // ── R8-3 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R8-3: the first approval HOLDS the holder identity — a rename mid-approval cannot 500 it', async () => {
    // The label is derived in one statement, written in a second, and RECOMPUTED by the seal in a
    // third. At `90ec557` nothing held the identity across them, so a rename committing in between
    // gave the service the old name and the trigger the new one — and a valid approval died on a
    // raw database error.
    const userId = `r8-${run}-rename-${seq++}`;
    await t.prisma.user.create({
      data: { id: userId, projectId: f.projectA.id, role: 'contractor', name: 'Before Rename', email: `${userId}@t4bc8.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId, role: 'contractor', status: 'active' },
    });
    const id = await seedPublished({ deciderKind: 'member', deciderMembershipId: holder.id });

    // INTERPOSE the race deterministically (the R3-7 / R6-6 pattern) rather than hoping the
    // scheduler lands in a sub-millisecond window: the rename is dispatched from a second session
    // at the exact moment the service has DERIVED the label and not yet written it.
    //
    // The two heads then differ observably. At `90ec557` nothing holds the identity, so the rename
    // commits inside the window and the trigger recomputes a name the service never saw. With the
    // identity held `FOR SHARE`, the rename BLOCKS until the approval commits — so the same
    // dispatch changes nothing and the act is attributed to the identity it actually held.
    const svcAny = svc as unknown as { holderLabel: (...a: unknown[]) => Promise<string | null> };
    const realLabel = svcAny.holderLabel.bind(svc);
    let renaming: Promise<unknown> | null = null;
    let spyFired = false;
    let renameLanded = false;
    svcAny.holderLabel = async (...args: unknown[]) => {
      spyFired = true;
      const label = await realLabel(...args);
      // DISPATCHED, not merely constructed: a Prisma raw promise is LAZY and does not touch the
      // database until something awaits it. Assigning it and walking away starts nothing — the
      // trap the Phase-4 T1 correction-4 packet already records, walked into again here, and
      // caught only because this probe asserts that its own interposition actually happened.
      renaming = Promise.resolve().then(() =>
        raceDb.$executeRawUnsafe(`UPDATE "User" SET "name" = 'After Rename' WHERE "id" = $1`, userId),
      );
      // give the rename its chance to commit: at `90ec557` it takes it, and with the identity held
      // it cannot — so this delay decides nothing, it only removes the scheduler from the question
      await new Promise((r) => setTimeout(r, 300));
      renameLanded = (await raceDb.user.findUniqueOrThrow({ where: { id: userId } })).name === 'After Rename';
      return label;
    };

    try {
      await expect(
        svc.approve(f.projectA.id, id, { optionIndex: 0 } as never, { sub: userId, role: 'contractor', projectId: f.projectA.id } as AuthUser),
        'an ordinary approval must not die because someone was renamed mid-flight',
      ).resolves.toBeDefined();
    } finally {
      svcAny.holderLabel = realLabel as never;
    }
    await renaming;
    expect(spyFired, 'the interposition must actually have run, or the probe proves nothing').toBe(true);
    expect(
      renameLanded,
      'the rename must have been HELD OFF while the approval was in flight — if it landed inside the window, the identity was not locked',
    ).toBe(false);
    expect(
      (await t.prisma.user.findUniqueOrThrow({ where: { id: userId } })).name,
      'the rename DID land afterwards — it was serialized, not lost',
    ).toBe('After Rename');

    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('approved');
    expect(after.approvedDeciderLabel, 'the act froze the identity it actually held').toBe('Before Rename');
  });
});
