import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PushService } from './push.service';
import { ZodPipe } from '../common/zod.pipe';
import { pushSubscribeSchema, type PushSubscribeInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';

@Controller()
export class PushController {
  constructor(private readonly push: PushService) {}

  /** The VAPID public key the browser needs to subscribe; empty string disables push client-side. */
  @Get('push/public-key')
  publicKey(): { key: string } {
    return { key: this.push.publicKey };
  }

  /** Register a browser push subscription for the project. */
  @Post('projects/:projectId/push/subscribe')
  @UseGuards(JwtGuard)
  async subscribe(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(pushSubscribeSchema)) body: PushSubscribeInput,
  ): Promise<{ ok: boolean }> {
    await this.push.subscribe(projectId, body.subscription, user.role);
    return { ok: true };
  }
}
