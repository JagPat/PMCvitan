import { describe, it, expect, vi } from 'vitest';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyHubSignature, HUB_SIGNATURE_TOLERANCE_SECONDS, HUB_SIGNATURE_HEADER_MAX, HUB_WEBHOOK_ID_MAX, type HubSignatureInput } from './hub-signature';

// Spies over the real functions, so a test can count the HMACs and comparisons one check makes.
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>();
  return { ...real, createHmac: vi.fn(real.createHmac), timingSafeEqual: vi.fn(real.timingSafeEqual) };
});
const counted = (input: HubSignatureInput) => {
  vi.mocked(createHmac).mockClear();
  vi.mocked(timingSafeEqual).mockClear();
  const verdict = verifyHubSignature(input);
  return { verdict, hmacs: vi.mocked(createHmac).mock.calls.length, compares: vi.mocked(timingSafeEqual).mock.calls.length };
};

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

  it('refuses missing and malformed headers, and a stale or future timestamp, before any HMAC', () => {
    const refused = (over: Partial<HubSignatureInput>, reason: string, label: string) =>
      expect(counted(spec(over)), label).toEqual({ verdict: { ok: false, reason }, hmacs: 0, compares: 0 });
    for (const over of [{ id: undefined }, { timestamp: undefined }, { signature: undefined }, { id: '' }, { timestamp: '' }, { signature: '' },
      { id: [] }, { timestamp: [] }, { signature: [] }] as Partial<HubSignatureInput>[]) refused(over, 'missing_header', JSON.stringify(over));
    for (const id of ['msg.1', 'msg 1', 'msg\t1', 'msg_é', 'x'.repeat(HUB_WEBHOOK_ID_MAX + 1)]) refused({ id }, 'malformed_id', id);
    expect(verifyHubSignature(spec({ id: 'x'.repeat(HUB_WEBHOOK_ID_MAX) })).ok).toBe(false);
    for (const timestamp of ['-1614265330', '1614265330.5', '1e9', ' 1614265330', '0x60374f72', '1'.repeat(13)]) refused({ timestamp }, 'malformed_timestamp', timestamp);
    refused({ now: at(T + 301) }, 'stale', 'stale');
    refused({ now: at(T - 301) }, 'future', 'future');
    for (const signature of ['g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=', 'v1', 'v1,', ',abc', `${SPEC.signature} ${'v1,A'.repeat(600)}`,
      // entries are separated by single spaces only; a tab makes one malformed entry
      `v1,${'A'.repeat(43)}=\t${SPEC.signature}`]) refused({ signature }, 'malformed_signature', signature.slice(0, 20));
    expect(`${SPEC.signature} ${'v1,A'.repeat(600)}`.length).toBeGreaterThan(HUB_SIGNATURE_HEADER_MAX);
    // a list with no v1 entry has nothing to compare
    refused({ signature: `v2,${SPEC.signature.slice(3)}` }, 'no_match', 'no v1');
    // an unpadded v1 entry is not 32 bytes of base64, so it never counts
    refused({ signature: `v1,${SPEC.signature.slice(3, -1)}` }, 'no_match', 'unpadded');
  });

  it('compares every v1 entry with every secret, with no early exit, whether or not one matches', () => {
    const [a, b] = [randomBytes(32), randomBytes(32)];
    const other = sign(randomBytes(32), SPEC.id, SPEC.timestamp, SPEC.body);
    const skipped = `v1a,${'A'.repeat(86)}==`;
    // the first entry matches the first secret, and every pair is still compared
    expect(counted(spec({ signature: `${SPEC.signature} ${other} ${skipped}`, secrets: [SPEC.secret, a, b] })))
      .toEqual({ verdict: { ok: true }, hmacs: 3, compares: 6 });
    expect(counted(spec({ signature: `${other} ${SPEC.signature}`, secrets: [a, b, SPEC.secret] })))
      .toEqual({ verdict: { ok: true }, hmacs: 3, compares: 6 });
    expect(counted(spec({ signature: `${other} ${other} ${other}`, secrets: [a, b] })))
      .toEqual({ verdict: { ok: false, reason: 'no_match' }, hmacs: 2, compares: 6 });
    // each comparison is of two 32-byte buffers
    for (const [x, y] of vi.mocked(timingSafeEqual).mock.calls) expect([(x as Buffer).length, (y as Buffer).length]).toEqual([32, 32]);
  });

  it('refuses a repeated header, as an array or joined with ", ", before any HMAC', () => {
    const repeated = (over: Partial<HubSignatureInput>, label: string) =>
      expect(counted(spec(over)), label).toEqual({ verdict: { ok: false, reason: 'repeated_header' }, hmacs: 0, compares: 0 });
    const bad = sign(randomBytes(32), SPEC.id, SPEC.timestamp, SPEC.body);
    repeated({ id: [SPEC.id, SPEC.id] }, 'id array');
    repeated({ timestamp: [SPEC.timestamp, SPEC.timestamp] }, 'timestamp array');
    repeated({ signature: [bad, SPEC.signature] }, 'signature array');
    repeated({ signature: [SPEC.signature, bad] }, 'signature array, valid first');
    repeated({ id: `${SPEC.id}, ${SPEC.id}` }, 'id joined');
    repeated({ timestamp: `${SPEC.timestamp}, ${SPEC.timestamp}` }, 'timestamp joined');
    repeated({ signature: `${bad}, ${SPEC.signature}` }, 'signature joined, valid last');
    repeated({ signature: `${SPEC.signature}, ${bad}` }, 'signature joined, valid first');
    // one value in an array is that value
    expect(verifyHubSignature(spec({ id: [SPEC.id], timestamp: [SPEC.timestamp], signature: [SPEC.signature] }))).toEqual({ ok: true });
  });

  it('over a real HTTP request: once passes, and each header sent twice is refused, from req.headers and req.headersDistinct', async () => {
    const bad = sign(randomBytes(32), SPEC.id, SPEC.timestamp, SPEC.body);
    const seen: Array<{ headers: IncomingHttpHeaders; distinct: Record<string, string[]>; body: Buffer }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, distinct: req.headersDistinct as Record<string, string[]>, body: Buffer.concat(chunks) });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const send = (headers: Record<string, string | string[]>) => new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(SPEC.body);
    });
    const once = { 'webhook-id': SPEC.id, 'webhook-timestamp': SPEC.timestamp, 'webhook-signature': SPEC.signature };
    try {
      await send(once);
      await send({ ...once, 'webhook-id': [SPEC.id, SPEC.id] });
      await send({ ...once, 'webhook-timestamp': [SPEC.timestamp, SPEC.timestamp] });
      await send({ ...once, 'webhook-signature': [bad, SPEC.signature] });
      await send({ ...once, 'webhook-signature': [SPEC.signature, bad] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const verdicts = seen.map(({ headers, distinct, body }) => [
      verifyHubSignature({ id: headers['webhook-id'], timestamp: headers['webhook-timestamp'], signature: headers['webhook-signature'], body, secrets: [SPEC.secret], now: at(T) }),
      verifyHubSignature({ id: distinct['webhook-id'], timestamp: distinct['webhook-timestamp'], signature: distinct['webhook-signature'], body, secrets: [SPEC.secret], now: at(T) }),
    ]);
    const refused = { ok: false, reason: 'repeated_header' };
    expect(verdicts).toEqual([[{ ok: true }, { ok: true }], [refused, refused], [refused, refused], [refused, refused], [refused, refused]]);
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
