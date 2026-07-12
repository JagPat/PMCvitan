# Phase 0 Trust Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PMCvitan a trustworthy multi-project construction operating record by proving that every project-scoped fact, route, request, database reference, date and screen remains attached to exactly one authorized project.

**Architecture:** Preserve the existing React, Zustand, NestJS, Prisma and PostgreSQL modular-monolith product. Introduce one explicit frontend project-scope lifecycle, enforce live project access and same-project references at the API/database boundary, replace prototype day offsets with real dates additively, and verify the complete behavior against two projects in PostgreSQL and Playwright.

**Tech Stack:** pnpm workspace, React 19, Zustand 5, React Router 7, Vitest 4, Playwright 1.61, NestJS 11, Prisma 6, PostgreSQL, TypeScript.

## Global Constraints

- Read `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` before changing code; it is the canonical product and architecture specification for this phase.
- Preserve the existing application and evolve it; do not rewrite the frontend or API.
- The operational unit is one project representing one construction site. Dashboard and portfolio may aggregate; schedule, decisions, drawings, inspections, daily logs, materials and future commercial records must be project-scoped.
- Record each fact once in its owning module. Other modules store a reference or consume a versioned event; they do not copy an independently editable version.
- Automate copying, matching, calculation, forecasting, reminders and draft preparation. Keep client consent, technical judgment, physical acceptance, certification and payment authority human, attributable and auditable.
- Keep field interactions mobile-first and recoverable after retries, stale responses and unreliable connectivity.
- Use additive database migrations. Backfill and verify before making a new constraint mandatory; do not use `prisma db push` for this phase.
- Do not add procurement, inventory, labour, billing, GST or RedBracket features in Phase 0. This phase establishes the reliable foundation those modules require.
- Do not split the modular monolith into independently deployed services.
- Do not merge a task until its focused tests, all web/API unit tests, typechecks and PostgreSQL-backed tests pass.
- Update the canonical spec or add an ADR in the same PR if implementation changes an approved invariant.

---

## Product Intent Claude Must Preserve

PMCvitan is being built for an architect-led PMC to run real construction sites, first internally at one or two locations and later for other practices and contractors. Its purpose is not to collect unrelated forms. Its purpose is to keep one traceable information chain from design intent and client decision through drawing, planned work, procurement, site receipt, labour, inspection, measurement, bill certification and payment.

Before each task and PR, Claude Code must include a five-line vision-alignment statement in the PR description. The following is a concrete example for Task 2; replace its values with the values for the task being submitted:

```text
User decision improved: A PMC architect can switch sites and trust that every visible record belongs to the selected site.
Canonical fact owner: The authenticated project scope owns identity; each operational module owns its records.
Information flow: Auth switch result -> empty project scope -> matching project snapshot -> project screens.
Human work removed: No manual refresh or visual cross-check is needed to determine whether records belong to the selected site.
Trust invariant: Project A records never render or arrive under Project B identity.
```

Every submitted PR must contain concrete values rather than repeating this example.

Reject a design during self-review when it:

1. Adds a screen without defining the canonical record and its owner.
2. Stores a second editable copy of a fact already owned elsewhere.
3. Allows a project switch while old-project records can still render or arrive asynchronously.
4. Trusts a project identifier from a client without authorizing the user and validating referenced records.
5. Replaces an attributable approval with an automatic state transition.
6. Requires a site user to re-enter information that the system already has.
7. Works only with the Ambli seed, a fixed date window or a single project.

## Required Execution Order

Implement Tasks 1-8 in order. Each task is an independent review gate and should normally be one PR. Do not begin Task 5 until Task 4's live PostgreSQL integration job is green, and do not begin Task 8 until Tasks 2-7 are merged or rebased together.

This plan intentionally implements only Phase 0 of the canonical specification. It protects every existing project module and establishes the contracts required by them, but it does not complete decision reapproval, inspection correction, event-derived readiness, procurement, stock, labour, commercial control, external collaboration or RedBracket integration. After Phase 0 passes independent review, each later phase receives its own implementation plan and acceptance gate; the Phase Intent Map in the canonical specification controls their order and purpose.

## File Structure

| File | Responsibility |
|---|---|
| `CLAUDE.md` | Small permanent agent entrypoint that points to the canonical spec and this plan without copying their contents. |
| `apps/web/src/store/projectScope.ts` | Pure definitions and helpers for project-scope generation, empty project data and stale-response checks. |
| `apps/web/src/store/store.ts` | Owns the atomic project transition and applies project data only through the scope helpers. |
| `apps/web/src/layout/RouteBridge.tsx` | Reconciles URL and store while respecting a pending project transition. |
| `apps/web/src/data/useApiSync.ts` | Loads snapshots with a captured scope identity and reports explicit ready/error states. |
| `apps/web/src/layout/ProjectLoadBoundary.tsx` | Renders loading, access/error and empty states without exposing stale project records. |
| `apps/api/src/common/project-access.service.ts` | Canonical live authorization for a user, project and role. |
| `apps/api/src/common/auth.ts` | Verifies JWT identity/scope and delegates live project access to `ProjectAccessService`. |
| `apps/api/src/common/project-ref.ts` | Resolves optional foreign references and rejects references owned by another project. |
| `apps/api/test/integration/test-app.ts` | Starts and tears down a real Nest application backed by the test PostgreSQL database. |
| `apps/api/test/integration/fixtures.ts` | Creates two isolated organizations/projects/users with deterministic memberships. |
| `apps/api/test/integration/*.test.ts` | Proves live access, tenant isolation, date behavior and relational constraints against PostgreSQL. |
| `apps/api/prisma/migrations/20260826000000_phase0_project_integrity/migration.sql` | Additive composite tenant constraints and supporting unique keys. |
| `apps/api/prisma/migrations/20260827000000_phase0_real_dates/migration.sql` | Additive real date columns and deterministic backfill from legacy values. |
| `packages/shared/src/lib/dates.ts` | ISO civil-date parsing, formatting and date arithmetic for shared web-domain contracts. |
| `apps/api/src/common/civil-date.ts` | API-side ISO civil-date validation while the source-only shared package remains a web dependency. |
| `apps/web/playwright.api.config.ts` | Runs API-backed browser tests with both web and API servers. |
| `apps/web/tests/e2e-api/project-scope.spec.ts` | Browser-level proof that a project switch cannot mix project identity or records. |
| `scripts/test-api-e2e.sh` | One command to migrate/seed an isolated test database and run API-backed Playwright. |

## Task 1: Install the Vision and Baseline Gate

**Business outcome:** Every implementation agent starts from the same construction-management purpose and current architecture, and Phase 0 begins from a reproducible green baseline.

