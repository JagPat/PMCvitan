import { test, expect } from '@playwright/test';

/**
 * B6 — a place, a drawing and a register entry each have their own URL: it survives a reload,
 * can be shared, and Back/Forward walk what was opened. Demo mode, no sign-in, nothing written.
 */

test('the Site Map place is in the URL: reload restores it and Back walks out', async ({ page }) => {
  await page.goto('/projects/ambli/places');
  await page.getByTestId('place-node-z-gf').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/places\/z-gf$/);
  await page.getByTestId('place-node-r-entrance').click();
  await expect(page).toHaveURL(/\/places\/r-entrance$/);
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Entrance');

  await page.reload();
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Entrance');

  await page.goBack();
  await expect(page).toHaveURL(/\/places\/z-gf$/);
  await expect(page.getByTestId('place-breadcrumb')).not.toContainText('Entrance');
  await page.goBack();
  await expect(page).toHaveURL(/\/places$/);
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Whole project');

  await page.goForward();
  await expect(page).toHaveURL(/\/places\/z-gf$/);
});

test('a shared place link opens at that place', async ({ page }) => {
  await page.goto('/projects/ambli/places/e-maindoor');
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Main Door');
});

test('the schedule opens the governing drawing itself, and Back closes it', async ({ page }) => {
  await page.goto('/projects/ambli/schedule');
  await page.getByTestId('sched-dwg-ACT-31').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings\/DWG-1$/);
  await expect(page.getByText(/BUILDING TO REV C/)).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/schedule$/);
});

test('a drawing link opens the viewer; closing it returns to the register URL', async ({ page }) => {
  await page.goto('/projects/ambli/drawings/DWG-1');
  await expect(page.getByText(/BUILDING TO REV C/)).toBeVisible();
  await page.getByRole('dialog', { name: /A-201/ }).getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings$/);
  await expect(page.getByText(/BUILDING TO REV C/)).toHaveCount(0);
});

test('a Decision Log link marks that entry, and its id is a copyable link', async ({ page }) => {
  await page.goto('/projects/ambli/decisions/DL-011');
  await expect(page.getByTestId('log-row-DL-011')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('log-row-DL-014')).not.toHaveAttribute('aria-current', 'true');

  await page.getByTestId('log-link-DL-014').click();
  await expect(page).toHaveURL(/\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('log-link-DL-014')).toHaveAttribute('href', '/projects/ambli/decisions/DL-014');
});

test('a modified click on a Decision Log link keeps the browser’s new-tab behaviour', async ({ page, context }) => {
  await page.goto('/projects/ambli/decisions');
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId('log-link-DL-014').click({ modifiers: ['ControlOrMeta'] }),
  ]);
  // a new tab opens at about:blank before it navigates, so wait on the URL itself (retrying), not on
  // a load state that about:blank already satisfies (the race CI hit on 6e8082b)
  await expect(popup).toHaveURL(/\/projects\/ambli\/decisions\/DL-014$/);
  // the original tab did not navigate in-app
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
});

test('an unknown drawing says it is not available, and "Show all drawings" opens the register', async ({ page }) => {
  // live bug 1c — a push or shared link naming a drawing the register does not hold says so, rather than
  // silently showing the register as though that were the drawing
  await page.goto('/projects/ambli/drawings/NOPE');
  await expect(page.getByTestId('item-not-found')).toContainText("Drawing NOPE isn't available");
  await expect(page.getByText(/BUILDING TO REV C/)).toHaveCount(0);
  await page.getByTestId('item-not-found-show-all').click();
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings$/);
  await expect(page.getByTestId('item-not-found')).toHaveCount(0);
});

test('a drawing opened from a notification link survives a reload, and Back returns to where the viewer was', async ({ page }) => {
  // live bug 1c — the service worker takes the open window to the push's path (a history entry); in the app
  // that is an ordinary navigation to the drawing's URL
  await page.goto('/projects/ambli/for-you');
  await page.evaluate(() => { window.location.assign('/projects/ambli/drawings/DWG-1'); });
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings\/DWG-1$/);
  await expect(page.getByText(/BUILDING TO REV C/)).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings\/DWG-1$/);
  await expect(page.getByText(/BUILDING TO REV C/)).toBeVisible();

  // a full navigation is a cold record link, so (as for every record link, #728's RouteBridge) the register
  // sits underneath it: Back closes the drawing to the register, and Back again returns to where the viewer was
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings$/);
  await expect(page.getByText(/BUILDING TO REV C/)).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/projects\/ambli\/drawings$/);
});
