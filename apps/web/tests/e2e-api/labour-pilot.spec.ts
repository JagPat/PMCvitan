import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Phase 4 Task 6 (§J) — the pilot LABOUR acceptance chain, in a REAL browser over live PostgreSQL,
 * in BOTH capability states.
 *
 * The chain: labour requirement (explicit demand slices) → the §F commercial fixture (requisition →
 * quote → comparison → PO → capacity commitment, API-side) → the BROWSER allocates a named worker
 * (forecast AT-RISK → READY, visible), records a same-day manual muster, the EXECUTION Team gate
 * authorizes `activities.start` (the §A in-tx truth), the browser records worked minutes, a §I
 * work output lands, and the productivity tab shows the derived join. A second PLAIN project proves
 * the INERT non-pilot state (no Labour nav, the labour read 404s).
 *
 * Determinism: execution coverage is evaluated at TODAY in the PROJECT timezone, and the hub's
 * muster form now derives "today" from the SNAPSHOT's `project.timeZone` (Codex F-TZ) — the pilot
 * project is created with timeZone 'UTC' and the browser context is pinned to UTC, so spec/server/
 * browser agree on "today" at any wall-clock moment. Every test provisions its OWN tagged
 * activity/worker/trade, so the suite is self-contained and re-runnable consecutively in legacy
 * AND outbox modes.
 */

test.use({ timezoneId: 'UTC' });

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const PMC = 'pmc@vitan.in';
const PILOT_NAME = 'T6 Labour Pilot';
const PLAIN_NAME = 'T6 Labour Plain';

/** Today's civil date in the pilot project's timezone (UTC — see the determinism note above). */
const todayUtc = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

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

async function openLabour(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: /Labour/ }).click();
  await expect(page.getByTestId('labour-summary')).toBeVisible();
}

let pilotId = '';
let plainId = '';
let orgId = '';
let home = '';
let pmcPilot = '';
let pmcPlain = '';

/** Create (idempotently, by name) a project in the PMC's org — the labour pilot is created with
 *  timeZone 'UTC' so its civil "today" matches the UTC-pinned browser context. */
async function ensureProject(request: APIRequestContext, homeToken: string, org: string, name: string): Promise<string> {
  const existing = await get(request, homeToken, `/orgs/${org}/projects`);
  const found = (existing as Array<{ id: string; name: string }>).find((x) => x.name === name);
  if (found) return found.id;
  const created = await post(request, homeToken, `/orgs/${org}/projects`, { name, short: name, descriptor: 'Task 6 acceptance', stage: 'Structure', siteCode: name.slice(0, 6), timeZone: 'UTC' });
  return created.id;
}

async function createActivity(request: APIRequestContext, token: string, projectId: string, name: string, plannedStartDate: string): Promise<string> {
  const res = await post(request, token, `/projects/${projectId}/activities`, { name, zone: 'Z', plannedStart: 0, plannedEnd: 30, plannedStartDate, plannedEndDate: '2027-06-30' });
  return (res.activities as Array<{ id: string; name: string }>).find((a) => a.name === name)!.id;
}

/** FIXTURE (API-only): trade + worker onboarding, the type-routed labour requirement (ONE demand
 *  slice dated today), and the §F commercial chain through a live capacity commitment — leaving
 *  the browser to drive allocation → attendance (the §J field ops). */
