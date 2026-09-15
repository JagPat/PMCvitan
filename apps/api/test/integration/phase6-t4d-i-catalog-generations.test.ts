import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { EXTERNAL_EFFECTS, effectCoverageVersion } from '../../src/platform/external-effects';

/**
 * Phase 6 units 4d-i and 4d-i-b — THE COEXISTING COVERAGE GENERATIONS (#582's review round 8,
 * finding 3; §D's 4d-i-b bullet).
 *
 * WHAT BROKE. `DomainEvent_t4d_envelope` resolves an event's intent by the EXACT
 * `(coverageVersion, effectKey)` pair and raises "which this database does not hold" on a miss —
 * and it does so from the moment 4d-i commits, with no dark window for the intent. A rolling
 * deploy therefore has previous-release processes still emitting under the version THEY compute.
 * With a single generation seeded, every one of those events is refused: not a dark rollout but
 * an outage lasting the whole drain. So ANY migration that changes `effectCoverageVersion()` must
 * seed beside the generations still being emitted, never over them.
 *
 * THREE GENERATIONS NOW, and each is DERIVED from this source rather than transcribed:
 *
 *   · OUTGOING `6313b00c…` — the pre-4d-i release: the five-element preimage over this catalog
 *     minus the keys 4d-i added, with the DECLARED policy divergence below (rounds 13 and 18).
 *   · PRIOR `842cc9fc…` — the 4d-i release: the same five-element preimage over the whole key set.
 *     4d-i seeded it with `pairingRequired` false on every row and named it
 *     `_t4d_catalog_incoming`.
 *   · CURRENT — the 4d-i-b release: the SIX-element preimage, `pairingRequired` normalised to a
 *     boolean as the sixth element, `true` on exactly the plan's six types. 4d-i-b seeds it
 *     BESIDE the prior one, every other column of every key equal, and it is the ONE successor
 *     shape 4d-i's `_t4d_catalog_successor` derivation admits.
 *
 * WHAT THIS SUITE HOLDS. `licences the seeds` RE-DERIVES all three from source on every run, so
 * neither migration's literal can outlive its proof: a key added without its row, a policy that
 * moved without being declared, or a seventh flip changes a hash and fails here. The rest reads
 * the live table and drives the envelope seal end to end under each generation.
 */

/** The version this source computes — the generation a CURRENT writer emits under. */
const CURRENT = effectCoverageVersion();

/**
 * The generation 4d-i compiled, as 4d-i's migration names it. Not transcribed from the deployed
 * database: it is `canonicalCatalog()` over this same catalog WITHOUT the `pairingRequired`
 * element, which is precisely what the 4d-i release's `canonicalCatalog()` emitted — 4d-i-b
 * flipped six keys and joined the flag to the preimage, and nothing else about the catalog moved.
 * Read out of 4d-i's migration text rather than retyped, so a probe can never assert against a
 * constant the file stopped using; `licences the seeds` asserts the derivation agrees.
 */
const PRIOR = (() => {
  const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations',
    '20271220000000_phase6_t4d_i_dark_migration', 'migration.sql'), 'utf8');
  const m = sql.match(/INSERT INTO "_t4d_catalog_incoming" \("v"\) VALUES \('([0-9a-f]{64})'\)/);
  if (!m) throw new Error('the 4d-i incoming coverage generation could not be read from its migration');
  return m[1]!;
})();

/**
 * The outgoing generation, as the migration names it: `canonicalCatalog()` over this same catalog
 * with the keys 4d-i ADDED removed and no `pairingRequired` element, which is what the pre-4d-i
 * release's `canonicalCatalog()` emitted.
 */
const OUTGOING = '6313b00c54f0ecfbc8798e88d77bc025faa6d30367921127181653d42b0cbca7';

/** Phase 6 unit 4d-i-b — the SIX types the switch-on flips, and no seventh (§D (c)). */
const PAIRING_REQUIRED = [
  'decision.approved', 'decision.reapproved',
  'decision.change_requested', 'decision.change_withdrawn',
  'decision.consultation_requested', 'decision.consultation_responded',
];

/**
 * THE DECLARED DIVERGENCE between the outgoing and the prior generations (#582 rounds 13 and 18).
 *
 * Round 13 split `activity.created`; round 18 split the other three keys that carried the same
 * flag, which exhausts the class — the flag is gone, so no fifth key can be in this state. For
 * each, the previous release has ONE key carrying the push exemption and this release has two:
 * the original, which now OWES its announcement, and a `push: null` sibling for the branch that
 * legitimately says nothing.
 *
 * The divergence is declared in ONE place, here and in the migration's seed, so the licence stays
 * a DERIVATION rather than becoming a pinned constant nobody can check. Only the ADDED KEYS are
 * hash-affecting: the previous release's preimage never contained the `pushOptional` element, so
 * removing it restores the same five-element tuple and reproduces the outgoing version exactly.
 */
