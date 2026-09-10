import { describe, it, expect, vi } from 'vitest';
import { InvitationsService, type InvitableUser } from './invitations.service';
import type { PrismaService } from '../prisma.service';
import type { EmailService } from '../auth/email.service';

/** An identity that was provisioned by a roster write and has not claimed its account. */
function invited(overrides: Partial<InvitableUser> = {}): InvitableUser {
  return { id: 'u1', name: 'Vitan Growth OS', email: 'growthos@vitan.in', passwordHash: null, emailVerifiedAt: null, ...overrides };
}

function make(sendMemberInvite = vi.fn(async () => ({ live: true }))) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    securityAuditEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); return data; }) },
  };
  const email = { sendMemberInvite };
  const svc = new InvitationsService(prisma as unknown as PrismaService, email as unknown as EmailService);
  return { svc, rows, sendMemberInvite };
}

const ctx = { context: 'the Ambli project', role: 'pmc', actorUserId: 'admin1' };

describe('InvitationsService.notify', () => {
  it('notifies an identity that has no way in yet, and records the attempt', async () => {
    const { svc, rows, sendMemberInvite } = make();
    await svc.notify(invited(), ctx);

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

  // The reported defect: an admin add provisioned the account and told nobody, so the
  // invitee could not discover they had access. These are the two states that mean
  // "still cannot get in on their own".
  it.each([
    ['no password and no verified email', invited()],
  ])('sends when the invitation is outstanding — %s', async (_label, user) => {
    const { svc, sendMemberInvite } = make();
    await svc.notify(user, ctx);
    expect(sendMemberInvite).toHaveBeenCalledOnce();
  });

  // A role change on an established account is not an invitation. Same predicate
  // `correctInvitationEmail` refuses on, so the module means one thing by "outstanding".
  it.each([
    ['a password is set', invited({ passwordHash: 'bcrypt-hash' })],
    ['the email is verified', invited({ emailVerifiedAt: new Date('2026-09-01T00:00:00Z') })],
    ['there is no email address', invited({ email: null })],
  ])('stays silent when %s', async (_label, user) => {
    const { svc, rows, sendMemberInvite } = make();
    await svc.notify(user, ctx);
    expect(sendMemberInvite).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it('records nothing when the provider is not configured, so the gap stays visible', async () => {
    const { svc, rows } = make(vi.fn(async () => ({ live: false })));
    await svc.notify(invited(), ctx);
    expect(rows).toEqual([]);
  });

  it('never throws when delivery fails — the membership is already committed', async () => {
    const { svc, rows } = make(vi.fn(async () => { throw new Error('smtp refused growthos@vitan.in'); }));
    await expect(svc.notify(invited(), ctx)).resolves.toBeUndefined();
    expect(rows).toEqual([]);
  });

  it('never throws when the audit write fails after a live send', async () => {
    const { svc } = (() => {
      const prisma = { securityAuditEvent: { create: vi.fn(async () => { throw new Error('audit down'); }) } };
      const email = { sendMemberInvite: vi.fn(async () => ({ live: true })) };
      return { svc: new InvitationsService(prisma as unknown as PrismaService, email as unknown as EmailService) };
    })();
    await expect(svc.notify(invited(), ctx)).resolves.toBeUndefined();
  });

  it('hands the sender no credential material', async () => {
    const { svc, sendMemberInvite } = make();
    await svc.notify(invited(), ctx);
    const payload = JSON.stringify(sendMemberInvite.mock.calls[0][1]);
    expect(payload).not.toMatch(/\d{6}/);
    expect(payload.toLowerCase()).not.toContain('token');
  });
});
