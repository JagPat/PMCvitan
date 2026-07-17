import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Phase 2 Task 10 correction ROUND 2 (finding 1) — the write-ahead outbox proves itself over the REAL
 * stack: a daily-log command whose RESPONSE is lost after the server already committed is retried under
 * the SAME idempotency key, so the Task-5 command ledger dedups it and the material is recorded EXACTLY
 * ONCE (not twice). Runs in every api-e2e mode (snapshot + moduleQuery, legacy + outbox senders).
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `test-eng@vitan.in` is an active engineer on `ambli`.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const A = 'ambli';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}
async function apiLogin(request: APIRequestContext, email: string): Promise<{ token: string }> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return res.json();
}

test('a lost response after the server commits does NOT double-apply — the write-ahead retry reuses the key', async ({ page, request }) => {
  const MAT = `LostResp-${test.info().workerIndex}-${test.info().retry}`;

  await page.goto('/');
  await signIn(page, 'test-eng@vitan.in');
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await page.getByRole('button', { name: /Daily Site Log/i }).click();
  await expect(page.getByTestId('add-material')).toBeVisible();

  // the FIRST addMaterial POST reaches the server (which COMMITS it) but its RESPONSE is dropped —
  // exactly the "server committed, response lost" case. Later POSTs pass through untouched.
  let dropped = false;
  await page.route('**/projects/*/daily-log/materials', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      await route.fetch();          // the server records the material (commit)
      await route.abort('failed');  // …but the client never receives the response (lost)
      return;
    }
    await route.continue();
  });

  await page.getByTestId('add-material').click();
  await page.getByTestId('mat-name').fill(MAT);
  await page.getByTestId('mat-qty').fill('9 units');
  await page.getByTestId('save-material').click();
  await expect.poll(() => dropped, { message: 'the first POST must reach the server' }).toBe(true);

  // RETRY via reconnect — the persisted write-ahead op replays under the SAME key; the command ledger
  // recognises the key and dedups, so no second material is created.
  await page.getByTestId('toggle-online').click(); // simulate offline
  await page.getByTestId('toggle-online').click(); // back online → flushOutbox replays the pending op

  // proven against the server: the material exists EXACTLY ONCE despite the lost response + retry
  const eng = await apiLogin(request, 'test-eng@vitan.in');
  await expect
    .poll(async () => {
      const res = await request.get(`${API}/projects/${A}/snapshot`, { headers: { Authorization: `Bearer ${eng.token}` } });
      const body = await res.json();
      return (body.materials ?? []).filter((m: { name: string }) => m.name === MAT).length;
    }, { timeout: 10_000, message: 'the material must be recorded exactly once' })
    .toBe(1);
});
