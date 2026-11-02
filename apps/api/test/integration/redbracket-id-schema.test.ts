import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Redbracket ID A1: `20280203000000_redbracket_id_tables` adds "PlatformPersonLink" (which issuer person a PMC user is),
 * "SignInAttempt" (the per-email sign-in count, digests only) and "IdentityRetirement" (an older account switched off
 * on its email's first Redbracket ID sign-in) before any code uses them (notes/auth/redbracket-id/plan.md). This proves
 * the shapes PostgreSQL holds on every writer, the cascades with the user, the counts the rate limit will run, and
 * that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280203000000_redbracket_id_tables/migration.sql');
const ISSUER = 'https://id.vitan.in';
const hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Redbracket ID A1: the link, attempt and retirement tables (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const users: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(`DELETE FROM "SignInAttempt"`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "PlatformPersonLink"`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "IdentityRetirement"`);
    if (users.length) await t.prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  const newUser = async () => {
    const id = `rbid-${randomUUID()}`;
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'client', name: 'Link Test', email: `${id}@test.local` } });
    users.push(id);
    return id;
  };
  const link = (userId: string, subject: string, matchedOn = 'signup', issuer = ISSUER) =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "PlatformPersonLink" ("userId", "issuer", "subject", "matchedOn") VALUES ($1, $2, $3, $4)`,
      userId, issuer, subject, matchedOn);
  const retire = (userId: string, email: string, at = 'now()') =>
    t.prisma.$executeRawUnsafe(`INSERT INTO "IdentityRetirement" ("userId", "email", "retiredAt") VALUES ($1, $2, ${at})`, userId, email);
  const attempt = (kind: string, email: string, address: string, at = 'now()') =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "SignInAttempt" ("kind", "emailHash", "addressHash", "at") VALUES ($1, $2, $3, ${at})`,
      kind, email, address);

  it('spells every character class out, so a look-alike outside ASCII never passes under any collation', async () => {
    // a bracket range (`a-z`, `0-9`, `!-~`) follows the collation; each class lists its characters instead
    const defs = await t.prisma.$queryRawUnsafe<Array<{ name: string; def: string }>>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
        WHERE conname IN ('PlatformPersonLink_shape_check', 'SignInAttempt_shape_check', 'IdentityRetirement_shape_check')`);
    expect(defs).toHaveLength(3);
    for (const { name, def } of defs) expect([name, /a-z|A-Z|0-9|a-f|!-~|\[:/.test(def)]).toEqual([name, false]);
    // U+FF10 (fullwidth 0), U+00E9 (é), U+0430 (Cyrillic a), U+FF41 (fullwidth a), U+200B (zero-width space)
    const lookAlikes = ['\uff10', '\u00e9', '\u0430', '\uff41', '\u200b'];
    const u = await newUser();
    for (const c of lookAlikes) {
      await expect(link(u, `sub${c}`)).rejects.toThrow(/PlatformPersonLink_shape_check/);
      await expect(link(u, 's', 'signup', `https://id${c}.vitan.in`)).rejects.toThrow(/PlatformPersonLink_shape_check/);
      await expect(link(u, 's', 'signup', `https://id.vitan.in/realm${c}`)).rejects.toThrow(/PlatformPersonLink_shape_check/);
      await expect(link(u, 's', 'signup', `https://id.vitan.in:44${c}`)).rejects.toThrow(/PlatformPersonLink_shape_check/);
      await expect(attempt('sign-in', hex('a').slice(0, 63) + c, hex('b'))).rejects.toThrow(/SignInAttempt_shape_check/);
      await expect(retire(u, `a${c}@b.in`)).rejects.toThrow(/IdentityRetirement_shape_check/);
    }
    // every printable ASCII character is still a subject character, and nothing else is
    const printable = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join('');
    expect(await link(u, printable)).toBe(1);
  });

  it('links a user to an issuer person, by sign-up or by an accepted invite', async () => {
    expect(await link(await newUser(), '312345678901234567', 'signup')).toBe(1);
    expect(await link(await newUser(), '312345678901234568', 'invite')).toBe(1);
  });

  it('holds one person per user and one user per issuer person', async () => {
    const a = await newUser();
    const b = await newUser();
    await link(a, 'sub-1');
    await expect(link(a, 'sub-2')).rejects.toThrow(/23505|unique constraint/i);
    await expect(link(b, 'sub-1')).rejects.toThrow(/23505|unique constraint/i);
    // the same sub at another issuer is another person
    expect(await link(b, 'sub-1', 'signup', 'https://id.example.in')).toBe(1);
  });

  it('refuses an issuer spelled any other way, a subject that is not 1-255 printable ASCII, and another way of matching', async () => {
    const u = await newUser();
    for (const issuer of ['http://id.vitan.in', 'https://id.vitan.in/', 'https://ID.vitan.in', 'https://id.vitan.in\n',
      'https://id.vitan.in ', 'https:// ', 'https://id.vitan.in?x=1', 'https://id.vitan.in#f', 'https://u:p@id.vitan.in']) {
      await expect(link(u, 's', 'signup', issuer)).rejects.toThrow(/PlatformPersonLink_shape_check/);
    }
    for (const subject of ['', ' ', '\t', 'sub\n', ' sub', 'é', 'x'.repeat(256)]) {
      await expect(link(u, subject)).rejects.toThrow(/PlatformPersonLink_shape_check/);
    }
    // fresh join: an email match is never a way of linking
    await expect(link(u, 's', 'email')).rejects.toThrow(/PlatformPersonLink_shape_check/);
    await expect(link(u, 's', 'password')).rejects.toThrow(/PlatformPersonLink_shape_check/);
    await expect(link(u, 's', 'phone')).rejects.toThrow(/PlatformPersonLink_shape_check/);
    expect(await link(u, 'x'.repeat(255))).toBe(1);
    // a port and a path are one spelling too
    expect(await link(await newUser(), 's', 'signup', 'https://id.example.in:8443/realm/a')).toBe(1);
  });

  it('refuses a link to no user, and the link falls with its user', async () => {
    await expect(link('no-such-user', 'sub-x')).rejects.toThrow(/PlatformPersonLink_userId_fkey/);
    const u = await newUser();
    await link(u, 'sub-y');
    await t.prisma.user.delete({ where: { id: u } });
    users.splice(users.indexOf(u), 1);
    const left = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "PlatformPersonLink"`);
    expect(left[0]!.n).toBe(0);
  });

  it('holds nothing about the person but the user id and the issuer person', async () => {
    const columns = await t.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PlatformPersonLink' ORDER BY column_name`);
    expect(columns.map((c) => c.column_name)).toEqual(['createdAt', 'issuer', 'matchedOn', 'subject', 'userId']);
    const attempts = await t.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'SignInAttempt' ORDER BY column_name`);
    expect(attempts.map((c) => c.column_name)).toEqual(['addressHash', 'at', 'emailHash', 'id', 'kind']);
    const retired = await t.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'IdentityRetirement' ORDER BY column_name`);
    expect(retired.map((c) => c.column_name)).toEqual(['email', 'retiredAt', 'userId']);
  });

  it('records one switch-off per account, with the email it had, and refuses a blank email, no user or an infinite time', async () => {
    const u = await newUser();
    expect(await retire(u, 'jp@example.in')).toBe(1);
    await expect(retire(u, 'jp@example.in')).rejects.toThrow(/23505|unique constraint/i);
    const v = await newUser();
    for (const email of ['', ' ', 'jp', 'jp @example.in', 'x'.repeat(316) + '@a.in']) {
      await expect(retire(v, email)).rejects.toThrow(/IdentityRetirement_shape_check/);
    }
    await expect(retire(v, 'a@b.in', `'infinity'::timestamp`)).rejects.toThrow(/IdentityRetirement_shape_check/);
    await expect(retire('no-such-user', 'a@b.in')).rejects.toThrow(/IdentityRetirement_userId_fkey/);
    await t.prisma.user.delete({ where: { id: u } });
    users.splice(users.indexOf(u), 1);
    const left = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "IdentityRetirement"`);
    expect(left[0]!.n).toBe(0);
  });

  it('takes a sign-in or reset attempt as two 64-hex digests, and refuses anything else', async () => {
    const e = hex('jp@example.in');
    const a = hex('203.0.113.7');
    expect(await attempt('sign-in', e, a)).toBe(1);
    expect(await attempt('reset', e, a)).toBe(1);
    await expect(attempt('otp', e, a)).rejects.toThrow(/SignInAttempt_shape_check/);
    await expect(attempt('sign-in', 'jp@example.in', a)).rejects.toThrow(/SignInAttempt_shape_check/);
    await expect(attempt('sign-in', e, '203.0.113.7')).rejects.toThrow(/SignInAttempt_shape_check/);
    await expect(attempt('sign-in', e.toUpperCase(), a)).rejects.toThrow(/SignInAttempt_shape_check/);
    await expect(attempt('sign-in', e, a, `'infinity'::timestamp`)).rejects.toThrow(/SignInAttempt_shape_check/);
  });

  it('answers the rate limit’s two counts and the one-day clean-up from its indexes’ columns', async () => {
    const e = hex('qa.limit@example.in');
    const here = hex('203.0.113.7');
    const there = hex('198.51.100.9');
    for (let i = 0; i < 5; i++) await attempt('sign-in', e, here);
    await attempt('sign-in', e, there);
    await attempt('sign-in', e, here, `now() - interval '20 minutes'`);
    await attempt('sign-in', e, here, `now() - interval '2 days'`);
    const [counts] = await t.prisma.$queryRawUnsafe<Array<{ pair: number; email: number }>>(
      `SELECT count(*) FILTER (WHERE "addressHash" = $2 AND "at" > now() - interval '15 minutes')::int AS pair,
              count(*) FILTER (WHERE "at" > now() - interval '1 hour')::int AS email
         FROM "SignInAttempt" WHERE "emailHash" = $1`, e, here);
    expect(counts).toEqual({ pair: 5, email: 7 });
    expect(await t.prisma.$executeRawUnsafe(`DELETE FROM "SignInAttempt" WHERE "at" < now() - interval '1 day'`)).toBe(1);
    const indexes = await t.prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'SignInAttempt' ORDER BY indexname`);
    expect(indexes.map((i) => i.indexname)).toEqual(['SignInAttempt_at_idx', 'SignInAttempt_emailHash_at_idx', 'SignInAttempt_pkey']);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    const u = await newUser();
    await link(u, 'sub-keep');
    await attempt('reset', hex('a@b.in'), hex('203.0.113.1'));
    await retire(u, 'kept@example.in');
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    const constraints = await t.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid IN ('"PlatformPersonLink"'::regclass, '"SignInAttempt"'::regclass, '"IdentityRetirement"'::regclass) ORDER BY conname`);
    expect(constraints.map((c) => c.conname)).toEqual([
      'IdentityRetirement_pkey', 'IdentityRetirement_shape_check', 'IdentityRetirement_userId_fkey',
      'PlatformPersonLink_pkey', 'PlatformPersonLink_shape_check', 'PlatformPersonLink_userId_fkey',
      'SignInAttempt_pkey', 'SignInAttempt_shape_check',
    ]);
    const kept = await t.prisma.$queryRawUnsafe<Array<{ links: number; attempts: number; retired: number }>>(
      `SELECT (SELECT count(*) FROM "PlatformPersonLink")::int AS links, (SELECT count(*) FROM "SignInAttempt")::int AS attempts,
              (SELECT count(*) FROM "IdentityRetirement")::int AS retired`);
    expect(kept).toEqual([{ links: 1, attempts: 1, retired: 1 }]);
  });
});
