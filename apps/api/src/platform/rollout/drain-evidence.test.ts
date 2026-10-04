import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  DRAIN_DIRECTIVE, DRAIN_EVIDENCE_MARKER, coolifyInventoryReader, deploymentInProgress, gitAncestryClassifier, judgeDeploymentHistoryPage, judgeDrain, renderDrainEvidence,
  type Classification, type DrainEvidenceInput, type LiveLease, type PlatformInventory, type ReleaseClassifier,
} from './drain-evidence';

/**
 * 4d-ii-a / A6e — `rollout:drain-evidence` outside the platform: the judgement over the two pieces of
 * evidence (fail closed on anything unclassifiable, `not-drained` dominating), the comment body, the
 * Coolify reader's field discipline (and that the token never appears in what it returns), and the
 * git-ancestry classifier over this checkout. The lease and generation reads are proven live in
 * `phase6-t4d-ii-a6e-generation-fence.test.ts`.
 */
const MIN = 'aaaaaaaa';
const table = (map: Record<string, Classification>): ReleaseClassifier => ({ classify: (_min, release) => map[release] ?? 'unclassifiable' });
const at = (d = '2026-09-28T10:00:00Z') => new Date(d);
const lease = (instanceId: string, catalogVersion: number, release: string): LiveLease =>
  ({ instanceId, catalogVersion, release, startedAt: at(), leaseUntil: at('2026-09-28T10:10:00Z') });
const inventory = (over: Partial<PlatformInventory['application']> = {}, running: PlatformInventory['runningDeployments'] = []): PlatformInventory => ({
  source: 'Coolify https://coolify.example/api/v1',
  application: { id: 7, uuid: 'app-1', name: 'pms-api', fqdn: 'https://pms-api.example', status: 'running:healthy', gitCommitSha: 'bbbbbbbb', ...over },
  runningDeployments: running,
});
const base = (over: Partial<DrainEvidenceInput> = {}): DrainEvidenceInput => ({
  minimumRelease: MIN,
  minimumCatalogVersion: { value: 3, source: 'the persisted catalog maximum' },
  compiledGeneration: 1,
  persistedMinimum: { minimumGeneration: 1, raisedBy: '20280101000000_phase6_t4d_ii_a6e_generation_fence', raisedAt: at() },
  platform: { inventory: inventory() },
  leases: [lease('i-1', 3, 'bbbbbbbb')],
  classifier: table({ aaaaaaaa: 'at-or-after', bbbbbbbb: 'at-or-after', '99999999': 'before' }),
  recordedAt: at(),
  ...over,
});

