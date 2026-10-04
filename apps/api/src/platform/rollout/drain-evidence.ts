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
 * WHAT IT IS, SINCE 2026-10-01. The owner withdrew the human operator attestation the gate
 * `phase-6-4d-previous-release-drained` used to require (docs/POLICY.md; #482 comment 5929472784), so
 * this command's `drained` verdict IS what clears the gate — once the trusted `drain-evidence` workflow
 * (.github/workflows/drain-evidence.yml, the owner's choice of 2026-10-02) has run it on `main` and its
 * stamped JSON is committed unchanged as `docs/rollout/phase-6-4d-drain-evidence.json`, where the
 * review-scope gate and the merge controller verify it against that run's artifact
 * (`scripts/autonomous-drain-clearance.mjs`) on the PR that removes the directive. The command still
 * only reads; it starts, stops, deploys and drains nothing, and it posts nothing itself — it renders
 * the comment body for the operator to record, so no platform or GitHub credential passes through it
 * beyond the read token it is given.
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

/**
 * The platform's deployment states (#663's review round 4, finding 1). A record in a TERMINAL state
 * is history, not a deployment in progress, whatever endpoint returned it; a record in an ACTIVE
 * state means two images may serve at once. A state this list does not know is counted IN PROGRESS
 * and named in a finding — fail closed, and visibly, rather than guessing which way it leans.
 */
export const DEPLOYMENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'cancelled-by-user', 'cancelled']);
export const DEPLOYMENT_ACTIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'in_progress']);

/** Whether a deployment record still counts as in progress, and whether that judgement rests on a known state. */
export function deploymentInProgress(status: string): { inProgress: boolean; known: boolean } {
  const s = status.trim().toLowerCase();
  if (DEPLOYMENT_TERMINAL_STATUSES.has(s)) return { inProgress: false, known: true };
  if (DEPLOYMENT_ACTIVE_STATUSES.has(s)) return { inProgress: true, known: true };
  return { inProgress: true, known: false };
}
export type DrainVerdict = 'drained' | 'not-drained' | 'unclassified';

export interface ReleaseClassifier {
  /** Is `release` at or after `minimumRelease` in the deployed lineage? */
  classify(minimumRelease: string, release: string): Classification;
}

/**
 * Where a running commit came from when Coolify's `git_commit_sha` was not itself a commit.
 * `finished-deployment` is the newest finished production deployment: Coolify stores the commit it
 * resolved (its default `HEAD` means "track the branch tip") on that row, and tags the running image
 * `{application uuid}:{commit}`.
 */
export interface RunningCommitSource {
  source: 'finished-deployment';
  deploymentUuid: string;
  /** the application's `git_commit_sha` as Coolify returned it, before resolution */
  configuredGitCommitSha: string;
}

