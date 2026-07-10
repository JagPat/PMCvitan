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

/** Minimal in-memory Prisma stand-in for the tables AuthService touches. */
function fakePrisma(seed: FakeUser[] = []) {
  const users = [...seed];
  let workerSeq = 0;
  return {
    users,
    workerCreated: [] as unknown[],
    user: {
      findUnique: async ({ where }: { where: { email?: string; phone?: string } }) =>
        users.find((u) => (where.email && u.email === where.email) || (where.phone && u.phone === where.phone)) ?? null,
      findFirst: async ({ where }: { where: { role?: string; projectId?: string } }) =>
        users.find((u) => (where.role ? u.role === where.role : true) && (where.projectId ? u.projectId === where.projectId : true)) ?? null,
      create: async ({ data }: { data: Omit<FakeUser, 'id'> }) => {
        const u = { id: `u${users.length + 1}`, ...data };
        users.push(u);
        return u;
      },
    },
    workerDevice: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const d = { id: `w${++workerSeq}`, ...data };
        return d;
      },
    },
    project: {
      // 'ambli' is the seeded demo project; 'archived-proj' exists but is archived.
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id === 'ambli') return { archivedAt: null };
        if (where.id === 'archived-proj') return { archivedAt: new Date() };
        return null;
      },
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
    const prisma = fakePrisma([
      { id: 'u1', projectId: 'ambli', role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in', passwordHash: bcrypt.hashSync('secret', 10) },
    ]);
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
    const prisma = fakePrisma([
      { id: 'u9', projectId: 'ambli', role: 'engineer', name: 'Ramesh', phone: '9876543210' },
    ]);
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    const res = await auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' });
    expect(res.name).toBe('Ramesh');
    expect(prisma.users).toHaveLength(1);
  });

  it('reuses an existing account for the phone', async () => {
    const prisma = fakePrisma([
      { id: 'u9', projectId: 'ambli', role: 'engineer', name: 'Ramesh', phone: '9876543210' },
    ]);
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
    const prisma = fakePrisma([
      { id: 'u1', projectId: 'ambli', role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' },
    ]);
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
    const prisma = fakePrisma([
      { id: 'u1', projectId: 'ambli', role: 'client', name: 'Mr. Shah', email: 'client@vitan.in' },
    ]);
    const { auth, google } = make(prisma);
    google.verify = async () => ({ email: 'client@vitan.in', name: 'Mr. Shah', emailVerified: true });
    const res = await auth.googleSignIn({ idToken: 'tok', projectId: 'ambli' });
    expect(res.role).toBe('client');
    expect(prisma.users).toHaveLength(1); // reused, not provisioned
  });
});
