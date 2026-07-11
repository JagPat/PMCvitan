import { test, expect } from '@playwright/test';

test('location drafts: a PMC builds a location privately, then publishes it live to the team', async ({ page }) => {
  await page.goto('/');

  // A seeded DRAFT location (Basement) must NOT appear on the shared Site Map yet.
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ground Floor' })).toBeVisible(); // published tree is there
  await expect(page.getByText('Basement', { exact: true })).toHaveCount(0); // the draft is hidden

  // The PMC opens the Locations editor from the Decision Log — the draft's private home.
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await page.getByTestId('manage-locations').click();

  // The Basement row shows a DRAFT chip and a Publish button; a published zone shows neither.
  await expect(page.getByTestId('loc-draft-z-basement')).toBeVisible();
  await expect(page.getByTestId('loc-draft-z-gf')).toHaveCount(0);

  // Publish the draft branch.
  await page.getByTestId('loc-publish-z-basement').click();
  await expect(page.getByTestId('loc-draft-z-basement')).toHaveCount(0); // no longer a draft
  await expect(page.getByTestId('loc-draft-r-cellar')).toHaveCount(0); // the room below came along

  // It is now on the shared Site Map for the whole team.
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByRole('button', { name: 'Basement' })).toBeVisible();
});
