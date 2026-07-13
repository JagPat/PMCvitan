import { describe, it, expect } from 'vitest';
import { createActivitySchema, createMediaSchema, createPhaseSchema, createProjectSchema, isoCivilDateSchema, issueDrawingSchema, pushSubscribeSchema, isSafeExternalHttpsUrl, MAX_MEDIA_BASE64, timeZoneSchema } from './contracts';

describe('createMediaSchema — P2-5 raster allowlist + size cap', () => {
  const base = { kind: 'progress' as const, data: 'AAAA' };

  it('accepts common raster image types', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/heic']) {
      expect(createMediaSchema.safeParse({ ...base, mime }).success).toBe(true);
    }
  });

  it('rejects image/svg+xml (active content → stored XSS)', () => {
    expect(createMediaSchema.safeParse({ ...base, mime: 'image/svg+xml' }).success).toBe(false);
  });

  it('rejects non-image types', () => {
    expect(createMediaSchema.safeParse({ ...base, mime: 'text/html' }).success).toBe(false);
    expect(createMediaSchema.safeParse({ ...base, mime: 'application/pdf' }).success).toBe(false);
  });

  it('rejects an oversized base64 body', () => {
    const huge = 'A'.repeat(MAX_MEDIA_BASE64 + 1);
    expect(createMediaSchema.safeParse({ ...base, mime: 'image/png', data: huge }).success).toBe(false);
  });
});

describe('issueDrawingSchema — P2-5 MIME allowlist', () => {
  const base = { number: 'A-201', title: 'Plan', discipline: 'architectural' as const, rev: 'A', data: 'AAAA' };
  it('accepts PDF and CAD/raster types', () => {
    for (const mime of ['application/pdf', 'image/vnd.dwg', 'image/png']) {
      expect(issueDrawingSchema.safeParse({ ...base, mime }).success).toBe(true);
    }
  });
  it('rejects SVG and script-y types', () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/javascript']) {
      expect(issueDrawingSchema.safeParse({ ...base, mime }).success).toBe(false);
    }
  });
});

describe('isSafeExternalHttpsUrl — P2-1 push SSRF guard', () => {
  it('accepts real push-provider https hosts', () => {
    expect(isSafeExternalHttpsUrl('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isSafeExternalHttpsUrl('https://updates.push.services.mozilla.com/wpush/v2/xyz')).toBe(true);
  });

  it('rejects non-https', () => {
    expect(isSafeExternalHttpsUrl('http://fcm.googleapis.com/x')).toBe(false);
  });

  it('rejects localhost and internal names', () => {
    for (const u of ['https://localhost/x', 'https://foo.local/x', 'https://svc.internal/x']) {
      expect(isSafeExternalHttpsUrl(u)).toBe(false);
    }
  });

  it('rejects private, loopback, link-local and metadata IPs', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1']) {
      expect(isSafeExternalHttpsUrl(`https://${host}/x`)).toBe(false);
    }
  });

  it('rejects any bare-IP and IPv6 endpoint (not a real push provider)', () => {
    expect(isSafeExternalHttpsUrl('https://8.8.8.8/x')).toBe(false);
    expect(isSafeExternalHttpsUrl('https://[::1]/x')).toBe(false);
  });

  it('the push schema rejects an SSRF endpoint', () => {
    const bad = { subscription: { endpoint: 'https://169.254.169.254/latest/meta-data', keys: { p256dh: 'k', auth: 'a' } } };
    expect(pushSubscribeSchema.safeParse(bad).success).toBe(false);
    const ok = { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } } };
    expect(pushSubscribeSchema.safeParse(ok).success).toBe(true);
  });
});

describe('canonical date validation (Codex gate finding 5)', () => {
  it('isoCivilDateSchema rejects impossible calendar dates, not just bad shapes', () => {
    expect(isoCivilDateSchema.safeParse('2026-02-28').success).toBe(true);
    expect(isoCivilDateSchema.safeParse('2028-02-29').success).toBe(true); // leap day
    expect(isoCivilDateSchema.safeParse('2026-02-31').success).toBe(false); // no Feb 31
    expect(isoCivilDateSchema.safeParse('2026-13-01').success).toBe(false); // no month 13
    expect(isoCivilDateSchema.safeParse('2026-00-10').success).toBe(false);
  });

  it('timeZoneSchema accepts real IANA zones and rejects junk', () => {
    expect(timeZoneSchema.safeParse('Asia/Kolkata').success).toBe(true);
    expect(timeZoneSchema.safeParse('UTC').success).toBe(true);
    expect(timeZoneSchema.safeParse('Mars/Olympus_Mons').success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'X', short: 'X', timeZone: 'Not/AZone' }).success).toBe(false);
  });

  it('a reversed ISO window is a 400 at the boundary — for activities AND phases', () => {
    const base = { name: 'A', plannedStart: 0, plannedEnd: 5 };
    expect(createActivitySchema.safeParse({ ...base, plannedStartDate: '2026-07-10', plannedEndDate: '2026-07-01' }).success).toBe(false);
    expect(createActivitySchema.safeParse({ ...base, plannedStartDate: '2026-07-01', plannedEndDate: '2026-07-10' }).success).toBe(true);
    expect(createPhaseSchema.safeParse({ name: 'P', plannedStartDate: '2026-07-10', plannedEndDate: '2026-07-01' }).success).toBe(false);
    expect(createPhaseSchema.safeParse({ name: 'P', plannedStart: 9, plannedEnd: 2 }).success).toBe(false); // reversed offsets too
    expect(createPhaseSchema.safeParse({ name: 'P', plannedStartDate: '2026-07-01', plannedEndDate: '2026-07-10' }).success).toBe(true);
  });
});
