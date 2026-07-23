import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import type { Actor } from '../common/actor';
import type { EmittedEventMeta } from './outbox/registry';

/**
 * Phase 2 Task 5 — the command-idempotency kernel.
 *
 * `executeCommand` is the ONE way a consequential command runs under an idempotency key. A
 * retried or duplicated command (offline replay, network retry, double-tap) executes its
 * effect exactly once and returns the same result, so at-least-once clients and the offline
 * outbox are safe by construction.
 *
 * Protocol (reserve → execute → receipt, in ONE transaction):
 *   1. Fast path — a prior COMMITTED receipt for THIS (scope, actor, commandType, key) replays
 *      its result (same requestHash) or is a 409 (different requestHash). The lookup keys on
 *      the actor + scope id(s), so a receipt can NEVER cross to another actor or scope.
 *   2. Otherwise, in one transaction: insert the `reserved` row (acquiring the scope-specific
 *      partial-unique lock EARLY), run the canonical mutation + its audit + DomainEvent, then
 *      flip the row to `succeeded` with its resultRef. A concurrent duplicate blocks on that
 *      unique lock; when the winner commits, the loser's insert raises P2002 and it replays the
 *      winner's committed result. A mutation that throws rolls the reservation back with it, so
 *      the key stays retryable (no `succeeded` receipt, no lingering `reserved` row).
 *
 * Additive rollout: an absent key runs today's compare-and-set path unchanged (no ledger row,
 * no regression) UNTIL enforcement is switched on (capability/version gate — a Phase-2
 * completion criterion), after which a missing key is refused.
 */

/** The transaction handle a command's `run` writes through — a `$transaction` callback client. */
export type CommandTx = Prisma.TransactionClient;

/** Phase 3 Task 4 — execution context handed to `run` alongside the transaction. `commandId`
 *  is the `CommandExecution` ledger row this execution reserved, so a mutation can record its
 *  source action on rows it appends (the §C stock-ledger provenance rule). It is `null` ONLY
 *  on the legacy unkeyed path, which reserves no ledger row (additive rollout — a missing key
 *  is refused once `commandKeyEnforced()` flips on). Existing `run` callbacks that declare
 *  only `(tx)` are unaffected. */
export interface CommandRunContext {
  commandId: string | null;
}

/** The project- or org-scoped subject the receipt keys on. For a project command the tenant
 *  `organizationId` is DERIVED server-side from the project, so it can never be forged. */
export type CommandScope =
  | { scopeKind: 'project'; projectId: string }
  | { scopeKind: 'org'; organizationId: string };

export interface CommandResult<T> {
  /** The committed entity id the command resolves to (Decision.id, …) — stored as `resultRef`. */
  resultRef: string;
  /** Optional value threaded back to the caller on a FRESH execution (unused when the caller
   *  rebuilds its own response, e.g. a snapshot). */
  value?: T;
  /** PR C Task 2 — the domain events this fresh execution emitted, in causal order, so the caller
   *  hands them to the post-commit ExternalEffectDispatcher. Omit for a command that emits none. */
  events?: EmittedEventMeta[];
}

export interface ExecuteInput<T> {
  scope: CommandScope;
  actor: Actor;
  /** The command's stable type, e.g. `decisions.approve` — part of the ledger subject. */
  commandType: string;
  /** The client idempotency key (an offline op id / `Idempotency-Key` header). `null`/`undefined`
   *  = a legacy client that sends no key. */
  idempotencyKey?: string | null;
  /** Canonical hash of the EXACT request DTO fields — the same-key/different-payload → 409 key. */
  requestHash: string;
  /**
   * Tasks 4–5 integrity correction (F1) — when the caller sends NO client key, synthesize a
   * SERVER one-shot command so the execution still reserves a `CommandExecution` row and `run`
   * receives a non-null `ctx.commandId`. Used by the inventory module, whose §C ledger rows
   * REQUIRE a source command (`StockTransaction.sourceCommandId` is NOT NULL). This preserves
   * legacy unkeyed behavior exactly: the synthesized key is unique per call, so it is never a
   * replay and two unkeyed retries each execute once (today's compare-and-set semantics) — it
   * only guarantees provenance. A CLIENT-supplied key keeps its exactly-once replay unchanged.
   *
   * Enforcement takes precedence: when `commandKeyEnforced()` is on, a MISSING client key is
   * refused BEFORE synthesis is considered (synthesis never substitutes for the required client
   * key — see `executeCommand` step 2), so a lost-response retry cannot re-run the movement.
   */
  synthesizeKeyWhenAbsent?: boolean;
  /** The canonical mutation, run INSIDE the reserve/receipt transaction. Returns the resultRef. */
  run: (tx: CommandTx, ctx: CommandRunContext) => Promise<CommandResult<T>>;
}

