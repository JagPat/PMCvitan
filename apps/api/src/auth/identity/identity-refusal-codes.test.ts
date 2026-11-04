/**
 * Redbracket ID A5 — every refusal of the switched-on email sign-in and password setup carries its machine `code`
 * (@vitan/shared `IDENTITY_REFUSAL_CODES`) beside an unchanged status and English message, so the web words it from the
 * code. A wrong password and "unavailable" carry none (the web's default words already fit them).
 */
import { readFileSync, readdirSync } from 'node:fs';
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

  // What the source pins below prove, and no more: inside apps/api/src, every coded message text lives once (its
  // declaration), the sign-in service builds no exception other than the three coded helpers and the listed uncoded
  // ones, each coded name is only declared, mapped or handed to a coded helper, and the session landing sends RETIRED
  // and NO_PROJECT only through their coded builders. A refusal that still escaped them would reach the web with no
  // code, and the web would then show today's words for it (see the web's no-code fallback test), never a wrong reason.
  const SRC = join(__dirname, '..', '..');
  const SERVICE = join(__dirname, 'identity-sign-in.service.ts');
  const LANDING = join(__dirname, '..', 'auth.service.ts');
  const productionFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return productionFiles(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.spec.ts') ? [path] : [];
  });
  const RETIRED_TEXT = 'This account has moved to Redbracket ID. Sign in with your email and your Redbracket ID password.';
  const CODED_NAMES = ['NO_PROJECT', 'INVITE_PENDING', 'TEST_ACCOUNT', 'EMAIL_UNVERIFIED', 'PASSWORD_CHANGED', 'NEEDS_HELP', 'ISSUER_ACCOUNT_EXISTS', 'PASSWORD_REJECTED'];

  it('each coded message text is written once in the API source: its declaration, never a pasted copy', () => {
    const sources = productionFiles(SRC).map((f) => readFileSync(f, 'utf8'));
    for (const text of [...rows.map(([message]) => message), RETIRED_TEXT]) {
      // the first words of the text, so a copy with a changed ending is caught too
      const probe = text.slice(0, 28);
      const count = sources.reduce((n, src) => n + src.split(probe).length - 1, 0);
      expect({ probe, count }).toEqual({ probe, count: 1 });
    }
  });

  it('the sign-in service builds no exception but the coded helpers and the listed uncoded refusals', () => {
    const source = readFileSync(SERVICE, 'utf8');
    const lines = source.split('\n');
    // an exception class is named only in its import or right after `new` (no alias, no subclass, no factory)
    for (const line of lines) {
      if (/^import /.test(line)) continue;
      expect(line.replace(/new \w+Exception\(/g, '')).not.toMatch(/\b\w+Exception\b/);
    }
    const built = [...source.matchAll(/new (\w+Exception)\(([^\n]*)/g)].map(([, cls, rest]) => `${cls}(${rest.trim()}`).sort();
    expect(built).toEqual([
      'BadRequestException(resetUrl ? { ...coded(400, message), resetUrl } : coded(400, message));',
      'ConflictException(coded(409, message));',
      'HttpException({ statusCode: 429, message: TOO_MANY, retryAfter: attempt.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);',
      'ServiceUnavailableException(UNAVAILABLE);',
      'ServiceUnavailableException(UNAVAILABLE);',
      'ServiceUnavailableException(UNAVAILABLE);',
      'ServiceUnavailableException(UNAVAILABLE);',
      'UnauthorizedException(WRONG_PASSWORD);',
      'UnauthorizedException(coded(401, message));',
    ]);
  });

  it('each coded name is only declared, mapped to its code, or handed straight to a coded helper', () => {
    const lines = readFileSync(SERVICE, 'utf8').split('\n');
    for (const name of CODED_NAMES) {
      const uses = lines.filter((line) => new RegExp(`\\b${name}\\b`).test(line));
      for (const line of uses) {
        const declared = new RegExp(`^export const ${name} = '`).test(line);
        const mapped = new RegExp(`^  \\[${name}, CODE\\.\\w+\\],$`).test(line);
        const handed = new RegExp(`throw refused(?:SignIn|Setup|Conflict)\\([^;]*\\b${name}\\b[^;]*\\);$`).test(line);
        expect({ name, line, ok: declared || mapped || handed }).toEqual({ name, line, ok: true });
      }
      expect(uses.filter((line) => /^export const /.test(line))).toHaveLength(1);
    }
    // no other API file names them, so none can be thrown elsewhere without its code
    for (const file of productionFiles(SRC).filter((f) => f !== SERVICE && f !== LANDING)) {
      const source = readFileSync(file, 'utf8');
      for (const name of CODED_NAMES) expect({ file, name, found: new RegExp(`\\b${name}\\b`).test(source) }).toEqual({ file, name, found: false });
    }
  });

  it('the session landing sends RETIRED and NO_PROJECT only through their coded builders', () => {
    const lines = readFileSync(LANDING, 'utf8').split('\n');
    expect(lines.filter((line) => /\bRETIRED\b/.test(line))).toEqual([
      `const RETIRED = '${RETIRED_TEXT}';`,
      'export const retiredRefusal = () => new UnauthorizedException({ statusCode: 401, message: RETIRED, code: IDENTITY_REFUSAL_CODES.retired });',
    ]);
    const noProject = lines.filter((line) => /\bNO_PROJECT\b/.test(line));
    expect(noProject).toHaveLength(2);
    expect(noProject[0]).toMatch(/^import \{ NO_PROJECT, /);
    expect(noProject[1]).toMatch(/throw refusedSignIn\(NO_PROJECT\);$/);
  });
});
