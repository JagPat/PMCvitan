import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

interface StubEntry {
  code: string;
  expires: number;
}

const OTP_TTL_MS = 5 * 60_000;

/**
 * Phone OTP delivery. When MSG91 is configured (MSG91_AUTH_KEY + MSG91_TEMPLATE_ID)
 * it uses the MSG91 v5 OTP API — MSG91 generates, stores and verifies the code
 * against the DLT-approved template (its `##OTP##` variable). With no provider
 * configured it falls back to an in-memory dev stub that logs the code and
 * returns it to the caller, so the OTP flow is demoable end-to-end without SMS.
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger('SmsService');
  private readonly stub = new Map<string, StubEntry>();

  private get authKey(): string | undefined {
    return process.env.MSG91_AUTH_KEY?.trim() || undefined;
  }

  private get templateId(): string | undefined {
    return process.env.MSG91_TEMPLATE_ID?.trim() || undefined;
  }

  /** True when a real SMS provider is configured; otherwise OTPs are dev-stubbed. */
  get live(): boolean {
    return Boolean(this.authKey && this.templateId);
  }

  /** Normalise to MSG91's country-coded mobile (defaults a bare 10-digit number to India +91). */
  private mobile(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : digits;
  }

  /**
   * Send an OTP. In dev-stub mode the returned `devCode` lets the demo complete
   * with no SMS; in live mode nothing sensitive is returned (MSG91 holds the code).
   */
  async sendOtp(phone: string): Promise<{ live: boolean; devCode?: string }> {
    if (!this.live) {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      this.stub.set(phone, { code, expires: Date.now() + OTP_TTL_MS });
      this.log.warn(`DEV OTP for ${phone}: ${code} (no MSG91 configured)`);
      return { live: false, devCode: code };
    }

    const params = new URLSearchParams({
      template_id: this.templateId!,
      mobile: this.mobile(phone),
      otp_length: '4',
      otp_expiry: '5',
    });
    if (process.env.MSG91_SENDER_ID) params.set('sender', process.env.MSG91_SENDER_ID);

    const res = await fetch(`https://control.msg91.com/api/v5/otp?${params.toString()}`, {
      method: 'POST',
      headers: { authkey: this.authKey!, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || data.type === 'error') {
      this.log.error(`MSG91 send failed (${res.status}): ${data.message ?? 'unknown error'}`);
      throw new ServiceUnavailableException('Could not send the verification code. Please try again.');
    }
    return { live: true };
  }

  /** Verify an OTP against MSG91 (live) or the in-memory stub (dev). */
  async verifyOtp(phone: string, code: string): Promise<boolean> {
    if (!this.live) {
      const entry = this.stub.get(phone);
      if (!entry || entry.expires < Date.now()) return false;
      const ok = entry.code === code;
      if (ok) this.stub.delete(phone);
      return ok;
    }

    const params = new URLSearchParams({ otp: code, mobile: this.mobile(phone) });
    const res = await fetch(`https://control.msg91.com/api/v5/otp/verify?${params.toString()}`, {
      headers: { authkey: this.authKey! },
    });
    const data = (await res.json().catch(() => ({}))) as { type?: string };
    return res.ok && data.type === 'success';
  }
}
