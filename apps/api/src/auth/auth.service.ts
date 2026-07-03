import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { SmsService } from './sms.service';
import type { Role } from '../common/auth';
import type {
  SessionInput,
  LoginInput,
  OtpRequestInput,
  OtpVerifyInput,
  WorkerTokenInput,
} from '../contracts';

export interface TokenResult {
  token: string;
  role: Role;
  projectId: string;
  name?: string;
}

/**
 * Phase 7c-auth. Three ways in:
 *   • email + password  → PMC / client / contractor accounts (bcrypt)
 *   • phone + OTP        → site engineers (MSG91, dev-stubbed with no provider)
 *   • worker device token → no-account QR / tap-photo job card
 * The passwordless dev auth (`session`) is kept for the demo persona switch and
 * gated at the controller by ALLOW_DEV_AUTH.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  private issue(sub: string, role: Role, projectId: string, extra?: Record<string, unknown>): string {
    return this.jwt.sign({ sub, role, projectId, ...extra });
  }

  /** Dev auth — passwordless role pick. Gated by ALLOW_DEV_AUTH at the controller. */
  session(input: SessionInput): TokenResult {
    return {
      token: this.issue(`dev-${input.role}`, input.role, input.projectId),
      role: input.role,
      projectId: input.projectId,
    };
  }

  /** Email + password sign-in for PMC / client / contractor accounts. */
  async login(input: LoginInput): Promise<TokenResult> {
    const email = input.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return {
      token: this.issue(user.id, user.role as Role, user.projectId),
      role: user.role as Role,
      projectId: user.projectId,
      name: user.name,
    };
  }

  /** Start a phone-OTP sign-in (site engineer). `devCode` is only present with no SMS provider. */
  async requestOtp(input: OtpRequestInput): Promise<{ sent: boolean; live: boolean; devCode?: string }> {
    const r = await this.sms.sendOtp(input.phone);
    return { sent: true, live: r.live, devCode: r.devCode };
  }

  /** Complete a phone-OTP sign-in; provisions a site-engineer account on first use. */
  async verifyOtp(input: OtpVerifyInput): Promise<TokenResult> {
    if (!(await this.sms.verifyOtp(input.phone, input.code))) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    let user = await this.prisma.user.findUnique({ where: { phone: input.phone } });
    user ??= await this.prisma.user.create({
      data: { projectId: input.projectId, role: 'engineer', name: 'Site Engineer', phone: input.phone },
    });
    return {
      token: this.issue(user.id, user.role as Role, user.projectId),
      role: user.role as Role,
      projectId: user.projectId,
      name: user.name,
    };
  }

  /** Mint a short-lived worker device token (no account) for the QR / tap-photo job card. */
  async workerToken(input: WorkerTokenInput): Promise<TokenResult> {
    const device = await this.prisma.workerDevice.create({
      data: { projectId: input.projectId, name: input.name, trade: input.trade, token: randomUUID() },
    });
    return {
      token: this.issue(`worker-${device.id}`, 'worker', input.projectId, { worker: true }),
      role: 'worker',
      projectId: input.projectId,
      name: input.name,
    };
  }
}
