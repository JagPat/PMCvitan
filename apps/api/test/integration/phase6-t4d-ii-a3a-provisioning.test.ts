import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { AuthService } from '../../src/auth/auth.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';

/**
 * Phase 6 task 4d unit 4d-ii-a / A3a — `ensure-accounts` refuses an `architect` roster entry BEFORE
 * its first write (plan §A.1, P28b), driven through the real script against live PostgreSQL.
 *
 * Before this unit the entry passed its `User` write and was refused at the membership by 4d-i's
 * reservation door, so the run failed with the account left behind. Now the whole roster is judged
 * first: the run fails naming the entry, and no `User`, `Membership` or org row is written for
 * any entry, the valid ones included.
 */
describe('4d-ii-a / A3a — ensure-accounts judges its roster before writing (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  const runEnsureAccounts = (env: Record<string, string>) => spawnSync(
    'npx', ['tsx', join(__dirname, '../../prisma/ensure-accounts.ts')],
    { cwd: join(__dirname, '../..'), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 },
  );

  it('an ACCOUNTS_JSON holding a pmc and an architect entry fails naming the entry, and writes nothing for either', async () => {
    const run = randomUUID().slice(0, 8);
    const pmcEmail = `a3a-pmc-${run}@test.local`;
    const architectEmail = `a3a-architect-${run}@test.local`;
    const orgSlug = `a3a-${run}`;

    const result = runEnsureAccounts({
      PROJECT_ID: f.projectA.id,
      ORG_SLUG: orgSlug,
      ACCOUNTS_JSON: JSON.stringify([
        { role: 'pmc', name: 'A3a PMC', email: pmcEmail },
        { role: 'architect', name: 'A3a Architect', email: architectEmail },
      ]),
    });

    expect(result.status, 'the run fails closed').not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/entry #2 \(A3a Architect, a3a-architect-[0-9a-f]+@test\.local\) has role "architect"/);
    // no partial write, for the refused entry OR the valid one before it
    expect(await t.prisma.user.count({ where: { email: { in: [pmcEmail, architectEmail] } } })).toBe(0);
    expect(await t.prisma.org.count({ where: { slug: orgSlug } }), 'not even the org upsert ran').toBe(0);
  }, 150_000);

  it('a roster with a non-string contact is refused before the org upsert, like every other malformed entry (#645 Codex 4114271547)', async () => {
    const run = randomUUID().slice(0, 8);
    const pmcEmail = `a3a-pmc-${run}@test.local`;
    const orgSlug = `a3a-${run}`;
    const result = runEnsureAccounts({
      PROJECT_ID: f.projectA.id,
      ORG_SLUG: orgSlug,
      ACCOUNTS_JSON: JSON.stringify([
        { role: 'pmc', name: 'A3a PMC', email: pmcEmail },
        { role: 'client', name: 'A3a Client', email: 7 },
      ]),
    });
    expect(result.status, 'the run fails closed').not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/entry #2 \(A3a Client\) has a non-string email \(7\)/);
    expect(await t.prisma.user.count({ where: { email: pmcEmail } })).toBe(0);
    expect(await t.prisma.org.count({ where: { slug: orgSlug } }), 'not even the org upsert ran').toBe(0);
  }, 150_000);

  it('sign-in provisioning waits for the project readiness key, then commits the account and its membership together', async () => {
    const auth = t.app.get(AuthService);
    const phone = `9${Date.now().toString().slice(-9)}`;
    const provision = () => (auth as unknown as {
      signInOrProvision(input: { phone: string; projectId: string; allowProvision: boolean }): Promise<unknown>;
    }).signInOrProvision({ phone, projectId: f.projectA.id, allowProvision: true });

    // Another transaction holds the key, as a command reading the project's standing does.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    const holder = t.prisma.$transaction(async (tx) => {
      await lockProjectReadiness(tx, f.projectA.id);
      holding();
      await released;
    }, { timeout: 20_000 });
    await held;

    let done = false;
    const provisioning = provision().finally(() => { done = true; });
    try {
      await new Promise((r) => setTimeout(r, 300));
      // RED before: the user and the membership were written with no key at all
      expect(done, 'provisioning waits for the key the holder has').toBe(false);
      expect(await t.prisma.user.count({ where: { phone } }), 'and nothing is visible while it waits').toBe(0);
      release();
      await holder;
      await provisioning;

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const membership = await t.prisma.membership.findUniqueOrThrow({
        where: { projectId_userId: { projectId: f.projectA.id, userId: user.id } },
      });
      expect(membership).toMatchObject({ role: 'engineer', status: 'active' });
    } finally {
      release();
      await holder.catch(() => undefined);
      await provisioning.catch(() => undefined);
      await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, user: { phone } } });
      await t.prisma.user.deleteMany({ where: { phone } });
    }
  });
});