**Files:**
- Create: `CLAUDE.md`
- Modify: `package.json`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: canonical design at `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` and this implementation plan.
- Produces: root scripts `check:web`, `check:api`, and `check` used by every later task.

- [ ] **Step 1: Record the pre-change baseline**

Run:

```bash
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status --short
pnpm install --frozen-lockfile
pnpm --filter web test
pnpm --filter web typecheck
pnpm --filter api test
pnpm --filter api typecheck
```

Expected: record both revisions in the PR description; the worktree is clean before edits; all four test/typecheck commands exit `0`. If current `main` fails, stop and report the exact existing failure instead of hiding it in this phase.

- [ ] **Step 2: Create the permanent Claude entrypoint**

Create `CLAUDE.md` with exactly this responsibility and no duplicated architectural prose:

```markdown
# PMCvitan Agent Entry Point

Before architecture or implementation work, read:

1. `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
2. The active plan under `docs/superpowers/plans/`
3. `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/TENANCY.md`, `docs/TEMPLATES.md`, and `docs/ROADMAP.md`

Git is the project memory. Revalidate findings against current `main`; do not rely on chat history. One project represents one site. Project operational records never become global. One fact has one canonical owner. Preserve attributable human approvals. Use additive migrations and prove tenant isolation against PostgreSQL.

Before every PR, include the vision-alignment statement and review packet required by the active plan. A task is not complete until its focused tests and `pnpm check` pass.
```

- [ ] **Step 3: Add complete workspace checks**

Change the root `package.json` scripts to include:

```json
{
  "scripts": {
    "check:web": "pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build",
    "check:api": "pnpm --filter api prisma:generate && pnpm --filter api typecheck && pnpm --filter api test && pnpm --filter api build",
    "check": "pnpm check:web && pnpm check:api"
  }
}
```

Keep all existing scripts. Merge these keys into the existing `scripts` object rather than replacing it.

- [ ] **Step 4: Add the Phase 0 roadmap gate**

Add a `Phase 0 trust foundation` section near the top of `docs/ROADMAP.md` with unchecked rows for Tasks 2-8 and this completion rule:

```markdown
Phase 0 is complete only when the API-mode two-project Playwright suite and PostgreSQL integration suite pass in CI. Unit tests or the seeded local demo alone are insufficient evidence.
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm check`

Expected: all existing web/API lint, typecheck, unit-test and build stages pass.

```bash
git add CLAUDE.md package.json docs/ROADMAP.md
git commit -m "docs: install phase zero execution guardrails"
```

## Task 2: Make Project Switching an Atomic State Transition

**Business outcome:** A user can never see Project A's decisions, checklist, daily log or site identity under Project B's name.

**Canonical fact owner:** `AuthResult.projectId` establishes the authenticated scope; the matching `ApiSnapshot.project.id` supplies project identity and operational records.

**Files:**
- Create: `apps/web/src/store/projectScope.ts`
- Modify: `apps/web/src/store/store.ts`
- Modify: `apps/web/src/store/selectors.ts`
- Modify: `apps/web/src/screens/EngineerChecklistScreen.tsx`
- Modify: `apps/web/src/screens/DailyLogScreen.tsx`
- Modify: `apps/web/src/screens/DashboardScreen.tsx`
- Modify: `apps/web/src/screens/ClientHealthScreen.tsx`
- Test: `apps/web/tests/store.api.test.ts`
- Test: `apps/web/tests/auth.test.ts`
- Test: `apps/web/tests/actionQueue.test.ts`

**Interfaces:**
- Consumes: `AuthResult.projectId`, `ApiSnapshot.project.id`, and project collections already defined in `AppState`.
- Produces: `ProjectLoadState`, `ProjectScope`, `emptyProjectData()`, `isCurrentProjectScope()`, nullable `checklist`/`dailyLog`, and `switchProject(projectId, targetScreen?) => Promise<boolean>`.

- [ ] **Step 1: Write failing authentication and clearing tests**

Add focused tests that express the complete contract:

```ts
it('adopts the project returned by authentication instead of retaining the requested or seeded project', async () => {
  const gateway = {
    login: vi.fn().mockResolvedValue({
      token: 'JWT-project-b', role: 'pmc', projectId: 'project-b', name: 'Project B PMC',
    }),
  };
  s()._setGateway(gateway as unknown as ApiGateway);
  s().login('pmc@vitan.in', 'secret');
  await flush();
  expect(s().activeProjectId).toBe('project-b');
});

it('clears every project-owned field before requesting the next snapshot', async () => {
  const pending = deferred<AuthResult>();
  gateway.switchProject.mockReturnValue(pending.promise);
  const switching = useStore.getState().switchProject('project-b');
  const state = useStore.getState();
  expect(state.pendingProjectId).toBe('project-b');
  expect(state.projectLoadState).toBe('switching');
  expect(state.decisions).toEqual([]);
  expect(state.activities).toEqual([]);
  expect(state.drawings).toEqual([]);
  expect(state.checklist).toBeNull();
  expect(state.dailyLog).toBeNull();
  pending.resolve(authResultFor('project-b'));
  await switching;
});

it('assigns nullable snapshot records directly so absence cannot retain old-project data', () => {
  seedProjectAWithChecklistAndDailyLog();
  applyProjectBSnapshot({ checklist: null, dailyLog: null });
  expect(useStore.getState().checklist).toBeNull();
  expect(useStore.getState().dailyLog).toBeNull();
});
```

Implement `deferred`, `authResultFor`, and seed helpers locally in the test file using typed objects, not production exports.

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
pnpm --filter web test -- tests/auth.test.ts tests/store.api.test.ts tests/actionQueue.test.ts
```

Expected: failures show that `projectId` is not adopted, checklist/daily log remain populated, and the new load-state properties do not exist.

- [ ] **Step 3: Add the project-scope types and pure helpers**

Create `apps/web/src/store/projectScope.ts`:

```ts
import type {
  Activity,
  AppNotification,
  Checklist,
  DailyLog,
  Decision,
  Drawing,
  Material,
  Phase,
  Photo,
  PlacedInspection,
  ProjectCompany,
  ProjectMember,
  ProjectNode,
  Review,
} from '@vitan/shared';

export type ProjectLoadState = 'idle' | 'switching' | 'loading' | 'ready' | 'error';

export interface ProjectScope {
  projectId: string;
  generation: number;
}

export interface ProjectDataState {
  decisions: Decision[];
  nodes: ProjectNode[];
  checklist: Checklist | null;
  reviews: Review[];
  activeReviewId: string | null;
  reinspectionCreated: boolean;
  drawings: Drawing[];
  photos: Photo[];
  materials: Material[];
  placedInspections: PlacedInspection[];
  phases: Phase[];
  members: ProjectMember[];
  activities: Activity[];
  dailyLog: DailyLog | null;
  notifications: AppNotification[];
  companies: ProjectCompany[];
}

export function emptyProjectData(): ProjectDataState {
  return {
    decisions: [],
    nodes: [],
    checklist: null,
    reviews: [],
    activeReviewId: null,
    reinspectionCreated: false,
    drawings: [],
    photos: [],
    materials: [],
    placedInspections: [],
    phases: [],
    members: [],
    activities: [],
    dailyLog: null,
    notifications: [],
    companies: [],
  };
}

export function isCurrentProjectScope(
  currentProjectId: string,
  currentGeneration: number,
  captured: ProjectScope,
): boolean {
  return currentProjectId === captured.projectId && currentGeneration === captured.generation;
}
```

