import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EXTERNAL_EFFECTS, effectCoverageVersion } from './external-effects';

/**
 * Phase 6 unit 4d-i — the catalog is compiled into the server AND projected as rows, and the two
 * must agree.
 *
 * WHY THE ROWS EXIST AT ALL: `platform_t4d_event_pairing_claimed` asks, of every event, whether
 * an act of that type owes a pairing claim. A trigger has no way to read a TypeScript constant,
 * so the answer lives in `ExternalEffectCatalog`. The moment it does, the compiled catalog and
 * the seeded rows are two copies of one truth — and two copies drift.
 *
 * This tripwire is what stops them. It compares the migration's literal seed against the module
 * itself, so a key added in code without its row, a row that outlives its key, or a changed
 * `eventType` / `invalidate` / push shape fails HERE rather than by silently changing what the
 * seals judge in production.
 *
 * It reads the MIGRATION TEXT, not the database, deliberately: the migration is the artifact
 * that ships, a database can be repaired by hand, and the claim under test is that the file a
 * reviewer reads seeds what the code declares.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
/** 4d-i's seed: the generation the 4d-i release compiled, `pairingRequired` false on every row. */
const MIGRATION_4D_I = join(MIGRATIONS, '20271220000000_phase6_t4d_i_dark_migration', 'migration.sql');
/** 4d-i-b's seed: the pairing generation, the flag true on exactly the plan's six. */
const MIGRATION_4D_I_B = join(MIGRATIONS, '20271224000000_phase6_t4d_i_b_u3_pairing_flip', 'migration.sql');
/** 4d-ii-a / A7d's seed: the three chain types added, the architect in three targeted ceilings, the
 *  two frozen families with their constant bodies. Since Site Visits SV1-a it is the PREVIOUS
 *  generation: this source with the eight site-visit keys removed. */
const MIGRATION_4D_II_A7D = join(MIGRATIONS, '20280104000000_phase6_t4d_ii_a7d_catalog_change', 'migration.sql');
/** Site Visits #792 SV1-a's seed: the generation THIS source compiles — A7d's plus exactly the eight
 *  site-visit keys (invalidate, never push, pairing-required). */
const MIGRATION_SV1A = join(MIGRATIONS, '20280111000000_site_visits_sv1a_catalog', 'migration.sql');
/** Hub #1118 U5m's seed: the NEXT generation, seeded ahead of the code that compiles it — SV1-a's plus
 *  exactly the two Hub keys. U5k compiles them, and then this literal becomes the current one. */
const MIGRATION_HUB_U5M = join(MIGRATIONS, '20280126000000_hub_catalog_generation', 'migration.sql');

/**
 * Phase 6 unit 4d-i-b — TWO LITERALS, TWO GENERATIONS, ONE SOURCE. 4d-i's literal may not be
 * edited (it is a deployed migration), and it is still the seed of a generation a still-serving
 * process emits under, so it is pinned HERE as the PREVIOUS generation: this catalog with the
 * `pairingRequired` element removed from the preimage and the flag false on every row. 4d-i-b's
 * literal is pinned as the current one. A parser that read only the newest file would let the
 * older literal rot exactly as quietly as a single-file parser let a rewording detach it.
 */
const PAIRING_REQUIRED = new Set([
  'decision.approved', 'decision.reapproved',
  'decision.change_requested', 'decision.change_withdrawn',
  'decision.consultation_requested', 'decision.consultation_responded',
]);

/**
 * Phase 6 unit 4d-ii-a / A7d — THREE LITERALS NOW. A7d's generation is what this source compiles;
 * U3's and 4d-i's are still being emitted under through the drain and are pinned here as the two
 * PREVIOUS generations, each DERIVED from this source with the declared bends removed:
 *   - the three keys A7d ADDED are absent from both;
 *   - the `architect` role A7d admitted into three targeted ceilings is absent from both;
 *   - U3's preimage is the six-element one (no `frozenAudience`/`pushBody` elements — no frozen
 *     family existed), 4d-i's the five-element one with the flag false on every row.
 */
