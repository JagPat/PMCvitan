import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { STALE_ROLE_MESSAGE } from '../../src/platform/actor-envelope';
import { OrgsService } from '../../src/orgs/orgs.service';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d-iii / R0a-2 — `emitEvent` refuses a human actor whose role does not stand on the
 * project (Decision 2), so a direct caller owes it a REAL standing. This is the tripwire for that
 * obligation: every file under `test/`, `prisma/seed.ts` and `scripts/` that calls `emitEvent(`
 * directly is pinned below with the shape of the actor it writes as. A new direct caller fails
 * here until someone classifies it, and the classification is what the reviewer reads.
 *
 *  - `system`         — a `system` actor: no pair is owed or written.
 *  - `member`         — a human whose role is a membership the fixture gives them (`memberUser`, pmc).
 *  - `org-owner-pmc`  — the fixture's membership-less org owner acting as `pmc` (the windowed arm).
 *  - `mixed`          — more than one of the above, each stated in the file.
 */
const PINNED: Array<[file: string, shape: 'system' | 'member' | 'org-owner-pmc' | 'mixed']> = [
  ['test/integration/activities-projection.test.ts', 'system'],
  ['test/integration/daily-log-isolation.test.ts', 'org-owner-pmc'],
  ['test/integration/daily-log-projection.test.ts', 'org-owner-pmc'],
  ['test/integration/decisions-projection.test.ts', 'org-owner-pmc'],
  ['test/integration/drawings-isolation.test.ts', 'system'],
  ['test/integration/drawings-projection.test.ts', 'system'],
  ['test/integration/event-envelope.test.ts', 'member'],
  ['test/integration/inspections-projection.test.ts', 'system'],
  ['test/integration/outbox-operations.test.ts', 'org-owner-pmc'],
  ['test/integration/outbox-reliability.test.ts', 'org-owner-pmc'],
  ['test/integration/outbox-scanner.test.ts', 'org-owner-pmc'],
  ['test/integration/outbox.test.ts', 'org-owner-pmc'],
  ['test/integration/phase5-t7bia-money-invalidation.test.ts', 'member'],
  ['test/integration/phase6-t4a-withdraw.test.ts', 'member'],
  ['test/integration/phase6-t4d-ii-a1-actor-envelope.test.ts', 'mixed'],
  ['test/integration/phase6-t4d-ii-a6d-delivery-seals.test.ts', 'member'],
  ['test/integration/projection.test.ts', 'org-owner-pmc'],
];

const API = resolve(__dirname, '../..');
const SELF = 'test/integration/phase6-t4d-iii-r0a2-emit-event-writers.test.ts';

const walk = (dir: string): string[] => {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((name) => {
    if (name === 'node_modules') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
};

/** A line that calls `emitEvent(` as code — not a comment line that mentions it. */
const callsEmitEvent = (text: string) =>
  text.split('\n').some((line) => /\bemitEvent\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));

describe('4d-iii / R0a-2 — emitEvent writers (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let orgs: OrgsService;
  const made: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    orgs = t.app.get(OrgsService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    if (made.length) await t.prisma.project.deleteMany({ where: { id: { in: made } } });
    await f?.cleanup();
    await t?.close();
  });

  it('every direct emitEvent( caller under test/, prisma/seed.ts and scripts/ is classified, sorted and pinned', () => {
    const files = [
      ...walk(join(API, 'test')),
      ...walk(join(API, 'scripts')),
      join(API, 'prisma', 'seed.ts'),
    ].filter((p) => /\.(ts|mts|mjs|js)$/.test(p));
    const found = files
      .filter((p) => { try { return callsEmitEvent(readFileSync(p, 'utf8')); } catch { return false; } })
      .map((p) => relative(API, p).split('\\').join('/'))
      .filter((p) => p !== SELF)
      .sort();
    const pinned = PINNED.map(([file]) => file);
    expect(pinned, 'the pinned list is sorted').toEqual([...pinned].sort());
    expect(found, 'a direct emitEvent( caller was added or removed: classify it in PINNED').toEqual(pinned);
  });

  it('emitEvent refuses a human actor without standing (403) and writes nothing', async () => {
    const entityId = `R0A2-${randomUUID()}`;
    const emit = (actorId: string, actorRole: string) => t.prisma.$transaction((tx) => emitEvent(tx, {
      projectId: f.projectA.id, actor: { actorId, actorRole, actorKind: 'human' }, eventType: 'project.updated',
      entityType: 'Project', entityId, effectKey: 'project.updated', dispatch: {},
    }));
    // a stranger with no standing, a member in a role they do not hold, an empty id, an org role that is no project role
    for (const [id, role] of [[f.strangerUser.id, 'pmc'], [f.clientUser.id, 'pmc'], ['', 'pmc'], [f.ownerUser.id, 'owner']] as const) {
      await expect(emit(id, role), `${id || '(empty)'} as ${role}`).rejects.toMatchObject({ status: 403, message: STALE_ROLE_MESSAGE });
    }
    expect(await t.prisma.domainEvent.count({ where: { entityId } })).toBe(0);
    // and the same call as a member in the role they hold is written, with the pair
    const ok = await emit(f.memberUser.id, 'pmc');
    expect(await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId: ok.eventId }, select: { actorRole: true } })).toEqual({ actorRole: 'pmc' });
  });

  it('an org owner updating, archiving and restoring a project records actorRole pmc', async () => {
    const id = `it-r0a2-${Date.now() % 1e6}`;
    made.push(id);
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'R', descriptor: '', stage: 'x', siteCode: 'R', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await orgs.updateProject(f.orgA.id, f.ownerUser.id, id, { stage: 'y' });
    await orgs.deleteProject(f.orgA.id, f.ownerUser.id, id);
    await orgs.restoreProject(f.orgA.id, f.ownerUser.id, id);
    for (const eventType of ['project.updated', 'project.archived', 'project.restored']) {
      const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: id, eventType }, select: { actorId: true, actorRole: true, actorName: true } });
      expect(ev, eventType).toMatchObject({ actorId: f.ownerUser.id, actorRole: 'pmc' });
      expect(ev.actorName, eventType).toBeTruthy();
    }
  });

  it('an ordinary org MEMBER who is the project PMC can update it, recorded as the pmc they hold (not the org role)', async () => {
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.memberUser.id, role: 'member' } });
    await orgs.updateProject(f.orgA.id, f.memberUser.id, f.projectA.id, { stage: 'z' });
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, eventType: 'project.updated', actorId: f.memberUser.id }, select: { actorRole: true } });
    expect(ev).toEqual({ actorRole: 'pmc' });
  });
});
