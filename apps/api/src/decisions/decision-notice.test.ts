import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONABLE_DECISION_NOTICE_KINDS, kindedDecisionNoticeServed, kindedNoticeRevisionId, renderKindedDecisionNotice } from './decision-notice';
import {
  APPROVED_DECISION_NOTICE_COLOR,
  PENDING_DECISION_NOTICE_COLOR,
  RECORDED_DECISION_NOTICE_COLOR,
  WITHDRAWN_DECISION_NOTICE_COLOR,
  approvedDecisionNotice,
  pendingDecisionNotice,
  recordedDecisionNotice,
  withdrawnDecisionNotice,
} from '../domain/notifications';

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
  ['dar-D1-v1', { material: 'Granite', onBehalfOf: null }],
  ['dar-D1-v2', { material: 'Quartz', onBehalfOf: 'client' }],
]);

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
    expect(renderKindedDecisionNotice('decision.approved', approved(), revisions))
      .toEqual({ text: approvedDecisionNotice({ actorName: 'Client One', actorRole: 'client', title: 'Kitchen counter', material: 'Granite', deciderKind: 'client', onBehalfOf: null }), color: APPROVED_DECISION_NOTICE_COLOR });
    expect(renderKindedDecisionNotice('decision.reapproved', approved({ kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client', actorRole: 'pmc', actorName: 'Ar. Meghna' }), revisions))
      .toEqual({ text: approvedDecisionNotice({ actorName: 'Ar. Meghna', actorRole: 'pmc', title: 'Kitchen counter', material: 'Quartz', deciderKind: 'client', onBehalfOf: 'client' }), color: APPROVED_DECISION_NOTICE_COLOR });
  });

  it('the green notice, character for character (the three announcement shapes the delivered approve wrote inline)', () => {
    expect(renderKindedDecisionNotice('decision.approved', approved(), revisions)?.text).toBe('Client approved Kitchen counter — Granite');
    expect(renderKindedDecisionNotice('decision.approved', approved({ deciderKind: 'member', actorRole: 'engineer', actorName: 'Ravi' }), revisions)?.text).toBe('Ravi approved Kitchen counter — Granite');
    expect(renderKindedDecisionNotice('decision.reapproved', approved({ kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client', actorRole: 'pmc', actorName: 'Ar. Meghna' }), revisions))
      .toEqual({ text: 'Ar. Meghna (PMC) approved Kitchen counter on behalf of the client — Quartz', color: '#3F7A54' });
    expect(approvedDecisionNotice({ actorName: 'Ar. Meghna', actorRole: 'pmc', title: 'T', material: 'M', deciderKind: 'member', onBehalfOf: 'member' })).toBe('Ar. Meghna (PMC) approved T on behalf of the named decider — M');
  });

  it('the green notice renders ITS revision, never the head, and nothing without the revision, the envelope or the payload facts', () => {
    // a twice-approved decision: the older notice keeps its own option and approver
    const older = approved();
    const newer = approved({ kind: 'decision.reapproved', revisionId: 'dar-D1-v2', onBehalfOf: 'client', actorRole: 'pmc', actorName: 'Ar. Meghna' });
    expect(renderKindedDecisionNotice('decision.approved', older, revisions)?.text).toContain('Granite');
    expect(renderKindedDecisionNotice('decision.reapproved', newer, revisions)?.text).toContain('Quartz');
    expect(kindedNoticeRevisionId('decision.approved', older)).toBe('dar-D1-v1');
    expect(kindedNoticeRevisionId('decision.reapproved', newer)).toBe('dar-D1-v2');
    expect(kindedNoticeRevisionId('decision.published', published('T'))).toBeNull();
    expect(kindedNoticeRevisionId('decision.approved', { ...older, eventType: 'decision.reapproved' })).toBeNull();
    // the revision the event names is not in the snapshot (or the event names none): nothing
    expect(renderKindedDecisionNotice('decision.approved', approved({ revisionId: 'dar-D1-v9' }), revisions)).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', approved(), new Map())).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', approved())).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', { ...approved(), payload: { option: 'Option A', material: 'Granite' } }, revisions), 'a previous-release payload').toBeNull();
    // a previous-release event through the drain carries no envelope: no kinded rendering
    expect(renderKindedDecisionNotice('decision.approved', approved({ actorRole: null, actorName: null }), revisions)).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', { ...approved(), payload: { ...approved().payload, title: '' } }, revisions)).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', { ...approved(), payload: { ...approved().payload, deciderKind: undefined } }, revisions)).toBeNull();
  });

  it('the strings and colours are today\'s, character for character (the cache every kind-less row carries)', () => {
    expect(renderKindedDecisionNotice('decision.published', published('X'))).toEqual({ text: 'Decision awaiting approval: X', color: '#C08A2D' });
    expect(renderKindedDecisionNotice('decision.published', published('X', 'decision.published.record'))).toEqual({ text: 'Issue recorded: X', color: '#6B665C' });
    expect(renderKindedDecisionNotice('decision.withdrawn', withdrawn('X', 'R'))).toEqual({ text: 'Decision withdrawn: X — R', color: '#6B665C' });
  });

  it('renders NOTHING it has no arm for, and never trusts a kind that disagrees with its event', () => {
    for (const kind of ['decision.drafted', 'decision.forwarded', 'decision.awaiting_countersign', 'decision.change_requested', 'decision.consultation_requested', 'x.y']) {
      expect(renderKindedDecisionNotice(kind, { eventType: kind, payload: { title: 'T' }, effectKey: kind, ...envelope }, revisions), kind).toBeNull();
    }
    expect(renderKindedDecisionNotice('decision.published', { ...published('T'), eventType: 'decision.withdrawn' })).toBeNull();
    expect(renderKindedDecisionNotice('decision.approved', { ...approved(), eventType: 'decision.reapproved' }, revisions)).toBeNull();
    expect(renderKindedDecisionNotice('decision.published', { eventType: 'decision.published', payload: {}, effectKey: 'decision.published', ...envelope })).toBeNull();
    expect(renderKindedDecisionNotice('decision.withdrawn', { eventType: 'decision.withdrawn', payload: { title: 'T' }, effectKey: 'decision.withdrawn', ...envelope })).toBeNull();
  });

  it('the ACTIONABLE set is exactly the four kinds that ask for an act', () => {
    expect([...ACTIONABLE_DECISION_NOTICE_KINDS].sort()).toEqual([
      'decision.awaiting_countersign', 'decision.change_requested', 'decision.forwarded', 'decision.published',
    ]);
  });

  it('the delivered decision writers cache with the SAME colour constants the renderer reads, and every one is KINDED (A7a)', () => {
    const src = readFileSync(join(__dirname, 'decisions.service.ts'), 'utf8');
    const creates = [...src.matchAll(/tx\.notification\.create\(\{ data: \{[^}]*\} \}\)/g)].map((m) => m[0]);
    expect(creates.length).toBe(4);
    // every notice names its colour by the constant its renderer arm reads; no literal is left
    expect(creates.filter((c) => /PENDING_DECISION_NOTICE_COLOR|RECORDED_DECISION_NOTICE_COLOR|WITHDRAWN_DECISION_NOTICE_COLOR|APPROVED_DECISION_NOTICE_COLOR/.test(c))).toHaveLength(4);
    expect(creates.filter((c) => /'#[0-9A-Fa-f]{6}'/.test(c))).toEqual([]);
    // 4d-ii-a / A7a — every decisions notice writer stamps the event it announces and its kind (the
    // binding pair; the seal refuses one half without the other), the event emitted first in the
    // same transaction with the id the writer minted (`emitEvent(..., { eventId, ... })`)
    for (const c of creates) {
      expect(c, c).toMatch(/kind: /);
      expect(c, c).toMatch(/eventId \}/);
    }
    expect(src.match(/const eventId = randomUUID\(\);/g)).toHaveLength(4);
    expect(src.match(/emitEvent\(tx, \{\n\s+projectId, actor, eventId,/g)).toHaveLength(4);
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
