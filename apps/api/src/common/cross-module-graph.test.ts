import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Phase 2 Task 1 — CHARACTERIZATION CLASSIFIER for the cross-module call graph.
 *
 * Today the backend is one flat AppModule and modules reach INTO each other two
 * ways: (a) a domain service writes ANOTHER domain's tables through the shared
 * PrismaService, and (b) every mutating pillar service is handed SnapshotService +
 * RealtimeGateway and calls them directly. Phase 2 (Tasks 6–10) turns these into
 * declared events / atomic workflow contracts / FK actions per the plan's edge
 * decision table (docs/reviews/phase2-projection-matrix.md §1).
 *
 * This classifier is DISCOVERY-DRIVEN and SIGNATURE-LEVEL, not a set/count scan
 * (Codex Task-1 re-review finding 5):
 *
 *   1. AUTO-DISCOVERY — it walks the whole src tree and asserts EVERY *.service.ts
 *      and *.controller.ts falls into a documented bucket. A NEW service/controller
 *      file (or a moved one) fails here until it is triaged — the graph can never
 *      silently grow behind the test.
 *   2. FOREIGN WRITES ARE COUNTED, not just named — the expected value is a
 *      model→count map, so removing ONE of two writes to the same foreign model
 *      (3→2) fails, where a distinct-model set would stay green.
 *   3. THE `changed` SIGNAL IS PINNED BY ORDERED SIGNATURE + ENCLOSING METHOD —
 *      the ordered per-call push signature (silent / exact roles / dynamic) catches
 *      an added/removed/reordered/re-targeted emit; the "one emit per method"
 *      invariant catches a call MOVED into a method that already emits, which a bare
 *      count would miss.
 *   4. ROUTES ARE PINNED BY ORDERED SIGNATURE, not count — replacing one route
 *      with another (same count) changes the signature list and fails.
 *
 * Source-text only (same technique as route-policy.test.ts), so it never needs a DB.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string): string => stripComments(readFileSync(join(SRC, rel), 'utf8'));

/** Every file under src/, path relative to src/ (posix separators). */
function walk(rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(SRC, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(r));
    else out.push(r);
  }
  return out;
}
const isSrc = (f: string, suffix: string) => f.endsWith(suffix) && !f.includes('.spec.') && !f.includes('.test.');
const ALL_FILES = walk('');
const serviceFiles = ALL_FILES.filter((f) => isSrc(f, '.service.ts')).sort();
const controllerFiles = ALL_FILES.filter((f) => isSrc(f, '.controller.ts')).sort();

// Prisma model → the domain (boundary unit) that OWNS its table. A write to a
// model whose owner ≠ the writing service's domain is a cross-module edge.
const MODEL_OWNER: Record<string, string> = {
  decision: 'decisions', decisionOption: 'decisions', decisionEvent: 'decisions', changeRequest: 'decisions',
  activity: 'activities', gateOverride: 'activities',
  phase: 'phases',
  inspection: 'inspections', inspectionItem: 'inspections',
  drawing: 'drawings', drawingRevision: 'drawings', drawingRecipient: 'drawings', drawingAck: 'drawings',
  dailyLog: 'daily-log', crewRow: 'daily-log', siteMaterial: 'daily-log',
  projectNode: 'nodes',
  media: 'media',
  org: 'orgs', orgMembership: 'orgs', membership: 'orgs', project: 'orgs', projectCompany: 'orgs',
  projectTemplate: 'orgs', templateModule: 'orgs', user: 'orgs', workerDevice: 'orgs',
  // shared infrastructure every module appends to — NOT a cross-module edge
  auditLog: 'SHARED', notification: 'SHARED', pushSubscription: 'SHARED',
  // identity-security infrastructure is shared by auth self-service and the
  // org-admin invitation correction workflow.
  passwordCredentialChallenge: 'SHARED', securityAuditEvent: 'SHARED',
};

