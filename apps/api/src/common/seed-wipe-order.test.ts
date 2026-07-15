import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('seed wipe order', () => {
  it('deletes credential-security children before users', () => {
    const seed = readFileSync(new URL('../../prisma/seed.ts', import.meta.url), 'utf8');
    const userDelete = seed.indexOf('prisma.user.deleteMany()');

    expect(userDelete).toBeGreaterThan(-1);
    for (const child of ['passwordCredentialChallenge', 'securityAuditEvent']) {
      const childDelete = seed.indexOf(`prisma.${child}.deleteMany()`);
      expect(childDelete, `${child} cleanup is missing`).toBeGreaterThan(-1);
      expect(childDelete, `${child} must be deleted before User`).toBeLessThan(userDelete);
    }
  });
});