describe('rollout:drain-evidence (4d-ii-a / A6e)', () => {
  it('drained: the application runs an image at or after the minimum, no deployment is in progress, every live lease is at the minimum catalog version', () => {
    const ev = judgeDrain(base());
    expect(ev).toMatchObject({ marker: DRAIN_EVIDENCE_MARKER, directive: DRAIN_DIRECTIVE, verdict: 'drained', findings: [] });
    expect(ev.platform).toMatchObject({ available: true, application: { classification: 'at-or-after' }, deploymentsInProgress: [] });
    expect(ev.leases[0]).toMatchObject({ instanceId: 'i-1', classification: 'at-or-after' });
  });

  it('not drained: an image before the minimum, a lease below the minimum catalog version, a lease naming an earlier release — and it dominates the unclassifiable', () => {
    expect(judgeDrain(base({ platform: { inventory: inventory({ gitCommitSha: '99999999' }) } }))).toMatchObject({ verdict: 'not-drained', findings: [expect.stringMatching(/BEFORE the minimum release/)] });
    expect(judgeDrain(base({ leases: [lease('i-old', 2, 'bbbbbbbb')] }))).toMatchObject({ verdict: 'not-drained', findings: [expect.stringMatching(/catalog version 2, below the minimum 3/)] });
    expect(judgeDrain(base({ leases: [lease('i-old', 3, '99999999')] }))).toMatchObject({ verdict: 'not-drained', findings: [expect.stringMatching(/names release 99999999, BEFORE/)] });
    const both = judgeDrain(base({ platform: { unavailable: 'HTTP 503' }, leases: [lease('i-old', 2, 'bbbbbbbb')] }));
    expect(both.verdict).toBe('not-drained');
    expect(both.findings).toHaveLength(2);
  });

  it('fails closed: no platform read, a stopped application, a deployment in progress, an unplaceable image or lease, no persisted minimum, a stale command build', () => {
    const unclassified = (over: Partial<DrainEvidenceInput>, finding: RegExp) => {
      const ev = judgeDrain(base(over));
      expect(ev.verdict, JSON.stringify(ev.findings)).toBe('unclassified');
      expect(ev.findings).toEqual([expect.stringMatching(finding)]);
    };
    unclassified({ platform: { unavailable: 'COOLIFY_TOKEN is not set' } }, /platform inventory unavailable: COOLIFY_TOKEN is not set/);
    unclassified({ platform: { inventory: inventory({ status: 'exited:unhealthy' }) } }, /is not running \(status "exited:unhealthy"\)/);
    unclassified({ platform: { inventory: inventory({}, [{ deploymentUuid: 'd-1', applicationId: 7, status: 'in_progress', commit: 'cccccccc' }]) } }, /1 deployment\(s\) in progress .*d-1:in_progress/);
    // a running deployment of ANOTHER application is not this one's
    expect(judgeDrain(base({ platform: { inventory: inventory({}, [{ deploymentUuid: 'd-2', applicationId: 8, status: 'in_progress', commit: null }]) } })).verdict).toBe('drained');
    // a deployment record is judged by STATE (#663 round 4, finding 1): finished, failed and cancelled records
    // are history and leave the verdict drained; queued is in progress; an unknown state is counted in
    // progress and named in the finding
    const dep = (status: string) => ({ deploymentUuid: `d-${status}`, applicationId: 7, status, commit: 'cccccccc' });
    expect(judgeDrain(base({ platform: { inventory: inventory({}, [dep('finished'), dep('failed'), dep('cancelled-by-user')]) } })).verdict).toBe('drained');
    unclassified({ platform: { inventory: inventory({}, [dep('finished'), dep('queued')]) } }, /1 deployment\(s\) in progress .*d-queued:queued\)/);
    unclassified({ platform: { inventory: inventory({}, [dep('weird')]) } }, /d-weird:weird\).*"weird" is not a state this command knows and is counted in progress/);
    expect(deploymentInProgress('FINISHED')).toEqual({ inProgress: false, known: true });
    expect(deploymentInProgress('in_progress')).toEqual({ inProgress: true, known: true });
    expect(deploymentInProgress('rolling')).toEqual({ inProgress: true, known: false });
    unclassified({ platform: { inventory: inventory({ gitCommitSha: 'unknown' }) } }, /image commit "unknown", which cannot be placed/);
    unclassified({ leases: [lease('i-u', 3, 'unreleased')] }, /names release "unreleased", which cannot be placed/);
    unclassified({ persistedMinimum: null }, /no persisted server-generation minimum/);
    unclassified({ persistedMinimum: { minimumGeneration: 2, raisedBy: 'a8b', raisedAt: at() } }, /compiles server generation 1, below the persisted minimum 2/);
  });

  it('renders the comment body: the marker and directive, the verdict, both inventories, the findings — and says it is not an attestation', () => {
    const body = renderDrainEvidence(judgeDrain(base({ leases: [lease('i-1', 3, 'bbbbbbbb'), lease('i-old', 2, '99999999')] })));
    expect(body.startsWith(`${DRAIN_EVIDENCE_MARKER} — autonomous corroboration for \`${DRAIN_DIRECTIVE}\``)).toBe(true);
    expect(body).toContain('not an attestation');
    expect(body).toContain('**Verdict: NOT DRAINED**');
    expect(body).toContain('application `app-1` pms-api (https://pms-api.example) — status `running:healthy`, image commit `bbbbbbbb` → at-or-after; deployments in progress for it: 0');
    expect(body).toContain('2 live lease(s):');
    expect(body).toContain('`i-old` catalog version 2, release `99999999` → before');
    expect(body).toContain('- Findings: \n  - live lease i-old');
    expect(renderDrainEvidence(judgeDrain(base({ platform: { unavailable: 'HTTP 503' } })))).toContain('UNAVAILABLE — HTTP 503');
    expect(renderDrainEvidence(judgeDrain(base()))).toContain('- Findings: none');
  });

  it('the Coolify reader reads the application and the running deployments, sends the token and never returns it, and refuses a shape it cannot judge', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.Authorization! });
      if (url.endsWith('/applications/app-1')) return { ok: true, status: 200, json: async () => ({ id: 7, uuid: 'app-1', name: 'pms-api', fqdn: 'https://pms-api.example', status: 'running:healthy', git_commit_sha: 'bbbbbbbb', extra: 'ignored' }) };
      if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => ([{ deployment_uuid: 'd-1', application_id: 7, status: 'in_progress', commit: 'cccccccc' }]) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const reader = coolifyInventoryReader({ baseUrl: 'https://coolify.example/api/v1/', token: 'id|secret', fetch });
    const inv = await reader.read('app-1');
    expect(inv).toEqual({
      source: 'Coolify https://coolify.example/api/v1',
      application: { id: 7, uuid: 'app-1', name: 'pms-api', fqdn: 'https://pms-api.example', status: 'running:healthy', gitCommitSha: 'bbbbbbbb' },
      runningDeployments: [{ deploymentUuid: 'd-1', applicationId: 7, status: 'in_progress', commit: 'cccccccc' }],
    });
    expect(calls.map((c) => c.url)).toEqual(['https://coolify.example/api/v1/applications/app-1', 'https://coolify.example/api/v1/deployments']);
    expect(calls.every((c) => c.auth === 'Bearer id|secret')).toBe(true);
    expect(JSON.stringify(inv)).not.toContain('secret');

    const failing = coolifyInventoryReader({ baseUrl: 'https://coolify.example/api/v1', token: 't', fetch: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) });
    await expect(failing.read('app-1')).rejects.toThrow(/HTTP 401/);
    const noSha = coolifyInventoryReader({ baseUrl: 'https://coolify.example/api/v1', token: 't', fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 7, uuid: 'app-1', name: 'n', status: 'running:healthy' }) })) });
    await expect(noSha.read('app-1')).rejects.toThrow(/"git_commit_sha" is absent/);
  });

  const IMAGE = 'ab8600c782bc686cfc64d538279c6e79f10ccf9c';
  const historyRow = (over: Record<string, unknown> = {}) => ({
    deployment_uuid: 'dep-finished', application_id: 7, pull_request_id: 0, status: 'finished', commit: IMAGE,
    restart_only: false, only_this_server: false, parent_deployment_uuid: null, created_at: '2026-10-04T12:00:00.000000Z', ...over,
  });
  const resolvableApplication = (over: Record<string, unknown> = {}) => ({
    id: 7, uuid: 'app-1', name: 'pms-api', status: 'running:unknown', git_commit_sha: 'HEAD',
    build_pack: 'dockerfile', dockerfile: null, additional_networks_count: 0, ...over,
  });

  it('classifies one page of deployment history, and fails closed when that page is not one fleet image', () => {
    // The reader does not adopt a resolved page. History has no configuration snapshot and no image
    // tag, so a page commit is not the running image. These cases keep the page rules honest.
    const resolved = judgeDeploymentHistoryPage([
      historyRow({ deployment_uuid: 'dep-preview', pull_request_id: 4, status: 'finished', commit: 'HEAD', created_at: '2026-10-04T13:00:00.000000Z' }),
      historyRow({ deployment_uuid: 'dep-failed', status: 'failed', commit: 'HEAD', created_at: '2026-10-04T12:30:00.000000Z' }),
      historyRow(),
    ], 7, null);
    expect(resolved).toMatchObject({ decision: 'resolved', commit: IMAGE, deploymentUuid: 'dep-finished' });
    // a restart records the commit of the image it restarted; that commit is the running image
    expect(judgeDeploymentHistoryPage([historyRow({ restart_only: true })], 7, null).decision).toBe('resolved');
    // the newest finished deploy that did not record a SHA is not replaced by an older image
    const stuck = judgeDeploymentHistoryPage([
      historyRow({ deployment_uuid: 'dep-head', commit: 'HEAD', created_at: '2026-10-04T13:00:00.000000Z' }),
      historyRow({ deployment_uuid: 'dep-older', created_at: '2026-10-04T11:00:00.000000Z' }),
    ], 7, null);
    expect(stuck.decision).toBe('unresolved');
    expect(stuck).toMatchObject({ reason: expect.stringMatching(/dep-head recorded commit "HEAD", which is not a commit SHA/) });
    expect(judgeDeploymentHistoryPage([historyRow({ status: 'rolling', deployment_uuid: 'dep-weird' })], 7, null)).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/"rolling"/) });
    expect(judgeDeploymentHistoryPage([historyRow({ only_this_server: true })], 7, null)).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/only_this_server/) });
    expect(judgeDeploymentHistoryPage([historyRow({ docker_registry_image_tag: 'latest' })], 7, null)).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/image tag "latest"/) });
    expect(judgeDeploymentHistoryPage([historyRow({ restart_only: null })], 7, null)).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/restart_only/) });
    // an in-progress deploy has not replaced the image, but it is reported so the verdict cannot be drained
    const busy = judgeDeploymentHistoryPage([
      historyRow({ deployment_uuid: 'dep-busy', status: 'in_progress', commit: 'HEAD', created_at: '2026-10-04T13:00:00.000000Z' }),
      historyRow(),
    ], 7, null);
    expect(busy).toMatchObject({ decision: 'resolved', commit: IMAGE, inProgress: [{ deploymentUuid: 'dep-busy', status: 'in_progress' }] });
    // a string application id from the deployment model still matches, and a different id does not
    expect(judgeDeploymentHistoryPage([historyRow({ application_id: '7' })], 7, null).decision).toBe('resolved');
    expect(judgeDeploymentHistoryPage([historyRow({ application_id: 8 })], 7, null)).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/application_id/) });
    // a failed additional server is newer than the primary Coolify already marked finished, and that
    // server may still be on the previous image. Skipping it would drain on the primary's commit.
    const failedChild = judgeDeploymentHistoryPage([
      historyRow({ deployment_uuid: 'child-failed', status: 'failed', parent_deployment_uuid: 'dep-finished', created_at: '2026-10-04T13:00:00.000000Z' }),
      historyRow(),
    ], 7, null, { additionalNetworksCount: 1, finishedChildren: new Map() });
    expect(failedChild).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/additional server of dep-finished and ended failed/) });
    const noParent = historyRow({ deployment_uuid: 'dep-opaque', status: 'failed', created_at: '2026-10-04T13:00:00.000000Z' });
    delete noParent.parent_deployment_uuid;
    expect(judgeDeploymentHistoryPage([noParent, historyRow()], 7, null)).toMatchObject({ decision: 'unresolved', reason: expect.stringMatching(/parent_deployment_uuid/) });
    // one additional destination, and its deployment finished the same commit: that is the fleet
    const fleet = judgeDeploymentHistoryPage([
      historyRow({ deployment_uuid: 'child-ok', parent_deployment_uuid: 'dep-finished', created_at: '2026-10-04T13:00:00.000000Z' }),
      historyRow(),
    ], 7, null, { additionalNetworksCount: 1, finishedChildren: new Map() });
    expect(fleet).toMatchObject({ decision: 'resolved', commit: IMAGE, deploymentUuid: 'dep-finished' });
    expect(judgeDeploymentHistoryPage([historyRow()], 7, null, { additionalNetworksCount: 1, finishedChildren: new Map() })).toMatchObject({
      decision: 'unresolved', reason: expect.stringMatching(/1 additional destination/),
    });
    const other = 'b'.repeat(40);
    expect(judgeDeploymentHistoryPage([
      historyRow({ deployment_uuid: 'child-other', parent_deployment_uuid: 'dep-finished', commit: other, created_at: '2026-10-04T13:00:00.000000Z' }),
      historyRow(),
    ], 7, null, { additionalNetworksCount: 1, finishedChildren: new Map() })).toMatchObject({
      decision: 'unresolved', reason: expect.stringMatching(/different commit/),
    });
  });

  it('leaves a non-commit git_commit_sha unclassified, even when dockerfile is empty and history names a commit', async () => {
    const savedSettings = /saved build_pack and dockerfile are not the configuration that produced the running image/;
    for (const buildPack of ['dockerfile', 'nixpacks', 'static', 'railpack']) {
      const urls: string[] = [];
      const inv = await coolifyInventoryReader({
        baseUrl: 'https://coolify.example/api/v1', token: 'read-only-token',
        fetch: vi.fn(async (url: string) => {
          urls.push(url);
          if (url.endsWith('/applications/app-1')) return { ok: true, status: 200, json: async () => resolvableApplication({ build_pack: buildPack }) };
          if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [] };
          if (url.includes('/deployments/applications/')) return { ok: true, status: 200, json: async () => ({ count: 1, deployments: [historyRow()] }) };
          return { ok: false, status: 404, json: async () => ({}) };
        }),
      }).read('app-1');
      expect(urls.some((url) => url.includes('/deployments/applications/')), buildPack).toBe(false);
      expect(urls, buildPack).toEqual([
        'https://coolify.example/api/v1/applications/app-1',
        'https://coolify.example/api/v1/deployments',
      ]);
      expect(inv.application.gitCommitSha, buildPack).toBe('HEAD');
      expect(inv.application.runningCommit, buildPack).toBeUndefined();
      expect(JSON.stringify(inv), buildPack).not.toContain('read-only-token');
      const judged = judgeDrain(base({
        platform: { inventory: inv },
        classifier: table({ aaaaaaaa: 'at-or-after', bbbbbbbb: 'at-or-after', [IMAGE]: 'at-or-after' }),
      }));
      expect(judged.verdict, buildPack).toBe('unclassified');
      expect(judged.findings.join('\n'), buildPack).toMatch(/git_commit_sha is "HEAD", not a commit SHA/);
      expect(judged.findings.join('\n'), buildPack).toMatch(savedSettings);
      expect(renderDrainEvidence(judged), buildPack).not.toContain('finished deployment');
    }

    // a deploy still in progress is the queue from GET /deployments; history is not a second queue
    const busyUrls: string[] = [];
    const busy = await coolifyInventoryReader({
      baseUrl: 'https://coolify.example/api/v1', token: 't',
      fetch: vi.fn(async (url: string) => {
        busyUrls.push(url);
        if (url.endsWith('/applications/app-1')) return { ok: true, status: 200, json: async () => resolvableApplication({ status: 'running:healthy', build_pack: 'nixpacks' }) };
        if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [{ deployment_uuid: 'dep-busy', application_id: 7, status: 'queued', commit: null }] };
        if (url.includes('/deployments/applications/')) return { ok: true, status: 200, json: async () => ({ count: 1, deployments: [historyRow()] }) };
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    }).read('app-1');
    expect(busyUrls.some((url) => url.includes('/deployments/applications/'))).toBe(false);
    expect(busy.application.gitCommitSha).toBe('HEAD');
    expect(busy.runningDeployments).toEqual([{ deploymentUuid: 'dep-busy', applicationId: 7, status: 'queued', commit: null }]);
    expect(judgeDrain(base({ platform: { inventory: busy }, classifier: table({ aaaaaaaa: 'at-or-after', bbbbbbbb: 'at-or-after', [IMAGE]: 'at-or-after' }) })).verdict).toBe('unclassified');

    // a registry image is not a git commit, a pasted Dockerfile tags :latest, and a compose file can
    // keep a service on some other image; none of them is the deployment commit, even when history has one
    for (const application of [
      { build_pack: 'dockerimage', dockerfile: '', finding: /does not tag the running image with the deployment commit/ },
      { build_pack: 'dockerfile', dockerfile: 'FROM node:22', finding: /inline Dockerfile/ },
      { build_pack: 'dockercompose', dockerfile: '', finding: /cannot see every running service image/ },
    ]) {
      const urls: string[] = [];
      const refused = await coolifyInventoryReader({
        baseUrl: 'https://coolify.example/api/v1', token: 't',
        fetch: vi.fn(async (url: string) => {
          urls.push(url);
          if (url.endsWith('/applications/app-1')) return { ok: true, status: 200, json: async () => ({ id: 7, uuid: 'app-1', name: 'n', status: 'running:healthy', git_commit_sha: 'HEAD', build_pack: application.build_pack, dockerfile: application.dockerfile }) };
          if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [] };
          if (url.includes('/deployments/applications/')) return { ok: true, status: 200, json: async () => ({ count: 1, deployments: [historyRow()] }) };
          return { ok: false, status: 404, json: async () => ({}) };
        }),
      }).read('app-1');
      expect(urls.some((url) => url.includes('/deployments/applications/')), application.build_pack).toBe(false);
      expect(refused.application.gitCommitSha).toBe('HEAD');
      expect(refused.application.runningCommit).toBeUndefined();
      const judged = judgeDrain(base({ platform: { inventory: refused }, classifier: table({ aaaaaaaa: 'at-or-after', bbbbbbbb: 'at-or-after', [IMAGE]: 'at-or-after' }) }));
      expect(judged.verdict, application.build_pack).toBe('unclassified');
      expect(judged.findings.join('\n'), application.build_pack).toMatch(application.finding);
    }

    // a read-only token omits dockerfile even when the column is a pasted Dockerfile. Absence is not empty.
    const hiddenUrls: string[] = [];
    const hidden = await coolifyInventoryReader({
      baseUrl: 'https://coolify.example/api/v1', token: 't',
      fetch: vi.fn(async (url: string) => {
        hiddenUrls.push(url);
        if (url.endsWith('/applications/app-1')) {
          const application = resolvableApplication();
          delete application.dockerfile;
          return { ok: true, status: 200, json: async () => application };
        }
        if (url.endsWith('/deployments')) return { ok: true, status: 200, json: async () => [] };
        if (url.includes('/deployments/applications/')) return { ok: true, status: 200, json: async () => ({ count: 1, deployments: [historyRow()] }) };
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    }).read('app-1');
    expect(hiddenUrls.some((url) => url.includes('/deployments/applications/'))).toBe(false);
    expect(hidden.application.gitCommitSha).toBe('HEAD');
    const hiddenJudged = judgeDrain(base({ platform: { inventory: hidden }, classifier: table({ aaaaaaaa: 'at-or-after', bbbbbbbb: 'at-or-after', [IMAGE]: 'at-or-after' }) }));
    expect(hiddenJudged.verdict).toBe('unclassified');
    expect(hiddenJudged.findings.join('\n')).toMatch(/dockerfile column is hidden from this token/);
  });

  it('the git-ancestry classifier places a commit against the minimum through this checkout, and never guesses', () => {
    const repo = join(__dirname, '..', '..', '..', '..');
    const git = (args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(head)) return; // not a git checkout: nothing to classify against
    const c = gitAncestryClassifier(repo);
    expect(c.classify(head, head)).toBe('at-or-after');
    expect(c.classify(head.slice(0, 8), head)).toBe('at-or-after');
    expect(c.classify(head, 'unreleased')).toBe('unclassifiable');
    expect(c.classify(head, 'r-2026-09')).toBe('unclassifiable');
    expect(c.classify(head, '0123456789abcdef0123456789abcdef01234567')).toBe('unclassifiable');
    const parent = git(['rev-parse', '--verify', '--quiet', 'HEAD~1^{commit}']);
    if (parent.status === 0) {
      expect(c.classify(head, parent.stdout.trim())).toBe('before');
      expect(c.classify(parent.stdout.trim(), head)).toBe('at-or-after');
    }
    // an injected runner: a git error is unclassifiable, not a verdict
    const broken = gitAncestryClassifier(repo, () => ({ status: 128, stdout: '' }));
    expect(broken.classify(head, head)).toBe('unclassifiable');
  });
});

