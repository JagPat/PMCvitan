import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 2 Task 10 (correction, finding 5) — the daily-log MODULE-OWNED read, proven end-to-end over
 * the REAL stack (NestJS + PostgreSQL + the web app) with the web app running in `moduleQuery` mode
 * (VITE_DAILYLOG_READ=moduleQuery, forwarded by the runner). This spec runs ONLY in that mode; the
 * default 'snapshot' runs skip it (the daily-log slice rides the snapshot there and never calls the
 * module endpoint).
 *
 * It proves the whole XOR read path the correction touched:
 *   • the daily-log surface is populated by the module-owned `GET …/daily-log` (not the snapshot);
 *   • a command carries the Task-5 `Idempotency-Key` header (finding 3);
 *   • after the command, the module-owned read is REFETCHED under the same scope (finding 2), so the
 *     committed material becomes visible without a page reload.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): Project A `ambli` carries a daily log; `test-eng@vitan.in`
 * is an active engineer on A (home there). Password is the seed default.
 */

const MQ = process.env.E2E_DAILYLOG_READ === 'moduleQuery';
const A = 'ambli';
const PASSWORD = 'vitan123';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test.describe('daily-log module-owned read (moduleQuery)', () => {
  test.skip(!MQ, 'runs only under VITE_DAILYLOG_READ=moduleQuery (E2E_DAILYLOG_READ=moduleQuery)');

  test('the module read owns the surface, commands carry an idempotency key, and reconcile refetches', async ({ page }) => {
    // record every daily-log module request so we can assert the read path + the post-command refetch
    const dailyLogGETs: string[] = [];
    const materialPOSTs: { url: string; idem: string | undefined }[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (r.method() === 'GET' && u.includes(`/projects/${A}/daily-log`)) dailyLogGETs.push(u);
      if (r.method() === 'POST' && u.includes(`/projects/${A}/daily-log/materials`)) {
        materialPOSTs.push({ url: u, idem: r.headers()['idempotency-key'] });
      }
    });

    await page.goto('/');
    await signIn(page, 'test-eng@vitan.in');
    await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');

    // the module-owned GET is fetched alongside the snapshot on load — proving moduleQuery is live
    // (screen navigation itself never refetches; the read rides the snapshot pulls).
    await expect
      .poll(() => dailyLogGETs.length, { message: 'the daily-log surface is served by the module read, not the snapshot' })
      .toBeGreaterThan(0);

    // onto the Daily Site Log screen — the seeded log renders (its own materials); the honest
    // "loading/unavailable" gates are gone because the read has settled 'ready'
    await page.getByRole('button', { name: /Daily Site Log/i }).click();
    await expect(page.getByText('Italian Marble (Botticino)')).toBeVisible();
    await expect(page.getByTestId('crew-total')).toBeVisible();

    // record a NEW material — the command carries an Idempotency-Key and triggers a reconcile refetch
    const getsBefore = dailyLogGETs.length;
    await page.getByTestId('add-material').click();
    await page.getByTestId('mat-name').fill('E2E Module Material');
    await page.getByTestId('mat-qty').fill('7 units');
    const postDone = page.waitForResponse((r) => r.url().includes(`/projects/${A}/daily-log/materials`) && r.request().method() === 'POST' && r.status() < 400);
    await page.getByTestId('save-material').click();
    await postDone;

    // finding 3 — the command carried the Task-5 idempotency key
    expect(materialPOSTs.length).toBeGreaterThan(0);
    expect(materialPOSTs[0].idem, 'the addMaterial command carries an Idempotency-Key header').toBeTruthy();

    // finding 2 — the module read is refetched under the same scope after the command…
    await expect.poll(() => dailyLogGETs.length, { message: 'a post-command module refetch must fire' }).toBeGreaterThan(getsBefore);
    // …and the committed material becomes visible in the LIST without a reload (the command snapshot
    // carried no slice). `exact` avoids also matching the "Material recorded: …" success toast.
    await expect(page.getByText('E2E Module Material', { exact: true })).toBeVisible();
  });
});
