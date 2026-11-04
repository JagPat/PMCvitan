import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { PasswordCredentialsService } from './password-credentials.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { AllowAnyRole, Public } from '../common/roles';
import { Throttle, ThrottleGuard } from '../common/throttle';
import { isProduction } from '../config';
import { identitySwitchOn } from './identity/identity-config';
import { IdentitySignInService } from './identity/identity-sign-in.service';

/** Rate-limit window shared by the auth endpoints. */
const WINDOW = 10 * 60 * 1000; // 10 minutes
import {
  sessionSchema,
  loginSchema,
  passwordCredentialRequestSchema,
  passwordCredentialVerifySchema,
  passwordCredentialCompleteSchema,
  otpRequestSchema,
  otpVerifySchema,
  workerTokenSchema,
  emailOtpRequestSchema,
  emailOtpVerifySchema,
  googleSignInSchema,
  switchProjectSchema,
  type SessionInput,
  type LoginInput,
  type PasswordCredentialRequestInput,
  type PasswordCredentialVerifyInput,
  type PasswordCredentialCompleteInput,
  type OtpRequestInput,
  type OtpVerifyInput,
  type WorkerTokenInput,
  type EmailOtpRequestInput,
  type EmailOtpVerifyInput,
  type GoogleSignInInput,
  type SwitchProjectInput,
} from '../contracts';

/** The caller's address as Express reads it behind PMC's one proxy (`trust proxy` 1); only ever hashed. */
function callerAddress(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

@Controller('auth')
@UseGuards(ThrottleGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordCredentials: PasswordCredentialsService,
    private readonly identity: IdentitySignInService,
  ) {}

  /** Re-scope the session to another project the user belongs to (project switch). */
  @Post('switch')
  @UseGuards(JwtGuard)
  @AllowAnyRole('AuthService.switchProject verifies the caller is a member of the target project')
  switch(@CurrentUser() user: AuthUser, @Body(new ZodPipe(switchProjectSchema)) body: SwitchProjectInput) {
    return this.auth.switchProject(user.sub, body.projectId, user.credentialVersion ?? 0);
  }

  /**
   * Passwordless dev auth (demo persona switch). **Secure by default**: enabled only
   * when ALLOW_DEV_AUTH is explicitly "true" AND the API is not running in production.
   * Anyone reaching it gets a full role-scoped token for the asked role, so it must
   * NEVER be reachable on a production deploy — even if the env template ships
   * ALLOW_DEV_AUTH=true, `NODE_ENV=production` hard-disables it here (P1-4). Real
   * sign-in (password / email-OTP / Google) covers production.
   */
  @Public()
  @Throttle(20, WINDOW)
  @Post('session')
  session(@Body(new ZodPipe(sessionSchema)) body: SessionInput) {
    if (isProduction() || process.env.ALLOW_DEV_AUTH !== 'true') {
      throw new ForbiddenException('Dev auth is disabled');
    }
    return this.auth.session(body);
  }

  @Public()
  @Throttle(15, WINDOW)
  @Post('login')
  async login(@Body(new ZodPipe(loginSchema)) body: LoginInput, @Req() req: Request) {
    // Redbracket ID A3: only `IDENTITY_OIDC` exactly `1` reaches the issuer; anything else is today's sign-in, unchanged
    if (identitySwitchOn()) return this.auth.signInIdentity(await this.identity.login(body, callerAddress(req)));
    return this.auth.login(body);
  }

  @Public()
  @Throttle(5, WINDOW)
  @Post('password/request')
  async passwordRequest(@Body(new ZodPipe(passwordCredentialRequestSchema)) body: PasswordCredentialRequestInput, @Req() req: Request) {
    // with Redbracket ID on, a spent per-person limit sends nothing and answers exactly as a sent request does
    if (identitySwitchOn() && !(await this.identity.mayRequestReset(body.email, callerAddress(req)))) return this.passwordCredentials.unsent();
    return this.passwordCredentials.request(body);
  }

  @Public()
  @Throttle(15, WINDOW)
  @Post('password/verify')
  async passwordVerify(@Body(new ZodPipe(passwordCredentialVerifySchema)) body: PasswordCredentialVerifyInput) {
    // whether the password chosen next is the one Redbracket ID password every Vitan portal uses (switch on) or PMC's
    // own (switch off), so the screen says which is true. Read once: the setup token is bound to this same value, and
    // a completion under the other one refuses it (PasswordCredentialsService.openChallenge)
    return this.passwordCredentials.verify(body, identitySwitchOn());
  }

  @Public()
  @Throttle(10, WINDOW)
  @Post('password/complete')
  async passwordComplete(@Body(new ZodPipe(passwordCredentialCompleteSchema)) body: PasswordCredentialCompleteInput) {
    if (identitySwitchOn()) return this.auth.signInIdentity(await this.passwordCredentials.completeThroughIssuer(body, this.identity));
    const user = await this.passwordCredentials.complete(body);
    return this.auth.signInUser(user);
  }

  // Sending an OTP costs a paid SMS — keep this tight.
  @Public()
  @Throttle(5, WINDOW)
  @Post('otp/request')
  otpRequest(@Body(new ZodPipe(otpRequestSchema)) body: OtpRequestInput) {
    return this.auth.requestOtp(body);
  }

  @Public()
  @Throttle(15, WINDOW)
  @Post('otp/verify')
  otpVerify(@Body(new ZodPipe(otpVerifySchema)) body: OtpVerifyInput) {
    return this.auth.verifyOtp(body);
  }

  // NOTE: worker/token is unauthenticated by design (QR job-card onboarding) — audit §5.1
  // tracks tightening it (device attestation / rate limiting). Marked @Public so the
  // route-walk test records it as a deliberate public mutation, not an oversight.
  // NOTE: worker/token is unauthenticated by design (QR job-card onboarding) — audit §5.1
  // tightens it: WORKER_ENROLL_SECRET (when set) is required, the project must exist, and
  // this rate limit blunts mass minting. Marked @Public so the route-walk test records it
  // as a deliberate public mutation, not an oversight.
  @Public()
  @Throttle(10, WINDOW)
  @Post('worker/token')
  workerToken(@Body(new ZodPipe(workerTokenSchema)) body: WorkerTokenInput) {
    return this.auth.workerToken(body);
  }

  @Public()
  @Throttle(5, WINDOW)
  @Post('email/request')
  emailRequest(@Body(new ZodPipe(emailOtpRequestSchema)) body: EmailOtpRequestInput) {
    return this.auth.requestEmailOtp(body);
  }

  @Public()
  @Throttle(15, WINDOW)
  @Post('email/verify')
  emailVerify(@Body(new ZodPipe(emailOtpVerifySchema)) body: EmailOtpVerifyInput) {
    return this.auth.verifyEmailOtp(body);
  }

  @Public()
  @Throttle(20, WINDOW)
  @Post('google')
  google(@Body(new ZodPipe(googleSignInSchema)) body: GoogleSignInInput) {
    return this.auth.googleSignIn(body);
  }
}
