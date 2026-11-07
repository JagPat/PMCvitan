import { describe, it, expect } from 'vitest';
import { ROLE_POLICY } from '@vitan/shared';
import { linkOfferBy, SITE_VISIT_OWN_REMOVAL_MS } from './site-visits.query';

/**
 * Video V2g-1 — the read's full-video link offer (`linkOfferBy`) against the routes' own rules, for the cases a live
 * read cannot reach or should be pinned exactly: a role the routes never let in (gap-check G5: an architect, whom the
 * database does not yet let any member be) and an ended visit (G1: the link's adder asks the PMC, as for a file).
 */
describe('video V2g-1: a clip\'s full-video link offer', () => {
  const now = Date.parse('2026-11-07T10:00:00Z');
  const inHour = new Date(now - 10 * 60_000);
  const visit = (status: string) => ({ status, visitorId: 'pmc-1', attendees: [{ userId: 'eng-1', retiredAt: null }] }) as never;

  it('a role outside media.upload is offered nothing, even on the visit and as the clip\'s adder', () => {
    expect(ROLE_POLICY['media.upload']).not.toContain('architect');
    const architect = { id: 'eng-1', role: 'architect' };
    expect(linkOfferBy(architect, visit('open'), 'eng-1', null, now)).toBeNull();
    expect(linkOfferBy(architect, visit('open'), 'eng-1', { addedById: 'eng-1', addedAt: inHour }, now)).toBeNull();
    // the same person in a role the routes let in is offered the add
    expect(linkOfferBy({ id: 'eng-1', role: 'engineer' }, visit('open'), 'eng-1', null, now)).toMatchObject({ reasonRequired: false });
  });

  it('an ended visit: the adder of a link within the hour is offered nothing; the PMC is, with a reason', () => {
    const engineer = { id: 'eng-1', role: 'engineer' };
    const own = { addedById: 'eng-1', addedAt: inHour };
    expect(linkOfferBy(engineer, visit('open'), 'eng-1', own, now)).toMatchObject({
      reasonRequired: false, until: new Date(inHour.getTime() + SITE_VISIT_OWN_REMOVAL_MS).toISOString(),
    });
    expect(linkOfferBy(engineer, visit('ended'), 'eng-1', own, now)).toBeNull();
    expect(linkOfferBy(engineer, visit('closed'), 'eng-1', own, now)).toBeNull();
    expect(linkOfferBy({ id: 'pmc-1', role: 'pmc' }, visit('ended'), 'eng-1', own, now)).toMatchObject({ reasonRequired: true });
    // adding where there is none stays open to them on an ended visit, as the server allows (only a closed one stops it)
    expect(linkOfferBy(engineer, visit('ended'), 'eng-1', null, now)).toMatchObject({ reasonRequired: false });
    expect(linkOfferBy(engineer, visit('closed'), 'eng-1', null, now)).toBeNull();
  });
});
