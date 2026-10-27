import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readHubConfig, HUB_ENV, HUB_WEBHOOK_SECRETS_MAX } from './hub-config';

// Test-only values: random keys made here, never a real Hub secret.
const key = (bytes = 32) => randomBytes(bytes);
const whsec = (k: Buffer) => `whsec_${k.toString('base64')}`;
const K1 = key();
// a fixed key whose base64 holds '+' and '/', so its base64url spelling differs
const K2 = Buffer.alloc(24, 0xfb);
const full = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  HUB_BASE_URL: 'https://hub.example.test',
  HUB_OFFICE_TOKEN: 'office-token-for-tests',
  HUB_WEBHOOK_SECRET: whsec(K1),
  HUB_ORG_ID: 'org-hub-test',
  ...over,
});
const faults = (env: NodeJS.ProcessEnv) => {
  const r = readHubConfig(env);
  return r.open ? [] : r.faults;
};

describe('#1118 U2 — Hub configuration (closed unless all four HUB_* are set and well formed)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('opens with all four set, and normalises what it keeps', () => {
    const r = readHubConfig(full({ HUB_BASE_URL: ' https://Hub.Example.test/ ', HUB_ORG_ID: ' org-hub-test ' }));
    expect(r).toEqual({ open: true, config: {
      baseUrl: 'https://hub.example.test', officeToken: 'office-token-for-tests', webhookSecrets: [K1], orgId: 'org-hub-test',
    } });
  });

  it('is closed with nothing set, naming every variable', () => {
    expect(readHubConfig({})).toEqual({ open: false, faults: HUB_ENV.map((name) => ({ name, problem: 'unset' })) });
  });

  it('is closed when any one is unset or blank, and names only that one', () => {
    for (const name of HUB_ENV) {
      for (const value of [undefined, '', '   ']) {
        expect(readHubConfig(full({ [name]: value })), `${name}=${JSON.stringify(value)}`).toEqual({ open: false, faults: [{ name, problem: 'unset' }] });
      }
    }
  });

  it('reads the process environment on every call, so unsetting a variable closes it', () => {
    for (const [name, value] of Object.entries(full())) vi.stubEnv(name, value!);
    expect(readHubConfig().open).toBe(true);
    vi.stubEnv('HUB_WEBHOOK_SECRET', '');
    expect(readHubConfig()).toEqual({ open: false, faults: [{ name: 'HUB_WEBHOOK_SECRET', problem: 'unset' }] });
  });

  it('HUB_BASE_URL is an https origin only: no path, query, fragment or credentials', () => {
    for (const url of ['hub.example.test', 'ftp://hub.example.test', 'http://hub.example.test', 'https://hub.example.test/api', 'https://hub.example.test/api/v2/',
      'https://hub.example.test?x=1', 'https://hub.example.test/?', 'https://hub.example.test#', 'https://user:pw@hub.example.test', 'https://user@hub.example.test',
      'https://', 'not a url']) {
      expect(faults(full({ HUB_BASE_URL: url })), url).toEqual([{ name: 'HUB_BASE_URL', problem: 'malformed' }]);
    }
    expect(readHubConfig(full({ HUB_BASE_URL: 'https://hub.example.test:8443' }))).toMatchObject({ open: true, config: { baseUrl: 'https://hub.example.test:8443' } });
  });

  it('plain http only for a loopback stub Hub, and never in production', () => {
    for (const url of ['http://localhost:4010', 'http://127.0.0.1:4010', 'http://[::1]:4010']) {
      expect(readHubConfig(full({ HUB_BASE_URL: url })), url).toMatchObject({ open: true, config: { baseUrl: url } });
    }
    expect(faults(full({ HUB_BASE_URL: 'http://10.0.0.5' }))).toEqual([{ name: 'HUB_BASE_URL', problem: 'malformed' }]);
    vi.stubEnv('NODE_ENV', 'production');
    for (const url of ['http://localhost:4010', 'http://127.0.0.1:4010']) {
      expect(faults(full({ HUB_BASE_URL: url })), url).toEqual([{ name: 'HUB_BASE_URL', problem: 'malformed' }]);
    }
    expect(readHubConfig(full()).open).toBe(true);
  });

  it('HUB_WEBHOOK_SECRET is one or more whsec_ secrets of 24 to 64 bytes, separated by commas or spaces', () => {
    const [a, b] = [key(), key(64)];
    for (const list of [`${whsec(a)},${whsec(b)}`, `${whsec(a)} ${whsec(b)}`, ` ${whsec(a)} ,\n ${whsec(b)} `, `${whsec(a)},,${whsec(b)},`]) {
      expect(readHubConfig(full({ HUB_WEBHOOK_SECRET: list })), list).toMatchObject({ open: true, config: { webhookSecrets: [a, b] } });
    }
    // a repeated secret is kept once
    expect(readHubConfig(full({ HUB_WEBHOOK_SECRET: `${whsec(a)},${whsec(a)}` }))).toMatchObject({ open: true, config: { webhookSecrets: [a] } });
    // a rotation needs two; four at most
    expect(HUB_WEBHOOK_SECRETS_MAX).toBe(4);
    const many = Array.from({ length: 4 }, () => whsec(key()));
    expect(readHubConfig(full({ HUB_WEBHOOK_SECRET: many.join(',') })).open).toBe(true);
    expect(faults(full({ HUB_WEBHOOK_SECRET: [...many, whsec(key())].join(',') }))).toEqual([{ name: 'HUB_WEBHOOK_SECRET', problem: 'malformed' }]);
  });

  it('one bad secret in the list closes the integration rather than being dropped', () => {
    const good = whsec(K1);
    for (const bad of [K1.toString('base64'), 'whsec_', `whsec_${key(23).toString('base64')}`, `whsec_${key(65).toString('base64')}`,
      `whsec_${K2.toString('base64').replace(/=+$/, '')}x`, `whsec_${K2.toString('base64url')}`, `whsec_${K2.toString('base64')}!`, `WHSEC_${K2.toString('base64')}`,
      // 25 bytes end in `A==`; a `B` there sets bits the decoder drops, so it is not the canonical spelling
      `whsec_${Buffer.alloc(25).toString('base64').replace(/A==$/, 'B==')}`]) {
      expect(faults(full({ HUB_WEBHOOK_SECRET: `${good},${bad}` })), bad).toEqual([{ name: 'HUB_WEBHOOK_SECRET', problem: 'malformed' }]);
    }
  });

  it('HUB_OFFICE_TOKEN and HUB_ORG_ID are one run of visible ASCII', () => {
    for (const name of ['HUB_OFFICE_TOKEN', 'HUB_ORG_ID'] as const) {
      for (const value of ['two words', 'tab\there', 'line\nbreak', 'naïve']) {
        expect(faults(full({ [name]: value })), `${name}=${JSON.stringify(value)}`).toEqual([{ name, problem: 'malformed' }]);
      }
    }
  });

  it('never puts a value in its result, and never logs', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const secret = whsec(key());
    const env = full({ HUB_BASE_URL: 'https://hub.example.test/secret-path', HUB_OFFICE_TOKEN: 'tok en-value', HUB_WEBHOOK_SECRET: `${secret},whsec_bad`, HUB_ORG_ID: 'org id' });
    const result = JSON.stringify(readHubConfig(env));
    for (const value of ['secret-path', 'tok en-value', 'en-value', secret, secret.slice(6), 'whsec_bad', 'org id']) expect(result).not.toContain(value);
    expect(JSON.parse(result)).toEqual({ open: false, faults: HUB_ENV.map((name) => ({ name, problem: 'malformed' })) });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
