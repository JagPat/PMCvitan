import { test, expect } from '@playwright/test';

/**
 * The mobile shell at a real iPhone viewport (390×844 — iPhone 14/15/16).
 *
 * Journeys: the active project is visible immediately (1) · site- and zone-level work is found
 * where it was filed, with no invented room (3, 4) · a nested place stays readable (5) · an
 * entity carries its location (6) · a locked item explains itself (7) · More holds the
 * secondary screens (8).
 */

test.use({ viewport: { width: 390, height: 844 } });

test('journey 1 + 8 — the project is named on the bar, and More holds the secondary screens', async ({ page }) => {
  await page.goto('/');

  // the active project is answered without navigating anywhere
  const project = page.getByTestId('mobile-project-switcher');
  await expect(project).toBeVisible();
  await expect(project).toContainText('Residence at Ambli');

  // the bar holds four destinations plus More — never thirteen compressed tabs
  const tabs = page.getByTestId('bottom-tabs');
  await expect(tabs).toBeVisible();
  for (const key of ['inbox', 'site-schedule', 'places', 'portfolio', 'more']) {
    await expect(page.getByTestId(`tab-${key}`)).toBeVisible();
  }
  // and the bar itself never overflows the viewport
  const box = await tabs.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);

  // More carries the rest, still permission-filtered
  await page.getByTestId('tab-more').click();
  await expect(page.getByTestId('more-sheet')).toBeVisible();
  await expect(page.getByTestId('more-item-decision-log')).toBeVisible();
  await expect(page.getByTestId('more-item-drawings')).toBeVisible();
  await page.getByTestId('more-item-decision-log').click();
  await expect(page.getByTestId('more-sheet')).toBeHidden();
  await expect(page.getByText('DECISION REGISTER')).toBeVisible();
});

test('journey 3 + 4 — zone-level work is found at the zone, with no pseudo-room in the path', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-places').click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();

  // Terrace is a top-level zone; the waterproofing activity is filed DIRECTLY on it
  await page.getByTestId('place-node-z-terrace').click();
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Terrace');
  await expect(page.getByTestId('place-activity-ACT-28')).toBeVisible();
  // nothing was invented to hold it: the zone has no child places at all
  await expect(page.getByTestId('place-node-r-living')).toBeHidden();
});

test('journey 5 — a nested place keeps a readable breadcrumb on a phone', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-places').click();
  await page.getByTestId('place-node-z-gf').click();
  await page.getByTestId('place-node-r-entrance').click();
  await page.getByTestId('place-node-e-maindoor').click();

  const crumb = page.getByTestId('place-breadcrumb');
  await expect(crumb).toContainText('Ground Floor');
  await expect(crumb).toContainText('Main Door');
  // it wraps within the viewport rather than scrolling the page sideways
  const box = await crumb.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('journey 6 — an activity on the Schedule shows where it belongs, and the crumb navigates there', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-site-schedule').click();

  const place = page.getByTestId('sched-place-ACT-33');
  await expect(place).toContainText('Ground Floor');
  await expect(place).toContainText('Main Door');

  // tapping the containing place opens the Site Map there
  await page.getByTestId('sched-place-ACT-33-crumb-1').click();
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Entrance');
});

test('journey 7 — an approved decision explains the lock and offers the permitted action', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByTestId('more-item-decision-log').click();

  // DL-009 is approved in the demo register
  const state = page.getByTestId('edit-state-DL-009');
  await expect(state).toBeVisible();
  await expect(state).toHaveAttribute('data-edit-state', 'locked');
  await expect(state).toContainText('Locked after approval');
  await page.getByTestId('request-change-DL-009').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
