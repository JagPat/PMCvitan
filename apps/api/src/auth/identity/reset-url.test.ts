/**
 * Unit H: `IDENTITY_RESET_URL`, Redbracket ID's own password reset page. Only an `https://` URL on an allowed host,
 * holding `{loginName}` exactly once and written exactly as it will be sent, is used; anything else is no link.
 */
import { describe, expect, it } from 'vitest';
import { isRedbracketResetUrl } from '@vitan/shared';
import { RESET_URL_ENV, RESET_URL_HOSTS, RESET_URL_MAX, readResetUrl, resetUrlFor } from './identity-config';

const env = (value?: string) => (value === undefined ? {} : { [RESET_URL_ENV]: value }) as NodeJS.ProcessEnv;
const GOOD = 'https://rb.vitan.in/ui/v2/login/loginname?loginName={loginName}';

describe('IDENTITY_RESET_URL (unit H)', () => {
  it('allows only rb.vitan.in today', () => {
    expect([...RESET_URL_HOSTS]).toEqual(['rb.vitan.in']);
  });

  it('unset or empty is no link', () => {
    expect(readResetUrl(env())).toEqual({ state: 'unset' });
    expect(readResetUrl(env(''))).toEqual({ state: 'unset' });
    expect(resetUrlFor('a@b.c', env())).toBeNull();
  });

  it('a well formed template gives the page for the email, the email URL-encoded', () => {
    expect(readResetUrl(env(GOOD))).toEqual({ state: 'ok', template: GOOD });
    expect(resetUrlFor('ana+site@vitan.in', env(GOOD))).toBe('https://rb.vitan.in/ui/v2/login/loginname?loginName=ana%2Bsite%40vitan.in');
    // an email cannot add a parameter or a fragment
    expect(resetUrlFor('x&requestId=1#y@z.in', env(GOOD))).toBe('https://rb.vitan.in/ui/v2/login/loginname?loginName=x%26requestId%3D1%23y%40z.in');
    // the recommended value skips the login-name step
    const submit = `${GOOD}&submit=true`;
    expect(resetUrlFor('a@b.c', env(submit))).toBe('https://rb.vitan.in/ui/v2/login/loginname?loginName=a%40b.c&submit=true');
  });

  it('every link the server sends is one the web opens, even for the longest email', () => {
    const longest = `${'%'.repeat(64)}@${'%'.repeat(189)}`; // 254 characters, each encoded to 3
    const atCap = `${GOOD}&p=${'a'.repeat(RESET_URL_MAX - GOOD.length - 3)}`;
    expect(atCap.length).toBe(RESET_URL_MAX);
    const url = resetUrlFor(longest, env(atCap));
    expect(url).not.toBeNull();
    expect(isRedbracketResetUrl(url)).toBe(true);
    expect(isRedbracketResetUrl(resetUrlFor('a@b.c', env(GOOD)))).toBe(true);
    // one character over the cap is malformed
    expect(readResetUrl(env(`${atCap}a`)).state).toBe('malformed');
  });

  it('anything else is malformed, and gives no link', () => {
    const bad = [
      'http://rb.vitan.in/ui/v2/login/loginname?loginName={loginName}', // not https
      'https://evil.example/ui/v2/login/loginname?loginName={loginName}', // host not allowed
      'https://rb.vitan.in.evil.example/x?l={loginName}', // a lookalike host
      'https://user@rb.vitan.in/x?l={loginName}', // user info
      'https://rb.vitan.in:8443/x?l={loginName}', // a port
      'https://rb.vitan.in/x?l={loginName}#top', // a fragment
      'https://rb.vitan.in/ui/v2/login/loginname', // no {loginName}
      'https://rb.vitan.in/x?a={loginName}&b={loginName}', // twice
      ' https://rb.vitan.in/x?l={loginName}', // not as it will be sent
      'https://rb.vitan.in/x\n?l={loginName}',
      'not a url {loginName}',
    ];
    for (const value of bad) {
      expect({ value, read: readResetUrl(env(value)).state }).toEqual({ value, read: 'malformed' });
      expect(resetUrlFor('a@b.c', env(value))).toBeNull();
    }
  });
});
