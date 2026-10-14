import { test, expect } from '@playwright/test';
import { openNav } from './fixtures/nav';

test('contractor acknowledges building to the current revision (Drawings Slice 2)', async ({ page }) => {
  await page.goto('/');

  // become the contractor and open the Drawings register
  await page.getByRole('button', { name: 'Contractor', exact: true }).click();
  await openNav(page, /^Drawings( \d+)?$/);
  await expect(page.getByText('DRAWINGS · REGISTER')).toBeVisible();

  // open A-201 (Living Room Flooring Layout)
  await page.getByTestId('drawing-A-201').click();
  await expect(page.getByText(/BUILDING TO REV C/)).toBeVisible();

  // acknowledge building to it → confirmation replaces the button
  await page.getByTestId('ack-drawing').click();
  await expect(page.getByText(/You’re building to Rev C/)).toBeVisible();
});

test('the schedule links each activity to the drawing it builds from', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Project manager (PMC)', exact: true }).click();
  await openNav(page, /^Site Schedule( \d+)?$/);
  // ACT-31 (Living Room Flooring) is governed by A-201
  await expect(page.getByTestId('sched-dwg-ACT-31')).toContainText('A-201');
});
