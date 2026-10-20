import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';

/**
 * #482 QA company lock (Jagrut, 20 Oct 2026: "Rebuild it" on the QA sign-in door card): `20280116000000_qa_company_lock`
 * adds "Org"."qaOnly" and the triggers that keep a QA-only company to QA accounts (Q1) and a QA account to QA-only
 * companies (Q2). No server code reads it yet; this proves what PostgreSQL refuses on every writer, that two writes
 * racing to break the rule run one after the other, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280116000000_qa_company_lock/migration.sql');

describe('#482 QA company lock (live PG)', () => {
  let t: TestApp;
  // a QA address is qa.<lowercase letters>@vitan.in, so the run's tag is letters only
  const run = [...randomBytes(8)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
  const orgs: string[] = [];
  const users: string[] = [];

  const raw = (sql: string, ...values: unknown[]) => t.prisma.$executeRawUnsafe(sql, ...values);
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });

  let n = 0;
  const company = async () => {
    const id = `qalock-org-${run}-${++n}`;
    orgs.push(id);
    await t.prisma.org.create({ data: { id, name: id, slug: id } });
    const pid = `qalock-proj-${run}-${n}`;
    await t.prisma.project.create({ data: {
      id: pid, orgId: id, name: pid, short: pid, descriptor: '', stage: 'Planning', siteCode: `QL${n}`,
      projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    return { orgId: id, projectId: pid };
  };
  /** a person whose landing project is `projectId` (which grants nothing by itself) */
  const person = async (projectId: string, qa: boolean) => {
    const id = `qalock-user-${run}-${++n}`;
    users.push(id);
    const email = qa ? `qa.${run}${String.fromCharCode(97 + (n % 26))}${'x'.repeat(n)}@vitan.in` : `${id}@test.local`;
    await t.prisma.user.create({ data: { id, projectId, role: 'pmc', name: id, email } });
    return id;
  };
  const joinOrg = (orgId: string, userId: string) => t.prisma.orgMembership.create({ data: { orgId, userId, role: 'member' } });
  const joinProject = (projectId: string, userId: string, status = 'active') =>
    t.prisma.membership.create({ data: { projectId, userId, role: 'engineer', status } });
  const mark = (orgId: string, qaOnly = true) => t.prisma.org.update({ where: { id: orgId }, data: { qaOnly } });
  /** rows the way they stood before this file: written with the lock's triggers off */
  const before = async (write: () => Promise<unknown>) => {
    for (const [table, trigger] of [['OrgMembership', 'OrgMembership_qa_lock'], ['Membership', 'Membership_qa_lock']]) {
      await raw(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
    try {
      await write();
    } finally {
      for (const [table, trigger] of [['OrgMembership', 'OrgMembership_qa_lock'], ['Membership', 'Membership_qa_lock']]) {
        await raw(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      }
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    if (t) {
      await t.prisma.membership.deleteMany({ where: { userId: { in: users } } });
      await t.prisma.orgMembership.deleteMany({ where: { userId: { in: users } } });
      await t.prisma.user.deleteMany({ where: { id: { in: users } } });
      await t.prisma.project.deleteMany({ where: { orgId: { in: orgs } } });
      await t.prisma.org.deleteMany({ where: { id: { in: orgs } } });
    }
    await t?.close();
  });

  it('every company starts unmarked, and a QA account cannot join an unmarked company or its projects (Q2)', async () => {
    const c = await company();
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: c.orgId } })).qaOnly).toBe(false);
    const qa = await person(c.projectId, true);
    await expect(joinOrg(c.orgId, qa)).rejects.toThrow(/is a QA account, and company .* is not QA-only/);
    await expect(joinProject(c.projectId, qa)).rejects.toThrow(/is a QA account/);
    await expect(joinProject(c.projectId, qa, 'invited')).rejects.toThrow(/is a QA account/);
    // a removed membership gives no reach, so it is never refused
    await joinProject(c.projectId, qa, 'removed');
    await expect(raw(`UPDATE "Membership" SET "status" = 'active' WHERE "userId" = $1`, qa)).rejects.toThrow(/is a QA account/);
    // a real person joins as before
    const real = await person(c.projectId, false);
    await joinOrg(c.orgId, real);
    await joinProject(c.projectId, real);
  });

  it('a company is marked only while its people are all QA accounts, and the QA company that exists today can be (Q1)', async () => {
    const c = await company();
    const qa1 = await person(c.projectId, true);
    const qa2 = await person(c.projectId, true);
    const real = await person(c.projectId, false);
    // the live QA company already holds its QA accounts, written before this file
    await before(async () => {
      await joinOrg(c.orgId, qa1);
      await joinProject(c.projectId, qa2);
      await joinProject(c.projectId, real);
    });
    await expect(mark(c.orgId)).rejects.toThrow(/is QA-only, and .* is not a QA account/);
    await raw(`UPDATE "Membership" SET "status" = 'removed' WHERE "userId" = $1`, real);
    await mark(c.orgId);
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: c.orgId } })).qaOnly).toBe(true);
    // and is never unmarked while it holds a QA account
    await expect(mark(c.orgId, false)).rejects.toThrow(/is a QA account, and company .* is not QA-only/);
  });

  it('a company is not marked while one of its QA accounts still belongs to an unmarked company, by either membership (Q2)', async () => {
    const c = await company();
    const other = await company();
    const qa1 = await person(c.projectId, true);
    const qa2 = await person(c.projectId, true);
    // rows from before this file: each QA account here also reaches an ordinary company
    await before(async () => {
      await joinOrg(c.orgId, qa1);
      await joinProject(c.projectId, qa2);
      await joinOrg(other.orgId, qa1);
      await joinProject(other.projectId, qa2, 'invited');
    });
    await expect(mark(c.orgId)).rejects.toThrow(new RegExp(`${qa1} is a QA account that still belongs to company ${other.orgId}, which is not QA-only`));
    await t.prisma.orgMembership.deleteMany({ where: { userId: qa1, orgId: other.orgId } });
    await expect(mark(c.orgId)).rejects.toThrow(new RegExp(`${qa2} is a QA account that still belongs to company ${other.orgId}`));
    await raw(`UPDATE "Membership" SET "status" = 'removed' WHERE "userId" = $1 AND "projectId" = $2`, qa2, other.projectId);
    await mark(c.orgId);
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: c.orgId } })).qaOnly).toBe(true);
  });

  it('a marked company takes no real person, as a company member or on any project, and a QA account joins it', async () => {
    const c = await company();
    await mark(c.orgId);
    const real = await person(c.projectId, false);
    const phoneOnly = `qalock-user-${run}-${++n}`;
    users.push(phoneOnly);
    await t.prisma.user.create({ data: { id: phoneOnly, projectId: c.projectId, role: 'engineer', name: phoneOnly, phone: `+91${Date.now() % 1e10}` } });
    await expect(joinOrg(c.orgId, real)).rejects.toThrow(/is QA-only, and .* is not a QA account/);
    await expect(joinProject(c.projectId, real)).rejects.toThrow(/is QA-only/);
    await expect(joinProject(c.projectId, real, 'invited')).rejects.toThrow(/is QA-only/);
    await expect(joinProject(c.projectId, phoneOnly)).rejects.toThrow(/is QA-only/);
    const qa = await person(c.projectId, true);
    await joinOrg(c.orgId, qa);
    await joinProject(c.projectId, qa);
    // nor can a membership be moved onto someone else (a project membership's person is frozen since phase 6-4b)
    await expect(raw(`UPDATE "Membership" SET "userId" = $1 WHERE "userId" = $2 AND "projectId" = $3`, real, qa, c.projectId)).rejects.toThrow(/identity is frozen/);
    await expect(raw(`UPDATE "OrgMembership" SET "userId" = $1 WHERE "userId" = $2`, real, qa)).rejects.toThrow(/is QA-only/);
  });

  it('an address cannot change to or from a QA address while its person belongs anywhere that would break the rule', async () => {
    const qaCo = await company();
    await mark(qaCo.orgId);
    const realCo = await company();
    const qa = await person(qaCo.projectId, true);
    await joinProject(qaCo.projectId, qa);
    await expect(raw(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `${qa}@test.local`, qa)).rejects.toThrow(/is QA-only, and .* is not a QA account/);
    await expect(raw(`UPDATE "User" SET "email" = NULL WHERE "id" = $1`, qa)).rejects.toThrow(/is QA-only/);
    const real = await person(realCo.projectId, false);
    await joinOrg(realCo.orgId, real);
    await expect(raw(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `qa.${run}zz@vitan.in`, real)).rejects.toThrow(/is a QA account, and company/);
    // a QA address keeps changing to another QA address, and a person who belongs nowhere changes freely
    await raw(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `qa.${run}yy@vitan.in`, qa);
    const loose = await person(realCo.projectId, false);
    await raw(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `qa.${run}ww@vitan.in`, loose);
    // the address is matched as stored: a capital letter is not a QA address
    await expect(raw(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `QA.${run}yy@vitan.in`, qa)).rejects.toThrow(/is QA-only/);
  });

  it('a project membership cannot be moved across the line even where phase 6-4b\'s freeze is missing (a db push baseline)', async () => {
    // a baseline replays this file but not 20270826's "Membership_t4b_identity_frozen", so the lock checks a re-key itself
    const qaCo = await company();
    await mark(qaCo.orgId);
    const realCo = await company();
    const qa = await person(qaCo.projectId, true);
    const real = await person(realCo.projectId, false);
    await joinProject(qaCo.projectId, qa);
    await joinProject(realCo.projectId, real);
    await raw(`ALTER TABLE "Membership" DISABLE TRIGGER "Membership_t4b_identity_frozen"`);
    try {
      await expect(raw(`UPDATE "Membership" SET "userId" = $1 WHERE "userId" = $2 AND "projectId" = $3`, real, qa, qaCo.projectId)).rejects.toThrow(/is QA-only, and .* is not a QA account/);
      await expect(raw(`UPDATE "Membership" SET "projectId" = $1 WHERE "userId" = $2`, realCo.projectId, qa)).rejects.toThrow(/is a QA account, and company .* is not QA-only/);
      await expect(raw(`UPDATE "Membership" SET "userId" = $1 WHERE "userId" = $2 AND "projectId" = $3`, qa, real, realCo.projectId)).rejects.toThrow(/is a QA account, and company/);
      await expect(raw(`UPDATE "Membership" SET "projectId" = $1 WHERE "userId" = $2`, qaCo.projectId, real)).rejects.toThrow(/is QA-only/);
    } finally {
      await raw(`ALTER TABLE "Membership" ENABLE TRIGGER "Membership_t4b_identity_frozen"`);
    }
    expect(await t.prisma.membership.count({ where: { userId: qa, projectId: qaCo.projectId } })).toBe(1);
    expect(await t.prisma.membership.count({ where: { userId: real, projectId: realCo.projectId } })).toBe(1);
  });

  it('a project never moves company, so a QA project cannot carry its people out or a real one in', async () => {
    // phase 6-4b already freezes "Project"."orgId"; this file relies on that rather than checking a move itself
    const qaCo = await company();
    await mark(qaCo.orgId);
    const realCo = await company();
    await expect(raw(`UPDATE "Project" SET "orgId" = $1 WHERE "id" = $2`, qaCo.orgId, realCo.projectId)).rejects.toThrow(/re-homing/);
    await expect(raw(`UPDATE "Project" SET "orgId" = $1 WHERE "id" = $2`, realCo.orgId, qaCo.projectId)).rejects.toThrow(/re-homing/);
  });

  /**
   * A deterministic race: `first` writes inside a transaction and then holds it open; `second` starts only after that
   * write, and the holder lets go only once `second` is seen waiting on a row lock in pg_stat_activity. Returns what
   * `second` threw (or null).
   */
  const race = async (first: (tx: Prisma.TransactionClient) => Promise<unknown>, second: () => Promise<unknown>, waitingOn: string) => {
    let written!: () => void;
    let release!: () => void;
    const wrote = new Promise<void>((r) => (written = r));
    const released = new Promise<void>((r) => (release = r));
    const holding = t.prisma.$transaction(async (tx) => {
      await first(tx);
      written();
      await released;
    }, { timeout: 30_000 });
    try {
      await Promise.race([wrote, holding]);
      const competing = second().then(() => null, (e: unknown) => e);
      for (let i = 0; ; i++) {
        const [{ c }] = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT COUNT(*)::int AS c FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, `%${waitingOn}%`);
        if (c > 0) break;
        if (i >= 400) throw new Error(`the second write never waited on a lock (${waitingOn})`);
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await holding;
      return await competing;
    } finally {
      release();
    }
  };

  it('marking a company while a real person is being added to it: the second write waits, then is refused', async () => {
    const c = await company();
    const real = await person(c.projectId, false);
    // the mark goes first and holds the company's row; the add waits on it, then sees the mark
    const refused = await race(
      (tx) => tx.org.update({ where: { id: c.orgId }, data: { qaOnly: true } }),
      () => t.prisma.membership.create({ data: { projectId: c.projectId, userId: real, role: 'engineer', status: 'active' } }),
      '"Membership"');
    expect(String(refused)).toMatch(/is QA-only/);
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: c.orgId } })).qaOnly).toBe(true);
    expect(await t.prisma.membership.count({ where: { userId: real } })).toBe(0);

    // the add goes first and holds the company FOR SHARE; the mark waits on it, then sees the person
    const d = await company();
    const real2 = await person(d.projectId, false);
    const refused2 = await race(
      (tx) => tx.membership.create({ data: { projectId: d.projectId, userId: real2, role: 'engineer', status: 'active' } }),
      () => t.prisma.org.update({ where: { id: d.orgId }, data: { qaOnly: true } }),
      '"Org"');
    expect(String(refused2)).toMatch(/is QA-only/);
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: d.orgId } })).qaOnly).toBe(false);
    expect(await t.prisma.membership.count({ where: { userId: real2, projectId: d.projectId, status: 'active' } })).toBe(1);
  });

  it('changing an address while that person is being added: the second write waits, then is refused', async () => {
    const c = await company();
    await mark(c.orgId);
    const qa = await person(c.projectId, true);
    const email = async (id: string) => (await t.prisma.user.findUniqueOrThrow({ where: { id } })).email;
    // the add holds the person FOR SHARE; the address change waits, then sees the membership
    const qaEmail = await email(qa);
    const refused = await race(
      (tx) => tx.membership.create({ data: { projectId: c.projectId, userId: qa, role: 'engineer', status: 'active' } }),
      () => raw(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `${qa}@test.local`, qa),
      '"User"');
    expect(String(refused)).toMatch(/is QA-only/);
    expect(await email(qa)).toBe(qaEmail);
    expect(await t.prisma.membership.count({ where: { userId: qa, projectId: c.projectId } })).toBe(1);

    // the address change holds the person's row; the add waits, then reads the new address
    const qa2 = await person(c.projectId, true);
    const refused2 = await race(
      (tx) => tx.$executeRawUnsafe(`UPDATE "User" SET "email" = $1 WHERE "id" = $2`, `${qa2}@test.local`, qa2),
      () => t.prisma.membership.create({ data: { projectId: c.projectId, userId: qa2, role: 'engineer', status: 'active' } }),
      '"Membership"');
    expect(String(refused2)).toMatch(/is QA-only/);
    expect(await email(qa2)).toBe(`${qa2}@test.local`);
    expect(await t.prisma.membership.count({ where: { userId: qa2 } })).toBe(0);
  });

  it('marking reads a QA account\'s other companies without a lock: it never waits, and refuses while any other membership is visible', async () => {
    // org_qa_lock holds only its own company's row (the UPDATE); the Q2 read of the person's other companies takes no
    // lock, so it can wait on nothing and adds no lock cycle. Each case below finishes while the other write is open.
    const holdOpen = async (write: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      let written!: () => void;
      let release!: () => void;
      const wrote = new Promise<void>((r) => (written = r));
      const released = new Promise<void>((r) => (release = r));
      const done = t.prisma.$transaction(async (tx) => {
        await write(tx);
        written();
        await released;
      }, { timeout: 30_000 });
      await Promise.race([wrote, done]);
      return { release: () => { release(); return done; } };
    };
    const qaOnly = async (orgId: string) => (await t.prisma.org.findUniqueOrThrow({ where: { id: orgId } })).qaOnly;

    // two companies sharing a QA account, marked at the same moment: each reads the other unmarked, so both refuse
    const a = await company();
    const b = await company();
    const shared = await person(a.projectId, true);
    await before(async () => {
      await joinOrg(a.orgId, shared);
      await joinProject(b.projectId, shared);
    });
    const both = await Promise.allSettled([mark(a.orgId), mark(b.orgId)]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect([await qaOnly(a.orgId), await qaOnly(b.orgId)]).toEqual([false, false]);

    // marking while the account is being removed from the other company: refused until the removal commits, then marked
    const removing = await holdOpen((tx) => tx.$executeRawUnsafe(
      `UPDATE "Membership" SET "status" = 'removed' WHERE "userId" = $1 AND "projectId" = $2`, shared, b.projectId));
    await expect(mark(a.orgId)).rejects.toThrow(/still belongs to company/);
    await removing.release();
    await mark(a.orgId);
    expect(await qaOnly(a.orgId)).toBe(true);

    // marking while the account is being added to another company: an unmarked one refuses the add whatever the mark does,
    // and a marked one is not read, so the mark goes through while the add is still open, and both hold once it commits
    const c = await company();
    const shared2 = await person(c.projectId, true);
    await before(() => joinOrg(c.orgId, shared2));
    const plain = await company();
    await expect(joinProject(plain.projectId, shared2)).rejects.toThrow(/is a QA account, and company/);
    const qaOther = await company();
    await mark(qaOther.orgId);
    const adding = await holdOpen((tx) => tx.membership.create({ data: { projectId: qaOther.projectId, userId: shared2, role: 'engineer', status: 'active' } }));
    await mark(c.orgId);
    await adding.release();
    expect([await qaOnly(c.orgId), await qaOnly(qaOther.orgId)]).toEqual([true, true]);
    expect(await t.prisma.membership.count({ where: { userId: shared2, projectId: qaOther.projectId, status: 'active' } })).toBe(1);
  });

  it('the file re-runs over itself and keeps every marked company and refusal', async () => {
    const c = await company();
    await mark(c.orgId);
    replay();
    replay();
    expect((await t.prisma.org.findUniqueOrThrow({ where: { id: c.orgId } })).qaOnly).toBe(true);
    const real = await person(c.projectId, false);
    await expect(joinProject(c.projectId, real)).rejects.toThrow(/is QA-only/);
    const triggers = await t.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%_qa_lock' `);
    expect(triggers.map((r) => r.tgname).sort()).toEqual(['Membership_qa_lock', 'OrgMembership_qa_lock', 'Org_qa_lock', 'User_qa_lock']);
  });
});
