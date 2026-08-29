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
