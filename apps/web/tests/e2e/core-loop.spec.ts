import { test, expect } from '@playwright/test';

test('core loop: client approves & locks a decision → Decision Log → PMC dashboard count decrements', async ({ page }) => {
  await page.goto('/');

  // every role now lands on the "For You" action queue — switch to the Client
  // persona, then open their Decisions Waiting screen to drive the approval flow
  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await page.getByRole('button', { name: 'Decisions Waiting' }).click();
  await expect(page.getByText('Decisions waiting for you')).toBeVisible();

  // approve the architect's pick (Option B) on DL-014
  await page.getByTestId('approve-DL-014-B').click();

  // irreversible-step confirmation modal
  await expect(page.getByText('CONFIRM APPROVAL')).toBeVisible();
  await page.getByTestId('approve-lock').click();

  // toast confirms the lock
  await expect(page.getByText(/Approved & locked/)).toBeVisible();

  // open the Decision Log — DL-014 is now approved & locked
  await page.getByRole('button', { name: 'Decision Log' }).click();
  const row = page.getByTestId('log-row-DL-014');
  await expect(row).toContainText('APPROVED & LOCKED');
  await expect(page.getByTestId('lock-DL-014')).toBeVisible();

  // switch persona to PMC and open the Dashboard → the "Decisions pending" tile has decremented 2 → 1
  await page.getByRole('button', { name: 'PMC', exact: true }).click();
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.getByText('PROJECT DASHBOARD')).toBeVisible();
  await expect(page.getByTestId('tile-pending-value')).toHaveText('1');
});

test('offline-first: daily-log mutations queue while offline and flush on reconnect', async ({ page }) => {
  await page.goto('/');

  // become the engineer and open the Daily Site Log
  await page.getByRole('button', { name: 'Engineer', exact: true }).click();
  await page.getByRole('button', { name: 'Daily Site Log' }).click();
  await expect(page.getByTestId('conn-text')).toContainText('Online');

  // go offline, then check in and add a progress photo — both queue
  await page.getByTestId('toggle-online').click();
  await expect(page.getByTestId('conn-text')).toContainText('Offline');
  await page.getByTestId('check-in').click();
  await expect(page.getByTestId('conn-text')).toContainText('1 update queued');

  // back online flushes the queue
  await page.getByTestId('toggle-online').click();
  await expect(page.getByTestId('conn-text')).toContainText('Online · all synced');
  await expect(page.getByText(/synced to server/)).toBeVisible();
});
