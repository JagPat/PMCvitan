import { test, expect, type Page } from '@playwright/test';

/**
 * Live bug 1 — owner live check (#482 6039737806): on the deployed app, Back after opening a record from
 * a notification must return to the screen it was tapped on. Proven here over the REAL stack (signed-in
 * PMC, the seeded Ambli notices), by tapping the notification itself — the test never builds the history
 * it asserts. Runs in every api-e2e read mode.
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

async function openAmbli(page: Page): Promise<void> {
  // the PMC's home is the empty project B; Ambli holds the seeded notices
  const optionA = page.getByRole('group', { name: 'Switch project' }).getByRole('button', { name: /Residence at Ambli/ });
  await expect(async () => {
    if (!(await optionA.isVisible())) await page.getByTestId('project-switcher').click();
    await optionA.click({ timeout: 2000 });
  }).toPass();
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
}

async function tapNotice(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByTestId('notif-item').filter({ hasText: text }).click();
}

test('a notification opens its record, and Back and Forward walk the history the tap made', async ({ page }) => {
  await page.goto('/');
  await signIn(page, PMC);
  await openAmbli(page);
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);

  // decision
  await tapNotice(page, 'Living Room Flooring');
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');

  // inspection: the seeded notice names no inspection id, so it opens Inspection Review itself
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await tapNotice(page, 'Re-inspection due: Waterproofing, Terrace');
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
});
