/**
 * Phase 2 Task 7 — the module registry contract (shared api + web).
 *
 * Each module declares a MANIFEST: the Prisma models it exclusively owns, the other
 * modules it may call, the domain events it produces/consumes, and its
 * commands/queries/routes/permissions. {@link validateRegistry} checks the whole set
 * at API startup AND in CI, so a boundary can never silently drift:
 *
 *   - unique module ids;
 *   - exactly ONE owner per Prisma model (a second owner is a boundary violation);
 *   - every `dependsOn` id resolves to a registered module;
 *   - the `dependsOn` graph is ACYCLIC (a cycle means two modules reach into each
 *     other — the shape Phase 2 exists to remove);
 *   - every produced/consumed event is a known {@link DomainEventType} and every
 *     CONSUMED event is PRODUCED by some module (no subscription to an event that is
 *     never emitted);
 *   - every referenced permission is a known role;
 *   - route + command contributions are unique across the whole registry.
 *
 * Enablement (plan finding 7) is deliberately trivial: {@link enabledModules} is
 * "every compiled, registered module" — there is no per-tenant `ModuleInstallation`
 * used as runtime truth, and a manifest NEVER substitutes for a server-side
 * authorization check (spec §7, §18).
 */
import { DOMAIN_EVENT_TYPES, type DomainEventType } from './events';

const KNOWN_EVENTS: ReadonlySet<string> = new Set(DOMAIN_EVENT_TYPES);

export type ModuleKind = 'domain' | 'platform';

/** A module's declared, machine-checked boundary. */
export interface ModuleManifest {
  /** Stable kebab id, unique across the registry (matches the `src/<id>` directory). */
  readonly id: string;
  /** Human-readable title. */
  readonly title: string;
  /** `domain` owns a bounded context + its tables; `platform` is kernel/orchestration. */
  readonly kind: ModuleKind;
  /**
   * The Prisma models (camelCase, as `PrismaService` exposes them) this module
   * EXCLUSIVELY writes. One model has exactly one owner; a write to a model owned by
   * another module is the cross-module edge the boundary check forbids. Shared
   * infrastructure tables (AuditLog, Notification, DomainEvent, …) are owned by the
   * `platform` module and may be appended to from anywhere via the kernel helpers.
   */
  readonly ownsModels: readonly string[];
  /**
   * Module ids this module calls one-directionally — a typed query, a contract, or an
   * event subscription. The registry proves THIS graph is acyclic: an accidental mutual
   * reach between two modules is a boundary violation.
   */
  readonly dependsOn: readonly string[];
  /**
   * Module ids whose **transaction-bound atomic-workflow participant** this module
   * invokes within one unit of work (plan finding 4 / Task 7 Step 3). This is the
   * SANCTIONED mechanism for a cross-module consequence that must commit or roll back
   * together — the activity↔inspection sign-off, material→readiness, project→module
   * initialization. Unlike {@link dependsOn} it is EXEMPT from the acyclic check,
   * because an atomic workflow is one shared boundary two modules participate in as
   * equals, not an async/query coupling. Each entry must still resolve to a registered
   * module, and the participant it invokes writes ONLY the target module's own tables
   * (the boundary check proves no write leaks into the caller's file).
   */
  readonly workflowParticipants: readonly string[];
  /** Domain events this module emits (exact catalog base names). */
  readonly producesEvents: readonly DomainEventType[];
  /** Domain events this module subscribes to (each must be produced by some module). */
  readonly consumesEvents: readonly DomainEventType[];
  /** State-changing command types this module handles. */
  readonly commands: readonly string[];
  /** Read query types this module answers. */
  readonly queries: readonly string[];
  /**
   * The fully-qualified mutating HTTP routes the module's controller(s) declare, each as
   * a canonical `"<METHOD> /fully/qualified/path"` string (e.g.
   * `"POST /projects/:projectId/decisions"`). These are derived from Nest's controller +
   * handler metadata by the boundary analyzer (`boundary-analyzer.ts`), so a fully-qualified
   * route is GLOBALLY UNIQUE — {@link validateRegistry} rejects a route contributed by two
   * modules, and the analyzer proves this set equals the routes the compiled controllers
   * actually expose.
   */
  readonly routes: readonly string[];
  /** RBAC roles the module's commands reference (validated against the known-role set). */
  readonly permissions: readonly string[];
}

export interface RegistryValidationError {
  /** Machine code, e.g. `duplicate-id`, `cycle`, `unknown-event`, `dangling-consume`. */
  readonly code: string;
  /** Human-readable explanation naming the offending module(s). */
  readonly message: string;
}

