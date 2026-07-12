import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Phase 0 Task 8 — the two-project acceptance proof, over the REAL stack:
 * NestJS + PostgreSQL (seeded by scripts/test-api-e2e.sh) + the web app in API
 * mode. Fixtures (apps/api/prisma/seed.ts, stable `test-` ids):
 *   Project A `ambli` — populated (decisions, activities, drawing, checklist,
 *     daily log, photo).
 *   Project B `test-empty-site` — no operational records.
 *   test-pmc@vitan.in       PMC, member of BOTH, home = B.
 *   test-client-b@vitan.in  client, member of B only, home = B.
 *   test-eng@vitan.in       engineer, member of A only.
 *   test-removed@vitan.in   engineer, active member of A until a scenario
 *                           removes the membership live.
 *
 * Serial (one worker): scenarios share one seeded database; the revocation
 * scenario mutates memberships and runs against its own dedicated user.
 */
const API = 'http://localhost:3000';
// the seed's default demo password (apps/api/prisma/seed.ts, SEED_DEMO_PASSWORD unset)
const PASSWORD = 'vitan123';
const A = 'ambli';
const B = 'test-empty-site';

/** Drive the real sign-in gate: who-are-you → team member → password login. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

async function apiLogin(request: APIRequestContext, email: string): Promise<{ token: string; projectId: string; role: string }> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return res.json();
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test('authentication lands on the server project', async ({ page }) => {
  // the URL claims Project A; the signing-in user's server-side scope is B only
  await page.goto(`/projects/${A}/decisions`);
  const snapB = page.waitForResponse((r) => r.url().includes(`/projects/${B}/snapshot`) && r.status() === 200);
  await signIn(page, 'test-client-b@vitan.in');
  await snapB; // token scope is B — a token scoped elsewhere would 403 this route
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/`));
  expect(page.url()).not.toContain(`/projects/${A}`);
});

test('populated A to empty B is atomic', async ({ page }) => {
  await page.goto('/');
  await signIn(page, 'test-pmc@vitan.in'); // home = B
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');

  // over to populated A, onto its decision log
  await page.getByTestId('project-switcher').click();
  await page.getByRole('button', { name: /Residence at Ambli/ }).click();
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page.getByText('DL-014').first()).toBeVisible();

  // switch back to B with its snapshot artificially delayed
  await page.route(`**/projects/${B}/snapshot`, async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.getByTestId('project-switcher').click();
  await page.getByRole('button', { name: /Test Empty Site/ }).click();

  // the loading boundary appears immediately; no A decision is visible during the gap
  await expect(page.getByTestId('project-switching')).toBeVisible();
  await expect(page.getByText('DL-014')).toHaveCount(0);

  // …and after the empty B snapshot lands, still no A records anywhere
  await expect(page.getByTestId('project-switching')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/decisions`));
  await expect(page.getByText('DL-014')).toHaveCount(0);
  await expect(page.getByText(/Residence at Ambli/)).toHaveCount(0);
});

test('deep link survives token switch', async ({ page }) => {
  await page.goto(`/projects/${B}/decisions`);
  await signIn(page, 'test-pmc@vitan.in');
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/decisions$`));
  await expect(page.getByText('CLIENT DECISION LOG')).toBeVisible();

  // a refresh drops the in-memory token — signing in again mints a NEW token,
  // and the deep link's project AND screen still survive
  await page.reload();
  await signIn(page, 'test-pmc@vitan.in');
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/decisions$`));
  await expect(page.getByText('CLIENT DECISION LOG')).toBeVisible();
});