const ADDED_BY_A7D = new Set(['decision.forwarded', 'decision.awaiting_countersign', 'membership.standing_changed']);
const WIDENED_BY_A7D = new Set(['decision.published', 'decision.consultation_requested', 'decision.consultation_responded']);

/**
 * Site Visits #792 SV1-a — FOUR LITERALS NOW. SV1-a's generation is what this source compiles; A7d's
 * is pinned as the previous one, DERIVED from this source with the eight keys SV1-a added removed
 * (A7d's eight-element preimage is unchanged). Every older generation lacks them too.
 */
const ADDED_BY_SV1A = new Set([
  'sitevisit.started', 'sitevisit.ended', 'sitevisit.closed', 'sitevisit.late_end_recorded',
  'sitevisit.place_added', 'sitevisit.place_retired', 'sitevisit.attendee_added', 'sitevisit.attendee_retired',
]);

/**
 * Hub #1118 U5m — FIVE LITERALS NOW, and the newest is AHEAD of the source. U5m seeds the generation U5k
 * will compile, so it is DERIVED from this source with the two Hub keys ADDED (the eight-element preimage
 * is unchanged), and the source is asserted NOT to carry them yet. When U5k adds them, `HUB_KEYS` moves
 * into `EXTERNAL_EFFECTS`, the tripwire below fails on purpose, and U5m's literal becomes 'current'.
 */
const HUB_KEYS: Record<string, Def> = {
  'drawing.superseded_hub': { eventType: 'drawing.revised', invalidate: true, push: null },
  'drawing.relinked': { eventType: 'drawing.refiled', invalidate: true, push: null },
};

type Row = {
  coverageVersion: string;
  effectKey: string;
  eventType: string;
  invalidate: boolean;
  push: string[] | null;
  pushFamily: string | null;
  frozenAudience: boolean;
  requiresPush: boolean;
  audience: string | null;
  pushBody: string | null;
  pairingRequired: boolean;
};

/** Parse the seed's VALUES tuples out of a migration, anchored on the named temp table. */
function seededRows(migration: string, seedTable: string): Row[] {
  const sql = readFileSync(migration, 'utf8');
  // #582's review round 9, finding 2 — the literal moved into a TEMP table, which is now the
  // authority the real table is audited against and both generations are seeded from. The parser
  // follows the literal rather than the destination: what this suite checks is that the SEED says
  // what the compiled catalog says, and the seed is the VALUES list wherever it lands.
  const start = sql.indexOf(`INSERT INTO "${seedTable}"`);
  expect(start, 'the migration must carry the catalog seed literal').toBeGreaterThan(-1);
  // #582 round 13 — the end anchor is the literal's own TERMINATOR, not the prose that used to
  // follow it. This parser pinned the audit's opening COMMENT, so rewording that comment (which
  // round 13 did, making the audit total) silently detached the parser from the literal and it
  // read nothing. A tripwire that depends on the wording of a sentence is not a tripwire; the
  // statement's closing `;` at the start of a line is a fact about the SQL.
  const end = sql.indexOf('\n;', start);
  expect(end, 'the seed literal must be terminated').toBeGreaterThan(start);

  const rows: Row[] = [];
  // Eleven columns since Codex round 1 (findings 4 and 5): the key gained `coverageVersion` and
  // the push shape gained the four columns the envelope and transition seals read. The parser
  // pins ALL of them — a tripwire that reads only the columns the first implementation happened
  // to write is the same mistake the round is correcting.
  const re = new RegExp(
    String.raw`^ {2}\('([^']+)', '([^']+)', '([^']+)', (true|false), ` // coverage, key, type, invalidate
    + String.raw`(NULL|'(\[[^\]]*\])'::jsonb), (NULL|'([^']+)'), `      // pushRoles, pushFamily
    + String.raw`(true|false), (true|false), (NULL|'([^']+)'), (NULL|'([^']*)'), `  // frozen, requires, audience, body
    + String.raw`(true|false)\),?$`,                                     // pairingRequired
    'gm',
  );
  const body = sql.slice(start, end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    rows.push({
      coverageVersion: m[1]!,
      effectKey: m[2]!,
      eventType: m[3]!,
      invalidate: m[4] === 'true',
      push: m[5] === 'NULL' ? null : (JSON.parse(m[6]!) as string[]),
      pushFamily: m[7] === 'NULL' ? null : m[8]!,
      frozenAudience: m[9] === 'true',
      requiresPush: m[10] === 'true',
      audience: m[11] === 'NULL' ? null : m[12]!,
      pushBody: m[13] === 'NULL' ? null : m[14]!,
      // Phase 6 unit 4d-i-b — CAPTURED, not skipped. 4d-i's parser matched the flag and threw it
      // away, which was right while every row was false; the moment one literal flips six of
      // them the flag is the whole difference between the two generations.
      pairingRequired: m[15] === 'true',
    });
  }
  return rows;
}

