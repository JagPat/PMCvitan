import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B4 — the copy and the withdraw rule over the REAL stack with the six reservation
 * doors STANDING: no row carries `countersignRequired` and no change request carries an origin, so the
 * client's approval confirmation reads the DELIVERED copy ("Will be locked", "Approve & Lock") and the
 * PMC's register offers Withdraw on the seeded standard change request exactly as before. The 4d arms
 * (the provisional copy, the withheld Withdraw) are exercised on planted rows by the unit tests; this
 * spec is the proof that B4 changed nothing a delivered role sees. Runs in every api-e2e mode.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `client@vitan.in` is the client of `ambli`; `test-pmc@vitan.in`
 * is a PMC on `ambli` too (home: project B). DL-003 is the seeded reopened decision (a standard request).
 */

const PASSWORD = 'vitan123';
const CLIENT = 'client@vitan.in';
const PMC = 'test-pmc@vitan.in';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test('with the doors standing, the client’s confirmation reads the delivered copy and is cancelled without approving', async ({ page }) => {
  await page.goto('/');
  await signIn(page, CLIENT);
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await page.getByRole('button', { name: 'Decisions Waiting' }).click();
  // the first option of the first pending card opens the confirmation; nothing is approved here
  const approve = page.locator('[data-testid^="approve-DL-"]').first();
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.getByTestId('approve-outcome')).toHaveText('Will be locked');
  await expect(page.getByTestId('approve-lock')).toHaveText('Approve & Lock');
  await expect(page.getByTestId('approve-explainer')).toHaveText('This decision will be recorded against your name, time-stamped, and locked. Any later change needs a formal Change Request.');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('approve-lock')).toHaveCount(0);
});

test('with the doors standing, the PMC’s register offers Withdraw on the seeded standard change request and names no origin', async ({ page }) => {
  await page.goto('/');
  await signIn(page, PMC);
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');
  // switch to ambli, where the seeded reopened decision lives (the project-scope spec's pattern)
  const optionA = page.getByRole('group', { name: 'Switch project' }).getByRole('button', { name: /Residence at Ambli/ });
  await expect(async () => {
    if (!(await optionA.isVisible())) await page.getByTestId('project-switcher').click();
    await optionA.click({ timeout: 2000 });
  }).toPass();
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await page.getByTestId('filter-change').click();
  const row = page.locator('[data-testid^="log-row-"]').first();
  await expect(row).toBeVisible();
  await expect(row.locator('[data-testid^="cr-detail-"]')).toContainText('Change requested:');
  await expect(row.locator('[data-testid^="cr-origin-"]')).toHaveCount(0);
  await expect(row.locator('[data-testid^="withdraw-DL-"]')).toBeVisible();
});
