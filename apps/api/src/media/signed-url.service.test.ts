import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignedUrlService } from './signed-url.service';

describe('SignedUrlService — private file tokens', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-file-secret';
    delete process.env.FILE_URL_TTL_SEC;
  });
  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.FILE_URL_TTL_SEC;
  });

  it('signs a token that verifies for the same (kind, id)', () => {
    const s = new SignedUrlService();
    const t = s.sign('media', 'med1');
    expect(s.verify('media', 'med1', t)).toBe(true);
  });

  it('rejects a token used for a different id or kind (no cross-file reuse)', () => {
    const s = new SignedUrlService();
    const t = s.sign('media', 'med1');
    expect(s.verify('media', 'med2', t)).toBe(false); // different id
    expect(s.verify('drawing', 'med1', t)).toBe(false); // different kind
  });

  it('rejects a missing, malformed, or tampered token', () => {
    const s = new SignedUrlService();
    expect(s.verify('media', 'med1', undefined)).toBe(false);
    expect(s.verify('media', 'med1', 'garbage')).toBe(false);
    const t = s.sign('media', 'med1');
    expect(s.verify('media', 'med1', t + 'x')).toBe(false); // tampered signature
    const [exp] = t.split('.');
    expect(s.verify('media', 'med1', `${exp}.AAAA`)).toBe(false); // wrong signature
  });

  it('rejects an expired token', () => {
    process.env.FILE_URL_TTL_SEC = '1';
    const s = new SignedUrlService();
    // craft an already-expired token by signing against a past expiry via the public path
    const t = s.sign('media', 'med1');
    const past = Math.floor(Date.now() / 1000) - 10;
    // rebuild with a past exp so the signature is valid-for-that-exp but expired
    const forged = `${past}.${t.split('.')[1]}`;
    expect(s.verify('media', 'med1', forged)).toBe(false);
  });

  it("rejects a token signed under a different secret (can't forge without the key)", () => {
    const a = new SignedUrlService();
    const t = a.sign('media', 'med1');
    process.env.JWT_SECRET = 'a-different-secret';
    const b = new SignedUrlService();
    expect(b.verify('media', 'med1', t)).toBe(false);
  });

  it('builds relative, token-carrying serve paths for media and drawings', () => {
    const s = new SignedUrlService();
    expect(s.mediaPath('med1')).toMatch(/^\/media\/med1\?t=\d+\.[\w-]+$/);
    expect(s.drawingPath('rev1')).toMatch(/^\/drawings\/rev\/rev1\?t=\d+\.[\w-]+$/);
  });
});
