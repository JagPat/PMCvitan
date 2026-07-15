import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PushService } from '../../push/push.service';
import { OutboxRelay } from './relay.service';
import { registerConsumer } from './registry';
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
  ) {}

  async onModuleInit(): Promise<void> {
    registerConsumer(makeSocketConsumer(this.realtime));
    registerConsumer(makePushConsumer(this.push));
    try {
      const created = await this.relay.backfillPreCutover();
      if (created) this.log.log(`pre-cutover backfill created ${created} outbox deliveries`);
    } catch (e) {
      this.log.warn(`pre-cutover backfill failed (will retry next boot): ${(e as Error).message}`);
    }
    this.relay.start();
  }
}
