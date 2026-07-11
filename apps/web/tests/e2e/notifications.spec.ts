import { test, expect } from '@playwright/test';

test('bell: tapping a notification jumps to the relevant screen', async ({ page }) => {
  await page.goto('/');

  // PMC (default) — open the notifications bell
  await page.getByRole('button', { name: 'Notifications' }).click();

  // the seeded "Client approved …" notice is about a decision → jumps to the Decision Log
  const first = page.getByTestId('notif-item').first();
  await expect(first).toBeVisible();
  await expect(first).toContainText('Client approved');
  await first.click();

  // navigated to the Decision Log (and the panel closed)
  await expect(page).toHaveURL(/\/decisions$/);
  await expect(page.getByTestId('notif-item')).toHaveCount(0);
});
