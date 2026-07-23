import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Phase 3 Task 7 (+ correction) — the pilot MATERIALS acceptance chain, in a REAL browser over live
 * PostgreSQL, in BOTH capability states.
 *
 * The pilot is OPERATIONAL, not observational (correction findings 1/7): the upstream procurement chain
 * (requirement → requisition → comparison → PO → commitment → receipt → ACCEPTANCE) is set up over the API
 * as a FIXTURE only, leaving accepted stock FREE on hand. The BROWSER then drives the operational site
 * commands and proves a readiness TRANSITION: it RESERVES the on-hand stock to the activity (BLOCKED →
 * READY, visible), ISSUES it to site, and records CONSUMPTION — all through the UI. A blocked no-supply
 * requirement produces a shortage Inbox card whose corrective action raises a requisition. A second PLAIN
 * project proves the INERT non-pilot state: no Materials nav, and the Phase-3 read 404s.
 *
 * Isolation: this spec creates its OWN two projects (never the seeded ones).
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

async function openMaterials(page: Page): Promise<void> {
  // scope to the navigation landmark — `/Materials/i` also matches the project-switcher button
  await page.getByRole('navigation').getByRole('button', { name: /Materials/ }).click();
  await expect(page.getByTestId('materials-summary')).toBeVisible();
}

let pilotId = '';
let plainId = '';
let pmcPilot = '';
let pmcPlain = '';
let coveredActivity = '';
let shortActivity = '';

/** Create (idempotently, by name) a project in the PMC's org. */
async function ensureProject(request: APIRequestContext, home: string, orgId: string, name: string): Promise<string> {
  const existing = await get(request, home, `/orgs/${orgId}/projects`);
  const found = (existing as Array<{ id: string; name: string }>).find((x) => x.name === name);
  if (found) return found.id;
  const created = await post(request, home, `/orgs/${orgId}/projects`, { name, short: name, descriptor: 'Task 7 acceptance', stage: 'Structure', siteCode: name.slice(0, 6) });
  return created.id;
}

/** FIXTURE (API-only, per finding 7): procure the requirement and RECEIVE + ACCEPT the full qty, leaving
 *  it FREE on hand (NOT reserved) — so the activity starts BLOCKED and the browser drives the rest. */
async function procureAndAccept(request: APIRequestContext, token: string, projectId: string, orgId: string, home: string, activityId: string, qty: string) {
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
  // NOTE: intentionally NOT reserved/issued — the browser drives reserve → issue → consume.
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
  const existing = (await get(request, pmcPilot, `/projects/${pilotId}/activities`)).activities as Array<{ id: string; name: string }>;
  const findAct = (name: string) => existing.find((a) => a.name === name)?.id;
  coveredActivity = findAct('Slab casting') ?? '';
  shortActivity = findAct('Plastering') ?? '';
  if (!coveredActivity) {
    // an activity with ACCEPTED-but-unreserved stock → starts BLOCKED; the browser reserves it to READY
    coveredActivity = (await post(request, pmcPilot, `/projects/${pilotId}/activities`, { name: 'Slab casting', zone: 'Terrace', plannedStart: 0, plannedEnd: 30, plannedStartDate: '2026-09-30', plannedEndDate: '2026-10-30' })).activities.find((a: { name: string }) => a.name === 'Slab casting')!.id;
    await procureAndAccept(request, pmcPilot, pilotId, orgId, home, coveredActivity, '100');
  }
  if (!shortActivity) {
    // a BLOCKED requirement with no supply → a shortage with a no-supply forecast + a "Raise requisition" corrective
    shortActivity = (await post(request, pmcPilot, `/projects/${pilotId}/activities`, { name: 'Plastering', zone: 'GF', plannedStart: 0, plannedEnd: 15, plannedStartDate: '2026-08-10', plannedEndDate: '2026-08-25' })).activities.find((a: { name: string }) => a.name === 'Plastering')!.id;
    await post(request, pmcPilot, `/projects/${pilotId}/requirements`, {
      activityId: shortActivity, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'critical', decisionId: null, responsibleId: null, tolerance: null,
    });
  }
});