// The gate that clears `phase-6-4d-previous-release-drained` (scripts/autonomous-drain-clearance.mjs)
// re-derives a committed record's verdict from the record's own inventory, by THIS module's rules. The
// two implementations cannot share code (the gate is a dependency-free Node script that runs before
// `pnpm install`), so parity is pinned here against the real `judgeDrain` over the JSON round-trip the
// record goes through (#686's shadow review, round 3: an empty lease register is `drained` in both).
describe('the drain-clearance gate re-derives exactly what judgeDrain judges', async () => {
  const gate = await import('../../../../../scripts/autonomous-drain-clearance.mjs');
  const roundTrip = (input: DrainEvidenceInput) => {
    const judged = judgeDrain(input);
    const rederived = gate.rederiveDrainVerdict(JSON.parse(JSON.stringify(judged)));
    return { judged, rederived };
  };
  const cases: Array<[string, Partial<DrainEvidenceInput>]> = [
    ['drained, one lease', {}],
    ['drained, empty lease register', { leases: [] }],
    ['drained, several leases', { leases: [lease('i-1', 3, 'bbbbbbbb'), lease('i-2', 4, 'aaaaaaaa')] }],
    ['not drained: image before the minimum', { platform: { inventory: inventory({ gitCommitSha: '99999999' }) } }],
    ['not drained: lease below the minimum catalog version', { leases: [lease('i-old', 2, 'bbbbbbbb')] }],
    ['not drained: lease naming an earlier release', { leases: [lease('i-old', 3, '99999999')] }],
    ['not drained dominates unclassifiable', { platform: { unavailable: 'HTTP 503' }, leases: [lease('i-old', 2, 'bbbbbbbb')] }],
    ['unclassified: no platform read', { platform: { unavailable: 'COOLIFY_TOKEN is not set' } }],
    ['unclassified: stopped application', { platform: { inventory: inventory({ status: 'exited' }) } }],
    ['unclassified: deployment in progress', { platform: { inventory: inventory({}, [{ deploymentUuid: 'd1', applicationId: 7, status: 'in_progress', commit: null }]) } }],
    ['unclassified: unplaceable image', { platform: { inventory: inventory({ gitCommitSha: 'cccccccc' }) } }],
    ['unclassified: HEAD left unresolved', { platform: { inventory: inventory({ gitCommitSha: 'HEAD', runningCommitUnresolved: 'Coolify git_commit_sha is "HEAD", not a commit SHA; no finished production deployment recorded a commit SHA' }) } }],
    ['drained, an extra runningCommit note does not replace the image commit', { platform: { inventory: inventory({ runningCommit: { source: 'finished-deployment', deploymentUuid: 'dep-finished', configuredGitCommitSha: 'HEAD' } }) } }],
    ['unclassified: unplaceable lease', { leases: [lease('i-x', 3, 'cccccccc')] }],
    ['unclassified: no persisted minimum', { persistedMinimum: null }],
    ['unclassified: stale command build', { compiledGeneration: 0 }],
  ];
  for (const [label, over] of cases) {
    it(label, () => {
      const { judged, rederived } = roundTrip(base(over));
      expect(rederived.verdict, `${label}: judgeDrain said ${judged.verdict} (${judged.findings.join('; ')}) but the gate re-derives ${rederived.verdict} (${rederived.findings.join('; ')})`).toBe(judged.verdict);
      // and a drained record passes the gate's full record validation when it is fresh and names the directive's minimum
      if (judged.verdict === 'drained') {
        const record = JSON.stringify({ ...judged, minimumRelease: gate.DRAIN_MINIMUM_RELEASE, recordedAt: '2026-10-02T09:00:00.000Z' });
        const parsed = gate.parseDrainEvidence(record, { now: Date.parse('2026-10-02T12:00:00.000Z') });
        expect(parsed.ok, `${label}: ${parsed.reason}`).toBe(true);
      }
    });
  }
});