- [ ] **Step 4: Implement one atomic adoption path in the store**

Add these fields to `AppState`:

```ts
pendingProjectId: string | null;
projectScopeGeneration: number;
projectLoadState: ProjectLoadState;
projectLoadError: string | null;
checklist: Checklist | null;
dailyLog: DailyLog | null;
```

Change `switchProject` to return `Promise<boolean>` and accept an optional target screen. Change the snapshot action to accept the captured scope used by network callers while retaining an optional current-scope default for direct local tests:

```ts
switchProject: (projectId: string, targetScreen?: ScreenKey) => Promise<boolean>;
applySnapshot: (snapshot: ApiSnapshot, capturedScope?: ProjectScope) => boolean;
```

At the beginning of a switch, in one Zustand `set` call: increment `projectScopeGeneration`, set `pendingProjectId`, set `projectLoadState = 'switching'`, clear `projectLoadError`, and assign `emptyProjectData()`. After `/auth/switch` succeeds, adopt `result.projectId`, `result.role`, `result.token`, `result.name`, and a role-allowed `targetScreen`; never adopt the caller's `projectId` as the authenticated scope. On failure, retain the old authenticated project identity but keep project data empty, clear `pendingProjectId`, set `projectLoadState = 'error'`, set a user-readable error and return `false`.

Route passwordless login, phone OTP, email OTP, Google login and project switching through one internal `applyAuthResult(result: AuthResult, targetScreen?: ScreenKey)` helper. Remove the separate field-by-field auth adoption blocks.

In `applySnapshot`, set `capturedScope` to the current `{ projectId, generation }` only when the caller omits it. Reject and return `false` unless both `snap.project.id === activeProjectId` and `isCurrentProjectScope(...)` is true. Assign `checklist` and `dailyLog` directly, including `null`; do not use truthiness guards. Return `true` only when the snapshot was applied so `useApiSync` cannot mark a stale response ready.

- [ ] **Step 5: Make nullable records honest in selectors and screens**

Use explicit empty states rather than seed fallback:

```tsx
if (!dailyLog) {
  return <EmptyState title="No daily log started" detail="Start today's log when site work begins." />;
}
```

```tsx
if (!checklist) {
  return <EmptyState title="No checklist issued" detail="The PMC has not issued an inspection checklist for this project." />;
}
```

Update selectors so totals use `s.dailyLog?.crew.reduce(...) ?? 0`, action items are emitted only when the source record exists, and dashboards display zero/empty state instead of Ambli seed data.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm --filter web test -- tests/auth.test.ts tests/store.api.test.ts tests/actionQueue.test.ts
pnpm --filter web typecheck
pnpm --filter web lint
```

Expected: all focused suites pass; TypeScript has no unsafe nullable access; lint exits `0`.

```bash
git add apps/web/src/store/projectScope.ts apps/web/src/store/store.ts apps/web/src/store/selectors.ts apps/web/src/screens apps/web/tests/auth.test.ts apps/web/tests/store.api.test.ts apps/web/tests/actionQueue.test.ts
git commit -m "fix: make project scope transitions atomic"
```

## Task 3: Stop Route, Snapshot and Loader Races

**Business outcome:** Deep links, browser navigation and late network replies cannot change the visible project or place stale data into the active project.

**Files:**
- Create: `apps/web/src/layout/ProjectLoadBoundary.tsx`
- Modify: `apps/web/src/layout/RouteBridge.tsx`
- Modify: `apps/web/src/layout/AppShell.tsx`
- Modify: `apps/web/src/data/useApiSync.ts`
- Modify: `apps/web/src/store/store.ts`
- Test: `apps/web/tests/routing.test.ts`
- Test: `apps/web/tests/store.api.test.ts`
- Test: `apps/web/tests/e2e/routing.spec.ts`

**Interfaces:**
- Consumes: `ProjectScope`, `isCurrentProjectScope`, `pendingProjectId`, `projectLoadState`, and async `switchProject(projectId, targetScreen?)` from Task 2.
- Produces: `captureProjectScope(): ProjectScope`, guarded application of every project-scoped loader, and `ProjectLoadBoundary`.

- [ ] **Step 1: Write failing race tests**

Add these scenarios:

```ts
it('does not rewrite a project-B deep link back to project A while auth switch is pending', async () => {
  renderAt('/projects/project-b/decisions');
  expect(mockSwitchProject).toHaveBeenCalledWith('project-b', 'decision-log');
  expect(location.pathname).toBe('/projects/project-b/decisions');
});

it('ignores a team response captured before a project switch', async () => {
  const oldTeam = deferred<ProjectMember[]>();
  gateway.listMembers.mockReturnValueOnce(oldTeam.promise);
  const load = useStore.getState().loadTeam();
  await useStore.getState().switchProject('project-b');
  oldTeam.resolve(projectAMembers);
  await load;
  expect(useStore.getState().members).not.toEqual(projectAMembers);
});

