import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Phase 1 Task 7 — THE PILLAR CHAIN, browser-level, over the real stack
 * (compiled NestJS + seeded PostgreSQL + the web app in API mode):
 *
 *   PMC issues a decision → client approves (attributed) → PMC issues a
 *   for_construction drawing (recipients FROZEN) → engineer + contractor
 *   acknowledge → PMC issues a checklist LINKED to the activity → the activity
 *   becomes ready and starts → engineer fails an item WITH a real photo → PMC
 *   rejects → the linked reinspection appears in the engineer's Inbox →
 *   engineer passes it with evidence → activity complete → awaiting_signoff →
 *   PMC approves the closing inspection → done. Then the change loop: a change
 *   request on the approved decision reverts readiness → the client
 *   re-approves → ready again.
 *
 * The chain runs in its OWN project (created here through the org API by the
 * seeded org owner) so the frozen recipient set is exactly the cast and the
 * isolation re-proof against the seeded projects is meaningful. Human steps
 * run in the BROWSER; PMC authoring uses the API (the same contracts the UI
 * calls). Serial — one worker, one database.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';

// the seeded ambli-homed cast (apps/api/prisma/seed.ts)
const PMC = 'pmc@vitan.in';
const CLIENT = 'client@vitan.in';
const ENG = 'test-eng@vitan.in';
const CON = 'contractor@vitan.in';

const PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
); // a real 1×1 PNG

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}

