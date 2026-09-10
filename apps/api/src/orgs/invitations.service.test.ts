import { describe, it, expect, vi } from 'vitest';
import { InvitationsService } from './invitations.service';
import type { PrismaService } from '../prisma.service';
import type { EmailService } from '../platform/email.service';

interface Row { name: string; email: string | null; passwordHash: string | null; emailVerifiedAt: Date | null }

/** An identity that was provisioned by a roster write and has not claimed its account. */
function invited(overrides: Partial<Row> = {}): Row {
  return { name: 'Vitan Growth OS', email: 'growthos@vitan.in', passwordHash: null, emailVerifiedAt: null, ...overrides };
}

function make(row: Row | null = invited(), sendMemberInvite = vi.fn(async () => ({ live: true }))) {
  const rows: Array<Record<string, unknown>> = [];
  const locks: string[] = [];
  const prisma = {
    user: { findUnique: vi.fn(async () => row) },
    // round-1 Codex F5 — the credential advisory lock the eligibility read is taken under.
    $executeRaw: vi.fn(async (sql: { values?: unknown[] }) => { locks.push(String(sql?.values?.[0] ?? '')); return 1; }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    securityAuditEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; }) },
  };
  const email = { sendMemberInvite };
  const svc = new InvitationsService(prisma as unknown as PrismaService, email as unknown as EmailService);
  return { svc, rows, locks, prisma, sendMemberInvite };
}

const ctx = { context: 'the Ambli project', role: 'pmc', actorUserId: 'admin1' };

describe('InvitationsService.notify', () => {
  it('notifies an identity that has no way in yet, and records the attempt', async () => {
    const { svc, rows, sendMemberInvite } = make();
    await svc.notify('u1', ctx);

    expect(sendMemberInvite).toHaveBeenCalledOnce();
    expect(sendMemberInvite.mock.calls[0][0]).toBe('growthos@vitan.in');
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.invitation_sent',
        targetUserId: 'u1',
        actorUserId: 'admin1',
        actorKind: 'administrator',
      }),
    ]);
  });

  // round-1 Codex F5 — the caller's pre-transaction snapshot could be stale by the time the
  // roster write commits, so the decision is made on a FRESH read taken under the same
  // credential lock `PasswordCredentialsService` establishes credentials with.
  it('decides on a fresh read taken under the credential lock, not a caller snapshot', async () => {
    const { svc, locks, prisma } = make();
    await svc.notify('u1', ctx);
    expect(prisma.user.findUnique).toHaveBeenCalledOnce();
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(locks).toEqual(['credential:u1']);
  });

  it('stays silent when a concurrent password completion claimed the account first', async () => {
    const { svc, rows, sendMemberInvite } = make(invited({ passwordHash: 'bcrypt-hash' }));
    await svc.notify('u1', ctx);
    expect(sendMemberInvite).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  // A role change on an established account is not an invitation. Same predicate
  // `correctInvitationEmail` refuses on, so the module means one thing by "outstanding".
  it.each([
    ['the email is verified', invited({ emailVerifiedAt: new Date('2026-09-01T00:00:00Z') })],
    ['there is no email address', invited({ email: null })],
    ['the identity vanished', null],
  ])('stays silent when %s', async (_label, row) => {
    const { svc, rows, sendMemberInvite } = make(row);
    await svc.notify('u1', ctx);
    expect(sendMemberInvite).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it('records nothing when the provider is not configured, so the gap stays visible', async () => {
    const { svc, rows } = make(invited(), vi.fn(async () => ({ live: false })));
    await svc.notify('u1', ctx);
    expect(rows).toEqual([]);
  });

  it('never throws when delivery fails — the membership is already committed', async () => {
    const { svc, rows } = make(invited(), vi.fn(async () => { throw new Error('smtp refused growthos@vitan.in'); }));
    await expect(svc.notify('u1', ctx)).resolves.toBeUndefined();
    expect(rows).toEqual([]);
  });

  // round-1 Codex F1 — the eligibility read is itself fallible and runs after the roster
  // commit, so it must not be able to reject a durable add either.
  it('never throws when the eligibility read fails', async () => {
    const prisma = { $transaction: vi.fn(async () => { throw new Error('db down'); }) };
    const email = { sendMemberInvite: vi.fn() };
    const svc = new InvitationsService(prisma as unknown as PrismaService, email as unknown as EmailService);
    await expect(svc.notify('u1', ctx)).resolves.toBeUndefined();
    expect(email.sendMemberInvite).not.toHaveBeenCalled();
  });

  it('never throws when the audit write fails after a live send', async () => {
    const { svc, prisma } = make();
    prisma.securityAuditEvent.create = vi.fn(async () => { throw new Error('audit down'); });
    await expect(svc.notify('u1', ctx)).resolves.toBeUndefined();
  });

  it('hands the sender no credential material', async () => {
    const { svc, sendMemberInvite } = make();
    await svc.notify('u1', ctx);
    const payload = JSON.stringify(sendMemberInvite.mock.calls[0][1]);
    expect(payload).not.toMatch(/\d{6}/);
    expect(payload.toLowerCase()).not.toContain('token');
  });
});
