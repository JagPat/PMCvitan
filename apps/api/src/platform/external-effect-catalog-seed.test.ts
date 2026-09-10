import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTERNAL_EFFECTS } from './external-effects';

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

type Row = { effectKey: string; eventType: string; invalidate: boolean; push: string[] | null; pushFamily: string | null };

/** Parse the seed's VALUES tuples out of the migration. */
function seededRows(): Row[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const start = sql.indexOf('INSERT INTO "ExternalEffectCatalog"');
  expect(start, 'the migration must carry the catalog seed').toBeGreaterThan(-1);
  const end = sql.indexOf('ON CONFLICT ("effectKey") DO NOTHING;', start);
  expect(end, 'the seed must end with its ON CONFLICT clause').toBeGreaterThan(start);

  const rows: Row[] = [];
  const re = /^ {2}\('([^']+)', '([^']+)', (true|false), (NULL|'(\[[^\]]*\])'::jsonb), (NULL|'([^']+)')\),?$/gm;
  const body = sql.slice(start, end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    rows.push({
      effectKey: m[1]!,
      eventType: m[2]!,
      invalidate: m[3] === 'true',
      push: m[4] === 'NULL' ? null : (JSON.parse(m[5]!) as string[]),
      pushFamily: m[6] === 'NULL' ? null : m[7]!,
    });
  }
  return rows;
}

/** The same shape, read off the compiled catalog. */
function compiledRows(): Row[] {
  const catalog = EXTERNAL_EFFECTS as Record<string, { eventType: string; invalidate: boolean; push: readonly string[] | null; pushFamily?: string }>;
  return Object.keys(catalog).sort().map((effectKey) => {
    const d = catalog[effectKey]!;
    return {
      effectKey,
      eventType: d.eventType,
      invalidate: d.invalidate,
      push: d.push === null ? null : [...d.push].sort(),
      pushFamily: d.pushFamily ?? null,
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

  it('seeds each key with the eventType, invalidate flag and push shape the code declares', () => {
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
