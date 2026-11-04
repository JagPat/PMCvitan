/**
 * Unit H: `IDENTITY_RESET_URL`, Redbracket ID's own password reset page. Only an `https://` URL on an allowed host,
 * holding `{loginName}` exactly once and written exactly as it will be sent, is used; anything else is no link.
 */
import { describe, expect, it } from 'vitest';
import { RESET_URL_ENV, RESET_URL_HOSTS, readResetUrl, resetUrlFor } from './identity-config';

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
