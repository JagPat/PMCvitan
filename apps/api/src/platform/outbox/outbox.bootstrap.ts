import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PushService } from '../../push/push.service';
import { OutboxRelay } from './relay.service';
import { registerConsumer, syncConsumerCatalog } from './registry';
import { makeSocketConsumer, makePushConsumer } from './consumers';

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
    this.relay.start();
  }
}
