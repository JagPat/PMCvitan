import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

interface StubEntry {
  code: string;
  expires: number;
}

const OTP_TTL_MS = 10 * 60_000;

export interface EmailOtpResult {
  live: boolean;
  devCode?: string;
}

/**
 * Email OTP delivery, dev-stub-first. When SMTP is configured
 * (SMTP_HOST + SMTP_USER + SMTP_PASS) it emails a code we generate; with no SMTP
 * it logs the code and returns it (demoable without a mail server). Codes are
 * held in an in-memory Map and verified locally. Zero DLT — a universal fallback.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger('EmailService');
  private readonly store = new Map<string, StubEntry>();
  private transporter: Transporter | null = null;

  get configured(): boolean {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  private get from(): string {
    return process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@vitan.in';
  }

  private tx(): Transporter {
    this.transporter ??= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_SECURE ?? '') === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
    });
    return this.transporter;
  }

  private newCode(): string {
    return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit for email
  }

  /** Send an email OTP. `devCode` is present only when SMTP is not configured. */
  async sendOtp(email: string): Promise<EmailOtpResult> {
    const key = email.trim().toLowerCase();
    const code = this.newCode();
    this.store.set(key, { code, expires: Date.now() + OTP_TTL_MS });

    if (!this.configured) {
      this.log.warn(`DEV EMAIL OTP for ${key}: ${code} (no SMTP configured)`);
      return { live: false, devCode: code };
    }

    try {
      await this.tx().sendMail({
        from: this.from,
        to: key,
        subject: 'Your Vitan PMC sign-in code',
        text: `Your Vitan PMC verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
        html: `<p>Your Vitan PMC verification code is <b style="font-size:20px;letter-spacing:2px">${code}</b>.</p><p>It expires in 10 minutes. If you didn't request this, ignore this email.</p>`,
      });
    } catch (err) {
      this.log.error(`SMTP send failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Could not send the email code. Please try again.');
    }
    return { live: true };
  }

  async verifyOtp(email: string, code: string): Promise<boolean> {
    const key = email.trim().toLowerCase();
    const entry = this.store.get(key);
    if (!entry || entry.expires < Date.now()) return false;
    const ok = entry.code === code;
    if (ok) this.store.delete(key);
    return ok;
  }
}
