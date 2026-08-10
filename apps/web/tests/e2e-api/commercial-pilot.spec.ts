import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 5 Task 7B-iv (§M) — the pilot COMMERCIAL acceptance chain: REAL browser, live PostgreSQL,
 * BOTH capability states. Each test provisions its own vendor/claim/counterparty under a unique
 * tag, so the suite is re-runnable in legacy AND outbox modes. SERIAL by necessity: §L refuses to
 * enable `commercial` while any LIVE PO line is unattributed, and a parallel worker can create
 * exactly that state.
 */
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const PMC = 'pmc@vitan.in';
const SECOND_PMC = 'test-pmc@vitan.in';
const PILOT_NAME = 'T7 Commercial Pilot';
const PLAIN_NAME = 'T7 Commercial Plain';
/** a 1×1 png, for the evidence an acceptance requires */
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

/** Verbatim from the cleared materials/labour pilots: the switcher may already show the target. */
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

async function openCommercial(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: /Commercial|Money/ }).click();
  await expect(page.getByTestId('commercial-tab-claims')).toBeVisible();
}

let home = '';
let orgId = '';
let pilotId = '';
let plainId = '';
let pmcPilot = '';
let pmcPlain = '';
/** the SECOND pmc — §I forbids a self-grant, so an exception needs a second identity to issue it */
let secondPmcToken = '';

async function ensureProject(request: APIRequestContext, homeToken: string, org: string, name: string): Promise<string> {
  const existing = await get(request, homeToken, `/orgs/${org}/projects`);
  const found = (existing as Array<{ id: string; name: string }>).find((x) => x.name === name);
  if (found) return found.id;
  const created = await post(request, homeToken, `/orgs/${org}/projects`, {
    name, short: name, descriptor: 'Task 7B-iv acceptance', stage: 'Structure', siteCode: name.slice(0, 6),
  });
  return created.id;
}

async function createActivity(request: APIRequestContext, token: string, projectId: string, name: string): Promise<string> {
  const res = await post(request, token, `/projects/${projectId}/activities`, {
    name, zone: 'Z', plannedStart: 0, plannedEnd: 30,
    plannedStartDate: '2026-08-20', plannedEndDate: '2026-12-30',
  });
  return (res.activities as Array<{ id: string; name: string }>).find((a) => a.name === name)!.id;
}

/** FIXTURE (API-only): cost head, budget, a received-and-accepted material PO line, and a SUBMITTED
 *  claim bounded by it — the state a payer's day begins in. The browser drives the rest. */
