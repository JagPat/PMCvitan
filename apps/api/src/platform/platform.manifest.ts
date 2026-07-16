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
  ],
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: [],
  consumesEvents: [],
  commands: ['push.subscribe'],
  queries: ['snapshot.project'],
  routes: ["Post('projects/:projectId/push/subscribe')"],
  permissions: [],
};
