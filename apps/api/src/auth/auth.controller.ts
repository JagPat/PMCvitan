import { Body, Controller, ForbiddenException, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import {
  sessionSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  workerTokenSchema,
  emailOtpRequestSchema,
  emailOtpVerifySchema,
  googleSignInSchema,
  switchProjectSchema,
  type SessionInput,
  type LoginInput,
  type OtpRequestInput,
  type OtpVerifyInput,
  type WorkerTokenInput,
  type EmailOtpRequestInput,
  type EmailOtpVerifyInput,
  type GoogleSignInInput,
  type SwitchProjectInput,
} from '../contracts';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Re-scope the session to another project the user belongs to (project switch). */
  @Post('switch')
  @UseGuards(JwtGuard)
  switch(@CurrentUser() user: AuthUser, @Body(new ZodPipe(switchProjectSchema)) body: SwitchProjectInput) {
    return this.auth.switchProject(user.sub, body.projectId);
  }

  /**
   * Passwordless dev auth (demo persona switch). **Secure by default**: only
   * enabled when ALLOW_DEV_AUTH is explicitly "true". Any other value — or the
   * var being unset — returns 403, so a fresh deploy can't hand out a full PMC
   * token to anyone who POSTs `{role:"pmc"}`. Flip it on for the demo; drop it
   * once real sign-in (password / email-OTP / Google) covers every role.
   */
  @Post('session')
  session(@Body(new ZodPipe(sessionSchema)) body: SessionInput) {
    if (process.env.ALLOW_DEV_AUTH !== 'true') {
      throw new ForbiddenException('Dev auth is disabled');
    }
    return this.auth.session(body);
  }

  @Post('login')
  login(@Body(new ZodPipe(loginSchema)) body: LoginInput) {
    return this.auth.login(body);
  }

  @Post('otp/request')
  otpRequest(@Body(new ZodPipe(otpRequestSchema)) body: OtpRequestInput) {
    return this.auth.requestOtp(body);
  }

  @Post('otp/verify')
  otpVerify(@Body(new ZodPipe(otpVerifySchema)) body: OtpVerifyInput) {
    return this.auth.verifyOtp(body);
  }

  @Post('worker/token')
  workerToken(@Body(new ZodPipe(workerTokenSchema)) body: WorkerTokenInput) {
    return this.auth.workerToken(body);
  }

  @Post('email/request')
  emailRequest(@Body(new ZodPipe(emailOtpRequestSchema)) body: EmailOtpRequestInput) {
    return this.auth.requestEmailOtp(body);
  }

  @Post('email/verify')
  emailVerify(@Body(new ZodPipe(emailOtpVerifySchema)) body: EmailOtpVerifyInput) {
    return this.auth.verifyEmailOtp(body);
  }

  @Post('google')
  google(@Body(new ZodPipe(googleSignInSchema)) body: GoogleSignInInput) {
    return this.auth.googleSignIn(body);
  }
}