it('shows a project load error without rendering records from the prior project', async () => {
  gateway.switchProject.mockRejectedValue(new Error('Forbidden'));
  await useStore.getState().switchProject('project-b');
  expect(useStore.getState().projectLoadState).toBe('error');
  expect(useStore.getState().decisions).toEqual([]);
});
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
pnpm --filter web test -- tests/routing.test.ts tests/store.api.test.ts
```

Expected: route is rewritten during the pending switch, the old team response is applied, and no explicit error boundary exists.

- [ ] **Step 3: Make URL reconciliation one-way during a transition**

In `RouteBridge.tsx`, parse the URL once per location change. If its project differs from `activeProjectId`, validate it against memberships and call:

```ts
void switchProject(parsed.projectId, parsed.screen ?? undefined);
return;
```

The store-to-URL effect must return without navigation while `pendingProjectId !== null` or `projectLoadState` is `switching`/`loading`. For an unknown project, replace the URL with `pathForScreen(screen, activeProjectId)`. For a known project but forbidden screen, switch project and select `screensFor(returnedRole)[0].key` inside `applyAuthResult`.

- [ ] **Step 4: Guard every project-scoped async response**

Add this action:

```ts
captureProjectScope: (): ProjectScope => ({
  projectId: get().activeProjectId,
  generation: get().projectScopeGeneration,
});
```

For `loadTeam`, `loadCompanies`, project snapshot loads, drawing/media mutations that refetch, outbox flushes and any project-scoped loader found with `rg "await api\\." apps/web/src/store apps/web/src/data`, capture the scope before awaiting and apply the response only when:

```ts
isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, captured)
```

Do not apply this guard to organization-level loaders (`myOrgs`, org members/templates) or portfolio aggregation; those must instead capture the authenticated user/session token and ignore responses after sign-out.

- [ ] **Step 5: Add the load boundary**

Create `ProjectLoadBoundary.tsx` with this state contract:

```tsx
interface ProjectLoadBoundaryProps {
  state: ProjectLoadState;
  error: string | null;
  onRetry: () => void;
  children: React.ReactNode;
}
```

Render a stable full-content loading state for `switching`/`loading`, an error state with a retry button for `error`, and children only for `idle` in demo mode or `ready` in API mode. Wrap `ScreenView` with it in `AppShell.tsx`. In `useApiSync`, set `loading` before the snapshot request, `ready` only after a current-scope snapshot is applied, and `error` on a current-scope failure.

- [ ] **Step 6: Run focused and browser tests, then commit**

Run:

```bash
pnpm --filter web test -- tests/routing.test.ts tests/store.api.test.ts
pnpm --filter web test:e2e -- tests/e2e/routing.spec.ts
pnpm --filter web typecheck
```

Expected: all commands pass; the route test proves the requested project path remains stable during the switch.

```bash
git add apps/web/src/layout apps/web/src/data/useApiSync.ts apps/web/src/store/store.ts apps/web/tests/routing.test.ts apps/web/tests/store.api.test.ts apps/web/tests/e2e/routing.spec.ts
git commit -m "fix: guard project routes and async responses"
```

## Task 4: Add a Real PostgreSQL Integration Gate and Live Access Check

**Business outcome:** Removing a person from a project or archiving the project revokes access immediately; an unexpired token alone is not continuing authority.

**Files:**
- Create: `apps/api/vitest.integration.config.ts`
- Create: `apps/api/test/integration/test-app.ts`
- Create: `apps/api/test/integration/fixtures.ts`
- Create: `apps/api/test/integration/project-access.test.ts`
- Create: `apps/api/src/common/project-access.service.ts`
- Modify: `apps/api/src/common/auth.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/auth/auth.tenancy.test.ts`
- Modify: `apps/api/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: JWT `AuthUser { sub, role, projectId, orgId? }`, `Membership`, `OrgMembership`, `Project.archivedAt`.
- Produces: `ProjectAccessService.authorize(user: AuthUser, projectId: string): Promise<AuthUser>` and `pnpm --filter api test:integration`.

- [ ] **Step 1: Add test dependencies and script**

Run:

```bash
pnpm --filter api add -D @nestjs/testing supertest @types/supertest
```

Add to `apps/api/package.json`:

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 2: Create the integration configuration and app helper**

Create `vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

`test-app.ts` must compile `AppModule`, create a `NestExpressApplication`, apply the same validation/CORS/bootstrap configuration as `src/main.ts` through an extracted `configureApp(app)` helper, initialize it, and close both Nest and Prisma in `afterAll`. `fixtures.ts` must create unique IDs for two orgs/projects and four users, and delete them in reverse foreign-key order inside a transaction.

- [ ] **Step 3: Write failing live-access integration tests**

Use real HTTP requests and the real database:

```ts
it('rejects a previously issued token after membership removal', async () => {
  const token = await issueProjectToken(memberUser.id, projectA.id);
  await prisma.membership.update({
    where: { projectId_userId: { projectId: projectA.id, userId: memberUser.id } },
    data: { status: 'removed' },
  });
  await request(app.getHttpServer())
    .get(`/projects/${projectA.id}/snapshot`)
    .set('Authorization', `Bearer ${token}`)
    .expect(403);
});

it('rejects access to an archived project', async () => {
  const token = await issueProjectToken(memberUser.id, projectA.id);
  await prisma.project.update({ where: { id: projectA.id }, data: { archivedAt: new Date() } });
  await request(app.getHttpServer())
    .get(`/projects/${projectA.id}/snapshot`)
    .set('Authorization', `Bearer ${token}`)
    .expect(403);
});

