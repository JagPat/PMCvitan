import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { bootstrapOrg, bootstrapSpecSchema, type BootstrapSpec } from '../../src/platform/org-bootstrap';

/**
 * Fresh start — `org:bootstrap` makes a company, its first project and its people from nothing, in one
 * transaction. A dry run leaves no row; a commit makes exactly the listed grants; a taken name or
 * address is refused before any write; the QA company lock holds (a QA company takes only qa.* accounts).
 */
describe('org:bootstrap — a company from nothing (live PG)', () => {
  let t: TestApp;
  const run = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
  const made: Array<{ orgId: string; projectId: string; userIds: string[] }> = [];

  const spec = (over: Partial<BootstrapSpec> = {}): BootstrapSpec =>
    bootstrapSpecSchema.parse({
      company: { name: `Bootstrap Co ${run}` },
      project: { name: `First project ${run}`, short: `First ${run}`, siteCode: 'FP-01' },
      people: [
        { name: 'Owner PMC', email: `boss.${run}@test.local`, companyRole: 'owner', projectRole: 'pmc' },
        { name: 'Owner only', email: `owner2.${run}@test.local`, companyRole: 'owner' },
        { name: 'Client', email: `client.${run}@test.local`, phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`, projectRole: 'client' },
      ],
      ...over,
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    for (const m of made) {
      await t.prisma.$transaction([
        t.prisma.orgMembership.deleteMany({ where: { orgId: m.orgId } }),
        t.prisma.membership.deleteMany({ where: { projectId: m.projectId } }),
        t.prisma.user.deleteMany({ where: { id: { in: m.userIds } } }),
        t.prisma.project.deleteMany({ where: { id: m.projectId } }),
        t.prisma.org.deleteMany({ where: { id: m.orgId } }),
      ]);
    }
    await t?.close();
  });

  it('a dry run writes nothing and says what a commit would make', async () => {
    const s = spec();
    const r = await bootstrapOrg(t.prisma, s, { commit: false });
    expect(r).toMatchObject({ ok: true, outcome: 'dry-run', refusals: [] });
    expect(r.people).toHaveLength(3);
    expect(await t.prisma.org.count({ where: { name: s.company.name } })).toBe(0);
    expect(await t.prisma.user.count({ where: { email: { in: [`boss.${run}@test.local`, `owner2.${run}@test.local`] } } })).toBe(0);
  });

  it('a commit makes the company, the project and exactly the listed grants, with no password', async () => {
    const r = await bootstrapOrg(t.prisma, spec(), { commit: true });
    expect(r).toMatchObject({ ok: true, outcome: 'committed' });
    const orgId = r.company!.id;
    const projectId = r.project!.id;
    made.push({ orgId, projectId, userIds: r.people.map((p) => p.id) });

    const project = await t.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project).toMatchObject({ orgId, archivedAt: null, timeZone: 'Asia/Kolkata' });
    expect(project.scheduleStartDate).not.toBeNull();
    // the project's event counter exists, so the first command on it can append events
    expect(await t.prisma.projectEventStream.count({ where: { projectId } })).toBe(1);

    const grants = await t.prisma.orgMembership.findMany({ where: { orgId }, include: { user: true }, orderBy: { createdAt: 'asc' } });
    expect(grants.map((g) => [g.user.email, g.role])).toEqual([[`boss.${run}@test.local`, 'owner'], [`owner2.${run}@test.local`, 'owner']]);
    const members = await t.prisma.membership.findMany({ where: { projectId }, include: { user: true } });
    expect(members.map((m) => [m.user.name, m.role, m.status]).sort()).toEqual([['Client', 'client', 'active'], ['Owner PMC', 'pmc', 'active']]);
    const users = await t.prisma.user.findMany({ where: { id: { in: r.people.map((p) => p.id) } } });
    expect(users.every((u) => u.passwordHash === null && u.projectId === projectId)).toBe(true);
    // an owner who does not run the project never has a home role that reads as pmc
    expect(users.find((u) => u.email === `owner2.${run}@test.local`)?.role).toBe('contractor');
  });

  it('refuses, before any write, a company name or an address that is already taken', async () => {
    const before = await t.prisma.org.count();
    const r = await bootstrapOrg(t.prisma, spec({ company: { name: `Bootstrap Co ${run}`, qaOnly: false } }), { commit: true });
    expect(r).toMatchObject({ ok: false, outcome: 'refused' });
    expect(r.refusals).toContain(`a company named "Bootstrap Co ${run}" already exists`);
    expect(r.refusals).toContain(`already has an account: boss.${run}@test.local`);
    expect(await t.prisma.org.count()).toBe(before);
  });

  it('makes a QA company of qa.* accounts, and refuses a non-QA account in it with nothing written', async () => {
    const qa = (who: string) => `qa.${who}${run}@vitan.in`;
    const qaSpec = spec({
      company: { name: `QA Co ${run}`, qaOnly: true },
      people: [
        { name: 'QA Pmc', email: qa('pmc'), companyRole: 'owner', projectRole: 'pmc' },
        { name: 'QA Client', email: qa('client'), projectRole: 'client' },
      ],
    });
    const r = await bootstrapOrg(t.prisma, qaSpec, { commit: true });
    expect(r).toMatchObject({ ok: true, outcome: 'committed', company: { qaOnly: true } });
    made.push({ orgId: r.company!.id, projectId: r.project!.id, userIds: r.people.map((p) => p.id) });

    const mixed = spec({
      company: { name: `QA Mixed ${run}`, qaOnly: true },
      people: [{ name: 'Not QA', email: `notqa.${run}@test.local`, companyRole: 'owner', projectRole: 'pmc' }],
    });
    await expect(bootstrapOrg(t.prisma, mixed, { commit: true })).rejects.toThrow(/qa lock/);
    expect(await t.prisma.org.count({ where: { name: `QA Mixed ${run}` } })).toBe(0);
    expect(await t.prisma.user.count({ where: { email: `notqa.${run}@test.local` } })).toBe(0);
  });

  it('refuses a spec with no owner, a person with no role or no email, or a discipline off a consultant', () => {
    const base = { company: { name: 'X' }, project: { name: 'P', short: 'P', siteCode: 'S' } };
    expect(bootstrapSpecSchema.safeParse({ ...base, people: [{ name: 'A', email: 'a@test.local', projectRole: 'pmc' }] }).success).toBe(false);
    expect(bootstrapSpecSchema.safeParse({ ...base, people: [{ name: 'A', email: 'a@test.local', companyRole: 'owner' }, { name: 'B', email: 'b@test.local' }] }).success).toBe(false);
    // an email is required (password set-up and, until SMS is live, the phone code go to it)
    expect(bootstrapSpecSchema.safeParse({ ...base, people: [{ name: 'A', phone: '9876543210', companyRole: 'owner' }] }).success).toBe(false);
    // a discipline only on a consultant
    expect(bootstrapSpecSchema.safeParse({ ...base, people: [{ name: 'A', email: 'a@test.local', companyRole: 'owner', projectRole: 'pmc', discipline: 'architect' }] }).success).toBe(false);
  });
});
