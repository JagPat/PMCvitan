import type { ModuleManifest } from '@vitan/shared';

/**
 * Organizations, projects, roster and templates — the tenancy + membership root.
 * Creating a project is an ATOMIC WORKFLOW (edge 8): the project + its PMC membership +
 * the `project.created` event commit together, then each starting-structure source is
 * instantiated through the owning module's INITIALIZER participant (nodes/activities/
 * inspections), so `orgs` never writes another domain's tables directly.
 */
export const orgsManifest: ModuleManifest = {
  id: 'orgs',
  title: 'Organizations & Projects',
  kind: 'domain',
  // Phase 6 unit 6.1a (§A) — the canonical external party, the per-project association the
  // collaborator resolver reads, and the two per-origin source tables that justify it. Orgs-owned
  // so the access path never has to read procurement.
  ownsModels: ['org', 'orgMembership', 'membership', 'project', 'projectCompany', 'projectTemplate', 'templateModule', 'user', 'workerDevice', 'externalParty', 'projectParty', 'projectPartyCompanySource', 'projectPartyVendorSource'],
  // Task 8 reads decisions; Task 10 reads the existing inspection ids at init via the inspections query
  // (InspectionsQueryService.allIds) — both through their query contracts.
  // Phase 4 Task 3 — the WorkerDevice bind command reads the trusted-worker lifecycle through
  // Labour's query contract (`Worker` is Labour-owned + read-encapsulated). Labour is a LEAF, so
  // this edge closes no cycle.
  dependsOn: ['decisions', 'inspections', 'labour'],
  // Phase 6 unit 6.1b (§A) — the operator merge repoints EVERY party copy in one transaction, and
  // two of them (`Vendor`, and `ProjectVendor` through its cascade) are procurement-owned. Parties
  // are orgs-owned, so the command lives here and reaches procurement's rows through
  // `ProcurementParticipant.repointVendorParty` rather than writing them directly. A
  // workflow-participant edge is cycle-exempt, which is what lets an orgs → procurement channel
  // coexist with procurement's own dependencies.
  workflowParticipants: ['nodes', 'activities', 'inspections', 'procurement'],
  producesEvents: [
    'project.created',
    'project.updated',
    'project.archived',
    'project.restored',
    'membership.added',
    'membership.role_changed',
    'membership.discipline_changed',
    'membership.removed',
  ],
  consumesEvents: [],
  commands: [
    'orgs.createOrg',
    'orgs.correctInvitationEmail',
    'orgs.addOrgMember',
    'orgs.updateOrgMemberRole',
    'orgs.removeOrgMember',
    'orgs.createProject',
    'orgs.updateProject',
    'orgs.deleteProject',
    'orgs.restoreProject',
    'orgs.createModule',
    'orgs.archiveModule',
    'orgs.createTemplate',
    'orgs.archiveTemplate',
    'members.add',
    'members.updateRole',
    'members.remove',
    'companies.add',
    'companies.update',
    'companies.remove',
    // Phase 6 unit 6.1b (§A) — the operator merge/repoint, exposed as the `party:merge` CLI.
    // Not an HTTP route: reconciling canonical identity is a rare, high-authority correction
    // that moves every reference a firm has and deletes an identity, which is the same shape as
    // `capability:enable` rather than a workflow step.
    'orgs.party.merge',
    // Phase 4 Task 3 (§H) — binding an orgs-owned WorkerDevice to a trusted Worker. The model is
    // orgs-owned, so the command lives here; the workflow it serves (trusted attendance evidence)
    // is Labour's, and it carries `labour.manage` authority + the labour capability gate.
    'orgs.workerDevice.bind',
  ],
  queries: [],
  routes: [
    // orgs.controller
    'POST /orgs',
    'PATCH /orgs/:orgId/members/:userId/invitation-email',
    'POST /orgs/:orgId/members',
    'PATCH /orgs/:orgId/members/:userId',
    'DELETE /orgs/:orgId/members/:userId',
    'POST /orgs/:orgId/projects',
    'PATCH /orgs/:orgId/projects/:pid',
    'DELETE /orgs/:orgId/projects/:pid',
    'POST /orgs/:orgId/projects/:pid/restore',
    'POST /orgs/:orgId/modules',
    'DELETE /orgs/:orgId/modules/:moduleId',
    'POST /orgs/:orgId/templates',
    'DELETE /orgs/:orgId/templates/:templateId',
    // members.controller
    'POST /projects/:projectId/members',
    'PATCH /projects/:projectId/members/:userId',
    'DELETE /projects/:projectId/members/:userId',
    // companies.controller
    'POST /projects/:projectId/companies',
    'PATCH /projects/:projectId/companies/:companyId',
    'DELETE /projects/:projectId/companies/:companyId',
    // worker-devices.controller (Phase 4 Task 3)
    'POST /projects/:projectId/worker-devices/:deviceId/bind',
  ],
  permissions: ['owner', 'admin', 'member', 'pmc', 'client', 'engineer', 'contractor'],
};
