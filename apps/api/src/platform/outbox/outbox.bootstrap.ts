import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PushService } from '../../push/push.service';
import { OutboxRelay } from './relay.service';
import { registerConsumer, syncConsumerCatalog, outboxSenderMode } from './registry';
import { makeSocketConsumer, makePushConsumer } from './consumers';
import { makeDecisionsProjectionConsumer } from '../../decisions/decisions.projection';
import { makeDailyLogProjectionConsumer } from '../../daily-log/daily-log.projection';
import { effectCoverageVersion } from '../external-effects';

/**
 * Phase 2 Task 6 — outbox lifecycle bootstrap. At app start it registers the socket + push
 * consumers (so `emitEvent` materializes their deliveries from now on), runs the ONE-TIME
 * pre-cutover backfill (deriving deliveries for any events that predate the outbox), and starts
 * the relay's dispatch interval (a no-op under NODE_ENV=test — tests drive the relay directly).
 */
@Injectable()
export class OutboxBootstrap implements OnModuleInit {
  private readonly log = new Logger('OutboxBootstrap');

  constructor(
    private readonly relay: OutboxRelay,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    registerConsumer(makeSocketConsumer(this.realtime));
    registerConsumer(makePushConsumer(this.push));
    // Task 9 — the first module's rebuildable read path: the decisions projection consumer maintains
    // the DecisionProjection read model from `decision.*` events (ordered, effectively-once). Every
    // event materializes its ordered delivery (dispatch for a decision event, noop otherwise), so the
    // projection cursor advances contiguously. Additive: the live snapshot slice stays authoritative
    // until the frontend is switched to the projection query (the capability-versioned XOR cutover).
    registerConsumer(makeDecisionsProjectionConsumer());
    // Task 10 — the daily-log module's rebuildable read path: the daily-log projection consumer
    // maintains the per-project DailyLogProjection slice from `dailylog.*`/`material.*` events (ordered,
    // effectively-once). Same additive cutover — the live snapshot slice stays authoritative until the
    // frontend switches to the module query (the capability-versioned XOR read-ownership).
    registerConsumer(makeDailyLogProjectionConsumer());
    // PR B — persist each consumer's contract BEFORE the relay starts, so the (consumer,
    // consumerKind) delivery FK always resolves and the durable obligation is complete. A contract
    // drift or a failed sync ABORTS boot (never downgraded to a warning): an unsynced catalog would
    // let deliveries reference an undeclared contract, and a silent skip would lose the obligation.
    await syncConsumerCatalog(this.prisma);
    // Expand any missing delivery obligations before the relay starts (events predating a consumer's
    // registration, a rolling-deploy gap, a legacy DB). Fail-closed — a lost obligation is a
    // correctness fault, not a warn-and-continue. The relay also re-runs this every pass.
    const created = await this.relay.expandMissingDeliveries();
    if (created) this.log.log(`delivery expansion created ${created} outbox deliveries`);
    // PR C Task 3 — the outbox-mode startup gate. In `outbox` mode the background relay becomes the
    // SOLE external sender, so it must not start until the external-effect cutover is SEALED at the
    // EXACT compiled coverage version — otherwise the relay could re-send pre-cutover history or send
    // under a catalog the seal never covered. `legacy`/`shadow` stay available for a forward deploy
    // and a later reseal, so this gate fires only for `outbox`.
    if (outboxSenderMode() === 'outbox') {
      const seal = await this.prisma.outboxCutoverState.findUnique({ where: { key: 'singleton' } });
      const compiled = effectCoverageVersion();
      if (!seal) {
        throw new Error('OUTBOX_SENDER_MODE=outbox requires an external-effect cutover seal — run `outbox:seal-external` in legacy/shadow mode first');
      }
      if (seal.coverageVersion !== compiled) {
        throw new Error(`OUTBOX_SENDER_MODE=outbox seal coverage ${seal.coverageVersion} != compiled catalog ${compiled} — reseal (in legacy/shadow) after the external-effect catalog changed`);
      }
      this.log.log(`outbox-mode cutover seal verified at coverage ${compiled}`);
    }
    this.relay.start();
  }
}
