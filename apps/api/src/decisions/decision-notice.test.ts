import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONABLE_DECISION_NOTICE_KINDS, kindedDecisionNoticeServed, kindedNoticeRevisionId, renderKindedDecisionNotice } from './decision-notice';
import {
  APPROVED_DECISION_NOTICE_COLOR,
  AWAITING_COUNTERSIGN_NOTICE_COLOR,
  FORWARDED_DECISION_NOTICE_COLOR,
  PENDING_DECISION_NOTICE_COLOR,
  RECORDED_DECISION_NOTICE_COLOR,
  WITHDRAWN_DECISION_NOTICE_COLOR,
  approvedDecisionNotice,
  forwardedDecisionNotice,
  pendingDecisionNotice,
  provisionalApprovalNotice,
  recordedDecisionNotice,
  withdrawnDecisionNotice, finalizedApprovalNotice, changeRequestedNotice, CHANGE_REQUESTED_NOTICE_COLOR } from '../domain/notifications';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4c — the RENDERER TRIPWIRE (§A.3 obligation 7): a kinded notice is
 * rendered from its kind and event, and the rendering must equal what the delivered writer caches in
 * `text`/`color` for the same act, so the kinded path and the kind-less cache cannot disagree.
 */
const envelope = { actorRole: 'pmc', actorName: 'Ar. Meghna' };
const published = (title: string, effectKey = 'decision.published') => ({ eventType: 'decision.published', payload: { title }, effectKey, ...envelope });
const withdrawn = (title: string, reason: string) => ({ eventType: 'decision.withdrawn', payload: { title, reason, pushIntentsCancelled: 0 }, effectKey: 'decision.withdrawn', ...envelope });
/** 4d-ii-a / A7a — an approve event as the direct approve emits it: the option facts, the exact
 *  revision it wrote, the title and the holder kind, under the actor's frozen envelope. */
const approved = (over: Partial<{ kind: string; title: string; deciderKind: string; onBehalfOf: string; revisionId: string; actorRole: string | null; actorName: string | null }> = {}) => {
  const kind = over.kind ?? 'decision.approved';
  return {
    eventType: kind,
    payload: { option: 'Option A', material: 'Granite', ...(over.onBehalfOf ? { onBehalfOf: over.onBehalfOf } : {}), revisionId: over.revisionId ?? 'dar-D1-v1', title: over.title ?? 'Kitchen counter', deciderKind: over.deciderKind ?? 'client' },
    effectKey: kind,
    actorRole: over.actorRole === undefined ? 'client' : over.actorRole,
    actorName: over.actorName === undefined ? 'Client One' : over.actorName,
  };
};
const revisions = new Map([
  ['dar-D1-v1', { decisionId: 'D1', material: 'Granite', onBehalfOf: null, approvedByName: 'Client One', approvedByRole: 'client' }],
  ['dar-D1-v2', { decisionId: 'D1', material: 'Quartz', onBehalfOf: 'client', approvedByName: 'Priya PMC', approvedByRole: 'pmc' }],
  // another decision's revision in the same project (#665's review round 1)
  ['dar-D2-v1', { decisionId: 'D2', material: 'Marble', onBehalfOf: null, approvedByName: null, approvedByRole: null }],
]);
/** the renderer for D1's notices: the revision the event names must be D1's */
const render = (kind: string, event: Parameters<typeof renderKindedDecisionNotice>[1]) => renderKindedDecisionNotice(kind, event, revisions, 'D1');