async function labourFixture(request: APIRequestContext, token: string, projectId: string, activityId: string, tag: string, opts: { commit: boolean }) {
  const today = todayUtc();
  const tradeCode = `mason-${tag}`;
  await post(request, token, `/projects/${projectId}/labour/trades`, { code: tradeCode, name: `Mason ${tag}` });
  const worker = await post(request, token, `/projects/${projectId}/labour/workers`, { name: `Worker ${tag}`, tradeCode, skillCodes: [], activeFrom: today });

  const req = await post(request, token, `/projects/${projectId}/requirements`, {
    activityId, type: 'labour', tradeCode, shift: 'day',
    demandSlices: [{ civilDate: today, personShiftQty: 1 }], criticality: 'normal',
  });

  if (!opts.commit) return { requirementId: req.requirementId as string, workerId: worker.id as string, tradeCode, today };

  // §F — requisition → RFQ → quote → comparison → PO → issue → capacity commitment (promise = today).
  await post(request, token, `/projects/${projectId}/labour/requisitions`, {
    title: `Source ${tradeCode}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: today, personShiftQty: 1 }],
  });
  const requisition = ((await get(request, token, `/projects/${projectId}/labour/requisitions`)).requisitions as Array<{ id: string; title: string; lines: Array<{ id: string }> }>).find((r) => r.title === `Source ${tradeCode}`)!;
  await post(request, token, `/projects/${projectId}/labour/requisitions/${requisition.id}/submit`, {});
  await post(request, token, `/projects/${projectId}/labour/requisitions/${requisition.id}/approve`, {});
  const rfq = await post(request, token, `/projects/${projectId}/labour/rfqs`, { requisitionId: requisition.id });
  const vendor = await post(request, home, `/orgs/${orgId}/vendors`, { name: `Labour Vendor ${tag}` });
  await post(request, token, `/projects/${projectId}/vendors`, { vendorId: vendor.id });
  await post(request, home, `/orgs/${orgId}/labour/vendor-profiles`, { vendorId: vendor.id, trades: [tradeCode], skills: [] });
  await post(request, token, `/projects/${projectId}/labour/rfqs/${rfq.id}/quotes`, {
    vendorId: vendor.id, validUntil: '2027-06-01',
    lines: [{ requisitionLineId: requisition.lines[0].id, ratePerPersonShift: '800.00', shiftPremium: '0.00', landedPerPersonShift: '800.00', matchesSpecification: true }],
  });
  await post(request, token, `/projects/${projectId}/labour/rfqs/${rfq.id}/comparison`, {});
  const withQuotes = await get(request, token, `/projects/${projectId}/labour/rfqs/${rfq.id}`);
  const quoteId = (withQuotes.quotes as Array<{ id: string; status: string }>).find((q) => q.status === 'recorded')!.id;
  await post(request, token, `/projects/${projectId}/labour/rfqs/${rfq.id}/comparison/approve`, { selectedQuoteId: quoteId, reason: 'single in-spec labour quote' });
  const cmp = (await get(request, token, `/projects/${projectId}/labour/rfqs/${rfq.id}`)).comparison as { id: string };
  const po = await post(request, token, `/projects/${projectId}/labour/pos`, { comparisonId: cmp.id, lines: [{ requisitionLineId: requisition.lines[0].id, personShiftQty: 1 }] });
  await post(request, token, `/projects/${projectId}/labour/pos/${po.id}/issue`, {});
  const poLine = (await get(request, token, `/projects/${projectId}/labour/pos/${po.id}`)).currentVersion.lines[0] as { id: string };
  await post(request, token, `/projects/${projectId}/labour/commitments`, { poLineId: poLine.id, promisedDate: today });

  return { requirementId: req.requirementId as string, workerId: worker.id as string, tradeCode, today };
}

test.beforeAll(async ({ request }) => {
  home = await login(request, PMC);
  const orgs = await get(request, home, '/me/orgs');
  orgId = orgs[0].id;
  pilotId = await ensureProject(request, home, orgId, PILOT_NAME);
  plainId = await ensureProject(request, home, orgId, PLAIN_NAME);

  // §D — enable the labour pilot on the PILOT project only (operator CLI: the sole enable path).
  execSync(`pnpm --filter api capability:enable --project ${pilotId} --capability labour --operator ci@vitan.in --reason "Task 6 acceptance"`, { stdio: 'pipe' });

  pmcPilot = await scoped(request, home, pilotId);
  pmcPlain = await scoped(request, home, plainId);
});

test('PILOT §J acceptance chain: commitment → browser ALLOCATE (AT-RISK → READY) → browser MUSTER → execution Team gate authorizes start → browser records WORK → productivity shows the derived join', async ({ page, request }) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const today = todayUtc();
  const activityId = await createActivity(request, pmcPilot, pilotId, `Brickwork ${tag}`, today);
  const { requirementId, workerId } = await labourFixture(request, pmcPilot, pilotId, activityId, tag, { commit: true });
  // Codex F1 — an INCOMPATIBLE-trade worker on the same roster must never be offered for this slice.
  const elecTrade = `elec-${tag}`;
  await post(request, pmcPilot, `/projects/${pilotId}/labour/trades`, { code: elecTrade, name: `Electrician ${tag}` });
  const wrongWorker = await post(request, pmcPilot, `/projects/${pilotId}/labour/workers`, { name: `Wrong ${tag}`, tradeCode: elecTrade, skillCodes: [], activeFrom: today });

  await signInToProject(page, PMC, PILOT_NAME);
  await openLabour(page);

  // Readiness — the slice is unallocated but a live same-slice commitment promises arrival today:
  // the server FORECAST is AT-RISK. Allocating the named worker flips it to READY in the browser.
  const verdict = page.getByTestId(`labour-verdict-${activityId}`);
  await expect(verdict).toBeVisible();
  await expect(verdict).toHaveText('AT-RISK');

  await page.getByTestId('labour-tab-allocation').click();
  const workerSelect = page.getByTestId(`labour-worker-select-${requirementId}-${today}`);
  await expect(workerSelect.locator(`option[value="${workerId}"]`)).toHaveCount(1); // the compatible mason
  await expect(workerSelect.locator(`option[value="${wrongWorker.id}"]`)).toHaveCount(0); // F1 — the electrician is NOT an option
  await workerSelect.selectOption(workerId);
  await page.getByTestId(`labour-do-allocate-${requirementId}-${today}`).click();
  await page.getByTestId('labour-tab-readiness').click();
  await expect(verdict).toHaveText('READY'); // the forecast transition, proven in the browser

  // Attendance — the pmc-attributable MANUAL muster for today (the §H exception path; a worker's
  // own bound device is the canonical path and is exercised by the Task-3 integration suite).
  await page.getByTestId('labour-tab-attendance').click();
  await page.getByTestId('labour-muster-worker-select').selectOption(workerId);
  await page.getByTestId('labour-muster-reason').fill('device battery dead — engineer verified on site');
  await page.getByTestId('labour-do-muster').click();
  await expect(page.getByTestId(`labour-muster-${workerId}`)).toBeVisible(); // reconciled presence

  // EXECUTION truth — allocated AND mustered today ⇒ the in-tx Team gate authorizes the start.
  await post(request, pmcPilot, `/projects/${pilotId}/activities/${activityId}/start`, {});

  // Work — the browser records worked minutes against THIS run's active allocation (default 480).
  const capacity = await get(request, pmcPilot, `/projects/${pilotId}/labour/capacity`);
  const allocation = (capacity.allocations as Array<{ id: string; activityId: string; status: string; capacityCommitmentId: string | null }>).find((a) => a.activityId === activityId && a.status === 'active')!;
  // Codex F2 — the browser allocate CARRIED the covering commitment id, so the server recorded the
  // §F bound-3 drawdown: the allocation is supplier-capacity-backed, and the hub says so.
  expect(allocation.capacityCommitmentId).toBeTruthy();
  await page.getByTestId('labour-tab-allocation').click();
  await expect(page.getByTestId(`labour-allocation-${allocation.id}`)).toContainText('supplier capacity');
  const workBtn = page.getByTestId(`labour-do-work-${allocation.id}`);
  await expect(workBtn).toBeVisible();
  await workBtn.click();

  // §I — a measured output lands (activities-owned), and productivity is the DERIVED join.
  await post(request, pmcPilot, `/projects/${pilotId}/activities/outputs`, { activityId, civilDate: today, shift: 'day', quantity: '12.5', uom: 'sqm' });
  await page.getByTestId('labour-refresh').click();
  await page.getByTestId('labour-tab-productivity').click();
  const prod = page.getByTestId(`labour-productivity-${activityId}`);
  await expect(prod).toBeVisible();
  await expect(prod).toContainText('12.5');
  await expect(prod).toContainText('sqm');
});

test('PILOT: an uncommitted labour shortfall is BLOCKED, surfaces the labour-shortage Inbox action, and the demand tab raises ONE labour requisition', async ({ page, request }) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const activityId = await createActivity(request, pmcPilot, pilotId, `Plaster ${tag}`, todayUtc());
  const { requirementId, tradeCode } = await labourFixture(request, pmcPilot, pilotId, activityId, tag, { commit: false });

  await signInToProject(page, PMC, PILOT_NAME);
  // the For-You inbox is the home — the labour shortfall action is there
  await expect(page.getByText(/labour shortfall/i).first()).toBeVisible();

  await openLabour(page);
  await expect(page.getByTestId(`labour-verdict-${activityId}`)).toHaveText('BLOCKED');

  // the corrective is a REAL single command: raise ONE labour requisition for the slices
  await page.getByTestId('labour-tab-demand').click();
  const raiseBtn = page.getByTestId(`labour-raise-req-${requirementId}`);
  await expect(raiseBtn).toBeVisible();
  await raiseBtn.click();
  await page.getByTestId('labour-tab-suppliers').click();
  await expect(page.getByText(new RegExp(`Source ${tradeCode}`)).first()).toBeVisible(); // the raised requisition surfaced
});

test('PILOT: the Team roster section onboards a worker against the catalog', async ({ page, request }) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tradeCode = `carp-${tag}`;
  await post(request, pmcPilot, `/projects/${pilotId}/labour/trades`, { code: tradeCode, name: `Carpenter ${tag}` });

  await signInToProject(page, PMC, PILOT_NAME);
  await page.getByRole('navigation').getByRole('button', { name: /Team/, exact: false }).first().click();
  await expect(page.getByTestId('labour-roster')).toBeVisible();
  await page.getByTestId('labour-worker-name').fill(`Roster ${tag}`);
  await page.getByTestId('labour-worker-trade').selectOption(tradeCode);
  await page.getByTestId('labour-onboard-worker').click();
  await expect(page.getByText(`Roster ${tag}`).first()).toBeVisible(); // the onboarded worker joins the roster

  // the workforce register confirms the trusted identity landed
  const wf = await get(request, pmcPilot, `/projects/${pilotId}/labour/workforce`);
  expect((wf.workers as Array<{ name: string }>).some((w) => w.name === `Roster ${tag}`)).toBe(true);
});

test('INERT: a non-pilot project has NO Labour nav, a direct /labour deep link is BOUNCED, and the labour read 404s', async ({ page, request }) => {
  await signInToProject(page, PMC, PLAIN_NAME);
  await expect(page.getByRole('navigation').getByRole('button', { name: /Labour/ })).toHaveCount(0);
  // Codex F-deeplink — a bookmarked /labour URL must never land on a permanently-loading hub. A
  // full reload drops the in-memory token (the project-scope deep-link pattern): sign in THROUGH
  // the gate with the deep link's URL standing. Once the shell reports no `labour` capability the
  // screen is ejected to the role default — the URL leaves /labour and the hub never renders.
  // (A fresh login scopes to the account's SERVER-designated home project — the pre-existing
  // "authentication lands on the server project" behaviour — so the eject may land on the home
  // project's role default; the finding's claim is only that the dead hub is never served.)
  await page.goto(`/projects/${plainId}/labour`);
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(PMC);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).not.toHaveURL(/\/labour$/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/for-you$/, { timeout: 15_000 });
  await expect(page.getByTestId('labour-summary')).toHaveCount(0);
  const res = await request.get(`${API}/projects/${plainId}/labour/readiness`, { headers: bearer(pmcPlain) });
  expect(res.status()).toBe(404);
});
