import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PushService } from './push.service';
import { ZodPipe } from '../common/zod.pipe';
import { pushSubscribeSchema, pushUnlinkSchema, type PushSubscribeInput, type PushUnlinkInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { AllowAnyRole, Public } from '../common/roles';

@Controller()
export class PushController {
  constructor(private readonly push: PushService) {}

  /** The VAPID public key the browser needs to subscribe; empty string disables push client-side. */
  @Public()
  @Get('push/public-key')
  publicKey(): { key: string } {
    return { key: this.push.publicKey };
  }

  /** Register a browser push subscription for the project. Any authenticated member may
   *  register their own device — there is no role restriction, only the caller's own subscription.
   *  Phase 6 task 4b (§A.3) — the authenticated subscribe ATTRIBUTES the device to its user
   *  (credential version + the token's own expiry recorded), the linkage TARGETED delivery
   *  requires; a worker/pseudo identity stores the subscription unlinked. */
  @Post('projects/:projectId/push/subscribe')
  @UseGuards(JwtGuard)
  @AllowAnyRole('a member registers their own browser/device for this project; no role gate')
  async subscribe(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(pushSubscribeSchema)) body: PushSubscribeInput,
  ): Promise<{ ok: boolean }> {
    const link =
      !user.worker && user.exp
        ? { userId: user.sub, credentialVersion: user.credentialVersion ?? 0, expiresAt: new Date(user.exp * 1000) }
        : undefined;
    await this.push.subscribe(projectId, body.subscription, user.role, link);
    return { ok: true };
  }

  /** Phase 6 task 4b (§A.3 round 13) — sign-out unlinks THIS browser's subscription: the device
   *  keeps role-level pushes but receives no targeted content until re-attributed by the next
   *  authenticated open. Endpoint-keyed, idempotent. */
  @Post('projects/:projectId/push/unlink')
  @UseGuards(JwtGuard)
  @AllowAnyRole('a member unlinks their own browser/device at sign-out; no role gate')
  async unlink(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(pushUnlinkSchema)) body: PushUnlinkInput,
  ): Promise<{ ok: boolean }> {
    await this.push.unlink(body.endpoint);
    return { ok: true };
  }
}
