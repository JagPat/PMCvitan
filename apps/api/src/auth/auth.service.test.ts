import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { GoogleAuthService } from './google.service';
import type { PrismaService } from '../prisma.service';

interface FakeUser {
  id: string;
  projectId: string;
  role: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  passwordHash?: string | null;
}

interface FakeMembership {
  projectId: string;
  userId: string;
  role: string;
  status: string;
}

interface FakeOrgMembership {
  orgId: string;
  userId: string;
  role: string;
}

/** Minimal in-memory Prisma stand-in for the tables AuthService touches. */
function fakePrisma(seed: FakeUser[] = [], membershipSeed: FakeMembership[] = [], orgMembershipSeed: FakeOrgMembership[] = []) {
  const users = [...seed];
  const memberships = [...membershipSeed];
  const orgMemberships = [...orgMembershipSeed];
  // Known projects: 'ambli' (active, org 'org1'); 'archived-proj' (archived).
  const projects: Array<{ id: string; orgId: string | null; archivedAt: Date | null }> = [
    { id: 'ambli', orgId: 'org1', archivedAt: null },
    { id: 'archived-proj', orgId: 'org1', archivedAt: new Date() },
  ];
  const isActiveProject = (projectId: string): boolean => {
    const p = projects.find((x) => x.id === projectId);
    return p ? !p.archivedAt : true; // projects not modelled here are treated as active
  };
  let workerSeq = 0;
  return {
    users,
    memberships,
    workerCreated: [] as unknown[],
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string; phone?: string } }) =>
        users.find((u) => (where.id && u.id === where.id) || (where.email && u.email === where.email) || (where.phone && u.phone === where.phone)) ?? null,
      findFirst: async ({ where }: { where: { role?: string; projectId?: string } }) =>
        users.find((u) => (where.role ? u.role === where.role : true) && (where.projectId ? u.projectId === where.projectId : true)) ?? null,
      create: async ({ data }: { data: Omit<FakeUser, 'id'> }) => {
        const u = { id: `u${users.length + 1}`, ...data };
        users.push(u);
        return u;
      },
    },
    membership: {
      findUnique: async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        memberships.find((m) => m.projectId === where.projectId_userId.projectId && m.userId === where.projectId_userId.userId) ?? null,
      findFirst: async ({ where }: { where: { userId: string; status?: string; project?: { archivedAt: null } } }) =>
        memberships.find(
          (m) =>
            m.userId === where.userId &&
            (where.status ? m.status === where.status : true) &&
            (where.project?.archivedAt === null ? isActiveProject(m.projectId) : true),
        ) ?? null,
      findMany: async ({ where }: { where: { userId: string; status?: string } }) =>
        memberships
          .filter((m) => m.userId === where.userId && (where.status ? m.status === where.status : true))
          .map((m) => ({ ...m, project: { name: m.projectId, short: m.projectId, orgId: 'org1', archivedAt: null, org: { name: 'Vitan' } } })),
      create: async ({ data }: { data: FakeMembership }) => {
        memberships.push({ ...data });
        return { id: `m${memberships.length}`, ...data };
      },
    },
    orgMembership: {
      findUnique: async ({ where }: { where: { orgId_userId: { orgId: string; userId: string } } }) =>
        orgMemberships.find((o) => o.orgId === where.orgId_userId.orgId && o.userId === where.orgId_userId.userId) ?? null,
      findMany: async ({ where }: { where: { userId: string; role?: { in: string[] } } }) =>
        orgMemberships
          .filter((o) => o.userId === where.userId && (where.role?.in ? where.role.in.includes(o.role) : true))
          .map((o) => ({ orgId: o.orgId })),
    },
    workerDevice: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const d = { id: `w${++workerSeq}`, ...data };
        return d;
      },
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => projects.find((p) => p.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { orgId?: { in: string[] }; archivedAt?: null } }) =>
        projects.find(
          (p) => (where.orgId?.in ? p.orgId !== null && where.orgId.in.includes(p.orgId) : true) && (where.archivedAt === null ? !p.archivedAt : true),
        ) ?? null,
    },
  };
}

