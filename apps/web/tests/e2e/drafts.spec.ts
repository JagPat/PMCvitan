import { test, expect } from '@playwright/test';

test('drafts: a private decision stays in the workspace until the PMC publishes it', async ({ page }) => {
  await page.goto('/');

  // PMC (default) opens the private Drafts workspace — the seeded work-in-progress is there
  await page.getByRole('button', { name: 'Drafts' }).click();
  await expect(page.getByTestId('draft-DL-015')).toBeVisible();
  await expect(page.getByTestId('draft-DL-015')).toContainText('Living Room Feature Wall');

  // it is NOT on the shared Decision Log yet (still private)
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page.getByTestId('log-row-DL-015')).toHaveCount(0);

  // publish it from the workspace → it leaves Drafts…
  await page.getByRole('button', { name: 'Drafts' }).click();
  await page.getByTestId('publish-DL-015').click();
  await expect(page.getByTestId('draft-DL-015')).toHaveCount(0);

  // …and now appears on the Decision Log for the team
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page.getByTestId('log-row-DL-015')).toBeVisible();
});

test('drafts: the client never sees an unpublished draft (no Drafts screen, absent from their log)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Client', exact: true }).click();

  // the client has no Drafts workspace at all
  await expect(page.getByRole('button', { name: 'Drafts' })).toHaveCount(0);

  // and the draft is absent from their Decision Log — while published decisions show
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page.getByTestId('log-row-DL-015')).toHaveCount(0);
  await expect(page.getByTestId('log-row-DL-014')).toBeVisible();
});