/** Find a dependency cycle in the manifests' `dependsOn` graph, or null when acyclic. */
function findCycle(manifests: readonly ModuleManifest[]): string[] | null {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') {
      // the cycle is the tail of the stack from the first occurrence of `id`
      const from = stack.indexOf(id);
      return [...stack.slice(from), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      // a dangling dependency is reported separately; skip it here so the cycle walk is total
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const m of manifests) {
    const cycle = visit(m.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Validate the whole manifest set. Returns every problem found (empty ⇒ valid) so a
 * caller can report them all at once. `knownRoles` is the authoritative RBAC role set
 * the API supplies (token roles ∪ org roles ∪ named authorization groups).
 */
export function validateRegistry(
  manifests: readonly ModuleManifest[],
  knownRoles: ReadonlySet<string>,
): RegistryValidationError[] {
  const errors: RegistryValidationError[] = [];
  const seenIds = new Set<string>();
  for (const m of manifests) {
    if (seenIds.has(m.id)) errors.push({ code: 'duplicate-id', message: `Module id "${m.id}" is declared more than once` });
    seenIds.add(m.id);
  }

  // one owner per model
  const modelOwner = new Map<string, string>();
  for (const m of manifests) {
    for (const model of m.ownsModels) {
      const prior = modelOwner.get(model);
      if (prior && prior !== m.id) {
        errors.push({ code: 'shared-model', message: `Model "${model}" is claimed by both "${prior}" and "${m.id}" — one fact has one owner` });
      }
      modelOwner.set(model, m.id);
    }
  }

  // unique command contributions across the registry. Commands are module-prefixed and
  // MUST be unique.
  const commandOwner = new Map<string, string>();
  for (const m of manifests) {
    for (const c of m.commands) {
      const prior = commandOwner.get(c);
      if (prior) errors.push({ code: 'duplicate-command', message: `Command "${c}" is contributed by both "${prior}" and "${m.id}"` });
      else commandOwner.set(c, m.id);
    }
  }

  // unique route contributions across the registry. Fully-qualified `"<METHOD> /path"`
  // routes ARE globally unique (unlike the old bare decorator signatures like `Post()`),
  // so a route claimed by two modules is a boundary drift — the boundary analyzer proves
  // this same set against the compiled controllers.
  const routeOwner = new Map<string, string>();
  for (const m of manifests) {
    for (const r of m.routes) {
      const prior = routeOwner.get(r);
      if (prior) errors.push({ code: 'duplicate-route', message: `Route "${r}" is contributed by both "${prior}" and "${m.id}"` });
      else routeOwner.set(r, m.id);
    }
  }

  // dependencies resolve
  for (const m of manifests) {
    for (const dep of m.dependsOn) {
      if (!seenIds.has(dep)) errors.push({ code: 'unknown-dependency', message: `Module "${m.id}" depends on unregistered module "${dep}"` });
      if (dep === m.id) errors.push({ code: 'self-dependency', message: `Module "${m.id}" depends on itself` });
    }
    // workflow participants resolve too (but are cycle-exempt — an atomic workflow is a
    // shared boundary, not an async coupling)
    for (const wp of m.workflowParticipants) {
      if (!seenIds.has(wp)) errors.push({ code: 'unknown-participant', message: `Module "${m.id}" invokes unregistered workflow participant "${wp}"` });
      if (wp === m.id) errors.push({ code: 'self-participant', message: `Module "${m.id}" lists itself as a workflow participant` });
    }
  }

  // acyclic
  const cycle = findCycle(manifests);
  if (cycle) errors.push({ code: 'cycle', message: `Dependency cycle: ${cycle.join(' -> ')}` });

  // event compatibility
  const produced = new Set<string>();
  for (const m of manifests) for (const e of m.producesEvents) produced.add(e);
  for (const m of manifests) {
    for (const e of m.producesEvents) {
      if (!KNOWN_EVENTS.has(e)) errors.push({ code: 'unknown-event', message: `Module "${m.id}" produces unknown event "${e}"` });
    }
    for (const e of m.consumesEvents) {
      if (!KNOWN_EVENTS.has(e)) errors.push({ code: 'unknown-event', message: `Module "${m.id}" consumes unknown event "${e}"` });
      else if (!produced.has(e)) errors.push({ code: 'dangling-consume', message: `Module "${m.id}" consumes "${e}" which no module produces` });
    }
  }

  // permissions
  for (const m of manifests) {
    for (const role of m.permissions) {
      if (!knownRoles.has(role)) errors.push({ code: 'unknown-permission', message: `Module "${m.id}" references unknown role "${role}"` });
    }
  }

  return errors;
}

/**
 * The single source of enablement truth (finding 7): every compiled, registered
 * module is enabled. There is no per-tenant `ModuleInstallation` used as runtime truth
 * in Phase 2, and this list NEVER replaces a server-side authorization check.
 */
export function enabledModules(manifests: readonly ModuleManifest[]): string[] {
  return manifests.map((m) => m.id).sort();
}

/** Convenience: the `model -> owning module id` map the boundary check derives from manifests. */
export function modelOwnership(manifests: readonly ModuleManifest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of manifests) for (const model of m.ownsModels) out.set(model, m.id);
  return out;
}
