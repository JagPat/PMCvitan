import { writeFileSync } from 'node:fs';
import { PrismaService } from '../../prisma.service';
import {
  coolifyInventoryReader, gitAncestryClassifier, judgeDrain, readDrainInputsFromDatabase, renderDrainEvidence,
  type DrainEvidenceInput, type PlatformInventory,
} from './drain-evidence';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6e — the drain's autonomous corroboration (the 4d plan §D):
 *
 *   COOLIFY_TOKEN=<read token> pnpm --filter api rollout:drain-evidence \
 *        --minimum-release <commit> --app <coolify application uuid> \
 *        [--coolify-url https://…/api/v1] [--repo <git checkout>] [--out <comment-body.md>] \
 *        [--minimum-catalog-version <n>]
 *
 * Reads the platform's inventory and the `ReleaseLease` register, judges them against the minimum
 * release, prints the evidence as JSON on stdout and the `DRAIN-EVIDENCE` comment body on stderr (or
 * to `--out`), and exits 0 only on `drained`. An OBSERVER: it drains, stops, deploys and posts
 * nothing; the runner records the body on the controlling issue. The token is read from the
 * environment only (an argument would be visible to every process on the host) and never printed.
 * Since 2026-10-01 (docs/POLICY.md) the committed `drained` verdict is what clears the gate: commit the
 * stdout JSON as docs/rollout/phase-6-4d-drain-evidence.json in the PR that clears the directive.
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
  const minimumRelease = f['minimum-release']?.trim();
  const app = (f.app ?? process.env.COOLIFY_APP_UUID ?? '').trim();
  const coolifyUrl = (f['coolify-url'] ?? process.env.COOLIFY_API_URL ?? '').trim();
  if (!minimumRelease || !app || !coolifyUrl) {
    process.stderr.write('usage: rollout:drain-evidence --minimum-release <commit> --app <application uuid> [--coolify-url <api base>] [--repo <dir>] [--out <file>] [--minimum-catalog-version <n>]\n'
      + '       COOLIFY_TOKEN must be set in the environment (never passed as an argument); COOLIFY_APP_UUID and COOLIFY_API_URL stand in for --app and --coolify-url.\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const db = await readDrainInputsFromDatabase(prisma);
    const override = f['minimum-catalog-version']?.trim();
    const minimumCatalogVersion = override
      ? { value: Number(override), source: '--minimum-catalog-version' }
      : { value: db.catalogMaximum ?? 0, source: db.catalogMaximum === null ? 'no persisted catalog row' : 'the persisted catalog maximum' };
    if (!Number.isInteger(minimumCatalogVersion.value) || minimumCatalogVersion.value < 1) {
      process.stderr.write(`rollout:drain-evidence: minimum catalog version ${minimumCatalogVersion.value} (${minimumCatalogVersion.source}) is not a registered generation\n`);
      process.exitCode = 2;
      return;
    }
    let platform: DrainEvidenceInput['platform'];
    const token = process.env.COOLIFY_TOKEN?.trim();
    if (!token) {
      platform = { unavailable: 'COOLIFY_TOKEN is not set' };
    } else {
      try {
        const inventory: PlatformInventory = await coolifyInventoryReader({ baseUrl: coolifyUrl, token, fetch: fetch as never }).read(app);
        platform = { inventory };
      } catch (e) {
        platform = { unavailable: (e as Error).message };
      }
    }
    const evidence = judgeDrain({
      minimumRelease,
      minimumCatalogVersion,
      compiledGeneration: db.compiledGeneration,
      persistedMinimum: db.persistedMinimum,
      platform,
      leases: db.leases,
      classifier: gitAncestryClassifier(f.repo?.trim() || process.cwd()),
      recordedAt: new Date(),
    });
    const body = renderDrainEvidence(evidence);
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    if (f.out) writeFileSync(f.out, body); else process.stderr.write(body);
    process.exitCode = evidence.verdict === 'drained' ? 0 : 1;
  } catch (e) {
    process.stderr.write(`rollout:drain-evidence: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
