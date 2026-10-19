import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { ZodPipe } from '../common/zod.pipe';
import { Public } from '../common/roles';
import { Throttle, ThrottleGuard } from '../common/throttle';
import { OpsTokenGuard } from '../platform/ops/ops-token.guard';

const qaSignInSchema = z.object({
  email: z.string().trim().min(3).max(200),
  operator: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(3).max(500),
});
type QaSignInInput = z.infer<typeof qaSignInSchema>;

/** Rate-limit window for the operator door sign-in, the same 10 minutes as the other auth endpoints. */
const WINDOW = 10 * 60 * 1000;

/**
 * #482 operator door — the auth routes behind `OPS_TOKEN`. Its own controller so the door guard runs BEFORE the
 * rate limiter (Codex P2 on #983): Nest runs a class's guards before a method's, and `AuthController` throttles at
 * class level, so there a closed door would answer 429 after ten calls and reveal the route. Here a closed door is
 * 404 every time, and only a caller holding the token is counted.
 */
@Controller('auth/ops')
@UseGuards(OpsTokenGuard, ThrottleGuard)
export class AuthOpsController {
  constructor(private readonly auth: AuthService) {}

  /** Sign in as a QA account (QA-only companies only; see `AuthService.qaSignIn`). 404 closed, 401 wrong token. */
  @Public()
  @Throttle(10, WINDOW)
  @Post('qa-sign-in')
  qaSignIn(@Body(new ZodPipe(qaSignInSchema)) body: QaSignInInput) {
    return this.auth.qaSignIn(body);
  }
}
