import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { PhasesService } from '../../src/activities/phases.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { CompaniesService } from '../../src/orgs/companies.service';
import { OrgsService } from '../../src/orgs/orgs.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * A delete that lost a race to another delete of the same row answers its route's own 404, never a 500 (nor, for an
 * activity, a 409 that says it has linked records). Each route reads the row before its transaction; the other delete
 * commits between that read and this one's row delete, which finds nothing (Prisma P2025). Forced here: the read is
 * wrapped once to run the real other delete right after it. Nothing of the losing delete is kept: no audit row, no
 * event, and no command receipt for its key, so the key stays free (platform/commands.ts).
 *
 * Reproduce-first: on 9e644157 the phase, override, company and org-member cases are 500 (P2025) and the activity case
 * is 409.
 */
describe('a delete that lost a race to another delete is the route\'s 404 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const p = () => f.projectA.id;
  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: p() }) as AuthUser;
  const extraMember = () => `${p()}-race-orgmember`;

  /** The next `findUnique` on `delegate` naming `matches` runs `other` (the delete that wins) after its own read. */
  const loseRaceTo = (delegate: object, matches: (where: Record<string, unknown>) => boolean, other: () => Promise<unknown>) => {
    const d = delegate as { findUnique: (a: { where: Record<string, unknown> }) => Promise<unknown> };
    const real = d.findUnique.bind(d);
    let fired = false;
    d.findUnique = async (a) => {
      const row = await real(a);
      if (!fired && matches(a.where)) { fired = true; await other(); }
      return row;
    };
    return { restore: () => { d.findUnique = real; }, fired: () => fired };
  };
  const receipts = (key: string) => t.prisma.commandExecution.count({ where: { idempotencyKey: key } });
  const audits = (action: string, entityId: string) => t.prisma.auditLog.count({ where: { projectId: p(), action, entityId } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.user.create({ data: { id: extraMember(), projectId: p(), role: 'pmc', name: 'Org member', email: `${extraMember()}@test.local` } });
  });
  afterAll(async () => {
    await t?.prisma.orgMembership.deleteMany({ where: { userId: extraMember() } }).catch(() => undefined);
    await t?.prisma.user.deleteMany({ where: { id: extraMember() } }).catch(() => undefined);
    await f?.cleanup().catch(() => undefined);
    await t?.close();
  });

  it('a phase: the loser is 404 "Phase not found", keyed or not, with no receipt or audit of its own', async () => {
    const phases = t.app.get(PhasesService);
    for (const keyed of [false, true]) {
      const id = (await t.prisma.phase.create({ data: { projectId: p(), name: `race-${run}-${keyed}` } })).id;
      const [win, lose] = [`race-win-${randomUUID()}`, `race-lose-${randomUUID()}`];
      const race = loseRaceTo(t.prisma.phase, (w) => w.id === id, () => phases.remove(p(), id, pmc(), keyed ? win : undefined));
      try {
        await expect(phases.remove(p(), id, pmc(), keyed ? lose : undefined)).rejects.toMatchObject({ status: 404, message: 'Phase not found' });
        expect(race.fired()).toBe(true);
      } finally { race.restore(); }
      expect(await audits('phase.delete', id)).toBe(1);
      if (keyed) expect([await receipts(win), await receipts(lose)]).toEqual([1, 0]);
    }
  });

  it('an activity: the loser is 404, not the 409 that says it has linked records, and its unlink rolls back', async () => {
    const activities = t.app.get(ActivitiesService);
    for (const keyed of [false, true]) {
      const id = `${p()}-race-act-${run}-${keyed}`;
      await t.prisma.activity.create({ data: { id, projectId: p(), name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
      const [win, lose] = [`race-win-${randomUUID()}`, `race-lose-${randomUUID()}`];
      const race = loseRaceTo(t.prisma.activity, (w) => w.id === id, () => activities.remove(p(), id, pmc(), keyed ? win : undefined));
      try {
        await expect(activities.remove(p(), id, pmc(), keyed ? lose : undefined)).rejects.toMatchObject({ status: 404, message: `Activity ${id} not found` });
        expect(race.fired()).toBe(true);
      } finally { race.restore(); }
      expect(await audits('activity.delete', id)).toBe(1);
      expect(await t.prisma.domainEvent.count({ where: { projectId: p(), eventType: 'activity.deleted', entityId: id } })).toBe(1);
      if (keyed) expect([await receipts(win), await receipts(lose)]).toEqual([1, 0]);
    }
  });

  it('a gate override: the loser of two revokes is 404', async () => {
    const activities = t.app.get(ActivitiesService);
    const activityId = `${p()}-race-ovr-act-${run}`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: p(), name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
    try {
      for (const keyed of [false, true]) {
        const id = (await t.prisma.gateOverride.create({ data: { projectId: p(), activityId, gate: 'material', state: 'ok', reason: 'race', actorId: f.memberUser.id, actorName: 'PMC', expiresAt: new Date(Date.now() + 864e5) } })).id;
        const [win, lose] = [`race-win-${randomUUID()}`, `race-lose-${randomUUID()}`];
        const race = loseRaceTo(t.prisma.gateOverride, (w) => w.id === id, () => activities.revokeOverride(p(), activityId, id, pmc(), keyed ? win : undefined));
        try {
          await expect(activities.revokeOverride(p(), activityId, id, pmc(), keyed ? lose : undefined)).rejects.toMatchObject({ status: 404, message: `Override ${id} not found` });
          expect(race.fired()).toBe(true);
        } finally { race.restore(); }
        expect(await t.prisma.auditLog.count({ where: { projectId: p(), action: 'activity.override_revoke', entityId: activityId, payload: { path: ['overrideId'], equals: id } } })).toBe(1);
        if (keyed) expect([await receipts(win), await receipts(lose)]).toEqual([1, 0]);
      }
    } finally {
      await t.prisma.activity.deleteMany({ where: { id: activityId } });
    }
  });

  it('a company: the loser of two removals is 404 "Company not found on this project"', async () => {
    const companies = t.app.get(CompaniesService);
    const { id } = await companies.add(p(), pmc(), { name: `Race Structural ${run}`, kind: 'structural' } as never);
    const race = loseRaceTo(t.prisma.projectCompany, (w) => w.id === id, () => companies.remove(p(), pmc(), id));
    try {
      await expect(companies.remove(p(), pmc(), id)).rejects.toMatchObject({ status: 404, message: 'Company not found on this project' });
      expect(race.fired()).toBe(true);
    } finally { race.restore(); }
    expect(await t.prisma.projectCompany.count({ where: { id } })).toBe(0);
  });

  it('an org member: the loser of two removals is 404 "Not a member of this org"', async () => {
    const orgs = t.app.get(OrgsService);
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: extraMember(), role: 'member' } });
    const race = loseRaceTo(t.prisma.orgMembership, (w) => (w.orgId_userId as { userId?: string } | undefined)?.userId === extraMember(),
      () => orgs.removeOrgMember(f.orgA.id, f.ownerUser.id, extraMember()));
    try {
      await expect(orgs.removeOrgMember(f.orgA.id, f.ownerUser.id, extraMember())).rejects.toMatchObject({ status: 404, message: 'Not a member of this org' });
      expect(race.fired()).toBe(true);
    } finally { race.restore(); }
    expect(await t.prisma.orgMembership.count({ where: { userId: extraMember() } })).toBe(0);
  });
});
