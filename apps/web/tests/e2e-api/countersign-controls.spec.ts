import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B5b — the countersign chain's affordances over the REAL stack with the six reservation
 * doors STANDING (P29c's "no Forward renders" arm; the web arms of P30 / P33 / P34): the shell reads
 * `rollout.phase6_4d = 'reserved'`, so the PMC's register offers NO Forward on any open row, and — no row can be
 * awaiting — none of the architect's countersign controls and none of the stranded resolution render. The
 * controls are exercised on planted rows by the unit tests; this spec is the proof that B5b changed nothing a
 * delivered role sees. Runs in every api-e2e mode.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `test-pmc@vitan.in` is a PMC on `ambli` (home: project B).
 */

const PASSWORD = 'vitan123';
const PMC = 'test-pmc@vitan.in';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test('with the doors standing, the PMC’s register renders no Forward, no countersign control and no stranded resolution on any row', async ({ page }) => {
  await page.goto('/');
  await signIn(page, PMC);
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');
  const optionA = page.getByRole('button', { name: /Residence at Ambli/ });
  await expect(async () => {
    if (!(await optionA.isVisible())) await page.getByTestId('project-switcher').click();
    await optionA.click({ timeout: 2000 });
  }).toPass();
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await page.getByRole('button', { name: 'Decision Log' }).click();

  const rows = page.locator('[data-testid^="log-row-"]');
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  expect(n).toBeGreaterThan(2); // the seeded pending, reopened and approved rows are all on screen
  // the open rows are here (the seeded pending decision) — and carry no Forward while the shell reads reserved
  await expect(page.getByTestId('log-row-DL-014')).toBeVisible();
  await expect(page.locator('[data-testid^="chain-controls-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="forward-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="countersign-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="reject-back-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="stranded-"]')).toHaveCount(0);
  // …while the delivered affordances on the same rows are untouched
  await expect(page.getByTestId('withdraw-decision-DL-014')).toBeVisible();
});
