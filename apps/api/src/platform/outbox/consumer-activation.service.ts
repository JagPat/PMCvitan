import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6b — the `outbox:consumer` OPERATOR PROTOCOL (the companion
 * document `2026-09-09-outbox-consumer-activation.md`, "The operator protocol").
 *
 * An OPERATOR PROTOCOL, deliberately NOT a ledger command (#572's review round 8, finding 3): the
 * command ledger's `CommandScope` admits a project or an org, and this register is GLOBAL, so keying
 * a receipt on a tenant would attach a global mutation to an arbitrary project. Idempotency comes
 * from a stable REQUEST TOKEN the caller generates once and reuses on every retry — not from the
 * sequence (ordering safety, which the head lock gives, is not retry idempotency: #572 round 9,
 * finding 2) and not from the state (a state-only no-op silently undoes a later operator's intent
 * after a lost response: #572 round 12, finding 4; #580 round 1, finding 2).
 *
 * Inside ONE transaction holding the consumer's catalog row `FOR UPDATE`, exactly TWO branches:
 *   1. a fact for `(consumer, 'operator', requestToken)` exists — the KIND is part of the identity —
 *      and its stored canonical request (`active`, `reason`, `actorId`) equals this call's: return THAT
 *      fact unchanged, whatever the mirror now says. DIFFERENT: REFUSED naming the conflict (same key
 *      + different request → 409, the command kernel's own contract; #580 round 1, finding 3).
 *   2. otherwise: append at `activationSeq + 1`, derived under that same lock, carrying the token, the
 *      identity and the canonical request. EVERY distinct request appends its fact, including one that
 *      confirms the state it found — the register is the record of every REQUEST, which is what lets a
 *      retry find its own row (the state-only branch is gone, not narrowed).
 *
 * The identity is OPERATOR-DECLARED, not authenticated, exactly as `outbox:retry`'s is: the protocol
 * has no request context to derive one from. What the register guarantees is that a state-changing
 * fact always CARRIES an identity and never an invented or blank one. Belt and braces at the surface:
 * a token carrying the reserved `sys:` prefix, or shaped like a migration name (the retry identity
 * A6a's backfill minted), is refused here, so the cross-kind collision (#580 round 3, finding 2)
 * cannot be attempted through the supported path either; the trigger keeps the namespace disjoint by
 * the kind regardless.
 *
 * The mirror is never written here: the register's head lock verifies the sequence and its apply
 * moves `active` / `activationSeq` — the only writer `OutboxConsumerCatalog_t4d_rules` admits.
 */

/** The whitespace discipline `DecisionForward.reason` carries: trimmed, and non-empty after it. */
const nonBlank = z.string().trim().min(1);

export const consumerActivationRequestSchema = z.object({
  consumer: nonBlank,
  active: z.boolean(),
  reason: nonBlank,
  actorId: nonBlank,
  requestToken: nonBlank
    .refine((t) => !t.startsWith('sys:'), { message: 'requestToken must not carry the reserved `sys:` prefix (system tokens only)' })
    .refine((t) => !/^\d{14}_/.test(t), { message: 'requestToken must not be shaped like a migration name (a migration\'s own retry identity)' }),
});
export type ConsumerActivationRequest = z.infer<typeof consumerActivationRequestSchema>;

export interface ConsumerActivationFact {
  consumer: string;
  seq: number;
  active: boolean;
  reason: string;
  actorKind: string;
  actorId: string;
  requestToken: string | null;
  at: Date;
}

/** Same token, different request: the command kernel's 409 contract, as a plain error the CLI reports. */
export class ConsumerActivationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerActivationConflictError';
  }
}

@Injectable()
export class OutboxConsumerActivationService {
  private readonly log = new Logger('OutboxActivation');
  constructor(private readonly prisma: PrismaService) {}

  /** Validate at the surface; the message names every failing field. */
  static parse(input: unknown): ConsumerActivationRequest {
    const parsed = consumerActivationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`outbox:consumer request refused: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  }

  /**
   * Ask for a consumer's activation state. Returns the fact that answers the request — the appended
   * one, or the caller's own earlier fact when the token replays — and whether it replayed.
   */
  async request(input: unknown): Promise<{ fact: ConsumerActivationFact; replayed: boolean }> {
    const req = OutboxConsumerActivationService.parse(input);
    const result = await this.prisma.$transaction(async (tx) => {
      // the head, under the row lock the register's own head lock takes: a concurrent request waits
      // here and re-reads the committed head (P-A5)
      const head = await tx.$queryRaw<Array<{ activationSeq: number; active: boolean }>>`
        SELECT "activationSeq", "active" FROM "OutboxConsumerCatalog" WHERE "consumer" = ${req.consumer} FOR UPDATE`;
      if (!head[0]) throw new Error(`consumer '${req.consumer}' is not a registered catalog contract`);

      const existing = await tx.outboxConsumerActivation.findUnique({
        where: { consumer_actorKind_requestToken: { consumer: req.consumer, actorKind: 'operator', requestToken: req.requestToken } },
      });
      if (existing) {
        const same = existing.active === req.active && existing.reason === req.reason && existing.actorId === req.actorId;
        if (!same) {
          throw new ConsumerActivationConflictError(
            `request token '${req.requestToken}' for consumer '${req.consumer}' was already used by a DIFFERENT request `
            + `(recorded: active=${existing.active}, actorId='${existing.actorId}', reason='${existing.reason}'; `
            + `asked: active=${req.active}, actorId='${req.actorId}', reason='${req.reason}'). `
            + 'A retry must resend the same request; a new request needs a new token.',
          );
        }
        return { fact: existing, replayed: true };
      }

      const fact = await tx.outboxConsumerActivation.create({
        data: {
          consumer: req.consumer, seq: head[0].activationSeq + 1, active: req.active,
          reason: req.reason, actorKind: 'operator', actorId: req.actorId, requestToken: req.requestToken,
        },
      });
      return { fact, replayed: false };
    });
    if (!result.replayed) {
      this.log.warn(`outbox consumer '${req.consumer}' ${req.active ? 'activated' : 'deactivated'} by '${req.actorId}' (seq ${result.fact.seq}, token ${req.requestToken})`);
    }
    return result;
  }
}
