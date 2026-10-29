import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DrawingsService } from '../../src/drawings/drawings.service';
import { StorageService } from '../../src/media/storage.service';

/**
 * `DELETE /drawings/:id` (notes/delete-race/plan.md S2). The route reads the drawing before its transaction:
 *  - a delete that loses a race to another delete of the drawing is the route's 404 'Drawing not found', with nothing
 *    of it committed (no audit, no receipt for its key) and no file removed by it;
 *  - the revisions' files are removed only after the delete commits, so a delete that fails keeps every file its rows
 *    still name;
 *  - a revision issued after the read has its file removed with the drawing (the list is read under the row lock).
 *
 * Reproduce-first: on 9e644157 the lost race is a 500 (P2025), the failed delete has already removed the files, and the
 * late revision's file is never removed.
 */
describe('drawing delete: lost races, failed deletes and late revisions (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  const run = randomUUID().slice(0, 8);
  const p = () => f.projectA.id;
  let n = 0;

  const drawing = async (keys: string[]) => {
    n += 1;
    const d = await t.prisma.drawing.create({ data: { projectId: p(), number: `RACE-${run}-${n}`, title: 'race', discipline: 'architectural' } });
    for (const [i, storageKey] of keys.entries()) {
      await t.prisma.drawingRevision.create({ data: { projectId: p(), drawingId: d.id, rev: String.fromCharCode(65 + i), status: 'for_review', mime: 'application/pdf', storageKey, issuedBy: 'PMC', issuedAt: '29 Oct 2026' } });
    }
    return d.id;
  };
  const del = (id: string, key?: string) => {
    const r = request(t.app.getHttpServer()).delete(`/drawings/${id}`).set('Authorization', `Bearer ${pmc}`);
    if (key) r.set('Idempotency-Key', key);
    return r;
  };
  /** The next `drawing.findUnique` naming `id` runs `then` right after its own read. */
  const afterRead = (id: string, then: () => Promise<unknown>) => {
    const d = t.prisma.drawing as unknown as { findUnique: (a: { where: { id?: string } }) => Promise<unknown> };
    const real = d.findUnique.bind(d);
    let fired = false;
    d.findUnique = async (a) => {
      const row = await real(a);
      if (!fired && a.where.id === id) { fired = true; await then(); }
      return row;
    };
    return { restore: () => { d.findUnique = real; }, fired: () => fired };
  };
  const audits = (id: string) => t.prisma.auditLog.count({ where: { projectId: p(), action: 'drawing.remove', entityId: id } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmc = t.issueProjectToken(f.memberUser.id, p(), 'pmc');
  });
  afterAll(async () => {
    await t?.prisma.drawing.deleteMany({ where: { projectId: p() } }).catch(() => undefined);
    await f?.cleanup().catch(() => undefined);
    await t?.close();
  });

  it('the loser of two deletes is 404 "Drawing not found", keyed or not, and removes no file itself', async () => {
    const service = t.app.get(DrawingsService);
    for (const keyed of [false, true]) {
      const key = `drawings/${run}-lose-${keyed}.pdf`;
      const id = await drawing([key]);
      const [win, lose] = [`race-win-${randomUUID()}`, `race-lose-${randomUUID()}`];
      const removed = vi.spyOn(t.app.get(StorageService), 'remove');
      const race = afterRead(id, () => service.remove(id, p(), { sub: f.memberUser.id, role: 'pmc', projectId: p() } as never, keyed ? win : undefined));
      try {
        const res = await del(id, keyed ? lose : undefined);
        expect([keyed, res.status, res.body.message]).toEqual([keyed, 404, 'Drawing not found']);
        expect(race.fired()).toBe(true);
        // the winner's one removal of its one file, and none by the loser
        expect(removed.mock.calls.map((c) => c[0])).toEqual([key]);
      } finally { race.restore(); removed.mockRestore(); }
      expect(await audits(id)).toBe(1);
      if (keyed) {
        expect(await t.prisma.commandExecution.count({ where: { idempotencyKey: win } })).toBe(1);
        expect(await t.prisma.commandExecution.count({ where: { idempotencyKey: lose } })).toBe(0);
      }
    }
  });

  it('a delete that fails in its transaction keeps the drawing and every one of its files', async () => {
    const keys = [`drawings/${run}-kept-a.pdf`, `drawings/${run}-kept-b.pdf`];
    const id = await drawing(keys);
    await t.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.drawing_race_test_refuse() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'drawing race test: refused'; END $$`);
    await t.prisma.$executeRawUnsafe(`CREATE TRIGGER drawing_race_test_refuse BEFORE DELETE ON public."Drawing" FOR EACH ROW EXECUTE FUNCTION public.drawing_race_test_refuse()`);
    const removed = vi.spyOn(t.app.get(StorageService), 'remove');
    try {
      expect((await del(id)).status).toBe(500);
      expect(await t.prisma.drawingRevision.count({ where: { drawingId: id } })).toBe(2);
      expect(removed).not.toHaveBeenCalled();
    } finally {
      removed.mockRestore();
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS drawing_race_test_refuse ON public."Drawing"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.drawing_race_test_refuse()`);
    }
    expect(await audits(id)).toBe(0);
  });

  it('a revision added after the read goes with the drawing, and so does its file', async () => {
    const first = `drawings/${run}-early.pdf`;
    const late = `drawings/${run}-late.pdf`;
    const id = await drawing([first]);
    const race = afterRead(id, () => t.prisma.drawingRevision.create({ data: { projectId: p(), drawingId: id, rev: 'Z', status: 'for_review', mime: 'application/pdf', storageKey: late, issuedBy: 'PMC', issuedAt: '29 Oct 2026' } }));
    const removed = vi.spyOn(t.app.get(StorageService), 'remove');
    try {
      expect((await del(id)).status).toBe(200);
      expect(race.fired()).toBe(true);
      expect(removed.mock.calls.map((c) => c[0]).sort()).toEqual([first, late].sort());
    } finally { race.restore(); removed.mockRestore(); }
    expect(await t.prisma.drawingRevision.count({ where: { drawingId: id } })).toBe(0);
  });
});
