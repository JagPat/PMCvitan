import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { CapabilitiesService, HOME_NAV_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { disableCapability } from '../../src/platform/capability-switch';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H0) — the per-project home/navigation switch is a SERVER switch:
 * the shell reports it only for a project that holds it, the operator can turn it off again, and
 * turning it off is audited, idempotent and refused for any capability that is not presentation only.
 */
describe('Stage 1 H0 — the home-nav switch (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let capabilities: CapabilitiesService;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    capabilities = t.app.get(CapabilitiesService);
    tokenA = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    tokenB = t.issueProjectToken(f.otherUser.id, f.projectB.id);
  });

  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  const shellCapabilities = async (projectId: string, token: string): Promise<string[]> => {
    const r = await request(t.app.getHttpServer()).get(`/projects/${projectId}/shell`).set('Authorization', `Bearer ${token}`);
    expect(r.status, r.text).toBe(200);
    return r.body.capabilities as string[];
  };
  const disableAudits = () =>
    t.prisma.auditLog.findMany({ where: { projectId: f.projectA.id, action: 'capability.disable' } });

  it('is off by default: the shell does not report it', async () => {
    expect(await shellCapabilities(f.projectA.id, tokenA)).not.toContain(HOME_NAV_CAPABILITY);
  });

  it('on for one project is reported for that project only', async () => {
    await capabilities.enable(f.projectA.id, HOME_NAV_CAPABILITY, 'operator@test.local');
    expect(await shellCapabilities(f.projectA.id, tokenA)).toContain(HOME_NAV_CAPABILITY);
    expect(await shellCapabilities(f.projectB.id, tokenB), 'the sibling project is untouched').not.toContain(HOME_NAV_CAPABILITY);
  });

  it('the operator turns it off: the shell stops reporting it and the audit trail records who and why', async () => {
    const result = await disableCapability(t.prisma, {
      projectId: f.projectA.id, capability: HOME_NAV_CAPABILITY, operator: 'operator@test.local', reason: 'rollback drill',
    });
    expect(result).toEqual({ changed: true });
    expect(await shellCapabilities(f.projectA.id, tokenA)).not.toContain(HOME_NAV_CAPABILITY);
    const audits = await disableAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(`${f.projectA.id}:${HOME_NAV_CAPABILITY}`);
    expect(audits[0].payload).toEqual({ reason: 'rollback drill' });
  });

  it('turning it off again changes nothing and writes no second audit row', async () => {
    const result = await disableCapability(t.prisma, {
      projectId: f.projectA.id, capability: HOME_NAV_CAPABILITY, operator: 'operator@test.local', reason: 'retry',
    });
    expect(result).toEqual({ changed: false });
    expect(await disableAudits()).toHaveLength(1);
  });

  it('refuses a pilot capability, an unknown project, and a missing reason, leaving the rows as they were', async () => {
    await capabilities.enable(f.projectA.id, MATERIALS_CAPABILITY, 'operator@test.local');
    await expect(disableCapability(t.prisma, {
      projectId: f.projectA.id, capability: MATERIALS_CAPABILITY, operator: 'operator@test.local', reason: 'nope',
    })).rejects.toThrow(/cannot be disabled/);
    expect(await capabilities.isEnabled(f.projectA.id, MATERIALS_CAPABILITY), 'the pilot hub stays on').toBe(true);
    await expect(disableCapability(t.prisma, {
      projectId: 'no-such-project', capability: HOME_NAV_CAPABILITY, operator: 'operator@test.local', reason: 'nope',
    })).rejects.toThrow();
    await expect(disableCapability(t.prisma, {
      projectId: f.projectA.id, capability: HOME_NAV_CAPABILITY, operator: 'operator@test.local', reason: ' ',
    })).rejects.toThrow(/reason/);
    expect(await disableAudits()).toHaveLength(1);
  });
});