/**
 * The same shape, DERIVED from the compiled catalog exactly as the seed generator derives it.
 * `generation` is CURRENT (this source's six-element preimage, the flag as declared) or PREVIOUS
 * (the five-element preimage the 4d-i release hashed, the flag false everywhere) — the two
 * generations whose literals ship, both derived from ONE source.
 */
type Generation = 'next' | 'current' | 'a7d' | 'pairing' | 'previous';

/** The catalog as a PREVIOUS generation saw it: SV1-a's keys removed; before A7d, A7d's keys removed
 *  and its role widening undone. */
function catalogBefore(generation: Generation): Record<string, Def> {
  const catalog = EXTERNAL_EFFECTS as Record<string, Def>;
  if (generation === 'next') return { ...catalog, ...HUB_KEYS };
  if (generation === 'current') return catalog;
  const out: Record<string, Def> = {};
  for (const k of Object.keys(catalog)) {
    if (ADDED_BY_SV1A.has(k)) continue;
    if (generation === 'a7d') {
      out[k] = catalog[k]!;
      continue;
    }
    if (ADDED_BY_A7D.has(k)) continue;
    const d = catalog[k]!;
    out[k] = WIDENED_BY_A7D.has(k) && d.push !== null ? { ...d, push: d.push.filter((r) => r !== 'architect') } : d;
  }
  return out;
}

type Def = { eventType: string; invalidate: boolean; push: readonly string[] | null; pushFamily?: string; pairingRequired?: true; frozenAudience?: true; pushBody?: string };

function compiledRows(generation: Generation): Row[] {
  const catalog = catalogBefore(generation);
  const coverageVersion = generation === 'current' ? effectCoverageVersion() : previousCoverageVersion(generation);
  return Object.keys(catalog).sort().map((effectKey) => {
    const d = catalog[effectKey]!;
    // #582 round 2, finding 1 — PERMISSION and OBLIGATION are two questions, and deriving the
    // second from the first was a seeding defect that round found: `push !== null` says the key
    // MAY announce; `requiresPush` says the delivered branch ALWAYS does, and the envelope seal
    // refuses a silent event of such a key.
    //
    // THE TWO ARE THE SAME QUESTION AGAIN, and that is round 18's answer rather than a return to
    // the defect. Four keys carried `pushOptional` because one of their branches legitimately
    // stayed quiet — and the exemption released the ANNOUNCING branch with it. Rounds 13 and 18
    // split all four, so every key now has exactly one obligation and `push !== null` IS the
    // obligation. `audience` follows PERMISSION and is unchanged.
    const mayPush = d.push !== null;
    const requiresPush = mayPush;
    // 4d-ii-a / A7d — a FROZEN-audience family (the two chain families) seeds `audience = 'frozen'`
    // with its constant body; the previous generations carried none.
    const frozen = d.frozenAudience === true;
    return {
      coverageVersion,
      effectKey,
      eventType: d.eventType,
      invalidate: d.invalidate,
      push: d.push === null ? null : [...d.push].sort(),
      pushFamily: d.pushFamily ?? null,
      frozenAudience: frozen,
      requiresPush,
      audience: !mayPush ? null : frozen ? 'frozen' : d.pushFamily ? 'targeted' : 'broadcast',
      pushBody: frozen ? d.pushBody ?? null : null,
      pairingRequired: generation === 'previous' ? false : d.pairingRequired === true,
    };
  });
}

