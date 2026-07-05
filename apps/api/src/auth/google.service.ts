import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  email: string;
  name?: string;
  emailVerified: boolean;
}

/**
 * Google sign-in — verifies a Google ID token (from Google Identity Services on
 * the client) and returns the identity. Enabled only when GOOGLE_CLIENT_ID is
 * set; otherwise the endpoint reports it's unavailable. Zero DLT.
 */
@Injectable()
export class GoogleAuthService {
  private client: OAuth2Client | null = null;

  get configured(): boolean {
    return Boolean(process.env.GOOGLE_CLIENT_ID);
  }

  private oauth(): OAuth2Client {
    this.client ??= new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    return this.client;
  }

  /** Verify the ID token against our client id; throws if unconfigured or invalid. */
  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.configured) {
      throw new ServiceUnavailableException('Google sign-in is not enabled on this server.');
    }
    try {
      const ticket = await this.oauth().verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID! });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error('no email in token');
      return { email: payload.email.toLowerCase(), name: payload.name, emailVerified: Boolean(payload.email_verified) };
    } catch {
      throw new UnauthorizedException('Invalid Google sign-in.');
    }
  }
}
