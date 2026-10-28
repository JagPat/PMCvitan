import { describe, expect, it } from 'vitest';
import { readHubEvent } from './hub-event';

/** #1118 U3 — reading a signed Hub body. The shapes are Hub's (`docs/hub-api.md`, `WebhookService.drawing/project`). */
const issued = (data: Record<string, unknown> = {}, type = 'drawing.issued') => ({
  type,
  timestamp: '2026-10-27T10:00:00Z',
  data: {
    fileId: 'f-17', fileNo: 'A-101', name: 'A-101 Ground floor plan', title: 'Ground floor plan', revision: 'C02',
    statusCode: 'A2', toStage: 'CONSTRUCTION', versionId: 'v-9031', contentPath: '/api/v2/drawings/f-17/content?versionId=v-9031',
    project: { id: 42, number: 'P-042', name: 'Ambli', links: [{ app: 'pmc', externalId: 'ambli', url: 'https://pms.vitan.in' }] },
    ...data,
  },
});
const read = (value: unknown) => readHubEvent(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));

describe('#1118 U3 readHubEvent', () => {
  it('reads a drawing event: its type, version, Hub project and the one PMC project Hub names', () => {
    expect(read(issued())).toEqual({ kind: 'event', type: 'drawing.issued', versionId: 'v-9031', hubProjectId: '42', pmcProjectIds: ['ambli'] });
    expect(read(issued({ toStage: 'SUPERSEDED' }, 'drawing.superseded'))).toMatchObject({ kind: 'event', type: 'drawing.superseded' });
    // a string Hub project id reads the same as the number
    expect(read(issued({ project: { id: '42', links: [] } }))).toMatchObject({ hubProjectId: '42', pmcProjectIds: [] });
  });

  it('keeps every other app\'s link out, and counts a PMC project once', () => {
    const links = [{ app: 'erp', externalId: 'x' }, { app: 'pmc', externalId: 'a' }, { app: 'pmc', externalId: 'a' }, { app: 'pmc', externalId: 'b' }];
    expect(read(issued({ project: { id: 42, links } }))).toMatchObject({ pmcProjectIds: ['a', 'b'] });
  });

  it('ignores an unsubscribed type and a status change into work in progress', () => {
    expect(read({ type: 'webhook.test', data: { message: 'hi' } })).toEqual({ kind: 'ignored', type: 'webhook.test', why: 'not_subscribed' });
    expect(read(issued({}, 'drawing.created'))).toEqual({ kind: 'ignored', type: 'drawing.created', why: 'not_subscribed' });
    expect(read(issued({ toStage: null }, 'drawing.status_changed'))).toEqual({ kind: 'ignored', type: 'drawing.status_changed', why: 'work_in_progress' });
    // only an explicit null is work in progress: a status change with no toStage at all is malformed
    expect(read(issued({ toStage: undefined }, 'drawing.status_changed'))).toEqual({ kind: 'malformed', type: 'drawing.status_changed', versionId: 'v-9031' });
    // a review stage is not work in progress
    expect(read(issued({ toStage: 'SHARED' }, 'drawing.status_changed'))).toMatchObject({ kind: 'event', type: 'drawing.status_changed' });
  });

  it('can\'t read what isn\'t a JSON object with a Hub type', () => {
    for (const body of ['', 'not json', '[1]', 'null', '"drawing.issued"', JSON.stringify({ data: {} }), JSON.stringify({ type: 7 }),
      JSON.stringify({ type: 'Drawing.Issued' }), JSON.stringify({ type: '(unreadable)' }), JSON.stringify({ type: `drawing.${'x'.repeat(260)}` })]) {
      expect(read(body), body).toEqual({ kind: 'unreadable' });
    }
  });

  it('refuses a subscribed event whose data lacks what resolving it needs, keeping a good version id', () => {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ toStage: 'WIP' }, 'v-9031'],
      [{ toStage: null }, 'v-9031'], // an issue or a supersede always has a stage
      [{ project: null }, 'v-9031'],
      [{ project: { links: [] } }, 'v-9031'],
      [{ project: { id: -1, links: [] } }, 'v-9031'],
      [{ project: { id: 1.5, links: [] } }, 'v-9031'],
      [{ project: { id: 'has space', links: [] } }, 'v-9031'],
      [{ project: { id: 42 } }, 'v-9031'],
      [{ project: { id: 42, links: [null] } }, 'v-9031'],
      [{ project: { id: 42, links: [{ app: 'pmc', externalId: '' }] } }, 'v-9031'],
      [{ project: { id: 42, links: [{ app: 'pmc', externalId: 'é' }] } }, 'v-9031'],
      [{ versionId: { id: 1 } }, null],
      [{ versionId: 'v '.repeat(3) }, null],
    ];
    for (const [data, versionId] of cases) expect(read(issued(data)), JSON.stringify(data)).toEqual({ kind: 'malformed', type: 'drawing.issued', versionId });
    expect(read({ type: 'drawing.issued', data: [] })).toEqual({ kind: 'malformed', type: 'drawing.issued', versionId: null });
  });

  it('reads a missing version as none, and a numeric one as its digits', () => {
    expect(read(issued({ versionId: null }))).toMatchObject({ kind: 'event', versionId: null });
    expect(read(issued({ versionId: 9031 }))).toMatchObject({ kind: 'event', versionId: '9031' });
  });

  it('reads the exact bytes as UTF-8, whatever their other fields hold', () => {
    const body = Buffer.from(JSON.stringify(issued({ title: 'Plan — तल मंज़िल' })), 'utf8');
    expect(readHubEvent(body)).toMatchObject({ kind: 'event', pmcProjectIds: ['ambli'] });
  });
});
