import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';

/**
 * Phase 5 Task 5A — the SEED RESET IS CLOSED UNDER INBOUND FOREIGN KEYS.
 *
 * `prisma/seed.ts` resets the shared e2e database with a bare `TRUNCATE TABLE a, b, c` — no
 * `CASCADE`, deliberately, because CASCADE would silently delete rows nobody listed and hide
 * exactly the kind of coupling this file is about. PostgreSQL therefore refuses the statement
 * outright when a table NOT in the list has a foreign key into one that is:
 *
 *   HINT: Truncate table "BillVerification" at the same time, or use TRUNCATE ... CASCADE.
 *
 * That refusal is correct and it is also invisible until the e2e suite runs — a full CI job, minutes
 * later, in a file the author of the new table never opened. This test moves the failure to the
 * moment the table is added, and states the rule ONCE instead of asking each author to remember it.
 *
 * **Why a test rather than a hand-kept list.** Adding a table with an FK into the reset set has now
 * broken this reset four times across Phases 4 and 5, each time fixed by appending one more name.
 * A list that must be edited by hand is a list that will be one entry short again; the closure is
 * derived from the DMMF, so a table added tomorrow is covered without anyone editing anything.
 */
describe('Phase 5 Task 5A — the seed reset is closed under inbound foreign keys', () => {
  /** Every table named in `seed.ts`'s TRUNCATE, in DMMF (model) terms. */
  const truncated = (): Set<string> => {
    const seed = readFileSync(join(__dirname, '../../../prisma/seed.ts'), 'utf8');
    const statement = seed.match(/TRUNCATE TABLE ([^']+)/u);
    expect(statement, 'seed.ts must contain a TRUNCATE TABLE reset').toBeTruthy();
    return new Set(
      [...statement![1]!.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((m) => m[1]!),
    );
  };

  /**
   * For each model, the models that hold a foreign key INTO it. Derived from the DMMF's relation
   * fields: the side carrying `relationFromFields` is the side with the FK column.
   */
  const inboundReferences = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        if (field.kind !== 'object') continue;
        const from = field.relationFromFields ?? [];
        if (from.length === 0) continue; // the other side owns the FK
        const target = field.type;
        if (target === model.name) continue; // self-reference truncates with itself
        out.set(target, [...(out.get(target) ?? []), model.name]);
      }
    }
    return out;
  };

  it('every table with a foreign key INTO the reset set is itself in the reset set', () => {
    const listed = truncated();
    const inbound = inboundReferences();
    const missing: string[] = [];
    for (const table of listed) {
      for (const referrer of inbound.get(table) ?? []) {
        if (!listed.has(referrer)) missing.push(`${referrer} → ${table}`);
      }
    }
    expect(
      [...new Set(missing)].sort(),
      'PostgreSQL refuses a bare TRUNCATE when an unlisted table references a listed one. '
      + 'Add the referring table to the TRUNCATE in prisma/seed.ts (and to the per-suite lists that '
      + 'mirror it) rather than reaching for CASCADE, which would delete rows nobody declared.',
    ).toEqual([]);
  });

  it('names a real table set, so the check cannot pass by matching nothing', () => {
    // The precision half of the rule this repository already states: a check that only ever passes
    // is not shown to be checking. If the parse breaks, `truncated()` returns an empty set and the
    // assertion above is vacuously true — so the set is asserted to be substantial and to contain a
    // model the DMMF actually knows.
    const listed = truncated();
    expect(listed.size).toBeGreaterThan(5);
    const known = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));
    for (const table of listed) expect(known.has(table), `${table} is not a Prisma model`).toBe(true);
  });
});
