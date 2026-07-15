import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import { PasswordCredentialsService } from './password-credentials.service';

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  credentialVersion: number;
  memberships: Array<{ status: string }>;
  orgMemberships: Array<{ role: string }>;
}

interface ChallengeRow {
  id: string;
  userId: string;
  purpose: string;
  otpHash: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  setupTokenHash: string | null;
  setupTokenExpiresAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}

function fakePrisma(seed: UserRow[]) {
  const users = structuredClone(seed);
  const challenges: ChallengeRow[] = [];
  const events: Array<Record<string, unknown>> = [];

  const matches = (row: ChallengeRow, where: Record<string, unknown>): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.purpose !== undefined && row.purpose !== where.purpose) return false;
    if (where.setupTokenHash !== undefined && row.setupTokenHash !== where.setupTokenHash) return false;
    if (where.attempts !== undefined && typeof where.attempts === 'number' && row.attempts !== where.attempts) return false;
    if (where.consumedAt === null && row.consumedAt !== null) return false;
    if (where.verifiedAt === null && row.verifiedAt !== null) return false;
    if (typeof where.verifiedAt === 'object' && where.verifiedAt !== null && 'not' in where.verifiedAt && row.verifiedAt === null) return false;
    if (typeof where.expiresAt === 'object' && where.expiresAt !== null && 'gt' in where.expiresAt && row.expiresAt <= (where.expiresAt as { gt: Date }).gt) return false;
    if (typeof where.setupTokenExpiresAt === 'object' && where.setupTokenExpiresAt !== null && 'gt' in where.setupTokenExpiresAt && (!row.setupTokenExpiresAt || row.setupTokenExpiresAt <= (where.setupTokenExpiresAt as { gt: Date }).gt)) return false;
    return true;
  };

  const db = {
    users,
    challenges,
    events,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
        users.find((row) => (where.id ? row.id === where.id : row.email === where.email)) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const user = users.find((row) => row.id === where.id);
        if (!user) throw new Error('missing user');
        if (typeof data.passwordHash === 'string') user.passwordHash = data.passwordHash;
        if (data.emailVerifiedAt instanceof Date) user.emailVerifiedAt = data.emailVerifiedAt;
        if (typeof data.credentialVersion === 'object' && data.credentialVersion && 'increment' in data.credentialVersion) {
          user.credentialVersion += Number((data.credentialVersion as { increment: number }).increment);
        }
        return { ...user };
      }),
    },
    passwordCredentialChallenge: {
      create: vi.fn(async ({ data }: { data: ChallengeRow }) => {
        const row = { ...data };
        challenges.push(row);
        return { ...row };
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; setupTokenHash?: string } }) => {
        const row = challenges.find((candidate) => (where.id ? candidate.id === where.id : candidate.setupTokenHash === where.setupTokenHash));
        if (!row) return null;
        return { ...row, user: { ...users.find((user) => user.id === row.userId)! } };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const selected = challenges.filter((row) => matches(row, where));
        for (const row of selected) {
          if (data.consumedAt instanceof Date) row.consumedAt = data.consumedAt;
          if (data.verifiedAt instanceof Date) row.verifiedAt = data.verifiedAt;
          if (typeof data.setupTokenHash === 'string') row.setupTokenHash = data.setupTokenHash;
          if (data.setupTokenExpiresAt instanceof Date) row.setupTokenExpiresAt = data.setupTokenExpiresAt;
          if (typeof data.attempts === 'object' && data.attempts && 'increment' in data.attempts) {
            row.attempts += Number((data.attempts as { increment: number }).increment);
          }
        }
        return { count: selected.length };
      }),
    },
    securityAuditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push({ ...data });
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const beforeUsers = structuredClone(users);
      const beforeChallenges = structuredClone(challenges);
      const beforeEvents = structuredClone(events);
      try {
        return await work(db);
      } catch (error) {
        users.splice(0, users.length, ...beforeUsers);
        challenges.splice(0, challenges.length, ...beforeChallenges);
        events.splice(0, events.length, ...beforeEvents);
        throw error;
      }
    }),
  };
  return db;
}

function activeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u-active',
    email: 'member@example.com',
    passwordHash: null,
    emailVerifiedAt: null,
    credentialVersion: 0,
    memberships: [{ status: 'active' }],
    orgMemberships: [],
    ...overrides,
  };
}

function make(seed: UserRow[]) {
  const prisma = fakePrisma(seed);
  const delivered: Array<{ email: string; code: string }> = [];
  const email = {
    sendPasswordCredentialCode: vi.fn(async (address: string, code: string) => {
      delivered.push({ email: address, code });
      return { live: true };
    }),
  };
  const service = new PasswordCredentialsService(
    prisma as unknown as PrismaService,
    email as never,
  );
  return { service, prisma, delivered };
}

describe('PasswordCredentialsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('returns the same public shape but sends and stores a challenge only for an eligible invited identity', async () => {
    const { service, prisma, delivered } = make([
      activeUser(),
      activeUser({ id: 'u-removed', email: 'removed@example.com', memberships: [{ status: 'removed' }] }),
    ]);

    const known = await service.request({ email: ' MEMBER@EXAMPLE.COM ' });
    const unknown = await service.request({ email: 'unknown@example.com' });
    const removed = await service.request({ email: 'removed@example.com' });

    for (const response of [known, unknown, removed]) {
      expect(response).toEqual({ accepted: true, requestId: expect.any(String) });
    }
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.email).toBe('member@example.com');
    expect(prisma.challenges).toHaveLength(1);
    expect(prisma.challenges[0]?.otpHash).not.toContain(delivered[0]!.code);
  });

  it('limits wrong OTP attempts, expires challenges, and never returns an application session', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.verify({ requestId, code: '000000' })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.verify({ requestId, code: delivered[0]!.code })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.challenges[0]?.consumedAt).toBeInstanceOf(Date);

    const second = await service.request({ email: 'member@example.com' });
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await expect(service.verify({ requestId: second.requestId, code: delivered[1]!.code })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses a one-time setup token to hash the password, increment the version, and write a secret-free audit', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });
    const verified = await service.verify({ requestId, code: delivered[0]!.code });

    expect(verified).toEqual({ setupToken: expect.any(String), expiresInSeconds: 600 });
    expect(verified).not.toHaveProperty('token');
    expect(prisma.challenges[0]?.setupTokenHash).not.toBe(verified.setupToken);

    const updated = await service.complete({
      setupToken: verified.setupToken,
      password: 'a long internal passphrase',
    });

    expect(await bcrypt.compare('a long internal passphrase', updated.passwordHash!)).toBe(true);
    expect(updated.emailVerifiedAt).toEqual(new Date('2026-07-15T10:00:00.000Z'));
    expect(updated.credentialVersion).toBe(1);
    expect(prisma.events).toEqual([
      expect.objectContaining({ action: 'auth.password_requested', targetUserId: 'u-active' }),
      expect.objectContaining({
        action: 'auth.password_enrolled',
        targetUserId: 'u-active',
        actorUserId: 'u-active',
        actorKind: 'self',
      }),
    ]);
    expect(JSON.stringify(prisma.events)).not.toContain('123456');
    expect(JSON.stringify(prisma.events)).not.toContain(verified.setupToken);
    expect(JSON.stringify(prisma.events)).not.toContain('a long internal passphrase');
    await expect(service.complete({ setupToken: verified.setupToken, password: 'another long passphrase' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rolls back token consumption when access is removed after verification', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });
    const verified = await service.verify({ requestId, code: delivered[0]!.code });
    prisma.users[0]!.memberships = [{ status: 'removed' }];

    await expect(service.complete({ setupToken: verified.setupToken, password: 'a long internal passphrase' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.challenges[0]?.consumedAt).toBeNull();
    expect(prisma.users[0]?.passwordHash).toBeNull();
    expect(prisma.events).toEqual([
      expect.objectContaining({ action: 'auth.password_requested', targetUserId: 'u-active' }),
    ]);
  });
});
