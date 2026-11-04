import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import { PasswordCredentialsService, tokenScope } from './password-credentials.service';

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
    if (typeof where.consumedAt === 'object' && where.consumedAt !== null && 'gt' in where.consumedAt && (!row.consumedAt || row.consumedAt <= (where.consumedAt as { gt: Date }).gt)) return false;
    if (where.setupTokenExpiresAt === null && row.setupTokenExpiresAt !== null) return false;
    if (typeof where.setupTokenHash === 'object' && where.setupTokenHash !== null && 'not' in where.setupTokenHash && row.setupTokenHash === null) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.purpose !== undefined && row.purpose !== where.purpose) return false;
    if (typeof where.setupTokenHash === 'string' && row.setupTokenHash !== where.setupTokenHash) return false;
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
    // Redbracket ID A3: no account here was set aside by a first Redbracket ID sign-in
    identityRetirement: { count: vi.fn(async () => 0) },
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
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = challenges.find((candidate) => matches(candidate, where));
        return row ? { id: row.id } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = challenges.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('missing challenge');
        if (data.setupTokenHash === null) row.setupTokenHash = null;
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const selected = challenges.filter((row) => matches(row, where));
        for (const row of selected) {
          if (data.consumedAt instanceof Date) row.consumedAt = data.consumedAt;
          if (data.verifiedAt instanceof Date) row.verifiedAt = data.verifiedAt;
          if (typeof data.setupTokenHash === 'string' || data.setupTokenHash === null) row.setupTokenHash = data.setupTokenHash;
          if (data.setupTokenExpiresAt instanceof Date || data.setupTokenExpiresAt === null) row.setupTokenExpiresAt = data.setupTokenExpiresAt;
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
    // the claim reads the lease start from the database clock (A4a)
    $queryRaw: vi.fn(async () => [{ at: new Date() }]),
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

  it('a delivery failure logs its own path, keeps the same public response, and keeps its code working', async () => {
    const { service, delivered } = make([activeUser()]);
    const email = (service as unknown as { email: { sendPasswordCredentialCode: ReturnType<typeof vi.fn> } }).email;
    // #806 unit B1: an SMTP timeout after the provider took the mail. The code arrives although the send threw.
    email.sendPasswordCredentialCode.mockImplementationOnce(async (address: string, code: string) => {
      delivered.push({ email: address, code });
      throw new Error('smtp timeout');
    });
    const logs: string[] = [];
    const logger = (service as unknown as { log: { log: (m: string) => void; error: (m: string) => void } }).log;
    vi.spyOn(logger, 'log').mockImplementation((m: string) => { logs.push(m); });
    vi.spyOn(logger, 'error').mockImplementation((m: string) => { logs.push(m); });

    const res = await service.request({ email: 'member@example.com' });
    expect(res).toEqual({ accepted: true, requestId: expect.any(String) });
    expect(logs).toEqual([expect.stringContaining(`delivery failed for challenge ${res.requestId}`)]);
    await expect(service.verify({ requestId: res.requestId, code: delivered[0]!.code }, false))
      .resolves.toEqual({ setupToken: expect.any(String), expiresInSeconds: 600, sharedPassword: false });
  });

  it('limits wrong OTP attempts, expires challenges, and never returns an application session', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.verify({ requestId, code: '000000' }, false)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.verify({ requestId, code: delivered[0]!.code }, false)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.challenges[0]?.consumedAt).toBeInstanceOf(Date);

    const second = await service.request({ email: 'member@example.com' });
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await expect(service.verify({ requestId: second.requestId, code: delivered[1]!.code }, false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses a one-time setup token to hash the password, increment the version, and write a secret-free audit', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });
    const verified = await service.verify({ requestId, code: delivered[0]!.code }, false);

    expect(verified).toEqual({ setupToken: expect.any(String), expiresInSeconds: 600, sharedPassword: false });
    expect(verified).not.toHaveProperty('token');
    expect(prisma.challenges[0]?.setupTokenHash).not.toBe(verified.setupToken);

    const updated = await service.complete({
      setupToken: verified.setupToken,
      password: 'a long internal passphrase',
    });

    expect(await bcrypt.compare('a long internal passphrase', updated.passwordHash!)).toBe(true);
    expect(updated.emailVerifiedAt).toEqual(new Date('2026-07-15T10:00:00.000Z'));
    expect(updated.credentialVersion).toBe(1);
    // the claim spends the code and clears its expiry: the durable mark an invitation-email correction refuses on
    expect(prisma.challenges[0]).toMatchObject({ consumedAt: expect.any(Date), verifiedAt: expect.any(Date), setupTokenExpiresAt: null, setupTokenHash: null });
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

  it('binds the setup token to the password scope the screen was told: a completion under the other scope refuses it, spending nothing', async () => {
    // Codex 4464315045: the switch changed (or another pod answered) between verify and complete
    const shared = make([activeUser()]);
    const first = await shared.service.request({ email: 'member@example.com' });
    const toldShared = await shared.service.verify({ requestId: first.requestId, code: shared.delivered[0]!.code }, true);
    expect(toldShared.sharedPassword).toBe(true);
    await expect(shared.service.complete({ setupToken: toldShared.setupToken, password: 'a long internal passphrase' })).rejects.toBeInstanceOf(BadRequestException);
    expect(shared.prisma.challenges[0]).toMatchObject({ consumedAt: null });
    expect(shared.prisma.users[0]?.passwordHash).toBeNull();

    const own = make([activeUser()]);
    const second = await own.service.request({ email: 'member@example.com' });
    const toldOwn = await own.service.verify({ requestId: second.requestId, code: own.delivered[0]!.code }, false);
    // refused before the issuer is reached: the identity service is never touched
    await expect(own.service.completeThroughIssuer({ setupToken: toldOwn.setupToken, password: 'a long internal passphrase' }, {} as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(own.prisma.challenges[0]).toMatchObject({ consumedAt: null });
    expect(tokenScope('a'.repeat(43))).toBe('unscoped');
    expect(tokenScope(toldShared.setupToken)).toBe('shared');
    expect(tokenScope(toldOwn.setupToken)).toBe('pmc');
    expect(tokenScope('x.' + 'a'.repeat(43))).toBe('other');
  });

  it('stores a scoped token under a hash the release before scopes cannot look up, so an old pod cannot complete it', async () => {
    // Codex 4471261534 on #1341: an old pod finds a setup token by sha256(token) and completes it under its own switch
    const plain = (token: string) => createHash('sha256').update(token).digest('hex');
    for (const shared of [true, false]) {
      const { service, prisma, delivered } = make([activeUser()]);
      const { requestId } = await service.request({ email: 'member@example.com' });
      const verified = await service.verify({ requestId, code: delivered[0]!.code }, shared);
      expect(tokenScope(verified.setupToken)).toBe(shared ? 'shared' : 'pmc');
      expect(prisma.challenges[0]?.setupTokenHash).not.toBe(plain(verified.setupToken));
      // the old release's lookup finds nothing: its generic refusal, the code unspent
      expect(prisma.challenges.find((row) => row.setupTokenHash === plain(verified.setupToken))).toBeUndefined();
      // while this release still completes it under its own scope
      if (!shared) {
        const updated = await service.complete({ setupToken: verified.setupToken, password: 'a long internal passphrase' });
        expect(await bcrypt.compare('a long internal passphrase', updated.passwordHash!)).toBe(true);
      }
    }
    // an unscoped token keeps the plain hash both releases read
    const { service } = make([activeUser()]);
    expect((service as unknown as { tokenHash(t: string): string }).tokenHash('a'.repeat(43))).toBe(plain('a'.repeat(43)));
  });

  it('takes a token with no scope (issued by the release before scopes) under either switch, as that release did', async () => {
    // Codex 4470403440 on #1341: a person who verified on the old release just before the rollout is not refused mid-setup
    const unscoped = 'a'.repeat(43);
    const own = make([activeUser()]);
    const first = await own.service.request({ email: 'member@example.com' });
    await own.service.verify({ requestId: first.requestId, code: own.delivered[0]!.code }, false);
    own.prisma.challenges[0]!.setupTokenHash = (own.service as unknown as { tokenHash(t: string): string }).tokenHash(unscoped);
    const updated = await own.service.complete({ setupToken: unscoped, password: 'a long internal passphrase' });
    expect(await bcrypt.compare('a long internal passphrase', updated.passwordHash!)).toBe(true);

    const shared = make([activeUser()]);
    const second = await shared.service.request({ email: 'member@example.com' });
    await shared.service.verify({ requestId: second.requestId, code: shared.delivered[0]!.code }, true);
    shared.prisma.challenges[0]!.setupTokenHash = (shared.service as unknown as { tokenHash(t: string): string }).tokenHash(unscoped);
    // past the scope check and the challenge read: the completion reaches the issuer write
    const reached = new Error('reached the issuer');
    const identity = { setPassword: vi.fn(async () => { throw reached; }) };
    await expect(shared.service.completeThroughIssuer({ setupToken: unscoped, password: 'a long internal passphrase' }, identity as never)).rejects.toBe(reached);
    expect(identity.setPassword).toHaveBeenCalledTimes(1);
  });

  it('rolls back token consumption when access is removed after verification', async () => {
    const { service, prisma, delivered } = make([activeUser()]);
    const { requestId } = await service.request({ email: 'member@example.com' });
    const verified = await service.verify({ requestId, code: delivered[0]!.code }, false);
    prisma.users[0]!.memberships = [{ status: 'removed' }];

    await expect(service.complete({ setupToken: verified.setupToken, password: 'a long internal passphrase' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.challenges[0]?.consumedAt).toBeNull();
    expect(prisma.users[0]?.passwordHash).toBeNull();
    expect(prisma.events).toEqual([
      expect.objectContaining({ action: 'auth.password_requested', targetUserId: 'u-active' }),
    ]);
  });
});
