import { BadRequestException, Controller, HttpCode, NotFoundException, Param, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/roles';
import { HubReceiverService } from './hub-receiver.service';

/**
 * #1118 U3 — where Hub delivers drawing webhooks: `POST /integrations/hub/:orgId/events`.
 *
 * `@Public`: no user signs in here; Hub proves itself with the Standard Webhooks signature over the raw body, which
 * {@link HubReceiverService} checks. Closed, it answers Nest's own unrouted 404, as the operator door does. A bad
 * signature is 401 and writes nothing. Every delivery PMC has judged (applied before, refused or ignored) is 204, so Hub
 * stops retrying it; one PMC will apply is 503 until U5 writes it, so Hub keeps it and retries.
 */
@Controller('integrations/hub')
export class HubReceiverController {
  constructor(private readonly receiver: HubReceiverService) {}

  @Public()
  @Post(':orgId/events')
  @HttpCode(204)
  async events(@Param('orgId') orgId: string, @Req() req: Request): Promise<void> {
    const distinct = req.headersDistinct;
    const answer = await this.receiver.receive({
      orgId,
      headers: { id: distinct['webhook-id'], timestamp: distinct['webhook-timestamp'], signature: distinct['webhook-signature'] },
      body: req.body,
      now: new Date(),
    });
    if (answer === 'closed') throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    if (answer === 'unreadable_body') throw new BadRequestException();
    if (answer === 'unsigned') throw new UnauthorizedException();
    if (answer === 'accepted') throw new ServiceUnavailableException();
  }
}
