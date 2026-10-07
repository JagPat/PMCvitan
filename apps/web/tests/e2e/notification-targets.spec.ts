import { test, expect, type Page } from '@playwright/test';

/**
 * Live bug 1 — deep-link target fidelity. A notification opens the RECORD it is about, at a URL that
 * survives a reload and walks back with Back; a link to a record that is not there says so. The two
 * notices are the owner's live repros, carried by the demo seed:
 * - 1a: "New decision issued for approval: Living Room Flooring" must open DL-014 itself;
 * - 1b: "Re-inspection due: Waterproofing, Terrace" names a re-inspection by its work and zone but no id,
 *   and the seed holds no such task (only "Waterproofing Ponding Test", which merely contains the work):
 *   the bell must say the record isn't available and offer Inspection Review — never open a near-titled
 *   inspection in its place (Codex 4203960929), and never drop the viewer on the list as the answer.
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

test('"Re-inspection due: Waterproofing, Terrace" says its record is not available, and offers Inspection Review', async ({ page }) => {
  await page.goto('/projects/ambli/for-you');
  await tapNotice(page, 'Re-inspection due: Waterproofing, Terrace');
  // explained in place: nothing navigated, and no near-titled inspection opened in its stead
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await expect(page.getByTestId('notif-missing')).toContainText("isn't available");
  await page.getByTestId('notif-missing-open').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
});

test('a link that STARTS the tab opens its inspection, survives reload, and Back goes to the inspection list', async ({ page }) => {
  // owner live check (#482 6039737806) — a record with nothing behind it must not make Back a dead end
  await page.goto('/projects/ambli/review/INSP-21');
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
});

test('a link to an inspection that is not there says so ALONE — never an unrelated, actionable review', async ({ page }) => {
  await page.goto('/projects/ambli/review/INSP-999');
  await expect(page.getByTestId('item-not-found')).toContainText('INSP-999');
  // Codex 4203544331 — the default review (INSP-21) and its approve/reject are not shown under it
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toHaveCount(0);
  await page.getByTestId('item-not-found-show-all').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
});

test('an outstanding checklist link brings that checklist into view', async ({ page }) => {
  await page.goto('/projects/ambli/review/INSP-22');
  await expect(page.getByTestId('outstanding-checklist-INSP-22')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
});

test("the engineer's field checklist opens the checklist a link names, and says when it cannot", async ({ page }) => {
  // the demo persona resets on a reload, so the engineer is reached by the role picker and the link is
  // followed in-app, as a notification tap does
  await page.goto('/');
  await page.getByRole('button', { name: 'Engineer', exact: true }).click();
  const follow = (path: string) => page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await follow('/projects/ambli/site/checklist/INSP-22');
  await expect(page.getByTestId('checklist-title')).toHaveText('Pre-Tiling Inspection');
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
  await follow('/projects/ambli/site/checklist/INSP-404');
  await expect(page.getByTestId('item-not-found')).toContainText('INSP-404');
  await expect(page.getByTestId('checklist-title')).toHaveCount(0);
  await page.getByTestId('item-not-found-show-all').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/site\/checklist$/);
  await expect(page.getByTestId('checklist-title')).toHaveText('Pre-Tiling Inspection');
});

// Owner live check (#482 6039737806) — history is proven through the app's OWN actions: the test taps the
// notification and the screen's controls, and never builds the history it then asserts.
test('a decision notification pushes history: Back returns to the screen it was tapped on, Forward to the record', async ({ page }) => {
  await page.goto('/projects/ambli/for-you');
  await tapNotice(page, 'Living Room Flooring');
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
});

test('a decision notification tapped on the register: Back returns to the register, its search intact', async ({ page }) => {
  await page.goto('/projects/ambli/decisions');
  await page.getByTestId('decision-search').fill('Living');
  await tapNotice(page, 'Living Room Flooring');
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
  await expect(page.getByTestId('decision-search')).toHaveValue('Living');
});

test('a decision link that STARTS the tab: Back goes to the register, not out of the app', async ({ page }) => {
  await page.goto('/projects/ambli/decisions/DL-014');
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await page.reload();
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
  await expect(page.locator('[data-testid^="log-row-"]').first()).toBeVisible();
});

test('an inspection notification pushes history: its "Open Inspection Review" lands there and Back returns', async ({ page }) => {
  await page.goto('/projects/ambli/for-you');
  await tapNotice(page, 'Re-inspection due: Waterproofing, Terrace');
  await page.getByTestId('notif-missing-open').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
  await expect(page.getByText('Waterproofing Ponding Test', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/projects\/ambli\/review$/);
});
