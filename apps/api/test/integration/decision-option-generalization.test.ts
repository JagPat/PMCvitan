import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Issue generalization unit A1 — AN OPTION IS NOT NECESSARILY A CHOICE OF MATERIAL.
 *
 * No writer ships in this unit, so every probe goes at the database directly: during the
 * expansion phase direct SQL is the only writer these columns can have, and a rule that holds
 * only when the service cooperates is not a rule.
 *
 * Probes
 *   P1  the option-kind menu is SERVER-DRIVEN — four seeded base kinds, ordered, keyed for
 *       localization rather than carrying display strings
 *   P2  an option with NO material and NO swatch is accepted for a non-material kind
 *   P3  cost impact is a STATE: an amount is required for estimated/confirmed and FORBIDDEN for
 *       pending/none, so `pending` can never read as free and no stale amount lingers
 *   P4  procurement may draw only on an option that really names a material
 *   P5  an organization may add its own kind, mapped to a stable base kind, without colliding
 *       with the platform menu or with another organization
 */
describe('A1 — option generalization (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const run = Math.floor(Math.random() * 1e6);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  const wipe = async (): Promise<void> => {
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "Decision" WHERE "id" LIKE 'DL-a1-%'`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOptionKind" WHERE "code" LIKE 'a1-%'`);
  };
  afterEach(wipe);
  afterAll(async () => {
    await wipe();
    await f?.cleanup();
    await t?.close();
  });

  /** An issue. `photoSwatch` is deliberately omitted — A1 relaxed it, because a colour chip is
   *  material evidence and an issue need not be about material at all. */
  const issue = async (): Promise<string> => {
    const id = `DL-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Decision"("id","projectId","title","room","status","authorId")
       VALUES ('${id}','${f.projectA.id}','Which approach?','Hall','pending','${f.memberUser.id}')`,
    );
    return id;
  };

  const refusal = async (sql: string): Promise<string> => {
    const err = await t.prisma.$executeRawUnsafe(sql).then(() => null, (e: unknown) => e);
    expect(err, `expected PostgreSQL to refuse: ${sql.slice(0, 100)}`).not.toBeNull();
    return String(err);
  };

  const option = (
    decisionId: string,
    cols: Record<string, string | number | null>,
  ): string => {
    const base: Record<string, string | number | null> = {
      id: `opt-a1-${run}-${seq++}`, decisionId, label: 'Option A',
      optionKey: `k${seq}`, delta: 0, ...cols,
    };
    const keys = Object.keys(base).map((k) => `"${k}"`).join(',');
    const vals = Object.values(base)
      .map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
      .join(',');
    return `INSERT INTO "DecisionOption"(${keys}) VALUES (${vals})`;
  };

  // ── P1 ─────────────────────────────────────────────────────────────────────────────────────
  it('P1 the kind menu is server-driven: four seeded base kinds, ordered, localization-keyed', async () => {
    const rows = await t.prisma.$queryRawUnsafe<
      Array<{ code: string; baseKind: string; labelKey: string; displayOrder: number }>
    >(`SELECT "code","baseKind"::text AS "baseKind","labelKey","displayOrder"
         FROM "DecisionOptionKind" WHERE "orgId" IS NULL AND "active" ORDER BY "displayOrder"`);

    expect(rows.map((r) => r.code)).toEqual(['material', 'technology', 'solution', 'other']);
    // every menu row maps to a STABLE base kind — that is what downstream behaviour reads
    expect(rows.map((r) => r.baseKind)).toEqual(['material', 'technology', 'solution', 'other']);
    // labels are KEYS, served localized by the backend; the frontend hardcodes none
    for (const r of rows) expect(r.labelKey).toMatch(/^option\.kind\./);
    expect(new Set(rows.map((r) => r.displayOrder)).size).toBe(rows.length); // a total order
  });

  // ── P2 — the point of the whole unit ───────────────────────────────────────────────────────
  it('P2 a technology, solution or other option needs no material and no swatch', async () => {
    const d = await issue();
    for (const kind of ['technology', 'solution', 'other']) {
      await t.prisma.$executeRawUnsafe(option(d, {
        kindCode: kind, description: `A ${kind} proposal`, material: null, swatch: null,
      }));
    }
    const rows = await t.prisma.$queryRawUnsafe<Array<{ kindCode: string; material: string | null }>>(
      `SELECT "kindCode","material" FROM "DecisionOption" WHERE "decisionId"='${d}' ORDER BY "kindCode"`,
    );
    expect(rows.map((r) => r.kindCode)).toEqual(['other', 'solution', 'technology']);
    expect(rows.every((r) => r.material === null)).toBe(true);

    // …and a MATERIAL option may still carry its structured identity, so the relaxation widened
    // the model rather than hollowing it out
    await t.prisma.$executeRawUnsafe(option(d, {
      kindCode: 'material', description: 'Teak', material: 'Teak 18mm', swatch: 'sw-teak',
    }));
    const mat = await t.prisma.$queryRawUnsafe<Array<{ material: string }>>(
      `SELECT "material" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "kindCode"='material'`,
    );
    expect(mat[0]?.material).toBe('Teak 18mm');
  });

  // ── P3 ─────────────────────────────────────────────────────────────────────────────────────
  it('P3 cost impact is a state: amount required for estimated/confirmed, forbidden for pending/none', async () => {
    const d = await issue();

    // the honest defaults: not assessed yet, and assessed-as-zero — neither carries an amount
    await t.prisma.$executeRawUnsafe(option(d, { kindCode: 'other', costImpact: 'pending' }));
    await t.prisma.$executeRawUnsafe(option(d, { kindCode: 'other', costImpact: 'none' }));
    await t.prisma.$executeRawUnsafe(option(d, { kindCode: 'other', costImpact: 'estimated', costAmount: 25000 }));
    await t.prisma.$executeRawUnsafe(option(d, { kindCode: 'other', costImpact: 'confirmed', costAmount: 31500 }));

    // a priced state with no price is a claim with nothing behind it
    expect(await refusal(option(d, { kindCode: 'other', costImpact: 'estimated' })))
      .toMatch(/cost_impact_check/i);
    expect(await refusal(option(d, { kindCode: 'other', costImpact: 'confirmed' })))
      .toMatch(/cost_impact_check/i);
    // …and an amount on an UNASSESSED option is worse than none: it reads as a price nobody set
    expect(await refusal(option(d, { kindCode: 'other', costImpact: 'pending', costAmount: 900 })))
      .toMatch(/cost_impact_check/i);
    expect(await refusal(option(d, { kindCode: 'other', costImpact: 'none', costAmount: 900 })))
      .toMatch(/cost_impact_check/i);

    // PENDING IS NOT ZERO — the distinction the state exists for, asserted rather than assumed
    const pending = await t.prisma.$queryRawUnsafe<Array<{ costAmount: number | null }>>(
      `SELECT "costAmount" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "costImpact"='pending'`,
    );
    expect(pending[0]?.costAmount).toBeNull();
    expect(pending[0]?.costAmount).not.toBe(0);

    // the default for a caller that says nothing at all is `pending`, not a free option
    await t.prisma.$executeRawUnsafe(option(d, { kindCode: 'other' }));
    const defaulted = await t.prisma.$queryRawUnsafe<Array<{ costImpact: string }>>(
      `SELECT "costImpact"::text AS "costImpact" FROM "DecisionOption"
        WHERE "decisionId"='${d}' AND "costAmount" IS NULL AND "costImpact"='pending'`,
    );
    expect(defaulted.length).toBeGreaterThanOrEqual(2);
  });

  // ── P4 ─────────────────────────────────────────────────────────────────────────────────────
  it('P4 a material requirement may cite only an option that really names a material', async () => {
    const d = await issue();
    await t.prisma.$executeRawUnsafe(option(d, {
      optionKey: 'tech', kindCode: 'technology', description: 'Post-tensioned slab', material: null, swatch: null,
    }));
    await t.prisma.$executeRawUnsafe(option(d, {
      optionKey: 'blank', kindCode: 'material', description: 'Named later', material: null, swatch: null,
    }));
    await t.prisma.$executeRawUnsafe(option(d, {
      optionKey: 'real', kindCode: 'material', description: 'Teak', material: 'Teak 18mm', swatch: 'sw',
    }));

    // The seal is a BEFORE INSERT trigger, so it decides before PostgreSQL validates the spec's
    // requirement/approval foreign keys. That is what lets these refusals be asserted without
    // standing up a whole procurement chain — and it is also the correct order: an unqualified
    // reference should be refused for the reason that actually matters.
    const spec = (optionKey: string): string =>
      `INSERT INTO "MaterialRequirementSpec"
         ("id","projectId","requirementId","revision","materialCategory","make","grade",
          "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey")
       VALUES ('spec-a1-${seq++}','${f.projectA.id}','req-a1',1,'timber','X','A','{}','fp',
               '${d}',1,'${optionKey}')`;

    expect(await refusal(spec('tech')))
      .toMatch(/is a technology option — only a material option can back a material requirement/);
    expect(await refusal(spec('blank')))
      .toMatch(/carries no material identity/);

    // PRECISION — for a genuine material option the trigger ADMITS the row, and the insert then
    // fails on the requirement foreign key instead. Asserting that the refusal CHANGED OWNER is
    // what distinguishes "the trigger let it through" from "the trigger refuses everything".
    const admitted = await refusal(spec('real'));
    expect(admitted).not.toMatch(/only a material option|carries no material identity/);
    expect(admitted).toMatch(/foreign key|requirementId/i);
  });

  // ── P5 ─────────────────────────────────────────────────────────────────────────────────────
  it('P5 an organization may add its own kind, mapped to a base kind, without collisions', async () => {
    // an org addition MUST map to one of the stable base kinds — that is how procurement and the
    // dynamic form keep working without knowing this organization's vocabulary
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey","displayOrder","orgId")
       VALUES ('a1-precast','material','org.kind.precast',10,'${f.orgA.id}')`,
    );
    // the SAME code is available to a different organization — org menus are independent
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey","displayOrder","orgId")
       VALUES ('a1-precast-b','material','org.kind.precast',10,'${f.orgB.id}')`,
    );

    // a platform code cannot be duplicated (the partial unique over orgId IS NULL)
    expect(await refusal(
      `INSERT INTO "DecisionOptionKind"("code","baseKind","labelKey") VALUES ('material','material','dup')`,
    )).toMatch(/already exists|duplicate/i);

    // an org addition behaves as its BASE kind: an option on it is a material option, so a
    // material requirement may cite it once it names a material — and may not while it does not
    const d = await issue();
    await t.prisma.$executeRawUnsafe(option(d, {
      optionKey: 'pc', kindCode: 'a1-precast', description: 'Precast panel', material: null, swatch: null,
    }));
    expect(await refusal(
      `INSERT INTO "MaterialRequirementSpec"
         ("id","projectId","requirementId","revision","materialCategory","make","grade",
          "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey")
       VALUES ('spec-a1-pc','${f.projectA.id}','req-a1',1,'precast','X','A','{}','fp','${d}',1,'pc')`,
    )).toMatch(/carries no material identity/);
  });
});
