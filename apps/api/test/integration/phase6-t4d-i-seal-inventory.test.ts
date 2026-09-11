import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * Phase 6 unit 4d-i — THE CLOSING VERIFICATION.
 *
 * "A contract that names no installer is not installed" is a rule this plan family has recorded
 * failing four separate times: a seal described in the design, named in a later unit's replace,
 * and never actually created by the migration an implementation follows. Every one of those was
 * found by reading, late, by someone who happened to notice.
 *
 * This is the check that finds the fifth one immediately. The set of `_t4d_` triggers PRESENT in
 * the database must EQUAL the inventory below, exactly — so:
 *
 *   · a seal added to the migration and not listed here FAILS (the inventory is incomplete);
 *   · a seal listed here and never installed FAILS (the contract names no installer);
 *   · a seal silently dropped by a later edit FAILS (the migration stopped installing it).
 *
 * An `expect(actual).toEqual(expected)` over two sorted lists is what makes all three true at
 * once. A per-name `EXISTS` loop would only catch the second.
 *
 * It runs against the live migrated database rather than the migration TEXT, because the claim
 * is about what the deploy PRODUCES — a `CREATE TRIGGER` inside a marker-aware guard that never
 * fires would satisfy a text search and install nothing.
 */

/** table → the `_t4d_` triggers 4d-i installs on it. */
const INVENTORY: Record<string, string[]> = {
  ChangeRequest: ['ChangeRequest_t4d_evidence_frozen', 'ChangeRequest_t4d_no_truncate', 'ChangeRequest_t4d_project'],
  Decision: [
    'Decision_t4d_architect_reserved',
    'Decision_t4d_awaiting_paired',
    'Decision_t4d_awaiting_reserved',
    'Decision_t4d_disagreement_paired',
    'Decision_t4d_entry_seal',
    'Decision_t4d_holder_standing',
  ],
  DecisionApprovalRevision: [
    'DecisionApprovalRevision_t4d_birth',
    'DecisionApprovalRevision_t4d_birth_paired',
    'DecisionApprovalRevision_t4d_flip_paired',
    'DecisionApprovalRevision_t4d_one_flip',
  ],
  DecisionConsultation: ['DecisionConsultation_t4d_attribution',
    'DecisionConsultation_t4d_attribution_present'],
  DecisionConsultationResponse: ['DecisionConsultationResponse_t4d_attribution',
    'DecisionConsultationResponse_t4d_attribution_present'],
  DecisionCountersign: [
    'DecisionCountersign_t4d_append_only',
    'DecisionCountersign_t4d_no_truncate',
    'DecisionCountersign_t4d_paired',
    'DecisionCountersign_t4d_provenance_bound',
    'DecisionCountersign_t4d_seal',
  ],
  DecisionEvent: ['DecisionEvent_t4d_append_only', 'DecisionEvent_t4d_correspondence',
    'DecisionEvent_t4d_renotified_claim'],
  DecisionForward: [
    'DecisionForward_t4d_append_only',
    'DecisionForward_t4d_no_truncate',
    'DecisionForward_t4d_paired',
    'DecisionForward_t4d_provenance_bound',
    'DecisionForward_t4d_reserved',
    'DecisionForward_t4d_seal',
  ],
  DecisionStrandedResolution: [
    'DecisionStrandedResolution_t4d_append_only',
    'DecisionStrandedResolution_t4d_no_truncate',
    'DecisionStrandedResolution_t4d_paired',
    'DecisionStrandedResolution_t4d_provenance_bound',
    'DecisionStrandedResolution_t4d_seal',
  ],
  DomainEvent: ['DomainEvent_t4d_envelope', 'DomainEvent_t4d_pairing_claimed'],
  DomainEventPairingClaim: [
    'DomainEventPairingClaim_t4d_no_truncate',
    'DomainEventPairingClaim_t4d_writer',
  ],
  ExternalEffectCatalog: [
    'ExternalEffectCatalog_t4d_no_truncate',
    'ExternalEffectCatalog_t4d_sealed',
  ],
  Membership: [
    'Membership_t4d_architect_provenance',
    'Membership_t4d_architect_reserved',
    'Membership_t4d_fact_first',
    'Membership_t4d_holder_guard',
    'Membership_t4d_no_truncate',
    'Membership_t4d_role_standing',
  ],
  MembershipTransition: [
    'MembershipTransition_t4d_append_only',
    'MembershipTransition_t4d_no_truncate',
    'MembershipTransition_t4d_provenance_bound',
    'MembershipTransition_t4d_seal',
  ],
  Notification: [
    'Notification_t4d_binding',
    'Notification_t4d_binding_bound',
    'Notification_t4d_no_truncate',
  ],
  OrgMembership: ['OrgMembership_t4d_org_authority', 'OrgMembership_t4d_user_standing'],
  OrgUserAuthority: ['OrgUserAuthority_t4d_no_truncate', 'OrgUserAuthority_t4d_writer'],
  Project: ['Project_t4d_deleting', 'Project_t4d_project_org', 'Project_t4d_user_standing'],
  ProjectEventStream: [
    // §A.2 names FIVE objects here and the first version of this unit installed two, with the
    // first weakened to "any increase" (Codex round 1, findings 3 and 7). The pin is what makes
    // the other three visible: an inventory that lists what was built rather than what the
    // contract states cannot report a missing seal.
    'ProjectEventStream_t4d_allocation',
    'ProjectEventStream_t4d_allocation_bound',
    'ProjectEventStream_t4d_init',
    'ProjectEventStream_t4d_no_delete',
    'ProjectEventStream_t4d_no_truncate',
  ],
  ProjectOrg: ['ProjectOrg_t4d_frozen', 'ProjectOrg_t4d_no_truncate', 'ProjectOrg_t4d_writer'],
  ProjectRoleStanding: ['ProjectRoleStanding_t4d_no_truncate', 'ProjectRoleStanding_t4d_writer'],
  ProjectUserStanding: ['ProjectUserStanding_t4d_no_truncate', 'ProjectUserStanding_t4d_writer'],
  ReleaseLease: ['ReleaseLease_t4d_frozen', 'ReleaseLease_t4d_no_truncate'],
  RolloutRetirement: [
    'RolloutRetirement_t4d_frozen',
    'RolloutRetirement_t4d_gate',
    'RolloutRetirement_t4d_no_truncate',
  ],
  User: ['User_t4d_architect_reserved', 'User_t4d_identity'],
  UserIdentity: ['UserIdentity_t4d_no_truncate', 'UserIdentity_t4d_writer'],
};

