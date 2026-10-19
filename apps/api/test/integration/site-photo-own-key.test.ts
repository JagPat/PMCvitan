import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos (Codex 4313929002) — the snapshot sends a photo's upload key to its uploader only, so a device
 * whose upload reply was lost (the photo still waits in its offline queue) can show the recorded photo once.
 * Nobody else is sent the key. Proven through the real routes against PostgreSQL.
 */
describe('a site photo\'s upload key goes only to its uploader (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  let client: string;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const http = () => request(t.app.getHttpServer());
  const photos = async (token: string) =>
    (await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`).expect(200)).body.photos as Array<{ id: string; clientKey?: string }>;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  it('sends each viewer the key of their own photo and no one else\'s', async () => {
    const mine = await http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${pmc}`)
      .send({ kind: 'progress', mime: 'image/png', data: px, clientKey: 'own-key-pmc' }).expect(201);
    const theirs = await http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${client}`)
      .send({ kind: 'progress', mime: 'image/png', data: px, clientKey: 'own-key-client' }).expect(201);

    const pmcView = await photos(pmc);
    expect(pmcView.find((p) => p.id === mine.body.id)?.clientKey).toBe('own-key-pmc');
    expect(pmcView.find((p) => p.id === theirs.body.id)).not.toHaveProperty('clientKey');

    const clientView = await photos(client);
    expect(clientView.find((p) => p.id === theirs.body.id)?.clientKey).toBe('own-key-client');
    expect(clientView.find((p) => p.id === mine.body.id)).not.toHaveProperty('clientKey');
  });
});