// The PILLAR mutating services: each owns a domain, writes an EXACT multiset of
// foreign models (model→count), and hands its committed events to the SINGLE
// external-effect sender an EXACT number of times (`dispatch`). `orgs` is a pillar
// writer whose events are all weightless, so it dispatches nothing (dispatch: 0).
//
// Phase 2 Task 7: every cross-module edge in §1 was REMOVED from its former writer service —
// so each pillar service now writes EXACTLY its own domain (foreign: {}). The atomic edges
// (1–4) route through the owning module's leaf WORKFLOW PARTICIPANT, the referential edges
// (5–7) became database ON DELETE SET NULL FK actions, and project-init (8) writes through
// the owning modules' INITIALIZER participants.
//
// PR C Task 2: the in-request `notifyChanged(socket + push)` was REMOVED from every service.
// External effects (socket invalidation + Web Push) are now sent EXCLUSIVELY through the outbox
// consumers, invoked by the SINGLE ExternalEffectDispatcher post-commit. So this classifier no
// longer pins per-call push ROLES (those live in the external-effect CATALOG —
// platform/external-effects.ts, verified by external-effects.test.ts, and pinned end-to-end per
// command branch by test/integration/phase2-consequences.test.ts). It instead pins that NO
// service sends directly and that each command dispatches exactly once. The `dispatch` count
// mirrors the pre-PR-C `changed`-emission count (one per emitting command); the total is
// unchanged at 30.
const SERVICES: Record<string, { domain: string; foreign: Record<string, number>; dispatch: number }> = {
  'decisions/decisions.service.ts': { domain: 'decisions', foreign: {}, dispatch: 5 },
  // edge 1 (closing inspection) → inspection.participant; edge 5 (drawing unlink) → FK SET NULL
  'activities/activities.service.ts': { domain: 'activities', foreign: {}, dispatch: 7 },
  // edge 6 (phase→activity detach) → FK SET NULL (phaseId)
  'activities/phases.service.ts': { domain: 'phases', foreign: {}, dispatch: 2 },
  // edges 2/3 (sign-off done/revert) → activity.participant.applySignOff/revertSignOff
  'inspections/inspections.service.ts': { domain: 'inspections', foreign: {}, dispatch: 3 },
  'drawings/drawings.service.ts': { domain: 'drawings', foreign: {}, dispatch: 5 },
  // edge 4 (material mismatch block) → activity.participant.blockForMaterialMismatch
  'daily-log/daily-log.service.ts': { domain: 'daily-log', foreign: {}, dispatch: 4 },
  // edge 7 (node unfiling across five domains) → FK SET NULL (nodeId); decisions stay a guarded NO ACTION
  'nodes/nodes.service.ts': { domain: 'nodes', foreign: {}, dispatch: 1 },
  'media/media.service.ts': { domain: 'media', foreign: {}, dispatch: 3 },
  // edge 8 (project-init structure) → node/activity/inspection init participants
  'orgs/orgs.service.ts': { domain: 'orgs', foreign: {}, dispatch: 0 },
};

// Services that WRITE but are NOT pillar signal emitters. Documented so a new
// writing service can't hide here; `auth` is called out by finding 1 — it
// provisions identity/roster rows (User/Membership/WorkerDevice) that are
// project/org-scoped, so the "auth writes nothing" claim would be false.
const NON_PILLAR_WRITERS: Record<string, string> = {
  'auth/auth.service.ts': 'identity provisioning — signInOrProvision creates User+Membership, workerToken creates WorkerDevice (see the provisioning-writes test below)',
  'auth/password-credentials.service.ts': 'identity security — durable challenge CAS, password establishment and security audit; no project signal',
  'orgs/members.service.ts': 'project roster — writes orgs-owned User/Membership; no cross-domain write, no signal',
  'orgs/companies.service.ts': 'project roster — writes orgs-owned ProjectCompany; no cross-domain write, no signal',
  'push/push.service.ts': 'infra — writes the SHARED PushSubscription; no domain table, no signal',
  'platform/outbox/relay.service.ts': 'platform infra (Task 6) — the outbox relay writes the SHARED OutboxDelivery/ProcessedEvent/ProjectionCursor delivery-state tables and dispatches to consumers; no module domain table',
  'platform/outbox/outbox-operations.service.ts': 'platform infra (PR B Task 4) — operator dead-letter status/retry writes the SHARED OutboxDelivery/ProjectionCursor delivery-state + the OutboxOperatorAction audit; no module domain table',
};

