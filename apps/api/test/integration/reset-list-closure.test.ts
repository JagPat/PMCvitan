import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';

/**
 * Phase 6 unit 4d-i — the seed's TRUNCATE lists are CLOSED under "is referenced by".
 *
 * WHY THIS EXISTS. PostgreSQL refuses to truncate a table that a foreign key references unless
 * every referencing table is named in the SAME statement. `ON DELETE CASCADE` does not exempt it:
 * TRUNCATE is a statement, not a row delete, and the rule looks at the reference. So a migration
 * that adds one FK onto a table the seed truncates silently breaks the seed — and only the seed.
 *
 * HOW IT WAS FOUND, which is the point. The integration suites reach `sanctionedReset` with
 * `{ cascade: true }`, which papers the omission over completely; a full green integration run
 * says nothing about it. `prisma/seed.ts` passes no `cascade`, and `pnpm test:e2e:api` runs the
 * seed — so the first signal was a red `api-e2e` check on CI, naming ONE missing table at a time,
 * because PostgreSQL reports the first violation and stops. 4d-i added FIVE such references
 * (`Notification.eventId` and `DomainEventPairingClaim` onto `DomainEvent`;
 * `ChangeRequest.revisionId` and the two chain facts onto `DecisionApprovalRevision`) — five CI
 * rounds if the only oracle is CI.
 *
 * WHY IT READS `pg_constraint` AND NOT THE PRISMA SCHEMA. The first draft of this suite computed
 * the closure from the DMMF and PASSED against the broken seed, which is worse than no tripwire:
 * `Notification.eventId` is a plain `String?` in `schema.prisma` with the foreign key declared in
 * the migration SQL alone, so the DMMF cannot see it and the check was vacuous for exactly the
 * cases that had just broken CI. It was driven against the pre-fix seed, seen to pass, and
 * rewritten to ask the DATABASE — which is where the constraint actually lives.
 *
 * It reads the LIST TEXT out of `prisma/seed.ts` rather than importing the seed, because importing
 * it would run it.
 */

const SEED = join(__dirname, '..', '..', 'prisma', 'seed.ts');

/** The named `const <NAME> = [...] as const;` array literal, as plain strings. */
function resetList(name: string): string[] {
  const text = readFileSync(SEED, 'utf8');
  const start = text.indexOf(`const ${name} = [`);
  expect(start, `prisma/seed.ts must declare ${name}`).toBeGreaterThan(-1);
  const end = text.indexOf('] as const;', start);
  expect(end, `${name} must end with its \`] as const;\``).toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]!);
}

describe('the seed\'s TRUNCATE lists are closed under foreign-key references (live PG)', () => {
  let t: TestApp;
  /** referenced table → the tables carrying a foreign key onto it, as PostgreSQL holds it. */
  let refs: Map<string, Set<string>>;

  beforeAll(async () => {
    t = await createTestApp();
    const rows = await t.prisma.$queryRaw<Array<{ parent: string; child: string }>>`
      SELECT c.confrelid::regclass::text AS parent, c.conrelid::regclass::text AS child
        FROM pg_constraint c
       WHERE c.contype = 'f'`;
    refs = new Map();
    for (const { parent, child } of rows) {
      const p = parent.replace(/"/g, '');
      const ch = child.replace(/"/g, '');
      if (!refs.has(p)) refs.set(p, new Set());
      refs.get(p)!.add(ch);
    }
  });

  afterAll(async () => { await t?.close(); });

  it('the database actually declares references — an empty map would make every list vacuously closed', () => {
    expect(refs.size).toBeGreaterThan(20);
    expect(refs.get('DomainEvent'), 'DomainEvent is referenced by the outbox at minimum').toBeDefined();
    expect(refs.get('DomainEvent')!.has('OutboxDelivery')).toBe(true);
    // and the SQL-only foreign key the DMMF cannot see, which is the reason this suite is here
    expect(
      refs.get('DomainEvent')!.has('Notification'),
      'Notification.eventId is declared in the migration SQL, not as a Prisma relation — if this '
      + 'is false the query is wrong and every assertion below is vacuous',
    ).toBe(true);
  });

  for (const listName of ['RESET_EVENTS', 'RESET_TABLES'] as const) {
    it(`${listName} names every table that references one of its members`, () => {
      const list = resetList(listName);
      expect(list.length, `${listName} must parse to a non-empty list`).toBeGreaterThan(5);
      const inList = new Set(list);

      const missing: string[] = [];
      for (const parent of list) {
        for (const child of refs.get(parent) ?? []) {
          if (child !== parent && !inList.has(child)) missing.push(`${child} (references ${parent})`);
        }
      }

      expect(
        [...new Set(missing)].sort(),
        `these tables carry a foreign key onto a table ${listName} truncates, and PostgreSQL `
        + 'refuses to truncate a referenced table unless every referencing table is named in the '
        + 'SAME statement — ON DELETE CASCADE does not exempt them. Add each to '
        + `${listName} in prisma/seed.ts, and give it a TRUNCATE_SEALS entry in `
        + 'prisma/sanctioned-reset.ts if it carries a no-TRUNCATE seal. The other integration '
        + 'suites pass `{ cascade: true }` and will NOT catch this; the seed does not, so without '
        + 'this arm the only signal is a red api-e2e check on CI, one missing table per round.',
      ).toEqual([]);
    });
  }
});
