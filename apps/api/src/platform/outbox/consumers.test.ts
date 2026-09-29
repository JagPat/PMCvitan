import { describe, it, expect, vi } from 'vitest';
import { makePushConsumer, preSendVerdict, type PushClaimDeps, type PushClaimVerdict } from './consumers';
import type { PushService } from '../../push/push.service';
import type { EmittedEventMeta } from './registry';

/**
 * Phase 6 task 4d-ii-a / A7b — the push consumer's PER-RECIPIENT pre-send hook (plan §A.4 (ii)),
 * over fakes: the outcome rule for a subject that leaves before any send, between sends, a stale
 * recipient, every recipient stale, and a canceller's mark. The live arms (the real predicates under
 * the real seals) are in `phase6-t4d-ii-a7b-send-boundary.test.ts`.
 */
function deps(over: Partial<PushClaimDeps> & { verdicts?: PushClaimVerdict[] } = {}) {
  const verdicts = over.verdicts ?? [];
  let call = 0;
  const next = (): PushClaimVerdict => verdicts[Math.min(call++, verdicts.length - 1)] ?? { actionable: true, roles: ['client'] };
  const d: PushClaimDeps = {
    deciderTarget: vi.fn(async () => next()),
    consultationRequestedTarget: vi.fn(async () => next()),
    consultationRespondedTarget: vi.fn(async () => next()),
    forwardTarget: vi.fn(async () => next()),
    countersignTarget: vi.fn(async () => next()),
    markCancelled: vi.fn(async () => {}),
    roleHolderUserIds: vi.fn(async () => ['u-a', 'u-b']),
    cancelled: vi.fn(async () => false),
    userHoldsRole: vi.fn(async () => true),
    ...over,
  };
  return d;
}
const meta = (effectKey: string): EmittedEventMeta => ({
  eventId: 'e1', eventType: 'decision.published', projectId: 'p1', organizationId: 'o1', streamPosition: 1n,
  entityType: 'Decision', entityId: 'd1', payload: null,
  dispatchIntent: { effectKey, coverageVersion: 'v', invalidate: true, push: { body: 'b', roles: ['client'] } } as never,
});
const run = async (d: PushClaimDeps, effectKey = 'decision.published', payload: object = { body: 'decide', roles: ['client'] }) => {
  const sent: string[] = [];
  const push = { notifyTargetedUser: vi.fn(async (_p: string, _payload: unknown, user: string) => { sent.push(user); }), notifyProject: vi.fn() } as unknown as PushService;
  await makePushConsumer(push, d).handle({ delivery: { id: 'del-1', consumer: 'webpush.notify', projectId: 'p1', streamPosition: 1n, payload: payload as never }, meta: meta(effectKey), senderMode: 'outbox' } as never);
  return sent;
};

describe('the pre-send verdict (4d-ii-a / A7b)', () => {
  it('a canceller\'s mark stops the send without a second mark', async () => {
    const d = deps({ cancelled: vi.fn(async () => true) });
    expect(await preSendVerdict(d, { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'decider', recipient: 'u-a', role: 'client' })).toBe('cancelled');
  });
  it('the subject leaving the actionable set DROPS; a re-target SKIPS the displaced recipient; a role no longer named or no longer held SKIPS', async () => {
    expect(await preSendVerdict(deps({ verdicts: [{ actionable: false }] }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'decider', recipient: 'u-a', role: 'client' })).toBe('drop');
    expect(await preSendVerdict(deps({ verdicts: [{ actionable: true, targetUserId: 'u-z' }] }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'decider', recipient: 'u-a', role: null })).toBe('skip');
    expect(await preSendVerdict(deps({ verdicts: [{ actionable: true, targetUserId: 'u-a' }] }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'consultation_requested', recipient: 'u-a', role: null })).toBe('send');
    expect(await preSendVerdict(deps({ verdicts: [{ actionable: true, roles: ['pmc'] }] }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'decider', recipient: 'u-a', role: 'client' })).toBe('skip');
    expect(await preSendVerdict(deps({ userHoldsRole: vi.fn(async () => false) }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'decider', recipient: 'u-a', role: 'client' })).toBe('skip');
    expect(await preSendVerdict(deps(), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'decider', recipient: 'u-a', role: 'client' })).toBe('send');
  });
  it('a user-targeted family re-runs its predicate FOR the recipient', async () => {
    const d = deps({ verdicts: [{ actionable: true, targetUserId: 'u-a' }] });
    await preSendVerdict(d, { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'consultation_responded', recipient: 'u-a', role: null });
    expect(d.consultationRespondedTarget).toHaveBeenCalledWith('p1', 'd1', 'u-a');
  });
});