export interface ExecuteOutcome<T> {
  /** true = this call REPLAYED a prior committed receipt (no new effect); false = fresh execution. */
  replayed: boolean;
  resultRef: string;
  value?: T;
  /** PR C Task 2 — the events this call emitted (empty on a replay, which re-emits nothing). The
   *  caller passes them to `ExternalEffectDispatcher.dispatchCommitted` post-commit. */
  events: EmittedEventMeta[];
}

/** Whether a missing idempotency key is REFUSED (the capability/version gate). Off by default so
 *  old clients keep working while they drain; flipped on (a Phase-2 completion criterion) once
 *  compatibility telemetry proves the drain. Read at call time so it can be toggled per-process. */
export function commandKeyEnforced(): boolean {
  return process.env.COMMAND_KEY_ENFORCED === 'true';
}

/** A stable, canonical SHA-256 of the request payload — object keys are sorted so field order
 *  never changes the hash, while array order (which is semantic, e.g. option order) is preserved. */
export function hashRequest(input: unknown): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Fast-path replay guard, run BEFORE a command's own validation reads. Returns `true` when THIS
 * (scope, actor, commandType, key) has already committed — so the caller replays its own result
 * (e.g. rebuilds the snapshot) WITHOUT re-validating; a locked decision would otherwise 409 a
 * legitimate retry. Throws 409 on a same-key/different-request. Runs on the TOP-LEVEL client so a
 * command's barrier-observable pre-read stays where it was (outside the transaction). An absent
 * key (legacy client) is never a replay.
 */
export async function peekReplay(
  prisma: PrismaService,
  scope: CommandScope,
  actorId: string,
  commandType: string,
  idempotencyKey: string | null | undefined,
  requestHash: string,
): Promise<boolean> {
  const key = idempotencyKey?.trim() || null;
  if (!key) return false;
  const prior = await prisma.commandExecution.findFirst({ where: receiptWhere(scope, actorId, commandType, key) });
  if (prior?.status === 'succeeded') {
    if (prior.requestHash !== requestHash) throw sameKeyDifferentRequest();
    return true;
  }
  return false;
}

/** The receipt-lookup WHERE — keyed on scopeKind + the matching scope id(s) + actor + command +
 *  key. This is what makes replay non-disclosing: another actor (or scope) simply finds no row. */
function receiptWhere(scope: CommandScope, actorId: string, commandType: string, key: string): Prisma.CommandExecutionWhereInput {
  return scope.scopeKind === 'project'
    ? { scopeKind: 'project', projectId: scope.projectId, actorId, commandType, idempotencyKey: key }
    : { scopeKind: 'org', organizationId: scope.organizationId, actorId, commandType, idempotencyKey: key };
}

/** Resolve the tenant columns for the reservation. A project command derives `organizationId`
 *  from the project itself (forgery-proof, exactly like emitEvent); an org command carries the
 *  org and a NULL project. */
async function resolveTenant(tx: CommandTx, scope: CommandScope): Promise<{ organizationId: string; projectId: string | null }> {
  if (scope.scopeKind === 'project') {
    const { orgId } = await tx.project.findUniqueOrThrow({ where: { id: scope.projectId }, select: { orgId: true } });
    return { organizationId: orgId, projectId: scope.projectId };
  }
  return { organizationId: scope.organizationId, projectId: null };
}

