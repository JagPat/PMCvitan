import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { OtpStore } from './otp-store';

const OTP_TTL_MS = 5 * 60_000;

export type OtpChannel = 'sms' | 'telegram' | 'stub';
export interface OtpSendResult {
  live: boolean;
  channel: OtpChannel;
  devCode?: string;
}

/**
 * Phone OTP delivery, channel-pluggable and dev-stub-first. Priority:
 *   1. MSG91 (MSG91_AUTH_KEY + MSG91_TEMPLATE_ID) — real SMS; MSG91 owns/verifies
 *      the code against the DLT template. Needs DLT.
 *   2. Telegram Gateway (TELEGRAM_GATEWAY_TOKEN) — a code WE generate, delivered
 *      via Telegram by phone number. **Zero DLT, free.** Verified locally.
 *   3. Dev stub — logs the code and returns it, so the flow is demoable with
 *      no provider at all.
 * Codes for the Telegram + stub channels live in an in-memory Map and are
 * verified locally; only MSG91 is remote-verified.
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger('SmsService');
  private readonly otp = new OtpStore(OTP_TTL_MS);

  private get authKey(): string | undefined {
    return process.env.MSG91_AUTH_KEY?.trim() || undefined;
  }
  private get templateId(): string | undefined {
    return process.env.MSG91_TEMPLATE_ID?.trim() || undefined;
  }
  private get telegramToken(): string | undefined {
    return process.env.TELEGRAM_GATEWAY_TOKEN?.trim() || undefined;
  }

  /** MSG91 (real SMS) is configured. */
  private get msg91Live(): boolean {
    return Boolean(this.authKey && this.templateId);
  }
  /** True when a real delivery channel (SMS or Telegram) is configured. */
  get live(): boolean {
    return this.msg91Live || Boolean(this.telegramToken);
  }
  /** The channel that will be used for the next send. */
  get channel(): OtpChannel {
    if (this.msg91Live) return 'sms';
    if (this.telegramToken) return 'telegram';
    return 'stub';
  }

  /** MSG91 mobile: bare 10-digit → India 91XXXXXXXXXX (no +). */
  private mobile(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : digits;
  }
  /** E.164 (+<cc><number>) for Telegram Gateway. */
  private e164(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    return `+${digits.length === 10 ? `91${digits}` : digits}`;
  }
  private newCode(): string {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  /** Send an OTP over the highest-priority configured channel (throttled per number). */
  async sendOtp(phone: string): Promise<OtpSendResult> {
    if (!this.otp.canSend(phone)) {
      throw new HttpException('Please wait a moment before requesting another code.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (this.msg91Live) {
      await this.sendViaMsg91(phone);
      this.otp.markSent(phone); // MSG91 verifies remotely; track send for throttling
      return { live: true, channel: 'sms' };
    }
    if (this.telegramToken) {
      const code = this.newCode();
      await this.sendViaTelegram(phone, code);
      this.otp.put(phone, code);
      return { live: true, channel: 'telegram' };
    }
    const code = this.newCode();
    this.otp.put(phone, code);
    this.log.warn(`DEV OTP for ${phone}: ${code} (no SMS/Telegram provider)`);
    return { live: false, channel: 'stub', devCode: code };
  }

  /** Verify: MSG91 remote-verifies; Telegram + stub verify against the attempt-limited store. */
  async verifyOtp(phone: string, code: string): Promise<boolean> {
    if (this.msg91Live) return this.verifyViaMsg91(phone, code);
    return this.otp.verify(phone, code);
  }

  private async sendViaMsg91(phone: string): Promise<void> {
    const params = new URLSearchParams({ template_id: this.templateId!, mobile: this.mobile(phone), otp_length: '4', otp_expiry: '5' });
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
  }

  private async verifyViaMsg91(phone: string, code: string): Promise<boolean> {
    const params = new URLSearchParams({ otp: code, mobile: this.mobile(phone) });
    const res = await fetch(`https://control.msg91.com/api/v5/otp/verify?${params.toString()}`, { headers: { authkey: this.authKey! } });
    const data = (await res.json().catch(() => ({}))) as { type?: string };
    return res.ok && data.type === 'success';
  }

  /** Telegram Gateway: deliver a code we generated to the phone's Telegram account. */
  private async sendViaTelegram(phone: string, code: string): Promise<void> {
    const res = await fetch('https://gatewayapi.telegram.org/sendVerificationMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.telegramToken!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: this.e164(phone), code, ttl: 300 }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok !== true) {
      this.log.error(`Telegram Gateway send failed (${res.status}): ${data.error ?? 'unknown error'}`);
      throw new ServiceUnavailableException('Could not send the verification code. Please try again.');
    }
  }
}
