import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { OtpStore } from './otp-store';
import { isProduction } from '../config';

const OTP_TTL_MS = 10 * 60_000;

export interface EmailOtpResult {
  live: boolean;
  devCode?: string;
}

export interface PasswordCredentialEmailResult {
  live: boolean;
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
  private readonly otp = new OtpStore(OTP_TTL_MS);
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
    if (!this.otp.canSend(key)) {
      throw new HttpException('Please wait a moment before requesting another code.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!this.configured) {
      // P1-1: never hand the code back to the caller in production — that would let
      // anyone request an OTP for a known address and read the code from the response
      // (account takeover). The dev stub is dev/test only; in prod, fail closed.
      if (isProduction()) {
        throw new ServiceUnavailableException('Email sign-in is not available — no mail provider is configured.');
      }
      const code = this.newCode();
      this.otp.put(key, code);
      this.log.warn(`DEV EMAIL OTP for ${key}: ${code} (no SMTP configured)`);
      return { live: false, devCode: code };
    }

    const code = this.newCode();
    this.otp.put(key, code);

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
    return this.otp.verify(email.trim().toLowerCase(), code);
  }

  /** Deliver a code whose lifecycle is owned by the durable credential service.
   * It is deliberately never copied into the legacy in-memory sign-in OTP store. */
  async sendPasswordCredentialCode(email: string, code: string): Promise<PasswordCredentialEmailResult> {
    const to = email.trim().toLowerCase();
    if (!this.configured) {
      if (isProduction()) {
        throw new ServiceUnavailableException('Password setup email is not available.');
      }
      // Do not log or return credential material. Integration tests replace this
      // provider with a capture transport; local manual use should run SMTP/Mailpit.
      return { live: false };
    }
    try {
      await this.tx().sendMail({
        from: this.from,
        to,
        subject: 'Set up or reset your Vitan PMC password',
        text: `Your Vitan PMC password verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
        html: `<p>Your Vitan PMC password verification code is <b style="font-size:20px;letter-spacing:2px">${code}</b>.</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`,
      });
    } catch (error) {
      this.log.error(`Password credential email failed: ${(error as Error).constructor.name}`);
      throw new ServiceUnavailableException('Could not send the password setup email.');
    }
    return { live: true };
  }
}