/** The kernel primitives and kernel reads every seal above calls. A seal whose primitive is
 *  missing does not fail at CREATE time — plpgsql bodies are not validated — it fails on the
 *  first real write, in production. */
const FUNCTIONS = [
  'phase6_t4d_retired',
  'phase6_t4d_reserved',
  'phase6_t4d_actor_bound',
  'phase6_t4d_provenance_bound',
  'phase6_t4d_membership_transition_bound',
  'platform_t4d_register_writer',
  'platform_t4d_register_no_truncate',
  'platform_project_org_apply',
  'platform_role_standing_apply',
  'platform_user_standing_apply',
  'platform_user_identity_apply',
  'platform_org_authority_apply',
  'platform_role_standing',
  'platform_role_has_holder',
  'platform_role_holder_user_ids',
  'platform_membership_active_user',
  'platform_user_holds_role',
  'platform_user_display_name',
  'platform_user_orchestration_authority',
  'platform_claim_event_pairing',
  'platform_tx_event',
  'platform_tx_notification',
];

describe('Phase 6 unit 4d-i — every seal the migration names is INSTALLED (live PG)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('the database carries EXACTLY the t4d trigger inventory — no more, no fewer', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; trigger: string }[]>(
      `SELECT c.relname AS "table", t.tgname AS "trigger"
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_t4d\\_%'
        ORDER BY c.relname, t.tgname`,
    );
    const actual = rows.map((r) => `${r.table}.${r.trigger}`);
    const expected = Object.entries(INVENTORY)
      .flatMap(([table, names]) => names.map((n) => `${table}.${n}`))
      .sort();
    expect(actual).toEqual(expected);
  });

  it('every installed t4d trigger is ENABLED — a disabled seal is an absent seal', async () => {
    const rows = await prisma.$queryRawUnsafe<{ trigger: string; enabled: string }[]>(
      `SELECT t.tgname AS "trigger", t.tgenabled AS "enabled"
         FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_t4d\\_%' AND t.tgenabled <> 'O'`,
    );
    // A sanctioned reset disables seals BY NAME inside one transaction and re-enables them in
    // the same one, so nothing should ever be observed off between suites. Left off, a seal
    // protects nothing while still passing an existence check.
    expect(rows).toEqual([]);
  });

  it('every kernel primitive and kernel read the seals call EXISTS', async () => {
    const rows = await prisma.$queryRawUnsafe<{ proname: string }[]>(
      `SELECT proname FROM pg_proc WHERE proname = ANY($1::text[])`,
      FUNCTIONS,
    );
    const found = rows.map((r) => r.proname).sort();
    expect(found).toEqual([...FUNCTIONS].sort());
  });

  it('the delivered blanket append-only seal on the approval register is REPLACED, not stacked under', async () => {
    // §D: the countersign's `finalized` false→true flip would abort before its pairing trigger
    // ran if `phase3_immutable_row` still guarded the register. The migration DROPs it; this is
    // the assertion that the drop happened and the replacement stands in its place.
    const old = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_trigger
        WHERE NOT tgisinternal AND tgname = 'DecisionApprovalRevision_append_only'`,
    );
    expect(Number(old[0]!.n)).toBe(0);
    const replacement = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_trigger
        WHERE NOT tgisinternal AND tgname = 'DecisionApprovalRevision_t4d_one_flip'`,
    );
    expect(Number(replacement[0]!.n)).toBe(1);
  });

  it('the effect catalog is seeded, and every row is live', async () => {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint; retired: bigint }[]>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE "retiredAt" IS NOT NULL) AS retired
         FROM "ExternalEffectCatalog"`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(50);
    expect(Number(rows[0]!.retired)).toBe(0);
  });
});
