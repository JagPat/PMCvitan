import { test, expect } from '@playwright/test';

test('consultant: the Drawings register defaults to their discipline, with an all-disciplines escape', async ({ page }) => {
  await page.goto('/');

  // become a consultant (the demo persona maps to a representative discipline → structural)
  await page.getByRole('button', { name: 'Consultant', exact: true }).click();
  await page.getByRole('button', { name: 'Drawings' }).click();

  // scoped by default: the structural sheet shows, the architectural one is hidden
  await expect(page.getByTestId('scope-mine')).toBeVisible();
  await expect(page.getByTestId('drawing-S-101')).toBeVisible();
  await expect(page.getByTestId('drawing-A-201')).toHaveCount(0);

  // one tap to see the whole register
  await page.getByTestId('scope-all').click();
  await expect(page.getByTestId('drawing-A-201')).toBeVisible();
  await expect(page.getByTestId('drawing-S-101')).toBeVisible();
});
