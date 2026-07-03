import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ZodPipe } from '../common/zod.pipe';
import { sessionSchema, type SessionInput } from '../contracts';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('session')
  session(@Body(new ZodPipe(sessionSchema)) body: SessionInput) {
    return this.auth.session(body);
  }
}
