import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ZodPipe } from '../common/zod.pipe';
import {
  sessionSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  workerTokenSchema,
  emailOtpRequestSchema,
  emailOtpVerifySchema,
  googleSignInSchema,
  type SessionInput,
  type LoginInput,
  type OtpRequestInput,
  type OtpVerifyInput,
  type WorkerTokenInput,
  type EmailOtpRequestInput,
  type EmailOtpVerifyInput,
  type GoogleSignInInput,
} from '../contracts';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Passwordless dev auth (demo persona switch). Disabled when ALLOW_DEV_AUTH=false. */
  @Post('session')
  session(@Body(new ZodPipe(sessionSchema)) body: SessionInput) {
    if (process.env.ALLOW_DEV_AUTH === 'false') {
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
