import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { SessionInput } from '../contracts';

/**
 * Dev auth for Phase-7 Slice 1: issues a scoped JWT for a chosen role, no
 * password. Replaced in the next slice by real auth (accounts + phone OTP +
 * worker device tokens).
 */
@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  session(input: SessionInput): { token: string; role: string; projectId: string } {
    const token = this.jwt.sign({ sub: `dev-${input.role}`, role: input.role, projectId: input.projectId });
    return { token, role: input.role, projectId: input.projectId };
  }
}
