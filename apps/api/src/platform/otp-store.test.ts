import { describe, it, expect } from 'vitest';
import { OtpStore } from './otp-store';

describe('OtpStore', () => {
  it('verifies a correct code once, then it is consumed', () => {
    const s = new OtpStore(60_000);
    s.put('k', '1234');
    expect(s.verify('k', '1234')).toBe(true);
    expect(s.verify('k', '1234')).toBe(false); // single-use
  });

  it('burns the code after too many wrong attempts (brute-force cap)', () => {
    const s = new OtpStore(60_000, 0, 3); // no throttle, max 3 attempts
    s.put('k', '1234');
    expect(s.verify('k', '0000')).toBe(false); // 1
    expect(s.verify('k', '0001')).toBe(false); // 2
    expect(s.verify('k', '0002')).toBe(false); // 3 → burned
    expect(s.verify('k', '1234')).toBe(false); // correct, but code was invalidated
  });

  it('throttles a re-send within the window, allows after it', () => {
    const s = new OtpStore(60_000, 30_000);
    expect(s.canSend('k')).toBe(true);
    s.put('k', '1234');
    expect(s.canSend('k')).toBe(false); // within throttle window
    const s2 = new OtpStore(60_000, 0); // zero window → always allowed
    s2.put('k', '1');
    expect(s2.canSend('k')).toBe(true);
  });

  it('rejects an expired code and an unknown key', () => {
    const s = new OtpStore(-1); // already expired
    s.put('k', '1234');
    expect(s.verify('k', '1234')).toBe(false);
    expect(new OtpStore(60_000).verify('missing', '1234')).toBe(false);
  });

  it('markSent tracks throttle without a verifiable code (remote channels)', () => {
    const s = new OtpStore(60_000, 30_000);
    s.markSent('k');
    expect(s.canSend('k')).toBe(false);       // throttled
    expect(s.verify('k', '')).toBe(false);    // empty code never verifies
    expect(s.verify('k', '1234')).toBe(false);
  });
});
