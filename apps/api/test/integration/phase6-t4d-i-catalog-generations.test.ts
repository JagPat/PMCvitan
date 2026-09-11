import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { EXTERNAL_EFFECTS, effectCoverageVersion } from '../../src/platform/external-effects';

/**
 * Phase 6 unit 4d-i — THE COEXISTING COVERAGE GENERATIONS (#582's review round 8, finding 3).
 *
 * WHAT BROKE. `DomainEvent_t4d_envelope` resolves an event's intent by the EXACT
 * `(coverageVersion, effectKey)` pair and raises "which this database does not hold" on a miss —
 * and it does so from the moment 4d-i commits, with no dark window for the intent. A rolling
 * deploy therefore has previous-release processes still emitting under the version THEY compute.
 * With a single generation seeded, every one of those events is refused: not a dark rollout but
 * an outage lasting the whole drain.
 *
 * WHY THE VERSIONS DIVERGED. `pushOptional` was introduced by this unit at review round 2 to
 * DESCRIBE four emit paths the previous release already takes silently, and joined
 * `canonicalCatalog()`'s preimage at round 5 (finding 4) because it decides the sealed
 * `requiresPush`. Neither change altered a single key's policy — it made an existing behaviour
 * explicit — so the two releases declare the SAME catalog and hash apart only because one of them
 * spells the fourth element of each tuple.
 *
 * WHAT THIS SUITE HOLDS. The migration copies the current generation's rows to the outgoing
 * version rather than transcribing a second literal block, and that copy is licensed by exactly
 * one fact: the two generations' policy is identical. `licences the row copy` below RE-DERIVES
 * that fact from source on every run, so the licence cannot outlive its proof — the day a release
 * genuinely changes a key's audience, invalidation or push obligation, this goes red and the
 * outgoing generation must be seeded with the OUTGOING policy instead.
 */

/** The version this source computes — the generation a CURRENT writer emits under. */
const CURRENT = effectCoverageVersion();

/**
 * The outgoing generation, as the migration names it. Not transcribed from the deployed database:
 * it is `canonicalCatalog()` over this same catalog with the `pushOptional` element absent, which
 * is precisely what the previous release's `canonicalCatalog()` emits. `licences the row copy`
 * asserts the two agree.
 */
const OUTGOING = '6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7';

/**
 * THE DECLARED DIVERGENCE between the two generations (#582 review round 13, finding 3).
 *
 * Until this round the releases declared an IDENTICAL catalog and this file's licence was simply
 * "the same rows, a different preimage". Splitting `activity.created` ended that: the previous
 * release has one key there carrying the push exemption, this release has two — `activity.created`
 * which now OWES its announcement and `activity.created.init` which may not push at all.
 *
 * The divergence is declared in ONE place, here and in the migration's seed, so the licence stays
 * a DERIVATION rather than becoming a pinned constant nobody can check. Note what is and is not
 * hash-affecting: the previous release's preimage does not contain the `pushOptional` element at
 * all, so restoring that flag changes no hash — only the ADDED KEY does. That is why removing it
 * alone reproduces the outgoing version exactly, and why an undeclared divergence still goes red.
 */
const ADDED_THIS_RELEASE = ['activity.created.init'];

/** Keys whose `requiresPush` the previous release computed differently (it carried `pushOptional`). */
const REQUIRES_PUSH_DIVERGENCE = new Map<string, boolean>([['activity.created', false]]);

