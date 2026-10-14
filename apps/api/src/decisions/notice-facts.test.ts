import { describe, it, expect } from 'vitest';
import { noticeText } from '@vitan/shared';
import { renderKindedDecisionNotice } from './decision-notice';
import { servedNotifications, type ViewerFeed } from '../snapshot/served-notifications';

/**
 * #827 (#839, #840) — an approval or forward notice is served with the facts its English text was rendered
 * from, so the bell can say it in Hindi or Gujarati with role names translated and every name, title and
 * material exactly as written. The facts come from the same arguments as the text, so they cannot disagree.
 */
const revisions = new Map([
  ['rev-1', { decisionId: 'D1', material: 'Granite', onBehalfOf: null, approvedByName: 'Client One', approvedByRole: 'client' }],
  ['rev-2', { decisionId: 'D1', material: 'Quartz', onBehalfOf: 'client', approvedByName: 'Priya', approvedByRole: 'pmc' }],
]);
const approval = (over: { kind?: string; revisionId?: string; deciderKind?: string; actorName?: string; actorRole?: string; finalization?: string; title?: string } = {}) => ({
  eventType: over.kind ?? 'decision.approved',
  payload: { revisionId: over.revisionId ?? 'rev-1', title: over.title ?? 'Kitchen counter', deciderKind: over.deciderKind ?? 'client', ...(over.finalization ? { finalization: over.finalization } : {}) },
  effectKey: over.kind ?? 'decision.approved',
  actorName: over.actorName ?? 'Client One',
  actorRole: over.actorRole ?? 'client',
});
const forward = (to: { kind: string; membershipId: string | null }, toLabel: string) => ({
  eventType: 'decision.forwarded', payload: { title: 'Kitchen counter', to, toLabel }, effectKey: 'decision.forwarded', actorName: 'Priya', actorRole: 'pmc',
});
const render = (kind: string, event: Parameters<typeof renderKindedDecisionNotice>[1]) => renderKindedDecisionNotice(kind, event, revisions, 'D1');