// Services that perform NO Prisma write (readers, token/OTP/blob helpers, the
// Prisma client itself). Each must stay write-free.
const NO_WRITE_SERVICES: Record<string, string> = {
  'auth/email.service.ts': 'email-OTP delivery (OTP store, no DB write)',
  'auth/google.service.ts': 'Google ID-token verification (no DB write)',
  'auth/sms.service.ts': 'phone-OTP delivery (no DB write)',
  'common/project-access.service.ts': 'read-only project access checks',
  'media/signed-url.service.ts': 'signed serve-path minting (no DB write)',
  'media/storage.service.ts': 'blob storage (S3 / dev stub; no DB write)',
  'prisma.service.ts': 'the PrismaClient itself',
  'snapshot/snapshot.service.ts': 'the read-side snapshot builder (no write)',
  'platform/module-registry/module-registry.service.ts': 'Task 7 — validates the module registry at startup (no DB write)',
};

const WRITE = /\.(\w+)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;

/** model → number of write call-sites in the source. */
function writesByModel(src: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of src.matchAll(WRITE)) {
    const model = m[1];
    if (model === 'prisma' || model === 'tx' || model === 'this') continue;
    counts[model] = (counts[model] ?? 0) + 1;
  }
  return counts;
}

/** the subset of writesByModel whose owner is a DIFFERENT domain (not own, not shared). */
function foreignWrites(src: string, domain: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [model, n] of Object.entries(writesByModel(src))) {
    const owner = MODEL_OWNER[model];
    expect(owner, `writes model "${model}" with no ownership mapping — add it to MODEL_OWNER`).toBeTruthy();
    if (owner !== domain && owner !== 'SHARED') out[model] = n;
  }
  return out;
}

