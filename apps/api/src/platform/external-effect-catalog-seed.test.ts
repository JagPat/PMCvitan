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
/** 4d-i-b's seed: the generation THIS source compiles, the flag true on exactly the plan's six. */
const MIGRATION_4D_I_B = join(MIGRATIONS, '20271222000000_phase6_t4d_i_b_pairing_switch_on', 'migration.sql');

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
function compiledRows(generation: 'current' | 'previous'): Row[] {
  const catalog = EXTERNAL_EFFECTS as Record<string, { eventType: string; invalidate: boolean; push: readonly string[] | null; pushFamily?: string; pairingRequired?: true }>;
  const coverageVersion = generation === 'current' ? effectCoverageVersion() : previousCoverageVersion();
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
    return {
      coverageVersion,
      effectKey,
      eventType: d.eventType,
      invalidate: d.invalidate,
      push: d.push === null ? null : [...d.push].sort(),
      pushFamily: d.pushFamily ?? null,
      // nothing compiled today is a frozen-audience family — those are 4d-ii's — so every seeded
      // row is false and carries no constant body.
      frozenAudience: false,
      requiresPush,
      audience: !mayPush ? null : d.pushFamily ? 'targeted' : 'broadcast',
      pushBody: null,
      pairingRequired: generation === 'current' ? d.pairingRequired === true : false,
    };
  });
}

/** The 4d-i release's `effectCoverageVersion()`: this catalog's `canonicalCatalog()` without the
 *  sixth element. `phase6-t4d-i-catalog-generations.test.ts` pins the same derivation against
 *  the migration's own `_t4d_catalog_incoming` literal; here it is what the 4d-i literal is
 *  compared to, key by key. */
function previousCoverageVersion(): string {
  const catalog = EXTERNAL_EFFECTS as Record<string, { eventType: string; invalidate: boolean; push: readonly string[] | null; pushFamily?: string }>;
  const preimage = JSON.stringify(Object.keys(catalog).sort().map((k) => {
    const d = catalog[k]!;
    return [k, d.eventType, d.invalidate, d.push === null ? null : [...d.push].slice().sort(), d.pushFamily ?? null];
  }));
  return createHash('sha256').update(preimage).digest('hex');
}

const GENERATIONS = [
  ['4d-i-b (current)', MIGRATION_4D_I_B, '_t4dib_catalog_seed', 'current'],
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
