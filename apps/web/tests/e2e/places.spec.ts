import { test, expect } from '@playwright/test';

test('site map: browse the project by location — decisions and drawings on one coordinate', async ({ page }) => {
  await page.goto('/');

  // PMC (default persona) opens the Site Map
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();

  // the whole-project view is the root of the breadcrumb
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Whole project');

  // even before a location tree exists, the whole-project view lists what's filed
  // nowhere yet — the seeded decision register shows here (intent), one coordinate the
  // whole team reads from.
  await expect(page.getByTestId('place-decision-DL-014')).toBeVisible();
});
