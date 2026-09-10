import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

const MIGRATION = join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20271220000000_phase6_t4d_i_dark_migration', 'migration.sql',
);

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
};

/** Parse the seed's VALUES tuples out of the migration. */
function seededRows(): Row[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  // #582's review round 9, finding 2 — the literal moved into a TEMP table, which is now the
  // authority the real table is audited against and both generations are seeded from. The parser
  // follows the literal rather than the destination: what this suite checks is that the SEED says
  // what the compiled catalog says, and the seed is the VALUES list wherever it lands.
  const start = sql.indexOf('INSERT INTO "_t4d_catalog_seed"');
  expect(start, 'the migration must carry the catalog seed literal').toBeGreaterThan(-1);
  const end = sql.indexOf('-- ANY ROW ALREADY AT ONE OF THESE KEYS', start);
  expect(end, 'the seed literal must be followed by its conflict audit').toBeGreaterThan(start);

  const rows: Row[] = [];
  // Eleven columns since Codex round 1 (findings 4 and 5): the key gained `coverageVersion` and
  // the push shape gained the four columns the envelope and transition seals read. The parser
  // pins ALL of them — a tripwire that reads only the columns the first implementation happened
  // to write is the same mistake the round is correcting.
  const re = new RegExp(
    String.raw`^ {2}\('([^']+)', '([^']+)', '([^']+)', (true|false), ` // coverage, key, type, invalidate
    + String.raw`(NULL|'(\[[^\]]*\])'::jsonb), (NULL|'([^']+)'), `      // pushRoles, pushFamily
    + String.raw`(true|false), (true|false), (NULL|'([^']+)'), (NULL|'([^']*)'), `  // frozen, requires, audience, body
    + String.raw`(?:true|false)\),?$`,                                   // pairingRequired
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
    });
  }
  return rows;
}

/** The same shape, DERIVED from the compiled catalog exactly as the seed generator derives it. */
function compiledRows(): Row[] {
  const catalog = EXTERNAL_EFFECTS as Record<string, { eventType: string; invalidate: boolean; push: readonly string[] | null; pushFamily?: string; pushOptional?: true }>;
  const coverageVersion = effectCoverageVersion();
  return Object.keys(catalog).sort().map((effectKey) => {
    const d = catalog[effectKey]!;
    // #582 round 2, finding 1 — PERMISSION and OBLIGATION are two questions, and deriving the
    // second from the first was a seeding defect this round found: `push !== null` says the key
    // MAY announce; `requiresPush` says the delivered branch ALWAYS does, and the envelope seal
    // refuses a silent event of such a key. Four keys carry `pushOptional` because one delivered
    // branch legitimately stays quiet; seeding them `requiresPush: true` would have aborted
    // those four live emit paths at INSERT. `audience` follows PERMISSION, so a key that may
    // push always declares the shape its pushes must take, silent branch or not.
    const mayPush = d.push !== null;
    const requiresPush = mayPush && d.pushOptional !== true;
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
    };
  });
}

describe('phase 6 unit 4d-i — the seeded effect catalog equals the compiled one', () => {
  it('seeds EVERY compiled key, and no key the code does not declare', () => {
    const seeded = seededRows().map((r) => r.effectKey).sort();
    const compiled = compiledRows().map((r) => r.effectKey);
    // Named difference sets, because "expected 107 to equal 106" tells a reader nothing about
    // WHICH key moved, and this failing is exactly the moment they need to know.
    const missing = compiled.filter((k) => !seeded.includes(k));
    const extra = seeded.filter((k) => !compiled.includes(k));
    expect(missing, 'compiled catalog keys with no seeded row — add them to the 4d-i seed').toEqual([]);
    expect(extra, 'seeded rows for keys the compiled catalog no longer declares — retire them, never delete').toEqual([]);
  });

  it('seeds each key with the coverage version, eventType, invalidate flag and FULL push shape the code declares', () => {
    const seeded = new Map(seededRows().map((r) => [r.effectKey, r]));
    for (const want of compiledRows()) {
      expect(seeded.get(want.effectKey), `no seeded row for ${want.effectKey}`).toEqual(want);
    }
  });

  it('the seed is non-trivial — a parser that matched nothing would pass both checks above', () => {
    // The two comparisons are symmetric, so a regex that silently matched zero rows would make
    // BOTH sides empty and both assertions pass. This is the arm that makes them mean something.
    expect(seededRows().length).toBeGreaterThan(50);
    expect(seededRows().length).toBe(compiledRows().length);
  });
});