/** The 4d-i release's `effectCoverageVersion()`: this catalog's `canonicalCatalog()` without the
 *  sixth element. `phase6-t4d-i-catalog-generations.test.ts` pins the same derivation against
 *  the migration's own `_t4d_catalog_incoming` literal; here it is what the 4d-i literal is
 *  compared to, key by key. */
function previousCoverageVersion(generation: 'next' | 'a7d' | 'pairing' | 'previous'): string {
  const catalog = catalogBefore(generation);
  const preimage = JSON.stringify(Object.keys(catalog).sort().map((k) => {
    const d = catalog[k]!;
    const five = [k, d.eventType, d.invalidate, d.push === null ? null : [...d.push].slice().sort(), d.pushFamily ?? null];
    // SV1-a — A7d's generation is this source's EIGHT-element preimage over its own keys; Hub U5m's
    // NEXT generation is the same preimage over this source's keys plus the two Hub keys.
    if (generation === 'a7d' || generation === 'next') return [...five, d.pairingRequired === true, d.frozenAudience === true, d.pushBody ?? null];
    return generation === 'pairing' ? [...five, d.pairingRequired === true] : five;
  }));
  return createHash('sha256').update(preimage).digest('hex');
}

const GENERATIONS = [
  ['hub U5m (next)', MIGRATION_HUB_U5M, '_hub_catalog_seed', 'next'],
  ['site-visits SV1-a (current)', MIGRATION_SV1A, '_sv1a_catalog_seed', 'current'],
  ['4d-ii-a A7d', MIGRATION_4D_II_A7D, '_t4dii_catalog_seed', 'a7d'],
  ['4d-i-b (pairing)', MIGRATION_4D_I_B, '_t4dib_catalog_seed', 'pairing'],
  ['4d-i (previous)', MIGRATION_4D_I, '_t4d_catalog_seed', 'previous'],
] as const;

describe.each(GENERATIONS)('phase 6 — the %s seeded effect catalog equals the compiled one', (_label, migration, seedTable, generation) => {
  it('seeds EVERY compiled key, and no key the code does not declare', () => {
    const seeded = seededRows(migration, seedTable).map((r) => r.effectKey).sort();
    const compiled = compiledRows(generation).map((r) => r.effectKey);
    // Named difference sets, because "expected 107 to equal 106" tells a reader nothing about
    // WHICH key moved, and this failing is exactly the moment they need to know.
    const missing = compiled.filter((k) => !seeded.includes(k));
    const extra = seeded.filter((k) => !compiled.includes(k));
    expect(missing, 'compiled catalog keys with no seeded row — a new key is a new generation, seeded by its own unit').toEqual([]);
    expect(extra, 'seeded rows for keys the compiled catalog no longer declares — retire them, never delete').toEqual([]);
  });

  it('seeds each key with the coverage version, eventType, invalidate flag, FULL push shape and pairing obligation the code declares', () => {
    const seeded = new Map(seededRows(migration, seedTable).map((r) => [r.effectKey, r]));
    for (const want of compiledRows(generation)) {
      expect(seeded.get(want.effectKey), `no seeded row for ${want.effectKey}`).toEqual(want);
    }
  });

  it('the seed is non-trivial — a parser that matched nothing would pass both checks above', () => {
    // The two comparisons are symmetric, so a regex that silently matched zero rows would make
    // BOTH sides empty and both assertions pass. This is the arm that makes them mean something.
    expect(seededRows(migration, seedTable).length).toBeGreaterThan(50);
    expect(seededRows(migration, seedTable).length).toBe(compiledRows(generation).length);
  });
});

