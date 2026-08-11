import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestApp, type TestApp } from './test-app';

/**
 * The Prisma schema and the applied migration describe the SAME database, and when they disagree
 * the schema wins the next time anyone runs `prisma migrate dev` — silently reverting whatever
 * the hand-written migration added.
 *
 * This is a real failure, not a hypothetical. Phase 6 unit 6.1a added
 * `ExternalParty_promotedOrgId_fkey` and switched the binding's party key to `ON UPDATE CASCADE`
 * in SQL, and left `schema.prisma` describing neither. Both survived a full `pnpm check`, the
 * whole integration suite AND the upgrade proof — because every one of those runs against the
 * MIGRATED database, where the constraints really are present. Only a reviewer caught it, and the
 * fix for "a reviewer had to notice" is never a promise to remember.
 *
 * Scope is deliberately the party models. A blanket `prisma migrate diff` assertion was written
 * first and rejected: it reports substantial PRE-EXISTING drift across Phases 1–5 (composite keys
 * this repository writes by hand and Prisma renders differently), so it would fail this PR on
 * five phases of unrelated history. That drift is worth its own unit; it is not this one's to fix,
 * and burying it under a baseline list would be the enumeration anti-pattern one level up.
 */
describe('the party seals exist in BOTH the schema and the migrated database', () => {
  let t: TestApp;
  let schema: string;

  beforeAll(async () => {
    t = await createTestApp();
    schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
  });
  afterAll(async () => { await t?.close(); });

  /** `confdeltype`/`confupdtype`: a = NO ACTION, r = RESTRICT, c = CASCADE, n = SET NULL. */
  const actions = async (name: string): Promise<{ del: string; upd: string } | null> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ del: string; upd: string }>>(
      `SELECT confdeltype AS del, confupdtype AS upd FROM pg_constraint WHERE conname = $1`, name);
    return rows[0] ?? null;
  };

  it('the promotion target is a real Org — in the database AND in the model', async () => {
    expect(await actions('ExternalParty_promotedOrgId_fkey'), 'the FK is missing from the database').not.toBeNull();
    // The model half is what a generated migration diffs against. Without it the FK is one
    // `prisma migrate dev` away from being dropped, re-opening a promotion frozen onto a typo.
    expect(schema).toMatch(/promotedOrg\s+Org\?\s+@relation\("externalPartyPromotedTo"/u);
    expect(schema).toMatch(/promotedParties\s+ExternalParty\[\]\s+@relation\("externalPartyPromotedTo"\)/u);
  });

  it('the binding’s party copy follows its vendor — in the database AND in the model', async () => {
    const fk = await actions('ProjectVendor_orgId_vendorId_partyId_fkey');
    expect(fk, 'the FK is missing from the database').not.toBeNull();
    expect(fk!.upd, 'ON UPDATE must CASCADE or 6.1b cannot repoint a bound vendor').toBe('c');
    expect(schema).toMatch(/@relation\("projectVendorParty"[^)]*onUpdate:\s*Cascade\)/u);
  });

  it('an association cannot be deleted out from under its source — in the database AND in the model', async () => {
    for (const name of ['ProjectPartyCompanySource_association_fkey', 'ProjectPartyVendorSource_association_fkey']) {
      const fk = await actions(name);
      expect(fk, `${name} is missing from the database`).not.toBeNull();
      expect(fk!.del, `${name} must RESTRICT, not cascade the justification away`).toBe('r');
    }
    expect(schema.match(/projectParty\s+ProjectParty\s+@relation\([^)]*onDelete:\s*Restrict\)/gu) ?? [])
      .toHaveLength(2);
  });

  it('the party name is non-blank at the database', async () => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM pg_constraint WHERE conname = 'ExternalParty_name_not_blank'`);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
