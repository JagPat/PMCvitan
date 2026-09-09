import type { ModuleManifest } from '@vitan/shared';

/**
 * The platform kernel: the shared audit / event / command-ledger / outbox / projection
 * tables plus the shared notification + push-subscription + credential-security
 * infrastructure. Because this module is `kind: 'platform'`, its tables are SHARED
 * infrastructure every module appends to through the kernel helpers (`recordAudit`,
 * `emitEvent`, the command wrapper, the outbox relay) — a write to one of these tables
 * from a domain module is NOT a cross-module persistence edge. This module owns no
 * domain business logic and emits no domain events; it carries them.
 */
export const platformManifest: ModuleManifest = {
  id: 'platform',
  title: 'Platform Kernel',
  kind: 'platform',
  ownsModels: [
    // Phase 3 Task 1 — project-scoped capability activation (plan §D); readable by any module's gate
    'projectCapability',
    'auditLog',
    'notification',
    'pushSubscription',
    'passwordCredentialChallenge',
    'securityAuditEvent',
    'domainEvent',
    'projectEventStream',
    'commandExecution',
    'outboxDelivery',
    'processedEvent',
    'projectionCursor',
    'projectionGeneration',
    'outboxConsumerCatalog',
    'outboxOperatorAction',
    'outboxCutoverState',
    // Phase 6 task 4d unit 4d-i (§D Part 0) — the durable retirement marker. One row per retired
    // rollout unit, written only by the retiring migration under its `SET LOCAL` gate, and read
    // by every marker-aware statement in the 4d-i migration to decide whether it is installing a
    // fresh reservation or replaying over a database that has already retired it. Platform-owned
    // because it is rollout evidence about the deployment, not about any module's domain.
    'rolloutRetirement',
    // Phase 6 task 4d unit 4d-i (§A.2) — the five REGISTERS every 4d seal asks its standing,
    // identity, team-management-authority and project→org tenancy questions through. They are
    // platform-owned because the whole point is that no decisions- or platform-owned trigger
    // reads an orgs table (#561's review round 1, finding 1): ORGS-owned triggers PROJECT these
    // rows from their own tables through generic platform primitives, and every seal then reads
    // kernel-owned rows. Registering them here is not bookkeeping — the boundary suite requires
    // this set to EQUAL the DMMF, so a table added without its registration cannot merge.
    'projectOrg',
    'projectRoleStanding',
    'projectUserStanding',
    'userIdentity',
    'orgUserAuthority',
    // Phase 6 task 4d unit 4d-i — the external-effect catalog as DATA (what a seal reads when it
    // needs to know whether an event owed a claim), the drain attestation's release lease, and
    // the generic per-event pairing register. All three are kernel infrastructure and all three
    // are DARK: nothing reads or writes them until 4d-ii.
    'externalEffectCatalog',
    'releaseLease',
    'domainEventPairingClaim',
  ],
  dependsOn: [],
  // Phase 6 unit 4b, round-6 Codex F6 — the push spine asks TWO orgs-owned questions through
  // `OrgsParticipant` (identity existence at subscribe-attribution; credential/session validity
  // at targeted-claim time), so the platform → orgs interaction is DECLARED here exactly like
  // every other cycle-exempt participant edge: module validation sees the real graph and a
  // later cycle involving it is detectable. `dependsOn` stays empty — the kernel still owns no
  // domain logic and the participant channel is the one crossing.
  workflowParticipants: ['orgs'],
  producesEvents: [],
  consumesEvents: [],
  // Phase 6 task 4b (§A.3 round 13) — `push.unlink` severs a browser subscription's user
  // attribution at sign-out (targeted content stops; role-level pushes continue).
  commands: ['push.subscribe', 'push.unlink'],
  queries: ['snapshot.project'],
  routes: ['POST /projects/:projectId/push/subscribe', 'POST /projects/:projectId/push/unlink'],
  permissions: [],
};
