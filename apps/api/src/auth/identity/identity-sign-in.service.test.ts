/**
 * Redbracket ID A3 — break-glass while the issuer is unavailable: never a test account, the same bcrypt work on every
 * path (so the time taken does not tell who is an admin holding a PMC password, or how old its hash is), and one log
 * line per try.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import type { PrismaService } from '../../prisma.service';
import { IdentitySignInService, paddingCosts } from './identity-sign-in.service';

/** bcrypt work of the compares made since the last clear: 2^cost rounds each. */
const work = (calls: unknown[][]) => calls.reduce<number>((sum, call) => sum + 2 ** Number.parseInt(String(call[1]).slice(4, 6), 10), 0);

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
    expect(work(compare.mock.calls)).toBe(2 ** 12);
  });

  it('pads any cost below 12 to exactly the work of one cost-12 compare', () => {
    for (let cost = 4; cost <= 12; cost += 1) {
      expect(2 ** cost + paddingCosts(cost).reduce((sum, c) => sum + 2 ** c, 0)).toBe(2 ** 12);
    }
    expect(paddingCosts(13)).toEqual([]);
  });

  it('does the same bcrypt work for an unknown address, a non-admin, a legacy cost-10 admin and a cost-12 admin', async () => {
    process.env.IDENTITY_OIDC = '1';
    const legacy = await bcrypt.hash('local', 10);
    const modern = await bcrypt.hash('local', 12);
    const plain = { id: 'u1', email: 'a@x.in', passwordHash: legacy } as never;
    const old = { id: 'u2', email: 'b@x.in', passwordHash: legacy } as never;
    const fresh = { id: 'u3', email: 'c@x.in', passwordHash: modern } as never;
    vi.spyOn(OrgsParticipant.prototype, 'accountByAddress')
      .mockResolvedValueOnce(null).mockResolvedValueOnce(plain).mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValueOnce(fresh);
    vi.spyOn(OrgsParticipant.prototype, 'administersCompany').mockResolvedValueOnce(false).mockResolvedValue(true);
    const compare = vi.mocked(bcrypt.compare);
    const lines = vi.spyOn((IdentitySignInService.prototype as unknown as { line: () => void }), 'line');
    const service = new IdentitySignInService(prisma);
    const tries: Array<[string, string, boolean]> = [
      ['nobody@x.in', 'local', false], ['a@x.in', 'local', false], ['b@x.in', 'wrong', false], ['b@x.in', 'local', true], ['c@x.in', 'local', true],
    ];
    for (const [email, password, ok] of tries) {
      compare.mockClear();
      lines.mockClear();
      const outcome = service.login({ email, password }, '127.0.0.1');
      if (ok) await expect(outcome).resolves.toMatchObject({ fresh: false, breakGlass: true });
      else await expect(outcome).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(work(compare.mock.calls)).toBe(2 ** 12);
      // one line per try, naming why the issuer was not used and what break-glass decided
      expect(lines).toHaveBeenCalledTimes(1);
      expect((lines.mock.calls[0] as unknown[])[2]).toBe(ok ? 'settings incomplete; break-glass password accepted' : 'settings incomplete');
    }
  });
});