describe('phase 6 unit 4d-i-b — the two literals are two generations of ONE catalog', () => {
  it('the current literal is the previous one with `pairingRequired` flipped on exactly the six', () => {
    const prev = new Map(seededRows(MIGRATION_4D_I, '_t4d_catalog_seed').map((r) => [r.effectKey, r]));
    const cur = seededRows(MIGRATION_4D_I_B, '_t4dib_catalog_seed');
    expect(cur.length).toBe(prev.size);
    for (const row of cur) {
      const before = prev.get(row.effectKey);
      expect(before, `4d-i seeds no row for ${row.effectKey}`).toBeDefined();
      const { coverageVersion: _v, pairingRequired: _p, ...policyNow } = row;
      const { coverageVersion: _u, pairingRequired: wasRequired, ...policyThen } = before!;
      expect(policyNow, `${row.effectKey}: a column other than the flag moved between the two literals`).toEqual(policyThen);
      expect(wasRequired, `${row.effectKey}: 4d-i seeds the flag false everywhere`).toBe(false);
      expect(row.pairingRequired, `${row.effectKey}: the flip is exactly the plan's six`).toBe(PAIRING_REQUIRED.has(row.effectKey));
    }
    expect(cur[0]!.coverageVersion).not.toBe(prev.values().next().value!.coverageVersion);
  });
});

describe('phase 6 unit 4d-ii-a / A7d — the widened literal is U3\'s with exactly the declared bends', () => {
  it('three keys added, `architect` joining three ceilings, two frozen families born with their bodies, nothing else moved', () => {
    const prev = new Map(seededRows(MIGRATION_4D_I_B, '_t4dib_catalog_seed').map((r) => [r.effectKey, r]));
    const cur = seededRows(MIGRATION_4D_II_A7D, '_t4dii_catalog_seed');
    expect(cur.length).toBe(prev.size + ADDED_BY_A7D.size);
    for (const row of cur) {
      const before = prev.get(row.effectKey);
      if (ADDED_BY_A7D.has(row.effectKey)) {
        expect(before, `${row.effectKey} is NEW with A7d`).toBeUndefined();
        expect(row.pairingRequired, `${row.effectKey} is claimed by its fact`).toBe(true);
        expect(row.frozenAudience, `${row.effectKey} frozen ⇔ a chain push family`).toBe(row.effectKey !== 'membership.standing_changed');
        if (row.frozenAudience) {
          expect(row.audience).toBe('frozen');
          expect(row.pushBody).toEqual(expect.any(String));
        } else {
          expect(row).toMatchObject({ push: null, audience: null, pushBody: null, invalidate: true });
        }
        continue;
      }
      expect(before, `U3 seeds no row for ${row.effectKey}`).toBeDefined();
      const { coverageVersion: _v, push: pushNow, ...policyNow } = row;
      const { coverageVersion: _u, push: pushThen, ...policyThen } = before!;
      expect(policyNow, `${row.effectKey}: a column other than the ceiling moved between the two literals`).toEqual(policyThen);
      if (WIDENED_BY_A7D.has(row.effectKey)) {
        expect(pushNow, `${row.effectKey}: the ceiling gained exactly the architect`).toEqual([...pushThen!, 'architect'].sort());
      } else {
        expect(pushNow, `${row.effectKey}: the ceiling did not move`).toEqual(pushThen);
      }
    }
    expect(cur[0]!.coverageVersion).not.toBe(prev.values().next().value!.coverageVersion);
  });
});

describe('site visits #792 SV1-a — the new literal is A7d\'s plus exactly the eight site-visit keys', () => {
  it('eight keys added (invalidate, never push, pairing-required), every shared key equal in every column but the version', () => {
    const prev = new Map(seededRows(MIGRATION_4D_II_A7D, '_t4dii_catalog_seed').map((r) => [r.effectKey, r]));
    const cur = seededRows(MIGRATION_SV1A, '_sv1a_catalog_seed');
    expect(ADDED_BY_SV1A.size).toBe(8);
    expect(cur.length).toBe(prev.size + ADDED_BY_SV1A.size);
    expect(cur.filter((r) => ADDED_BY_SV1A.has(r.effectKey)).map((r) => r.effectKey).sort()).toEqual([...ADDED_BY_SV1A].sort());
    for (const k of prev.keys()) expect(ADDED_BY_SV1A.has(k), `${k} already existed at A7d`).toBe(false);
    const versions = new Set(cur.map((r) => r.coverageVersion));
    expect(versions.size, 'one literal is one generation').toBe(1);
    for (const row of cur) {
      const before = prev.get(row.effectKey);
      if (ADDED_BY_SV1A.has(row.effectKey)) {
        expect(before, `${row.effectKey} is NEW with SV1-a`).toBeUndefined();
        expect(row).toEqual({
          coverageVersion: row.coverageVersion,
          effectKey: row.effectKey,
          eventType: row.effectKey,
          invalidate: true,
          push: null,
          pushFamily: null,
          frozenAudience: false,
          requiresPush: false,
          audience: null,
          pushBody: null,
          pairingRequired: true,
        });
        continue;
      }
      expect(before, `A7d seeds no row for ${row.effectKey}`).toBeDefined();
      const { coverageVersion: _v, ...policyNow } = row;
      const { coverageVersion: _u, ...policyThen } = before!;
      expect(policyNow, `${row.effectKey}: a shared key moved between A7d and SV1-a`).toEqual(policyThen);
    }
    expect(cur[0]!.coverageVersion).not.toBe(prev.values().next().value!.coverageVersion);
    expect(cur[0]!.coverageVersion).toBe(effectCoverageVersion());
    expect(prev.values().next().value!.coverageVersion).toBe('23f47cd9d64db48a60afff7456337197c8711cb0d8a07954a66e7a28972c5b0c');
  });
});

