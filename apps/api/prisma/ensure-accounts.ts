import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { SEED_NODES, SEED_DECISIONS, SEED_ACTIVITIES, SEED_INSPECTIONS, SEED_LOG_MATERIALS, createStarterLibrary } from '../src/domain/seed-data';

/**
 * Non-destructive account provisioning — safe to run against a LIVE database.
 *
 * Unlike `seed.ts` (which wipes every table for a clean demo), this only
 * CREATES the office accounts (PMC / client / contractor) that are missing, so
 * email+password — and, once invite-only is on, email-OTP / Google — work.
 *
 * Strictly create-only (DEP-01): an existing account is never modified — its
 * password hash is never reset (the sole exception: an office account with no
 * password yet gets one), and an existing membership keeps its role and status,
 * so a `removed` member is never resurrected by a redeploy. The only mutating
 * path for existing rows is ORG_OWNER_EMAIL, an explicit, targeted promotion.
 *
 * Env:
 *   PROJECT_ID           project to attach the accounts to (default "ambli")
 *   SEED_DEMO_PASSWORD   password for NEWLY CREATED accounts (default "vitan123")
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

  // Promote a specific existing account to org OWNER (super-admin) — idempotent, additive
  // (does not demote anyone; the org can have several owners). Use this to hand the owner
  // role to e.g. jp@vitan.in without shell access: set ORG_OWNER_EMAIL + AUTO_ENSURE_ACCOUNTS
  // and redeploy. Only an owner can manage the admin roster, so this is how you make the
  // super-admin who can add/remove other admins.
  const ownerEmail = process.env.ORG_OWNER_EMAIL?.trim().toLowerCase();
  if (ownerEmail) {
    const ownerUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (!ownerUser) {
      // eslint-disable-next-line no-console
      console.warn(`ORG_OWNER_EMAIL="${ownerEmail}" — no such user yet; sign them in once (or add them below), then rerun.`);
    } else {
      await prisma.orgMembership.upsert({
        where: { orgId_userId: { orgId: org.id, userId: ownerUser.id } },
        update: { role: 'owner' },
        create: { orgId: org.id, userId: ownerUser.id, role: 'owner' },
      });
      // eslint-disable-next-line no-console
      console.log(`promoted ${ownerEmail} to OWNER of "${org.slug}"`);
    }
  }

  const accounts: AccountSpec[] = process.env.ACCOUNTS_JSON
    ? (JSON.parse(process.env.ACCOUNTS_JSON) as AccountSpec[])
    : DEFAULT_ACCOUNTS;

  // P1-5: NO default password. A known-fallback password (the old `vitan123`) on a
  // reachable production account is an account-takeover. A newly-created office account
  // gets a password ONLY when SEED_DEMO_PASSWORD is explicitly set to a non-trivial value;
  // otherwise it is created password-less (sign in by email-OTP, or set one via a
  // deliberate reset). Existing accounts are never given a password here.
  const seedPassword = process.env.SEED_DEMO_PASSWORD?.trim();
  if (seedPassword && seedPassword.length < 10) {
    throw new Error('SEED_DEMO_PASSWORD is too weak — use at least 10 characters, or unset it to create password-less accounts.');
  }
  const passwordHash = seedPassword ? bcrypt.hashSync(seedPassword, 10) : null;

  for (const a of accounts) {
    if (!a.email && !a.phone) {
      // eslint-disable-next-line no-console
      console.warn(`skip ${a.role} "${a.name}" — needs an email or phone`);
      continue;
    }
    // Password only for office roles, only when a strong SEED_DEMO_PASSWORD is provided,
    // and only on CREATE. Engineers sign in by phone OTP.
    const setPassword = a.role !== 'engineer' && Boolean(a.email) && passwordHash !== null;
    const where = a.email ? { email: a.email } : { phone: a.phone! };

    // CREATE-ONLY (DEP-01 / P1-5): an account that already exists is left completely
    // untouched — its password hash, role, name and home project are never modified. A
    // redeploy with AUTO_ENSURE_ACCOUNTS=true therefore can never reset OR back-fill a
    // password on a live identity (both are takeover vectors). Existing password-less
    // accounts stay password-less; give them one through a deliberate reset flow, not a boot.
    let user = await prisma.user.findUnique({ where });
    if (!user) {
      user = await prisma.user.create({
        data: {
          projectId: PROJECT_ID,
          role: a.role,
          name: a.name,
          email: a.email,
          phone: a.phone,
          ...(setPassword ? { passwordHash } : {}),
        },
      });
      if (a.role !== 'engineer' && a.email && !setPassword) {
        // eslint-disable-next-line no-console
        console.warn(`created ${a.email} WITHOUT a password (SEED_DEMO_PASSWORD unset) — they must use email-OTP or a reset.`);
      }
    }

    // Memberships are also create-only: a membership row that exists keeps its
    // role AND its status — this must never resurrect a `removed` member
    // (removal is the access-revocation record; see SEC-01).
    await prisma.membership.upsert({
      where: { projectId_userId: { projectId: PROJECT_ID, userId: user.id } },
      update: {},
      create: { projectId: PROJECT_ID, userId: user.id, role: a.role, status: 'active' },
    });
    await prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      update: {},
      create: { orgId: org.id, userId: user.id, role: a.role === 'pmc' ? 'owner' : 'member' },
    });
    // eslint-disable-next-line no-console
    console.log(`ensured ${user.role} ${user.email ?? user.phone} (${user.id}) + memberships`);
  }

  // Legacy-membership backfill (ORG escalation fix). Access now derives ONLY from
  // an active project Membership or an org owner/admin role — the legacy
  // `User.projectId`/`User.role` fallback is retired. To keep genuine
  // pre-membership accounts (e.g. a phone-OTP engineer, an old seed row) signing
  // in, give each one an explicit active Membership on their home project.
  //
  // Deliberately SKIP any user who holds an org membership: those are org-roster
  // identities whose access is owner/admin super-admin reach (or nothing, for a
  // plain member). Backfilling them a project membership from their (now-dormant)
  // User.role would re-introduce the very phantom-PMC grant this fix removes and
  // would survive a later demotion. This runs create-only (skips existing
  // memberships) and is safe to re-run.
  const legacyUsers = await prisma.user.findMany({
    where: {
      role: { in: ['pmc', 'client', 'engineer', 'contractor'] },
      memberships: { none: {} },
      orgMemberships: { none: {} },
    },
    select: { id: true, projectId: true, role: true, email: true, phone: true },
  });
  let backfilled = 0;
  for (const u of legacyUsers) {
    await prisma.membership.create({ data: { projectId: u.projectId, userId: u.id, role: u.role, status: 'active' } });
    backfilled += 1;
    // eslint-disable-next-line no-console
    console.log(`backfilled membership for legacy ${u.role} ${u.email ?? u.phone ?? u.id} on ${u.projectId}`);
  }
  if (backfilled === 0) {
    // eslint-disable-next-line no-console
    console.log('no legacy accounts needed a membership backfill');
  }

  // Phase backfill for the Ambli demo project (Orgs Slice 3): upsert the phases
  // and file each known activity under one — but only when the activity has no
  // phase yet, so a hand-assigned phase is never clobbered. Other projects define
  // phases through the app, so this is scoped to the seeded demo.
  if (PROJECT_ID === 'ambli') {
    const phases = [
      { id: 'PH-services', name: 'Services & Waterproofing', order: 0, plannedStart: 9, plannedEnd: 30 },
      { id: 'PH-wetareas', name: 'Wet Areas & Fittings', order: 1, plannedStart: 19, plannedEnd: 27 },
      { id: 'PH-finishing', name: 'Finishing', order: 2, plannedStart: 34, plannedEnd: 47 },
    ];
    for (const p of phases) {
      await prisma.phase.upsert({
        where: { id: p.id },
        update: { name: p.name, order: p.order, plannedStart: p.plannedStart, plannedEnd: p.plannedEnd },
        create: { ...p, projectId: PROJECT_ID },
      });
    }
    const actPhase: Record<string, string> = {
      'ACT-22': 'PH-services',
      'ACT-28': 'PH-services',
      'ACT-25': 'PH-wetareas',
      'ACT-31': 'PH-finishing',
      'ACT-35': 'PH-finishing',
      'ACT-33': 'PH-finishing',
    };
    for (const [actId, phaseId] of Object.entries(actPhase)) {
      // updateMany so a missing activity is a no-op; only fill an empty phaseId
      await prisma.activity.updateMany({ where: { id: actId, projectId: PROJECT_ID, phaseId: null }, data: { phaseId } });
    }
    // eslint-disable-next-line no-console
    console.log(`ensured ${phases.length} phase(s) + activity assignments on ${PROJECT_ID}`);

    // Location-spine backfill for the seeded demo project (Templates Slice 4 / data-flow
    // audit #1): the live ambli DB predates ProjectNode, so its Site Map is empty. Guarded
    // at the PROJECT level — it runs only while the project has NO nodes at all (mirroring
    // createStarterLibrary's zero-modules guard), so a tree the PMC has since built or
    // curated (including deleting seed nodes) is never added to, resurrected or re-filed.
    // Create + attach commit in ONE transaction: a half-applied backfill (tree without its
    // filings) can't survive a mid-boot crash and then be skipped forever by the guard.
    const nodeCount = await prisma.projectNode.count({ where: { projectId: PROJECT_ID } });
    if (nodeCount === 0) {
      const pmcUser = await prisma.user.findUnique({ where: { email: 'pmc@vitan.in' }, select: { id: true } });
      let nodesCreated = 0;
      await prisma.$transaction(async (tx) => {
        for (const n of SEED_NODES) {
          // An authorless draft (publishedAt null + authorId null) is visible to NO ONE and
          // create-only means it would never be repaired — if the roster (ACCOUNTS_JSON)
          // has no pmc@vitan.in, skip the demo draft branch rather than seed ghost rows.
          if (n.draft && !pmcUser) continue;
          await tx.projectNode.create({
            data: {
              id: n.id,
              projectId: PROJECT_ID,
              parentId: n.parentId,
              name: n.name,
              kind: n.kind,
              order: n.order,
              publishedAt: n.draft ? null : new Date(),
              authorId: n.draft ? pmcUser!.id : null,
            },
          });
          nodesCreated += 1;
        }
        // File the known demo records onto the fresh spine ONLY where nodeId is still
        // null — a hand-filed (or deliberately unfiled) place is never moved.
        for (const d of SEED_DECISIONS) {
          if (d.nodeId) await tx.decision.updateMany({ where: { id: d.id, projectId: PROJECT_ID, nodeId: null }, data: { nodeId: d.nodeId } });
        }
        for (const a of SEED_ACTIVITIES) {
          if (a.nodeId) await tx.activity.updateMany({ where: { id: a.id, projectId: PROJECT_ID, nodeId: null }, data: { nodeId: a.nodeId } });
        }
        for (const i of SEED_INSPECTIONS) {
          if (i.nodeId) await tx.inspection.updateMany({ where: { id: i.id, projectId: PROJECT_ID, nodeId: null }, data: { nodeId: i.nodeId } });
        }
        for (const m of SEED_LOG_MATERIALS) {
          if (m.nodeId) await tx.siteMaterial.updateMany({ where: { name: m.name, decisionId: m.decisionId, nodeId: null, dailyLog: { projectId: PROJECT_ID } }, data: { nodeId: m.nodeId } });
        }
      });
      // eslint-disable-next-line no-console
      console.log(`backfilled ${nodesCreated} location node(s) + spine attachments on ${PROJECT_ID}`);
    } else {
      // eslint-disable-next-line no-console
      console.log('project already has location nodes — spine untouched');
    }
  }

  // The Vitan starter template library (Templates Slice 4): modules + the "G+2 Residence"
  // preset. Create-only — runs ONLY when the org has no modules at all, so a curated
  // library is never touched by a redeploy.
  const seededLibrary = await createStarterLibrary(prisma, org.id);
  // eslint-disable-next-line no-console
  console.log(seededLibrary ? `seeded the starter template library for org ${org.slug}` : `org ${org.slug} already has modules — library untouched`);

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
