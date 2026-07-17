# Phase 2 Task 8 — First Backend Extraction (decisions) — Pattern Review Packet

**Review stop.** Task 8 is a **narrow pattern review** of the FIRST fully-extracted backend module. The
goal is to catch a wrong extraction pattern before Task 10 multiplies it across activities, drawings,
inspections, and daily-log. This packet states the pattern, the enforcement, the behavior-preservation
evidence, and the deliberate scoping decisions flagged for the reviewer.

Branch `claude/phase2-task8-extract-decisions` (from `main` @ the PR #166 merge). One PR.

---

## 1. The pattern

A module is reachable ONLY through its **commands**, its **queries**, and its **events**; no other
module touches its persistence. For `decisions`:

- **Writes** were already private (every `decision`/`decisionOption`/`decisionEvent`/`changeRequest`
  write is inside `decisions/`, emitting events via the outbox — Phase 1 + PR C).
- **Reads** are now private too. A new **`DecisionsQueryService`** (`decisions/decisions.query.ts`) is
  the module's public read boundary. It answers exactly the reads other modules needed:
  - `snapshotSlice(projectId, role, userId?)` → the role-filtered `DecisionDto[]` (the snapshot
    serialization moved here **verbatim**) + an unfiltered `id→status` map for readiness;
  - `existsInProject` / `resolveRefInProject` — the tenant-ownership check before storing a reference;
  - `countByNodeIds` — the node-delete guard;
  - `countPending` — the portfolio tile.
- **Consumers rerouted** off `prisma.decision`: the snapshot serializer, daily-log, activities, nodes,
  orgs portfolio, and — via the generic `common/project-ref` helper — drawings + media. `project-ref`
  dropped its `decision` case (a decision reference is validated through the query).
- **Contract in shared** (`packages/shared/src/contracts/decisions.ts`): the command inputs (each
  carried under a `DecisionCommandEnvelope` with the Task-5 idempotency key), the query inputs/outputs,
  and the command/query name tuples — importable by both API and web.

## 2. The enforcement (the part the review stop most scrutinizes)

The boundary analyzer now tracks **reads**, not just writes. A model listed in a manifest's
`readEncapsulated` may be read **only** by its owning module; a read from any other module is a
`cross-module-read` finding — **there is no read waiver** (a cross-module read must route through the
owning module's query contract; spec §6 permits a same-transaction query/validation, not a foreign
direct read).

- `decisions.manifest.ts` declares `readEncapsulated: ['decision','decisionOption','decisionEvent','changeRequest']`
  + the five `queries` it answers; the six consumers declare `dependsOn: ['decisions']`.
- The **real analysis is clean** — zero cross-module decision reads — proving every reroute landed.
- Adversarial fixtures prove the rule **fails** on a foreign read and **passes** for the owner's own
  read (`boundary.test.ts`). A contract test (`decisions.contract.test.ts`) pins the manifest
  commands/queries/events to the shared contract, the API request DTOs to the shared command inputs,
  the query response to the shared `DecisionView`, and that every command carries the idempotency key.

## 3. Behavior preservation

The extraction is a pure refactor — the decision serialization moved verbatim (the snapshot shape is
**byte-identical**), and every read maps 1:1 onto its predecessor.

| Gate | Result |
|------|--------|
| `pnpm check` (web + api: lint · typecheck · unit · build) | **exit 0** |
| Web unit | **298 passed** |
| API unit (incl. contract + read-boundary fixtures) | **542 passed** |
| API integration (live PostgreSQL 16 — snapshot-shape characterization + per-mutation consequences + cross-module-graph tripwire) | **248 passed** |
| Boundary suites (`boundary` · `module-registry` · `cross-module-graph` · `route-policy`) | **79 passed** |
| `test:e2e:api:legacy` (Playwright over compiled API + PG16) | **20/20** |
| `test:e2e:api:outbox` (sealed cutover) | **20/20** |
| `apps/api/scripts/upgrade-proof.sh` | **PASSED** |

## 4. Deliberate scoping decisions (flagged for the reviewer)

1. **Query response type.** `snapshotSlice` returns the API's `DecisionDto` (from `snapshot/types.ts`),
   which the contract test proves is assignable to the shared `DecisionView` (= the shared `Decision`).
   Physically unifying `DecisionDto` into the shared type is deferred — doing it now would churn the
   snapshot DTO surface and risk the snapshot-shape characterization; keeping `DecisionDto` as the
   response and asserting its conformance keeps the snapshot **provably byte-identical**.
2. **Runtime validation home.** The shared contract is TYPE-level; the runtime Zod validators stay at
   the API request boundary (`contracts.ts`). This avoids pulling `zod` into the web bundle (web
   consumes shared **source** via a Vite alias, so a `zod` import in a shared module would force `zod`
   into web's build). The contract test proves the API's validated inputs conform to the shared shape,
   so the contract is enforced on the side that actually validates requests.
3. **Read-tracking scope.** The analyzer detects **direct delegate reads** (`prisma.decision.find*`/
   `count`/…) — which covers all six rerouted sites. A **nested include-read** (e.g.
   `prisma.activity.findMany({ include: { decisions: … } })`) is not yet detected; no runtime site
   exercises it (verified), and it is noted here as a bounded follow-up mirroring the nested-**write**
   detection PR D added.
4. **`project-ref` generality.** The generic reference resolver lost its `decision` case (the only
   read-encapsulated model it handled); the other five models remain until their modules are extracted
   in Task 10.

## 5. Done criteria (Task 8)

decisions is reachable only via its contract + events; no other module imports its persistence (machine-
enforced); its flow + acceptance chain are unchanged; contract tests pin its commands/queries/events.
Held as one draft PR for the narrow first-extraction pattern review before Task 9/10 repeat the pattern.
