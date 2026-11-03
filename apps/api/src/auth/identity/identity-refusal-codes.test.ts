/**
 * Redbracket ID A5 — every refusal of the switched-on email sign-in and password setup carries its machine `code`
 * (@vitan/shared `IDENTITY_REFUSAL_CODES`) beside an unchanged status and English message, so the web words it from the
 * code. A wrong password and "unavailable" carry none (the web's default words already fit them).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTITY_REFUSAL_CODES } from '@vitan/shared';
import {
  EMAIL_UNVERIFIED, INVITE_PENDING, ISSUER_ACCOUNT_EXISTS, NEEDS_HELP, NO_PROJECT, PASSWORD_CHANGED, PASSWORD_REJECTED, TEST_ACCOUNT,
  refusedSetup, refusedSignIn,
} from './identity-sign-in.service';
import { retiredRefusal } from '../auth.service';

const C = IDENTITY_REFUSAL_CODES;
const rows: Array<[string, string]> = [
  [NO_PROJECT, C.noProject],
  [INVITE_PENDING, C.invitePending],
  [TEST_ACCOUNT, C.testAccount],
  [EMAIL_UNVERIFIED, C.emailUnverified],
  [PASSWORD_CHANGED, C.passwordChanged],
  [NEEDS_HELP, C.needsHelp],
  [ISSUER_ACCOUNT_EXISTS, C.issuerAccountExists],
  [PASSWORD_REJECTED, C.passwordRejected],
];

describe('Redbracket ID refusal codes (A5)', () => {
  it('each refusal message carries its own code, with the status and message unchanged', () => {
    for (const [message, code] of rows) {
      expect(refusedSignIn(message).getResponse()).toEqual({ statusCode: 401, message, code });
      expect(refusedSignIn(message).getStatus()).toBe(401);
      expect(refusedSetup(message).getResponse()).toEqual({ statusCode: 400, message, code });
      expect(refusedSetup(message).getStatus()).toBe(400);
    }
  });

  it('every shared code is used by exactly one message (the retired refusal is AuthService\'s own)', () => {
    expect([...rows.map(([, code]) => code), C.retired].sort()).toEqual(Object.values(C).sort());
    expect(retiredRefusal().getStatus()).toBe(401);
    expect(retiredRefusal().getResponse()).toEqual({ statusCode: 401, message: 'This account has moved to Redbracket ID. Sign in with your email and your Redbracket ID password.', code: C.retired });
  });

  it('a message with no code is refused at build time, never sent without one', () => {
    expect(() => refusedSignIn('Invalid email or password')).toThrow(/without a code/);
  });

  it('no refusal in the sign-in service or the session landing is thrown without its code', () => {
    const names = ['NO_PROJECT', 'INVITE_PENDING', 'TEST_ACCOUNT', 'EMAIL_UNVERIFIED', 'PASSWORD_CHANGED', 'NEEDS_HELP', 'ISSUER_ACCOUNT_EXISTS', 'PASSWORD_REJECTED'];
    for (const file of [join(__dirname, 'identity-sign-in.service.ts'), join(__dirname, '..', 'auth.service.ts')]) {
      const source = readFileSync(file, 'utf8');
      for (const name of names) expect(source).not.toMatch(new RegExp(`new \\w+Exception\\(\\s*(?:[^)]*\\?\\s*)?${name}\\b`));
      expect(source).not.toMatch(/Exception\('Redbracket ID did not accept/);
      expect(source).not.toMatch(/new \w+Exception\(RETIRED\)/);
    }
  });
});
