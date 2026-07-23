import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Phase 3 Task 7 (correction 2) — the pilot MATERIALS acceptance chain, in a REAL browser over live
 * PostgreSQL, in BOTH capability states.
 *
 * The pilot is OPERATIONAL with NO browser-side multi-command orchestration: each browser test provisions
 * its OWN fresh free stock via an API fixture (procurement → acceptance, unreserved) and then drives the
 * SINGLE user commands the correction defines — reserve a SERVER-offered candidate (exact lot + store
 * location + qty), issue it to that store, consume it — proving a visible BLOCKED → READY transition. A
 * blocked no-supply requirement's cover panel raises ONE requisition for the server-computed residual. A
 * second PLAIN project proves the INERT non-pilot state (no Materials nav, the read 404s).
 *
 * Probe 8: every browser test creates its own activity + stock (a unique name per run), so the suite is
 * self-contained and re-runnable twice CONSECUTIVELY against the same DB in legacy AND outbox modes,
 * never relying on another test's mutations.
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
let orgId = '';
let home = '';
let pmcPilot = '';
let pmcPlain = '';

/** Create (idempotently, by name) a project in the PMC's org. */
async function ensureProject(request: APIRequestContext, homeToken: string, org: string, name: string): Promise<string> {
  const existing = await get(request, homeToken, `/orgs/${org}/projects`);
  const found = (existing as Array<{ id: string; name: string }>).find((x) => x.name === name);
  if (found) return found.id;
  const created = await post(request, homeToken, `/orgs/${org}/projects`, { name, short: name, descriptor: 'Task 7 acceptance', stage: 'Structure', siteCode: name.slice(0, 6) });
  return created.id;
}

async function createActivity(request: APIRequestContext, token: string, projectId: string, name: string, plannedStartDate: string): Promise<string> {
  const res = await post(request, token, `/projects/${projectId}/activities`, { name, zone: 'Z', plannedStart: 0, plannedEnd: 30, plannedStartDate, plannedEndDate: '2026-12-30' });
  return (res.activities as Array<{ id: string; name: string }>).find((a) => a.name === name)!.id;
}

/** FIXTURE (API-only, per finding 7): procure the requirement and RECEIVE + ACCEPT the full qty, leaving
 *  it FREE on hand (NOT reserved) — so the activity starts BLOCKED and the browser drives the rest. */
async function procureAndAccept(request: APIRequestContext, token: string, projectId: string, activityId: string, qty: string): Promise<{ requirementId: string; lotId: string }> {
  const req = await post(request, token, `/projects/${projectId}/requirements`, {
    activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
    baseUom: 'bag', qty, requiredBy: '2026-09-01', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
  });
  const requisition = await post(request, token, `/projects/${projectId}/requisitions`, { title: `Req ${qty}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] });
  await post(request, token, `/projects/${projectId}/requisitions/${requisition.id}/submit`, {});
  const approved = await post(request, token, `/projects/${projectId}/requisitions/${requisition.id}/approve`, {});
  const lineId = approved.lines[0].id;
  const rfq = await post(request, token, `/projects/${projectId}/rfqs`, { requisitionId: requisition.id });
  const vendor = await post(request, home, `/orgs/${orgId}/vendors`, { name: `Vendor ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });
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
  home = await login(request, PMC);
  const orgs = await get(request, home, '/me/orgs');
  orgId = orgs[0].id;
  pilotId = await ensureProject(request, home, orgId, PILOT_NAME);
  plainId = await ensureProject(request, home, orgId, PLAIN_NAME);

  // §D — enable the materials pilot on the PILOT project only (operator CLI: the sole enable path).
  execSync(`pnpm --filter api capability:enable --project ${pilotId} --capability materials --operator ci@vitan.in --reason "Task 7 acceptance"`, { stdio: 'pipe' });

  pmcPilot = await scoped(request, home, pilotId);
  pmcPlain = await scoped(request, home, plainId);
});

