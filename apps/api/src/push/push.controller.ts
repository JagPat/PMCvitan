import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { DECISIONS_CONTRACT_HEADER } from '../common/recorded-compat.interceptor';
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
    @Headers(DECISIONS_CONTRACT_HEADER) contract?: string,
  ): Promise<{ ok: boolean }> {
    // round-4 Codex F3 — user linkage requires an UNLINK-CAPABLE bundle. The pre-4b bundle has
    // no `/push/unlink` in its sign-out (it only clears the token locally), so linking its
    // authenticated subscribe would leave the departing user's attribution live on a shared
    // browser until the JWT expires. The 4b bundle declares the decisions contract on EVERY
    // request (the same version boundary the recorded-compat interceptor reads); an undeclared
    // authenticated subscribe stores the subscription UNLINKED — byte-identical to the pre-4b
    // server — and, because a link-less upsert CLEARS the stored attribution, it also severs
    // any lingering link an earlier 4b session left on this browser.
    const unlinkCapable = typeof contract === 'string' && contract.length > 0;
    const link =
      unlinkCapable && !user.worker && user.exp
        ? { userId: user.sub, credentialVersion: user.credentialVersion ?? 0, expiresAt: new Date(user.exp * 1000) }
        : undefined;
    await this.push.subscribe(projectId, body.subscription, user.role, link);
    return { ok: true };
  }

  /** Phase 6 task 4b (§A.3 round 13) — sign-out unlinks THIS browser's subscription: the device
   *  keeps role-level pushes but receives no targeted content until re-attributed by the next
   *  authenticated open. Endpoint-keyed, idempotent, CONDITIONAL on the departing caller
   *  (round-1 Codex F1): a delayed request cannot strip the NEXT user's re-attributed link —
   *  and SCOPED to the routed project (round-10 Codex F1): a delayed project-A request cannot
   *  clear a link the endpoint now carries under project B. */
  @Post('projects/:projectId/push/unlink')
  @UseGuards(JwtGuard)
  @AllowAnyRole('a member unlinks their own browser/device at sign-out; no role gate')
  async unlink(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(pushUnlinkSchema)) body: PushUnlinkInput,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: boolean }> {
    await this.push.unlink(projectId, body.endpoint, user.sub);
    return { ok: true };
  }
}
