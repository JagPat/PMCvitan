import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { OtpStore } from './otp-store';
import { isProduction } from '../config';

const OTP_TTL_MS = 5 * 60_000;

export type OtpChannel = 'sms' | 'fast2sms' | 'telegram' | 'stub';
export interface OtpSendResult {
  live: boolean;
  channel: OtpChannel;
  devCode?: string;
}

/**
 * Phone OTP delivery, channel-pluggable and dev-stub-first. Priority:
 *   1. MSG91 (MSG91_AUTH_KEY + MSG91_TEMPLATE_ID) — real SMS; MSG91 owns/verifies
 *      the code against the DLT template. Needs DLT.
 *   2. Fast2SMS (FAST2SMS_API_KEY) — a code WE generate, verified locally.
 *      - With FAST2SMS_OTP_ID: Smart OTP (`/dev/otp/send`) delivers via a linked
 *        template over **WhatsApp and/or SMS** — no DLT (Meta template approval).
 *      - Without it: the older DLT-exempt bulkV2 `otp` route (SMS only; requires
 *        Fast2SMS OTP-route website verification).
 *   3. Telegram Gateway (TELEGRAM_GATEWAY_TOKEN) — a code WE generate, delivered
 *      via Telegram by phone number. **Zero DLT, free** — but only reaches users
 *      with Telegram, and a free/unactivated account only texts its own number.
 *   4. Dev stub — logs the code and returns it, so the flow is demoable with
 *      no provider at all.
 * Codes for the Fast2SMS + Telegram + stub channels live in an in-memory Map and
 * are verified locally; only MSG91 is remote-verified.
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger('SmsService');
  private readonly otp = new OtpStore(OTP_TTL_MS);

  constructor() {
    // Announce the resolved channel at boot so the deploy logs show exactly which
    // provider is live (and which keys were detected) — no secrets, just presence.
    const f2s = this.fast2smsKey ? (this.fast2smsOtpId ? 'true/smart-otp' : 'true/route-otp') : 'false';
    this.log.log(
      `Phone-OTP channel: ${this.channel} ` +
        `(msg91=${this.msg91Live}, fast2sms=${f2s}, telegram=${Boolean(this.telegramToken)})`,
    );
  }

  private get authKey(): string | undefined {
    return process.env.MSG91_AUTH_KEY?.trim() || undefined;
  }
  private get templateId(): string | undefined {
    return process.env.MSG91_TEMPLATE_ID?.trim() || undefined;
  }
  private get telegramToken(): string | undefined {
    return process.env.TELEGRAM_GATEWAY_TOKEN?.trim() || undefined;
  }
  private get fast2smsKey(): string | undefined {
    return process.env.FAST2SMS_API_KEY?.trim() || undefined;
  }
  /** Fast2SMS Smart OTP template id — when set, deliver via /dev/otp/send (WhatsApp/SMS per the template). */
  private get fast2smsOtpId(): string | undefined {
    return process.env.FAST2SMS_OTP_ID?.trim() || undefined;
  }

  /** MSG91 (real SMS) is configured. */
  private get msg91Live(): boolean {
    return Boolean(this.authKey && this.templateId);
  }
  /** True when a real delivery channel (SMS or Telegram) is configured. */
  get live(): boolean {
    return this.msg91Live || Boolean(this.fast2smsKey) || Boolean(this.telegramToken);
  }
  /** The channel that will be used for the next send. */
  get channel(): OtpChannel {
    if (this.msg91Live) return 'sms';
    if (this.fast2smsKey) return 'fast2sms';
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
    if (this.fast2smsKey) {
      const code = this.newCode();
      // Smart OTP (WhatsApp/SMS via a linked template) when FAST2SMS_OTP_ID is set;
      // otherwise the older DLT-exempt bulkV2 `otp` route.
      if (this.fast2smsOtpId) await this.sendViaFast2smsOtp(phone, code);
      else await this.sendViaFast2sms(phone, code);
      this.otp.put(phone, code);
      return { live: true, channel: 'fast2sms' };
    }
    if (this.telegramToken) {
      const code = this.newCode();
      await this.sendViaTelegram(phone, code);
      this.otp.put(phone, code);
      return { live: true, channel: 'telegram' };
    }
    // P1-1: the dev stub returns the code to the caller — dev/test ONLY. In production
    // with no SMS provider configured, refuse rather than hand out a code anyone could
    // read from the response to take over a known number's account.
    if (isProduction()) {
      throw new ServiceUnavailableException('Phone sign-in is not available — no SMS provider is configured.');
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

  /**
   * Fast2SMS: real SMS to an Indian mobile via the DLT-exempt `otp` route. We
   * generate the code and pass it as `variables_values`; the account's default
   * OTP template delivers it. Verified locally against the in-memory store.
   */
  private async sendViaFast2sms(phone: string, code: string): Promise<void> {
    const digits = phone.replace(/\D/g, '');
    const numbers = digits.length > 10 ? digits.slice(-10) : digits; // bare 10-digit Indian mobile
    const params = new URLSearchParams({ route: 'otp', variables_values: code, numbers });
    const res = await fetch(`https://www.fast2sms.com/dev/bulkV2?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: this.fast2smsKey! }, // header, not query, so the key stays out of logs
    });
    const data = (await res.json().catch(() => ({}))) as { return?: boolean; message?: string | string[] };
    if (!res.ok || data.return !== true) {
      const msg = Array.isArray(data.message) ? data.message.join('; ') : data.message;
      this.log.error(`Fast2SMS send failed (${res.status}): ${msg ?? 'unknown error'}`);
      throw new ServiceUnavailableException('Could not send the verification code. Please try again.');
    }
  }

  /**
   * Fast2SMS Smart OTP (`/dev/otp/send`): deliver our code through a linked OTP
   * template — WhatsApp and/or SMS, per the template's channel config. We pass our
   * own `otp` so verification stays local (Fast2SMS just delivers it into the
   * template's OTP variable). Needs FAST2SMS_OTP_ID (the assigned template id).
   */
  private async sendViaFast2smsOtp(phone: string, code: string): Promise<void> {
    const digits = phone.replace(/\D/g, '');
    const mobile = digits.length > 10 ? digits.slice(-10) : digits; // bare 10-digit Indian mobile
    const params = new URLSearchParams({ otp_id: this.fast2smsOtpId!, otp: code, mobile });
    const res = await fetch(`https://www.fast2sms.com/dev/otp/send?${params.toString()}`, {
      method: 'POST',
      headers: { authorization: this.fast2smsKey! }, // header, not query, so the key stays out of logs
    });
    const data = (await res.json().catch(() => ({}))) as { return?: boolean; message?: string | string[] };
    if (!res.ok || data.return !== true) {
      const msg = Array.isArray(data.message) ? data.message.join('; ') : data.message;
      this.log.error(`Fast2SMS Smart OTP send failed (${res.status}): ${msg ?? 'unknown error'}`);
      throw new ServiceUnavailableException('Could not send the verification code. Please try again.');
    }
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
