/**
 * Redbracket ID A3 — break-glass while the issuer is unavailable: never a test account, and one bcrypt compare on
 * every path (so the time taken does not tell who is an admin holding a PMC password).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import type { PrismaService } from '../../prisma.service';
import { IdentitySignInService } from './identity-sign-in.service';

vi.mock('bcryptjs', async (load) => {
  const actual = await load<typeof import('bcryptjs')>();
  const compare = vi.fn(actual.compare);
  return { ...actual, compare, default: { ...actual, compare } };
});

const prisma = {
  signInAttempt: {
    create: async () => ({ id: 1n }),
    count: async () => 1,
    deleteMany: async () => ({ count: 0 }),
  },
} as unknown as PrismaService;

describe('IdentitySignInService break-glass (switch on, settings incomplete = unavailable)', () => {
  const saved = process.env.IDENTITY_OIDC;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(bcrypt.compare).mockClear();
    if (saved === undefined) delete process.env.IDENTITY_OIDC;
    else process.env.IDENTITY_OIDC = saved;
  });

  it('refuses a test account address before looking it up, whatever it holds', async () => {
    process.env.IDENTITY_OIDC = '1';
    const lookup = vi.spyOn(OrgsParticipant.prototype, 'accountByAddress');
    const compare = vi.mocked(bcrypt.compare);
    compare.mockClear();
    const service = new IdentitySignInService(prisma);
    await expect(service.login({ email: 'qa.owner@vitan.in', password: 'any' }, '127.0.0.1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(lookup).not.toHaveBeenCalled();
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('runs one bcrypt compare for an unknown address, a non-admin and an admin alike', async () => {
    process.env.IDENTITY_OIDC = '1';
    const hash = await bcrypt.hash('local', 4);
    const account = { id: 'u1', email: 'a@x.in', passwordHash: hash } as never;
    vi.spyOn(OrgsParticipant.prototype, 'accountByAddress').mockResolvedValueOnce(null).mockResolvedValueOnce(account).mockResolvedValueOnce(account);
    vi.spyOn(OrgsParticipant.prototype, 'administersCompany').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const compare = vi.mocked(bcrypt.compare);
    compare.mockClear();
    const service = new IdentitySignInService(prisma);
    for (const email of ['nobody@x.in', 'a@x.in']) {
      await expect(service.login({ email, password: 'local' }, '127.0.0.1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    await expect(service.login({ email: 'a@x.in', password: 'local' }, '127.0.0.1')).resolves.toMatchObject({ account: { id: 'u1' }, fresh: false });
    expect(compare).toHaveBeenCalledTimes(3);
    // the non-admin's compare ran against the stand-in hash, not theirs
    expect(compare.mock.calls[1]![1]).not.toBe(hash);
    expect(compare.mock.calls[2]![1]).toBe(hash);
  });
});
