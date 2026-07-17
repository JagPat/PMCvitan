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
  ownsModels: ['org', 'orgMembership', 'membership', 'project', 'projectCompany', 'projectTemplate', 'templateModule', 'user', 'workerDevice'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
  workflowParticipants: ['nodes', 'activities', 'inspections'],
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
  ],
  permissions: ['owner', 'admin', 'member', 'pmc', 'client', 'engineer', 'contractor'],
};