const ADDED_BY_4D_I = [
  'activity.created.init',          // round 13, finding 3
  'decision.published.record',      // round 18, finding 1
  'inspection.created.init',        // round 18, finding 2
  'inspection.approved.closing',    // round 18, finding 3
];

/**
 * Keys whose `requiresPush` the outgoing release computed differently, because there it is ONE key
 * carrying `pushOptional` — a silent branch and an announcing branch under one obligation. Each
 * entry is a REAL policy divergence, not a preimage difference, and that is why the outgoing
 * generation must be seeded with `FALSE` here rather than copied from a later release's rows.
 */
const REQUIRES_PUSH_DIVERGENCE = new Map<string, boolean>([
  ['activity.created', false],
  ['decision.published', false],
  ['inspection.created', false],
  ['inspection.approved', false],
]);

type Def = { eventType: string; invalidate: boolean; push: readonly string[] | null; pushFamily?: string; pairingRequired?: true };

/**
 * `canonicalCatalog()`, replicated with two knobs: keys to skip, and whether the sixth
 * (`pairingRequired`) element is present. Five elements is the shape both earlier releases
 * hashed; six is this one's. The knobs are what make each generation a DERIVATION of this source.
 */
function canonical(skip: readonly string[] = [], withPairing = false): string {
  const keys = Object.keys(EXTERNAL_EFFECTS).filter((k) => !skip.includes(k)).sort();
  return JSON.stringify(
    keys.map((k) => {
      const d = (EXTERNAL_EFFECTS as Record<string, Def>)[k]!;
      const five = [k, d.eventType, d.invalidate, d.push === null ? null : [...d.push].slice().sort(), d.pushFamily ?? null];
      return withPairing ? [...five, d.pairingRequired === true] : five;
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

describe('phase 6 4d-i / 4d-i-b — the catalog carries every generation still being emitted', () => {
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
  const policy = (r: Row) => ({
    effectKey: r.effectKey, eventType: r.eventType, invalidate: r.invalidate,
    pushRoles: r.pushRoles, pushFamily: r.pushFamily, frozenAudience: r.frozenAudience,
    requiresPush: r.requiresPush, audience: r.audience, pushBody: r.pushBody,
    pairingRequired: r.pairingRequired,
  });

  it('licences the seeds — all three generations fall out of THIS catalog, and only the declared bends separate them', () => {
    // 4d-i-b's generation: the six-element preimage, which is what `effectCoverageVersion()` is.
    expect(sha(canonical([], true))).toBe(CURRENT);
    // 4d-i's generation: the same catalog, five elements. The flag's normalisation is what makes
    // "remove the element" reproduce the older preimage exactly.
    expect(sha(canonical([], false))).toBe(PRIOR);
    // the pre-4d-i generation: five elements, minus the keys 4d-i added.
    expect(sha(canonical(ADDED_BY_4D_I, false))).toBe(OUTGOING);
    expect(new Set([CURRENT, PRIOR, OUTGOING]).size, 'three DISTINCT generations').toBe(3);
    // and the flip is EXACTLY the plan's six — a seventh flag, or a missing one, moves CURRENT
    // and fails the first assertion; this arm says WHICH key did it.
    const flagged = Object.entries(EXTERNAL_EFFECTS as Record<string, Def>)
      .filter(([, d]) => d.pairingRequired === true).map(([k]) => k).sort();
    expect(flagged).toEqual([...PAIRING_REQUIRED].sort());
  });

  it('seeds ALL THREE generations, over the right key sets', async () => {
    const current = await rowsAt(CURRENT);
    const prior = await rowsAt(PRIOR);
    const outgoing = await rowsAt(OUTGOING);

    expect(current.length, `no rows at the current generation ${CURRENT}`).toBeGreaterThan(0);
    expect(current.length).toBe(Object.keys(EXTERNAL_EFFECTS).length);
    // 4d-i-b extends 4d-i's generation over the SAME keys, both directions
    expect(prior.map((r) => r.effectKey)).toEqual(current.map((r) => r.effectKey));
    // A generation seeded PARTIALLY is worse than one not seeded at all: the drain would then
    // reject exactly the keys nobody thought to copy, and only for the events that use them. The
    // outgoing set is the key set minus what 4d-i added — asserted as that subtraction, so a key
    // going missing for any OTHER reason still fails.
    expect(outgoing.map((r) => r.effectKey)).toEqual(
      current.map((r) => r.effectKey).filter((k) => !ADDED_BY_4D_I.includes(k)),
    );
  });

  it('4d-i-b: the current generation is the prior one with `pairingRequired` flipped on EXACTLY the six, column for column', async () => {
    const current = await rowsAt(CURRENT);
    const prior = await rowsAt(PRIOR);
    // every column but the flag equal — the shape 4d-i's `_t4d_catalog_successor` admits and
    // nothing else; asserted from the live rows, not from the literal.
    expect(current.map(policy)).toEqual(prior.map((r) => ({
      ...policy(r), pairingRequired: PAIRING_REQUIRED.includes(r.effectKey),
    })));
    expect(prior.filter((r) => r.pairingRequired).map((r) => r.effectKey),
      '4d-i seeds the flag false on every row').toEqual([]);
    expect(current.filter((r) => r.pairingRequired).map((r) => r.effectKey).sort())
      .toEqual([...PAIRING_REQUIRED].sort());
  });

  it('the outgoing rows say what the outgoing release means, column for column', async () => {
    const prior = await rowsAt(PRIOR);
    const outgoing = await rowsAt(OUTGOING);
    // Every column still agrees with 4d-i's generation except the one the divergence declares,
    // and that one is asserted to hold the PREVIOUS release's value rather than merely being
    // excluded from the comparison. (The flag is false in both: the outgoing release has none.)
    const expected = prior
      .filter((r) => !ADDED_BY_4D_I.includes(r.effectKey))
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

  it('no generation is born retired — a retired row may not back a new event', async () => {
    for (const v of [CURRENT, PRIOR, OUTGOING]) {
      const rows = await rowsAt(v);
      // presence first, or an absent generation would make this arm vacuously green — which is
      // exactly what it did on the RED measurement of the unfixed head.
      expect(rows.length, `no rows at all for generation ${v}`).toBeGreaterThan(0);
      expect(rows.filter((r) => r.retiredAt !== null), `retired rows at ${v}`).toEqual([]);
    }
  });

  it('THE DRAIN: the envelope seal admits an event emitted under every seeded generation, and only those', async () => {
    // The behaviour the finding is about, driven end to end rather than inferred from the rows:
    // a previous-release process emits its OWN version and the event must COMMIT. A key that is
    // `pairingRequired` at none of the three, so the pairing seal asks nothing here.
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
    // the 4d-i release's, still serving through 4d-i-b's own drain
    await emitAt(PRIOR, 'cg-ev-prior');
    // and this release's own
    await emitAt(CURRENT, 'cg-ev-current');
    // all COMMITTED, and each carries the version its own emitter computed
    const landed = await t.prisma.$queryRawUnsafe<{ eventId: string; v: string }[]>(
      `SELECT "eventId", "dispatchIntent" ->> 'coverageVersion' AS v FROM "DomainEvent"
        WHERE "eventId" IN ('cg-ev-outgoing','cg-ev-prior','cg-ev-current') ORDER BY "eventId"`,
    );
    expect(landed).toEqual([
      { eventId: 'cg-ev-current', v: CURRENT },
      { eventId: 'cg-ev-outgoing', v: OUTGOING },
      { eventId: 'cg-ev-prior', v: PRIOR },
    ]);
    // while a generation this database never registered stays refused: seeding the drain's
    // predecessors widens the catalog by KNOWN versions, it does not stop the seal asking.
    await expect(emitAt('0'.repeat(64), 'cg-ev-unknown'))
      .rejects.toThrow(/which this database does not hold/);
  });

  it('4d-i-b: the SWITCH-ON is a property of the generation, not of the key — the same type is unclaimed-admitted at the prior generation and refused at the current one', async () => {
    const org = f.orgA.id;
    const proj = f.projectA.id;
    // An UNCLAIMED `decision.change_requested` — the shape the pairing seal exists to refuse.
    // Nothing else in this transaction: no request, no transition, no claimant.
    const unclaimedAt = (version: string, eventId: string) => t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = $1`, proj,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
         SELECT $1,'decision.change_requested',1,$2,$3,s."nextPosition" - 1,'system','system:cg','Decision','cg-dec',
                jsonb_build_object('effectKey','decision.change_requested','coverageVersion',$4,'invalidate',true)
           FROM "ProjectEventStream" s WHERE s."projectId" = $3`,
        eventId, org, proj, version,
      );
    });
    // a still-serving 4d-i process emits under its own generation, where the flag is false: the
    // mechanism is dark for it, exactly as 4d-i left it, so the drain stays open.
    await unclaimedAt(PRIOR, 'cg-ev-unclaimed-prior');
    // a current writer emits under the switched-on generation: the same event, unclaimed, is an
    // effect with no act behind it, and the kernel's seal refuses it at commit.
    await expect(unclaimedAt(CURRENT, 'cg-ev-unclaimed-current'))
      .rejects.toThrow(/requires a pairing claim and none was made/);
  });
});
