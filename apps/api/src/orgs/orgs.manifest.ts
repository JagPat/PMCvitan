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
  dependsOn: [],
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
    "Post('orgs')",
    "Patch('orgs/:orgId/members/:userId/invitation-email')",
    "Post('orgs/:orgId/members')",
    "Patch('orgs/:orgId/members/:userId')",
    "Delete('orgs/:orgId/members/:userId')",
    "Post('orgs/:orgId/projects')",
    "Patch('orgs/:orgId/projects/:pid')",
    "Delete('orgs/:orgId/projects/:pid')",
    "Post('orgs/:orgId/projects/:pid/restore')",
    "Post('orgs/:orgId/modules')",
    "Delete('orgs/:orgId/modules/:moduleId')",
    "Post('orgs/:orgId/templates')",
    "Delete('orgs/:orgId/templates/:templateId')",
    // members.controller
    'Post()',
    "Patch(':userId')",
    "Delete(':userId')",
    // companies.controller
    'Post()',
    "Patch(':companyId')",
    "Delete(':companyId')",
  ],
  permissions: ['owner', 'admin', 'member', 'pmc', 'client', 'engineer', 'contractor'],
};
