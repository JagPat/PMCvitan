import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Phase 3 Task 7 — the pilot MATERIALS acceptance chain, in a REAL browser over live PostgreSQL, in
 * BOTH capability states. On a dedicated PILOT project (materials capability enabled by the operator
 * CLI — the only enable path, §D) the full pipeline is authored over the API —
 *   requirement → requisition → comparison → purchase order → delivery commitment → receipt →
 *   acceptance → stock → reservation → issue → consumption
 * — then the browser drives the Materials hub and asserts each surface, the readiness verdicts, the
 * shortage Inbox forecast, and the §E Daily-Log read. A second PLAIN project proves the INERT
 * non-pilot state: no Materials nav, and the Phase-3 read 404s.
 *
 * Isolation: this spec creates its OWN two projects (never the seeded ones), so it cannot pollute the
 * other suites (project-scope's "empty project" proof, etc.).
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const PMC = 'pmc@vitan.in';
const PILOT_NAME = 'T7 Materials Pilot';
const PLAIN_NAME = 'T7 Materials Plain';

const PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64'); // a real 1×1 PNG, base64

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}
async function scoped(request: APIRequestContext, home: string, projectId: string): Promise<string> {
  const res = await request.post(`${API}/auth/switch`, { headers: bearer(home), data: { projectId } });
  expect(res.ok(), `switch → ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}
async function post(request: APIRequestContext, token: string, path: string, data: unknown): Promise<any> {
  const res = await request.post(`${API}${path}`, { headers: bearer(token), data });
  expect(res.ok(), `POST ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}
async function get(request: APIRequestContext, token: string, path: string): Promise<any> {
  const res = await request.get(`${API}${path}`, { headers: bearer(token) });
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  return res.json();
}

async function signInToProject(page: Page, email: string, projectName: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  const switcher = page.getByTestId('project-switcher');
  await expect(switcher).toBeVisible();
  const option = page.getByRole('button', { name: new RegExp(projectName) }).first();
  await expect(async () => {
    if (!(await option.isVisible())) await switcher.click();
    await option.click({ timeout: 2000 });
  }).toPass();
  await expect(switcher).toContainText(projectName);
}

let pilotId = '';
let plainId = '';
let pmcPilot = '';
let pmcPlain = '';

/** Create (idempotently, by name) a project in the PMC's org. */
async function ensureProject(request: APIRequestContext, home: string, orgId: string, name: string): Promise<string> {
  const existing = await get(request, home, `/orgs/${orgId}/projects`);
  const found = (existing as Array<{ id: string; name: string }>).find((x) => x.name === name);
  if (found) return found.id;
  const created = await post(request, home, `/orgs/${orgId}/projects`, { name, short: name, descriptor: 'Task 7 acceptance', stage: 'Structure', siteCode: name.slice(0, 6) });
  return created.id;
}

/** Author the requirement → … → issue chain for a requirement on `activityId`, returning nothing.
 *  Reused for the covered head requirement (procure + receive + accept + reserve + issue). */
async function fullChain(request: APIRequestContext, token: string, projectId: string, orgId: string, home: string, activityId: string, qty: string) {
  const req = await post(request, token, `/projects/${projectId}/requirements`, {
    activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
    baseUom: 'bag', qty, requiredBy: '2026-09-01', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
  });
  const requisition = await post(request, token, `/projects/${projectId}/requisitions`, { title: `Req ${qty}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] });
  await post(request, token, `/projects/${projectId}/requisitions/${requisition.id}/submit`, {});
  const approved = await post(request, token, `/projects/${projectId}/requisitions/${requisition.id}/approve`, {});
  const lineId = approved.lines[0].id;
  const rfq = await post(request, token, `/projects/${projectId}/rfqs`, { requisitionId: requisition.id });
  const vendor = await post(request, home, `/orgs/${orgId}/vendors`, { name: `Vendor ${Date.now()}` });
  await post(request, token, `/projects/${projectId}/vendors`, { vendorId: vendor.id });
  const withQuote = await post(request, token, `/projects/${projectId}/rfqs/${rfq.id}/quotes`, {
    vendorId: vendor.id, validUntil: '2027-01-01',
    lines: [{ requisitionLineId: lineId, baseRate: '100.00', taxAmount: '50.00', freightAmount: '25.00', landedCost: '999.99', quotedMake: 'UltraTech', matchesSpecification: true }],
  });
  const quoteId = (withQuote.quotes as Array<{ id: string; status: string }>).find((q) => q.status === 'recorded')!.id;
  await post(request, token, `/projects/${projectId}/rfqs/${rfq.id}/comparison`, {});
  const cmp = await post(request, token, `/projects/${projectId}/rfqs/${rfq.id}/comparison/approve`, { selectedQuoteId: quoteId, reason: 'single in-spec quote' });
  const po = await post(request, token, `/projects/${projectId}/pos`, { comparisonId: cmp.comparison.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] });
  await post(request, token, `/projects/${projectId}/pos/${po.id}/issue`, {});
  const poLine = (await get(request, token, `/projects/${projectId}/pos/${po.id}`)).versions.at(-1).lines[0];
  const commitment = await post(request, token, `/projects/${projectId}/deliveries`, { poLineId: poLine.id, promisedDate: '2026-08-20' });
  const lot = await post(request, token, `/projects/${projectId}/stock/receipts`, { poLineId: poLine.id, commitmentId: commitment.id, purchaseQty: qty });
  const media = await post(request, token, `/projects/${projectId}/media`, { kind: 'material', mime: 'image/png', data: PX });
  await post(request, token, `/projects/${projectId}/stock/accept`, { lotId: lot.id, qty, qualityResult: 'passed', evidenceMediaId: media.id });
  await post(request, token, `/projects/${projectId}/stock/reserve`, { lotId: lot.id, activityId, qty });
  const issued = (Number(qty) / 2).toString();
  await post(request, token, `/projects/${projectId}/stock/issue`, { lotId: lot.id, activityId, qty: issued });
  return { requirementId: req.requirementId as string, lotId: lot.id as string };
}

test.beforeAll(async ({ request }) => {
  const home = await login(request, PMC);
  const orgs = await get(request, home, '/me/orgs');
  const orgId = orgs[0].id;
  pilotId = await ensureProject(request, home, orgId, PILOT_NAME);
  plainId = await ensureProject(request, home, orgId, PLAIN_NAME);

  // §D — enable the materials pilot on the PILOT project only (operator CLI: the sole enable path).
  execSync(`pnpm --filter api capability:enable --project ${pilotId} --capability materials --operator ci@vitan.in --reason "Task 7 acceptance"`, { stdio: 'pipe' });

  pmcPilot = await scoped(request, home, pilotId);
  pmcPlain = await scoped(request, home, plainId);

  // idempotent: a worker retry re-runs beforeAll — author the chain only once
  const alreadyAuthored = (await get(request, pmcPilot, `/projects/${pilotId}/requirements`)).requirements.length > 0;
  if (!alreadyAuthored) {
    // a COVERED head requirement: an activity with reserved + issued stock → ready
    const coveredActivity = (await post(request, pmcPilot, `/projects/${pilotId}/activities`, { name: 'Slab casting', zone: 'Terrace', plannedStart: 0, plannedEnd: 30, plannedStartDate: '2026-09-30', plannedEndDate: '2026-10-30' })).activities.find((a: { name: string }) => a.name === 'Slab casting')!.id;
    await fullChain(request, pmcPilot, pilotId, orgId, home, coveredActivity, '100');
    // a BLOCKED requirement with no supply → a shortage with a no-supply forecast
    const shortActivity = (await post(request, pmcPilot, `/projects/${pilotId}/activities`, { name: 'Plastering', zone: 'GF', plannedStart: 0, plannedEnd: 15, plannedStartDate: '2026-08-10', plannedEndDate: '2026-08-25' })).activities.find((a: { name: string }) => a.name === 'Plastering')!.id;
    await post(request, pmcPilot, `/projects/${pilotId}/requirements`, {
      activityId: shortActivity, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'critical', decisionId: null, responsibleId: null, tolerance: null,
    });
  }
});

test('PILOT: the Materials hub renders the authored pipeline and the readiness verdicts', async ({ page, request }) => {
  await signInToProject(page, PMC, PILOT_NAME);
  // click the nav item (scoped to the navigation landmark — `/Materials/i` also matches the
  // "T7 Materials Pilot" project-switcher button, which is NOT the screen entry).
  await page.getByRole('navigation').getByRole('button', { name: /Materials/ }).click();

  // the readiness summary + both verdicts (one ready, one blocked)
  await expect(page.getByTestId('materials-summary')).toBeVisible();
  const view = await get(request, pmcPilot, `/projects/${pilotId}/activities/material-readiness`);
  expect(view.summary.ready).toBe(1);
  expect(view.summary.blocked).toBe(1);
  const blocked = view.requirements.find((r: { verdict: string }) => r.verdict === 'blocked');
  await expect(page.getByTestId(`materials-verdict-${blocked.requirementId}`)).toHaveText('BLOCKED');
  const ready = view.requirements.find((r: { verdict: string }) => r.verdict === 'ready');
  await expect(page.getByTestId(`materials-verdict-${ready.requirementId}`)).toHaveText('READY');

  // procurement panel — the issued PO is there
  await page.getByTestId('materials-tab-procurement').click();
  await expect(page.locator('[data-testid^="materials-po-"]').first()).toBeVisible();

  // inventory panel — the received + accepted lot
  await page.getByTestId('materials-tab-inventory').click();
  await expect(page.locator('[data-testid^="materials-lot-"]').first()).toBeVisible();

  // reservations panel — stock reserved to the covered activity
  await page.getByTestId('materials-tab-reservations').click();
  await expect(page.locator('[data-testid^="materials-reservation-"]').first()).toBeVisible();

  // issues panel — the §E MaterialIssue that LEFT the store
  await page.getByTestId('materials-tab-issues').click();
  await expect(page.locator('[data-testid^="materials-issue-"]').first()).toBeVisible();
});

test('PILOT: the blocked requirement produces a shortage Inbox action with forecast impact (§25)', async ({ page }) => {
  await signInToProject(page, PMC, PILOT_NAME);
  // the For-You inbox is the home — the shortage action is there with its forecast detail
  await expect(page.getByText(/material shortage/i).first()).toBeVisible();
  await expect(page.getByText(/No covering delivery/i).first()).toBeVisible();
});

test('PILOT: the §E stock-issues read surfaces the issued material — and an issue is NOT a daily-log delivery', async ({ request }) => {
  // §E — "an issue is NOT a delivery". The issued material is surfaced by inventory's stock.issues
  // read, which JOINS the lot's §B identity + derives activity custody. Nothing is copied into the
  // daily-log's SiteMaterial (delivery) rows — the Daily Log screen reads stock.issues separately.
  const issues = await get(request, pmcPilot, `/projects/${pilotId}/stock/issues`);
  expect(issues.issues.length).toBeGreaterThan(0);
  const issue = issues.issues[0];
  expect(issue.activityId).toBeTruthy(); // issued to the covered activity
  expect(String(issue.materialCategory).toLowerCase()).toContain('cement'); // lot §B identity joined
  expect(Number(issue.remainingCustody)).toBeGreaterThan(0); // custody derived, not copied
  // the daily-log module read carries SiteMaterial deliveries only — the issue is not among them
  const daily = await get(request, pmcPilot, `/projects/${pilotId}/daily-log`);
  expect(JSON.stringify(daily.materials ?? [])).not.toContain(issue.id);
});

test('INERT: a non-pilot project has NO Materials nav and the Phase-3 read 404s', async ({ page, request }) => {
  // the browser: no Materials entry in the nav for a non-pilot project (scope to the navigation
  // landmark — the project-switcher lists "T7 Materials Plain", which must NOT be mistaken for a nav item)
  await signInToProject(page, PMC, PLAIN_NAME);
  await expect(page.getByRole('navigation').getByRole('button', { name: /Materials/ })).toHaveCount(0);
  // the API: the material-readiness read does not exist off-pilot
  const res = await request.get(`${API}/projects/${plainId}/activities/material-readiness`, { headers: bearer(pmcPlain) });
  expect(res.status()).toBe(404);
});
