import { test, expect } from '@playwright/test';
import { navButton, openNav } from './fixtures/nav';

test('drafts: a drawing draft stays private until published, then enters the register', async ({ page }) => {
  await page.goto('/');

  // PMC opens the Drafts workspace — the seeded draft drawing is there (under Drawings)
  await openNav(page, /^Drafts( \d+)?$/);
  await expect(page.getByTestId('draft-DWG-4')).toBeVisible();
  await expect(page.getByTestId('draft-DWG-4')).toContainText('A-305');

  // it is NOT in the shared Drawings register yet
  await openNav(page, /^Drawings( \d+)?$/);
  await expect(page.getByText('DRAWINGS · REGISTER')).toBeVisible();
  await expect(page.getByTestId('drawing-A-305')).toHaveCount(0);

  // publish it from the workspace → it leaves Drafts…
  await openNav(page, /^Drafts( \d+)?$/);
  await page.getByTestId('publish-DWG-4').click();
  await expect(page.getByTestId('draft-DWG-4')).toHaveCount(0);

  // …and now appears in the register for the build team
  await openNav(page, /^Drawings( \d+)?$/);
  await expect(page.getByTestId('drawing-A-305')).toBeVisible();
});

test('drafts: "Publish all" issues every draft at once', async ({ page }) => {
  await page.goto('/');

  await openNav(page, /^Drafts( \d+)?$/);
  // both a draft decision and a draft drawing are seeded
  await expect(page.getByTestId('draft-DL-015')).toBeVisible();
  await expect(page.getByTestId('draft-DWG-4')).toBeVisible();

  // one click publishes the whole workspace
  await page.getByTestId('publish-all').click();
  await expect(page.getByTestId('draft-DL-015')).toHaveCount(0);
  await expect(page.getByTestId('draft-DWG-4')).toHaveCount(0);
  await expect(page.getByText('No drafts yet')).toBeVisible();
});

test('drafts: a private decision stays in the workspace until the PMC publishes it', async ({ page }) => {
  await page.goto('/');

  // PMC (default) opens the private Drafts workspace — the seeded work-in-progress is there
  await openNav(page, /^Drafts( \d+)?$/);
  await expect(page.getByTestId('draft-DL-015')).toBeVisible();
  await expect(page.getByTestId('draft-DL-015')).toContainText('Living Room Feature Wall');

  // it is NOT on the shared Decision Log yet (still private)
  await openNav(page, /^Decision Log( \d+)?$/);
  await expect(page.getByTestId('log-row-DL-015')).toHaveCount(0);

  // publish it from the workspace → it leaves Drafts…
  await openNav(page, /^Drafts( \d+)?$/);
  await page.getByTestId('publish-DL-015').click();
  await expect(page.getByTestId('draft-DL-015')).toHaveCount(0);

  // …and now appears on the Decision Log for the team
  await openNav(page, /^Decision Log( \d+)?$/);
  await expect(page.getByTestId('log-row-DL-015')).toBeVisible();
});

test('drafts: the client never sees an unpublished draft (no Drafts screen, absent from their log)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Client', exact: true }).click();

  // the client has no Drafts workspace at all
  await expect(await navButton(page, /^Drafts( \d+)?$/)).toHaveCount(0);

  // and the draft is absent from their Decisions history — while published decisions show
  await openNav(page, /^Decisions( \d+)?$/);
  await expect(page.getByTestId('log-row-DL-015')).toHaveCount(0);
  await expect(page.getByTestId('approve-DL-015-A')).toHaveCount(0);
  // DL-014 waits on the client, so it is listed above the history; an approved one is in the history
  await expect(page.getByTestId('approve-DL-014-B')).toBeVisible();
  await expect(page.getByTestId('log-row-DL-009')).toBeVisible();
});
