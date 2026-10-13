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
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (typeof where.id === 'object' && where.id !== null && 'not' in where.id && row.id === (where.id as { not: string }).not) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.purpose !== undefined && row.purpose !== where.purpose) return false;
    if (where.setupTokenHash !== undefined && row.setupTokenHash !== where.setupTokenHash) return false;
    if (where.attempts !== undefined && typeof where.attempts === 'number' && row.attempts !== where.attempts) return false;
    if (typeof where.attempts === 'object' && where.attempts !== null && 'lt' in where.attempts && row.attempts >= (where.attempts as { lt: number }).lt) return false;
    if (typeof where.attempts === 'object' && where.attempts !== null && 'gte' in where.attempts && row.attempts < (where.attempts as { gte: number }).gte) return false;
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
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        challenges
          .filter((row) => matches(row, where))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, take)
          .map((row) => ({ ...row }))),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => challenges.filter((row) => matches(row, where)).length),
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
    $executeRaw: vi.fn(async () => 1),
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

  /**
   * #482 (12 Oct 2026): the owner's reset "did not arrive" and nothing on the server said why. The public response is
   * the same for every path (no account enumeration), so the SERVER log is the only place to tell them apart. Each
   * path now logs once, keyed by the public requestId, and never by the email address.
   */
  it('logs which path a request took, keyed by requestId and never by email, with the same public response', async () => {
    const { service, delivered } = make([
      activeUser(),
      activeUser({ id: 'u-removed', email: 'removed@example.com', memberships: [{ status: 'removed' }] }),
    ]);
    const logs: string[] = [];
    const logger = (service as unknown as { log: { log: (m: string) => void; error: (m: string) => void } }).log;
    vi.spyOn(logger, 'log').mockImplementation((m: string) => { logs.push(m); });
    vi.spyOn(logger, 'error').mockImplementation((m: string) => { logs.push(m); });

    const sent = await service.request({ email: 'member@example.com' });
    const unknown = await service.request({ email: 'unknown@example.com' });
    const removed = await service.request({ email: 'removed@example.com' });

    expect(delivered).toHaveLength(1);
    expect(logs).toEqual([
      expect.stringContaining(`${sent.requestId}: code handed to the mail provider`),
      expect.stringContaining(`${unknown.requestId}: no eligible account; nothing sent`),
      expect.stringContaining(`${removed.requestId}: no eligible account; nothing sent`),
    ]);
    for (const line of logs) expect(line).not.toMatch(/@/);
  });

  it('a delivery failure logs its own path and keeps the same public response', async () => {
    const { service } = make([activeUser()]);
    const email = (service as unknown as { email: { sendPasswordCredentialCode: ReturnType<typeof vi.fn> } }).email;
    email.sendPasswordCredentialCode.mockRejectedValueOnce(new Error('smtp down'));
    const logs: string[] = [];
    const logger = (service as unknown as { log: { log: (m: string) => void; error: (m: string) => void } }).log;
    vi.spyOn(logger, 'log').mockImplementation((m: string) => { logs.push(m); });
    vi.spyOn(logger, 'error').mockImplementation((m: string) => { logs.push(m); });

    const res = await service.request({ email: 'member@example.com' });
    expect(res).toEqual({ accepted: true, requestId: expect.any(String) });
    expect(logs).toEqual([expect.stringContaining(`delivery failed for challenge ${res.requestId}`)]);
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

  /**
   * #806 unit B: an ambiguous send (a timeout after the provider may have accepted the mail) or a slow mailbox can
   * deliver an older code after a newer one was requested. Any of the user's newest live codes verifies, under the
   * held challenge's attempt cap, and a successful verification retires every other live code.
   */
  it('accepts a late or out-of-order code from the same user, then retires the rest', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const email = (service as unknown as { email: { sendPasswordCredentialCode: ReturnType<typeof vi.fn> } }).email;
    email.sendPasswordCredentialCode.mockImplementationOnce(async (address: string, code: string) => {
      delivered.push({ email: address, code });
      throw new Error('timed out after the provider took the message');
    });
    const first = await service.request({ email: 'member@example.com' });
    vi.advanceTimersByTime(1_000);
    const second = await service.request({ email: 'member@example.com' });

    expect(prisma.challenges.map((row) => row.consumedAt)).toEqual([null, null]);
    const verified = await service.verify({ requestId: second.requestId, code: delivered[0]!.code });
    expect(verified).toEqual({ setupToken: expect.any(String), expiresInSeconds: 600 });
    expect(prisma.challenges.find((row) => row.id === second.requestId)?.verifiedAt).toBeInstanceOf(Date);
    expect(prisma.challenges.find((row) => row.id === first.requestId)?.consumedAt).toBeInstanceOf(Date);
    await expect(service.verify({ requestId: first.requestId, code: delivered[0]!.code })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only the held challenge and the three newest others can match, and wrong codes count against the held one', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await service.request({ email: 'member@example.com' })).requestId);
      vi.advanceTimersByTime(1_000);
    }
    // Held = the oldest; candidates = it plus the three newest others, so the second-oldest code is refused.
    await expect(service.verify({ requestId: ids[0]!, code: delivered[1]!.code })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.challenges.find((row) => row.id === ids[0])?.attempts).toBe(1);
    expect(prisma.challenges.find((row) => row.id === ids[1])?.attempts).toBe(0);
    await expect(service.verify({ requestId: ids[0]!, code: delivered[4]!.code })).resolves.toMatchObject({ expiresInSeconds: 600 });
  });

  it('never matches a locked, revoked or expired code, or another user\'s code', async () => {
    const { service, prisma, delivered } = make([
      activeUser(),
      activeUser({ id: 'u-other', email: 'other@example.com' }),
    ]);
    const locked = await service.request({ email: 'member@example.com' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.verify({ requestId: locked.requestId, code: '000000' })).rejects.toBeInstanceOf(BadRequestException);
    }
    const revoked = await service.request({ email: 'member@example.com' });
    prisma.challenges.find((row) => row.id === revoked.requestId)!.consumedAt = new Date();
    const other = await service.request({ email: 'other@example.com' });
    const held = await service.request({ email: 'member@example.com' });

    for (const code of [delivered[0]!.code, delivered[1]!.code, delivered[2]!.code]) {
      await expect(service.verify({ requestId: held.requestId, code })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(other.requestId).not.toBe(held.requestId);

    const late = await service.request({ email: 'member@example.com' });
    vi.advanceTimersByTime(10 * 60_000 + 1);
    const fresh = await service.request({ email: 'member@example.com' });
    await expect(service.verify({ requestId: fresh.requestId, code: delivered[4]!.code })).rejects.toBeInstanceOf(BadRequestException);
    expect(late.requestId).not.toBe(fresh.requestId);
  });

  it('counts every concurrent wrong guess, then locks the challenge', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });
    const guesses = await Promise.allSettled(Array.from({ length: 8 }, () => service.verify({ requestId, code: '000000' })));
    expect(guesses.every((guess) => guess.status === 'rejected')).toBe(true);
    expect(prisma.challenges[0]?.attempts).toBeGreaterThanOrEqual(5);
    expect(prisma.challenges[0]?.consumedAt).toBeInstanceOf(Date);
    await expect(service.verify({ requestId, code: delivered[0]!.code })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a new request still revokes an outstanding setup token', async () => {
    const { service, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });
    const verified = await service.verify({ requestId, code: delivered[0]!.code });
    await service.request({ email: 'member@example.com' });
    await expect(service.complete({ setupToken: verified.setupToken, password: 'a long internal passphrase' })).rejects.toBeInstanceOf(BadRequestException);
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
