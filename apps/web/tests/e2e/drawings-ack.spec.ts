import { test, expect } from '@playwright/test';

test('contractor acknowledges building to the current revision (Drawings Slice 2)', async ({ page }) => {
  await page.goto('/');

  // become the contractor and open the Drawings register
  await page.getByRole('button', { name: 'Contractor', exact: true }).click();
  await page.getByRole('button', { name: 'Drawings' }).click();
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
  await page.getByRole('button', { name: 'PMC', exact: true }).click();
  await page.getByRole('button', { name: 'Site Schedule' }).click();
  // ACT-31 (Living Room Flooring) is governed by A-201
  await expect(page.getByTestId('sched-dwg-ACT-31')).toContainText('A-201');
});
