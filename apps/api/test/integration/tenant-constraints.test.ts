import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Codex gate finding 4: node/phase/material relations were single-column FKs, so
 * a DIRECT database write could link one project's record to another project's
 * node, phase or decision. These constraints are now composite (projectId, ref)
 * — PostgreSQL itself rejects the forgery, even bypassing every service.
 */
describe('tenant constraints for node/phase/material references (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.activity.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.decision.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.phase.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  it('PostgreSQL rejects cross-project node, phase, parent and material-decision links (raw SQL)', async () => {
    const nodeA = await t.prisma.projectNode.create({ data: { id: 'it-tc-node-a', projectId: f.projectA.id, name: 'Zone A', kind: 'zone', publishedAt: new Date() } });
    const nodeB = await t.prisma.projectNode.create({ data: { id: 'it-tc-node-b', projectId: f.projectB.id, name: 'Zone B', kind: 'zone', publishedAt: new Date() } });
    const decA = await t.prisma.decision.create({ data: { id: 'IT-TC-DL-1', projectId: f.projectA.id, title: 'A decision', room: 'Living', status: 'pending', photoSwatch: 'tile', publishedAt: new Date() } });
    const decB = await t.prisma.decision.create({ data: { id: 'IT-TC-DL-2', projectId: f.projectB.id, title: 'B decision', room: 'Living', status: 'pending', photoSwatch: 'tile', publishedAt: new Date() } });
    const phaseB = await t.prisma.phase.create({ data: { id: 'it-tc-phase-b', projectId: f.projectB.id, name: 'B phase' } });
    const actA = await t.prisma.activity.create({ data: { id: 'IT-TC-ACT-1', projectId: f.projectA.id, name: 'A activity', zone: 'GF', plannedStart: 0, plannedEnd: 1, order: 1, gateMaterial: 'na', gateTeam: 'na', gateInspection: 'na' } });
    const logA = await t.prisma.dailyLog.create({ data: { id: 'it-tc-log-a', projectId: f.projectA.id, date: '01 Jul 2026' } });

    // an A decision may not sit on a B node
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "nodeId" = '${nodeB.id}' WHERE "id" = '${decA.id}'`),
    ).rejects.toThrow(/foreign key|constraint/i);

    // an A activity may not join a B phase
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Activity" SET "phaseId" = '${phaseB.id}' WHERE "id" = '${actA.id}'`),
    ).rejects.toThrow(/foreign key|constraint/i);

    // an A node may not hang under a B parent
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ProjectNode" ("id", "projectId", "parentId", "name", "kind", "order", "createdAt") VALUES ('it-tc-forged-child', '${f.projectA.id}', '${nodeB.id}', 'Forged', 'room', 0, now())`,
      ),
    ).rejects.toThrow(/foreign key|constraint/i);

    // an A material (owned by A's daily log) may not claim a B decision or B node
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "SiteMaterial" ("id", "projectId", "dailyLogId", "decisionId", "name", "qty", "zone", "matched", "swatch", "photo", "order") VALUES ('it-tc-forged-mat', '${f.projectA.id}', '${logA.id}', '${decB.id}', 'Forged', '1', 'Z', true, 'tile', false, 0)`,
      ),
    ).rejects.toThrow(/foreign key|constraint/i);
    // …and it may not even claim to BE project B's while sitting on A's log
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "SiteMaterial" ("id", "projectId", "dailyLogId", "name", "qty", "zone", "matched", "swatch", "photo", "order") VALUES ('it-tc-forged-mat2', '${f.projectB.id}', '${logA.id}', 'Forged', '1', 'Z', true, 'tile', false, 0)`,
      ),
    ).rejects.toThrow(/foreign key|constraint/i);

    // control: the same links WITHIN one project stay fully allowed
    await t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "nodeId" = '${nodeA.id}' WHERE "id" = '${decA.id}'`);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "SiteMaterial" ("id", "projectId", "dailyLogId", "decisionId", "nodeId", "name", "qty", "zone", "matched", "swatch", "photo", "order") VALUES ('it-tc-ok-mat', '${f.projectA.id}', '${logA.id}', '${decA.id}', '${nodeA.id}', 'OK', '1', 'Z', true, 'tile', false, 0)`,
    );
    const ok = await t.prisma.siteMaterial.findUnique({ where: { id: 'it-tc-ok-mat' } });
    expect(ok?.projectId).toBe(f.projectA.id);
  });

  it('deleting a node unlinks every referencing record in-transaction (service-owned, NO ACTION FKs)', async () => {
    const node = await t.prisma.projectNode.create({ data: { id: 'it-tc-node-del', projectId: f.projectA.id, name: 'Doomed zone', kind: 'zone', publishedAt: new Date() } });
    const act = await t.prisma.activity.create({ data: { id: 'IT-TC-ACT-2', projectId: f.projectA.id, name: 'Filed work', zone: 'GF', plannedStart: 0, plannedEnd: 1, order: 2, gateMaterial: 'na', gateTeam: 'na', gateInspection: 'na', nodeId: node.id } });
    const media = await t.prisma.media.create({ data: { id: 'it-tc-media-1', projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('x'), sizeBytes: 1, uploadedBy: 'pmc', nodeId: node.id } });

    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await request(t.app.getHttpServer())
      .delete(`/projects/${f.projectA.id}/nodes/${node.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act.id } })).nodeId).toBeNull();
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: media.id } })).nodeId).toBeNull();
    expect(await t.prisma.projectNode.findUnique({ where: { id: node.id } })).toBeNull();
  });
});
