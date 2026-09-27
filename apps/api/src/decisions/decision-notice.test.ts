import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONABLE_DECISION_NOTICE_KINDS, kindedDecisionNoticeServed, renderKindedDecisionNotice } from './decision-notice';
import {
  PENDING_DECISION_NOTICE_COLOR,
  RECORDED_DECISION_NOTICE_COLOR,
  WITHDRAWN_DECISION_NOTICE_COLOR,
  pendingDecisionNotice,
  recordedDecisionNotice,
  withdrawnDecisionNotice,
} from '../domain/notifications';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4c — the RENDERER TRIPWIRE (§A.3 obligation 7): a kinded notice is
 * rendered from its kind and event, and the rendering must equal what the delivered writer caches in
 * `text`/`color` for the same act, so the kinded path and the kind-less cache cannot disagree.
 */
const published = (title: string, effectKey = 'decision.published') => ({ eventType: 'decision.published', payload: { title }, effectKey });
const withdrawn = (title: string, reason: string) => ({ eventType: 'decision.withdrawn', payload: { title, reason, pushIntentsCancelled: 0 }, effectKey: 'decision.withdrawn' });

describe('the kinded decision notice renderer (4d-ii-a / A4c)', () => {
  it('renders each arm exactly as its writer caches it', () => {
    expect(renderKindedDecisionNotice('decision.published', published('Kitchen counter')))
      .toEqual({ text: pendingDecisionNotice('Kitchen counter'), color: PENDING_DECISION_NOTICE_COLOR });
    expect(renderKindedDecisionNotice('decision.published', published('Stair rail', 'decision.published.record')))
      .toEqual({ text: recordedDecisionNotice('Stair rail'), color: RECORDED_DECISION_NOTICE_COLOR });
    expect(renderKindedDecisionNotice('decision.withdrawn', withdrawn('Kitchen counter', 'Client changed scope')))
      .toEqual({ text: withdrawnDecisionNotice('Kitchen counter', 'Client changed scope'), color: WITHDRAWN_DECISION_NOTICE_COLOR });
  });

  it('the strings and colours are today\'s, character for character (the cache every kind-less row carries)', () => {
    expect(renderKindedDecisionNotice('decision.published', published('X'))).toEqual({ text: 'Decision awaiting approval: X', color: '#C08A2D' });
    expect(renderKindedDecisionNotice('decision.published', published('X', 'decision.published.record'))).toEqual({ text: 'Issue recorded: X', color: '#6B665C' });
    expect(renderKindedDecisionNotice('decision.withdrawn', withdrawn('X', 'R'))).toEqual({ text: 'Decision withdrawn: X — R', color: '#6B665C' });
  });

  it('renders NOTHING it has no arm for, and never trusts a kind that disagrees with its event', () => {
    for (const kind of ['decision.approved', 'decision.reapproved', 'decision.forwarded', 'decision.awaiting_countersign', 'decision.change_requested', 'decision.consultation_requested', 'x.y']) {
      expect(renderKindedDecisionNotice(kind, { eventType: kind, payload: { title: 'T' }, effectKey: kind }), kind).toBeNull();
    }
    expect(renderKindedDecisionNotice('decision.published', { ...published('T'), eventType: 'decision.withdrawn' })).toBeNull();
    expect(renderKindedDecisionNotice('decision.published', { eventType: 'decision.published', payload: {}, effectKey: 'decision.published' })).toBeNull();
    expect(renderKindedDecisionNotice('decision.withdrawn', { eventType: 'decision.withdrawn', payload: { title: 'T' }, effectKey: 'decision.withdrawn' })).toBeNull();
  });

  it('the ACTIONABLE set is exactly the four kinds that ask for an act', () => {
    expect([...ACTIONABLE_DECISION_NOTICE_KINDS].sort()).toEqual([
      'decision.awaiting_countersign', 'decision.change_requested', 'decision.forwarded', 'decision.published',
    ]);
  });

  it('the delivered decision writers cache with the SAME colour constants the renderer reads', () => {
    const src = readFileSync(join(__dirname, 'decisions.service.ts'), 'utf8');
    const creates = [...src.matchAll(/tx\.notification\.create\(\{ data: \{[^}]*\} \}\)/g)].map((m) => m[0]);
    expect(creates.length).toBe(4);
    // the three notices with a renderer arm name their colour by constant; the green approved notice
    // (rendered from its revision from A7) is the one literal left
    expect(creates.filter((c) => /PENDING_DECISION_NOTICE_COLOR|RECORDED_DECISION_NOTICE_COLOR|WITHDRAWN_DECISION_NOTICE_COLOR/.test(c))).toHaveLength(3);
    expect(creates.filter((c) => /'#[0-9A-Fa-f]{6}'/.test(c))).toEqual([expect.stringContaining('#3F7A54')]);
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

  it('a record demands nothing and reaches everyone who may see it', () => {
    const recorded = { status: 'recorded' as const, deciderKind: 'none' as const, deciderUserId: undefined };
    expect(kindedDecisionNoticeServed('decision.published', published('T', 'decision.published.record'), recorded, 'contractor', 'u-con')).toBe(true);
  });
});
