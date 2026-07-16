import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ModuleManifest } from '@vitan/shared';
import { MODULE_MANIFESTS, enabledModuleIds, validateModuleRegistry } from './registry';

/**
 * Phase 2 Task 7 — validates the module registry at API STARTUP. A malformed boundary
 * (duplicate id, shared model, dependency cycle, unknown/dangling event, unknown role)
 * aborts boot rather than run a process whose declared module graph is inconsistent. The
 * SAME check runs in CI (`module-registry.test.ts`), so the failure surfaces long before
 * a deploy.
 */
@Injectable()
export class ModuleRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModuleRegistryService.name);

  onModuleInit(): void {
    const errors = validateModuleRegistry();
    if (errors.length) {
      const detail = errors.map((e) => `  [${e.code}] ${e.message}`).join('\n');
      throw new Error(`Module registry is invalid — refusing to boot:\n${detail}`);
    }
    this.logger.log(`Module registry valid: ${enabledModuleIds().length} modules enabled (${enabledModuleIds().join(', ')})`);
  }

  /** The manifests, for read-only consumers (e.g. a future manifest-driven nav/query). */
  get manifests(): readonly ModuleManifest[] {
    return MODULE_MANIFESTS;
  }

  /** The single enablement source (finding 7). */
  get enabledModules(): string[] {
    return enabledModuleIds();
  }
}
