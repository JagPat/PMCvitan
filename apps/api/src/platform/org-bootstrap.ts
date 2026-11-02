import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PrismaService } from '../prisma.service';
import { fromIsoCivilDate } from '../common/civil-date';
import { lockOrgStanding, lockProjectReadiness } from '../common/readiness-lock';
import { lockOrgStandingWriters } from '../orgs/org-standing';
import { timeZoneSchema } from '../contracts';

/**
 * Fresh start (Jagrut, 1 Nov 2026) — make one company from nothing: the company, its first project,
 * and its people, in ONE transaction. Every account must have a home project (`User.projectId` is
 * required), so on an empty database no one can sign in to create the first company; this is the
 * operator's way in. After it, everything else (more projects, more people) is done in the app.
 *
 * It only ever CREATES. It refuses, before any write, a company name already in use, and any email
 * or phone that already has an account, so it can never change or take over an existing account.
 * Nobody gets a password: each person sets one with "Forgot password" (the emailed code).
 *
 * Without `commit` it is a dry run: everything is written and checked, then rolled back.
 */

const PROJECT_ROLES = ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as const;
const COMPANY_ROLES = ['owner', 'admin'] as const;

const personSchema = z
  .object({
    name: z.string().trim().min(1),
    // an email is required: "Forgot password" and (until SMS is live) the phone code both go to it
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().regex(/^\d{10}$/, 'phone: 10 digits').optional(),
    companyRole: z.enum(COMPANY_ROLES).optional(),
    projectRole: z.enum(PROJECT_ROLES).optional(),
    // the same bound as the app's member add and update (`disciplineField` in contracts.ts)
    discipline: z.string().trim().min(1).max(40).optional(),
  })
  .strict()
  // the app keeps a discipline only on a consultant (members.service `disciplineFor`)
  .refine((p) => !p.discipline || p.projectRole === 'consultant', { message: 'discipline is only for a consultant' })
  .refine((p) => p.companyRole || p.projectRole, { message: 'each person needs a companyRole or a projectRole' });

export const bootstrapSpecSchema = z
  .object({
    company: z.object({ name: z.string().trim().min(1), qaOnly: z.boolean().default(false) }).strict(),
    project: z
      .object({
        name: z.string().trim().min(1),
        short: z.string().trim().min(1),
        descriptor: z.string().trim().default(''),
        stage: z.string().trim().default('Planning'),
        siteCode: z.string().trim().min(1),
        location: z.string().trim().default(''),
        // the app's own zone check, so an unknown zone is a bad spec (exit 2), not a failed run
        timeZone: timeZoneSchema.default('Asia/Kolkata'),
      })
      .strict(),
    people: z.array(personSchema).min(1),
  })
  .strict()
  .refine((s) => s.people.some((p) => p.companyRole === 'owner'), { message: 'the company needs at least one owner' });

export type BootstrapSpec = z.infer<typeof bootstrapSpecSchema>;

export interface BootstrapRecord {
  ok: boolean;
  outcome: 'committed' | 'dry-run' | 'refused';
  refusals: string[];
  company?: { id: string; name: string; slug: string; qaOnly: boolean };
  project?: { id: string; name: string };
  people: Array<{ id: string; name: string; email: string | null; phone: string | null; companyRole: string | null; projectRole: string | null }>;
}

class DryRunRollback extends Error {}

/** The command line: exactly `--spec <path>` and an optional `--commit`. Anything else (a misspelled
 *  `--commmit`, a stray word, a repeated flag) is `wrong`, never a silent dry run. */
export function parseBootstrapArgs(args: readonly string[]): { specPath?: string; commit: boolean; wrong: boolean } {
  let specPath: string | undefined;
  let commit = false;
  let wrong = false;
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === '--spec' && specPath === undefined && next !== undefined && !next.startsWith('--')) specPath = args[++i];
    else if (args[i] === '--commit' && !commit) commit = true;
    else wrong = true;
  }
  return { specPath, commit, wrong };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'org';
}

function today(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

/** What makes the spec unrunnable against this database: names and addresses already taken, and repeats. */
async function refusalsFor(tx: Prisma.TransactionClient, spec: BootstrapSpec): Promise<string[]> {
  const out: string[] = [];
  const emails = spec.people.map((p) => p.email);
  const phones = spec.people.flatMap((p) => (p.phone ? [p.phone] : []));
  for (const dup of [...emails, ...phones].filter((v, i, all) => all.indexOf(v) !== i)) out.push(`listed twice: ${dup}`);
  if (await tx.org.findFirst({ where: { name: spec.company.name }, select: { id: true } })) out.push(`a company named "${spec.company.name}" already exists`);
  const taken = await tx.user.findMany({ where: { OR: [{ email: { in: emails } }, { phone: { in: phones } }] }, select: { email: true, phone: true } });
  for (const u of taken) out.push(`already has an account: ${u.email ?? u.phone}`);
  return out;
}

export async function bootstrapOrg(prisma: PrismaService, spec: BootstrapSpec, opts: { commit: boolean }): Promise<BootstrapRecord> {
  const record: BootstrapRecord = { ok: false, outcome: 'refused', refusals: [], people: [] };
  try {
    await prisma.$transaction(
      async (tx) => {
        record.refusals = await refusalsFor(tx, spec);
        if (record.refusals.length) return;

        // the order every org writer keeps: the org key, then the project's readiness key
        const org = await tx.org.create({
          data: { name: spec.company.name, slug: `${slugify(spec.company.name)}-${randomUUID().slice(0, 4)}`, qaOnly: spec.company.qaOnly },
        });
        await lockOrgStanding(tx, org.id);
        const projectId = `${slugify(spec.project.short)}-${randomUUID().slice(0, 4)}`;
        await lockProjectReadiness(tx, projectId);
        const p = spec.project;
        const project = await tx.project.create({
          data: {
            id: projectId,
            orgId: org.id,
            name: p.name,
            short: p.short,
            descriptor: p.descriptor,
            stage: p.stage,
            siteCode: p.siteCode,
            location: p.location,
            projStart: '',
            projEnd: '',
            scheduleStartDate: fromIsoCivilDate(today(p.timeZone)),
            timeZone: p.timeZone,
            elapsedPct: 0,
            todayDay: 0,
            milestonePct: 0,
          },
        });

        for (const person of spec.people) {
          // the home project only satisfies the schema; access comes from the grants below. A home role
          // never reads as `pmc` unless the person runs the project (as `addOrgMember` does).
          const user = await tx.user.create({
            data: { projectId: project.id, role: person.projectRole ?? 'contractor', name: person.name, email: person.email, phone: person.phone ?? null },
          });
          if (person.projectRole) {
            await tx.membership.create({
              data: { projectId: project.id, userId: user.id, role: person.projectRole, discipline: person.discipline ?? null, status: 'active' },
            });
          }
          if (person.companyRole) {
            // an owner/admin grant is an org-standing write: the org key, the org marker, every project's key
            await lockOrgStandingWriters(tx, org.id);
            await tx.orgMembership.create({ data: { orgId: org.id, userId: user.id, role: person.companyRole } });
          }
          record.people.push({ id: user.id, name: user.name, email: user.email, phone: user.phone, companyRole: person.companyRole ?? null, projectRole: person.projectRole ?? null });
        }

        record.company = { id: org.id, name: org.name, slug: org.slug, qaOnly: org.qaOnly };
        record.project = { id: project.id, name: project.name };
        record.ok = true;
        record.outcome = opts.commit ? 'committed' : 'dry-run';
        if (!opts.commit) throw new DryRunRollback();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
    );
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return record;
}