async function claimAwaitingVerification(
  request: APIRequestContext, token: string, projectId: string, activityId: string, tag: string,
): Promise<{ billId: string; vendorId: string; headCode: string }> {
  const qty = '100';
  const headCode = `H-${tag}`.slice(0, 12);
  await post(request, token, `/projects/${projectId}/commercial/cost-heads`, { code: headCode, name: `Materials ${tag}` });
  await post(request, token, `/projects/${projectId}/commercial/budget`, {
    costHeadCode: headCode, amount: '1000000.00', reason: 'pilot budget',
  });

  const req = await post(request, token, `/projects/${projectId}/requirements`, {
    activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
    baseUom: 'bag', qty, requiredBy: '2026-09-01', criticality: 'normal',
    decisionId: null, responsibleId: null, tolerance: null,
  });
  const requisition = await post(request, token, `/projects/${projectId}/requisitions`, {
    title: `Req ${tag}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }],
  });
  await post(request, token, `/projects/${projectId}/requisitions/${requisition.id}/submit`, {});
  const approved = await post(request, token, `/projects/${projectId}/requisitions/${requisition.id}/approve`, {});
  const lineId = approved.lines[0].id;
  const rfq = await post(request, token, `/projects/${projectId}/rfqs`, { requisitionId: requisition.id });
  const vendor = await post(request, home, `/orgs/${orgId}/vendors`, { name: `Commercial Vendor ${tag}` });
  await post(request, token, `/projects/${projectId}/vendors`, { vendorId: vendor.id });
  const withQuote = await post(request, token, `/projects/${projectId}/rfqs/${rfq.id}/quotes`, {
    vendorId: vendor.id, validUntil: '2027-01-01',
    lines: [{
      requisitionLineId: lineId, baseRate: '100.00', taxAmount: '0.00', freightAmount: '0.00',
      landedCost: '100.00', quotedMake: 'UltraTech', matchesSpecification: true,
    }],
  });
  const quoteId = (withQuote.quotes as Array<{ id: string; status: string }>).find((q) => q.status === 'recorded')!.id;
  await post(request, token, `/projects/${projectId}/rfqs/${rfq.id}/comparison`, {});
  const cmp = await post(request, token, `/projects/${projectId}/rfqs/${rfq.id}/comparison/approve`, {
    selectedQuoteId: quoteId, reason: 'single in-spec quote',
  });
  const po = await post(request, token, `/projects/${projectId}/pos`, {
    comparisonId: cmp.comparison.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }],
  });
  // §B/§C — ISSUING makes an order a COMMITMENT, so its cost head is named in the SAME call.
  // `commercial/attributions` RE-classifies one that already has a head; it cannot create the
  // first. The server refuses an unattributed issue — the rule is the product's, not the test's.
  const draftLine = (await get(request, token, `/projects/${projectId}/pos/${po.id}`)).versions.at(-1).lines[0];
  await post(request, token, `/projects/${projectId}/pos/${po.id}/issue`, {
    costHeads: [{ poLineId: draftLine.id, costHeadCode: headCode }],
  });
  const poLine = (await get(request, token, `/projects/${projectId}/pos/${po.id}`)).versions.at(-1).lines[0];
  const commitment = await post(request, token, `/projects/${projectId}/deliveries`, {
    poLineId: poLine.id, promisedDate: '2026-08-20',
  });
  const lot = await post(request, token, `/projects/${projectId}/stock/receipts`, {
    poLineId: poLine.id, commitmentId: commitment.id, purchaseQty: qty,
  });
  const media = await post(request, token, `/projects/${projectId}/media`, { kind: 'material', mime: 'image/png', data: PX });
  await post(request, token, `/projects/${projectId}/stock/accept`, {
    lotId: lot.id, qty, qualityResult: 'passed', evidenceMediaId: media.id,
  });

  // …and the claim the counterparty makes against it: ₹10,000 for the 100 bags actually accepted
  const bill = await post(request, token, `/projects/${projectId}/commercial/bills`, {
    vendorId: vendor.id, vendorBillNumber: `INV-${tag}`, documentDate: '2026-08-20',
    // no `type` tag: the kind is DERIVED from which purchase-order line the claim names, and the
    // contract refines it as an exclusive-or. One fact, one place.
    lines: [{ poLineId: poLine.id, quantity: qty, rate: '100.00', taxAmount: '0.00', freightAmount: '0.00' }],
  });
  // the §F transitions name the claim in the BODY, not the path — one route per act, the claim as
  // its argument, which is what lets an idempotency key identify the act rather than the URL
  await post(request, token, `/projects/${projectId}/commercial/bills/submit`, { billId: bill.id });
  return { billId: bill.id as string, vendorId: vendor.id as string, headCode };
}

test.beforeAll(async ({ request }) => {
  home = await login(request, PMC);
  const orgs = await get(request, home, '/me/orgs');
  orgId = orgs[0].id;
  pilotId = await ensureProject(request, home, orgId, PILOT_NAME);
  plainId = await ensureProject(request, home, orgId, PLAIN_NAME);

  // §D/§L — enabled on the PILOT project only, through the operator CLI (the sole path).
  // `commercial` activation is NOT a no-op: it must attribute every live PO line, so the CLI
  // demands a PLAN. Supplying one exercises the operator experience §L specifies rather than
  // describing it. A fresh project holds no live lines, so the mapping arrays are empty.
  // …and `materials` FIRST: a commercial claim is bounded by ordered authority and accepted
  // delivery (Phase 3's facts), and those routes are gated on that capability. The phase
  // dependency showing up in the operator's runbook, not a test detail.
  try {
    execSync(
      `pnpm --filter api capability:enable --project ${pilotId} --capability materials --operator ci@vitan.in --reason "Task 7B-iv acceptance"`,
      { stdio: 'pipe' },
    );
  } catch { /* already enabled by a previous run of this suite */ }

  const planPath = join(mkdtempSync(join(tmpdir(), 'commercial-pilot-')), 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    costHeads: [{ code: 'PILOT', name: 'Pilot works' }],
    materialLines: [], labourLines: [],
    reason: 'Task 7B-iv acceptance',
  }));
  try {
    execSync(
      `pnpm --filter api capability:enable --project ${pilotId} --capability commercial --operator ${PMC} --plan ${planPath} --reason "Task 7B-iv acceptance"`,
      { stdio: 'pipe' },
    );
  } catch (e: any) {
    // ALREADY ENABLED is the only tolerable failure: the project is REUSED by `ensureProject`, and
    // re-enabling is refused rather than silently re-attributing. Anything else must fail loudly —
    // swallowing it would leave every later step 404ing with no reason on screen.
    const out = `${e?.stderr ?? ''}${e?.stdout ?? ''}${e?.message ?? ''}`;
    if (!/already enabled|already has/iu.test(out)) throw new Error(`capability:enable commercial failed: ${out}`);
  }

  pmcPilot = await scoped(request, home, pilotId);
  pmcPlain = await scoped(request, home, plainId);
  // a SECOND pmc, as an org ADMIN: `hasProjectRoleStanding` admits an org owner/admin as pmc on a
  // project where they hold no membership, so one org-level grant covers the pilot project without
  // this spec reaching into memberships. Idempotent — the seed user may already be a member.
  try {
    await post(request, home, `/orgs/${orgId}/members`, {
      name: 'Test PMC (Both Sites)', email: SECOND_PMC, role: 'admin',
    });
  } catch { /* already an org member from a previous run */ }
  secondPmcToken = await scoped(request, await login(request, SECOND_PMC), pilotId);
});

test('PILOT §M chain: browser VERIFIES → CERTIFIES → WITHHOLDS → APPROVES → PAYS → REVERSES, and every figure follows', async ({ page, request }) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const activityId = await createActivity(request, pmcPilot, pilotId, `Commercial ${tag}`);
  const { billId } = await claimAwaitingVerification(request, pmcPilot, pilotId, activityId, tag);

  await signInToProject(page, PMC, PILOT_NAME);
  await openCommercial(page);

  // open the claim this test provisioned — the list is newest-first but other tests add rows too
  await page.getByTestId('commercial-tab-claims').click();
  await page.getByTestId(`commercial-claim-row-${billId}`).click();

  /**
   * Each §F transition is confirmed LANDED before the next control is touched. Every one carries a
   * viewed-fact pin the server refuses if the claim has moved, and a write-ahead surface will let a
   * second click ride on a first that was refused — so "the button was clickable" is not evidence.
   */
  const landed = async (status: string) => {
    await expect(async () => {
      const b = await get(request, pmcPilot, `/projects/${pilotId}/commercial/bills/${billId}`);
      expect(b.status, `the claim reached ${status} (it is "${b.status}")`).toBe(status);
    }).toPass({ timeout: 25_000 });
  };

  // ── §E: open verification, then verify against the ordered/accepted/billed triple ────────────
  await page.getByTestId('commercial-tab-certification').click();
  await page.getByTestId(`bill-begin-verification-${billId}`).click();
  await landed('under-verification');
  const verify = page.getByTestId(`bill-verify-${billId}`);
  await expect(verify).toBeEnabled({ timeout: 15_000 });
  await verify.click();
  await landed('verified');

  /**
   * §I working, not an obstacle to route around. This browser's pmc also RECORDED the evidence, and
   * `evidence-recorder-may-not-certify` forbids the pairing — so a second pmc authorises it against
   * this exact claim state, attributably. Over the API because §I forbids a SELF-grant: the browser
   * user cannot be both parties, which is the whole point.
   */
  // the actor id comes from the claim's own preflight — the field §I added because a session
  // carries a role and a name but never an identity an authorisation form can name
  const callerActorId = (await get(request, pmcPilot, `/projects/${pilotId}/commercial/claims/${billId}`))
    .certifyPreflight.callerActorId;
  // …and the grantor's OWN reading supplies the three viewed facts the grant pins (7B-iii-h: an
  // authorisation records the claim state it was justified against). Read as the GRANTOR.
  const asGrantor = await get(request, secondPmcToken, `/projects/${pilotId}/commercial/claims/${billId}`);
  const liveVersionId = (asGrantor.bill.versions as Array<{ id: string; live: boolean }>).find((v) => v.live)!.id;
  await post(request, secondPmcToken, `/projects/${pilotId}/commercial/bills/sod-grant`, {
    billId, actorId: callerActorId,
    versionId: liveVersionId,
    status: asGrantor.bill.status,
    lifecycleVersion: asGrantor.certifyPreflight.lifecycleVersion,
    reason: 'single-pmc pilot site: authorised to certify own evidence',
  });

  // ── §E/§G bound 3: certify what the evidence supports ────────────────────────────────────────
  const certify = page.getByTestId(`bill-certify-${billId}`);
  await expect(certify).toBeEnabled({ timeout: 15_000 });
  await certify.click();

  await landed('certified');

  // ── §H: withhold 10% retention, which LOWERS what may be approved ────────────────────────────
  await page.getByTestId('commercial-tab-payments').click();
  await page.getByTestId('deduct-type').selectOption('retention');
  await page.getByTestId('deduct-amount').fill('1000.00');
  await page.getByTestId(`deduct-${billId}`).click();
  // the payable falls from 10,000 to 9,000 and the screen says so before anything is authorised
  await expect(page.getByTestId('payments-approvable')).toContainText('9000.00', { timeout: 15_000 });

  /**
   * §I again, its OTHER rule — the one this unit exposed to the client. The browser user has now
   * CERTIFIED, so `certifier-may-not-approve` forbids them approving; the second pmc grants it
   * against the claim state as it stands NOW, which differs from the certification grant because
   * certifying and withholding both moved the revision. Before 7B-iv the screen read
   * `certifyPreflight` here — a different rule — so a live CERTIFY grant would have enabled this
   * button and the server would have refused the payment after the outbox reported it saved.
   */
  const nowAsGrantor = await get(request, secondPmcToken, `/projects/${pilotId}/commercial/claims/${billId}`);
  await post(request, secondPmcToken, `/projects/${pilotId}/commercial/bills/sod-grant`, {
    billId, actorId: callerActorId,
    versionId: (nowAsGrantor.bill.versions as Array<{ id: string; live: boolean }>).find((v) => v.live)!.id,
    status: nowAsGrantor.bill.status,
    lifecycleVersion: nowAsGrantor.certifyPreflight.lifecycleVersion,
    // the SAME rule the browser's §I form now offers (7B-iv). Issued here over the API only
    // because §I forbids a self-grant and this spec drives ONE browser session — the grantor is a
    // different person, not a different interface. That the surface exists is proven in the screen
    // and store suites; what this chain proves is that the grant makes the approval live.
    rule: 'certifier-may-not-approve',
    reason: 'single-pmc pilot site: authorised to approve a claim they certified',
  });
  await page.getByTestId('commercial-refresh').click();

  // ── §G bound 4: approve what is payable, and no more ─────────────────────────────────────────
  const approve = page.getByTestId(`approve-${billId}`);
  await page.getByTestId('approve-amount').fill('9000.01');
  await expect(approve, 'one paisa past the payable is still an overdraw').toBeDisabled();
  await page.getByTestId('approve-amount').fill('9000.00');
  await expect(approve).toBeEnabled();
  await approve.click();

  // ── §G bound 5: pay against THAT authorisation ───────────────────────────────────────────────
  const approval = page.getByTestId('pay-approval');
  await expect(approval).toBeVisible({ timeout: 15_000 });
  const approvalId = await approval.locator('option').nth(1).getAttribute('value');
  await approval.selectOption(approvalId!);
  await page.getByTestId('pay-amount').fill('9000.01');
  await page.getByTestId('pay-method').fill('neft');
  await expect(page.getByTestId(`pay-${billId}`), 'a payment cannot exceed what it draws on').toBeDisabled();
  await page.getByTestId('pay-amount').fill('4000.00');
  await expect(page.getByTestId(`pay-${billId}`)).toBeEnabled();
  await page.getByTestId(`pay-${billId}`).click();

  // ── §0: cash that came back is its own fact, never an edit of the payment ────────────────────
  const reversePick = page.getByTestId('reverse-payment');
  await expect(reversePick).toBeVisible({ timeout: 15_000 });
  const paymentId = await reversePick.locator('option').nth(1).getAttribute('value');
  await reversePick.selectOption(paymentId!);
  await page.getByTestId('reverse-amount').fill('4000.01');
  await page.getByTestId('reverse-reason').fill('bank returned it');
  await expect(page.getByTestId(`reverse-${billId}`), 'more than the payment moved never came back').toBeDisabled();
  await page.getByTestId('reverse-amount').fill('1000.00');
  await page.getByTestId(`reverse-${billId}`).click();

  // and the SERVER agrees with the screen: 4,000 paid less 1,000 returned
  await expect(async () => {
    const ledger = await get(request, pmcPilot, `/projects/${pilotId}/commercial/bills/${billId}/payments`);
    expect(ledger.approved).toBe('9000.00');
    expect(ledger.paid, 'PAID is a fold over payments AND reversals').toBe('3000.00');
  }).toPass({ timeout: 20_000 });
});

test('NON-PILOT: the Commercial surface is ABSENT, and its reads 404', async ({ page, request }) => {
  await signInToProject(page, PMC, PLAIN_NAME);
  await expect(
    page.getByRole('navigation').getByRole('button', { name: /Commercial|Money/ }),
    'no capability, no nav',
  ).toHaveCount(0);

  for (const path of ['commercial/money-position', 'commercial/bills', 'commercial/advances']) {
    const res = await request.get(`${API}/projects/${plainId}/${path}`, { headers: bearer(pmcPlain) });
    expect(res.status(), `${path} off-pilot`).toBe(404);
  }
});
