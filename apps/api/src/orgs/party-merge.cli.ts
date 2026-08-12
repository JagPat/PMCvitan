import { PrismaService } from '../prisma.service';
import { PartyMergeService } from './party-merge.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { RequirementsQueryService } from '../activities/requirements.query';
import type { AuthUser } from '../common/auth';

/**
 * Phase 6 unit 6.1b — the operator MERGE/REPOINT command (plan §A).
 *
 *   pnpm --filter api party:merge --org <id> --surviving <partyId> --absorbed <partyId> \
 *        --operator <you@example.com> --reason <text>
 *
 * A CLI rather than an HTTP route, for the same reason `capability:enable` is one: this is a rare,
 * high-authority correction to canonical identity, not a workflow step. It moves every reference a
 * firm has across every project it reaches, and it deletes an identity.
 *
 * It does NOT decide which rows are the same firm. That judgement is the operator's, and the two
 * party ids they supply ARE that judgement — which is why the command records both, plus the
 * absorbed firm's name, on the audit trail before the row that carries it is gone.
 *
 * `--operator` must be a user who holds owner/admin standing in the org. The service re-checks that
 * under a row lock inside its own transaction, so a revocation racing this command blocks rather
 * than slipping between the check and the repoint.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (!f.org || !f.surviving || !f.absorbed || !f.operator || !f.reason) {
    process.stderr.write(
      'usage: party:merge --org <id> --surviving <partyId> --absorbed <partyId> '
        + '--operator <identity> --reason <text>\n',
    );
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaService();
  try {
    // The operator is named by identity, not by a token: this runs from a shell, and the authority
    // it asserts has to resolve to a real member of the org whose firms are being reconciled.
    const user = await prisma.user.findFirst({ where: { email: f.operator }, select: { id: true } });
    if (!user) {
      process.stderr.write(`party:merge: no user with email ${f.operator}\n`);
      process.exitCode = 2;
      return;
    }

    // Constructed directly rather than through Nest: a CLI has no request scope, and the merge
    // needs exactly these two collaborators. `ProcurementParticipant` carries its own dependency
    // for the paths this command does not use.
    const service = new PartyMergeService(prisma, new ProcurementParticipant(new RequirementsQueryService()));
    const result = await service.merge(
      f.org,
      { survivingPartyId: f.surviving, absorbedPartyId: f.absorbed },
      { sub: user.id, role: 'pmc', orgId: f.org } as AuthUser,
      // A stable key derived from the judgement itself: re-running the same merge after a lost
      // connection replays the receipt instead of attempting a second, now-impossible merge.
      `party-merge:${f.org}:${f.surviving}:${f.absorbed}`,
    );

    process.stdout.write(
      `party:merge: "${result.absorbedName}" (${result.absorbedPartyId}) folded into `
        + `${result.survivingPartyId}\n`
        + `  repointed: ${result.repointed.companies} directory row(s), `
        + `${result.repointed.vendors} vendor(s), `
        + `${result.repointed.associations} project association(s) released\n`
        + `  reason: ${f.reason}\n`,
    );
  } catch (e) {
    process.stderr.write(`party:merge: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
