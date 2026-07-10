import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
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
   * auto-provision an account. */
  private get selfSignupAllowed(): boolean {
    return process.env.AUTH_ALLOW_SIGNUP === 'true';
  }

  /** Phone-OTP self-signup: auto-provision a site-engineer account for an unknown
   * number. **Default off in production** so a stranger's phone can't mint a
   * writable engineer account (which would hollow out the dev-auth lockdown); set
   * AUTH_ALLOW_PHONE_SIGNUP=true to enable on-site onboarding. Outside production
   * it defaults on so the local demo's phone flow keeps working. */
  private get phoneSignupAllowed(): boolean {
    const v = process.env.AUTH_ALLOW_PHONE_SIGNUP;
    if (v !== undefined) return v === 'true';
    return process.env.NODE_ENV !== 'production';
  }

  /**
   * The role a user may hold on a project — the ONE access-resolution rule every
   * sign-in channel and the project switch go through (SEC-01). Precedence:
   *   1. an active membership (the authoritative grant — `removed` DENIES);
   *   2. org owner/admin super-admin reach (operates any org project as PMC);
   *   3. the legacy home-project fields on `User` — but ONLY when the user has no
   *      membership row for that project at all (accounts provisioned before
   *      memberships existed). A `removed` membership therefore revokes access
   *      even for legacy accounts: removal always wins over the legacy fields.
   * Returns null when access is denied.
   */
  private async resolveProjectRole(user: { id: string; projectId: string; role: string }, projectId: string): Promise<Role | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (membership?.status === 'active') return membership.role as Role;
    if (await this.isOrgAdminOfProject(user.id, projectId)) return 'pmc';
    if (!membership && user.projectId === projectId) return user.role as Role;
    return null;
  }

  /**
   * Where a successful credential lands (SEC-01): the user's home project when
   * still permitted, else their first active membership, else any project in an
   * org they administer. When none of those hold the account has been revoked
   * everywhere — reject the sign-in even though the credential was valid.
   */
  private async signInAccess(user: { id: string; projectId: string; role: string }): Promise<{ projectId: string; role: Role }> {
    const home = await this.prisma.project.findUnique({ where: { id: user.projectId }, select: { archivedAt: true } });
    if (home && !home.archivedAt) {
      const homeRole = await this.resolveProjectRole(user, user.projectId);
      if (homeRole) return { projectId: user.projectId, role: homeRole };
    }
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id, status: 'active', project: { archivedAt: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (membership) return { projectId: membership.projectId, role: membership.role as Role };
    const adminOrgs = await this.prisma.orgMembership.findMany({
      where: { userId: user.id, role: { in: ['owner', 'admin'] } },
      select: { orgId: true },
    });
    if (adminOrgs.length) {
      const project = await this.prisma.project.findFirst({
        where: { orgId: { in: adminOrgs.map((o) => o.orgId) }, archivedAt: null },
      });
      if (project) return { projectId: project.id, role: 'pmc' };
    }
    throw new UnauthorizedException('Your project access has been removed. Ask your PMC to re-add you.');
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
    const access = await this.signInAccess(user);
    return {
      token: this.issue(user.id, access.role, access.projectId),
      role: access.role,
      projectId: access.projectId,
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
    // a valid password is not enough — the account must still hold access somewhere
    const access = await this.signInAccess(user);
    return {
      token: this.issue(user.id, access.role, access.projectId),
      role: access.role,
      projectId: access.projectId,
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
    // An unknown number auto-provisions a site engineer only when phone signup is
    // enabled (AUTH_ALLOW_PHONE_SIGNUP; off by default in production). A number
    // already on an account always signs in.
    return this.signInOrProvision({ phone: input.phone, projectId: input.projectId, allowProvision: this.phoneSignupAllowed });
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
    // AUTH-01: matching accounts by email is only safe when Google has verified the
    // address — an unverified claim could otherwise be linked to someone else's account.
    if (!identity.emailVerified) {
      throw new UnauthorizedException('This Google account’s email address is not verified.');
    }
    // Office channel — invite-only unless AUTH_ALLOW_SIGNUP=true.
    return this.signInOrProvision({ email: identity.email, name: identity.name, projectId: input.projectId, allowProvision: this.selfSignupAllowed });
  }

  /** Mint a short-lived worker device token (no account) for the QR / tap-photo job card. */
  async workerToken(input: WorkerTokenInput): Promise<TokenResult> {
    // Prod lockdown: when WORKER_ENROLL_SECRET is set, the site QR must carry it. Left
    // unset in dev/demo so QR onboarding stays open. (The endpoint is also rate-limited.)
    const enrollSecret = process.env.WORKER_ENROLL_SECRET;
    if (enrollSecret && input.enrollSecret !== enrollSecret) {
      throw new ForbiddenException('Invalid or missing worker enrollment secret');
    }
    // Only mint a device token for a real, active project — otherwise anyone could seed
    // WorkerDevice rows (and read snapshots) for arbitrary/unknown project ids.
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId }, select: { archivedAt: true } });
    if (!project) throw new NotFoundException('Unknown project');
    if (project.archivedAt) throw new ForbiddenException('This project has been archived');
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
      // Back-compat: a user provisioned before memberships still has a home project —
      // but ONLY when they have no membership rows at all. A user whose memberships
      // were all `removed` has been revoked, not grandfathered (SEC-01).
      const anyMembership = await this.prisma.membership.findFirst({ where: { userId }, select: { id: true } });
      if (!anyMembership) {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { project: { include: { org: true } } } });
        if (user) rows.push({ projectId: user.projectId, name: user.project.name, short: user.project.short, role: user.role as Role, orgId: user.project.orgId, orgName: user.project.org?.name ?? null });
      }
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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Unknown user');

    // Role precedence (intentional): an explicit active membership wins over the
    // org-admin super-admin reach, so an org owner/admin can deliberately operate a
    // specific project in a narrower role (e.g. as the `client`) by holding a
    // membership there. The legacy home-project fields count only when the user has
    // no membership row for that project — a `removed` membership always denies
    // (SEC-01). `listMemberships` mirrors this precedence. (Granting PMC to org
    // admins over an explicit membership is a product decision — see docs/ORGS.md.)
    const role = await this.resolveProjectRole(user, projectId);
    if (!role) throw new ForbiddenException('You are not a member of this project');
    return { token: this.issue(userId, role, projectId), role, projectId, name: user.name };
  }
}
