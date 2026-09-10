import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { OtpStore } from '../auth/otp-store';
import { isProduction } from '../config';

const OTP_TTL_MS = 10 * 60_000;

/** The invite is the only mail here that interpolates caller-supplied text (a member's name,
 *  the project/org they were added to) into HTML, so it escapes: an operator who types a name
 *  containing markup must not get it rendered as markup in someone's inbox. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailOtpResult {
  live: boolean;
  devCode?: string;
}

export interface PasswordCredentialEmailResult {
  live: boolean;
}

/** What an invited member is told: where they were added and where to sign in. Carries NO
 *  credential material — the invitee asks for their own code from the sign-in screen. */
export interface MemberInvite {
  name: string;
  /** What they were added to, already phrased for a sentence ("the Ambli project"). */
  context: string;
  role: string;
  /** Public origin of the web app, or null when none is configured (the link is then omitted). */
  signInUrl: string | null;
}

export interface MemberInviteEmailResult {
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

  /**
   * Tell a newly invited identity that an account exists for them and how to reach it.
   *
   * Unlike the two code senders this does NOT fail closed on a missing provider: it hangs off
   * an admin write that has already committed, so an unconfigured mailer returns `live: false`
   * rather than the 503 that would report a durable member-add as failed. A delivery error
   * still propagates — reporting it is this sender's job, deciding what it means is the
   * caller's ({@link InvitationsService} swallows it and records nothing).
   *
   * No code or token is embedded — the invitee requests their own from the sign-in screen, so
   * a forwarded or archived invite grants nothing.
   */
  async sendMemberInvite(email: string, invite: MemberInvite): Promise<MemberInviteEmailResult> {
    const to = email.trim().toLowerCase();
    if (!this.configured) {
      if (isProduction()) {
        this.log.warn(`Member invite for ${to} not sent — no mail provider is configured.`);
      }
      return { live: false };
    }
    // round-1 Codex F2 — these are the REAL control labels on `TeamAccessScreen`, in the order
    // an invitee meets them. There is no "email me a code" entry point on that screen; the
    // password-setup path is the one built for an invited identity ("Use the email your
    // administrator added to Vitan PMC"), and its eligibility rule is the same one that
    // decides whether this invite is sent at all.
    const open = invite.signInUrl ? `Open ${invite.signInUrl}` : 'Open the Vitan PMC app';
    const where = `${open}, choose "Architect / Client / Contractor? Sign in with email", then "Set up or forgot password", and enter this address — a verification code will be sent to it.`;
    const link = invite.signInUrl
      ? `<p><a href="${escapeHtml(invite.signInUrl)}">${escapeHtml(invite.signInUrl)}</a></p>`
      : '';
    await this.tx().sendMail({
      from: this.from,
      to,
      subject: 'You have been added to Vitan PMC',
      text: `Hi ${invite.name},\n\nYou have been added to ${invite.context} on Vitan PMC as ${invite.role}.\n\n${where}\n\nIf you were not expecting this, ignore this email.`,
      html: `<p>Hi ${escapeHtml(invite.name)},</p><p>You have been added to <b>${escapeHtml(invite.context)}</b> on Vitan PMC as <b>${escapeHtml(invite.role)}</b>.</p><p>${escapeHtml(where)}</p>${link}<p>If you were not expecting this, ignore this email.</p>`,
    });
    return { live: true };
  }
}