export async function executeCommand<T>(prisma: PrismaService, input: ExecuteInput<T>): Promise<ExecuteOutcome<T>> {
  // 1. Normalize the client key (an all-whitespace header is no key).
  const clientKey = input.idempotencyKey?.trim() || null;

  // 2. Enforcement — evaluated for ANY missing client key, BEFORE any transaction / receipt /
  //    audit / DomainEvent / ledger write. When `COMMAND_KEY_ENFORCED=true`, a caller that sends
  //    no client `Idempotency-Key` is refused REGARDLESS of `synthesizeKeyWhenAbsent`. Server
  //    synthesis chooses provenance; it must NEVER stand in for the client key the enforcement
  //    contract requires. Without this, an inventory call (which opts into synthesis) would slip
  //    past enforcement and a lost-response retry could execute the same physical movement again
  //    under a second server key. The throw happens here, so zero side effects have occurred.
  if (!clientKey && commandKeyEnforced()) {
    throw new BadRequestException('This action requires an Idempotency-Key — please update the app to continue.');
  }

  // 3. Legacy / unkeyed path: today's compare-and-set behavior, unchanged. A caller with no
  //    client key that does NOT opt into synthesis reserves no ledger row and runs the
  //    ledger-less mutation exactly as before (`run` receives a null `commandId`). Reached only
  //    when enforcement is OFF (step 2 already refused a missing key under enforcement).
  if (!clientKey && !input.synthesizeKeyWhenAbsent) {
    const r = await prisma.$transaction((tx) => input.run(tx, { commandId: null }));
    return { replayed: false, resultRef: r.resultRef, value: r.value, events: r.events ?? [] };
  }

  // 4. Keyed or synthesized path. The key the receipt is stored under: the client's
  //    (exactly-once replay) or, when the caller synthesizes, a per-call server key (unique →
  //    never a replay; two unkeyed retries each run once, exactly as the legacy compare-and-set
  //    path did — this only secures provenance).
  const key = clientKey ?? `srv-${randomUUID()}`;

  // ── Fast path: replay a prior committed receipt for THIS actor + scope ─────────────────────
  const prior = await prisma.commandExecution.findFirst({ where: receiptWhere(input.scope, input.actor.actorId, input.commandType, key) });
  if (prior?.status === 'succeeded') {
    if (prior.requestHash !== input.requestHash) throw sameKeyDifferentRequest();
    return { replayed: true, resultRef: prior.resultRef ?? '', value: undefined, events: [] };
  }

  // ── Reserve + execute + receipt, all in ONE transaction ────────────────────────────────────
  try {
    const r = await prisma.$transaction(async (tx) => {
      const { organizationId, projectId } = await resolveTenant(tx, input.scope);
      const reservation = await tx.commandExecution.create({
        data: {
          scopeKind: input.scope.scopeKind,
          organizationId,
          projectId,
          actorId: input.actor.actorId,
          commandType: input.commandType,
          idempotencyKey: key,
          requestHash: input.requestHash,
          status: 'reserved',
        },
        select: { id: true },
      });
      const result = await input.run(tx, { commandId: reservation.id });
      await tx.commandExecution.update({
        where: { id: reservation.id },
        data: { status: 'succeeded', resultRef: result.resultRef, completedAt: new Date() },
      });
      return result;
    });
    return { replayed: false, resultRef: r.resultRef, value: r.value, events: r.events ?? [] };
  } catch (e) {
    // A concurrent duplicate committed first → the scope-specific partial unique index rejected
    // our reserve. By the time P2002 surfaces, the winner has committed, so its `succeeded`
    // receipt is visible: read it and replay (the loser "waited" on the unique-index lock).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const winner = await prisma.commandExecution.findFirst({ where: receiptWhere(input.scope, input.actor.actorId, input.commandType, key) });
      if (winner?.status === 'succeeded') {
        if (winner.requestHash !== input.requestHash) throw sameKeyDifferentRequest();
        return { replayed: true, resultRef: winner.resultRef ?? '', value: undefined, events: [] };
      }
      // The winner isn't `succeeded` (its own transaction rolled back after we saw the conflict)
      // — extremely rare; the key is free again, so surface a retryable conflict.
      throw new ConflictException('A concurrent command with this key is in progress — retry.');
    }
    // The mutation itself threw → the transaction (and the reservation) rolled back, so the key
    // stays retryable. Propagate the original error (a business 409/400/…), never mask it.
    throw e;
  }
}

function sameKeyDifferentRequest(): ConflictException {
  return new ConflictException('This idempotency key was already used for a different request.');
}