function make(prisma: ReturnType<typeof fakePrisma>) {
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '12h' } });
  const sms = new SmsService();
  const email = new EmailService();
  const google = new GoogleAuthService();
  const auth = new AuthService(jwt, prisma as unknown as PrismaService, sms, email, google);
  return { auth, jwt, sms, email, google };
}

describe('AuthService.login', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    delete process.env.FAST2SMS_API_KEY;
  });

  it('accepts the right password and issues a role-scoped token', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in', passwordHash: bcrypt.hashSync('secret', 10) }],
      [{ projectId: 'ambli', userId: 'u1', role: 'pmc', status: 'active' }],
    );
    const { auth, jwt } = make(prisma);
    const res = await auth.login({ email: 'PMC@vitan.in', password: 'secret' });
    expect(res.role).toBe('pmc');
    expect(res.name).toBe('Ar. Vitan');
    const decoded = jwt.verify<{ sub: string; role: string; projectId: string }>(res.token);
    expect(decoded).toMatchObject({ sub: 'u1', role: 'pmc', projectId: 'ambli' });
  });

  it('rejects a wrong password', async () => {
    const prisma = fakePrisma([
      { id: 'u1', projectId: 'ambli', role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in', passwordHash: bcrypt.hashSync('secret', 10) },
    ]);
    const { auth } = make(prisma);
    await expect(auth.login({ email: 'pmc@vitan.in', password: 'nope' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown email', async () => {
    const { auth } = make(fakePrisma());
    await expect(auth.login({ email: 'ghost@vitan.in', password: 'secret' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('SEC-01: a removed member cannot sign in with a valid password (revocation is authoritative)', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'contractor', name: 'Ex Contractor', email: 'ex@vitan.in', passwordHash: bcrypt.hashSync('secret', 10) }],
      [{ projectId: 'ambli', userId: 'u1', role: 'contractor', status: 'removed' }],
    );
    const { auth } = make(prisma);
    await expect(auth.login({ email: 'ex@vitan.in', password: 'secret' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('SEC-01: sign-in lands on the first active membership when home access was revoked', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'contractor', name: 'Moved', email: 'moved@vitan.in', passwordHash: bcrypt.hashSync('secret', 10) }],
      [
        { projectId: 'ambli', userId: 'u1', role: 'contractor', status: 'removed' },
        { projectId: 'villa', userId: 'u1', role: 'engineer', status: 'active' },
      ],
    );
    const { auth } = make(prisma);
    const res = await auth.login({ email: 'moved@vitan.in', password: 'secret' });
    expect(res).toMatchObject({ projectId: 'villa', role: 'engineer' });
  });

  it('SEC-01: an active membership overrides the stale legacy role on the User row', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'pmc', name: 'Demoted', email: 'demoted@vitan.in', passwordHash: bcrypt.hashSync('secret', 10) }],
      [{ projectId: 'ambli', userId: 'u1', role: 'client', status: 'active' }],
    );
    const { auth } = make(prisma);
    const res = await auth.login({ email: 'demoted@vitan.in', password: 'secret' });
    expect(res).toMatchObject({ projectId: 'ambli', role: 'client' }); // membership wins, not user.role
  });
});

