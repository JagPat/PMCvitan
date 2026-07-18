# Phase 2 Task 10 — Drawings module CORRECTION (post-merge independent review) — Review Packet

Follows the independent review of the merged drawings module (PR #174, on `main` @ `abbe9ed`). Base:
latest `main`. **Not** a rollback of #174, a projection redesign, or the start of Inspections — a
focused correction so every drawing mutation is **content-bound**, **recoverable after an uncertain
network result**, and **consistently blocked while the module-owned read is unsettled**.

Branch `claude/phase2-task10-drawings-correction` (from `main` @ `abbe9ed`). Twelve files, three areas.

---

## Vision alignment

The controlled-drawing register stays a per-site operational record, reached only through the module's
contract + `drawing.*` events; this correction touches no ownership, no projection shape, and no
tenancy. It hardens the **command path**: a drawing revision's identity now binds to the actual file
CONTENT (so the exactly-once ledger can never confuse two different files), a lost/uncertain response is
recovered instead of surfaced as a false failure, and no drawing mutation ever runs against a register
the client hasn't actually loaded. Human approvals stay attributable and exactly-once; migrations are
untouched (this correction adds none).

---

## C1 — content-bound issue identity (`contracts.ts`, `drawings.service.ts`, gateway)

The issue command hash bound to `dataLen` — file LENGTH — so two different files of the same length
under the same key + metadata were indistinguishable (a same-key retry could replay the wrong file, or a
genuinely different upload could be mis-deduped).

- **Backend.** `issueDrawingSchema` gains `contentSha256` (lowercase-hex SHA-256), **required on the
  presigned path** (the server never sees those bytes). `drawings.service.issue` computes the digest
  authoritatively from the decoded inline bytes (`createHash('sha256')`), or uses the client-supplied
  `contentSha256` for the presigned path, and puts THAT — never a length — into `hashRequest`.
- **Frontend.** `ApiGateway.prepareIssue` computes the digest once via SubtleCrypto (`sha256Hex`) and
  carries it in BOTH the inline and presigned POST bodies.
- **Reproduce-first (live PG, `drawings-idempotency.test.ts`):** same key + same metadata + DIFFERENT
  same-length bytes → **409** (exactly one revision survives); presigned path — same key + same
  `storageKey` + same `contentSha256` **replays**, a different digest → **409**.

## C2 — lost-response handling (`apiGateway.ts`, `store.ts`, `useApiSync.ts`)

The issue POST re-presigned + re-uploaded on every call, and its `catch` said “please try again” without
ever checking whether the command had committed.

- **Prepare ONCE, retry the write.** `issueDrawing` is split into `prepareIssue` (digest + a large
  file's direct-to-bucket PUT — run ONCE) and `submitIssue` (the retryable register-write POST). The
  store prepares once, then runs a bounded **same-key, same-prepared-body** retry — so a
  committed-but-unacked issue replays the one success (the ledger dedupes; no duplicate revision, no
  re-upload).
- **Reconcile before failing.** If the outcome is still uncertain after the bounded retry, the store
  runs a **scope-guarded reconciliation** (`requestFreshSnapshot`) and emits **no** “try again” — the
  register surfaces the committed revision if it landed; a terminal 4xx stops immediately with an honest
  message and no reconcile loop.
- **Small commands are durable.** `publishDrawing` and `fileDrawing`/unfile move onto the existing
  **write-ahead** outbox (`publishDrawing` / `setDrawingNode` ops with a stable key + replay cases),
  matching acknowledge: a lost response replays the SAME op under the SAME key and reconciles.
- **Socket reconnect.** `useApiSync`'s `connect` handler now **joins the room THEN refetches** — a
  reconnect after a drop may have missed `changed` pings, so a bare rejoin would leave the register
  stale.
- **Reproduce-first (`drawings-lost-response.test.ts`, `drawings-socket-reconnect.test.ts`,
  `snapshot-ordering.test.ts`, `drawings-module-query.test.ts`):** prepare-once + same-key/-body on
  every retry; server-commits-but-both-attempts-abort → reconciliation shows **exactly one revision** and
  **no false-failure** toast; a terminal 4xx stops with no reconcile; socket (re)connect joins the room
  AND refetches; the scope guards on the issue continuation still drop a reply that lands after a switch.

## C3 — centralized mutation-readiness guard (`store.ts`, `DrawingsScreen.tsx`, `DraftsScreen.tsx`)

The lock was recomputed ad-hoc in the screen; nothing stopped a store action from acting on an unsettled
register.

- **One predicate.** `drawingMutationsBlocked(s)` — `moduleQuery && drawingsLoad !== 'ready'` — is the
  SINGLE readiness gate, exported from the store.
- **Disable AND defensively reject.** Issue, Acknowledge, Publish, Publish-All (when drawing drafts are
  included), Re-file and Unfile are disabled in the UI **and** no-op in the store while the read is
  idle/loading/error under moduleQuery — never a gateway call, never a write-ahead op, on stale/absent
  data. `DrawingsScreen`'s `actionsLocked`/`ackLocked` use the shared predicate.
- **DraftsScreen honesty.** The Drafts workspace shows an honest drawing loading / stale+Retry banner and
  pauses per-draft publish + Publish-all instead of publishing from stale drawing data.
- **Reproduce-first (`drawings-module-query.test.ts`):** at `drawingsLoad` idle/loading/error the store
  no-ops every drawing mutation (no gateway call, empty outbox, honest toast); at `ready` they are
  permitted again.

---

## Verification (all green)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| API unit suite | **556 passed** |
| Web unit suite | **367 passed** |
| Full integration suite (live PostgreSQL) | **306 passed** |
| `drawings-idempotency` (content-bound: same-length-different-bytes 409; presigned digest replay/409) | in the 306, **9 passed** |
| `apps/api/scripts/upgrade-proof.sh` (this correction adds NO migration) | **PASSED** |
| `pnpm test:e2e:api:drawings` (controlled-drawing browser lifecycle — moduleQuery, rebuilt stack) | **2 passed** |

**HELD for review — do not merge.** Inspections (module 3) does not start until this correction clears
review.
