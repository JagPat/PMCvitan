import { test, expect } from '@playwright/test';

test('site map: browse the project by location — decisions and drawings on one coordinate', async ({ page }) => {
  await page.goto('/');

  // PMC (default persona) opens the Site Map
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();

  // the whole-project view is the root of the breadcrumb
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Whole project');

  // the seeded location tree lets us walk the building — the whole-project view lists
  // the register (intent), one coordinate the whole team reads from.
  await expect(page.getByTestId('place-decision-DL-014')).toBeVisible();
});

test('site map: drill into an object shows intent (drawing) vs reality (photos) side by side', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Site Map' }).click();
  await expect(page.getByText('BY LOCATION')).toBeVisible();

  // walk Ground Floor › Entrance › Main Door
  await page.getByTestId('place-node-z-gf').click();
  await page.getByTestId('place-node-r-entrance').click();
  await page.getByTestId('place-node-e-maindoor').click();
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Main Door');

  // the Intent-vs-Reality band pairs the governing drawing with the site photo
  const band = page.getByTestId('intent-reality');
  await expect(band).toBeVisible();
  await expect(band.getByTestId('ir-drawing')).toContainText('SK-07'); // the drawing that governs it
  await expect(band.getByTestId('ir-photo')).toBeVisible(); // the reality of what's built

  // and the place's own work + decision are listed below
  await expect(page.getByTestId('place-activity-ACT-33')).toBeVisible();
  await expect(page.getByTestId('place-decision-DL-011')).toBeVisible();
});

test('site map on a desktop: the places tree sits beside the opened place, and a phone keeps one column', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Site Map' }).click();
  const tree = page.getByRole('navigation', { name: 'Places' });
  await expect(tree).toBeVisible();
  // a long tree scrolls inside its own column, never taller than the window
  await expect(tree).toHaveCSS('overflow-y', 'auto');
  expect((await tree.boundingBox())!.height).toBeLessThanOrEqual(800);

  // one click on a place in the tree opens it, and the tree marks it
  await page.getByTestId('site-map-tree-z-gf').click();
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Ground Floor');
  await expect(page.getByTestId('site-map-tree-z-gf')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('site-map-tree-r-entrance')).toBeVisible(); // its branch is open

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tree).toHaveCount(0); // not built on a phone
  await expect(page.getByTestId('place-breadcrumb')).toContainText('Ground Floor');
});