test('PILOT operational: the browser RESERVES a server-offered candidate (BLOCKED → READY), ISSUES it, and records CONSUMPTION', async ({ page, request }) => {
  // this run's OWN fresh activity + free stock (probe 8: self-contained, re-runnable)
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const activityId = await createActivity(request, pmcPilot, pilotId, `Slab casting ${tag}`, '2026-09-30');
  await procureAndAccept(request, pmcPilot, pilotId, activityId, '100');

  await signInToProject(page, PMC, PILOT_NAME);
  await openMaterials(page);

  // Readiness — the activity is BLOCKED (stock accepted but not reserved to it). Covering it reserves a
  // SERVER-offered candidate (a single command), flipping it to READY.
  const verdict = page.getByTestId(`materials-verdict-${activityId}`);
  await expect(verdict).toBeVisible();
  await expect(verdict).toHaveText('BLOCKED');
  await page.getByTestId(`materials-cover-${activityId}`).click(); // open the cover panel (loads the plan)
  const reserveBtn = page.getByTestId(`materials-cover-panel-${activityId}`).locator('[data-testid^="materials-reserve-"]').first();
  await expect(reserveBtn).toBeVisible(); // the server offered a reserve candidate
  await reserveBtn.click();               // the SINGLE reserve command
  await expect(verdict).toHaveText('READY'); // the readiness TRANSITION, proven in the browser

  // Reservations — issue the reserved stock to site (creates the §E MaterialIssue) from its store location.
  await page.getByTestId('materials-tab-reservations').click();
  const issueBtn = page.locator('[data-testid^="materials-do-issue-"]').first();
  await expect(issueBtn).toBeVisible();
  await issueBtn.click();

  // Issues — the §E issue exists; record consumption against it (custody derived).
  await page.getByTestId('materials-tab-issues').click();
  await expect(page.locator('[data-testid^="materials-issue-"]').first()).toBeVisible();
  const consumeBtn = page.locator('[data-testid^="materials-do-consume-"]').first();
  await expect(consumeBtn).toBeVisible();
  await consumeBtn.click();

  // the pipeline panels render the operated facts
  await page.getByTestId('materials-tab-inventory').click();
  await expect(page.locator('[data-testid^="materials-lot-"]').first()).toBeVisible();
});

test('PILOT: a blocked requirement produces a shortage Inbox action; the cover panel RAISES ONE REQUISITION for the residual (§25)', async ({ page, request }) => {
  // this run's OWN fresh short activity (no stock → blocked, no-supply)
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const shortActivity = await createActivity(request, pmcPilot, pilotId, `Plastering ${tag}`, '2026-08-10');
  await post(request, pmcPilot, `/projects/${pilotId}/requirements`, {
    activityId: shortActivity, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
    baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'critical', decisionId: null, responsibleId: null, tolerance: null,
  });

  await signInToProject(page, PMC, PILOT_NAME);
  // the For-You inbox is the home — the shortage action is there with its forecast detail
  await expect(page.getByText(/material shortage/i).first()).toBeVisible();
  await expect(page.getByText(/No covering delivery/i).first()).toBeVisible();

  // the shortage's corrective on the Materials hub is a real command (finding 2): open the cover panel and
  // raise ONE requisition for the residual the server computed (no browser-side fan-out).
  await openMaterials(page);
  await page.getByTestId(`materials-cover-${shortActivity}`).click();
  const reqBtn = page.getByTestId(`materials-requisition-${shortActivity}`);
  await expect(reqBtn).toBeVisible();
  await reqBtn.click();
  await page.getByTestId('materials-tab-procurement').click();
  await expect(page.getByText(new RegExp(`Cover Plastering ${tag}`)).first()).toBeVisible(); // the raised requisition surfaced
});

test('PILOT: the §E stock-issues read surfaces a browser-issuable material — and an issue is NOT a daily-log delivery', async ({ request }) => {
  // this test's OWN fresh activity + reserve + issue (API), so it never relies on another test's mutations
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const activityId = await createActivity(request, pmcPilot, pilotId, `Issue-read ${tag}`, '2026-09-30');
  const { lotId } = await procureAndAccept(request, pmcPilot, pilotId, activityId, '50');
  await post(request, pmcPilot, `/projects/${pilotId}/stock/reserve`, { lotId, storeLocation: 'main', activityId, qty: '50' });
  const issue = await post(request, pmcPilot, `/projects/${pilotId}/stock/issue`, { lotId, storeLocation: 'main', activityId, qty: '50' });

  // §E — "an issue is NOT a delivery". The issued material is surfaced by inventory's stock.issues read
  // (lot §B identity joined, custody derived), never copied into the daily-log deliveries.
  const issues = await get(request, pmcPilot, `/projects/${pilotId}/stock/issues`);
  const mine = (issues.issues as Array<{ id: string; activityId: string; materialCategory: string }>).find((i) => i.activityId === activityId);
  expect(mine).toBeTruthy();
  expect(String(mine!.materialCategory).toLowerCase()).toContain('cement');
  const daily = await get(request, pmcPilot, `/projects/${pilotId}/daily-log`);
  expect(JSON.stringify(daily.materials ?? [])).not.toContain(issue.id ?? mine!.id);
});

test('INERT: a non-pilot project has NO Materials nav and the Phase-3 read 404s', async ({ page, request }) => {
  await signInToProject(page, PMC, PLAIN_NAME);
  await expect(page.getByRole('navigation').getByRole('button', { name: /Materials/ })).toHaveCount(0);
  const res = await request.get(`${API}/projects/${plainId}/activities/material-readiness`, { headers: bearer(pmcPlain) });
  expect(res.status()).toBe(404);
});
