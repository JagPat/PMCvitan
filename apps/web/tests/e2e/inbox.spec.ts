import { test, expect } from '@playwright/test';

test('For You: the client lands on their action queue and a card jumps straight to the decisions', async ({ page }) => {
  await page.goto('/');

  // switch to the Client persona — every role now lands on the "For You" home
  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await expect(page.getByText('need you')).toBeVisible();

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

  // back on For You: the client is all caught up
  await page.getByRole('button', { name: 'For You' }).click();
  await expect(page.getByTestId('inbox-empty')).toBeVisible();
  await expect(page.getByText('Nothing needs you right now')).toBeVisible();
});
