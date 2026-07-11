import { test, expect } from '@playwright/test';

test('site map: inspections are surfaced at their location for the PMC', async ({ page }) => {
  await page.goto('/');

  // PMC (default) opens the Site Map — the whole-project view lists the placed inspections
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();
  await expect(page.getByTestId('place-inspection-INSP-21')).toBeVisible();
  await expect(page.getByTestId('place-inspection-INSP-21')).toContainText('Waterproofing Ponding Test');

  // and they scope by place: drill into the Terrace and the terrace inspection is still there
  await page.getByTestId('place-node-z-terrace').click();
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Terrace');
  await expect(page.getByTestId('place-inspection-INSP-21')).toBeVisible();
});

test('site map: inspections are hidden from the client (AUTH-02 boundary)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Client', exact: true }).click();

  // the client can browse the Site Map, but the Inspections section never renders for them
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();
  await expect(page.getByTestId('place-inspection-INSP-21')).toHaveCount(0);
  await expect(page.getByText('quality checks here')).toHaveCount(0);
});