/** `canonicalCatalog()`, with the `pushOptional` element optionally withheld and keys optionally skipped. */
function canonical(withPushOptional: boolean, skip: readonly string[] = []): string {
  const keys = Object.keys(EXTERNAL_EFFECTS).filter((k) => !skip.includes(k)).sort();
  return JSON.stringify(
    keys.map((k) => {
      const d = (EXTERNAL_EFFECTS as Record<string, {
        eventType: string; invalidate: boolean; push: readonly string[] | null;
        pushFamily?: string; pushOptional?: true;
      }>)[k]!;
      const base: unknown[] = [
        k, d.eventType, d.invalidate,
        d.push === null ? null : [...d.push].slice().sort(),
        d.pushFamily ?? null,
      ];
      return withPushOptional ? [...base, d.pushOptional === true] : base;
    }),
  );
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

type Row = {
  coverageVersion: string; effectKey: string; eventType: string; invalidate: boolean;
  pushRoles: unknown; pushFamily: string | null; frozenAudience: boolean;
  requiresPush: boolean; audience: string | null; pushBody: string | null;
  pairingRequired: boolean; retiredAt: Date | null;
};

describe('phase 6 4d-i — the catalog carries every generation still being emitted', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  beforeAll(async () => { t = await createTestApp(); f = await createTwoProjectFixture(t.prisma); });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  const rowsAt = (v: string) => t.prisma.$queryRawUnsafe<Row[]>(
    `SELECT * FROM "ExternalEffectCatalog" WHERE "coverageVersion" = $1 ORDER BY "effectKey"`, v,
  );

  it('licences the seed — the outgoing generation is THIS catalog minus the declared divergence', () => {
    // The migration seeds the outgoing generation from the same compiled source with two declared
    // bends. This is the derivation of that claim: remove the key this release added and the
    // previous release's own `canonicalCatalog()` output falls out exactly. Anything that
    // diverges WITHOUT being declared above changes this hash and fails here.
    expect(sha(canonical(false, ADDED_THIS_RELEASE))).toBe(OUTGOING);
    expect(sha(canonical(true))).toBe(CURRENT);
    expect(CURRENT).not.toBe(OUTGOING);
  });

  it('seeds BOTH generations, over the same key set', async () => {
    const current = await rowsAt(CURRENT);
    const outgoing = await rowsAt(OUTGOING);

    expect(current.length, `no rows at the current generation ${CURRENT}`).toBeGreaterThan(0);
    expect(current.length).toBe(Object.keys(EXTERNAL_EFFECTS).length);
    // A generation seeded PARTIALLY is worse than one not seeded at all: the drain would then
    // reject exactly the keys nobody thought to copy, and only for the events that use them. The
    // outgoing set is the current set minus the key this release added — asserted as that
    // subtraction, so a key going missing for any OTHER reason still fails.
    expect(outgoing.map((r) => r.effectKey)).toEqual(
      current.map((r) => r.effectKey).filter((k) => !ADDED_THIS_RELEASE.includes(k)),
    );
  });

  it('the outgoing rows say what the outgoing release means, column for column', async () => {
    const current = await rowsAt(CURRENT);
    const outgoing = await rowsAt(OUTGOING);
    const policy = (r: Row) => ({
      effectKey: r.effectKey, eventType: r.eventType, invalidate: r.invalidate,
      pushRoles: r.pushRoles, pushFamily: r.pushFamily, frozenAudience: r.frozenAudience,
      requiresPush: r.requiresPush, audience: r.audience, pushBody: r.pushBody,
      pairingRequired: r.pairingRequired,
    });
    // Every column still agrees except the one the divergence declares, and that one is asserted
    // to hold the PREVIOUS release's value rather than merely being excluded from the comparison.
    const expected = current
      .filter((r) => !ADDED_THIS_RELEASE.includes(r.effectKey))
      .map((r) => {
        const p = policy(r);
        const bend = REQUIRES_PUSH_DIVERGENCE.get(r.effectKey);
        return bend === undefined ? p : { ...p, requiresPush: bend };
      });
    expect(outgoing.map(policy)).toEqual(expected);
    for (const [key, value] of REQUIRES_PUSH_DIVERGENCE) {
      const row = outgoing.find((r) => r.effectKey === key);
      expect(row, `the outgoing generation must carry ${key}`).toBeTruthy();
      expect(row!.requiresPush, `${key} must carry the PREVIOUS release's obligation`).toBe(value);
    }
  });

  it('neither generation is born retired — a retired row may not back a new event', async () => {
    for (const v of [CURRENT, OUTGOING]) {
      const rows = await rowsAt(v);
      // presence first, or an absent generation would make this arm vacuously green — which is
      // exactly what it did on the RED measurement of the unfixed head.
      expect(rows.length, `no rows at all for generation ${v}`).toBeGreaterThan(0);
      expect(rows.filter((r) => r.retiredAt !== null), `retired rows at ${v}`).toEqual([]);
    }
  });

  it('THE DRAIN: the envelope seal admits an event emitted under the outgoing generation', async () => {
    // The behaviour the finding is about, driven end to end rather than inferred from the rows:
    // a previous-release process emits its OWN version and the event must COMMIT.
    const org = f.orgA.id;
    const proj = f.projectA.id;

    const emitAt = (version: string, eventId: string) => t.prisma.$transaction(async (tx) => {
      // NOT `ON CONFLICT DO NOTHING`: `platform_t4d_stream_init` is a BEFORE ROW trigger and
      // Postgres fires it before it ever looks for the conflict, so on a project that already
      // holds events the no-op insert raises "allocator cannot be created afresh at 0". The
      // guard has to keep the statement from reaching the trigger at all.
      await tx.$executeRawUnsafe(
        `INSERT INTO "ProjectEventStream" ("projectId","nextPosition")
         SELECT $1, 0 WHERE NOT EXISTS (SELECT 1 FROM "ProjectEventStream" WHERE "projectId" = $1)`,
        proj,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = $1`, proj,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
         SELECT $1,'decision.drafted',1,$2,$3,s."nextPosition" - 1,'system','system:cg','Decision','cg-dec',
                jsonb_build_object('effectKey','decision.drafted','coverageVersion',$4,'invalidate',false)
           FROM "ProjectEventStream" s WHERE s."projectId" = $3`,
        eventId, org, proj, version,
      );
    });

    // the outgoing release's event — this is the write round 8 found refused
    await emitAt(OUTGOING, 'cg-ev-outgoing');
    // and this release's own, unchanged
    await emitAt(CURRENT, 'cg-ev-current');
    // both COMMITTED, and each carries the version its own emitter computed
    const landed = await t.prisma.$queryRawUnsafe<{ eventId: string; v: string }[]>(
      `SELECT "eventId", "dispatchIntent" ->> 'coverageVersion' AS v FROM "DomainEvent"
        WHERE "eventId" IN ('cg-ev-outgoing','cg-ev-current') ORDER BY "eventId"`,
    );
    expect(landed).toEqual([
      { eventId: 'cg-ev-current', v: CURRENT },
      { eventId: 'cg-ev-outgoing', v: OUTGOING },
    ]);
    // while a generation this database never registered stays refused: seeding the drain's
    // predecessor widens the catalog by ONE known version, it does not stop the seal asking.
    await expect(emitAt('0'.repeat(64), 'cg-ev-unknown'))
      .rejects.toThrow(/which this database does not hold/);
  });
});
