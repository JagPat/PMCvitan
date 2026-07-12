import { test, expect } from '@playwright/test';

test('the URL is project-scoped: root redirects, and navigating carries the project id', async ({ page }) => {
  await page.goto('/');
  // root resolves to the active project's home ("For You")
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);

  // navigating to a screen keeps the project in the path
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
  await expect(page.getByText('Decision Register')).toBeVisible();
});

test('a project-scoped deep link restores that screen on load (refresh restoration)', async ({ page }) => {
  // load straight into a scoped URL — the app should open on that screen, not the default
  await page.goto('/projects/ambli/decisions');
  await expect(page.getByText('Decision Register')).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
});

test('a legacy bare path is redirected under the active project', async ({ page }) => {
  await page.goto('/decisions');
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);
  await expect(page.getByText('Decision Register')).toBeVisible();
});