describe('approval and forward notices carry their facts (#839)', () => {
  it('a client approval: the line names the client role, not the person', () => {
    const r = render('decision.approved', approval());
    expect(r?.text).toBe('Client approved Kitchen counter — Granite');
    expect(r?.facts).toEqual({ kind: 'approval', byClient: true, actorName: 'Client One', actorRole: 'client', title: 'Kitchen counter', material: 'Granite', onBehalfOf: null, ending: null });
    expect(noticeText(r!.text, 'hi', { decision: true, facts: r!.facts })).toBe('क्लाइंट ने मंज़ूरी दी: Kitchen counter — Granite');
    expect(noticeText(r!.text, 'gu', { decision: true, facts: r!.facts })).toBe('ક્લાયન્ટ એ મંજૂરી આપી: Kitchen counter — Granite');
  });

  it('an on-behalf approval names the approver, their role and the holder', () => {
    const r = render('decision.reapproved', approval({ kind: 'decision.reapproved', revisionId: 'rev-2', actorName: 'Priya', actorRole: 'pmc' }));
    expect(r?.text).toBe('Priya (PMC) approved Kitchen counter on behalf of the client — Quartz');
    expect(r?.facts).toMatchObject({ byClient: false, actorName: 'Priya', actorRole: 'pmc', onBehalfOf: 'client', ending: null });
    expect(noticeText(r!.text, 'hi', { facts: r!.facts })).toBe('Priya (प्रोजेक्ट मैनेजर (PMC)) ने क्लाइंट की ओर से मंज़ूरी दी: Kitchen counter — Quartz');
  });

  it('a provisional and a finalized approval carry their ending', () => {
    const provisional = render('decision.awaiting_countersign', approval({ kind: 'decision.awaiting_countersign' }));
    expect(provisional?.text).toBe("Client approved Kitchen counter — Granite — awaiting the architect's countersign");
    expect(provisional?.facts).toMatchObject({ ending: { kind: 'provisional' } });
    const countersigned = render('decision.approved', approval({ actorName: 'Arch One', actorRole: 'architect', finalization: 'countersign' }));
    expect(countersigned?.text).toBe('Client approved Kitchen counter — Granite — countersigned by Arch One');
    expect(countersigned?.facts).toMatchObject({ actorName: 'Client One', byClient: true, ending: { kind: 'countersigned', by: 'Arch One' } });
    const finalized = render('decision.reapproved', approval({ kind: 'decision.reapproved', revisionId: 'rev-2', actorName: 'Priya', actorRole: 'pmc', finalization: 'stranded_completed' }));
    expect(finalized?.text).toBe('Priya (PMC) approved Kitchen counter on behalf of the client — Quartz — finalized by Priya with no active architect');
    expect(finalized?.facts).toMatchObject({ onBehalfOf: 'client', ending: { kind: 'finalized', by: 'Priya' } });
  });

  it('a named decider is named by the person, even one called "Client" or "Ann approved Bob" (#840)', () => {
    for (const actorName of ['Client', 'Ann approved Bob']) {
      const r = render('decision.approved', approval({ deciderKind: 'member', actorName, actorRole: 'engineer' }));
      expect(r?.facts).toMatchObject({ byClient: false, actorName });
      expect(noticeText(r!.text, 'hi', { decision: true, facts: r!.facts })).toBe(`${actorName} ने मंज़ूरी दी: Kitchen counter — Granite`);
    }
  });

  it('a forward to a role says the role; a forward to a member named like a role keeps the name', () => {
    const toRole = render('decision.forwarded', forward({ kind: 'architect', membershipId: null }, 'the architect'));
    expect(toRole?.facts).toEqual({ kind: 'forward', title: 'Kitchen counter', to: 'the architect', toRole: 'architect' });
    expect(noticeText(toRole!.text, 'gu', { facts: toRole!.facts })).toBe('નિર્ણય આગળ મોકલાયો: Kitchen counter → આર્કિટેક્ટ');
    const toMember = render('decision.forwarded', forward({ kind: 'member', membershipId: 'm-1' }, 'the client'));
    expect(toMember?.facts).toEqual({ kind: 'forward', title: 'Kitchen counter', to: 'the client', toRole: null });
    expect(noticeText(toMember!.text, 'hi', { facts: toMember!.facts })).toBe('निर्णय आगे भेजा गया: Kitchen counter → the client');
  });

  it('other notices carry no facts', () => {
    const published = render('decision.published', { eventType: 'decision.published', payload: { title: 'T' }, effectKey: 'decision.published', actorName: 'P', actorRole: 'pmc' });
    expect(published).not.toBeNull();
    expect(published).not.toHaveProperty('facts');
  });
});

describe('the bell is served the facts (#839)', () => {
  const feed = (kind: string, eventId: string) => ({ id: `n-${eventId}`, at: new Date('2026-10-14T00:00:00Z'), text: 'cached', time: 'just now', color: '#000', decisionId: 'D1', inspectionId: null, kind, eventId });
  const read = {
    slice: { decisions: [{ id: 'D1', status: 'approved', deciderKind: 'client', deciderUserId: null }] },
    feed: [feed('decision.approved', 'e1'), feed('decision.published', 'e2')],
    events: new Map<string, unknown>([
      ['e1', approval()],
      ['e2', { eventType: 'decision.published', payload: { title: 'T' }, effectKey: 'decision.published.record', actorName: 'P', actorRole: 'pmc' }],
    ]),
    revisions,
    seen: new Set<string>(),
  } as unknown as ViewerFeed;
  const query = {
    renderKindedNotice: (kind: string, event: Parameters<typeof renderKindedDecisionNotice>[1]) => renderKindedDecisionNotice(kind, event, revisions, 'D1'),
  };

  it('beside the text of an approval, and not on a notice without facts', () => {
    const served = servedNotifications(read, 'client', 'u-1', query as never);
    expect(served[0]).toMatchObject({ text: 'Client approved Kitchen counter — Granite', facts: { kind: 'approval', byClient: true } });
    expect(served[1]).not.toHaveProperty('facts');
  });
});
