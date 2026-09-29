import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  DRAIN_DIRECTIVE, DRAIN_EVIDENCE_MARKER, coolifyInventoryReader, deploymentInProgress, gitAncestryClassifier, judgeDrain, renderDrainEvidence,
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
