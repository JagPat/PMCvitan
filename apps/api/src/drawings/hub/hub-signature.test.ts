import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyHubSignature, HUB_SIGNATURE_TOLERANCE_SECONDS, HUB_SIGNATURE_HEADER_MAX, HUB_WEBHOOK_ID_MAX, type HubSignatureInput } from './hub-signature';

// The Standard Webhooks specification's published test vector (a public example secret, not a Hub secret).
const SPEC = {
  secret: Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64'),
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: Buffer.from('{"test": 2432232314}'),
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const at = (seconds: number) => new Date(seconds * 1000);
const T = Number(SPEC.timestamp);
const spec = (over: Partial<HubSignatureInput> = {}): HubSignatureInput => ({
  id: SPEC.id, timestamp: SPEC.timestamp, signature: SPEC.signature, body: SPEC.body, secrets: [SPEC.secret], now: at(T), ...over,
});
const sign = (secret: Buffer, id: string, timestamp: string, body: Buffer) =>
  `v1,${createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body])).digest('base64')}`;

describe('#1118 U2 — Hub webhook signature (Standard Webhooks v1)', () => {
  it('accepts the specification test vector', () => {
    expect(sign(SPEC.secret, SPEC.id, SPEC.timestamp, SPEC.body)).toBe(SPEC.signature);
    expect(verifyHubSignature(spec())).toEqual({ ok: true });
  });

  it('refuses a changed body, id or timestamp', () => {
    expect(verifyHubSignature(spec({ body: Buffer.from('{"test": 2432232315}') }))).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyHubSignature(spec({ body: Buffer.concat([SPEC.body, Buffer.from(' ')]) }))).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyHubSignature(spec({ body: Buffer.alloc(0) }))).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyHubSignature(spec({ id: `${SPEC.id}x` }))).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyHubSignature(spec({ timestamp: String(T + 1), now: at(T + 1) }))).toEqual({ ok: false, reason: 'no_match' });
  });

  it('signs the body bytes as received, never a re-encoded string', () => {
    const secret = randomBytes(32);
    const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]); // not valid UTF-8
    const signature = sign(secret, 'msg_1', SPEC.timestamp, body);
    expect(verifyHubSignature(spec({ id: 'msg_1', signature, body, secrets: [secret] }))).toEqual({ ok: true });
    expect(verifyHubSignature(spec({ id: 'msg_1', signature, body: Buffer.from(body.toString('utf8')), secrets: [secret] })))
      .toEqual({ ok: false, reason: 'no_match' });
  });

  it('allows five minutes of clock difference either side, and no more', () => {
    expect(HUB_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const tol = 300;
    expect(verifyHubSignature(spec({ now: at(T + tol) }))).toEqual({ ok: true });
    expect(verifyHubSignature(spec({ now: at(T - tol) }))).toEqual({ ok: true });
    // within the same second still counts as that second
    expect(verifyHubSignature(spec({ now: new Date((T + tol) * 1000 + 999) }))).toEqual({ ok: true });
    expect(verifyHubSignature(spec({ now: at(T + tol + 1) }))).toEqual({ ok: false, reason: 'stale' });
    expect(verifyHubSignature(spec({ now: at(T - tol - 1) }))).toEqual({ ok: false, reason: 'future' });
    expect(verifyHubSignature(spec({ now: at(T + 86_400) }))).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses the wrong secret, and no secret at all', () => {
    expect(verifyHubSignature(spec({ secrets: [randomBytes(24)] }))).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyHubSignature(spec({ secrets: [] }))).toEqual({ ok: false, reason: 'no_match' });
  });

  it('rotation: the old and the new secret both pass while both are configured, and only those', () => {
    const [old, next, other] = [randomBytes(32), randomBytes(32), randomBytes(32)];
    const byOld = sign(old, 'msg_r', SPEC.timestamp, SPEC.body);
    const byNext = sign(next, 'msg_r', SPEC.timestamp, SPEC.body);
    const byOther = sign(other, 'msg_r', SPEC.timestamp, SPEC.body);
    const check = (signature: string, secrets: Buffer[]) => verifyHubSignature(spec({ id: 'msg_r', signature, secrets })).ok;
    expect([check(byOld, [old, next]), check(byNext, [old, next]), check(byOther, [old, next])]).toEqual([true, true, false]);
    // Hub may send both signatures in one header during its own overlap; one match is enough, in either order
    expect(check(`${byOther} ${byNext}`, [next])).toBe(true);
    expect(check(`${byNext} ${byOther}`, [next])).toBe(true);
    // after the old secret is removed, only the new one passes
    expect([check(byOld, [next]), check(byNext, [next])]).toEqual([false, true]);
  });

  it('counts only v1 entries; other versions are skipped, and a list with none is no match', () => {
    expect(verifyHubSignature(spec({ signature: `v1a,${'A'.repeat(86)}== ${SPEC.signature}` }))).toEqual({ ok: true });
    expect(verifyHubSignature(spec({ signature: `v2,${SPEC.signature.slice(3)}` }))).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyHubSignature(spec({ signature: `  ${SPEC.signature}  ` }))).toEqual({ ok: true });
    // a v1 entry that is not 32 bytes of base64 can never match
    expect(verifyHubSignature(spec({ signature: `v1,${SPEC.signature.slice(3, -2)}` }))).toEqual({ ok: false, reason: 'no_match' });
  });

  it('refuses missing, repeated and malformed headers before any HMAC', () => {
    for (const over of [{ id: undefined }, { timestamp: undefined }, { signature: undefined }, { id: '' }, { timestamp: '' }, { signature: '' },
      { id: [SPEC.id, SPEC.id] }, { timestamp: [SPEC.timestamp] }, { signature: [SPEC.signature] }] as Partial<HubSignatureInput>[]) {
      expect(verifyHubSignature(spec(over)), JSON.stringify(over)).toEqual({ ok: false, reason: 'missing_header' });
    }
    for (const id of ['msg.1', 'msg 1', 'msg\t1', 'msg_é', 'x'.repeat(HUB_WEBHOOK_ID_MAX + 1)]) {
      expect(verifyHubSignature(spec({ id })), id).toEqual({ ok: false, reason: 'malformed_id' });
    }
    expect(verifyHubSignature(spec({ id: 'x'.repeat(HUB_WEBHOOK_ID_MAX) })).ok).toBe(false);
    for (const timestamp of ['-1614265330', '1614265330.5', '1e9', ' 1614265330', '0x60374f72', '1'.repeat(13)]) {
      expect(verifyHubSignature(spec({ timestamp })), timestamp).toEqual({ ok: false, reason: 'malformed_timestamp' });
    }
    for (const signature of ['g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=', 'v1', 'v1,', ',abc', `${SPEC.signature} ${'v1,A'.repeat(600)}`]) {
      expect(verifyHubSignature(spec({ signature })), signature.slice(0, 20)).toEqual({ ok: false, reason: 'malformed_signature' });
    }
    expect(`${SPEC.signature} ${'v1,A'.repeat(600)}`.length).toBeGreaterThan(HUB_SIGNATURE_HEADER_MAX);
  });

  it('a verdict carries a reason only, never a header value, signature or secret', () => {
    const secret = randomBytes(32);
    for (const over of [{}, { secrets: [secret] }, { now: at(T + 10_000) }, { id: 'msg.1' }]) {
      const verdict = JSON.stringify(verifyHubSignature(spec(over)));
      for (const value of [SPEC.id, SPEC.signature.slice(3), SPEC.secret.toString('base64'), secret.toString('base64'), SPEC.timestamp]) {
        expect(verdict).not.toContain(value);
      }
    }
  });
});
