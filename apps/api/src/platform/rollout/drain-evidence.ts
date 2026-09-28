import { spawnSync } from 'node:child_process';
import { Prisma } from '@prisma/client';
import { SERVER_GENERATION, readServerMinimum, type PersistedServerMinimum } from '../server-generation';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6e — `rollout:drain-evidence`, the drain's autonomous CORROBORATION
 * (the 4d plan §D, "The drain attestation": "the deploy platform's running-container inventory:
 * `rollout:drain-evidence` reads Coolify's API for the application's running containers and asserts
 * every image is at or after the minimum release, failing closed on any container it cannot
 * classify, and records its evidence (the inventory, the minimum release, the verdict) as a
 * `DRAIN-EVIDENCE` comment on the controlling issue — an OBSERVER of the platform's state, never an
 * actor that drains anything").
 *
 * WHAT IT IS NOT. The gate `phase-6-4d-previous-release-drained` clears ONLY on the direct explicit
 * human operator attestation (docs/POLICY.md; the Board decision carried from 4c). This evidence is
 * corroboration the runner records BESIDE it: never a substitute, never a reason to treat a wait
 * for the attestation as permission to clear the gate. The command reads; it starts, stops, deploys
 * and drains nothing, and it posts nothing itself — it renders the comment body for the runner to
 * record, so no platform or GitHub credential passes through it beyond the read token it is given.
 *
 * TWO PIECES OF EVIDENCE, both read here:
 *   (i) the `ReleaseLease` register — every serving process from 4d-ii on writes and renews a lease
 *       carrying its compiled consumer-catalog version, so "no LIVE lease at a catalog version below
 *       the minimum" is in-database proof that no older-generation process that started after the
 *       register existed is still serving;
 *  (ii) for the processes that predate the register, the platform's inventory: the application
 *       resource (its running status and the commit its image was built from) and the platform's
 *       queue of running deployments (a deployment in progress means two images may serve at once).
 * Beside them the persisted server-generation minimum and this build's compiled generation, which
 * is the fence that keeps the attested state durable afterwards.
 *
 * FAIL CLOSED. A release the classifier cannot place against the minimum (no git ancestry, a
 * `RELEASE_ID` that is not a commit, an `unreleased` lease), an application that is not running, a
 * deployment in progress, or a platform read that fails all yield `unclassified` — never `drained`.
 * A container or lease PROVABLY older than the minimum yields `not-drained`, which dominates.
 */

export const DRAIN_DIRECTIVE = 'phase-6-4d-previous-release-drained';
export const DRAIN_EVIDENCE_MARKER = 'DRAIN-EVIDENCE';

export type Classification = 'at-or-after' | 'before' | 'unclassifiable';
export type DrainVerdict = 'drained' | 'not-drained' | 'unclassified';

export interface ReleaseClassifier {
  /** Is `release` at or after `minimumRelease` in the deployed lineage? */
  classify(minimumRelease: string, release: string): Classification;
}

export interface PlatformApplication {
  id: number;
  uuid: string;
  name: string;
  fqdn: string | null;
  status: string;
  /** the commit the running image was built from */
  gitCommitSha: string;
}

export interface PlatformDeployment {
  deploymentUuid: string;
  applicationId: number;
  status: string;
  commit: string | null;
}

export interface PlatformInventory {
  source: string;
  application: PlatformApplication;
  /** the platform's queue of RUNNING deployments (every application), as read */
  runningDeployments: PlatformDeployment[];
}

export interface LiveLease {
  instanceId: string;
  catalogVersion: number;
  release: string;
  startedAt: Date;
  leaseUntil: Date;
}

export interface DrainEvidenceInput {
  minimumRelease: string;
  minimumCatalogVersion: { value: number; source: string };
  compiledGeneration: number;
  persistedMinimum: PersistedServerMinimum | null;
  platform: { inventory: PlatformInventory } | { unavailable: string };
  leases: LiveLease[];
  classifier: ReleaseClassifier;
  recordedAt: Date;
}

export interface DrainEvidence {
  marker: typeof DRAIN_EVIDENCE_MARKER;
  directive: typeof DRAIN_DIRECTIVE;
  minimumRelease: string;
  minimumCatalogVersion: { value: number; source: string };
  generation: { compiled: number; persistedMinimum: PersistedServerMinimum | null };
  platform:
    | { available: true; source: string; application: PlatformApplication & { classification: Classification }; deploymentsInProgress: PlatformDeployment[] }
    | { available: false; reason: string };
  leases: Array<LiveLease & { classification: Classification }>;
  findings: string[];
  verdict: DrainVerdict;
  recordedAt: string;
}

/** The pure judgement over what was read. */
export function judgeDrain(input: DrainEvidenceInput): DrainEvidence {
  const findings: string[] = [];
  let notDrained = false;
  let unclassified = false;
  const refuse = (finding: string) => { notDrained = true; findings.push(finding); };
  const cannot = (finding: string) => { unclassified = true; findings.push(finding); };

  // the fence
  if (!input.persistedMinimum) {
    cannot(`no persisted server-generation minimum: the fence migration has not run on this database`);
  } else if (input.persistedMinimum.minimumGeneration > input.compiledGeneration) {
    cannot(`this command compiles server generation ${input.compiledGeneration}, below the persisted minimum ${input.persistedMinimum.minimumGeneration}: it is itself an older build and cannot judge the fleet`);
  }

  // (ii) the platform inventory
  let platform: DrainEvidence['platform'];
  if ('unavailable' in input.platform) {
    cannot(`platform inventory unavailable: ${input.platform.unavailable}`);
    platform = { available: false, reason: input.platform.unavailable };
  } else {
    const { application, runningDeployments, source } = input.platform.inventory;
    const inProgress = runningDeployments.filter((d) => d.applicationId === application.id);
    const classification = input.classifier.classify(input.minimumRelease, application.gitCommitSha);
    if (!/^running\b/.test(application.status)) {
      cannot(`application ${application.uuid} (${application.name}) is not running (status "${application.status}"): the drain is judged over a serving fleet, and a stopped one is not evidence of which image would serve next`);
    }
    if (inProgress.length > 0) {
      cannot(`${inProgress.length} deployment(s) in progress for application ${application.uuid} (${inProgress.map((d) => `${d.deploymentUuid}:${d.status}`).join(', ')}): two images may serve at once until it finishes`);
    }
    if (classification === 'before') {
      refuse(`application ${application.uuid} (${application.name}) serves image commit ${application.gitCommitSha}, BEFORE the minimum release ${input.minimumRelease}`);
    } else if (classification === 'unclassifiable') {
      cannot(`application ${application.uuid} (${application.name}) serves image commit "${application.gitCommitSha}", which cannot be placed against the minimum release ${input.minimumRelease}`);
    }
    platform = { available: true, source, application: { ...application, classification }, deploymentsInProgress: inProgress };
  }

  // (i) the lease register
  const leases = input.leases.map((lease) => {
    const classification = input.classifier.classify(input.minimumRelease, lease.release);
    if (lease.catalogVersion < input.minimumCatalogVersion.value) {
      refuse(`live lease ${lease.instanceId} (release ${lease.release}) serves at catalog version ${lease.catalogVersion}, below the minimum ${input.minimumCatalogVersion.value}`);
    } else if (classification === 'before') {
      refuse(`live lease ${lease.instanceId} names release ${lease.release}, BEFORE the minimum release ${input.minimumRelease}`);
    } else if (classification === 'unclassifiable') {
      cannot(`live lease ${lease.instanceId} names release "${lease.release}", which cannot be placed against the minimum release ${input.minimumRelease}`);
    }
    return { ...lease, classification };
  });

  const verdict: DrainVerdict = notDrained ? 'not-drained' : unclassified ? 'unclassified' : 'drained';
  return {
    marker: DRAIN_EVIDENCE_MARKER,
    directive: DRAIN_DIRECTIVE,
    minimumRelease: input.minimumRelease,
    minimumCatalogVersion: input.minimumCatalogVersion,
    generation: { compiled: input.compiledGeneration, persistedMinimum: input.persistedMinimum },
    platform,
    leases,
    findings,
    verdict,
    recordedAt: input.recordedAt.toISOString(),
  };
}

/** The comment body the runner records on the controlling issue. Corroboration; never an attestation. */
export function renderDrainEvidence(ev: DrainEvidence): string {
  const verdict = ev.verdict === 'drained' ? 'DRAINED' : ev.verdict === 'not-drained' ? 'NOT DRAINED' : 'UNCLASSIFIED (fail closed)';
  const gen = ev.generation.persistedMinimum
    ? `persisted minimum ${ev.generation.persistedMinimum.minimumGeneration} (raised by \`${ev.generation.persistedMinimum.raisedBy}\` at ${ev.generation.persistedMinimum.raisedAt.toISOString()})`
    : 'NO persisted minimum';
  const lines = [
    `${ev.marker} — autonomous corroboration for \`${ev.directive}\`, recorded ${ev.recordedAt}.`,
    `This is an OBSERVATION, not an attestation: the gate clears only on the direct explicit human operator attestation (docs/POLICY.md). Nothing was drained, stopped, deployed or changed.`,
    '',
    `- **Verdict: ${verdict}**`,
    `- Minimum release: \`${ev.minimumRelease}\`; minimum consumer-catalog version: ${ev.minimumCatalogVersion.value} (${ev.minimumCatalogVersion.source})`,
    `- Server generation: this build compiles ${ev.generation.compiled}; ${gen}`,
  ];
  if (ev.platform.available) {
    const a = ev.platform.application;
    lines.push(`- Platform inventory (${ev.platform.source}): application \`${a.uuid}\` ${a.name}${a.fqdn ? ` (${a.fqdn})` : ''} — status \`${a.status}\`, image commit \`${a.gitCommitSha}\` → ${a.classification}; deployments in progress for it: ${ev.platform.deploymentsInProgress.length}`);
  } else {
    lines.push(`- Platform inventory: UNAVAILABLE — ${ev.platform.reason}`);
  }
  lines.push(`- Lease register: ${ev.leases.length} live lease(s)${ev.leases.length ? ':' : ''}`);
  for (const l of ev.leases) {
    lines.push(`  - \`${l.instanceId}\` catalog version ${l.catalogVersion}, release \`${l.release}\` → ${l.classification}, started ${l.startedAt.toISOString()}, lease until ${l.leaseUntil.toISOString()}`);
  }
  lines.push(`- Findings: ${ev.findings.length ? '' : 'none'}`);
  for (const f of ev.findings) lines.push(`  - ${f}`);
  return lines.join('\n') + '\n';
}

// ── the readers ──────────────────────────────────────────────────────────────────────────────────

type LeaseDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Every LIVE lease, on the database clock. */
export async function readLiveLeases(db: LeaseDb): Promise<LiveLease[]> {
  const rows = await db.$queryRaw<Array<{ instanceId: string; catalogVersion: number; release: string; startedAt: Date; leaseUntil: Date }>>(Prisma.sql`
    SELECT "instanceId", "catalogVersion", "release", "startedAt", "leaseUntil"
      FROM "ReleaseLease" WHERE "leaseUntil" > CURRENT_TIMESTAMP
     ORDER BY "catalogVersion", "startedAt", "instanceId"`);
  return rows.map((r) => ({ ...r, catalogVersion: Number(r.catalogVersion) }));
}

/** The highest catalog version any registered consumer persists: the release under deploy synced it. */
export async function readPersistedCatalogMaximum(db: LeaseDb): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ max: number | null }>>(Prisma.sql`SELECT max("catalogVersion")::int AS max FROM "OutboxConsumerCatalog"`);
  const max = rows[0]?.max;
  return max === null || max === undefined ? null : Number(max);
}

