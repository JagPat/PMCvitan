import { LABOUR_COMMANDS, LABOUR_QUERIES, type ModuleManifest } from '@vitan/shared';

/**
 * Phase 4 Task 1 — the LABOUR module (plan §§B/G/H): trusted workforce identity + the labour
 * requirement detail. A LEAF, exactly like `inventory` (round-3 acyclicity correction):
 * `dependsOn: []` — Labour never synchronously reads Activities, Procurement or Decisions.
 *
 * It OWNS the labour catalog (`LabourTrade`/`LabourSkill`), the trusted `Worker`/`Crew`/
 * `CrewMembership` identity, and the labour requirement detail (`LabourRequirementSpec` +
 * `LabourDemandSlice`). The labour detail is written THROUGH `LabourRequirementParticipant`,
 * invoked by the Activities requirement command inside its transaction — the cycle-exempt
 * `activities → labour` workflow-participant edge (so `activities.workflowParticipants` includes
 * `labour`; Labour's own `workflowParticipants` stays empty in Task 1 — it invokes no other
 * module's participant here). Onboarding is `pmc` authority; the register read is pmc/engineer.
 *
 * Task 1 emits NO domain event: onboarding is a roster surface (attributable via `recordAudit`,
 * idempotent via the command ledger). Labour capacity facts (allocation/attendance/work) — and
 * their event family — arrive in Tasks 3–5. The `requirement.*` events that carry the labour
 * demand stay Activities-owned (a discriminated `type` payload); Labour's async
 * `consumesEvents` read-model + the coverage read edge land in Task 4, not here.
 */
export const labourManifest: ModuleManifest = {
  id: 'labour',
  title: 'Labour & Workforce',
  kind: 'domain',
  ownsModels: ['labourTrade', 'labourSkill', 'worker', 'crew', 'crewMembership', 'labourRequirementSpec', 'labourDemandSlice'],
  readEncapsulated: ['labourTrade', 'labourSkill', 'worker', 'crew', 'crewMembership', 'labourRequirementSpec', 'labourDemandSlice'],
  // A LEAF (round-3): no synchronous read edge to any module. The Activities requirement command
  // writes the labour detail INTO this module through LabourRequirementParticipant (a workflow
  // edge on the Activities side), and Labour reaches no other module here.
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: [],
  consumesEvents: [],
  commands: [...LABOUR_COMMANDS],
  queries: [...LABOUR_QUERIES],
  routes: [
    'POST /projects/:projectId/labour/trades',
    'POST /projects/:projectId/labour/skills',
    'POST /projects/:projectId/labour/workers',
    'POST /projects/:projectId/labour/workers/:workerId/revoke',
    'POST /projects/:projectId/labour/crews',
    'POST /projects/:projectId/labour/crews/:crewId/members',
    'DELETE /projects/:projectId/labour/crews/:crewId/members/:workerId',
  ],
  permissions: ['pmc', 'engineer'],
};