/** Source index of every `notifyChanged(` call (the in-request sender that PR C removed). */
function notifyChangedCalls(src: string): number[] {
  return [...src.matchAll(/notifyChanged\(/g)].map((m) => m.index);
}

/** Source index of every `dispatchCommitted(` call, in source order — the single-sender handoff. */
function dispatchCalls(src: string): { index: number }[] {
  return [...src.matchAll(/dispatchCommitted\(/g)].map((m) => ({ index: m.index }));
}

/** Name of the class method enclosing a source index (nearest 2-space-indent header before it). */
function enclosingMethod(src: string, index: number): string {
  const header = /\n {2}(?:public |private |protected )?(?:async )?([A-Za-z_]\w*)\s*\(/g;
  let name = '<none>';
  let m: RegExpExecArray | null;
  while ((m = header.exec(src)) && m.index < index) name = m[1];
  return name;
}

/** Ordered `METHOD(argText)` signature of every mutating route decorator. */
function routeSignatures(src: string): string[] {
  return [...src.matchAll(/@(Post|Patch|Put|Delete)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2].trim()})`);
}

// The EXACT ordered mutating-route signature of every controller with mutations.
const CONTROLLER_ROUTES: Record<string, string[]> = {
  'orgs/orgs.controller.ts': [
    "Post('orgs')", "Patch('orgs/:orgId/members/:userId/invitation-email')", "Post('orgs/:orgId/members')", "Patch('orgs/:orgId/members/:userId')", "Delete('orgs/:orgId/members/:userId')",
    "Post('orgs/:orgId/projects')", "Patch('orgs/:orgId/projects/:pid')", "Delete('orgs/:orgId/projects/:pid')", "Post('orgs/:orgId/projects/:pid/restore')",
    "Post('orgs/:orgId/modules')", "Delete('orgs/:orgId/modules/:moduleId')", "Post('orgs/:orgId/templates')", "Delete('orgs/:orgId/templates/:templateId')",
  ],
  'auth/auth.controller.ts': [
    "Post('switch')", "Post('session')", "Post('login')", "Post('password/request')", "Post('password/verify')", "Post('password/complete')", "Post('otp/request')", "Post('otp/verify')",
    "Post('worker/token')", "Post('email/request')", "Post('email/verify')", "Post('google')",
  ],
  'activities/activities.controller.ts': [
    'Post()', "Patch(':activityId')", "Delete(':activityId')", "Post(':activityId/start')", "Post(':activityId/complete')",
    "Post(':activityId/override')", "Delete(':activityId/override/:overrideId')",
  ],
  'drawings/drawings.controller.ts': [
    "Post('projects/:projectId/drawings')", "Post('projects/:projectId/drawings/:drawingId/publish')", "Post('projects/:projectId/drawings/presign')",
    "Post('projects/:projectId/drawings/rev/:revId/ack')", "Patch('projects/:projectId/drawings/:drawingId/node')", "Delete('drawings/:id')",
  ],
  'nodes/nodes.controller.ts': ['Post()', "Patch(':nodeId')", "Post(':nodeId/move')", "Post(':nodeId/publish')", "Delete(':nodeId')"],
  'decisions/decisions.controller.ts': ['Post()', "Post(':decisionId/publish')", "Post(':decisionId/approve')", "Post(':decisionId/change')", "Post(':decisionId/change/withdraw')"],
  'daily-log/daily-log.controller.ts': ["Post('start')", "Post('materials')", "Post('flag-mismatch')", "Post('submit')"],
  'orgs/members.controller.ts': ['Post()', "Patch(':userId')", "Delete(':userId')"],
  'orgs/companies.controller.ts': ['Post()', "Patch(':companyId')", "Delete(':companyId')"],
  'media/media.controller.ts': ["Post('projects/:projectId/media')", "Patch('projects/:projectId/media/:mediaId/node')", "Delete('media/:id')"],
  'inspections/inspections.controller.ts': ['Post()', "Post(':inspectionId/submit')", "Post(':inspectionId/decide')"],
  'activities/phases.controller.ts': ['Post()', "Delete(':phaseId')"],
  'push/push.controller.ts': ["Post('projects/:projectId/push/subscribe')"],
};

// Controllers with NO mutating route (read-only surfaces).
const READ_ONLY_CONTROLLERS: Record<string, string> = {
  'health.controller.ts': 'liveness/readiness probes',
  'snapshot/project.controller.ts': 'GET the RBAC-filtered project snapshot',
};

describe('Phase 2 Task 1 — cross-module call-graph classifier', () => {
  describe('auto-discovery: every service/controller file is triaged (a new file fails until documented)', () => {
    it('every *.service.ts is a pillar service, a documented non-pillar writer, or a documented no-write service', () => {
      const documented = new Set([...Object.keys(SERVICES), ...Object.keys(NON_PILLAR_WRITERS), ...Object.keys(NO_WRITE_SERVICES)]);
      expect([...documented].sort(), 'a service file is undocumented OR a documented one vanished — reconcile the buckets').toEqual(serviceFiles);
    });

    it('every *.controller.ts either declares mutating routes (documented) or is a documented read-only controller', () => {
      const documented = new Set([...Object.keys(CONTROLLER_ROUTES), ...Object.keys(READ_ONLY_CONTROLLERS)]);
      expect([...documented].sort(), 'a controller file is undocumented OR a documented one vanished').toEqual(controllerFiles);
    });

    it('the documented no-write services really perform no Prisma write', () => {
      for (const file of Object.keys(NO_WRITE_SERVICES)) {
        expect(Object.keys(writesByModel(read(file))), `${file} now writes — reclassify it`).toEqual([]);
      }
    });

    it('the documented read-only controllers declare NO mutating route', () => {
      for (const file of Object.keys(READ_ONLY_CONTROLLERS)) {
        expect(routeSignatures(read(file)), `${file} gained a mutating route — move it to CONTROLLER_ROUTES`).toEqual([]);
      }
    });
  });

  describe('every pillar service writes EXACTLY its expected foreign-domain multiset (counted)', () => {
    for (const [file, spec] of Object.entries(SERVICES)) {
      it(`${file}: foreign writes === ${JSON.stringify(spec.foreign)}`, () => {
        // EXACT equality on the model→COUNT map: fails on a MISSING edge, an UNKNOWN
        // edge, AND on removing one of two writes to the SAME foreign model.
        expect(foreignWrites(read(file), spec.domain), `${file} cross-module edges drifted — reconcile with docs/reviews/phase2-projection-matrix.md §1`).toEqual(spec.foreign);
      });
    }
  });

  describe('PR C Task 2 — the in-request sender is gone; each command dispatches through the SINGLE ExternalEffectDispatcher', () => {
    it('NO pillar service calls notifyChanged (the in-request socket/push sender was removed)', () => {
      for (const file of Object.keys(SERVICES)) {
        expect(notifyChangedCalls(read(file)), `${file} still calls notifyChanged — external effects must go through the dispatcher`).toEqual([]);
      }
    });

    for (const [file, spec] of Object.entries(SERVICES)) {
      it(`${file}: dispatchCommitted() called ${spec.dispatch}× (one per emitting command)`, () => {
        const src = read(file);
        const calls = dispatchCalls(src);
        // the count mirrors the pre-PR-C `changed`-emission count — catches an added or removed
        // dispatch site (a command that stopped/started sending external effects).
        expect(calls.length, `${file} dispatchCommitted call count drifted`).toBe(spec.dispatch);
        // one dispatch per method — catches a handoff MOVED into a method that already dispatches
        // (which the raw count would miss).
        const methods = calls.map((c) => enclosingMethod(src, c.index));
        expect(new Set(methods).size, `${file} has two dispatchCommitted() in one method — a signal was moved`).toBe(calls.length);
      });
    }

    it('30 external-effect dispatch sites total across the pillar services (unchanged from the pre-PR-C emission count)', () => {
      const total = Object.keys(SERVICES).reduce((n, f) => n + dispatchCalls(read(f)).length, 0);
      expect(total).toBe(30);
    });
  });

  describe('every mutating controller declares EXACTLY its ordered route signatures (not just a count)', () => {
    for (const [file, sigs] of Object.entries(CONTROLLER_ROUTES)) {
      it(`${file}: ${sigs.length} route(s), signatures pinned`, () => {
        // ordered signature list — replacing one route with another (same count) fails.
        expect(routeSignatures(read(file)), `${file} route signatures changed — update §4 of the command inventory`).toEqual(sigs);
      });
    }
    it('67 mutating routes total (the documented command inventory §4)', () => {
      const total = Object.values(CONTROLLER_ROUTES).reduce((s, sigs) => s + sigs.length, 0);
      expect(total).toBe(67);
      // and the source agrees, route-for-route
      const live = Object.keys(CONTROLLER_ROUTES).reduce((s, f) => s + routeSignatures(read(f)).length, 0);
      expect(live).toBe(67);
    });
  });

  describe('finding 1 — auth provisioning writes are real, project/org-scoped identity rows', () => {
    it('auth.service.ts writes User + Membership + WorkerDevice (NOT an empty-write, no-subject command)', () => {
      // the fact §4 documents as the provisioning-command mechanism: these are not
      // "auth mints a token and writes nothing".
      expect(writesByModel(read('auth/auth.service.ts'))).toEqual({ user: 1, membership: 1, workerDevice: 1 });
    });
  });

  describe('read + sender coupling (SnapshotService + ExternalEffectDispatcher injected in every emitter)', () => {
    const emitters = Object.entries(SERVICES).filter(([, s]) => s.dispatch > 0).map(([f]) => f);
    it('all eight dispatching services depend on SnapshotService and the single ExternalEffectDispatcher', () => {
      expect(emitters.length).toBe(8);
      for (const file of emitters) {
        expect(read(file), `${file} no longer references SnapshotService`).toContain('SnapshotService');
        // PR C: the in-request RealtimeGateway is replaced by the single sender in every emitter.
        expect(read(file), `${file} no longer injects ExternalEffectDispatcher`).toContain('ExternalEffectDispatcher');
      }
    });
  });
});