export async function readDrainInputsFromDatabase(db: LeaseDb): Promise<{ leases: LiveLease[]; persistedMinimum: PersistedServerMinimum | null; catalogMaximum: number | null; compiledGeneration: number }> {
  const [leases, persistedMinimum, catalogMaximum] = await Promise.all([readLiveLeases(db), readServerMinimum(db), readPersistedCatalogMaximum(db)]);
  return { leases, persistedMinimum, catalogMaximum, compiledGeneration: SERVER_GENERATION };
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The Coolify reader: `GET /applications/{uuid}` (the resource, its `status` and `git_commit_sha`)
 * and `GET /deployments` (the platform's running deployments). The token is sent and never
 * returned, logged or embedded in the evidence. Any read that fails or lacks a field the judgement
 * needs throws, which the command records as an unavailable inventory — fail closed.
 */
export function coolifyInventoryReader(opts: { baseUrl: string; token: string; fetch: FetchLike }): { read(appUuid: string): Promise<PlatformInventory> } {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' };
  const get = async (path: string): Promise<unknown> => {
    const res = await opts.fetch(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${base}${path} -> HTTP ${res.status}`);
    return res.json();
  };
  const str = (o: Record<string, unknown>, k: string, where: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where}: field "${k}" is absent or not a non-empty string`);
    return v;
  };
  const num = (o: Record<string, unknown>, k: string, where: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: field "${k}" is absent or not a number`);
    return v;
  };
  return {
    async read(appUuid) {
      const app = await get(`/applications/${encodeURIComponent(appUuid)}`);
      if (!app || typeof app !== 'object' || Array.isArray(app)) throw new Error(`GET /applications/${appUuid}: not an object`);
      const a = app as Record<string, unknown>;
      const application: PlatformApplication = {
        id: num(a, 'id', `application ${appUuid}`),
        uuid: str(a, 'uuid', `application ${appUuid}`),
        name: str(a, 'name', `application ${appUuid}`),
        fqdn: typeof a.fqdn === 'string' && a.fqdn.trim() !== '' ? a.fqdn : null,
        status: str(a, 'status', `application ${appUuid}`),
        gitCommitSha: str(a, 'git_commit_sha', `application ${appUuid}`),
      };
      const deps = await get('/deployments');
      if (!Array.isArray(deps)) throw new Error('GET /deployments: not an array');
      const runningDeployments: PlatformDeployment[] = deps.map((d, i) => {
        if (!d || typeof d !== 'object') throw new Error(`GET /deployments[${i}]: not an object`);
        const o = d as Record<string, unknown>;
        return {
          deploymentUuid: str(o, 'deployment_uuid', `deployment[${i}]`),
          applicationId: num(o, 'application_id', `deployment[${i}]`),
          status: str(o, 'status', `deployment[${i}]`),
          commit: typeof o.commit === 'string' ? o.commit : null,
        };
      });
      return { source: `Coolify ${base}`, application, runningDeployments };
    },
  };
}

/**
 * The git-ancestry classifier: a release is at or after the minimum when the minimum is an ancestor
 * of it (or the same commit) in the checkout at `repoDir`. Either name failing to resolve to a commit
 * — a short sha the checkout does not have, a `RELEASE_ID` that is no commit, `unreleased` — is
 * unclassifiable, never a guess.
 */
export function gitAncestryClassifier(repoDir: string, run: (args: string[]) => { status: number | null; stdout: string } = (args) => {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}): ReleaseClassifier {
  const resolve = (name: string): string | null => {
    if (!/^[0-9a-f]{7,40}$/i.test(name.trim())) return null;
    const r = run(['rev-parse', '--verify', '--quiet', `${name.trim()}^{commit}`]);
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  return {
    classify(minimumRelease, release) {
      const min = resolve(minimumRelease);
      const rel = resolve(release);
      if (!min || !rel) return 'unclassifiable';
      if (min === rel) return 'at-or-after';
      const r = run(['merge-base', '--is-ancestor', min, rel]);
      if (r.status === 0) return 'at-or-after';
      if (r.status === 1) return 'before';
      return 'unclassifiable';
    },
  };
}