describe('hub #1118 U5m — the next literal is SV1-a\'s plus exactly the two Hub keys, seeded ahead of the code', () => {
  it('two keys added (an existing drawing event type, invalidate, never push, no pairing claim), every shared key equal in every column but the version', () => {
    const prev = new Map(seededRows(MIGRATION_SV1A, '_sv1a_catalog_seed').map((r) => [r.effectKey, r]));
    const next = seededRows(MIGRATION_HUB_U5M, '_hub_catalog_seed');
    expect(Object.keys(HUB_KEYS)).toHaveLength(2);
    expect(next.length).toBe(prev.size + 2);
    expect(next.filter((r) => !prev.has(r.effectKey)).map((r) => r.effectKey).sort()).toEqual(Object.keys(HUB_KEYS).sort());
    expect(new Set(next.map((r) => r.coverageVersion)).size, 'one literal is one generation').toBe(1);
    for (const row of next) {
      const before = prev.get(row.effectKey);
      const hub = HUB_KEYS[row.effectKey];
      if (hub) {
        expect(before, `${row.effectKey} is NEW with U5m`).toBeUndefined();
        expect(row).toEqual({
          coverageVersion: row.coverageVersion,
          effectKey: row.effectKey,
          eventType: hub.eventType,
          invalidate: true,
          push: null,
          pushFamily: null,
          frozenAudience: false,
          requiresPush: false,
          audience: null,
          pushBody: null,
          pairingRequired: false,
        });
        // the event type is one the catalog already carries, so the projection rule does not move
        expect(Object.values(EXTERNAL_EFFECTS as Record<string, Def>).some((d) => d.eventType === hub.eventType)).toBe(true);
        continue;
      }
      expect(before, `SV1-a seeds no row for ${row.effectKey}`).toBeDefined();
      const { coverageVersion: _v, ...policyNow } = row;
      const { coverageVersion: _u, ...policyThen } = before!;
      expect(policyNow, `${row.effectKey}: a shared key moved between SV1-a and U5m`).toEqual(policyThen);
    }
    expect(next[0]!.coverageVersion).toBe('63679450ab65f2bff678bdce792ab0afd591606fe895963923d1a0aa52e20848');
    expect(prev.values().next().value!.coverageVersion).toBe(effectCoverageVersion());
  });

  it('this release does NOT compile the Hub keys yet — U5k does, and that change must turn U5m\'s literal into the current one', () => {
    // The tripwire for the hand-over: the day a Hub key lands in `EXTERNAL_EFFECTS`, the compiled version
    // must equal U5m's seeded one (or the envelope seal refuses every event of that release), and this
    // suite must be re-pointed: 'next' becomes 'current', SV1-a's becomes the previous generation.
    for (const k of Object.keys(HUB_KEYS)) expect(k in EXTERNAL_EFFECTS, `${k} is compiled already`).toBe(false);
    expect(previousCoverageVersion('next')).not.toBe(effectCoverageVersion());
  });
});
