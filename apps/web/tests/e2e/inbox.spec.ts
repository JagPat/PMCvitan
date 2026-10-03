import { test, expect } from '@playwright/test';

// U2a — the client's home is their project's Pulse: the decisions waiting on them are its
// "one thing needs you" (a reopened one first), so it replaces their old approval cards.
test("For You: the client lands on their project's Pulse, and its waiting decision jumps straight to the decisions", async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await expect(page.getByTestId('client-pulse')).toBeVisible();
  await expect(page.getByTestId('pulse-progress')).toBeVisible();

  // three decisions wait on the seeded client; the reopened DL-003 comes first
  const needs = page.getByTestId('pulse-needs');
  await expect(needs).toContainText('3 things need you');
  await expect(needs).toHaveAttribute('data-decision', 'DL-003');
  await expect(needs).toContainText('Reopened by a change request');

  await page.getByTestId('pulse-needs-go').click();
  await expect(page.getByText('Decisions waiting for you')).toBeVisible();
});

test('For You: acting on everything empties the Pulse (the waiting decision disappears once done)', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await page.getByTestId('pulse-needs-go').click();

  // approve & lock both seeded pending decisions
  for (const opt of ['approve-DL-014-B', 'approve-DL-011-A']) {
    await page.getByTestId(opt).click();
    await page.getByTestId('approve-lock').click();
    await expect(page.getByText(/Approved & locked/)).toBeVisible();
  }

  // back on For You: the seeded reopened decision (DL-003) still needs the client —
  // mandatory re-approval IS their work now (Phase 1 Task 2)
  await page.getByRole('button', { name: 'For You' }).click();
  const needs = page.getByTestId('pulse-needs');
  await expect(needs).toHaveAttribute('data-decision', 'DL-003');
  await expect(needs).toContainText('One thing needs you');

  // its way in lands on Decisions Waiting, where the change-request context is shown…
  await page.getByTestId('pulse-needs-go').click();
  await expect(page.getByText('Needs your re-approval')).toBeVisible();
  await expect(page.getByTestId('cr-context-DL-003')).toContainText('Change requested');

  // …and re-approving closes the reopening
  await page.getByTestId('approve-DL-003-A').click();
  await page.getByTestId('approve-lock').click();
  await expect(page.getByText(/Approved & locked/)).toBeVisible();

  // NOW nothing waits on the client
  await page.getByRole('button', { name: 'For You' }).click();
  await expect(page.getByTestId('pulse-nothing')).toBeVisible();
  await expect(page.getByText('Nothing needs you right now')).toBeVisible();
  await expect(page.getByTestId('pulse-needs')).toHaveCount(0);
});
