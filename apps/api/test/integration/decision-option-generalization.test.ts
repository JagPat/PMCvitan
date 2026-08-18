import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, wipeDecisions, type TwoProjectFixture } from './fixtures';

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

  // Two kinds of permanence stand between these probes and a clean database, and neither yields
  // to an ordinary DELETE.
  //
  // The requirement/approval chain — `ActivityRequirementRoot`, `ActivityRequirement`,
  // `MaterialRequirementSpec` and `DecisionApprovalRevision` — is append-only by design: these are
  // the records a procurement decision is answerable from. TRUNCATE is how the rest of the suite
  // clears them, and it goes first, because while a requirement cites the activity and a root
  // cites its author, neither the activity nor the fixture user can be deleted at all.
  //
  // An APPROVED decision is permanent too, and more thoroughly: `phase6_t4a_withdrawn_no_delete`
  // refuses the delete on the decision's own approved status, so clearing the revisions above does
  // not free it, and `decision_t4b_no_truncate` blocks the escape the first kind allows. The
  // repository already answers this with `wipeDecisions`, which disables exactly those three named
  // seals inside one transaction and re-enables them; using it is what keeps the approval in this
  // fixture REAL rather than a decision left un-approved to make teardown convenient.
  const wipe = async (): Promise<void> => {
    await t.prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot",
                     "DecisionApprovalRevision" CASCADE`,
    );
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "id" LIKE 'opt-a1-%'`);
    await wipeDecisions(t.prisma, { id: { startsWith: 'DL-a1-' } });
    await t.prisma.$executeRawUnsafe(`DELETE FROM "DecisionOptionKind" WHERE "code" LIKE 'a1-%'`);
    await t.prisma.activity.deleteMany({ where: { id: { startsWith: 'act-a1-' } } });
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

  /**
   * A decision whose material option is APPROVED, plus the requirement rows a
   * `MaterialRequirementSpec` needs, and the SQL that pins a spec to that option.
   *
   * The provenance chain is real rather than stubbed because the qualification key sits alongside
   * it: a probe that could not create a legitimate spec would also be unable to show that an
   * illegitimate change to the option is refused.
   */
  const approvedDecisionWithMaterialOption = async (): Promise<{
    decisionId: string; optionKey: string;
  }> => {
    const decisionId = `DL-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Decision"("id","projectId","title","room","status","authorId")
       VALUES ('${decisionId}','${f.projectA.id}','Which approach?','Hall','pending','${f.memberUser.id}')`,
    );
    const optionKey = 'mat';
    const root = `req-a1-${run}-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindScope","kindCode")
       VALUES ('opt-a1-${run}-${seq++}','${decisionId}','Teak','${optionKey}','Teak 18mm',0,'sw-teak','platform','material')`,
    );
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='approved', "approvedOption"='Teak' WHERE "id"='${decisionId}'`,
    );
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionApprovalRevision"("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
       VALUES ('rev-a1-${run}-${seq++}','${f.projectA.id}','${decisionId}',1,'${optionKey}',now(),'${f.memberUser.id}')`,
    );
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById")
       VALUES ('${root}','${f.projectA.id}','${f.memberUser.id}')`,
    );
    const activityId = `act-a1-${run}-${seq++}`;
    await t.prisma.activity.create({
      data: { id: activityId, projectId: f.projectA.id, name: 'A', zone: 'Z', plannedStart: 0, plannedEnd: 1 },
    });
    // The requirement and its specification commit TOGETHER: a deferred constraint trigger checks
    // at COMMIT that a material revision carries exactly one MaterialRequirementSpec, so creating
    // the requirement on its own would abort the transaction that made it.
    const arId = `ar-a1-${run}-${seq++}`;
    const specId = `spec-a1-${run}-${seq++}`;
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","baseUom","requiredQty","requiredBy","createdById")
         VALUES ('${arId}','${f.projectA.id}','${root}',1,'${activityId}','bag',1,'2026-09-01','${f.memberUser.id}')`,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "MaterialRequirementSpec"
           ("id","projectId","requirementId","revision","materialCategory","make","grade",
            "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey","optionMaterialQualified")
         VALUES ('${specId}','${f.projectA.id}','${root}',1,'timber','X','A','{}','fp-a1',
                 '${decisionId}',1,'${optionKey}',true)`,
      ),
    ]);
    return { decisionId, optionKey };
  };

  const option = (
    decisionId: string,
    cols: Record<string, string | number | null>,
  ): string => {
    const base: Record<string, string | number | null> = {
      id: `opt-a1-${run}-${seq++}`, decisionId, label: 'Option A',
      optionKey: `k${seq}`, delta: 0, ...cols,
    };
    // A kind is identified by SCOPE plus code. Callers name the code they care about; unless one
    // says otherwise the kind is a platform kind, which is what every seeded code is.
    if (base.kindCode !== undefined && base.kindCode !== null && base.kindScope === undefined) {
      base.kindScope = 'platform';
    }
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
          "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey",
          "optionMaterialQualified")
       VALUES ('spec-a1-${seq++}','${f.projectA.id}','req-a1',1,'timber','X','A','{}','fp',
               '${d}',1,'${optionKey}',true)`;

    // Qualification is now a FACT ON THE OPTION rather than a question asked when a spec is
    // written, so this is asserted where it now lives — and the refusal, when a spec tries to cite
    // an unqualified option, comes from the foreign key rather than from a message.
    const qualified = async (key: string): Promise<boolean> => (
      await t.prisma.$queryRawUnsafe<Array<{ materialQualified: boolean }>>(
        `SELECT "materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='${key}'`,
      ))[0].materialQualified;

    expect(await qualified('tech'), 'a technology option is not material-qualified').toBe(false);
    expect(await qualified('blank'), 'a material kind with no material identity is not qualified').toBe(false);
    expect(await qualified('real'), 'a real material option is qualified').toBe(true);

    expect(await refusal(spec('tech'))).toMatch(/foreign key/i);
    expect(await refusal(spec('blank'))).toMatch(/foreign key/i);

    // PRECISION — for a genuine material option the trigger ADMITS the row, and the insert then
    // fails on the requirement foreign key instead. Asserting that the refusal CHANGED OWNER is
    // what distinguishes "the trigger let it through" from "the trigger refuses everything".
    const admitted = await refusal(spec('real'));
    expect(admitted).toMatch(/foreign key|requirementId/i);
  });

  // ── P6 ─────────────────────────────────────────────────────────────────────────────────────
  // THE COMPATIBILITY WINDOW, which the first version of this unit broke.
  //
  // `kindCode` is deliberately nullable so the release running during deployment keeps writing
  // valid options — and it writes them exactly as it always has: a material and a swatch, no kind.
  // The first trigger treated a NULL kind as "not a material option" and refused procurement on
  // every such row, which is a break for the running release rather than a rule about options.
  //
  // The rule the migration's own backfill states is the rule that must hold going forward: an
  // option carrying a material IS a material option. It cannot be true for a row written yesterday
  // and false for the byte-identical row written tomorrow.
  it('P6 an option written by the OLD release — material, no kind — still backs a requirement', async () => {
    const d = await issue();
    // exactly the pre-A1 writer's shape: no kindCode, no description, no cost columns named
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
       VALUES ('opt-a1-legacy-${seq++}','${d}','Teak','oldrel','Teak 18mm',0,'sw')`,
    );
    const kindless = await t.prisma.$queryRawUnsafe<{ kindCode: string | null }[]>(
      `SELECT "kindCode" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='oldrel'`,
    );
    expect(kindless[0].kindCode).toBeNull(); // the state under test, asserted rather than assumed

    const admitted = await refusal(
      `INSERT INTO "MaterialRequirementSpec"
         ("id","projectId","requirementId","revision","materialCategory","make","grade",
          "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey",
          "optionMaterialQualified")
       VALUES ('spec-a1-${seq++}','${f.projectA.id}','req-a1',1,'timber','X','A','{}','fp',
               '${d}',1,'oldrel',true)`,
    );
    // admitted by the kind seal; refused downstream by the requirement FK, as a real spec would be
    expect(admitted).not.toMatch(/only a material option|carries no material identity/);
    expect(admitted).toMatch(/foreign key|requirementId/i);
  });

  // ── P7 ─────────────────────────────────────────────────────────────────────────────────────
  // EXISTENCE IS NOT THE KIND SEAL'S QUESTION. A spec citing an option that is not there must be
  // refused by the four-column provenance FK, in those terms. The first version answered first and
  // called a nonexistent option "kindless" — a claim about the kind of something that has none,
  // and it displaced the precise error three existing phase-3 provenance probes assert on.
  it('P7 a spec citing a NONEXISTENT option is refused by provenance, not by the kind seal', async () => {
    const d = await issue();
    const err = await refusal(
      `INSERT INTO "MaterialRequirementSpec"
         ("id","projectId","requirementId","revision","materialCategory","make","grade",
          "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey",
          "optionMaterialQualified")
       VALUES ('spec-a1-${seq++}','${f.projectA.id}','req-a1',1,'timber','X','A','{}','fp',
               '${d}',1,'DOES-NOT-EXIST',true)`,
    );
    expect(err).not.toMatch(/kindless|only a material option|carries no material identity/);
    expect(err).toMatch(/foreign key|provenance|requirementId/i);
  });

  // ── P5 ─────────────────────────────────────────────────────────────────────────────────────
  it('P5 an organization may add its own kind, mapped to a base kind, without collisions', async () => {
    // an org addition MUST map to one of the stable base kinds — that is how procurement and the
    // dynamic form keep working without knowing this organization's vocabulary
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("scope","code","baseKind","labelKey","displayOrder","orgId")
       VALUES ('${f.orgA.id}','a1-precast','material','org.kind.precast',10,'${f.orgA.id}')`,
    );
    // THE SAME CODE, for a different organization. The original probe used `a1-precast-b` here
    // and so proved nothing: with `code` as the primary key the second insert would have failed,
    // and a test that renames the thing under test cannot see that. Codex found it; this is the
    // case that was missing.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOptionKind"("scope","code","baseKind","labelKey","displayOrder","orgId")
       VALUES ('${f.orgB.id}','a1-precast','material','org.kind.precast',10,'${f.orgB.id}')`,
    );

    // a platform code cannot be duplicated (the partial unique over orgId IS NULL)
    expect(await refusal(
      `INSERT INTO "DecisionOptionKind"("scope","code","baseKind","labelKey") VALUES ('platform','material','material','dup')`,
    )).toMatch(/already exists|duplicate/i);

    // an org addition behaves as its BASE kind: an option on it is a material option, so a
    // material requirement may cite it once it names a material — and may not while it does not
    const d = await issue();
    await t.prisma.$executeRawUnsafe(option(d, {
      optionKey: 'pc', kindScope: f.orgA.id, kindCode: 'a1-precast', description: 'Precast panel', material: null, swatch: null,
    }));
    expect(await refusal(
      `INSERT INTO "MaterialRequirementSpec"
         ("id","projectId","requirementId","revision","materialCategory","make","grade",
          "normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey",
          "optionMaterialQualified")
       VALUES ('spec-a1-pc','${f.projectA.id}','req-a1',1,'precast','X','A','{}','fp','${d}',1,'pc',true)`,
    )).toMatch(/foreign key/i);
  });

  // ── P8 (Codex round 1, F1 + F3) ─────────────────────────────────────────────────────────────
  // The FIRST version guarded this with a trigger on `MaterialRequirementSpec` that read the
  // decisions-owned option tables. Two defects in one: it crossed a module boundary that writing
  // the lookup in SQL hid rather than removed, and it only ever judged the SPEC — so once a spec
  // committed, the option could be turned into a technology note and nothing fired.
  //
  // Qualification is now a fact the option carries, and the spec points a foreign key at it. This
  // probe is about the WHOLE LIFETIME of the reference, which is the half the trigger never had.
  it('P8 an option backing a material requirement cannot later become a technology note', async () => {
    const d = await approvedDecisionWithMaterialOption();

    // the option is qualified, and a spec may cite it
    const [before] = await t.prisma.$queryRawUnsafe<Array<{ materialQualified: boolean }>>(
      `SELECT "materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d.decisionId}' AND "optionKey"='${d.optionKey}'`,
    );
    expect(before.materialQualified).toBe(true);

    // NOW the lifetime question: flip the referenced option to a technology kind with no material
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "DecisionOption" SET "kindCode"='technology', "material"=NULL
          WHERE "decisionId"='${d.decisionId}' AND "optionKey"='${d.optionKey}'`,
      ),
    ).rejects.toThrow(/foreign key|qualified/i);

    const [after] = await t.prisma.$queryRawUnsafe<Array<{ kindCode: string | null; materialQualified: boolean }>>(
      `SELECT "kindCode","materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d.decisionId}' AND "optionKey"='${d.optionKey}'`,
    );
    expect(after.kindCode).toBe('material');
    expect(after.materialQualified).toBe(true);
  });

  // ── P9 (Codex round 1, F2) ──────────────────────────────────────────────────────────────────
  // `confirmed` is a finalized financial claim. The pairwise CHECK keeps a state and an amount
  // coherent but says nothing about history, so without this a confirmed figure could be quietly
  // rewritten — or erased to `pending`/NULL — and the evidence would be gone.
  it('P9 a CONFIRMED cost cannot be rewritten or erased', async () => {
    const d = await issue();
    await t.prisma.$executeRawUnsafe(option(d, {
      optionKey: 'fin', kindCode: 'other', costImpact: 'confirmed', costAmount: 31500,
    }));
    const where = `WHERE "decisionId"='${d}' AND "optionKey"='fin'`;

    for (const set of [
      `"costImpact"='pending', "costAmount"=NULL`,
      `"costImpact"='none', "costAmount"=NULL`,
      `"costAmount"=99999`,
    ]) {
      await expect(t.prisma.$executeRawUnsafe(`UPDATE "DecisionOption" SET ${set} ${where}`))
        .rejects.toThrow(/finalized figure is evidence/i);
    }

    const [row] = await t.prisma.$queryRawUnsafe<Array<{ costImpact: string; costAmount: number }>>(
      `SELECT "costImpact","costAmount" FROM "DecisionOption" ${where}`,
    );
    expect(`${row.costImpact}/${row.costAmount}`).toBe('confirmed/31500');
  });

  // ── P10 (Codex round 1, F4) ─────────────────────────────────────────────────────────────────
  // THE COMPATIBILITY WINDOW, again — and this is the half the earlier correction missed. Making
  // the READ side treat a kindless option as material was necessary but not sufficient: the
  // release still serving writes only `delta`, so a row it inserts AFTER this migration would take
  // the new column defaults and a cost a PMC really typed would read as "nobody assessed this",
  // with the amount gone. Same input, same meaning, on both sides of the deployment.
  it('P10 a legacy write after the migration keeps its cost meaning', async () => {
    const d = await issue();
    // exactly the pre-A1 writer: no kind, no cost columns named
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
       VALUES ('opt-a1-legacy-${seq++}','${d}','Teak','legacy','Teak 18mm',500,'sw')`,
    );
    const [priced] = await t.prisma.$queryRawUnsafe<Array<{ costImpact: string; costAmount: number | null; materialQualified: boolean }>>(
      `SELECT "costImpact","costAmount","materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='legacy'`,
    );
    expect(`${priced.costImpact}/${priced.costAmount}`).toBe('estimated/500');
    expect(priced.materialQualified).toBe(true);

    // and a stated zero still means "assessed, no change" rather than "unpriced"
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch")
       VALUES ('opt-a1-legacy-${seq++}','${d}','Oak','legacyzero','Oak 18mm',0,'sw')`,
    );
    const [zero] = await t.prisma.$queryRawUnsafe<Array<{ costImpact: string; costAmount: number | null }>>(
      `SELECT "costImpact","costAmount" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='legacyzero'`,
    );
    expect(`${zero.costImpact}/${zero.costAmount ?? '-'}`).toBe('none/-');
  });

  // ── P11 (Codex round 1, F5) ─────────────────────────────────────────────────────────────────
  // One-argument `btrim` strips only spaces, so a tab or a newline passed as a material identity
  // nobody can order against.
  it('P11 every ASCII whitespace material is refused, not just spaces', async () => {
    const d = await issue();
    const shapes: Array<[string, string]> = [
      ['space', ' '], ['tab', '\t'], ['newline', '\n'],
      ['vertical tab', '\v'], ['form feed', '\f'], ['carriage return', '\r'],
    ];
    for (const [name, ch] of shapes) {
      const key = `ws-${name.replace(/\s/gu, '')}`;
      await t.prisma.$executeRawUnsafe(
        `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindScope","kindCode")
         VALUES ('opt-a1-${seq++}','${d}','W','${key}',E'${ch}',0,'sw','platform','material')`,
      );
      const [row] = await t.prisma.$queryRawUnsafe<Array<{ materialQualified: boolean }>>(
        `SELECT "materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='${key}'`,
      );
      expect(row.materialQualified, `${name} must not count as material identity`).toBe(false);
    }

    // …and a real material name is untouched. The first fix assembled the trim set by hand as
    // E' \t\n\r\v\f'; PostgreSQL reads \v there as the LETTER v, so it stripped the v from
    // "vinyl" while leaving an actual vertical tab in place — wrong in both directions at once.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","swatch","kindScope","kindCode")
       VALUES ('opt-a1-${seq++}','${d}','V','vname','vinyl',0,'sw','platform','material')`,
    );
    const [vinyl] = await t.prisma.$queryRawUnsafe<Array<{ material: string; materialQualified: boolean }>>(
      `SELECT "material","materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='vname'`,
    );
    expect(vinyl.material).toBe('vinyl');
    expect(vinyl.materialQualified).toBe(true);
  });
  // ── P12 ────────────────────────────────────────────────────────────────────────────────────
  it('P12 a kind is scope AND code: the half-written pair is refused', async () => {
    const d = await issue();

    // Why this needs a CHECK and not just a foreign key: the (kindScope, kindCode) reference is
    // MATCH SIMPLE, so a NULL in either column switches the whole reference OFF. Without the
    // constraint, the first insert below is accepted with a code that matches no kind anywhere —
    // and since the classifier resolves the base kind by the PAIR, it finds nothing and files a
    // genuine material choice as not-material. A lost procurement reference, no error anywhere.
    const codeOnly = await refusal(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","kindCode")
       VALUES ('opt-a1-${seq++}','${d}','T','half1','Teak 18mm',0,'material')`,
    );
    expect(codeOnly).toMatch(/DecisionOption_kind_pair_check/u);

    const scopeOnly = await refusal(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta","kindScope")
       VALUES ('opt-a1-${seq++}','${d}','T','half2','Teak 18mm',0,'platform')`,
    );
    expect(scopeOnly).toMatch(/DecisionOption_kind_pair_check/u);

    // Both NULL remains legal — that is the compatibility window the running release writes
    // through, and P10 covers what it means. It is only the half-written pair that is a mistake.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionOption"("id","decisionId","label","optionKey","material","delta")
       VALUES ('opt-a1-${seq++}','${d}','T','neither','Teak 18mm',0)`,
    );
    const [legacy] = await t.prisma.$queryRawUnsafe<Array<{ materialQualified: boolean }>>(
      `SELECT "materialQualified" FROM "DecisionOption" WHERE "decisionId"='${d}' AND "optionKey"='neither'`,
    );
    expect(legacy.materialQualified).toBe(true);
  });
});