describe('the kinded decision notice renderer (4d-ii-a / A4c)', () => {
  it('renders each arm exactly as its writer caches it', () => {
    expect(renderKindedDecisionNotice('decision.published', published('Kitchen counter')))
      .toEqual({ text: pendingDecisionNotice('Kitchen counter'), color: PENDING_DECISION_NOTICE_COLOR });
    expect(renderKindedDecisionNotice('decision.published', published('Stair rail', 'decision.published.record')))
      .toEqual({ text: recordedDecisionNotice('Stair rail'), color: RECORDED_DECISION_NOTICE_COLOR });
    expect(renderKindedDecisionNotice('decision.withdrawn', withdrawn('Kitchen counter', 'Client changed scope')))
      .toEqual({ text: withdrawnDecisionNotice('Kitchen counter', 'Client changed scope'), color: WITHDRAWN_DECISION_NOTICE_COLOR });
    // A7a — the green notice: the approver from the envelope, the option and on-behalf fact from
    // the revision the event names, the title and holder kind from the payload
    expect(render('decision.approved', approved()))
      .toEqual({ text: approvedDecisionNotice({ actorName: 'Client One', actorRole: 'client', title: 'Kitchen counter', material: 'Granite', deciderKind: 'client', onBehalfOf: null }), color: APPROVED_DECISION_NOTICE_COLOR });
    expect(render('decision.reapproved', approved({ kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client', actorRole: 'pmc', actorName: 'Ar. Meghna' })))
      .toEqual({ text: approvedDecisionNotice({ actorName: 'Ar. Meghna', actorRole: 'pmc', title: 'Kitchen counter', material: 'Quartz', deciderKind: 'client', onBehalfOf: 'client' }), color: APPROVED_DECISION_NOTICE_COLOR });
  });

  it('the green notice, character for character (the three announcement shapes the delivered approve wrote inline)', () => {
    expect(render('decision.approved', approved())?.text).toBe('Client approved Kitchen counter — Granite');
    expect(render('decision.approved', approved({ deciderKind: 'member', actorRole: 'engineer', actorName: 'Ravi' }))?.text).toBe('Ravi approved Kitchen counter — Granite');
    expect(render('decision.reapproved', approved({ kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client', actorRole: 'pmc', actorName: 'Ar. Meghna' })))
      .toEqual({ text: 'Ar. Meghna (PMC) approved Kitchen counter on behalf of the client — Quartz', color: '#3F7A54' });
    expect(approvedDecisionNotice({ actorName: 'Ar. Meghna', actorRole: 'pmc', title: 'T', material: 'M', deciderKind: 'member', onBehalfOf: 'member' })).toBe('Ar. Meghna (PMC) approved T on behalf of the named decider — M');
  });

  it('the green notice renders ITS revision, never the head, and nothing without the revision, the envelope or the payload facts', () => {
    // a twice-approved decision: the older notice keeps its own option and approver
    const older = approved();
    const newer = approved({ kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client', actorRole: 'pmc', actorName: 'Ar. Meghna' });
    expect(render('decision.approved', older)?.text).toContain('Granite');
    expect(render('decision.reapproved', newer)?.text).toContain('Quartz');
    expect(kindedNoticeRevisionId('decision.approved', older)).toBe('dar-D1-v1');
    expect(kindedNoticeRevisionId('decision.reapproved', newer)).toBe('dar-D1-v2');
    expect(kindedNoticeRevisionId('decision.published', published('T'))).toBeNull();
    expect(kindedNoticeRevisionId('decision.approved', { ...older, eventType: 'decision.reapproved' })).toBeNull();
    // the revision the event names is not in the snapshot (or the event names none): nothing
    expect(render('decision.approved', approved({ revisionId: 'dar-D1-v9' }))).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', approved(), new Map(), 'D1')).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', approved())).toBeNull();
    expect(render('decision.approved', { ...approved(), payload: { option: 'Option A', material: 'Granite' } }), 'a previous-release payload').toBeNull();
    // a previous-release event through the drain carries no envelope: no kinded rendering
    expect(render('decision.approved', approved({ actorRole: null, actorName: null }))).toBeNull();
    expect(render('decision.approved', { ...approved(), payload: { ...approved().payload, title: '' } })).toBeNull();
    expect(render('decision.approved', { ...approved(), payload: { ...approved().payload, deciderKind: undefined } })).toBeNull();
  });

  // #665's review round 1 (P1) — an event naming ANOTHER decision's revision renders nothing here,
  // and the database refuses such a bundle at commit (`phase6_t4d_revision_claims_approval`)
  it('the green notice renders only ITS decision\'s revision: another decision\'s revision, or no decision to judge by, renders nothing', () => {
    const forged = approved({ revisionId: 'dar-D2-v1' });
    expect(renderKindedDecisionNotice('decision.approved', forged, revisions, 'D1')).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', forged, revisions, 'D2')?.text).toBe('Client approved Kitchen counter — Marble');
    expect(renderKindedDecisionNotice('decision.approved', approved(), revisions, 'D2')).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', approved(), revisions)).toBeNull();
  });

  it('the strings and colours are today\'s, character for character (the cache every kind-less row carries)', () => {
    expect(renderKindedDecisionNotice('decision.published', published('X'))).toEqual({ text: 'Decision awaiting approval: X', color: '#C08A2D' });
    expect(renderKindedDecisionNotice('decision.published', published('X', 'decision.published.record'))).toEqual({ text: 'Issue recorded: X', color: '#6B665C' });
    expect(renderKindedDecisionNotice('decision.withdrawn', withdrawn('X', 'R'))).toEqual({ text: 'Decision withdrawn: X — R', color: '#6B665C' });
  });

  it('renders NOTHING it has no arm for, and never trusts a kind that disagrees with its event', () => {
    for (const kind of ['decision.drafted', 'decision.consultation_requested', 'x.y']) {
      expect(render(kind, { eventType: kind, payload: { title: 'T' }, effectKey: kind, ...envelope }), kind).toBeNull();
    }
    expect(renderKindedDecisionNotice('decision.published', { ...published('T'), eventType: 'decision.withdrawn' })).toBeNull();
    expect(render('decision.approved', { ...approved(), eventType: 'decision.reapproved' })).toBeNull();
    expect(renderKindedDecisionNotice('decision.published', { eventType: 'decision.published', payload: {}, effectKey: 'decision.published', ...envelope })).toBeNull();
    expect(renderKindedDecisionNotice('decision.withdrawn', { eventType: 'decision.withdrawn', payload: { title: 'T' }, effectKey: 'decision.withdrawn', ...envelope })).toBeNull();
  });

  // 4d-ii-a / A8a — the forwarding notice and the provisional approval's notice
  it('the forwarded notice renders the title and the new holder\'s frozen label from its event, and nothing without them', () => {
    const forwarded = (payload: object) => ({ eventType: 'decision.forwarded', payload, effectKey: 'decision.forwarded', ...envelope });
    expect(render('decision.forwarded', forwarded({ forwardId: 'dfw-1', title: 'Kitchen counter', toLabel: 'Ravi', reason: 'site engineer decides finishes' })))
      .toEqual({ text: forwardedDecisionNotice('Kitchen counter', 'Ravi'), color: FORWARDED_DECISION_NOTICE_COLOR });
    expect(render('decision.forwarded', forwarded({ title: 'Kitchen counter', toLabel: 'the architect' }))?.text).toBe('Decision forwarded: Kitchen counter → the architect');
    expect(FORWARDED_DECISION_NOTICE_COLOR).toBe('#C08A2D');
    expect(render('decision.forwarded', forwarded({ title: 'Kitchen counter' }))).toBeNull();
    expect(render('decision.forwarded', forwarded({ toLabel: 'Ravi' }))).toBeNull();
    expect(render('decision.forwarded', { ...forwarded({ title: 'T', toLabel: 'R' }), eventType: 'decision.published' })).toBeNull();
    // the forwarded notice is the NEW holder's action item: pmc and the decider the decision now names
    const held = { status: 'pending', deciderKind: 'member', deciderUserId: 'u-ravi' } as const;
    expect(kindedDecisionNoticeServed('decision.forwarded', forwarded({ title: 'T', toLabel: 'R' }), held, 'pmc', 'u-pmc')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.forwarded', forwarded({ title: 'T', toLabel: 'R' }), held, 'engineer', 'u-ravi')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.forwarded', forwarded({ title: 'T', toLabel: 'R' }), held, 'engineer', 'u-other')).toBe(false);
    expect(kindedDecisionNoticeServed('decision.forwarded', forwarded({ title: 'T', toLabel: 'R' }), { ...held, status: 'withdrawn' }, 'pmc', 'u-pmc')).toBe(false);
  });

  it('the provisional approval notice renders as the green one does, from the PROVISIONAL revision the demand names, with the countersign it awaits stated; a re-notification renders nothing', () => {
    const demand = approved({ kind: 'decision.awaiting_countersign' });
    expect(render('decision.awaiting_countersign', demand))
      .toEqual({ text: provisionalApprovalNotice({ actorName: 'Client One', actorRole: 'client', title: 'Kitchen counter', material: 'Granite', deciderKind: 'client', onBehalfOf: null }), color: AWAITING_COUNTERSIGN_NOTICE_COLOR });
    expect(render('decision.awaiting_countersign', demand)?.text).toBe("Client approved Kitchen counter — Granite — awaiting the architect's countersign");
    expect(AWAITING_COUNTERSIGN_NOTICE_COLOR).toBe('#31567F');
    expect(kindedNoticeRevisionId('decision.awaiting_countersign', demand)).toBe('dar-D1-v1');
    // the `decisions.effects` re-notification: a system event naming no revision, with no human envelope
    expect(render('decision.awaiting_countersign', { eventType: 'decision.awaiting_countersign', payload: { renotified: true, crossingEventId: 'e', transitionId: 't' }, effectKey: 'decision.awaiting_countersign', actorRole: null, actorName: null })).toBeNull();
    expect(render('decision.awaiting_countersign', approved({ kind: 'decision.awaiting_countersign', actorRole: null, actorName: null }))).toBeNull();
    expect(render('decision.awaiting_countersign', approved({ kind: 'decision.awaiting_countersign', revisionId: 'dar-D2-v1' }))).toBeNull();
    expect(render('decision.approved', demand), 'a kind that disagrees with its event').toBeNull();
  });

  // 4d-ii-a / A8b (#673 round 1) — the countersign rejection's notice
  it('the change-request notice renders the title and the reason from a `countersign_rejection` event, nothing from the standard request (which writes no notice) or without them, and is served to pmc and the decider', () => {
    const rejected = (payload: object) => ({ eventType: 'decision.change_requested', payload, effectKey: 'decision.change_requested', actorRole: 'architect', actorName: 'Arch One' });
    expect(render('decision.change_requested', rejected({ origin: 'countersign_rejection', title: 'Kitchen counter', reason: 'the wear rating is wrong', path: 'reject_back', revisionId: 'dar-D1-v1', requestId: 'cr-1' })))
      .toEqual({ text: changeRequestedNotice('Kitchen counter', 'the wear rating is wrong'), color: CHANGE_REQUESTED_NOTICE_COLOR });
    expect(render('decision.change_requested', rejected({ origin: 'countersign_rejection', title: 'Kitchen counter', reason: 'choose again', outcome: 'returned' }))?.text).toBe('Change requested: Kitchen counter — choose again');
    expect(CHANGE_REQUESTED_NOTICE_COLOR).toBe('#C08A2D');
    // the standard request's event (no origin; the delivered path writes no notice) renders nothing
    expect(render('decision.change_requested', rejected({ reason: 'second thoughts', costImpact: 0, timeImpactDays: 0 }))).toBeNull();
    expect(render('decision.change_requested', rejected({ origin: 'standard', title: 'T', reason: 'R' }))).toBeNull();
    expect(render('decision.change_requested', rejected({ origin: 'countersign_rejection', title: 'T' }))).toBeNull();
    expect(render('decision.change_requested', rejected({ origin: 'countersign_rejection', reason: 'R' }))).toBeNull();
    expect(render('decision.change_requested', { ...rejected({ origin: 'countersign_rejection', title: 'T', reason: 'R' }), eventType: 'decision.forwarded' })).toBeNull();
    // the decider's action item: pmc and the decider the decision now names
    const ev = rejected({ origin: 'countersign_rejection', title: 'T', reason: 'R' });
    const clientHeld = { status: 'change', deciderKind: 'client', deciderUserId: undefined } as const;
    const engHeld = { status: 'change', deciderKind: 'member', deciderUserId: 'u-eng' } as const;
    expect(kindedDecisionNoticeServed('decision.change_requested', ev, clientHeld, 'pmc', 'u-pmc')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.change_requested', ev, clientHeld, 'client', 'u-client')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.change_requested', ev, engHeld, 'engineer', 'u-eng')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.change_requested', ev, engHeld, 'engineer', 'u-other')).toBe(false);
    expect(kindedDecisionNoticeServed('decision.change_requested', ev, engHeld, 'client', 'u-client')).toBe(false);
    expect(kindedDecisionNoticeServed('decision.change_requested', ev, { ...clientHeld, status: 'withdrawn' }, 'pmc', 'u-pmc')).toBe(false);
  });

  it('the ACTIONABLE set is exactly the four kinds that ask for an act', () => {
    expect([...ACTIONABLE_DECISION_NOTICE_KINDS].sort()).toEqual([
      'decision.awaiting_countersign', 'decision.change_requested', 'decision.forwarded', 'decision.published',
    ]);
  });

  it('the delivered decision writers cache with the SAME colour constants the renderer reads, and every one is KINDED (A7a)', () => {
    const src = readFileSync(join(__dirname, 'decisions.service.ts'), 'utf8');
    const creates = [...src.matchAll(/tx\.notification\.create\(\{ data: \{[^}]*\} \}\)/g)].map((m) => m[0]);
    // 4d-ii-a / A8a — six writers: the one-step issue, publish, the approve (green), the provisional
    // approve (awaiting), the withdraw and the forward; A8b — three more: the FINALIZER's green notice
    // (the countersign and the `completed` stranded resolution share it), the rejection bundle's
    // change-request notice (the disagreement's two paths and the `returned` resolution; #673 round 1)
    // and the re-homing forward's notice inside that bundle
    expect(creates.length).toBe(9);
    // every notice names its colour by the constant its renderer arm reads; no literal is left
    expect(creates.filter((c) => /PENDING_DECISION_NOTICE_COLOR|RECORDED_DECISION_NOTICE_COLOR|WITHDRAWN_DECISION_NOTICE_COLOR|APPROVED_DECISION_NOTICE_COLOR|AWAITING_COUNTERSIGN_NOTICE_COLOR|FORWARDED_DECISION_NOTICE_COLOR|CHANGE_REQUESTED_NOTICE_COLOR/.test(c))).toHaveLength(9);
    expect(creates.filter((c) => /'#[0-9A-Fa-f]{6}'/.test(c))).toEqual([]);
    // 4d-ii-a / A7a — every decisions notice writer stamps the event it announces and its kind (the
    // binding pair; the seal refuses one half without the other), the event emitted first in the
    // same transaction with the id the writer minted (`emitEvent(..., { eventId, ... })`)
    for (const c of creates) {
      expect(c, c).toMatch(/kind: /);
      expect(c, c).toMatch(/eventId \}/);
    }
    // eight event-id mints (the approve mints one for either landing; A8b's finalization, its rejection's
    // `change_requested` announcement and its re-homing forward mint theirs) and nine minted emitters
    expect(src.match(/const eventId = randomUUID\(\);/g)).toHaveLength(8);
    expect(src.match(/emitEvent\(tx, \{\n\s+projectId, actor, eventId,/g)).toHaveLength(9);
  });

  it('A8b — a FINALIZER\'s green notice names the approver from the revision\'s frozen pair and the finalizer as its own attribution; an unknown finalization or a revision with no frozen approver renders nothing', () => {
    const countersigned = approved({ actorName: 'Arch One', actorRole: 'architect' });
    (countersigned.payload as Record<string, unknown>).finalization = 'countersign';
    expect(render('decision.approved', countersigned)).toEqual({
      text: finalizedApprovalNotice({ actorName: 'Client One', actorRole: 'client', title: 'Kitchen counter', material: 'Granite', deciderKind: 'client', onBehalfOf: null }, 'countersign', 'Arch One'),
      color: APPROVED_DECISION_NOTICE_COLOR,
    });
    expect(render('decision.approved', countersigned)?.text).toBe('Client approved Kitchen counter — Granite — countersigned by Arch One');
    const completed = approved({ actorName: 'Priya PMC', actorRole: 'pmc', kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client' });
    (completed.payload as Record<string, unknown>).finalization = 'stranded_completed';
    expect(render('decision.reapproved', completed)?.text).toBe('Priya PMC (PMC) approved Kitchen counter on behalf of the client — Quartz — finalized by Priya PMC with no active architect');
    const unknown = approved({ actorName: 'Arch One', actorRole: 'architect' });
    (unknown.payload as Record<string, unknown>).finalization = 'by decree';
    expect(render('decision.approved', unknown)).toBeNull();
    // the revision the event names carries no frozen approver (a drain-window head): nothing to name
    const unfrozen = approved({ actorName: 'Arch One', actorRole: 'architect', revisionId: 'dar-D2-v1' });
    (unfrozen.payload as Record<string, unknown>).finalization = 'countersign';
    expect(renderKindedDecisionNotice('decision.approved', unfrozen, revisions, 'D2')).toBeNull();
  });
});

describe('who is served a kinded decision notice (4d-ii-a / A4c)', () => {
  const pending = { status: 'pending' as const, deciderKind: 'client' as const, deciderUserId: undefined };
  const memberHeld = { status: 'pending' as const, deciderKind: 'member' as const, deciderUserId: 'u-eng' };

  it('nobody who may not see the decision', () => {
    expect(kindedDecisionNoticeServed('decision.withdrawn', withdrawn('T', 'R'), undefined, 'pmc', 'u-pmc')).toBe(false);
  });

  it('a withdrawn decision\'s ACTIONABLE kinds are suppressed, its informational ones stand', () => {
    const w = { status: 'withdrawn' as const, deciderKind: 'client' as const, deciderUserId: undefined };
    expect(kindedDecisionNoticeServed('decision.published', published('T'), w, 'pmc', 'u-pmc')).toBe(false);
    expect(kindedDecisionNoticeServed('decision.forwarded', { eventType: 'decision.forwarded', payload: {}, effectKey: 'decision.forwarded' }, w, 'pmc', 'u-pmc')).toBe(false);
    expect(kindedDecisionNoticeServed('decision.withdrawn', withdrawn('T', 'R'), w, 'pmc', 'u-pmc')).toBe(true);
  });

  it('a pending approval demand keeps the kind-less audience: pmc and the decider, not another viewer of the decision', () => {
    expect(kindedDecisionNoticeServed('decision.published', published('T'), pending, 'pmc', 'u-pmc')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.published', published('T'), pending, 'client', 'u-client')).toBe(true);
    expect(kindedDecisionNoticeServed('decision.published', published('T'), memberHeld, 'engineer', 'u-eng')).toBe(true);
    // a consultee may see the decision, but is not asked to approve it
    expect(kindedDecisionNoticeServed('decision.published', published('T'), memberHeld, 'engineer', 'u-other')).toBe(false);
    expect(kindedDecisionNoticeServed('decision.published', published('T'), memberHeld, 'client', 'u-client')).toBe(false);
  });

  // #651's review, finding 4117114385 — the audience is the DECISION's to say, not the event key's
  it('a notice whose catalog key disagrees with the decision is served to no one', () => {
    // a PENDING decision's notice emitted under the record key: not a team-visible record
    const recordKeyOnPending = published('T', 'decision.published.record');
    for (const [role, user] of [['pmc', 'u-pmc'], ['engineer', 'u-eng'], ['engineer', 'u-other'], ['client', 'u-client']] as const) {
      expect(kindedDecisionNoticeServed('decision.published', recordKeyOnPending, memberHeld, role, user), `${role}/${user}`).toBe(false);
    }
    // and a RECORD's notice emitted under the demand key: not a demand
    const recorded = { status: 'recorded' as const, deciderKind: 'none' as const, deciderUserId: undefined };
    expect(kindedDecisionNoticeServed('decision.published', published('T'), recorded, 'pmc', 'u-pmc')).toBe(false);
  });

  it('a record demands nothing and reaches everyone who may see it', () => {
    const recorded = { status: 'recorded' as const, deciderKind: 'none' as const, deciderUserId: undefined };
    expect(kindedDecisionNoticeServed('decision.published', published('T', 'decision.published.record'), recorded, 'contractor', 'u-con')).toBe(true);
  });
});
