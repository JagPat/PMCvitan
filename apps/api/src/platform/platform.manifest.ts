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
    // Top 10 #4b (#778) — per-notice read receipts over the notification feed above
    'notificationReceipt',
    'pushSubscription',
    'passwordCredentialChallenge',
    'securityAuditEvent',
    'domainEvent',
    'projectEventStream',
    'commandExecution',
    // Idempotency-Key Unit 2a-m (20280201000000) — the count of keyless and legacy-keyed requests on five routes
    'commandKeySighting',
    'outboxDelivery',
    'processedEvent',
    'projectionCursor',
    'projectionGeneration',
    'outboxConsumerCatalog',
    // Phase 6 task 4d-ii-a / A6a — the catalog's append-only, attributable ACTIVATION REGISTER
    // (the companion document): the head every obligation set is judged from, whose `active` the
    // catalog row mirrors. Platform-owned like the catalog it explains; written by the operator
    // protocol (A6b), a migration's backfill, and the catalog's own INSERT trigger — never by a
    // domain module.
    'outboxConsumerActivation',
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
    // 4d-ii-a / A6e — the server-generation fence's persisted minimum (platform-owned, migration-written)
    'serverGeneration',
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
  // Top 10 #4b unit C (#778) — `notifications.seen` records the viewer's receipts for served notices.
  commands: ['push.subscribe', 'push.unlink', 'notifications.seen'],
  queries: ['snapshot.project'],
  routes: [
    'POST /projects/:projectId/push/subscribe', 'POST /projects/:projectId/push/unlink', 'POST /projects/:projectId/notifications/seen',
    // #482 operator door — the presentation-only capability switch behind OPS_TOKEN
    'POST /ops/projects/:projectId/capabilities/:capability/enable', 'POST /ops/projects/:projectId/capabilities/:capability/disable',
    // #482 QA door rebuild — mark a company QA-only (the orgs participant writes the mark; the database guards it)
    'POST /ops/orgs/:orgId/qa-only',
  ],
  permissions: [],
};
