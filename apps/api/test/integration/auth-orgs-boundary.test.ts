import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { orgsManifest } from '../../src/orgs/orgs.manifest';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { AuthService } from '../../src/auth/auth.service';
import { PasswordCredentialsService } from '../../src/auth/password-credentials.service';
import { PhoneSignInService } from '../../src/auth/phone-sign-in.service';
import { GoogleAuthService } from '../../src/auth/google.service';
import { EmailService } from '../../src/platform/email.service';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 auth → orgs boundary (the reads #1020's round 3 left in auth). Auth owns no tables; the accounts, projects,
 * memberships and company roles every sign-in channel reads are the orgs module's, so auth asks `OrgsParticipant` and
 * never reads them itself. The harness is #1020's round-3 one, widened: it wraps the `prisma` of all three auth services
 * and every transaction they open, and records each call on an orgs-owned model (the manifest's own list), each public
 * raw statement, and each read of another table that pulls an orgs row in through `include`/`select`, with the first
 * source line that asked. Writes the boundary waives (`boundary-waivers.ts`) stay in auth; nothing else may.
 */
describe('#482 auth reads orgs-owned rows only through the orgs participant (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let auth: AuthService;
  let passwords: PasswordCredentialsService;
  let phones: PhoneSignInService;
  const passwordCodes = new Map<string, string>();
  const phoneCodes = new Map<string, string>();
  const run = randomUUID().slice(0, 8);
  const ids = { removed: `it-removed-${run}`, archived: `it-proj-archived-${run}` };
  const memberPhone = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const otherPhone = `97${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const PASSWORD = 'correct horse battery staple';

  const ORGS_MODELS = new Set<string>(orgsManifest.ownsModels);
  const RAW = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);
  /** relation names on other modules' tables that reach an orgs-owned row */
  const ORGS_RELATIONS = new Set(['user', 'users', 'project', 'org', 'membership', 'memberships', 'orgMembership', 'orgMemberships', 'workerDevice']);
  /** the writes `boundary-waivers.ts` lets auth make on orgs tables, by the file that makes them */
  const WAIVED = [/^user\.create <- .*\/src\/auth\/auth\.service\.ts/, /^membership\.create <- .*\/src\/auth\/auth\.service\.ts/, /^workerDevice\.create <- .*\/src\/auth\/auth\.service\.ts/, /^user\.update <- .*\/src\/auth\/password-credentials\.service\.ts/];

  const asked: string[] = [];
  const caller = () => ((new Error().stack ?? '').split('\n').find((line) => line.includes('/src/')) ?? '(no source frame)').trim();
  const reachesOrgs = (args: unknown): string | null => {
    const a = args as { include?: Record<string, unknown>; select?: Record<string, unknown> } | undefined;
    for (const key of [...Object.keys(a?.include ?? {}), ...Object.keys(a?.select ?? {})]) {
      if (ORGS_RELATIONS.has(key) && (a?.include?.[key] || (a?.select?.[key] && typeof a.select[key] === 'object'))) return key;
    }
    return null;
  };
  const delegate = (model: string, target: object): object => new Proxy(target, {
    get(d, method, receiver) {
      const fn = Reflect.get(d, method, receiver);
      if (typeof method !== 'string' || typeof fn !== 'function') return fn;
      return (...args: unknown[]) => {
        if (ORGS_MODELS.has(model)) asked.push(`${model}.${method} <- ${caller()}`);
        else {
          const via = reachesOrgs(args[0]);
          if (via) asked.push(`${model}.${method} include ${via} <- ${caller()}`);
        }
        return (fn as (...a: unknown[]) => unknown).apply(d, args);
      };
    },
  });
  const watch = <T extends object>(db: T): T => new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return value;
      if (RAW.has(prop)) asked.push(`${prop} <- ${caller()}`);
      if (prop === '$transaction') {
        const begin = value as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
        return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, opts?: unknown) => begin.call(target, (tx: Prisma.TransactionClient) => fn(watch(tx)), opts);
      }
      if (!prop.startsWith('$') && !prop.startsWith('_') && value && typeof value === 'object' && 'findUnique' in (value as object)) return delegate(prop, value as object);
      return value;
    },
  });

  /** Run `act` with every auth service's database handle watched; return what it asked, from where. */
  async function observe(act: () => Promise<unknown>): Promise<string[]> {
    const services = [auth, passwords, phones] as unknown as Array<{ prisma: object }>;
    const own = services.map((s) => s.prisma);
    asked.length = 0;
    services.forEach((s, i) => { s.prisma = watch(own[i]); });
    try {
      await act();
    } finally {
      services.forEach((s, i) => { s.prisma = own[i]; });
    }
    return [...asked];
  }
  /** Calls made by auth itself: anything not from the orgs module, except the waived writes and the advisory
   *  locks of `src/common/` (`pg_advisory_xact_lock`, which read no table). */
  const fromAuth = (seen: string[]) => seen.filter((a) => !a.includes('/src/orgs/') && !WAIVED.some((w) => w.test(a)) && !(/^\$(execute|query)Raw/.test(a) && a.includes('/src/common/')));

  beforeAll(async () => {
    t = await createTestApp({
      capturePasswordCode: (email, code) => passwordCodes.set(email, code),
      capturePhoneCode: (email, code) => phoneCodes.set(email, code),
    });
    f = await createTwoProjectFixture(t.prisma);
    auth = t.app.get(AuthService, { strict: false });
    passwords = t.app.get(PasswordCredentialsService, { strict: false });
    phones = t.app.get(PhoneSignInService, { strict: false });
    // the member signs in by password and by an emailed phone code; the other tenant's PMC by an SMS code
    await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { phone: memberPhone, passwordHash: await bcrypt.hash(PASSWORD, 4), emailVerifiedAt: new Date() } });
    await t.prisma.user.update({ where: { id: f.otherUser.id }, data: { phone: otherPhone } });
    // the agreement fixture: a removed member, and an archived project of org A the member still holds a membership on
    await t.prisma.user.create({ data: { id: ids.removed, projectId: f.projectA.id, role: 'pmc', name: 'Removed', email: `${ids.removed}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: ids.removed, role: 'pmc', status: 'removed' } });
    await t.prisma.project.create({
      data: {
        id: ids.archived, orgId: f.orgA.id, name: `Archived ${run}`, short: 'Arch', descriptor: '', stage: 'Planning', siteCode: 'ARCH',
        projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0, archivedAt: new Date(),
      },
    });
    await t.prisma.membership.create({ data: { projectId: ids.archived, userId: f.memberUser.id, role: 'engineer', status: 'active' } });
  });

  afterAll(async () => {
    await t?.prisma.$transaction([
      t.prisma.workerDevice.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } }),
      t.prisma.securityAuditEvent.deleteMany({ where: { targetUserId: ids.removed } }),
      t.prisma.membership.deleteMany({ where: { OR: [{ projectId: ids.archived }, { userId: ids.removed }] } }),
      t.prisma.user.deleteMany({ where: { id: ids.removed } }),
      t.prisma.project.deleteMany({ where: { id: ids.archived } }),
    ]);
    await f?.cleanup();
    await t?.close();
  });

  it('password sign-in reads the account through the participant', async () => {
    const seen = await observe(async () => {
      await expect(auth.login({ email: `${f.memberUser.id}@test.local`, password: PASSWORD })).resolves.toMatchObject({ projectId: f.projectA.id });
    });
    expect(seen.some((a) => a.startsWith('user.'))).toBe(true);
    expect(fromAuth(seen)).toEqual([]);
  });

  it('an emailed phone code: the request, its eligibility check and the redemption read the account through the participant', async () => {
    const email = `${f.memberUser.id}@test.local`;
    const seen = await observe(async () => {
      await expect(auth.requestOtp({ phone: memberPhone, projectId: f.projectA.id, acceptEmailCode: true })).resolves.toMatchObject({ channel: 'email' });
      const code = phoneCodes.get(email);
      expect(code).toBeTruthy();
      await expect(auth.verifyOtp({ phone: memberPhone, code: code!, projectId: f.projectA.id })).resolves.toMatchObject({ projectId: f.projectA.id });
    });
    expect(seen.some((a) => a.startsWith('user.'))).toBe(true);
    expect(fromAuth(seen)).toEqual([]);
  });

  it('an SMS code signs an existing account in by its number through the participant', async () => {
    const seen = await observe(async () => {
      const sent = await auth.requestOtp({ phone: otherPhone, projectId: f.projectB.id });
      expect(sent.devCode).toBeTruthy();
      await expect(auth.verifyOtp({ phone: otherPhone, code: sent.devCode!, projectId: f.projectB.id })).resolves.toMatchObject({ projectId: f.projectB.id });
    });
    expect(seen.some((a) => a.startsWith('user.'))).toBe(true);
    expect(fromAuth(seen)).toEqual([]);
  });

  it('Google and email-code sign-ins find the account by email through the participant', async () => {
    const email = `${f.ownerUser.id}@test.local`;
    const google = t.app.get(GoogleAuthService, { strict: false });
    const mail = t.app.get(EmailService, { strict: false });
    const verify = vi.spyOn(google, 'verify').mockResolvedValue({ email, emailVerified: true, name: 'Owner' } as Awaited<ReturnType<GoogleAuthService['verify']>>);
    const code = vi.spyOn(mail, 'verifyOtp').mockResolvedValue(true);
    try {
      const seen = await observe(async () => {
        await expect(auth.googleSignIn({ idToken: 'x', projectId: f.projectA.id })).resolves.toMatchObject({ role: 'pmc' });
        await expect(auth.verifyEmailOtp({ email, code: '1234', projectId: f.projectA.id })).resolves.toMatchObject({ role: 'pmc' });
      });
      expect(seen.some((a) => a.startsWith('user.'))).toBe(true);
      expect(fromAuth(seen)).toEqual([]);
    } finally {
      verify.mockRestore();
      code.mockRestore();
    }
  });

  it('a worker token checks its project through the participant; the device row is the waived write', async () => {
    const seen = await observe(async () => {
      await expect(auth.workerToken({ projectId: f.projectA.id, name: 'Mason', trade: 'masonry' } as Parameters<AuthService['workerToken']>[0])).resolves.toMatchObject({ role: 'worker' });
    });
    expect(seen.some((a) => a.startsWith('project.'))).toBe(true);
    expect(seen.some((a) => a.startsWith('workerDevice.create'))).toBe(true);
    expect(fromAuth(seen)).toEqual([]);
  });

  it('the project list and the project switch, and the switch\'s last-project stamp, go through the participant', async () => {
    const seen = await observe(async () => {
      await auth.listMemberships(f.ownerUser.id);
      await expect(auth.switchProject(f.ownerUser.id, f.projectA.id)).resolves.toMatchObject({ role: 'pmc' });
      await expect(auth.switchProject(f.memberUser.id, ids.archived)).rejects.toThrow('archived');
    });
    expect(seen.some((a) => a.startsWith('membership.'))).toBe(true);
    expect(seen.some((a) => a.startsWith('user.update'))).toBe(true);
    expect(fromAuth(seen)).toEqual([]);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } })).lastProjectId).toBe(f.projectA.id);
  });

  it('a password setup reads the account and its eligibility through the participant; only the credential write stays in auth', async () => {
    const email = `${f.clientUser.id}@test.local`;
    const seen = await observe(async () => {
      const { requestId } = await passwords.request({ email });
      const code = passwordCodes.get(email);
      expect(code).toBeTruthy();
      const { setupToken } = await passwords.verify({ requestId, code: code! });
      const user = await passwords.complete({ setupToken, password: PASSWORD });
      await expect(auth.signInUser(user)).resolves.toMatchObject({ projectId: f.projectA.id });
    });
    expect(seen.some((a) => a.startsWith('user.update <- ') && a.includes('password-credentials'))).toBe(true);
    expect(fromAuth(seen)).toEqual([]);
    // the audit row still tells an enrolment from a reset, now from the account the participant read under the lock
    // (the challenge no longer includes its user): no password before, so an enrolment; a second setup is a reset
    expect(await t.prisma.securityAuditEvent.count({ where: { targetUserId: f.clientUser.id, action: 'auth.password_enrolled' } })).toBe(1);
    const again = await passwords.request({ email });
    const { setupToken } = await passwords.verify({ requestId: again.requestId, code: passwordCodes.get(email)! });
    await passwords.complete({ setupToken, password: `${PASSWORD} again` });
    expect(await t.prisma.securityAuditEvent.count({ where: { targetUserId: f.clientUser.id, action: 'auth.password_reset' } })).toBe(1);
  });

  it('a password completion reads the account after the credential lock and before it writes the credential', async () => {
    const email = `${f.clientUser.id}@test.local`;
    const { requestId } = await passwords.request({ email });
    const { setupToken } = await passwords.verify({ requestId, code: passwordCodes.get(email)! });
    const seen = await observe(() => passwords.complete({ setupToken, password: `${PASSWORD} ordered` }));
    const at = (pattern: RegExp) => seen.findIndex((a) => pattern.test(a));
    const lock = at(/^\$executeRaw <- .*\/src\/common\/credential-lock\.ts/);
    const read = at(/^user\.findUnique <- .*\/src\/orgs\/orgs\.participant\.ts/);
    const write = at(/^user\.update <- .*\/src\/auth\/password-credentials\.service\.ts/);
    expect([lock, read, write].every((i) => i >= 0)).toBe(true);
    expect(lock).toBeLessThan(read);
    expect(read).toBeLessThan(write);
  });

  it('the dev-only role pick reads its account only through orgs.devAccount', async () => {
    const seen = await observe(async () => {
      await expect(auth.session({ role: 'pmc', projectId: f.projectA.id })).resolves.toMatchObject({ projectId: f.projectA.id });
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a.startsWith('user.findFirst <- ') && a.includes('/src/orgs/orgs.participant.ts'))).toBe(true);
  });

  it('the project list agrees with the access rule on every project, for a member, a company owner, a removed member and a stranger', async () => {
    const orgs = new OrgsParticipant();
    const projects = [f.projectA.id, f.projectB.id, ids.archived];
    for (const userId of [f.memberUser.id, f.ownerUser.id, ids.removed, f.strangerUser.id]) {
      const listed = new Map((await auth.listMemberships(userId)).map((p) => [p.projectId, p.role]));
      for (const projectId of projects) {
        const role = await orgs.projectRole(t.prisma, userId, projectId);
        // an archived project is never listed, and the switch refuses it before the rule is asked
        const expected = projectId === ids.archived ? undefined : (role ?? undefined);
        expect({ userId, projectId, role: listed.get(projectId) }).toEqual({ userId, projectId, role: expected });
      }
    }
    // the archived project really does carry a grant the list hides
    expect(await orgs.projectRole(t.prisma, f.memberUser.id, ids.archived)).toBe('engineer');
    expect(await orgs.projectRole(t.prisma, f.ownerUser.id, f.projectA.id)).toBe('pmc');
    expect(await orgs.projectRole(t.prisma, ids.removed, f.projectA.id)).toBeNull();
  });
});