describe('AuthService.verifyOtp', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    delete process.env.FAST2SMS_API_KEY;
    delete process.env.AUTH_ALLOW_PHONE_SIGNUP;
  });
  afterEach(() => {
    delete process.env.AUTH_ALLOW_PHONE_SIGNUP;
  });

  it('provisions a site engineer on first successful OTP when phone signup is enabled', async () => {
    process.env.AUTH_ALLOW_PHONE_SIGNUP = 'true';
    const prisma = fakePrisma();
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    const res = await auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' });
    expect(res.role).toBe('engineer');
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0]).toMatchObject({ phone: '9876543210', role: 'engineer' });
  });

  it('rejects an unknown number when phone signup is disabled (no auto-provision)', async () => {
    process.env.AUTH_ALLOW_PHONE_SIGNUP = 'false';
    const prisma = fakePrisma();
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    await expect(
      auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.users).toHaveLength(0); // nothing minted
  });

  it('a known number always signs in, even with phone signup disabled', async () => {
    process.env.AUTH_ALLOW_PHONE_SIGNUP = 'false';
    const prisma = fakePrisma(
      [{ id: 'u9', projectId: 'ambli', role: 'engineer', name: 'Ramesh', phone: '9876543210' }],
      [{ projectId: 'ambli', userId: 'u9', role: 'engineer', status: 'active' }],
    );
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    const res = await auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' });
    expect(res.name).toBe('Ramesh');
    expect(prisma.users).toHaveLength(1);
  });

  it('reuses an existing account for the phone', async () => {
    const prisma = fakePrisma(
      [{ id: 'u9', projectId: 'ambli', role: 'engineer', name: 'Ramesh', phone: '9876543210' }],
      [{ projectId: 'ambli', userId: 'u9', role: 'engineer', status: 'active' }],
    );
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    const res = await auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' });
    expect(res.name).toBe('Ramesh');
    expect(prisma.users).toHaveLength(1); // no new user created
  });

  it('rejects a bad code', async () => {
    const prisma = fakePrisma();
    const { auth, sms } = make(prisma);
    await sms.sendOtp('9876543210');
    await expect(
      auth.verifyOtp({ phone: '9876543210', code: '0000', projectId: 'ambli' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('SEC-01: a removed member cannot sign back in via phone OTP', async () => {
    const prisma = fakePrisma(
      [{ id: 'u9', projectId: 'ambli', role: 'engineer', name: 'Removed Eng', phone: '9876543210' }],
      [{ projectId: 'ambli', userId: 'u9', role: 'engineer', status: 'removed' }],
    );
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    await expect(
      auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.workerToken', () => {
  beforeEach(() => {
    delete process.env.WORKER_ENROLL_SECRET;
  });

  it('mints a worker-scoped token with a worker claim', async () => {
    const prisma = fakePrisma();
    const { auth, jwt } = make(prisma);
    const res = await auth.workerToken({ projectId: 'ambli', name: 'Suresh', trade: 'Mason' });
    expect(res.role).toBe('worker');
    const decoded = jwt.verify<{ sub: string; role: string; worker: boolean }>(res.token);
    expect(decoded).toMatchObject({ role: 'worker', worker: true });
    expect(decoded.sub).toMatch(/^worker-/);
  });

  it('rejects an unknown project (no minting device tokens for arbitrary ids)', async () => {
    const { auth } = make(fakePrisma());
    await expect(auth.workerToken({ projectId: 'does-not-exist' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an archived project', async () => {
    const { auth } = make(fakePrisma());
    await expect(auth.workerToken({ projectId: 'archived-proj' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires the enrollment secret when WORKER_ENROLL_SECRET is set (prod lockdown)', async () => {
    process.env.WORKER_ENROLL_SECRET = 's3cr3t';
    const { auth } = make(fakePrisma());
    await expect(auth.workerToken({ projectId: 'ambli' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.workerToken({ projectId: 'ambli', enrollSecret: 'wrong' })).rejects.toBeInstanceOf(ForbiddenException);
    const ok = await auth.workerToken({ projectId: 'ambli', enrollSecret: 's3cr3t' });
    expect(ok.role).toBe('worker'); // correct secret passes
  });

  it('stays open when WORKER_ENROLL_SECRET is unset (dev/demo QR onboarding)', async () => {
    const { auth } = make(fakePrisma());
    const res = await auth.workerToken({ projectId: 'ambli' }); // no secret needed
    expect(res.role).toBe('worker');
  });
});

describe('AuthService.session (dev auth)', () => {
  it('issues a synthetic token when no real account exists for the role', async () => {
    const { auth, jwt } = make(fakePrisma());
    const res = await auth.session({ role: 'client', projectId: 'ambli' });
    const decoded = jwt.verify<{ sub: string; role: string }>(res.token);
    expect(decoded).toMatchObject({ sub: 'dev-client', role: 'client' });
  });

  it('resolves to the REAL seeded account for the role (so the persona carries org/project membership)', async () => {
    const seed = [{ id: 'real-pmc', projectId: 'ambli', role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' }];
    const { auth, jwt } = make(fakePrisma(seed));
    const res = await auth.session({ role: 'pmc', projectId: 'ambli' });
    expect(res.name).toBe('Ar. Vitan');
    expect(jwt.verify<{ sub: string; role: string }>(res.token)).toMatchObject({ sub: 'real-pmc', role: 'pmc', projectId: 'ambli' });
  });
});

describe('AuthService — email OTP', () => {
  beforeEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.AUTH_ALLOW_SIGNUP;
  });

  it('rejects an unknown email by default (invite-only), creating no account', async () => {
    const prisma = fakePrisma();
    const { auth } = make(prisma);
    const req = await auth.requestEmailOtp({ email: 'stranger@vitan.in', projectId: 'ambli' });
    expect(req.live).toBe(false);
    await expect(
      auth.verifyEmailOtp({ email: 'stranger@vitan.in', code: req.devCode!, projectId: 'ambli' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.users).toHaveLength(0); // no self-provisioning
  });

  it('provisions an engineer for an unknown email when AUTH_ALLOW_SIGNUP=true', async () => {
    process.env.AUTH_ALLOW_SIGNUP = 'true';
    const prisma = fakePrisma();
    const { auth } = make(prisma);
    const req = await auth.requestEmailOtp({ email: 'new@vitan.in', projectId: 'ambli' });
    const res = await auth.verifyEmailOtp({ email: 'new@vitan.in', code: req.devCode!, projectId: 'ambli' });
    expect(res.role).toBe('engineer');
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0]).toMatchObject({ email: 'new@vitan.in', role: 'engineer' });
  });

  it('reuses an existing account (by email) with its role — even when invite-only', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' }],
      [{ projectId: 'ambli', userId: 'u1', role: 'pmc', status: 'active' }],
    );
    const { auth } = make(prisma);
    const req = await auth.requestEmailOtp({ email: 'pmc@vitan.in', projectId: 'ambli' });
    const res = await auth.verifyEmailOtp({ email: 'PMC@vitan.in', code: req.devCode!, projectId: 'ambli' });
    expect(res.role).toBe('pmc');
    expect(prisma.users).toHaveLength(1); // no new user
  });

  it('rejects a bad email code', async () => {
    const prisma = fakePrisma();
    const { auth } = make(prisma);
    await auth.requestEmailOtp({ email: 'x@vitan.in', projectId: 'ambli' });
    await expect(auth.verifyEmailOtp({ email: 'x@vitan.in', code: '000000', projectId: 'ambli' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService — Google sign-in', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.AUTH_ALLOW_SIGNUP;
  });

  it('is unavailable (503) when Google is not configured', async () => {
    const { auth } = make(fakePrisma());
    await expect(auth.googleSignIn({ idToken: 'tok', projectId: 'ambli' })).rejects.toThrow();
  });

  it('rejects an unknown Google identity by default (invite-only)', async () => {
    const prisma = fakePrisma();
    const { auth, google } = make(prisma);
    google.verify = async () => ({ email: 'stranger@gmail.com', name: 'Stranger', emailVerified: true });
    await expect(auth.googleSignIn({ idToken: 'tok', projectId: 'ambli' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.users).toHaveLength(0);
  });

  it('signs in an existing account matched by Google email', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'client', name: 'Mr. Shah', email: 'client@vitan.in' }],
      [{ projectId: 'ambli', userId: 'u1', role: 'client', status: 'active' }],
    );
    const { auth, google } = make(prisma);
    google.verify = async () => ({ email: 'client@vitan.in', name: 'Mr. Shah', emailVerified: true });
    const res = await auth.googleSignIn({ idToken: 'tok', projectId: 'ambli' });
    expect(res.role).toBe('client');
    expect(prisma.users).toHaveLength(1); // reused, not provisioned
  });

  it('AUTH-01: rejects a Google identity whose email is not verified', async () => {
    const prisma = fakePrisma(
      [{ id: 'u1', projectId: 'ambli', role: 'client', name: 'Mr. Shah', email: 'client@vitan.in' }],
      [{ projectId: 'ambli', userId: 'u1', role: 'client', status: 'active' }],
    );
    const { auth, google } = make(prisma);
    google.verify = async () => ({ email: 'client@vitan.in', name: 'Mr. Shah', emailVerified: false });
    await expect(auth.googleSignIn({ idToken: 'tok', projectId: 'ambli' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * Org-roster escalation (Codex addendum). A roster identity is provisioned homed on a
 * project as a legacy `contractor` with NO project membership; project access must come
 * ONLY from an active membership or an org owner/admin role — never the legacy User
 * fields. These wire roster org-role state directly to AuthService access resolution.
 */
describe('AuthService — org-roster access resolution', () => {
  const pw = bcrypt.hashSync('secret', 10);
  // A roster-provisioned identity: homed on 'ambli', dormant legacy role, no membership.
  const rosterUser = () => [{ id: 'u1', projectId: 'ambli', role: 'contractor', name: 'Chitrang', email: 'c@vitan.in', passwordHash: pw }];

  it('a plain org MEMBER (no project membership) cannot obtain a project token', async () => {
    const prisma = fakePrisma(rosterUser(), [], [{ orgId: 'org1', userId: 'u1', role: 'member' }]);
    const { auth } = make(prisma);
    await expect(auth.login({ email: 'c@vitan.in', password: 'secret' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.switchProject('u1', 'ambli')).rejects.toBeInstanceOf(ForbiddenException);
    expect(await auth.listMemberships('u1')).toEqual([]); // can't even enumerate the project
  });

  it('an org ADMIN reaches the org project as PMC while active', async () => {
    const prisma = fakePrisma(rosterUser(), [], [{ orgId: 'org1', userId: 'u1', role: 'admin' }]);
    const { auth } = make(prisma);
    const res = await auth.login({ email: 'c@vitan.in', password: 'secret' });
    expect(res).toMatchObject({ projectId: 'ambli', role: 'pmc' });
    expect(await auth.switchProject('u1', 'ambli')).toMatchObject({ role: 'pmc' });
  });

  it('demoting that admin to member immediately removes PMC access (no phantom membership left behind)', async () => {
    // demotion only changes the OrgMembership row — the fix means that IS the whole grant
    const prisma = fakePrisma(rosterUser(), [], [{ orgId: 'org1', userId: 'u1', role: 'member' }]);
    const { auth } = make(prisma);
    await expect(auth.login({ email: 'c@vitan.in', password: 'secret' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('removing the org membership entirely leaves no project access', async () => {
    const prisma = fakePrisma(rosterUser(), [], []); // org membership deleted
    const { auth } = make(prisma);
    await expect(auth.login({ email: 'c@vitan.in', password: 'secret' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.switchProject('u1', 'ambli')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an admin who ALSO holds an explicit project membership keeps that project via the membership', async () => {
    const prisma = fakePrisma(
      rosterUser(),
      [{ projectId: 'ambli', userId: 'u1', role: 'client', status: 'active' }], // explicit narrower role
      [{ orgId: 'org1', userId: 'u1', role: 'admin' }],
    );
    const { auth } = make(prisma);
    // explicit membership wins over the org-admin PMC reach (documented precedence)
    expect(await auth.switchProject('u1', 'ambli')).toMatchObject({ role: 'client' });
  });
});