test('PILOT operational: the browser RESERVES on-hand stock (BLOCKED → READY), ISSUES it, and records CONSUMPTION', async ({ page }) => {
  await signInToProject(page, PMC, PILOT_NAME);
  await openMaterials(page);

  // Readiness — the covered activity is BLOCKED (stock accepted but not reserved to it). Reserving flips it.
  const verdict = page.getByTestId(`materials-verdict-${coveredActivity}`);
  await expect(verdict).toBeVisible();
  if ((await verdict.textContent())?.trim() !== 'READY') {
    await expect(verdict).toHaveText('BLOCKED');
    await page.getByTestId(`materials-cover-${coveredActivity}`).click(); // the corrective reserve command
  }
  await expect(verdict).toHaveText('READY'); // the readiness TRANSITION, proven in the browser

  // Reservations — issue the reserved stock to site (creates the §E MaterialIssue). Skip if already issued.
  await page.getByTestId('materials-tab-reservations').click();
  const issueBtn = page.locator('[data-testid^="materials-do-issue-"]').first();
  if (await issueBtn.count()) await issueBtn.click();

  // Issues — the §E issue exists; record consumption against it (custody derived). Skip if already consumed.
  await page.getByTestId('materials-tab-issues').click();
  await expect(page.locator('[data-testid^="materials-issue-"]').first()).toBeVisible();
  const consumeBtn = page.locator('[data-testid^="materials-do-consume-"]').first();
  if (await consumeBtn.count()) {
    await consumeBtn.click();
    await expect(page.locator('[data-testid^="materials-do-consume-"]')).toHaveCount(0); // custody exhausted
  }

  // the pipeline panels render the authored + operated facts
  await page.getByTestId('materials-tab-procurement').click();
  await expect(page.locator('[data-testid^="materials-po-"]').first()).toBeVisible();
  await page.getByTestId('materials-tab-inventory').click();
  await expect(page.locator('[data-testid^="materials-lot-"]').first()).toBeVisible();
});

test('PILOT: the blocked requirement produces a shortage Inbox action, and its corrective RAISES A REQUISITION (§25)', async ({ page }) => {
  await signInToProject(page, PMC, PILOT_NAME);
  // the For-You inbox is the home — the shortage action is there with its forecast detail
  await expect(page.getByText(/material shortage/i).first()).toBeVisible();
  await expect(page.getByText(/No covering delivery/i).first()).toBeVisible();

  // the shortage's corrective on the Materials hub is a real command, not a read-only panel (finding 2)
  await openMaterials(page);
  const cover = page.getByTestId(`materials-cover-${shortActivity}`);
  await expect(cover).toHaveText(/Raise requisition/);
  await cover.click();
  await page.getByTestId('materials-tab-procurement').click();
  await expect(page.getByText(/Cover Plastering/).first()).toBeVisible(); // the raised requisition surfaced
});

test('PILOT: the §E stock-issues read surfaces the browser-issued material — and an issue is NOT a daily-log delivery', async ({ request }) => {
  // §E — "an issue is NOT a delivery". The material the browser issued is surfaced by inventory's
  // stock.issues read (lot §B identity joined, custody derived), never copied into the daily-log deliveries.
  const issues = await get(request, pmcPilot, `/projects/${pilotId}/stock/issues`);
  expect(issues.issues.length).toBeGreaterThan(0);
  const issue = issues.issues[0];
  expect(issue.activityId).toBeTruthy();
  expect(String(issue.materialCategory).toLowerCase()).toContain('cement');
  const daily = await get(request, pmcPilot, `/projects/${pilotId}/daily-log`);
  expect(JSON.stringify(daily.materials ?? [])).not.toContain(issue.id);
});

test('INERT: a non-pilot project has NO Materials nav and the Phase-3 read 404s', async ({ page, request }) => {
  await signInToProject(page, PMC, PLAIN_NAME);
  await expect(page.getByRole('navigation').getByRole('button', { name: /Materials/ })).toHaveCount(0);
  const res = await request.get(`${API}/projects/${plainId}/activities/material-readiness`, { headers: bearer(pmcPlain) });
  expect(res.status()).toBe(404);
});
