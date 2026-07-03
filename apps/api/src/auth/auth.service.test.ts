import { describe, it, expect, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { SmsService } from './sms.service';
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
  };
}

function make(prisma: ReturnType<typeof fakePrisma>) {
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '12h' } });
  const sms = new SmsService();
  const auth = new AuthService(jwt, prisma as unknown as PrismaService, sms);
  return { auth, jwt, sms };
}

describe('AuthService.login', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
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
  });

  it('provisions a site engineer on first successful OTP', async () => {
    const prisma = fakePrisma();
    const { auth, sms } = make(prisma);
    const { devCode } = await sms.sendOtp('9876543210');
    const res = await auth.verifyOtp({ phone: '9876543210', code: devCode!, projectId: 'ambli' });
    expect(res.role).toBe('engineer');
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0]).toMatchObject({ phone: '9876543210', role: 'engineer' });
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
  it('mints a worker-scoped token with a worker claim', async () => {
    const prisma = fakePrisma();
    const { auth, jwt } = make(prisma);
    const res = await auth.workerToken({ projectId: 'ambli', name: 'Suresh', trade: 'Mason' });
    expect(res.role).toBe('worker');
    const decoded = jwt.verify<{ sub: string; role: string; worker: boolean }>(res.token);
    expect(decoded).toMatchObject({ role: 'worker', worker: true });
    expect(decoded.sub).toMatch(/^worker-/);
  });
});

describe('AuthService.session (dev auth)', () => {
  it('issues a passwordless role token', () => {
    const { auth, jwt } = make(fakePrisma());
    const res = auth.session({ role: 'client', projectId: 'ambli' });
    const decoded = jwt.verify<{ sub: string; role: string }>(res.token);
    expect(decoded).toMatchObject({ sub: 'dev-client', role: 'client' });
  });
});
