import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { GoogleAuthService } from './google.service';

describe('GoogleAuthService', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
  });

  it('is disabled without GOOGLE_CLIENT_ID and rejects verify with 503', async () => {
    const svc = new GoogleAuthService();
    expect(svc.configured).toBe(false);
    await expect(svc.verify('any.token')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports configured once GOOGLE_CLIENT_ID is set', () => {
    process.env.GOOGLE_CLIENT_ID = '123.apps.googleusercontent.com';
    expect(new GoogleAuthService().configured).toBe(true);
    delete process.env.GOOGLE_CLIENT_ID;
  });
});
