import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/**
 * Non-destructive account provisioning — safe to run against a LIVE database.
 *
 * Unlike `seed.ts` (which wipes every table for a clean demo), this only
 * upserts the office accounts (PMC / client / contractor) so email+password —
 * and, once invite-only is on, email-OTP / Google — work for them without
 * touching decisions, media, daily logs, or anything else.
 *
 * Env:
 *   PROJECT_ID           project to attach the accounts to (default "ambli")
 *   SEED_DEMO_PASSWORD   password for the accounts (default "vitan123")
 *   ACCOUNTS_JSON        optional JSON array to override the default roster,
 *                        e.g. [{"role":"pmc","name":"Ar. Vitan","email":"pmc@vitan.in"}]
 *
 * Run (inside the API container / a shell with DATABASE_URL):
 *   pnpm --filter api ensure-accounts
 */
const prisma = new PrismaClient();

const PROJECT_ID = process.env.PROJECT_ID || 'ambli';

interface AccountSpec {
  role: 'pmc' | 'client' | 'contractor' | 'engineer';
  name: string;
  email?: string;
  phone?: string;
}

const DEFAULT_ACCOUNTS: AccountSpec[] = [
  { role: 'pmc', name: 'Ar. Vitan', email: 'pmc@vitan.in' },
  { role: 'client', name: 'Mr. Shah', email: 'client@vitan.in' },
  { role: 'contractor', name: 'Rajesh (Contractor)', email: 'contractor@vitan.in' },
];

async function main(): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: PROJECT_ID } });
  if (!project) {
    throw new Error(`Project "${PROJECT_ID}" not found — refusing to create orphan accounts. Set PROJECT_ID.`);
  }

  // Ensure the owning org, and link the project to it (multi-tenant backfill).
  const orgSlug = process.env.ORG_SLUG || 'vitan';
  const orgName = process.env.ORG_NAME || 'Vitan Architecture';
  const org = await prisma.org.upsert({ where: { slug: orgSlug }, update: {}, create: { name: orgName, slug: orgSlug } });
  if (project.orgId !== org.id) {
    await prisma.project.update({ where: { id: PROJECT_ID }, data: { orgId: org.id } });
  }

  const accounts: AccountSpec[] = process.env.ACCOUNTS_JSON
    ? (JSON.parse(process.env.ACCOUNTS_JSON) as AccountSpec[])
    : DEFAULT_ACCOUNTS;

  const password = process.env.SEED_DEMO_PASSWORD || 'vitan123';
  const passwordHash = bcrypt.hashSync(password, 10);

  for (const a of accounts) {
    if (!a.email && !a.phone) {
      // eslint-disable-next-line no-console
      console.warn(`skip ${a.role} "${a.name}" — needs an email or phone`);
      continue;
    }
    // Password only for office roles; engineers sign in by phone OTP.
    const wantsPassword = a.role !== 'engineer' && Boolean(a.email);
    const data = {
      projectId: PROJECT_ID,
      role: a.role,
      name: a.name,
      email: a.email,
      phone: a.phone,
      ...(wantsPassword ? { passwordHash } : {}),
    };
    const where = a.email ? { email: a.email } : { phone: a.phone! };
    const user = await prisma.user.upsert({
      where,
      // don't clobber an existing password on re-run unless we're (re)setting the office pw
      update: { projectId: PROJECT_ID, role: a.role, name: a.name, ...(wantsPassword ? { passwordHash } : {}) },
      create: data,
    });
    // project + org memberships (the multi-tenant access grants)
    await prisma.membership.upsert({
      where: { projectId_userId: { projectId: PROJECT_ID, userId: user.id } },
      update: { role: a.role, status: 'active' },
      create: { projectId: PROJECT_ID, userId: user.id, role: a.role, status: 'active' },
    });
    await prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      update: { role: a.role === 'pmc' ? 'owner' : 'member' },
      create: { orgId: org.id, userId: user.id, role: a.role === 'pmc' ? 'owner' : 'member' },
    });
    // eslint-disable-next-line no-console
    console.log(`ensured ${user.role} ${user.email ?? user.phone} (${user.id}) + memberships`);
  }

  // eslint-disable-next-line no-console
  console.log(`Done. Org ${orgSlug} + ${accounts.length} account(s) ensured on project ${PROJECT_ID} (no other data touched).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
