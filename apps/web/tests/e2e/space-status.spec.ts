import { test, expect } from '@playwright/test';

/** B8 — the Site Map says where each space stands; the Schedule can be narrowed to one place. */

test('Site Map cards carry each space’s derived state, phase and counts', async ({ page }) => {
  await page.goto('/projects/ambli/places');
  await expect(page.getByTestId('place-status-z-gf')).toHaveAttribute('data-state', 'not-started');
  await expect(page.getByTestId('place-status-z-gf')).toContainText('Finishing · 0/2 done');
  await expect(page.getByTestId('place-status-z-terrace')).toHaveAttribute('data-state', 'blocked');
  await expect(page.getByTestId('place-status-z-terrace')).toContainText('1 blocked');
  await expect(page.getByTestId('place-status-z-sf')).toHaveAttribute('data-state', 'done');
  // nothing placed in the (draft) basement: no status line rather than an invented one
  await expect(page.getByTestId('place-status-z-basement')).toHaveCount(0);
});

test('the Schedule filters to one place and everything inside it', async ({ page }) => {
  await page.goto('/projects/ambli/schedule');
  await expect(page.getByTestId('sched-ACT-28')).toBeVisible();
  await page.getByLabel('PLACE').selectOption('z-gf');
  await expect(page.getByTestId('sched-place-count')).toHaveText('2 activities at Ground Floor and inside it');
  await expect(page.getByTestId('sched-ACT-31')).toBeVisible();
  await expect(page.getByTestId('sched-ACT-33')).toBeVisible(); // an object two levels down
  await expect(page.getByTestId('sched-ACT-28')).toHaveCount(0); // terrace work is hidden

  // a published room with no work placed (draft places such as the Basement are not offered)
  await expect(page.getByLabel('PLACE').locator('option[value="z-basement"]')).toHaveCount(0);
  await page.getByLabel('PLACE').selectOption('r-kitchen');
  await expect(page.getByTestId('sched-place-empty')).toHaveText('No activities are placed at Kitchen yet.');

  await page.getByLabel('PLACE').selectOption('');
  await expect(page.getByTestId('sched-ACT-28')).toBeVisible();
});