test('history preserves scope and screen', async ({ page }) => {
  await page.goto('/');
  await signIn(page, 'test-pmc@vitan.in'); // lands on B's role home
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');

  await page.getByTestId('project-switcher').click();
  await page.getByRole('button', { name: /Residence at Ambli/ }).click();
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${A}/dashboard`));

  await page.getByTestId('project-switcher').click();
  await page.getByRole('button', { name: /Test Empty Site/ }).click();
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/decisions`));
  await page.getByRole('button', { name: 'Drawings' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/drawings`));

  // back through history: every entry restores MATCHING project identity + path
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/decisions`));
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');

  await page.goBack(); // B's role home
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/`));
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');

  await page.goBack(); // cross-project entry → re-scopes to A
  await expect(page).toHaveURL(new RegExp(`/projects/${A}/`), { timeout: 15_000 });
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli', { timeout: 15_000 });

  await page.goForward(); // forward across the project boundary again
  await expect(page).toHaveURL(new RegExp(`/projects/${B}/`), { timeout: 15_000 });
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site', { timeout: 15_000 });
});

test('non-member is forbidden', async ({ page, request }) => {
  // API: the A-only engineer's token gets 403 on every Project B surface
  const eng = await apiLogin(request, 'test-eng@vitan.in');
  expect(eng.projectId).toBe(A);
  const snap = await request.get(`${API}/projects/${B}/snapshot`, { headers: bearer(eng.token) });
  expect(snap.status()).toBe(403);
  const sw = await request.post(`${API}/auth/switch`, { headers: bearer(eng.token), data: { projectId: B } });
  expect(sw.status()).toBe(403);

  // UI: B is never offered, and a forged B path renders no B (or stale A) records —
  // the deep link is redirected back under the project the user actually holds
  const bRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`/projects/${B}/`)) bRequests.push(r.url());
  });
  await page.goto('/');
  await signIn(page, 'test-eng@vitan.in');
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await expect(page.getByText('Test Empty Site')).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState({}, '', '/projects/test-empty-site/decisions');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(new RegExp(`/projects/${A}/`)); // redirected home
  await expect(page.getByText('Test Empty Site')).toHaveCount(0);
  expect(bRequests, 'the UI must never request Project B data for a non-member').toEqual([]);
});

test('removed membership revokes token', async ({ page, request }) => {
  // the member's live token works before removal…
  const member = await apiLogin(request, 'test-removed@vitan.in');
  expect(member.projectId).toBe(A);
  const before = await request.get(`${API}/projects/${A}/snapshot`, { headers: bearer(member.token) });
  expect(before.status()).toBe(200);

  // …and they are signed in on A in the browser
  await page.goto('/');
  await signIn(page, 'test-removed@vitan.in');
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');

  // an org owner removes the membership through the real admin endpoint
  const owner = await apiLogin(request, 'pmc@vitan.in');
  const del = await request.delete(`${API}/projects/${A}/members/test-user-removed`, { headers: bearer(owner.token) });
  expect(del.ok(), `member removal → ${del.status()}`).toBeTruthy();

  // the SAME still-unexpired token is now refused live — token ≠ continuing authority
  const after = await request.get(`${API}/projects/${A}/snapshot`, { headers: bearer(member.token) });
  expect(after.status()).toBe(403);
  // and a fresh sign-in is refused outright: access removed everywhere
  const relogin = await request.post(`${API}/auth/login`, { data: { email: 'test-removed@vitan.in', password: PASSWORD } });
  expect(relogin.status()).toBe(401);

  // the UI's next full fetch clears the project: back to the gate, no A records
  await page.reload();
  await expect(page.getByText('Who are you?')).toBeVisible();
  await expect(page.getByText('DL-014')).toHaveCount(0);
  await expect(page.getByTestId('project-switcher')).toHaveCount(0);
});

test('cross-project reference is rejected', async ({ request }) => {
  const pmc = await apiLogin(request, 'test-pmc@vitan.in');
  expect(pmc.projectId).toBe(B);

  // a Project B drawing claiming to govern a Project A activity
  const res = await request.post(`${API}/projects/${B}/drawings`, {
    headers: bearer(pmc.token),
    data: {
      number: 'X-999',
      title: 'Cross-project forgery',
      discipline: 'architectural',
      rev: 'A',
      mime: 'application/pdf',
      data: 'JVBERi0xLjQgZm9yZ2Vk', // base64 of "%PDF-1.4 forged"
      activityId: 'ACT-31', // exists — in Project A
    },
  });
  expect(res.status()).toBe(400);

  // and no row was created: B's snapshot still carries zero drawings
  const snap = await request.get(`${API}/projects/${B}/snapshot`, { headers: bearer(pmc.token) });
  expect(snap.status()).toBe(200);
  const body = await snap.json();
  expect(body.drawings ?? []).toHaveLength(0);
  expect((body.drawings ?? []).some((d: { number: string }) => d.number === 'X-999')).toBe(false);
});

test('empty project is truthful', async ({ page, browser }) => {
  // PMC surfaces on B: live identity, zero counts, no Ambli, no fake report
  await page.goto('/');
  await signIn(page, 'test-pmc@vitan.in');
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');

  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByText('Test Empty Site, Bodakdev')).toBeVisible();
  await expect(page.getByText(/Ambli/)).toHaveCount(0);
  await expect(page.getByTestId('tile-photos-value')).toHaveText('0');
  await expect(page.getByText('No progress photos recorded')).toBeVisible();
  const report = page.getByRole('button', { name: /weekly report/i });
  await expect(report).toBeDisabled();
  await expect(report).toHaveAttribute('title', 'Report export is not available yet');
  await report.click({ force: true }); // even a forced click must not fake success
  await expect(page.getByText(/report generated/i)).toHaveCount(0);

  // the portfolio stays truthful: B's card reports its real (zero) rollup
  await page.getByRole('button', { name: 'Portfolio' }).click();
  await expect(page.getByTestId(`portfolio-${B}`)).toContainText('0/0 activities done');

  // client surfaces on B (fresh context, B-only client): recorded stage, honest absence
  const ctx = await browser.newContext();
  const client = await ctx.newPage();
  await client.goto('/');
  await signIn(client, 'test-client-b@vitan.in');
  await client.getByRole('button', { name: 'Project Health' }).click();
  await expect(client.getByText('Mobilisation', { exact: true })).toBeVisible();
  await expect(client.getByText('No progress photos recorded')).toBeVisible();
  await expect(client.getByText(/Ambli/)).toHaveCount(0);
  await expect(client.getByText(/On track/i)).toHaveCount(0);
  await ctx.close();
});
