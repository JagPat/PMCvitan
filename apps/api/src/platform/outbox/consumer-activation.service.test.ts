import { describe, it, expect } from 'vitest';
import { OutboxConsumerActivationService } from './consumer-activation.service';

/**
 * Phase 6 task 4d-ii-a / A6b — the `outbox:consumer` SURFACE (the companion document, "The register"
 * and P-A7 / P-A10's surface arms): zod trims and requires length ≥ 1 for the three caller-supplied
 * strings, and refuses a reserved or migration-shaped retry identity before any database read.
 */
describe('outbox:consumer — the operator surface (4d-ii-a / A6b)', () => {
  const ok = { consumer: 'webpush.notify', active: false, reason: 'paused for the probe', actorId: 'ops@vitan.in', requestToken: 'e7b1-1' };
  const WS = [' ', '\t', '\u000B', '\f', '\r', '\n', ''];

  it('a well-formed request parses, trimmed', () => {
    expect(OutboxConsumerActivationService.parse({ ...ok, reason: '  paused  ', actorId: ' ops ', requestToken: ' t1 ' }))
      .toEqual({ ...ok, reason: 'paused', actorId: 'ops', requestToken: 't1' });
  });

  it('a blank reason, actorId or requestToken is refused, naming the field', () => {
    for (const ws of WS) {
      expect(() => OutboxConsumerActivationService.parse({ ...ok, reason: ws })).toThrow(/reason/);
      expect(() => OutboxConsumerActivationService.parse({ ...ok, actorId: ws })).toThrow(/actorId/);
      expect(() => OutboxConsumerActivationService.parse({ ...ok, requestToken: ws })).toThrow(/requestToken/);
    }
  });

  it('a reserved `sys:` token and a migration-shaped token are refused at the surface (P-A10)', () => {
    expect(() => OutboxConsumerActivationService.parse({ ...ok, requestToken: 'sys:anything' })).toThrow(/reserved `sys:` prefix/);
    expect(() => OutboxConsumerActivationService.parse({ ...ok, requestToken: '20271228000000_phase6_t4d_ii_a6a_activation_register' })).toThrow(/migration name/);
  });

  it('active must be a boolean and consumer a name', () => {
    expect(() => OutboxConsumerActivationService.parse({ ...ok, active: 'false' })).toThrow(/active/);
    expect(() => OutboxConsumerActivationService.parse({ ...ok, consumer: '' })).toThrow(/consumer/);
  });
});
