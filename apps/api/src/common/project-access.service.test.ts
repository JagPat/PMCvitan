import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma.service';
import type { AuthUser } from './auth';
import { ProjectAccessService } from './project-access.service';

const named = (credentialVersion?: number): AuthUser => ({
  sub: 'u1', role: 'pmc', projectId: 'p1', credentialVersion,
});

describe('ProjectAccessService credential versions', () => {
  afterEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('accepts a matching current version and interprets a legacy missing claim as zero', async () => {
    const findUnique = vi.fn(async () => ({ credentialVersion: 0 }));
    const service = new ProjectAccessService({ user: { findUnique } } as unknown as PrismaService);
    await expect(service.assertCredentialVersion(named())).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it('rejects an older token after a password setup or reset increments the version', async () => {
    const service = new ProjectAccessService({ user: { findUnique: async () => ({ credentialVersion: 2 }) } } as unknown as PrismaService);
    await expect(service.assertCredentialVersion(named(1))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not query User for worker/device tokens or non-production synthetic dev tokens', async () => {
    const findUnique = vi.fn();
    const service = new ProjectAccessService({ user: { findUnique } } as unknown as PrismaService);
    await expect(service.assertCredentialVersion({ ...named(), sub: 'worker-1', role: 'worker', worker: true })).resolves.toBeUndefined();
    await expect(service.assertCredentialVersion({ ...named(), sub: 'dev-pmc' })).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not permit the synthetic dev bypass in production', async () => {
    process.env.NODE_ENV = 'production';
    const service = new ProjectAccessService({ user: { findUnique: async () => null } } as unknown as PrismaService);
    await expect(service.assertCredentialVersion({ ...named(), sub: 'dev-pmc' })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
