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
 *
 * DELIBERATELY ABSENT: `T3CRepairAction_no_truncate`. Do not add it — it breaks every reset in
 * the repository, which is how it was found. That table additionally carries a DDL guard that
 * refuses ALTER TABLE outright ("is the durable repair-evidence register and is never altered"),
 * and disabling a trigger IS an ALTER TABLE, so listing it here makes the very first statement of
 * every reset raise P0001. It also does not belong here on the merits: no sanctioned reset clears
 * that register — it is not a Prisma model, nothing holds a foreign key into it so no CASCADE can
 * reach it, and the only TRUNCATE aimed at it in the whole suite is a HOSTILE PROBE asserting the
 * seal rejects it. A seal nothing sanctioned needs to bypass does not go in the bypass list.
 */
export const TRUNCATE_SEALS: readonly { readonly table: string; readonly trigger: string }[] = [
  { table: 'ActivityDependency', trigger: 'ActivityDependency_no_truncate' },
  { table: 'DecisionProjection', trigger: 'DecisionProjection_4c_iiir_writer_fence_truncate' },
  { table: 'Decision', trigger: 'Decision_t4b_no_truncate' },
  { table: 'DecisionEvent', trigger: 'DecisionEvent_t4a_no_truncate' },
  { table: 'DecisionLegacyApproval', trigger: 'DecisionLegacyApproval_no_truncate' },
  { table: 'DecisionOption', trigger: 'DecisionOption_t4b2_no_truncate' },
  { table: 'DecisionOptionKind', trigger: 'DecisionOptionKind_no_truncate' },
  { table: 'DecisionOptionKindSelection', trigger: 'DecisionOptionKindSelection_no_truncate' },
  { table: 'DecisionOptionTouch', trigger: 'DecisionOptionTouch_t4a_no_truncate' },
  // Phase 6 unit 4c-i — the consultation register, and the approval register whose COUNT 4c
  // turns into trusted cycle evidence. Truncating the approval register would return the count
  // to 0 and make a stale cycle-0 consultation answerable in a reopened cycle: the exact revival
  // `openCycle` exists to prevent, reached by ERASING the evidence rather than forging it.
  { table: 'DecisionApprovalRevision', trigger: 'DecisionApprovalRevision_t4c_no_truncate' },
  { table: 'DecisionConsultation', trigger: 'DecisionConsultation_t4c_no_truncate' },
  { table: 'DecisionConsultationResponse', trigger: 'DecisionConsultationResponse_t4c_no_truncate' },
  { table: 'OrgMembership', trigger: 'OrgMembership_t4b2_no_truncate' },
  // Phase 6 unit 4c-iii installed `ProjectCapability_t4c_no_truncate` here — the consultation
  // PRESERVATION seal's statement-level arm, needed while the gate reads were still authoritative.
  // Unit 4c-v RETIRED that seal (migration 20271130000000): nothing reads the row any more, so
  // `ProjectCapability` carries no seal and needs no bypass. The entry is removed rather than left
  // as a dead name; `phase6-t4c-v-seal-retirement.test.ts` pins its absence.
  // Phase 6 unit 4c-iii-r — the repair marker's statement-level arm. The marker AUTHORIZES every
  // later start to skip the decisions.inbox repair, so losing it by TRUNCATE is sealed exactly as
  // losing it by DELETE is; and a row trigger never fires for TRUNCATE. It belongs here because a
  // sanctioned reset genuinely needs to bypass it: `outbox-operations.test.ts` truncates
  // `OutboxOperatorAction` directly, and this suite's own per-probe reset does too.
  { table: 'OutboxOperatorAction', trigger: 'OutboxOperatorAction_4c_iiir_no_truncate' },
  // Phase 6 unit 4d-i — the five platform REGISTERS the chain's standing, identity, authority and
  // tenancy questions are answered from, plus `Membership`, the orgs table the counted register
  // mirrors. Each carries a row-level writer-depth seal, and a row trigger never fires for
  // TRUNCATE, so each carries a statement seal too.
  //
  // `Membership` is the one that would fail loudest if it were left out: many suites reset it
  // directly and `TRUNCATE "Project" CASCADE` reaches it, so the seal would abort the SETUP of
  // every one of them. The registers are here for the same reason one step removed — a reset
  // that wipes `Project` or `User` cascades into all five.
  { table: 'ChangeRequest', trigger: 'ChangeRequest_t4d_no_truncate' },
  // Phase 6 unit 4d-i — the kernel side. `Notification` is NOT append-only (the withdraw path
  // deletes a now-false pending notice by identity) but it may not be TRUNCATED, because the row
  // seal that protects its event binding is a ROW trigger and does not fire for TRUNCATE. The
  // catalog, the lease and the pairing claims are sealed for the same reason, and the claims are
  // truncated together with `DomainEvent` — a claim outliving its event would refuse the next
  // fact that legitimately claims a reused id.
  { table: 'DomainEventPairingClaim', trigger: 'DomainEventPairingClaim_t4d_no_truncate' },
  { table: 'ExternalEffectCatalog', trigger: 'ExternalEffectCatalog_t4d_no_truncate' },
  { table: 'Notification', trigger: 'Notification_t4d_no_truncate' },
  { table: 'ReleaseLease', trigger: 'ReleaseLease_t4d_no_truncate' },
  // Phase 6 unit 4d-i — the three append-only FACTS of the architect chain. A
  // `TRUNCATE "Decision" … CASCADE` reaches all three, and a statement trigger fires even on an
  // empty table, so a suite that never created a forward would still meet the seal in setup.
  { table: 'DecisionCountersign', trigger: 'DecisionCountersign_t4d_no_truncate' },
  { table: 'DecisionForward', trigger: 'DecisionForward_t4d_no_truncate' },
  { table: 'DecisionStrandedResolution', trigger: 'DecisionStrandedResolution_t4d_no_truncate' },
  { table: 'Membership', trigger: 'Membership_t4d_no_truncate' },
  { table: 'MembershipTransition', trigger: 'MembershipTransition_t4d_no_truncate' },
  { table: 'OrgUserAuthority', trigger: 'OrgUserAuthority_t4d_no_truncate' },
  { table: 'ProjectOrg', trigger: 'ProjectOrg_t4d_no_truncate' },
  { table: 'ProjectRoleStanding', trigger: 'ProjectRoleStanding_t4d_no_truncate' },
  { table: 'ProjectUserStanding', trigger: 'ProjectUserStanding_t4d_no_truncate' },
  { table: 'UserIdentity', trigger: 'UserIdentity_t4d_no_truncate' },
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
