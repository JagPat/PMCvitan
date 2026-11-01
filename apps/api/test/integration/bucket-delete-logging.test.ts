import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';
import { ExternalEffectDispatcher } from '../../src/platform/outbox/external-effect-dispatcher';

/**
 * A stored file whose removal fails after its delete committed is an orphan in the bucket. The delete still succeeds
 * (a failed removal never fails it), and the failure is now one warn line naming the key and why it was being
 * removed, so it can be swept by hand (notes/bucket-delete-logging/plan.md). One case per module: a photo delete and
 * a drawing delete. Reproduce-first: on main the delete succeeds and nothing is logged.
 */
describe('a failed file removal after a delete is logged, and the delete still succeeds (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  const run = randomUUID().slice(0, 8);
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const http = () => request(t.app.getHttpServer());

  /** `remove` rejects as the bucket would; the warn lines are captured. */
  const failingBucket = () => {
    const storage = t.app.get(StorageService);
    const remove = vi.spyOn(storage, 'remove').mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    const warn = vi.spyOn((storage as unknown as { log: { warn: (m: string) => void } }).log, 'warn').mockImplementation(() => undefined);
    return { remove, warn, restore: () => { remove.mockRestore(); warn.mockRestore(); } };
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
  });
  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } }).catch(() => undefined);
    await t?.prisma.drawing.deleteMany({ where: { projectId: f.projectA.id } }).catch(() => undefined);
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await f?.cleanup().catch(() => undefined);
    await t?.close();
  });

  it('a photo delete: 200, the row gone, and one warn line for its file', async () => {
    const key = `${f.projectA.id}/progress/${run}.png`;
    const { id } = await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: f.memberUser.id, data: px, storageKey: key } });
    const bucket = failingBucket();
    try {
      const res = await http().delete(`/media/${id}`).set('Authorization', `Bearer ${pmc}`);
      expect(res.status).toBe(200);
      expect(await t.prisma.media.findUnique({ where: { id } })).toBeNull();
      expect(bucket.remove.mock.calls).toEqual([[key]]);
      expect(bucket.warn.mock.calls.map((c) => c[0])).toEqual([`could not delete ${key} (photo deleted): AccessDenied 403`]);
    } finally { bucket.restore(); }
  });

  it('a photo delete whose logger also throws still answers 200 and dispatches its events', async () => {
    const key = `${f.projectA.id}/progress/${run}-loud.png`;
    const { id } = await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: f.memberUser.id, data: px, storageKey: key } });
    const bucket = failingBucket();
    bucket.warn.mockImplementation(() => { throw new Error('logger down'); });
    const dispatched = vi.spyOn(t.app.get(ExternalEffectDispatcher), 'dispatchCommitted');
    try {
      const res = await http().delete(`/media/${id}`).set('Authorization', `Bearer ${pmc}`);
      expect(res.status).toBe(200);
      expect(await t.prisma.media.findUnique({ where: { id } })).toBeNull();
      expect(bucket.warn).toHaveBeenCalledTimes(1);
      // the delete's own committed events went out after the failed removal
      const sent = dispatched.mock.calls.flatMap((c) => c[0] as { eventType?: string; entityId?: string }[]);
      expect(sent.some((e) => e.entityId === id)).toBe(true);
    } finally { bucket.restore(); dispatched.mockRestore(); }
  });

  it('a drawing delete: 200, the drawing gone, and one warn line per revision file', async () => {
    const d = await t.prisma.drawing.create({ data: { projectId: f.projectA.id, number: `LOG-${run}`, title: 'log', discipline: 'architectural' } });
    const keys = [`${f.projectA.id}/drawings/${run}-a.pdf`, `${f.projectA.id}/drawings/${run}-b.pdf`];
    for (const [i, storageKey] of keys.entries()) {
      await t.prisma.drawingRevision.create({ data: { projectId: f.projectA.id, drawingId: d.id, rev: String.fromCharCode(65 + i), status: 'for_review', mime: 'application/pdf', storageKey, issuedBy: 'PMC', issuedAt: '1 Nov 2026' } });
    }
    const bucket = failingBucket();
    try {
      const res = await http().delete(`/drawings/${d.id}`).set('Authorization', `Bearer ${pmc}`);
      expect(res.status).toBe(200);
      expect(await t.prisma.drawing.findUnique({ where: { id: d.id } })).toBeNull();
      expect(bucket.warn.mock.calls.map((c) => c[0]).sort()).toEqual(keys.map((k) => `could not delete ${k} (drawing deleted): AccessDenied 403`).sort());
    } finally { bucket.restore(); }
  });
});
