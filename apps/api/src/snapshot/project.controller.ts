import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { ModuleRegistryService } from '../platform/module-registry/module-registry.service';
import { CapabilitiesService, MATERIALS_CAPABILITY, LABOUR_CAPABILITY } from '../platform/capabilities.service';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import type { ProjectShellDto } from './types';

@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class ProjectController {
  constructor(
    private readonly snapshot: SnapshotService,
    // Task 9 — the single enablement source for the manifest-driven shell/nav.
    private readonly registry: ModuleRegistryService,
    // Phase 3 Task 7 (§D) — the PER-PROJECT pilot capabilities, so the client can gate Materials.
    private readonly capabilities: CapabilitiesService,
  ) {}

  /** Phase 2 Task 9 — the PROJECT-SHELL summary: identity + `enabledModules` + projection counts, the
   *  light payload the app loads FIRST so the shell + nav render before the full data. Additive; the
   *  full snapshot below stays authoritative for the rest of the store. Phase 3 Task 7 adds the
   *  per-project `capabilities` (`['materials']` on a pilot project, `[]` otherwise); Phase 4
   *  Task 1 adds `'labour'` under the same per-project gate. */
  @Get('shell')
  @RolesFor('project.read')
  async shell(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser): Promise<ProjectShellDto> {
    const [summary, materials, labour] = await Promise.all([
      this.snapshot.shellSummary(projectId, user.role, user.sub),
      this.capabilities.isEnabled(projectId, MATERIALS_CAPABILITY),
      this.capabilities.isEnabled(projectId, LABOUR_CAPABILITY),
    ]);
    const capabilities = [...(materials ? [MATERIALS_CAPABILITY] : []), ...(labour ? [LABOUR_CAPABILITY] : [])];
    return { ...summary, enabledModules: this.registry.enabledModules, capabilities };
  }

  /** Full project snapshot the frontend hydrates its store from (RBAC-filtered by role).
   *  Interactive session roles only — an anonymously-minted worker device token gets the
   *  QR job-card flow, not the project's decisions/drawings/inspections (SEC-02). */
  @Get('snapshot')
  @RolesFor('project.read')
  snapshotFor(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
