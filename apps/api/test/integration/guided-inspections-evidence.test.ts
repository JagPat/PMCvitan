import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { base64, webmTimed } from '../unit-support/voice-files';
import { clipWebmTimed } from '../unit-support/video-files';

/**
 * Guided site inspections, step 2b — THE EVIDENCE RULE for guided items (proposal decision 2, Jagrut 5 Nov 2026: "a pass
 * needs the recordings its item asks for"), and voice notes and videos as an inspection item's evidence.
 *
 * - An item that asks for recordings needs that many of that kind (photo, video, voice) linked to it when it fails, and
 *   when it passes too if it asks "always". Not applicable needs none.
 * - A failed guided item needs a reason: its note, or a linked voice note.
 * - Any failed item needs at least one linked recording, as before; a plain checklist is refused with the same sentence.
 * - A voice note or a video uploads as item evidence (kind 'inspection', naming the item); anywhere else but a visit it
 *   is still refused.
 *
 * Reproduce-first: at the base (05fc25d) a guided pass with no recording submits, and a voice note or a video cannot be
 * filed on an item at all.
 */

describe('guided site inspections step 2b — required recordings on pass and fail (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;
  let clientToken: string;
  let seq = 0;
  const placeId = `gi2b-place-${Date.now()}`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');
    clientToken = t.issueProjectToken(f.strangerUser.id, f.projectA.id, 'client');
    await t.prisma.membership.createMany({
      data: [
        { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' },
        { projectId: f.projectA.id, userId: f.strangerUser.id, role: 'client', status: 'active' },
      ],
      skipDuplicates: true,
    });
    await t.prisma.projectNode.create({ data: { id: placeId, projectId: f.projectA.id, name: 'GF slab', kind: 'zone', publishedAt: new Date(), authorId: f.memberUser.id } });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.media.deleteMany({ where: { projectId } });
    // a guided item is never deleted; the sanctioned removal switches the refusal off by name, in one transaction
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" DISABLE TRIGGER "InspectionItem_guided_not_deleted"');
      await tx.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" ENABLE TRIGGER "InspectionItem_guided_not_deleted"');
    });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.projectNode.deleteMany({ where: { id: placeId } });
    await t.prisma.membership.deleteMany({ where: { projectId, userId: { in: [f.ownerUser.id, f.strangerUser.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (token: string, path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const voice = base64(webmTimed(4));
  const video = base64(clipWebmTimed(6));

  /** A guided checklist: A asks for 2 photos always, B 1 video on a fail, C 1 voice note always, D is plain, E has
   *  guidance but asks for no recording. Returns its id and item ids by name. */
  const guidedChecklist = async (): Promise<{ id: string; item: Record<'A' | 'B' | 'C' | 'D' | 'E', string> }> => {
    const title = `Guided ${seq++}`;
    const res = await post(pmcToken, `/projects/${f.projectA.id}/inspections`, {
      title, zone: 'GF', workType: 'RCC slab',
      items: [
        { name: 'A', lookAt: 'Steel spacing', record: { kind: 'photo', count: 2, when: 'always' } },
        { name: 'B', passRule: 'Gaps under 3 mm', record: { kind: 'video', count: 1, when: 'fail' } },
        { name: 'C', record: { kind: 'voice', count: 1, when: 'always', hint: 'Say what you see' } },
        'D',
        { name: 'E', lookAt: 'Sleeves in place' },
      ],
    });
    expect(res.status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title }, include: { items: true } });
    return { id: insp.id, item: Object.fromEntries(insp.items.map((i) => [i.name, i.id])) as Record<'A' | 'B' | 'C' | 'D' | 'E', string> };
  };

  const file = (inspectionId: string, inspectionItemId: string, mime: string, data: string, extra: object = {}, token = engToken) =>
    post(token, `/projects/${f.projectA.id}/media`, { kind: 'inspection', mime, data, inspectionId, inspectionItemId, clientKey: `gi2b-${seq++}`, ...extra });
  const photo = (i: string, it: string) => file(i, it, 'image/png', px);
  const voiceNote = (i: string, it: string) => file(i, it, 'audio/webm', voice, { durationSec: 4 });
  const videoClip = (i: string, it: string) => file(i, it, 'video/webm', video, { durationSec: 6 });

  type State = 'pass' | 'fail' | 'na';
  const submit = (c: { id: string; item: Record<string, string> }, states: Partial<Record<'A' | 'B' | 'C' | 'D' | 'E', State>>, notes: Partial<Record<string, string>> = {}) =>
    post(engToken, `/projects/${f.projectA.id}/inspections/${c.id}/submit`, {
      items: (['A', 'B', 'C', 'D', 'E'] as const).map((n) => ({ id: c.item[n], name: n, state: states[n] ?? 'pass', photos: 0, note: notes[n] ?? '' })),
    });
  const submitted = async (id: string) => (await t.prisma.inspection.findUniqueOrThrow({ where: { id } })).submitted;

  it('reproduce: a pass needs the recordings its item asks for "always"; the refusal names each item and what it lacks', async () => {
    const c = await guidedChecklist();
    const none = await submit(c, {});
    expect(none.status).toBe(400);
    expect(none.body.message).toBe('These items need the recordings they ask for before you can submit: A (2 photos), C (1 voice note)');
    expect(await submitted(c.id)).toBe(false);

    // one photo is not two, and a photo is not a voice note
    expect((await photo(c.id, c.item.A)).status).toBe(201);
    expect((await photo(c.id, c.item.C)).status).toBe(201);
    expect((await submit(c, {})).body.message).toBe('These items need the recordings they ask for before you can submit: A (2 photos), C (1 voice note)');

    expect((await photo(c.id, c.item.A)).status).toBe(201);
    const voiced = await voiceNote(c.id, c.item.C);
    expect(voiced.status).toBe(201);
    // B asks only on a fail, D is plain, E asks for no recording: a pass on each needs nothing
    expect((await submit(c, {})).status).toBe(201);
    expect(await submitted(c.id)).toBe(true);
    const stored = await t.prisma.media.findUniqueOrThrow({ where: { id: voiced.body.id as string } });
    expect(stored).toMatchObject({ kind: 'inspection', mime: 'audio/webm', durationSec: 4, inspectionItemId: c.item.C });
  });

  it('not applicable needs no recording, even on an item that asks "always"', async () => {
    const c = await guidedChecklist();
    expect((await submit(c, { A: 'na', C: 'na' })).status).toBe(201);
  });

  it('a fail needs the recordings its item asks for on a fail, and a reason, typed or spoken', async () => {
    const c = await guidedChecklist();
    await photo(c.id, c.item.A); await photo(c.id, c.item.A); await voiceNote(c.id, c.item.C);
    // B fails with a photo only: it asked for a video, and no reason was given
    await photo(c.id, c.item.B);
    expect((await submit(c, { B: 'fail' })).body.message).toBe(
      'These items need the recordings they ask for before you can submit: B (1 video) '
      + 'A failed item needs a reason, typed or spoken, before you can submit: B',
    );
    expect((await videoClip(c.id, c.item.B)).status).toBe(201);
    expect((await submit(c, { B: 'fail' })).body.message).toBe('A failed item needs a reason, typed or spoken, before you can submit: B');
    // a typed reason of only spaces is none
    expect((await submit(c, { B: 'fail' }, { B: '   ' })).status).toBe(400);
    expect((await submit(c, { B: 'fail' }, { B: 'Gap of 5 mm at the east edge' })).status).toBe(201);
  });

  it('a spoken reason counts: a failed guided item with a voice note and no note submits', async () => {
    const c = await guidedChecklist();
    await photo(c.id, c.item.A); await photo(c.id, c.item.A); await voiceNote(c.id, c.item.C);
    await photo(c.id, c.item.E);
    expect((await submit(c, { E: 'fail' })).body.message).toBe('A failed item needs a reason, typed or spoken, before you can submit: E');
    await voiceNote(c.id, c.item.E);
    expect((await submit(c, { E: 'fail' })).status).toBe(201);
  });

  it('a plain failed item is judged as before: one linked recording of any kind, the same sentence, and no reason asked', async () => {
    const c = await guidedChecklist();
    await photo(c.id, c.item.A); await photo(c.id, c.item.A); await voiceNote(c.id, c.item.C);
    expect((await submit(c, { D: 'fail' })).body.message).toBe('A failed item needs linked photo evidence before you can submit: D');
    expect((await videoClip(c.id, c.item.D)).status).toBe(201);
    expect((await submit(c, { D: 'fail' })).status).toBe(201);
  });

  it('a voice note or a video is evidence only on an item: elsewhere, or for a role that adds no evidence, it is still refused', async () => {
    const c = await guidedChecklist();
    // no item named: not an item's evidence and not a visit file
    expect((await post(engToken, `/projects/${f.projectA.id}/media`, { kind: 'inspection', mime: 'audio/webm', data: voice, inspectionId: c.id, clientKey: `gi2b-${seq++}` })).status).toBe(400);
    expect((await post(engToken, `/projects/${f.projectA.id}/media`, { kind: 'progress', mime: 'video/webm', data: video, clientKey: `gi2b-${seq++}` })).status).toBe(400);
    // filed on an item AND a place (a published one) or a decision: an item's recording is filed on nothing else
    expect((await file(c.id, c.item.C, 'audio/webm', voice, { nodeId: placeId })).status).toBe(400);
    expect((await file(c.id, c.item.B, 'video/webm', video, { decisionId: 'any' })).status).toBe(400);
    // a client adds no evidence
    expect((await file(c.id, c.item.C, 'audio/webm', voice, {}, clientToken)).status).toBe(403);
    // and the file must be what its type says
    expect((await file(c.id, c.item.C, 'audio/webm', px)).status).toBe(400);
    expect(await t.prisma.media.count({ where: { inspectionId: c.id } })).toBe(0);
  });

  it('an item recording is linked as the item\'s evidence; deleting it takes it off, and the submit is refused again', async () => {
    const c = await guidedChecklist();
    await photo(c.id, c.item.A); await photo(c.id, c.item.A);
    const v = await voiceNote(c.id, c.item.C);
    expect(await t.prisma.inspectionEvidence.count({ where: { inspectionItemId: c.item.C, mediaId: v.body.id as string } })).toBe(1);
    const del = await http().delete(`/media/${v.body.id as string}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(del.status).toBe(200);
    expect(await t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, eventType: 'inspection.evidence_removed' } })).toBeGreaterThan(0);
    expect((await submit(c, {})).body.message).toBe('These items need the recordings they ask for before you can submit: C (1 voice note)');
  });

  it('a proof photo is not evidence: only a linked recording counts', async () => {
    const c = await guidedChecklist();
    await photo(c.id, c.item.A); await photo(c.id, c.item.A); await voiceNote(c.id, c.item.C);
    // no API path files a proof before a submit; seeded directly, as a proof row is stored
    await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'proof', mime: 'image/png', uploadedBy: f.ownerUser.id, inspectionId: c.id, inspectionItemId: c.item.D } });
    expect((await submit(c, { D: 'fail' })).body.message).toBe('A failed item needs linked photo evidence before you can submit: D');
  });

  it('an item recording is not a site photo, and is never filed on a place afterwards', async () => {
    const c = await guidedChecklist();
    const v = await voiceNote(c.id, c.item.C);
    const clip = await videoClip(c.id, c.item.B);
    const p = await photo(c.id, c.item.A);
    const snap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${pmcToken}`);
    expect(snap.status).toBe(200);
    const photoIds = (snap.body.photos as Array<{ id: string }>).map((x) => x.id);
    expect(photoIds).toContain(p.body.id);
    expect(photoIds).not.toContain(v.body.id);
    expect(photoIds).not.toContain(clip.body.id);
    for (const id of [v.body.id as string, clip.body.id as string]) {
      const refile = await http().patch(`/projects/${f.projectA.id}/media/${id}/node`).set('Authorization', `Bearer ${pmcToken}`).send({ nodeId: placeId });
      expect(refile.status).toBe(400);
      expect((await t.prisma.media.findUniqueOrThrow({ where: { id } })).nodeId).toBeNull();
    }
  });
});
