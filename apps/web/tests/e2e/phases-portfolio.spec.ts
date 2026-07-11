import { test, expect } from '@playwright/test';

test('schedule groups activities by phase; portfolio shows a project card (Orgs Slice 3)', async ({ page }) => {
  await page.goto('/');

  // become the PMC (dev-auth persona switch in the local demo) and open the Dashboard
  // (every role now lands on the "For You" action queue first)
  await page.getByRole('button', { name: 'PMC', exact: true }).click();
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByText('PROJECT DASHBOARD')).toBeVisible();

  // Site Schedule now groups under phase headers with a rollup
  await page.getByRole('button', { name: 'Site Schedule' }).click();
  await expect(page.getByText('Services & Waterproofing')).toBeVisible();
  await expect(page.getByText('Finishing', { exact: true })).toBeVisible();
  // the seeded services phase is 1/2 done
  await expect(page.getByText('1/2 done · 50%')).toBeVisible();
  // its activities still render
  await expect(page.getByTestId('sched-ACT-22')).toBeVisible();

  // Portfolio: a monitoring card for the active project
  await page.getByRole('button', { name: 'Portfolio' }).click();
  await expect(page.getByText('Every project at a glance')).toBeVisible();
  await expect(page.getByTestId('portfolio-ambli')).toBeVisible();
  await expect(page.getByTestId('portfolio-ambli')).toContainText('activities done');
});
