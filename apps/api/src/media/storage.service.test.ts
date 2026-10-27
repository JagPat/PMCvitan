import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

const S3_ENV = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION', 'S3_PUBLIC_BASE'];

function clearS3Env(): void {
  for (const k of S3_ENV) delete process.env[k];
}

function configureS3(): void {
  process.env.S3_ENDPOINT = 'https://r2.example.com';
  process.env.S3_BUCKET = 'vitan-media';
  process.env.S3_ACCESS_KEY_ID = 'key';
  process.env.S3_SECRET_ACCESS_KEY = 'secret';
}

beforeEach(clearS3Env);

describe('StorageService.configured', () => {
  it('is false with no provider and true once all S3 vars are set', () => {
    const s = new StorageService();
    expect(s.configured).toBe(false);
    configureS3();
    expect(s.configured).toBe(true);
  });
});

describe('StorageService.keyFor', () => {
  it('builds <project>/<kind>/<uuid>.<ext> with the right extension', () => {
    const s = new StorageService();
    expect(s.keyFor('ambli', 'progress', 'image/jpeg')).toMatch(/^ambli\/progress\/[0-9a-f-]+\.jpg$/);
    expect(s.keyFor('ambli', 'inspection', 'image/png')).toMatch(/\.png$/);
    expect(s.keyFor('ambli', 'decision', 'image/tiff')).toMatch(/\.bin$/); // unknown mime
  });
});

describe('StorageService.publicUrl', () => {
  it('prefers S3_PUBLIC_BASE, else endpoint/bucket, and de-dupes slashes', () => {
    configureS3();
    const s = new StorageService();
    expect(s.publicUrl('ambli/progress/x.jpg')).toBe('https://r2.example.com/vitan-media/ambli/progress/x.jpg');
    process.env.S3_PUBLIC_BASE = 'https://cdn.vitan.in/';
    expect(s.publicUrl('ambli/progress/x.jpg')).toBe('https://cdn.vitan.in/ambli/progress/x.jpg');
  });
});

describe('StorageService.put', () => {
  it('dev stub (no provider): returns url null and does not touch S3', async () => {
    const s = new StorageService();
    const send = vi.fn();
    s._setClient({ send } as unknown as S3Client);
    const out = await s.put('ambli/progress/x.jpg', Buffer.from('hi'), 'image/jpeg');
    expect(out.url).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('S3 mode: PUTs the object and returns its public URL', async () => {
    configureS3();
    const s = new StorageService();
    const send = vi.fn().mockResolvedValue({});
    s._setClient({ send } as unknown as S3Client);

    const key = 'ambli/progress/x.jpg';
    const out = await s.put(key, Buffer.from('bytes'), 'image/jpeg');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as { input: { Bucket?: string; Key?: string; ContentType?: string } };
    expect(command.input).toMatchObject({ Bucket: 'vitan-media', Key: key, ContentType: 'image/jpeg' });
    expect(out.url).toBe('https://r2.example.com/vitan-media/ambli/progress/x.jpg');
  });
});

describe('StorageService.presignPut', () => {
  it('dev stub (no provider): returns null so the caller posts base64', async () => {
    const s = new StorageService();
    expect(await s.presignPut('ambli/drawings/x.pdf', 'application/pdf')).toBeNull();
  });

  it('S3 mode: returns a presigned upload URL + the public URL', async () => {
    configureS3();
    const s = new StorageService();
    const out = await s.presignPut('ambli/drawings/x.pdf', 'application/pdf');
    expect(out?.url).toBe('https://r2.example.com/vitan-media/ambli/drawings/x.pdf');
    expect(out?.uploadUrl).toContain('ambli/drawings/x.pdf');
    expect(out?.uploadUrl).toMatch(/X-Amz-Signature=/);
  });

  it('S3 mode: the upload is signed for the checked type, so the object is stored as that type (#995 nosniff)', async () => {
    configureS3();
    const s = new StorageService();
    const url = new URL((await s.presignPut('ambli/drawings/x.pdf', 'application/pdf'))!.uploadUrl);
    expect(url.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toContain('content-type');
  });
});

describe('StorageService.storedType', () => {
  it('dev stub (no provider): null, and does not touch S3', async () => {
    const s = new StorageService();
    const send = vi.fn();
    s._setClient({ send } as unknown as S3Client);
    expect(await s.storedType('ambli/drawings/x.pdf')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('S3 mode: the object\'s stored type; null when there is no such object; any other failure is thrown', async () => {
    configureS3();
    const s = new StorageService();
    const send = vi.fn().mockResolvedValueOnce({ ContentType: 'text/html' });
    s._setClient({ send } as unknown as S3Client);
    expect(await s.storedType('ambli/drawings/x.pdf')).toBe('text/html');
    const command = send.mock.calls[0][0] as { constructor: { name: string }; input: { Bucket?: string; Key?: string } };
    expect(command.constructor.name).toBe('HeadObjectCommand');
    expect(command.input).toEqual({ Bucket: 'vitan-media', Key: 'ambli/drawings/x.pdf' });
    send.mockRejectedValueOnce(Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } }));
    expect(await s.storedType('ambli/drawings/gone.pdf')).toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }));
    await expect(s.storedType('ambli/drawings/x.pdf')).rejects.toThrow('AccessDenied');
  });
});