describe('the push consumer sends per recipient behind the hook (4d-ii-a / A7b)', () => {
  it('a fan-out: every holder passes → every holder sent, no mark', async () => {
    const d = deps();
    expect(await run(d)).toEqual(['u-a', 'u-b']);
    expect(d.markCancelled).not.toHaveBeenCalled();
    // the claim, then one re-judge per recipient
    expect(d.deciderTarget).toHaveBeenCalledTimes(3);
  });
  it('a stale RECIPIENT is skipped without the mark and the others are sent', async () => {
    const d = deps({ userHoldsRole: vi.fn(async (_p: string, user: string) => user !== 'u-a') });
    expect(await run(d)).toEqual(['u-b']);
    expect(d.markCancelled).not.toHaveBeenCalled();
  });
  it('EVERY resolved recipient stale → nothing sent, the delivery marked', async () => {
    const d = deps({ userHoldsRole: vi.fn(async () => false) });
    expect(await run(d)).toEqual([]);
    expect(d.markCancelled).toHaveBeenCalledTimes(1);
  });
  it('the subject leaves BEFORE any send → nothing sent, the delivery marked once', async () => {
    // claim: actionable; first recipient's re-judge: not actionable
    const d = deps({ verdicts: [{ actionable: true, roles: ['client'] }, { actionable: false }] });
    expect(await run(d)).toEqual([]);
    expect(d.markCancelled).toHaveBeenCalledTimes(1);
  });
  it('the subject leaves BETWEEN sends → the remaining recipients skipped, NO mark', async () => {
    const d = deps({ verdicts: [{ actionable: true, roles: ['client'] }, { actionable: true, roles: ['client'] }, { actionable: false }] });
    expect(await run(d)).toEqual(['u-a']);
    expect(d.markCancelled).not.toHaveBeenCalled();
  });
  it('a canceller marked the row between the claim and the send → nothing sent, the mark not rewritten', async () => {
    let asked = 0;
    const d = deps({ cancelled: vi.fn(async () => asked++ >= 0) });
    expect(await run(d)).toEqual([]);
    expect(d.markCancelled).not.toHaveBeenCalled();
  });
  it('a user-targeted family: the ONE recipient sent when their re-judge passes, marked when it fails', async () => {
    const ok = deps({ verdicts: [{ actionable: true, targetUserId: 'u-t' }] });
    expect(await run(ok, 'decision.consultation_requested', { body: 'asked', roles: ['engineer'], targetUserId: 'u-t' })).toEqual(['u-t']);
    expect(ok.markCancelled).not.toHaveBeenCalled();
    const gone = deps({ verdicts: [{ actionable: true, targetUserId: 'u-t' }, { actionable: false }] });
    expect(await run(gone, 'decision.consultation_requested', { body: 'asked', roles: ['engineer'], targetUserId: 'u-t' })).toEqual([]);
    expect(gone.markCancelled).toHaveBeenCalledTimes(1);
  });
  it('the claim itself not actionable → marked, no recipient resolved', async () => {
    const d = deps({ verdicts: [{ actionable: false }] });
    expect(await run(d)).toEqual([]);
    expect(d.markCancelled).toHaveBeenCalledTimes(1);
    expect(d.roleHolderUserIds).not.toHaveBeenCalled();
  });
});

describe('the FROZEN-audience families send to the frozen set intersected with the current one (4d-ii-a / A7d)', () => {
  const frozen = (family: 'forward' | 'countersign', current: string[], targetUserIds = ['u-a', 'u-b']) =>
    run(deps({ verdicts: [{ actionable: true, targetUserIds: current }] }),
      family === 'forward' ? 'decision.forwarded' : 'decision.awaiting_countersign',
      { body: 'frozen', roles: ['architect'], targetUserId: null, targetUserIds });
  it('every frozen recipient still in the current set is sent; nobody outside the frozen set is, whoever holds the role now', async () => {
    expect(await frozen('countersign', ['u-a', 'u-b', 'u-new'])).toEqual(['u-a', 'u-b']);
    expect(await frozen('forward', ['u-a', 'u-b'])).toEqual(['u-a', 'u-b']);
  });
  it('a frozen recipient who left the current set is skipped without the mark; every one gone → nothing sent, the delivery marked', async () => {
    const d = deps({ verdicts: [{ actionable: true, targetUserIds: ['u-b'] }] });
    expect(await run(d, 'decision.awaiting_countersign', { body: 'frozen', roles: ['architect'], targetUserId: null, targetUserIds: ['u-a', 'u-b'] })).toEqual(['u-b']);
    expect(d.markCancelled).not.toHaveBeenCalled();
    const gone = deps({ verdicts: [{ actionable: true, targetUserIds: [] }] });
    expect(await run(gone, 'decision.forwarded', { body: 'frozen', roles: ['client'], targetUserId: null, targetUserIds: ['u-a'] })).toEqual([]);
    expect(gone.markCancelled).toHaveBeenCalledTimes(1);
  });
  it('the subject leaving the actionable set drops the whole delivery with the mark; the pre-send verdict reads the current set', async () => {
    const d = deps({ verdicts: [{ actionable: false }] });
    expect(await run(d, 'decision.forwarded', { body: 'frozen', roles: ['client'], targetUserId: null, targetUserIds: ['u-a'] })).toEqual([]);
    expect(d.markCancelled).toHaveBeenCalledTimes(1);
    expect(await preSendVerdict(deps({ verdicts: [{ actionable: true, targetUserIds: ['u-a'] }] }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'countersign', recipient: 'u-a', role: null })).toBe('send');
    expect(await preSendVerdict(deps({ verdicts: [{ actionable: true, targetUserIds: ['u-z'] }] }), { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'countersign', recipient: 'u-a', role: null })).toBe('skip');
    const asked = deps({ verdicts: [{ actionable: true, targetUserIds: ['u-a'] }] });
    await preSendVerdict(asked, { deliveryId: 'del-1', projectId: 'p1', decisionId: 'd1', family: 'forward', recipient: 'u-a', role: null });
    expect(asked.forwardTarget).toHaveBeenCalledWith('p1', 'd1');
  });
});