export interface PlatformApplication {
  id: number;
  uuid: string;
  name: string;
  fqdn: string | null;
  status: string;
  /** the commit the running image was built from */
  gitCommitSha: string;
  /** set when `gitCommitSha` was taken from a finished deployment rather than `git_commit_sha` */
  runningCommit?: RunningCommitSource;
  /**
   * Set when `git_commit_sha` is not a commit and no verifiable running commit could be read.
   * `judgeDrain` fails closed with this text. Absent when the commit did not need resolving.
   */
  runningCommitUnresolved?: string;
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
    // this application's records, judged by STATE: a finished, failed or cancelled record is history
    // (#663 round 4, finding 1); an unknown state is counted in progress and named
    const own = runningDeployments.filter((d) => d.applicationId === application.id);
    const inProgress = own.filter((d) => deploymentInProgress(d.status).inProgress);
    const unknown = inProgress.filter((d) => !deploymentInProgress(d.status).known);
    const classification = input.classifier.classify(input.minimumRelease, application.gitCommitSha);
    if (!/^running\b/.test(application.status)) {
      cannot(`application ${application.uuid} (${application.name}) is not running (status "${application.status}"): the drain is judged over a serving fleet, and a stopped one is not evidence of which image would serve next`);
    }
    if (inProgress.length > 0) {
      cannot(`${inProgress.length} deployment(s) in progress for application ${application.uuid} (${inProgress.map((d) => `${d.deploymentUuid}:${d.status}`).join(', ')}): two images may serve at once until it finishes${unknown.length ? ` — ${unknown.map((d) => `"${d.status}"`).join(', ')} ${unknown.length === 1 ? 'is not a state this command knows and is' : 'are not states this command knows and are'} counted in progress` : ''}`);
    }
    if (classification === 'before') {
      refuse(`application ${application.uuid} (${application.name}) serves image commit ${application.gitCommitSha}, BEFORE the minimum release ${input.minimumRelease}`);
    } else if (classification === 'unclassifiable') {
      const why = application.runningCommitUnresolved ? ` (${application.runningCommitUnresolved})` : '';
      cannot(`application ${application.uuid} (${application.name}) serves image commit "${application.gitCommitSha}", which cannot be placed against the minimum release ${input.minimumRelease}${why}`);
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
    `This is an OBSERVATION, not an attestation: the gate clears only when the drain-evidence workflow's drained verdict is committed unchanged as docs/rollout/phase-6-4d-drain-evidence.json and the review-scope gate verifies it (docs/POLICY.md). Nothing was drained, stopped, deployed or changed.`,
    '',
    `- **Verdict: ${verdict}**`,
    `- Minimum release: \`${ev.minimumRelease}\`; minimum consumer-catalog version: ${ev.minimumCatalogVersion.value} (${ev.minimumCatalogVersion.source})`,
    `- Server generation: this build compiles ${ev.generation.compiled}; ${gen}`,
  ];
  if (ev.platform.available) {
    const a = ev.platform.application;
    const resolved = a.runningCommit
      ? ` (finished deployment \`${a.runningCommit.deploymentUuid}\`; Coolify git_commit_sha was \`${a.runningCommit.configuredGitCommitSha}\`)`
      : '';
    lines.push(`- Platform inventory (${ev.platform.source}): application \`${a.uuid}\` ${a.name}${a.fqdn ? ` (${a.fqdn})` : ''} — status \`${a.status}\`, image commit \`${a.gitCommitSha}\`${resolved} → ${a.classification}; deployments in progress for it: ${ev.platform.deploymentsInProgress.length}`);
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

/** The same shape `gitAncestryClassifier` will try to resolve. `HEAD` is not a commit. */
export function isGitCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/**
 * Build packs whose one production image is tagged `{uuid}:{commit}`, from Coolify's
 * `ApplicationDeploymentJob::generate_image_names` (the branch that is not an inline Dockerfile,
 * a registry image, or a preview). `railpack` takes that branch. `dockerimage` tags a registry
 * image instead. `dockercompose` is not here: a compose file can keep a service on an image that
 * is not that commit, and the read-only API does not return every running service image.
 *
 * That commit tag is used only when the `dockerfile` column is empty. A non-empty column is
 * deployed first, as `{uuid}:latest`. The column is hidden unless the token can read sensitive
 * fields, so a response that omits it is not proof the column is empty.
 */
const COMMIT_TAGGED_BUILD_PACKS: ReadonlySet<string> = new Set(['dockerfile', 'nixpacks', 'static', 'railpack']);

/** One page of `GET /deployments/applications/{uuid}`. Coolify's own default page is 10; this stays bounded. */
export const DEPLOYMENT_HISTORY_PAGE = 20;
const DEPLOYMENT_HISTORY_CAP = 100;

export type RunningCommitDecision =
  | { decision: 'resolved'; commit: string; deploymentUuid: string; inProgress: PlatformDeployment[] }
  | { decision: 'unresolved'; reason: string; inProgress: PlatformDeployment[] }
  | { decision: 'continue'; oldestCreatedAt: string; inProgress: PlatformDeployment[] };

function sameApplication(value: unknown, applicationId: number): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return value === applicationId;
  if (typeof value === 'string' && value.trim() === String(applicationId)) return true;
  return false;
}

function isExplicitTrue(value: unknown): boolean {
  return value === true || value === 1;
}

function isExplicitFalse(value: unknown): boolean {
  return value === false || value === 0;
}

/**
 * Whether a deployment's image tag, when Coolify sent one, is the same commit. An empty tag is the
 * git-build case (the tag is the commit and is not stored separately). Any other tag is a different
 * image and is not evidence of this commit.
 */
function imageTagAgrees(tag: unknown, commit: string): boolean {
  if (tag === undefined || tag === null) return true;
  if (typeof tag !== 'string') return false;
  const trimmed = tag.trim();
  if (trimmed === '') return true;
  if (trimmed.toLowerCase() === commit.toLowerCase()) return true;
  return isGitCommitSha(trimmed) && commit.toLowerCase().startsWith(trimmed.toLowerCase());
}

/**
 * Finished additional-destination rows already passed, keyed by the primary deployment they belong
 * to. Coolify writes those rows after it marks the primary `finished`, so they are newer than it.
 */
export interface DeploymentHistoryState {
  /** `additional_networks_count`: how many extra destinations a finished primary fans out to. */
  additionalNetworksCount: number;
  finishedChildren: Map<string, string[]>;
}

/**
 * `null` when this deployment is not an additional-server child. A string is the primary it belongs
 * to. `undefined` means the row does not say, so a child cannot be told from a primary.
 */
function parentDeploymentUuid(row: Record<string, unknown>): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, 'parent_deployment_uuid')) return undefined;
  const value = row.parent_deployment_uuid;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Walk one page of an application's deployment history, newest first, toward the commit of the image
 * that is actually running. A preview and a deploy still in progress did not replace that image. A
 * failed or cancelled deploy did not either, except when it is an additional server of a primary
 * Coolify already marked finished: that server may still be serving the older image, so the walk
 * stops. The newest finished primary did replace its own server. It is the whole fleet only when
 * every additional destination has a newer finished child of that same commit. Anything the record
 * does not prove — an unknown status, a commit that is still `HEAD`, a one-server deploy, an image
 * tag that is not that commit — stops the walk. An older finished deploy is not a substitute.
 */
