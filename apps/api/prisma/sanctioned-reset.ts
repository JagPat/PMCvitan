// The SANCTIONED destructive reset, in one place.
//
// Every integration suite has to clear the tables it writes, and several of those tables carry
// statement-level `BEFORE TRUNCATE` seals. A row-level append-only trigger never fires for
// `TRUNCATE`, so tables whose counts or contents a predicate depends on are sealed at the
// STATEMENT level too — and a statement trigger fires even on an EMPTY table, so a suite that
// truncates a sealed table fails in setup whether or not it holds a single row.
//
// That is what makes a per-suite raw `TRUNCATE` unsustainable: installing one seal used to mean
// editing every suite that resets a table in its cascade, and MISSING one meant the required
// integration battery stopped being runnable. The reset therefore lives here, once. Adding a seal
// is one entry in `TRUNCATE_SEALS` below; no suite changes at all.
//
// This helper is the sanctioned reset — the same contract that lets the wipe in `prisma/seed.ts`
// bypass append-only triggers. It is for test setup and seeding ONLY. Nothing in `src/` may call
// it: in a live database these seals are exactly the evidence they exist to protect.

/** The narrow slice of PrismaClient this helper needs — kept structural so both the real client
 *  and the suites' test-app wrapper satisfy it without importing either. */
export interface TruncateCapableClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(operations: readonly Promise<T>[]): Promise<T[]>;
}

/**
 * Every statement-level TRUNCATE seal in the schema, with the table it guards.
 *
 * THE REGISTRY IS THE POINT. When a migration adds a `BEFORE TRUNCATE` seal, add it here in the
 * same unit — that is the whole reset contract, and a seal whose only artifact is its migration is
 * not finished. Leaving it out does not fail loudly at the seal; it fails in the SETUP of every
 * suite whose reset touches that table, directly or through a cascade.
 *
 * Cascades are why this list is applied wholesale rather than matched against the caller's table
 * list: `TRUNCATE "Decision" CASCADE` fires the seal on every table PostgreSQL pulls into the
 * cascade, which the caller never names and cannot be expected to enumerate.
 */
export const TRUNCATE_SEALS: readonly { readonly table: string; readonly trigger: string }[] = [
  { table: 'ActivityDependency', trigger: 'ActivityDependency_no_truncate' },
  { table: 'Decision', trigger: 'Decision_t4b_no_truncate' },
  { table: 'DecisionEvent', trigger: 'DecisionEvent_t4a_no_truncate' },
  { table: 'DecisionLegacyApproval', trigger: 'DecisionLegacyApproval_no_truncate' },
  { table: 'DecisionOption', trigger: 'DecisionOption_t4b2_no_truncate' },
  { table: 'DecisionOptionKind', trigger: 'DecisionOptionKind_no_truncate' },
  { table: 'DecisionOptionKindSelection', trigger: 'DecisionOptionKindSelection_no_truncate' },
  { table: 'DecisionOptionTouch', trigger: 'DecisionOptionTouch_t4a_no_truncate' },
  { table: 'OrgMembership', trigger: 'OrgMembership_t4b2_no_truncate' },
  { table: 'T3CRepairAction', trigger: 'T3CRepairAction_no_truncate' },
];

/**
 * Toggle one seal by name, guarded on its existence.
 *
 * The guard is not defensive noise: a database migrated to an EARLIER point does not carry the
 * trigger, and `ALTER TABLE … DISABLE TRIGGER` on a missing trigger is an error, not a no-op. The
 * suites run against whatever the migration state happens to be, so every toggle is conditional —
 * the same shape `prisma/seed.ts` uses for the seals it disables by name.
 */
function toggleSeal(action: 'DISABLE' | 'ENABLE', seal: { table: string; trigger: string }): string {
  return `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${seal.trigger}') THEN EXECUTE 'ALTER TABLE "${seal.table}" ${action} TRIGGER "${seal.trigger}"'; END IF; END $$;`;
}

export interface SanctionedResetOptions {
  /** Append `CASCADE`. Preserves each suite's original statement exactly. */
  readonly cascade?: boolean;
}

/**
 * Truncate `tables` with every statement-level seal disabled for exactly that wipe.
 *
 * ONE transaction, because PostgreSQL DDL is transactional: a wipe that throws rolls the DISABLE
 * back with it, so no failure path can leave a seal off. A bare disable/truncate/enable sequence
 * could, and that is the difference between a reset and a hole in the evidence.
 *
 * A nullish client is a no-op. That is not laziness — the suites call this from `afterAll` as
 * `t?.prisma`, where the optional chain short-circuits the whole expression when setup never
 * completed. Accepting nullish preserves that behaviour exactly; throwing here would turn a
 * failed setup into a second, misleading teardown failure that buries the real one.
 */
export async function sanctionedReset(
  prisma: TruncateCapableClient | null | undefined,
  tables: readonly string[],
  options: SanctionedResetOptions = {},
): Promise<void> {
  if (!prisma) return;
  if (tables.length === 0) return;

  const list = tables.map((table) => `"${table}"`).join(', ');
  const truncate = `TRUNCATE TABLE ${list}${options.cascade ? ' CASCADE' : ''}`;

  await prisma.$transaction([
    ...TRUNCATE_SEALS.map((seal) => prisma.$executeRawUnsafe(toggleSeal('DISABLE', seal))),
    prisma.$executeRawUnsafe(truncate),
    ...TRUNCATE_SEALS.map((seal) => prisma.$executeRawUnsafe(toggleSeal('ENABLE', seal))),
  ]);
}
