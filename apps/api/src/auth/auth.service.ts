import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { GoogleAuthService } from './google.service';
import type { Role } from '../common/auth';
import type {
  SessionInput,
  LoginInput,
  OtpRequestInput,
  OtpVerifyInput,
  WorkerTokenInput,
  EmailOtpRequestInput,
  EmailOtpVerifyInput,
  GoogleSignInInput,
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
    private readonly email: EmailService,
    private readonly google: GoogleAuthService,
  ) {}

  private issue(sub: string, role: Role, projectId: string, extra?: Record<string, unknown>): string {
    return this.jwt.sign({ sub, role, projectId, ...extra });
  }

  /** Self-signup for the office channels (email / Google) is invite-only by
   * default; set AUTH_ALLOW_SIGNUP=true to let an unknown email/Google identity
   * auto-provision an account. Phone-OTP is exempt — see `signInOrProvision`. */
  private get selfSignupAllowed(): boolean {
    return process.env.AUTH_ALLOW_SIGNUP === 'true';
  }

  /**
   * Resolve a passwordless sign-in (phone / email / Google) to a token: reuse an
   * existing account matched by phone or email. When there's no match, provision
   * a site-engineer account **only if `allowProvision`** — otherwise reject
   * (invite-only). Phone-OTP passes `allowProvision: true` (a phone is the on-site
   * engineer-onboarding signal); email + Google pass `selfSignupAllowed`, so with
   * the default (invite-only) a stranger's email/Google can't mint a writable
   * engineer account — which is what makes the dev-auth lockdown meaningful.
   */
  private async signInOrProvision(input: {
    phone?: string;
    email?: string;
    name?: string;
    projectId: string;
    allowProvision: boolean;
  }): Promise<TokenResult> {
    const user =
      (input.email && (await this.prisma.user.findUnique({ where: { email: input.email } }))) ||
      (input.phone && (await this.prisma.user.findUnique({ where: { phone: input.phone } }))) ||
      null;
    if (!user) {
      if (!input.allowProvision) {
        throw new UnauthorizedException('No account for this sign-in. Ask your PMC to add you.');
      }
      const created = await this.prisma.user.create({
        data: {
          projectId: input.projectId,
          role: 'engineer',
          name: input.name || 'Site Engineer',
          email: input.email,
          phone: input.phone,
        },
      });
      return { token: this.issue(created.id, 'engineer', created.projectId), role: 'engineer', projectId: created.projectId, name: created.name };
    }
    return {
      token: this.issue(user.id, user.role as Role, user.projectId),
      role: user.role as Role,
      projectId: user.projectId,
      name: user.name,
    };
  }

  /**
   * Dev auth — passwordless role pick (gated by ALLOW_DEV_AUTH at the controller).
   * Resolves to the REAL seeded account for this role+project when one exists, so
   * the persona carries real org/project membership — the "PMC" persona becomes the
   * actual org-owner admin and sees every admin control (create/edit/archive
   * projects, all teams, the whole portfolio). Falls back to a synthetic identity
   * for the pure local demo and for roles without a seeded account (e.g. engineer).
   */
  async session(input: SessionInput): Promise<TokenResult> {
    const real = await this.prisma.user.findFirst({ where: { role: input.role, projectId: input.projectId } });
    if (real) {
      return { token: this.issue(real.id, real.role as Role, real.projectId), role: real.role as Role, projectId: real.projectId, name: real.name };
    }
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

  /** Start a phone-OTP sign-in. `devCode` only with no provider; `channel` names the delivery route. */
  async requestOtp(input: OtpRequestInput): Promise<{ sent: boolean; live: boolean; channel: string; devCode?: string }> {
    const r = await this.sms.sendOtp(input.phone);
    return { sent: true, live: r.live, channel: r.channel, devCode: r.devCode };
  }

  /** Complete a phone-OTP sign-in; provisions a site-engineer account on first use. */
  async verifyOtp(input: OtpVerifyInput): Promise<TokenResult> {
    if (!(await this.sms.verifyOtp(input.phone, input.code))) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    // Phone-OTP is the on-site engineer onboarding flow — always provisions.
    return this.signInOrProvision({ phone: input.phone, projectId: input.projectId, allowProvision: true });
  }

  /** Start an email-OTP sign-in (zero-DLT fallback). `devCode` only with no SMTP. */
  async requestEmailOtp(input: EmailOtpRequestInput): Promise<{ sent: boolean; live: boolean; devCode?: string }> {
    const r = await this.email.sendOtp(input.email);
    return { sent: true, live: r.live, devCode: r.devCode };
  }

  /** Complete an email-OTP sign-in; reuses an existing account (by email) or provisions one. */
  async verifyEmailOtp(input: EmailOtpVerifyInput): Promise<TokenResult> {
    if (!(await this.email.verifyOtp(input.email, input.code))) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    // Office channel — invite-only unless AUTH_ALLOW_SIGNUP=true.
    return this.signInOrProvision({ email: input.email.toLowerCase(), projectId: input.projectId, allowProvision: this.selfSignupAllowed });
  }

  /** Google sign-in — verify the ID token, then reuse/provision the account by email. */
  async googleSignIn(input: GoogleSignInInput): Promise<TokenResult> {
    const identity = await this.google.verify(input.idToken);
    // Office channel — invite-only unless AUTH_ALLOW_SIGNUP=true.
    return this.signInOrProvision({ email: identity.email, name: identity.name, projectId: input.projectId, allowProvision: this.selfSignupAllowed });
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

  /** Projects the user can access (their memberships; falls back to the legacy home project). */
  async listMemberships(userId: string): Promise<
    Array<{ projectId: string; name: string; short: string; role: Role; orgId: string | null; orgName: string | null }>
  > {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'active' },
      include: { project: { include: { org: true } } },
    });
    const rows = memberships
      .filter((m) => !m.project.archivedAt) // hide archived projects
      .map((m) => ({
        projectId: m.projectId,
        name: m.project.name,
        short: m.project.short,
        role: m.role as Role,
        orgId: m.project.orgId,
        orgName: m.project.org?.name ?? null,
      }));

    // Org super-admin reach: an owner/admin can access every (non-archived) project in
    // their org (as PMC), even ones they didn't create and aren't an explicit member of.
    const adminOrgs = await this.prisma.orgMembership.findMany({ where: { userId, role: { in: ['owner', 'admin'] } }, select: { orgId: true } });
    if (adminOrgs.length) {
      const have = new Set(rows.map((r) => r.projectId));
      const projects = await this.prisma.project.findMany({ where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null }, include: { org: true } });
      for (const p of projects) {
        if (!have.has(p.id)) {
          rows.push({ projectId: p.id, name: p.name, short: p.short, role: 'pmc' as Role, orgId: p.orgId, orgName: p.org?.name ?? null });
          have.add(p.id);
        }
      }
    }

    if (rows.length === 0) {
      // back-compat: a user provisioned before memberships still has a home project
      const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { project: { include: { org: true } } } });
      if (user) rows.push({ projectId: user.projectId, name: user.project.name, short: user.project.short, role: user.role as Role, orgId: user.project.orgId, orgName: user.project.org?.name ?? null });
    }
    return rows;
  }

  /** Is this user an owner/admin of the org that owns this project? (org super-admin). */
  private async isOrgAdminOfProject(userId: string, projectId: string): Promise<boolean> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
    if (!project?.orgId) return false;
    const om = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: project.orgId, userId } } });
    return om?.role === 'owner' || om?.role === 'admin';
  }

  /** Issue a fresh token scoped to another project the user belongs to (project switch).
   *  Org owners/admins can switch into ANY project in their org — they operate it as PMC
   *  even without an explicit membership (the org super-admin reach). */
  async switchProject(userId: string, projectId: string): Promise<TokenResult> {
    const target = await this.prisma.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
    if (target?.archivedAt) throw new ForbiddenException('This project has been archived');
    const membership = await this.prisma.membership.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Unknown user');

    let role: Role;
    if (membership && membership.status === 'active') {
      role = membership.role as Role;
    } else if (user.projectId === projectId) {
      role = user.role as Role; // back-compat: the user's own home project
    } else if (await this.isOrgAdminOfProject(userId, projectId)) {
      role = 'pmc'; // org owner/admin operates any project in their org
    } else {
      throw new ForbiddenException('You are not a member of this project');
    }
    return { token: this.issue(userId, role, projectId), role, projectId, name: user.name };
  }
}