export function judgeDeploymentHistoryPage(
  deployments: unknown,
  applicationId: number,
  previousCreatedAt: string | null,
  state: DeploymentHistoryState = { additionalNetworksCount: 0, finishedChildren: new Map() },
): RunningCommitDecision {
  if (!Array.isArray(deployments)) return { decision: 'unresolved', reason: 'deployment history is not an array', inProgress: [] };
  const inProgress: PlatformDeployment[] = [];
  let previous = previousCreatedAt;
  for (let i = 0; i < deployments.length; i++) {
    const raw = deployments[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { decision: 'unresolved', reason: `deployment history[${i}] is not an object`, inProgress };
    }
    const row = raw as Record<string, unknown>;
    const createdAt = row.created_at;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      return { decision: 'unresolved', reason: `deployment history[${i}] has no created_at, so newest-first order cannot be verified`, inProgress };
    }
    if (previous !== null && Date.parse(createdAt) > Date.parse(previous)) {
      return { decision: 'unresolved', reason: `deployment history is not ordered newest-first at ${createdAt}`, inProgress };
    }
    previous = createdAt;
    const where = `deployment history[${i}]`;
    if (typeof row.pull_request_id !== 'number' || !Number.isInteger(row.pull_request_id)) {
      return { decision: 'unresolved', reason: `${where} has no pull_request_id, so a preview cannot be told from production`, inProgress };
    }
    if (row.pull_request_id !== 0) continue;
    if (!sameApplication(row.application_id, applicationId)) {
      return { decision: 'unresolved', reason: `${where} application_id does not match this application`, inProgress };
    }
    if (typeof row.status !== 'string' || row.status.trim() === '') {
      return { decision: 'unresolved', reason: `${where} has no status`, inProgress };
    }
    const status = row.status.trim().toLowerCase();
    const progress = deploymentInProgress(status);
    if (!progress.known) {
      return { decision: 'unresolved', reason: `${where} has status "${row.status.trim()}", which this command does not know and which may be the running image`, inProgress };
    }
    const deploymentUuid = typeof row.deployment_uuid === 'string' ? row.deployment_uuid.trim() : '';
    if (deploymentUuid === '') return { decision: 'unresolved', reason: `${where} has no deployment_uuid`, inProgress };
    const commit = typeof row.commit === 'string' ? row.commit : null;
    if (progress.inProgress) {
      inProgress.push({ deploymentUuid, applicationId, status, commit });
      continue;
    }
    const parent = parentDeploymentUuid(row);
    if (parent === undefined) {
      return { decision: 'unresolved', reason: `${where} has no readable parent_deployment_uuid, so an additional server cannot be told from the primary`, inProgress };
    }
    if (status !== 'finished') {
      if (parent !== null) {
        return {
          decision: 'unresolved',
          reason: `deployment ${deploymentUuid} is an additional server of ${parent} and ended ${status}, so that server may still be serving an older image`,
          inProgress,
        };
      }
      continue;
    }
    if (!isExplicitFalse(row.restart_only) && !isExplicitTrue(row.restart_only)) {
      return { decision: 'unresolved', reason: `finished deployment ${deploymentUuid} restart_only is ${JSON.stringify(row.restart_only ?? null)}, so it is not clear whether it replaced the image`, inProgress };
    }
    if (row.only_this_server !== undefined && row.only_this_server !== null && !isExplicitFalse(row.only_this_server)) {
      return {
        decision: 'unresolved',
        reason: isExplicitTrue(row.only_this_server)
          ? `finished deployment ${deploymentUuid} is limited to one server (only_this_server), so it is not the whole fleet`
          : `finished deployment ${deploymentUuid} has an unreadable only_this_server flag`,
        inProgress,
      };
    }
    const resolved = commit?.trim() ?? '';
    if (!isGitCommitSha(resolved)) {
      return { decision: 'unresolved', reason: `the newest finished production deployment ${deploymentUuid} recorded commit "${resolved}", which is not a commit SHA`, inProgress };
    }
    if (!imageTagAgrees(row.docker_registry_image_tag, resolved)) {
      const tag = typeof row.docker_registry_image_tag === 'string' ? JSON.stringify(row.docker_registry_image_tag.trim()) : JSON.stringify(row.docker_registry_image_tag);
      return { decision: 'unresolved', reason: `finished deployment ${deploymentUuid} names image tag ${tag}, which is not its commit ${resolved}`, inProgress };
    }
    if (parent !== null) {
      const seen = state.finishedChildren.get(parent) ?? [];
      seen.push(resolved);
      state.finishedChildren.set(parent, seen);
      continue;
    }
    const otherParent = [...state.finishedChildren.keys()].find((id) => id !== deploymentUuid);
    if (otherParent !== undefined) {
      return { decision: 'unresolved', reason: `a finished additional server of ${otherParent} is newer than ${deploymentUuid}, so this deployment is not the newest fleet`, inProgress };
    }
    const children = state.finishedChildren.get(deploymentUuid) ?? [];
    if (children.some((child) => child.toLowerCase() !== resolved.toLowerCase())) {
      return { decision: 'unresolved', reason: `an additional server of finished deployment ${deploymentUuid} recorded a different commit than ${resolved}`, inProgress };
    }
    if (children.length !== state.additionalNetworksCount) {
      return {
        decision: 'unresolved',
        reason: `finished deployment ${deploymentUuid} has ${children.length} finished additional-server deployment(s) but the application has ${state.additionalNetworksCount} additional destination(s)`,
        inProgress,
      };
    }
    return { decision: 'resolved', commit: resolved, deploymentUuid, inProgress };
  }
  return { decision: 'continue', oldestCreatedAt: previous ?? '', inProgress };
}

