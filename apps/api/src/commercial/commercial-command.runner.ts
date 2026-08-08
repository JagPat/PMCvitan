import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { executeCommand, type ExecuteInput, type ExecuteOutcome } from '../platform/commands';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';

/**
 * Phase 5 Task 7B-i-a — the ONE place a commercial command hands its external effects to the
 * post-commit dispatcher.
 *
 * Every other module dispatches at the call site: `const outcome = await executeCommand(...)`,
 * then `await this.dispatcher.dispatchCommitted(outcome.events)`. That reads fine when the event
 * is emitted three lines above the return. Commercial is the module where it is not: its money
 * announcement comes from `CommercialBudgetService.evaluate`, several frames below every command
 * body and often inside `CommercialParticipant`, so nothing at the call site mentions an event at
 * all. Seventeen commands would each need a dispatch line nothing local justifies — and the
 * eighteenth would be added without one.
 *
 * So the rule lives here instead of being copied seventeen times. `commercial.contract.test.ts`
 * §M pins the other half: no commercial service may call `executeCommand` directly, so a new
 * command cannot route around this and silently stop invalidating.
 *
 * Deliberately module-local. It is not in `platform/` because nothing outside commercial uses it
 * yet, and a shared helper with one caller claims a generality it has not earned; if a second
 * module wants it, moving it then is a rename. The behaviour it wraps is unchanged and not
 * commercial-specific: this is the same two lines every dispatching service already runs.
 */
@Injectable()
export class CommercialCommandRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /**
   * Execute the command, then send its external effects.
   *
   * `outcome.events` is COMPLETE because `executeCommand` collects what the transaction emitted
   * rather than what `run` returned (`platform/events.ts`) — which is the whole reason a commercial
   * command can dispatch an announcement made by a seam it never names.
   *
   * A REPLAY dispatches nothing: it re-emitted no event and its `events` is empty by construction,
   * so the guard is a statement of intent rather than a necessary check. Sending is best-effort by
   * design — `dispatchCommitted` swallows its own failures, because the command has already
   * committed and the durable `OutboxDelivery` rows carry the retry.
   */
  async run<T>(input: ExecuteInput<T>): Promise<ExecuteOutcome<T>> {
    const outcome = await executeCommand(this.prisma, input);
    if (!outcome.replayed && outcome.events.length > 0) {
      await this.dispatcher.dispatchCommitted(outcome.events);
    }
    return outcome;
  }
}