/** A token SCOPED to the chain project (login lands on the user's home project). */
async function chainToken(request: APIRequestContext, email: string, projectId: string): Promise<string> {
  const home = await login(request, email);
  const res = await request.post(`${API}/auth/switch`, { headers: bearer(home), data: { projectId } });
  expect(res.ok(), `switch ${email} → ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

/** Sign in and land on the CHAIN project (switch from the user's home). */
async function signInToChain(page: Page, email: string, chainName: string): Promise<void> {
  await page.goto('/');
  await signIn(page, email);
  await expect(page.getByTestId('project-switcher')).toBeVisible();
  await page.getByTestId('project-switcher').click();
  await page.getByRole('button', { name: new RegExp(chainName) }).first().click();
  await expect(page.getByTestId('project-switcher')).toContainText(chainName);
}

// ── chain state shared across the serial tests ──────────────────────────────
let chainId = '';
const CHAIN_NAME = 'Chain Acceptance Site';
let pmcToken = '';
let engToken = '';
let conToken = '';
let decisionId = '';
let activityId = '';
let inspectionId = '';

async function snapshot(request: APIRequestContext, token: string) {
  const res = await request.get(`${API}/projects/${chainId}/snapshot`, { headers: bearer(token) });
  expect(res.ok(), `snapshot → ${res.status()}`).toBeTruthy();
  return res.json();
}

const readinessOf = (snap: { activities: Array<{ id: string; readiness: Record<string, { v: string; source: string }> }> }) =>
  snap.activities.find((a) => a.id === activityId)!.readiness;

/** The UI flashes optimistically — poll the SERVER until the derived gate settles. */
async function pollGate(request: APIRequestContext, gate: 'decision' | 'inspection' | 'drawing', want: string): Promise<void> {
  await expect
    .poll(async () => readinessOf(await snapshot(request, pmcToken))[gate].v, { timeout: 15_000 })
    .toBe(want);
}
async function pollStatus(request: APIRequestContext, want: string): Promise<void> {
  await expect
    .poll(async () => (await snapshot(request, pmcToken)).activities.find((a: { id: string }) => a.id === activityId)?.status, { timeout: 15_000 })
    .toBe(want);
}

/** Worker restarts wipe module state — re-derive the chain ids by their KNOWN names. */
async function ensureIds(request: APIRequestContext): Promise<void> {
  if (decisionId && activityId && inspectionId) return;
  const snap = await snapshot(request, pmcToken);
  decisionId ||= (snap.decisions as Array<{ id: string; title: string }>).find((d) => d.title === 'Chain floor finish')?.id ?? '';
  activityId ||= (snap.activities as Array<{ id: string; name: string }>).find((a) => a.name === 'Chain flooring')?.id ?? '';
  inspectionId ||= ((snap.placedInspections ?? []) as Array<{ id: string; title: string }>).find((i) => i.title === 'Chain quality check')?.id ?? '';
}

test.beforeAll(async ({ request }) => {
  // the org owner creates the chain project and enrols the cast with real roles
  const owner = await login(request, PMC);
  const orgs = await (await request.get(`${API}/me/orgs`, { headers: bearer(owner) })).json();
  const orgId = orgs[0].id;
  // idempotent: a worker restart re-runs this hook against the same database —
  // reuse the chain project if an earlier worker already created it
  const existing = await (await request.get(`${API}/orgs/${orgId}/projects`, { headers: bearer(owner) })).json();
  const found = (existing as Array<{ id: string; name: string }>).find((x) => x.name === CHAIN_NAME);
  if (found) {
    chainId = found.id;
  } else {
    const created = await request.post(`${API}/orgs/${orgId}/projects`, {
      headers: bearer(owner),
      data: { name: CHAIN_NAME, short: CHAIN_NAME, descriptor: 'Task 7 acceptance', stage: 'Finishing', siteCode: 'CHN-1' },
    });
    expect(created.ok(), `create project → ${created.status()}`).toBeTruthy();
    chainId = (await created.json()).id;
  }

  pmcToken = await chainToken(request, PMC, chainId);
  for (const [email, name, role] of [
    [CLIENT, 'Mr. Shah', 'client'],
    [ENG, 'Test Engineer (Ambli Only)', 'engineer'],
    [CON, 'Rajesh (Contractor)', 'contractor'],
  ] as const) {
    const add = await request.post(`${API}/projects/${chainId}/members`, { headers: bearer(pmcToken), data: { name, role, email } });
    expect(add.ok() || add.status() === 409, `add ${email} → ${add.status()}`).toBeTruthy();
  }
  engToken = await chainToken(request, ENG, chainId);
  conToken = await chainToken(request, CON, chainId);
});

test('the chain is AUTHORED: decision, linked activity, frozen drawing, linked checklist — and readiness derives every block', async ({ request }) => {
  // PMC issues the decision the work depends on
  expect((await request.post(`${API}/projects/${chainId}/decisions`, {
    headers: bearer(pmcToken),
    data: {
      title: 'Chain floor finish', room: 'Hall', publish: true,
      options: [
        { label: 'Kota stone', material: 'Kota', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Granite', material: 'Granite', delta: 90000, swatch: 'sw2', recommended: false },
      ],
    },
  })).ok()).toBeTruthy();
  let snap = await snapshot(request, pmcToken);
  decisionId = snap.decisions.find((d: { title: string; id: string }) => d.title === 'Chain floor finish')!.id;

  // the activity the whole chain gates
  expect((await request.post(`${API}/projects/${chainId}/activities`, {
    headers: bearer(pmcToken),
    data: { name: 'Chain flooring', plannedStart: 0, plannedEnd: 7, decisionId },
  })).ok()).toBeTruthy();
  snap = await snapshot(request, pmcToken);
  activityId = snap.activities.find((a: { name: string; id: string }) => a.name === 'Chain flooring')!.id;

  // a for_construction drawing LINKED to the activity — issuing FREEZES the
  // distribution to the active engineer + contractor (exactly our cast)
  expect((await request.post(`${API}/projects/${chainId}/drawings`, {
    headers: bearer(pmcToken),
    data: { number: 'CH-100', title: 'Chain flooring layout', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 chain').toString('base64'), publish: true, activityId },
  })).ok()).toBeTruthy();

  // the checklist that ACCEPTS the work (explicit requirement edge)
  expect((await request.post(`${API}/projects/${chainId}/inspections`, {
    headers: bearer(pmcToken),
    data: { title: 'Chain quality check', zone: 'Hall', items: ['Level within tolerance'], activityId },
  })).ok()).toBeTruthy();
  snap = await snapshot(request, pmcToken);
  const review = snap.checklist as { id: string };
  inspectionId = review.id;

  // readiness DERIVES every block, and start refuses with the gates named
  const r = readinessOf(snap);
  expect(r.decision).toMatchObject({ v: 'wait', source: 'derived' }); // client has not approved
  expect(r.drawing).toMatchObject({ v: 'wait', source: 'derived' }); // 0/2 acknowledged
  expect(r.inspection).toMatchObject({ v: 'wait', source: 'derived' }); // open requirement
  const start = await request.post(`${API}/projects/${chainId}/activities/${activityId}/start`, { headers: bearer(engToken) });
  expect(start.status()).toBe(409);
});

test('the CLIENT approves in the browser — attributed, and the decision gate flips', async ({ page, request }) => {
  await ensureIds(request);
  await signInToChain(page, CLIENT, CHAIN_NAME);
  await page.getByRole('button', { name: 'Decisions Waiting' }).click();
  await expect(page.getByText('Chain floor finish')).toBeVisible();
  await page.getByTestId(`approve-${decisionId}-a`).click();
  await page.getByTestId('approve-lock').click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();

  await pollGate(request, 'decision', 'ok');
  const snap = await snapshot(request, pmcToken);
  const d = snap.decisions.find((x: { id: string }) => x.id === decisionId);
  expect(d.status).toBe('approved');
  expect(d.approver).toBe('Mr. Shah'); // the REAL person, recorded
});

test('the frozen distribution acknowledges — engineer in the browser, contractor over the API — and the drawing gate follows the set', async ({ page, request }) => {
  await ensureIds(request);
  await signInToChain(page, ENG, CHAIN_NAME);
  await page.getByRole('button', { name: 'Drawings' }).click();
  await page.getByTestId('drawing-CH-100').click();
  await page.getByTestId('ack-drawing').click();
  await expect(page.getByText(/acknowledged/i).first()).toBeVisible();

  await pollGate(request, 'drawing', 'wait'); // 1/2 — partial acknowledgement still waits

  const snap = await snapshot(request, pmcToken);
  const rev = snap.drawings.find((d: { number: string }) => d.number === 'CH-100')!.current;
  expect((await request.post(`${API}/projects/${chainId}/drawings/rev/${rev.id}/ack`, { headers: bearer(conToken) })).ok()).toBeTruthy();
  await pollGate(request, 'drawing', 'ok'); // every active recipient confirmed
});

test('the ENGINEER fails an item with a REAL photo; the PMC rejects; the linked reinspection lands in the engineer’s Inbox', async ({ page, request }) => {
  await ensureIds(request);
  // the evidence rule end-to-end: the failed item carries a LINKED photo
  await signInToChain(page, ENG, CHAIN_NAME);
  await page.getByRole('button', { name: "Today's Checklist" }).click();
  await expect(page.getByText('Chain quality check')).toBeVisible();
  await page.getByRole('button', { name: 'Fail' }).click();
  await page.getByPlaceholder(/describe the issue/i).fill('Hollow patch near the door');
  await page.getByTestId('evidence-file-input').setInputFiles({ name: 'defect.png', mimeType: 'image/png', buffer: PX });
  await expect(page.getByText(/uploaded and linked/i)).toBeVisible();
  await page.getByTestId('submit-inspection').click();
  await expect(page.getByTestId('submit-inspection')).toContainText(/submitted/i);

  // the PMC rejects the failed work in the browser
  await signInToChain(page, PMC, CHAIN_NAME);
  await page.getByRole('button', { name: 'Inspection Review' }).click();
  await expect(page.getByText('Chain quality check').first()).toBeVisible();
  await page.getByRole('button', { name: 'Reject item' }).click(); // the PMC NAMES the rejected work
  await page.getByTestId('send-reinspection').click();
  await expect(page.getByText(/re-inspection task/i).first()).toBeVisible();

  // the correction chain is OPEN — the gate reads FAIL until the fix is accepted
  await pollGate(request, 'inspection', 'fail');

  // …and it appears in the ENGINEER's Inbox as their work
  await signInToChain(page, ENG, CHAIN_NAME);
  await page.getByRole('button', { name: 'For You' }).click();
  await expect(page.getByTestId('inbox-item-eng-checklist')).toContainText('Re-inspection: Chain quality check');
});

test('the engineer PASSES the reinspection with evidence; the PMC accepts; the activity becomes ready, starts, completes and is SIGNED OFF done', async ({ page, request }) => {
  await ensureIds(request);
  // engineer corrects the work: pass WITH a supporting photo
  await signInToChain(page, ENG, CHAIN_NAME);
  await page.getByRole('button', { name: "Today's Checklist" }).click();
  await expect(page.getByText('Re-inspection: Chain quality check')).toBeVisible();
  await page.getByRole('button', { name: 'Pass' }).click(); // mark FIRST — the upload's snapshot refresh preserves marks
  await page.getByTestId('evidence-file-input').setInputFiles({ name: 'fixed.png', mimeType: 'image/png', buffer: PX });
  await expect(page.getByText(/uploaded and linked/i)).toBeVisible();
  await page.getByTestId('submit-inspection').click();
  await expect(page.getByTestId('submit-inspection')).toContainText(/submitted/i);

  // the PMC ACCEPTS the correction — the chain closes, the gate turns ok
  await signInToChain(page, PMC, CHAIN_NAME);
  await page.getByRole('button', { name: 'Inspection Review' }).click();
  await page.getByRole('button', { name: 'Approve Inspection' }).click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();
  await pollGate(request, 'inspection', 'ok');

  // START in the browser — every derived gate now aligns
  await signInToChain(page, ENG, CHAIN_NAME);
  await page.getByRole('button', { name: 'Site Schedule' }).click();
  await page.getByTestId(`start-${activityId}`).click();
  await expect(page.getByRole('button', { name: /mark complete/i })).toBeVisible();

  // COMPLETE is a claim — awaiting sign-off, not done
  await page.getByRole('button', { name: /mark complete/i }).click();
  await expect(page.getByRole('button', { name: /awaiting sign-off/i })).toBeVisible();
  await pollStatus(request, 'awaiting-signoff');

  // ONLY the PMC's closing approval writes done
  await signInToChain(page, PMC, CHAIN_NAME);
  await page.getByRole('button', { name: 'Inspection Review' }).click();
  await expect(page.getByTestId('closing-signoff-label')).toBeVisible();
  await page.getByRole('button', { name: 'Approve Inspection' }).click();
  await pollStatus(request, 'done');
});

test('the CHANGE LOOP: a change request reverts readiness; the client re-approves in the browser; ready again', async ({ page, request }) => {
  await ensureIds(request);
  expect((await request.post(`${API}/projects/${chainId}/decisions/${decisionId}/change`, {
    headers: bearer(conToken),
    data: { reason: 'Kota lot rejected at yard', costImpact: 0, timeImpactDays: 3 },
  })).ok()).toBeTruthy();
  await pollGate(request, 'decision', 'wait'); // the reopening reverts readiness automatically

  await signInToChain(page, CLIENT, CHAIN_NAME);
  await page.getByRole('button', { name: 'Decisions Waiting' }).click();
  await page.getByTestId(`approve-${decisionId}-a`).click();
  await page.getByTestId('approve-lock').click();
  await expect(page.getByText(/approved/i).first()).toBeVisible();

  await pollGate(request, 'decision', 'ok');
  const snap = await snapshot(request, pmcToken);
  const cr = snap.decisions.find((d: { id: string }) => d.id === decisionId);
  expect(cr.status).toBe('approved');
});

test('NEGATIVES: review copies never govern; same-room inspections are invisible; a review-only drawing degrades the gate; non-PMC cannot override', async ({ request }) => {
  await ensureIds(request);
  // a for_review issue does NOT displace the governing set
  expect((await request.post(`${API}/projects/${chainId}/drawings`, {
    headers: bearer(pmcToken),
    data: { number: 'CH-100', title: 'Chain flooring layout', discipline: 'architectural', rev: 'B', status: 'for_review', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 review').toString('base64') },
  })).ok()).toBeTruthy();
  let snap = await snapshot(request, pmcToken);
  const dwg = snap.drawings.find((d: { number: string }) => d.number === 'CH-100');
  expect(dwg.current.rev).toBe('A');
  expect(dwg.current.status).toBe('for_construction');
  expect(readinessOf(snap).drawing.v).toBe('ok');

  // an unrelated inspection sharing only the ROOM never moves the gate
  expect((await request.post(`${API}/projects/${chainId}/inspections`, {
    headers: bearer(pmcToken),
    data: { title: 'Unrelated hall check', zone: 'Hall', items: ['Other work'] },
  })).ok()).toBeTruthy();
  snap = await snapshot(request, pmcToken);
  expect(readinessOf(snap).inspection.v).toBe('ok');

  // a SECOND linked drawing whose only revision is a review copy → aggregate fail
  expect((await request.post(`${API}/projects/${chainId}/drawings`, {
    headers: bearer(pmcToken),
    data: { number: 'CH-101', title: 'Review-only detail', discipline: 'architectural', rev: 'A', status: 'for_review', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 detail').toString('base64'), publish: true, activityId },
  })).ok()).toBeTruthy();
  snap = await snapshot(request, pmcToken);
  expect(readinessOf(snap).drawing.v).toBe('fail');

  // an override is the PMC's authority alone
  const future = new Date(Date.now() + 3600_000).toISOString();
  const forbidden = await request.post(`${API}/projects/${chainId}/activities/${activityId}/override`, {
    headers: bearer(engToken),
    data: { gate: 'drawing', state: 'ok', reason: 'nope', expiresAt: future },
  });
  expect(forbidden.status()).toBe(403);
});

test('ISOLATION re-proof: the chain is invisible from every other project, and outsiders cannot read the chain', async ({ request }) => {
  // the seeded projects see NONE of the chain records
  const pmcAmbli = await login(request, PMC); // home = ambli
  const ambliSnap = await (await request.get(`${API}/projects/ambli/snapshot`, { headers: bearer(pmcAmbli) })).json();
  const flat = JSON.stringify(ambliSnap);
  for (const marker of ['Chain floor finish', 'Chain flooring', 'CH-100', 'Chain quality check', CHAIN_NAME]) {
    expect(flat).not.toContain(marker);
  }

  // a member of ANOTHER project cannot read the chain snapshot at all
  const clientB = await login(request, 'test-client-b@vitan.in'); // member of test-empty-site only
  const res = await request.get(`${API}/projects/${chainId}/snapshot`, { headers: bearer(clientB) });
  expect([401, 403]).toContain(res.status());
});

test('OFFLINE EVIDENCE: a captured photo survives a reload and replays exactly once; an oversized capture queues NOTHING; a terminal 4xx dead-letters with Retry', async ({ page, request }) => {
  // the field view surfaces ONE open checklist — retire leftovers from earlier
  // tests (e.g. the NEGATIVES room-only inspection) so ours is the one on screen
  for (let guard = 0; guard < 5; guard++) {
    const snap = await snapshot(request, engToken);
    const open = snap.checklist && !snap.checklist.submitted ? snap.checklist : null;
    if (!open) break;
    expect((await request.post(`${API}/projects/${chainId}/inspections/${open.id}/submit`, {
      headers: bearer(engToken),
      data: { items: open.items.map((it: { name: string }) => ({ name: it.name, state: 'pass', photos: 0, note: '' })) },
    })).ok()).toBeTruthy();
  }

  // a fresh checklist for the engineer + a daily log so the connectivity toggle exists
  expect((await request.post(`${API}/projects/${chainId}/inspections`, {
    headers: bearer(pmcToken),
    data: { title: 'Offline capture check', zone: 'Hall', items: ['Waterproof coat'] },
  })).ok()).toBeTruthy();
  await request.post(`${API}/projects/${chainId}/daily-log/start`, { headers: bearer(engToken) });

  await signInToChain(page, ENG, CHAIN_NAME);

  // go OFFLINE (the app's own connectivity switch — the queue is the contract)
  await page.getByRole('button', { name: 'Daily Site Log' }).click();
  await page.getByTestId('toggle-online').click();

  // an OVERSIZED capture is refused loudly and queues nothing
  await page.getByRole('button', { name: "Today's Checklist" }).click();
  await expect(page.getByText('Offline capture check')).toBeVisible();
  await page.getByTestId('evidence-file-input').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024, 7) });
  await expect(page.getByText(/too large/i).first()).toBeVisible();
  await expect(page.getByTestId('evidence-pending')).toHaveCount(0);

  // a real capture is saved DURABLY before any success message
  await page.getByTestId('evidence-file-input').setInputFiles({ name: 'coat.png', mimeType: 'image/png', buffer: PX });
  await expect(page.getByText(/saved offline/i).first()).toBeVisible();
  await expect(page.getByTestId('evidence-pending')).toContainText(/1 photo/);

  // RELOAD: the in-memory store dies; the bytes and the queued op survive
  await page.reload();
  await signIn(page, ENG);
  await expect(page.getByTestId('project-switcher')).toBeVisible();
  await page.getByTestId('project-switcher').click();
  await page.getByRole('button', { name: new RegExp(CHAIN_NAME) }).first().click();

  // back online → the replay uploads EXACTLY once (project-scoped clientKey dedupe).
  // Boot resets online=true without flushing — cycle the switch to trigger the flush.
  await page.getByRole('button', { name: 'Daily Site Log' }).click();
  await expect(page.getByTestId('conn-text')).toBeVisible();
  await page.getByTestId('toggle-online').click(); // → offline
  await page.getByTestId('toggle-online').click(); // → online: flush
  await expect
    .poll(async () => {
      const snap = await snapshot(request, pmcToken);
      const chk = (snap.checklist ?? {}) as { title?: string; items?: Array<{ evidence: string[] }> };
      return chk.title === 'Offline capture check' ? (chk.items?.[0]?.evidence.length ?? 0) : -1;
    }, { timeout: 15_000 })
    .toBe(1);

  // a TERMINAL non-dedupe 4xx must dead-letter, not delete: capture offline, fail the replay once
  await page.getByRole('button', { name: 'Daily Site Log' }).click();
  await page.getByTestId('toggle-online').click(); // offline again
  await page.getByRole('button', { name: "Today's Checklist" }).click();
  await page.getByTestId('evidence-file-input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: PX });
  await expect(page.getByText(/saved offline/i).first()).toBeVisible();

  await page.route('**/media', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"forbidden"}' }));
  await page.getByRole('button', { name: 'Daily Site Log' }).click();
  await page.getByTestId('toggle-online').click(); // replay → 403 → FAILED state, bytes retained
  await page.getByRole('button', { name: "Today's Checklist" }).click();
  await expect(page.getByTestId('evidence-failed')).toBeVisible();

  // the user's RETRY re-uses the same key once the server accepts again
  await page.unroute('**/media');
  const retry = page.locator('[data-testid^="evidence-retry-"]');
  await retry.first().click();
  await expect(page.getByTestId('evidence-failed')).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => {
      const snap = await snapshot(request, pmcToken);
      const chk = (snap.checklist ?? {}) as { title?: string; items?: Array<{ evidence: string[] }> };
      return chk.title === 'Offline capture check' ? (chk.items?.[0]?.evidence.length ?? 0) : -1;
    }, { timeout: 15_000 })
    .toBe(2);
});
