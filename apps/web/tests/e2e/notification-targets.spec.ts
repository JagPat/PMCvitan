import { test, expect, type Page } from '@playwright/test';

/**
 * Live bug 1 — deep-link target fidelity. A notification opens the RECORD it is about, at a URL that
 * survives a reload and walks back with Back; a link to a record that is not there says so. The two
 * notices are the owner's live repros, carried by the demo seed: "New decision issued for approval:
 * Living Room Flooring" must open DL-014 itself, and "Re-inspection due: Waterproofing, Terrace" must
 * open the Terrace waterproofing inspection rather than a review screen that never shows it.
 * Demo mode, no sign-in, nothing written.
 */

async function tapNotice(page: Page, text: string) {
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByTestId('notif-item').filter({ hasText: text }).click();
}

test('"Living Room Flooring" opens DL-014 itself; reload keeps it and Back returns', async ({ page }) => {
  await page.goto('/projects/ambli/for-you');
  await tapNotice(page, 'Living Room Flooring');

  await expect(page).toHaveURL(/\/projects\/ambli\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('log-row-DL-014')).toBeInViewport();

  await page.reload();
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');

  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
});

test('"Re-inspection due: Waterproofing, Terrace" opens the Terrace waterproofing inspection, reload-safe', async ({ page }) => {
  await page.goto('/projects/ambli/for-you');
  await tapNotice(page, 'Re-inspection due: Waterproofing, Terrace');

  await expect(page).toHaveURL(/\/projects\/ambli\/review\/INSP-21$/);
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
});

test('a link to a decision that is not there says so, and offers the register', async ({ page }) => {
  await page.goto('/projects/ambli/decisions/DL-999');
  await expect(page.getByTestId('item-not-found')).toContainText('DL-999');
  await page.getByTestId('item-not-found-show-all').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
});

test('a link to an inspection that is not there says so, and offers the review screen', async ({ page }) => {
  await page.goto('/projects/ambli/review/INSP-999');
  await expect(page.getByTestId('item-not-found')).toContainText('INSP-999');
  await page.getByTestId('item-not-found-show-all').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
});

test('an outstanding checklist link brings that checklist into view', async ({ page }) => {
  await page.goto('/projects/ambli/review/INSP-22');
  await expect(page.getByTestId('outstanding-checklist-INSP-22')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
});
