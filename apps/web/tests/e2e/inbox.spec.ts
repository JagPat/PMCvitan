import { test, expect } from '@playwright/test';

test('For You: the client lands on their action queue and a card jumps straight to the decisions', async ({ page }) => {
  await page.goto('/');

  // switch to the Client persona — every role now lands on the "For You" home,
  // scoped to (and naming) the active project
  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await expect(page.getByText(/Everything waiting on you in/)).toBeVisible();

  // their pending-decisions action is listed, with a one-tap CTA
  const card = page.getByTestId('inbox-item-client-pending');
  await expect(card).toBeVisible();
  await expect(card).toContainText('awaiting your approval');

  // the CTA takes them straight to the Decisions Waiting screen
  await page.getByTestId('inbox-cta-client-pending').click();
  await expect(page.getByText('Decisions waiting for you')).toBeVisible();
});

test('For You: acting on everything empties the queue (the item disappears once done)', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await page.getByTestId('inbox-cta-client-pending').click();

  // approve & lock both seeded pending decisions
  for (const opt of ['approve-DL-014-B', 'approve-DL-011-A']) {
    await page.getByTestId(opt).click();
    await page.getByTestId('approve-lock').click();
    await expect(page.getByText(/Approved & locked/)).toBeVisible();
  }

  // back on For You: the seeded reopened decision (DL-003) still needs the client —
  // mandatory re-approval IS their work now (Phase 1 Task 2)
  await page.getByRole('button', { name: 'For You' }).click();
  const reapprove = page.getByTestId('inbox-item-client-reapprove');
  await expect(reapprove).toBeVisible();
  await expect(reapprove).toContainText('re-approval');

  // its CTA lands on Decisions Waiting, where the change-request context is shown…
  await page.getByTestId('inbox-cta-client-reapprove').click();
  await expect(page.getByText('Needs your re-approval')).toBeVisible();
  await expect(page.getByTestId('cr-context-DL-003')).toContainText('Change requested');

  // …and re-approving closes the reopening
  await page.getByTestId('approve-DL-003-A').click();
  await page.getByTestId('approve-lock').click();
  await expect(page.getByText(/Approved & locked/)).toBeVisible();

  // NOW the client is all caught up
  await page.getByRole('button', { name: 'For You' }).click();
  await expect(page.getByTestId('inbox-empty')).toBeVisible();
  await expect(page.getByText('Nothing needs you right now')).toBeVisible();
});