it('allows an org owner to operate an active project in the same org as pmc', async () => {
  const token = await issueOrgOwnerToken(ownerUser.id, projectA.id, orgA.id);
  await request(app.getHttpServer())
    .get(`/projects/${projectA.id}/snapshot`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
});
```

- [ ] **Step 4: Run integration tests to verify failure**

Run after starting a disposable PostgreSQL database and applying migrations:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pmcvitan_test pnpm --filter api prisma:migrate
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pmcvitan_test JWT_SECRET=integration-test-secret pnpm --filter api test:integration
```

Expected: removed-membership and archived-project tests fail because the current guard trusts the signed token.

- [ ] **Step 5: Implement one live project-access service**

Create this public contract:

```ts
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(user: AuthUser, projectId: string): Promise<AuthUser> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { orgId: true, archivedAt: true },
    });
    if (!project || project.archivedAt) throw new ForbiddenException('Project is unavailable');

    const membership = await this.prisma.membership.findUnique({
      where: { projectId_userId: { projectId, userId: user.sub } },
      select: { role: true, status: true },
    });
    if (membership?.status === 'active') {
      if (membership.role !== user.role) throw new ForbiddenException('Project role changed; sign in again');
      return user;
    }

    const orgMembership = project.orgId
      ? await this.prisma.orgMembership.findUnique({
          where: { orgId_userId: { orgId: project.orgId, userId: user.sub } },
          select: { role: true },
        })
      : null;
    if (user.role === 'pmc' && (orgMembership?.role === 'owner' || orgMembership?.role === 'admin')) return user;
    throw new ForbiddenException('Project access has been removed');
  }
}
```

Make `JwtGuard.canActivate` async. Keep the token/route-project mismatch check first, then call `authorize` only for routes with `:projectId`, attach the returned user and return `true`. Org routes using `:pid` remain under their existing org authorization path. Register `ProjectAccessService` in `AppModule`.

Update unit tests to inject a typed fake `ProjectAccessService` and await `canActivate`.

- [ ] **Step 6: Put PostgreSQL in CI**

Add a `postgres:16` service to the API job with database `pmcvitan_test`, user/password `postgres`, a `pg_isready` health check, and set:

```yaml
DATABASE_URL: postgresql://postgres:postgres@localhost:5432/pmcvitan_test?schema=public
JWT_SECRET: ci-integration-secret-not-used-in-production
```

After `prisma:generate`, run `pnpm --filter api prisma:migrate`, then unit tests, integration tests, typecheck and build. Remove the dummy-URL comment.

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm --filter api test
pnpm --filter api test:integration
pnpm --filter api typecheck
pnpm --filter api build
```

Expected: all commands pass against PostgreSQL; tests prove revocation and archive checks.

```bash
git add apps/api .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "security: enforce live project access"
```

## Task 5: Enforce Same-Project References in Services and PostgreSQL

**Business outcome:** A drawing, photo, activity, decision, daily log or inspection can never be linked to a record from another project, even through a forged request or direct database write.

**Files:**
- Create: `apps/api/src/common/project-ref.ts`
- Create: `apps/api/prisma/migrations/20260826000000_phase0_project_integrity/migration.sql`
- Create: `apps/api/test/integration/project-reference-integrity.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/drawings/drawings.service.ts`
- Modify: `apps/api/src/media/media.service.ts`
- Modify: `apps/api/src/activities/activities.service.ts`
- Modify: `apps/api/src/inspections/inspections.service.ts`
- Modify: `apps/api/src/daily-log/daily-log.service.ts`
- Test: `apps/api/src/drawings/drawings.service.test.ts`
- Test: `apps/api/src/media/media.service.test.ts`

**Interfaces:**
- Consumes: every input field ending in `Id` that points to a project-owned record.
- Produces: `resolveProjectRef(model, projectId, id, field): Promise<string | null>` and composite database references including `projectId`.

- [ ] **Step 1: Inventory and classify references**

Run:

```bash
rg -n '\b(decisionId|activityId|dailyLogId|inspectionId|nodeId|drawingId)\b' apps/api/src apps/api/prisma/schema.prisma
```

In the PR description, list every reference as `strict`, `optional-set-null`, or `external`. `nodeId` remains optional-set-null where current deletion semantics require it. No project-owned reference may remain unclassified.

- [ ] **Step 2: Write failing service and database tests**

Add service tests for forged cross-project `decisionId`, `activityId`, `dailyLogId` and `nodeId`, each expecting `BadRequestException`. Add a database test that attempts a cross-project create through Prisma and expects a foreign-key error:

```ts
await expect(prisma.drawing.create({
  data: {
    id: uniqueId('drawing'),
    projectId: projectB.id,
    title: 'Forged link',
    discipline: 'Architecture',
    activityId: projectAActivity.id,
    decisionId: projectADecision.id,
  },
})).rejects.toMatchObject({ code: 'P2003' });
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
pnpm --filter api test -- src/drawings/drawings.service.test.ts src/media/media.service.test.ts
pnpm --filter api test:integration -- project-reference-integrity.test.ts
```

Expected: the current services accept at least the loose drawing/media references and PostgreSQL permits the loose relation.

- [ ] **Step 4: Add one shared resolver**

Create an exhaustive model switch rather than accepting arbitrary Prisma model names:

```ts
export type ProjectRefModel = 'activity' | 'dailyLog' | 'decision' | 'inspection' | 'node';

export async function resolveProjectRef(
  prisma: PrismaService,
  model: ProjectRefModel,
  projectId: string,
  id: string | null | undefined,
  field: string,
): Promise<string | null> {
  if (!id) return null;
  let row: { id: string } | null;
  switch (model) {
    case 'activity':
      row = await prisma.activity.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'dailyLog':
      row = await prisma.dailyLog.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'decision':
      row = await prisma.decision.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'inspection':
      row = await prisma.inspection.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'node':
      row = await prisma.projectNode.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
  }
  if (!row) throw new BadRequestException(`${field} does not belong to this project`);
  return id;
}
```

Use this resolver before every service write containing an optional project-owned reference.

- [ ] **Step 5: Add composite database constraints additively**

For each referenced model, add `@@unique([projectId, id])`. For referencing models, add the owning project to the relation fields, for example:

```prisma
activity Activity? @relation(fields: [projectId, activityId], references: [projectId, id], onDelete: SetNull)
```

Where Prisma/PostgreSQL does not allow `SET NULL` because `projectId` is also the non-null owning key, use `NoAction` plus the existing service deletion behavior, or retain the scalar without a Prisma relation and add a SQL constraint whose deletion behavior is explicitly tested. Never make the owning `projectId` nullable.

Before adding constraints, the migration must run diagnostic queries that fail deliberately if any cross-project rows exist. It must not silently null or reassign corrupt links. Apply unique keys first, then composite foreign keys.

- [ ] **Step 6: Verify migration and commit**

Run on a fresh database and a copy seeded with current demo data:

```bash
pnpm --filter api prisma:migrate
pnpm --filter api prisma:generate
pnpm --filter api test
pnpm --filter api test:integration
pnpm --filter api typecheck
```

Expected: all tests pass; the direct cross-project write fails with `P2003`; normal same-project create/update/delete behavior remains green.

```bash
git add apps/api/prisma apps/api/src/common/project-ref.ts apps/api/src/drawings apps/api/src/media apps/api/src/activities apps/api/src/inspections apps/api/src/daily-log apps/api/test/integration/project-reference-integrity.test.ts
git commit -m "security: enforce project-owned references"
```

## Task 6: Replace Prototype Day Offsets with Real Civil Dates

**Business outcome:** Schedules and daily logs remain correct across different project starts, months, years and time zones, enabling later delivery planning, labour readiness and cash-flow forecasting.

**Canonical fact owner:** Each project owns `scheduleStartDate`; activities/phases own planned and actual civil dates; daily logs own `logDate`. Display strings are derived and never sorted or compared.

**Files:**
- Create: `apps/api/prisma/migrations/20260827000000_phase0_real_dates/migration.sql`
- Create: `apps/api/test/integration/real-dates.test.ts`
- Create: `apps/api/src/common/clock.ts`
- Create: `apps/api/src/common/civil-date.ts`
- Create: `apps/api/src/common/civil-date.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `packages/shared/src/lib/dates.ts`
- Modify: `packages/shared/src/domain/types.ts`
- Modify: `packages/shared/src/domain/seed.ts`
- Modify: `apps/api/src/snapshot/types.ts`
- Modify: `apps/api/src/snapshot/snapshot.service.ts`
- Modify: `apps/api/src/activities/activities.service.ts`
- Modify: `apps/api/src/activities/phases.service.ts`
- Modify: `apps/api/src/daily-log/daily-log.service.ts`
- Modify: `apps/api/src/inspections/inspections.service.ts`
- Modify: `apps/api/src/orgs/orgs.service.ts`
- Modify: `apps/web/src/data/apiGateway.ts`
- Modify: `apps/web/src/screens/SiteScheduleScreen.tsx`
- Test: `apps/web/tests/format.test.ts`
- Test: existing activity, daily-log, snapshot and template service tests.

**Interfaces:**
- Consumes: legacy `Project.projStart/projEnd/todayDay`, `Activity.plannedStart/plannedEnd/actualStart/actualEnd`, `Phase.plannedStart/plannedEnd`, and display `DailyLog.date`.
- Produces: ISO `YYYY-MM-DD` strings at API/shared boundaries and PostgreSQL `date` columns internally.

- [ ] **Step 1: Write failing date tests**

Add tests for leap years, month/year sorting and project-specific starts:

```ts
expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29');
expect(formatCivilDate('2026-07-03')).toBe('03 Jul 2026');
expect(sortCivilDates(['2027-01-01', '2026-12-31'])).toEqual(['2026-12-31', '2027-01-01']);
```

The integration test must create logs for `2026-12-31` and `2027-01-01` and prove latest-log selection returns `2027-01-01`, independent of formatted labels.

- [ ] **Step 2: Verify current behavior fails**

Run:

```bash
pnpm --filter web test -- tests/format.test.ts
pnpm --filter api test:integration -- real-dates.test.ts
```

Expected: ISO helpers/columns are absent and the current daily-log service orders a display string.

- [ ] **Step 3: Add deterministic civil-date helpers**

In `packages/shared/src/lib/dates.ts`, use UTC arithmetic only:

```ts
const ISO_CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCivilDate(value: string): Date {
  if (!ISO_CIVIL_DATE.test(value)) throw new Error(`Invalid civil date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid civil date: ${value}`);
  }
  return date;
}

export function addCivilDays(value: string, days: number): string {
  const date = parseCivilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function formatCivilDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(parseCivilDate(value)).replace(',', '');
}

export function sortCivilDates(values: string[]): string[] {
  return [...values].sort((a, b) => parseCivilDate(a).getTime() - parseCivilDate(b).getTime());
}
```

The API currently cannot import the source-only ESM `@vitan/shared` package from its CommonJS build. Create `apps/api/src/common/civil-date.ts` with `parseCivilDate` and `addCivilDays` using the same signatures and algorithm, and pin both implementations to the same leap/year-boundary vectors in their respective test suites. This is utility-code duplication, not duplicated domain data; Task 2 of the architecture sequence will promote `@vitan/shared` to a built runtime package and remove the API copy.

- [ ] **Step 4: Add and backfill date columns**

Add nullable columns first:

```prisma
Project.scheduleStartDate DateTime? @db.Date
Project.scheduleEndDate   DateTime? @db.Date
Project.timeZone          String    @default("Asia/Kolkata")
Activity.plannedStartDate DateTime? @db.Date
Activity.plannedEndDate   DateTime? @db.Date
Activity.actualStartDate  DateTime? @db.Date
Activity.actualEndDate    DateTime? @db.Date
Phase.plannedStartDate    DateTime? @db.Date
Phase.plannedEndDate      DateTime? @db.Date
DailyLog.logDate          DateTime? @db.Date
Inspection.inspectionDate DateTime? @db.Date
```

Backfill `scheduleStartDate` by parsing `projStart`; for the current seeded project, verify it resolves to `2026-01-12`. Backfill activity/phase date columns as `scheduleStartDate + legacy offset`, preserving the existing offset convention after a characterization test determines whether offset `0` is the start date or the following day. Backfill `logDate` and `inspectionDate` with explicit `to_date(date, 'DD Mon YYYY')` guarded by a matching regular expression. Abort the migration on unparseable non-empty values; do not substitute today's date.

Keep legacy fields for compatibility during this task. Make new date columns non-null only for records whose domain requires dates after the backfill diagnostics pass.

- [ ] **Step 5: Cut services and contracts over to ISO dates**

Change shared/API DTO fields to `plannedStartDate`, `plannedEndDate`, `actualStartDate`, `actualEndDate`, `logDate`, `inspectionDate`, `scheduleStartDate`, and `scheduleEndDate`, all serialized as `YYYY-MM-DD`. Add `timeZone` to project create/update/snapshot contracts, defaulting to `Asia/Kolkata` for current projects. Daily-log queries order by `logDate`; starting/completing an activity writes the server's current civil date in the project's configured time zone through one injected clock helper. Do not derive actual dates from `Project.todayDay`.

Create the injectable clock contract in `apps/api/src/common/clock.ts`:

```ts
export interface Clock {
  today(timeZone: string): string;
}

@Injectable()
export class SystemClock implements Clock {
  today(timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }
}
```

Register `SystemClock` once in `AppModule` under an exported `CLOCK` symbol so activity/daily-log services can receive a deterministic fake in unit tests.

Keep a compatibility adapter in `apiGateway.ts` for demo seed data during this task; API mode must use only real dates. Update schedule geometry by deriving offsets from `scheduleStartDate` at render time.

Reusable templates remain organization methods, not dated project records. When saving a project as a template, derive each phase/activity's relative offset from `scheduleStartDate`; when instantiating it into a project, convert those offsets to new project dates. Never copy the source project's absolute dates into the new project.

- [ ] **Step 6: Verify dates and commit**

Run:

```bash
pnpm --filter api prisma:migrate
pnpm --filter api test
pnpm --filter api test:integration
pnpm --filter web test
pnpm --filter web typecheck
pnpm check
```

Expected: all pass; latest-log selection crosses a year boundary correctly; no API query orders by the legacy display `date` field; no activity mutation writes `todayDay` into an actual date.

```bash
git add apps/api/prisma apps/api/src packages/shared/src apps/web/src apps/web/tests apps/api/test/integration/real-dates.test.ts
git commit -m "refactor: establish real project dates"
```

## Task 7: Remove Seeded Claims from API Mode

**Business outcome:** Live users see only facts recorded for the active project. Empty or unavailable data is shown honestly; Ambli sample content is never presented as another site's reality.

**Files:**
- Modify: `apps/web/src/screens/DailyLogScreen.tsx`
- Modify: `apps/web/src/screens/DashboardScreen.tsx`
- Modify: `apps/web/src/screens/ClientHealthScreen.tsx`
- Modify: `apps/web/src/screens/PortfolioScreen.tsx`
- Modify: `apps/web/src/store/selectors.ts`
- Modify: `apps/web/src/data/apiGateway.ts`
- Create: `apps/web/tests/api-truthfulness.test.tsx`
- Test: `apps/web/tests/store.api.test.ts`
- Test: `apps/web/tests/e2e/phases-portfolio.spec.ts`

**Interfaces:**
- Consumes: live project identity, nullable daily log/checklist, snapshot photos/materials/phases, and `API_BASE` mode.
- Produces: explicit live, empty and unavailable states; no API-mode fallback to `PROJECT`, `SEED_*`, fixed photo totals or fake report completion.

- [ ] **Step 1: Write failing truthfulness tests**

Add a Testing Library test that sets API mode, applies a blank Project B snapshot, renders each affected screen and asserts:

```ts
expect(screen.queryByText(/Ambli/i)).not.toBeInTheDocument();
expect(screen.queryByText(/Residence at/i)).not.toBeInTheDocument();
expect(screen.getByText('No daily log started')).toBeInTheDocument();
expect(screen.getByText('No progress photos recorded')).toBeInTheDocument();
expect(screen.getByText('No portfolio data available')).toBeInTheDocument();
```

Because `API_BASE` is resolved at module load, the test setup must call `vi.stubEnv('VITE_API_URL', 'http://api.test')`, then `vi.resetModules()`, then dynamically import the gateway, store and screens. Restore environment variables and modules in `afterEach` so existing demo-mode tests remain isolated.

Add a test that report generation is disabled or labelled unavailable until backed by a real API endpoint; clicking it must not show a success toast claiming a generated report.

- [ ] **Step 2: Locate every seeded runtime fallback**

Run:

```bash
rg -n 'Ambli|Residence at|SEED_|PROJECT\.|progress photos|report generated|Generate report' apps/web/src
```

Classify every hit as `demo-only`, `API-live`, or `copy`. Any `API-live` hit must be removed or replaced in this task.

- [ ] **Step 3: Implement honest data states**

Use `name`, `short`, `location`, `dailyLog`, `photos`, `materials`, `phases` and `portfolio` from current state. Keep seeded behavior only behind `!API_BASE`. In API mode:

```ts
const visiblePortfolio = portfolio;
```

Do not append a fabricated current-project row when the API returns an empty portfolio. Compute photo/material totals from snapshot arrays. Use the project location rather than literal site copy. Hide or disable report generation with `title="Report export is not available yet"` until an actual server export exists; do not simulate success.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter web test
pnpm --filter web test -- tests/api-truthfulness.test.tsx
pnpm --filter web test:e2e -- tests/e2e/phases-portfolio.spec.ts
pnpm --filter web typecheck
pnpm --filter web lint
```

Expected: all pass; API-mode tests contain no Ambli content for Project B and no fake report success.

```bash
git add apps/web/src/screens apps/web/src/store/selectors.ts apps/web/src/data/apiGateway.ts apps/web/tests
git commit -m "fix: make api mode reflect only live project data"
```

## Task 8: Prove the Foundation End to End and Produce the Review Packet

**Business outcome:** The team has one repeatable command and one CI gate proving multi-project correctness before product modules are expanded.

**Files:**
- Create: `apps/web/playwright.api.config.ts`
- Create: `apps/web/tests/e2e-api/project-scope.spec.ts`
- Create: `scripts/test-api-e2e.sh`
- Create: `docs/reviews/phase-0-review-packet.md`
- Modify: `apps/api/prisma/seed.ts`
- Modify: `apps/web/package.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/TENANCY.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: all contracts from Tasks 2-7.
- Produces: `pnpm test:e2e:api`, a CI `api-e2e` job, and the exact evidence package for Codex independent review.

- [ ] **Step 1: Create deterministic two-project acceptance data**

Extend the development/test seed with:

```text
Project A: Ambli, with at least one decision, activity, drawing, checklist, daily log and photo.
Project B: Test Empty Site, with a different name/location and no operational records.
User 1: PMC member of both projects.
User 2: Engineer member only of Project A.
User 3: Removed former member of Project A.
```

Use stable IDs under a `test-` prefix and keep the production/demo seed idempotent. The browser suite must identify records by returned IDs or visible names, not assume global display-number sequences.

- [ ] **Step 2: Add the API-backed Playwright configuration**

Create `playwright.api.config.ts` with `testDir: './tests/e2e-api'`, `baseURL: 'http://localhost:4174'`, `fullyParallel: false`, trace retained on first retry, and two web servers:

```ts
webServer: [
  {
    command: 'pnpm --dir ../.. --filter api start:dev',
    url: 'http://localhost:3000/health',
    reuseExistingServer: false,
    timeout: 90_000,
    env: { ...process.env, PORT: '3000' },
  },
  {
    command: 'pnpm dev -- --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 90_000,
    env: { ...process.env, VITE_API_URL: 'http://localhost:3000' },
  },
]
```

If the API lacks `GET /health`, add a public health controller in this task that verifies process health without exposing database contents. Keep readiness separate if it checks PostgreSQL.

- [ ] **Step 3: Write complete acceptance scenarios**

`project-scope.spec.ts` must prove all of the following scenarios with real UI/API actions and explicit assertions:

| Test name | Required action | Required assertion |
|---|---|---|
| `authentication lands on the server project` | Authenticate while the URL contains Project A and make the server return Project B. | URL, project heading and token scope are Project B. |
| `populated A to empty B is atomic` | Open A decisions, switch to B and delay B snapshot. | Loading boundary appears immediately; no A decision is visible before or after the empty B snapshot. |
| `deep link survives token switch` | Open `/projects/test-empty-site/decisions` in a fresh context and refresh. | Path remains Project B and the Decision Log screen is selected. |
| `history preserves scope and screen` | Navigate A dashboard -> B decisions -> B drawings, then use back/forward. | Every history entry has matching project identity, path and screen. |
| `non-member is forbidden` | Authenticate as the A-only engineer and request/open Project B. | API returns 403 and UI shows access error without B or A operational records. |
| `removed membership revokes token` | Open A, remove membership through the fixture/admin helper, then refetch. | Next request is 403 and project records are cleared. |
| `cross-project reference is rejected` | Send a Project B drawing/media payload referencing a Project A decision/activity. | API returns 400 and no row is created. |
| `empty project is truthful` | Open every dashboard/daily-log/portfolio surface in B. | No Ambli identity/record/count appears and no fake report success can be triggered. |

Use accessibility roles/test IDs already present in the app; add a stable test ID only when no semantic locator exists. Every test must begin from its own browser context or reset the database fixture so ordering does not affect the result.

- [ ] **Step 4: Add the isolated runner**

Create `scripts/test-api-e2e.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must point to a disposable PMCvitan test database}"
: "${JWT_SECRET:=api-e2e-test-secret}"
export JWT_SECRET
pnpm --filter api prisma:migrate
pnpm --filter api seed
pnpm --filter web exec playwright test --config playwright.api.config.ts
```

The script must refuse to run when `DATABASE_URL` is absent. Document that the seed resets data and the URL must never point at production.

Add `"test:e2e:api": "bash scripts/test-api-e2e.sh"` at root and `"test:e2e:api": "playwright test --config playwright.api.config.ts"` in the web package.

- [ ] **Step 5: Add the CI acceptance job**

Create an `api-e2e` job with PostgreSQL 16, install Chromium, migrate, seed and run `pnpm test:e2e:api`. Upload Playwright traces only on failure. Make this job required before Phase 0 is marked complete.

- [ ] **Step 6: Update durable architecture memory**

Update docs to state current implemented behavior, not aspirations:

```text
ARCHITECTURE: modular monolith; frontend project-scope lifecycle; PostgreSQL integration gate.
DATA_MODEL: canonical project/site ownership, composite references, ISO civil dates, legacy-column deprecation.
TENANCY: token scope plus live membership/org-admin authorization; stale-response generation guard.
ROADMAP: mark Phase 0 rows complete only with links to commits/PRs and CI evidence.
DEPLOY: required migration order, pre-deploy diagnostics, rollback limits and post-deploy smoke checks.
```

Do not copy the design spec into these files; link to its decision and document the implemented contract where each document already owns that subject.

- [ ] **Step 7: Build the independent review packet**

Create `docs/reviews/phase-0-review-packet.md` containing concrete values. Use command output or links on every line; do not leave an evidence line blank:

```markdown
# Phase 0 Review Packet

## Revisions
- Base revision: output of `git merge-base origin/main HEAD`
- Head revision: output of `git rev-parse HEAD`
- PRs/commits by task: ordered links and SHAs for Tasks 1-8

## Vision Alignment
- User decisions improved: concrete role and decision list from the eight vision-alignment statements
- Canonical fact owners: implemented owner and record names
- Information flows protected: implemented source-to-consumer paths
- Human approvals preserved: client consent, technical acceptance, certification and payment authority status

## Schema and Migration Evidence
- Migrations: migration names and checksums
- Diagnostic query output: attached command output showing zero invalid rows
- Fresh-database result: CI/local command and exit result
- Existing-data-copy result: staging-copy command and exit result
- Rollback boundary: exact application/schema rollback procedure used for this release

## Security and Tenancy Evidence
- Removed membership: test name and result
- Archived project: test name and result
- Cross-project route: test name and result
- Cross-project reference: service/database test names and results
- Org owner path: test name and result

## Verification
- `pnpm check`: timestamp, exit result and test totals
- `pnpm --filter api test:integration`: timestamp, exit result and test totals
- `pnpm test:e2e:api`: timestamp, exit result and eight-scenario total
- CI run URL: direct URL to the green required-check run

## Known Residual Risks
- Risk, owner, and follow-up issue: one concrete row per accepted residual risk, or `None accepted for Phase 0`.
```

The explanatory text after each label is an instruction for building the packet; the committed review request must replace it with actual revisions, results and links.

- [ ] **Step 8: Run the final gate and commit**

Run:

```bash
pnpm check
pnpm --filter api test:integration
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pmcvitan_e2e JWT_SECRET=api-e2e-test-secret pnpm test:e2e:api
git diff --check
```

Expected: all commands exit `0`; Playwright reports all eight API-backed scenarios passing; no whitespace errors.

```bash
git add apps/web/playwright.api.config.ts apps/web/tests/e2e-api apps/api/prisma/seed.ts scripts/test-api-e2e.sh package.json apps/web/package.json .github/workflows/ci.yml docs
git commit -m "test: prove phase zero project isolation"
```

## Rollout and Rollback Rules

1. Deploy schema migrations before API code that requires their new columns or constraints.
2. Take and verify a database backup before Tasks 5 and 6 reach production.
3. Run diagnostic queries against a staging copy of production data. A cross-project reference or unparseable date blocks deployment and requires explicit data repair; the migration must not guess.
4. Frontend Tasks 2, 3 and 7 may be rolled back as one compatible group while additive columns remain.
5. Database constraints are not rolled back automatically after writes have depended on them. Rollback means restore the prior application, keep additive schema, and prepare an operator-reviewed forward migration.
6. After deploy, smoke-test one populated project and one empty project, a project switch, deep-link refresh, removed membership and one same-project record creation.

## Claude Code Handoff Prompt

Give Claude Code this exact instruction together with repository access:

```text
Work in JagPat/PMCvitan from the latest origin/main. This is an architect-led construction-management operating record, not a collection of independent forms. Its governing vision is: record a fact once at its responsible source, let it travel through authorized processes, add evidence and decisions as work progresses, and derive readiness, time, cost and accountability from the same chain.

First read docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md and docs/superpowers/plans/2026-07-12-phase-0-trust-foundation.md. Task 1 creates the permanent CLAUDE.md entrypoint; read it after that task and retain it. Then read the current architecture/data/tenancy/template/roadmap documents and revalidate every cited finding against current main. Report any code drift before editing.

Execute Phase 0 only, Tasks 1-8 in order, one reviewable PR per task unless the plan explicitly couples files. Use TDD and additive migrations. Before each PR, provide the required five-line vision-alignment statement. Do not add procurement, inventory, labour, billing, GST, RedBracket integration, microservices, or unrelated refactors.

Do not claim completion from unit tests or the seeded demo. Completion requires PostgreSQL integration tests and the API-backed two-project Playwright suite. Preserve client consent, technical acceptance, certification and payment authority as attributable human actions. Never copy a canonical fact into another module as independently editable data.

After each task, provide: base/head SHA, files changed, migration notes, commands run with results, risks, and the next task. Stop for review after Tasks 3, 5, 6 and 8. At the end, complete docs/reviews/phase-0-review-packet.md and share the branch/PR links and head SHA for independent Codex review.
```

## Independent Codex Review Gate

When Claude finishes, provide Codex with the repository URL, base SHA, head SHA, PR links and completed `docs/reviews/phase-0-review-packet.md`. Codex should review findings first by severity and verify, at minimum:

1. The current head actually contains every reported commit and migration.
2. Auth adopts the server-returned project and role on every login/switch path.
3. No project-owned field survives an in-progress or failed switch.
4. All project-scoped async responses and outbox flushes are generation guarded.
5. Route reconciliation cannot overwrite a pending deep link.
6. Membership removal, role change and project archive are enforced live.
7. Every optional project-owned reference is service validated and database constrained where feasible.
8. Real dates sort and calculate across month/year/leap boundaries; display strings are not compared.
9. API mode has no seed fallback or fabricated success.
10. Fresh-database migration, existing-data-copy migration, integration tests and eight browser scenarios pass independently.

Any failed item reopens its originating task. New feature work begins only after this gate is green.