/**
 * The Coolify reader: `GET /applications/{uuid}` (the resource, its `status` and `git_commit_sha`)
 * and `GET /deployments` (the platform's deployment queue, documented as the running ones; every
 * record is returned with its `status` and the judgement decides by state). When `git_commit_sha`
 * is not a commit — Coolify stores the literal `HEAD` to mean "track the branch tip", which is not
 * the running image — `GET /deployments/applications/{uuid}` (read-only) supplies the newest finished
 * primary deployment's commit, the value Coolify tags onto that one image. The column `dockerfile`
 * must be present and empty (a hidden column can still be an inline Dockerfile tagged `latest`),
 * and finished children must cover `additional_networks_count`. A commit that cannot be
 * verified stays on the application as `runningCommitUnresolved` and the judgement fails closed;
 * it does not fall back to an older image. The token is sent and never returned, logged or embedded
 * in the evidence. A failure of the application or the deployment-queue read, or an application that
 * lacks a field the judgement needs, throws, which the command records as an unavailable inventory.
 * A failure of the deployment-history read is not that: the inventory was read, and the missing
 * commit is the unclassified finding.
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
  const history = async (appUuid: string, applicationId: number, additionalNetworksCount: number): Promise<RunningCommitDecision> => {
    let skip = 0;
    let previousCreatedAt: string | null = null;
    const seenInProgress: PlatformDeployment[] = [];
    const state: DeploymentHistoryState = { additionalNetworksCount, finishedChildren: new Map() };
    while (skip < DEPLOYMENT_HISTORY_CAP) {
      const body = await get(`/deployments/applications/${encodeURIComponent(appUuid)}?skip=${skip}&take=${DEPLOYMENT_HISTORY_PAGE}`);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { decision: 'unresolved', reason: 'GET /deployments/applications did not return an object', inProgress: seenInProgress };
      }
      const record = body as Record<string, unknown>;
      const count = record.count;
      const deployments = record.deployments;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || !Array.isArray(deployments)) {
        return { decision: 'unresolved', reason: 'GET /deployments/applications did not return { count, deployments }', inProgress: seenInProgress };
      }
      const page = judgeDeploymentHistoryPage(deployments, applicationId, previousCreatedAt, state);
      seenInProgress.push(...page.inProgress);
      if (page.decision === 'resolved') return { ...page, inProgress: seenInProgress };
      if (page.decision === 'unresolved') return { ...page, inProgress: seenInProgress };
      const seen = skip + deployments.length;
      if (deployments.length === 0 || deployments.length < DEPLOYMENT_HISTORY_PAGE || seen >= count || seen >= DEPLOYMENT_HISTORY_CAP) {
        const bounded = seen >= DEPLOYMENT_HISTORY_CAP && seen < count;
        return {
          decision: 'unresolved',
          reason: bounded
            ? `no finished production deployment recorded a commit SHA within the first ${DEPLOYMENT_HISTORY_CAP} deployments`
            : 'no finished production deployment recorded a commit SHA',
          inProgress: seenInProgress,
        };
      }
      previousCreatedAt = page.oldestCreatedAt || previousCreatedAt;
      skip = seen;
    }
    return { decision: 'unresolved', reason: `no finished production deployment recorded a commit SHA within the first ${DEPLOYMENT_HISTORY_CAP} deployments`, inProgress: seenInProgress };
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
      if (!isGitCommitSha(application.gitCommitSha)) {
        const configured = application.gitCommitSha;
        const pack = typeof a.build_pack === 'string' ? a.build_pack.trim().toLowerCase() : '';
        const dockerfilePresent = Object.prototype.hasOwnProperty.call(a, 'dockerfile');
        const dockerfile = a.dockerfile;
        const inlineDockerfile = typeof dockerfile === 'string' && dockerfile.trim() !== '';
        const dockerfileEmpty = dockerfile === null || (typeof dockerfile === 'string' && dockerfile.trim() === '');
        const networks = a.additional_networks_count;
        const networksKnown = typeof networks === 'number' && Number.isInteger(networks) && networks >= 0;
        let resolved: RunningCommitDecision;
        if (inlineDockerfile) {
          resolved = { decision: 'unresolved', reason: 'an inline Dockerfile is set, so the running image is tagged latest rather than with a commit', inProgress: [] };
        } else if (!COMMIT_TAGGED_BUILD_PACKS.has(pack)) {
          const reason = pack === 'dockercompose'
            ? 'build_pack "dockercompose" can serve a service from an image that is not the deployment commit, and this command cannot see every running service image'
            : `build_pack ${JSON.stringify(pack || null)} does not tag the running image with the deployment commit`;
          resolved = { decision: 'unresolved', reason, inProgress: [] };
        } else if (!dockerfilePresent || !dockerfileEmpty) {
          resolved = {
            decision: 'unresolved',
            reason: dockerfilePresent
              ? `the dockerfile column is ${JSON.stringify(dockerfile)}, so an inline Dockerfile (image tagged latest) cannot be distinguished from a commit-tagged build`
              : 'the dockerfile column is hidden from this token, so an inline Dockerfile (image tagged latest) cannot be distinguished from a commit-tagged build',
            inProgress: [],
          };
        } else if (!networksKnown) {
          resolved = {
            decision: 'unresolved',
            reason: `additional_networks_count is ${JSON.stringify(networks ?? null)}, so a single server cannot be told from a fleet`,
            inProgress: [],
          };
        } else {
          try {
            resolved = await history(appUuid, application.id, networks);
          } catch (error) {
            resolved = { decision: 'unresolved', reason: (error as Error).message, inProgress: [] };
          }
        }
        const known = new Set(runningDeployments.map((d) => d.deploymentUuid));
        for (const extra of resolved.inProgress) {
          if (!known.has(extra.deploymentUuid)) runningDeployments.push(extra);
        }
        if (resolved.decision === 'resolved') {
          application.gitCommitSha = resolved.commit;
          application.runningCommit = { source: 'finished-deployment', deploymentUuid: resolved.deploymentUuid, configuredGitCommitSha: configured };
        } else {
          const reason = resolved.decision === 'unresolved' ? resolved.reason : 'deployment history did not resolve a commit';
          application.runningCommitUnresolved = `Coolify git_commit_sha is ${JSON.stringify(configured)}, not a commit SHA; ${reason}`;
        }
      }
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
    if (!isGitCommitSha(name)) return null;
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
