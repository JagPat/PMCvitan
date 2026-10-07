import { test, expect, type Page } from '@playwright/test';

/**
 * Live bug 1a — deep-link target fidelity for decisions. A decision notification opens the DECISION it
 * is about, at a URL that survives a reload and walks back with Back; a link to a decision that is not
 * there says so. The notice is the owner's live repro, carried by the demo seed: "New decision issued
 * for approval: Living Room Flooring" must open DL-014 itself, never the register.
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

test('a link to a decision that is not there says so ALONE, and offers the register', async ({ page }) => {
  await page.goto('/projects/ambli/decisions/DL-999');
  await expect(page.getByTestId('item-not-found')).toContainText('DL-999');
  // Codex 4203544331 — the register is not rendered beneath it as if it were the answer
  await expect(page.locator('[data-testid^="log-row-"]')).toHaveCount(0);
  await page.getByTestId('item-not-found-show-all').click();
  await expect(page.locator('[data-testid^="log-row-"]').first()).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
});

test('a notice opened while the register is filtered clears the filters and shows its decision', async ({ page }) => {
  // Codex 4203544317 — the register stays mounted, so its own filters must not hide the record
  await page.goto('/projects/ambli/decisions');
  await page.getByTestId('filter-approved').click();
  await page.getByTestId('decision-search').fill('Kitchen');
  await expect(page.getByTestId('log-row-DL-014')).toHaveCount(0);
  await tapNotice(page, 'Living Room Flooring');
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('decision-search')).toHaveValue('');
});

test("clicking a visible row's link keeps the viewer's search", async ({ page }) => {
  await page.goto('/projects/ambli/decisions');
  await page.getByTestId('decision-search').fill('Flooring');
  await page.getByTestId('log-link-DL-014').click();
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await expect(page.getByTestId('decision-search')).toHaveValue('Flooring');
});
