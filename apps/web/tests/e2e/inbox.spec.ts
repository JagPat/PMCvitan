import { test, expect } from '@playwright/test';

// U2a — the client's home is their project's Pulse: the decisions waiting on them are its
// "one thing needs you" (a reopened one first), so it replaces their old approval cards.
// U2b — its way in opens that ONE decision on its own screen: pick one, then approve.
test("For You: the client lands on their project's Pulse, and its waiting decision opens on its own screen", async ({ page }) => {
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
  const focus = page.getByTestId('decision-focus');
  await expect(focus).toHaveAttribute('data-decision', 'DL-003');
  await expect(page.getByTestId('cr-context-DL-003')).toContainText('Change requested');
  // nothing is chosen for the client: approve waits for a pick
  await expect(page.getByTestId('decision-focus-approve')).toBeDisabled();
  await page.getByTestId('decision-option-DL-003-A').click();
  await expect(page.getByTestId('decision-option-DL-003-A')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('decision-focus-approve')).toBeEnabled();

  // back to the list of everything waiting
  await page.getByTestId('decision-focus-back').click();
  await expect(page.getByText('Decisions waiting for you')).toBeVisible();
});

test('For You: acting on everything empties the Pulse (each decision disappears once done)', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Client', exact: true }).click();
  await page.getByTestId('pulse-needs-go').click();

  // the reopened DL-003 on its own screen: re-approving closes the reopening (Phase 1 Task 2)
  await expect(page.getByTestId('decision-focus')).toHaveAttribute('data-decision', 'DL-003');
  await page.getByTestId('decision-option-DL-003-A').click();
  await page.getByTestId('decision-focus-approve').click();
  await page.getByTestId('approve-lock').click(); // the same confirmation as the list
  await expect(page.getByText(/Approved & locked/)).toBeVisible();

  // once it is done the screen lets go of it: the list shows what is left
  await expect(page.getByText('Decisions waiting for you')).toBeVisible();
  for (const opt of ['approve-DL-014-B', 'approve-DL-011-A']) {
    await page.getByTestId(opt).click();
    await page.getByTestId('approve-lock').click();
    await expect(page.getByText(/Approved & locked/)).toBeVisible();
  }

  // NOW nothing waits on the client
  await page.getByRole('button', { name: 'For You' }).click();
  await expect(page.getByTestId('pulse-nothing')).toBeVisible();
  await expect(page.getByText('Nothing needs you right now')).toBeVisible();
  await expect(page.getByTestId('pulse-needs')).toHaveCount(0);
});

// Audit B2 — one count everywhere: the Pulse, its way to the full list, the For You and Decisions
// Waiting badges and Project Health all count the same three decisions (two new, one reopened).
test('For You: every client surface counts the same decisions waiting on them', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Client', exact: true }).click();

  const rail = page.getByRole('navigation').first();
  await expect(page.getByTestId('pulse-needs')).toContainText('3 things need you');
  await expect(rail.getByRole('button', { name: /^For You/ })).toContainText('3');
  await expect(rail.getByRole('button', { name: /^Decisions Waiting/ })).toContainText('3');

  await page.getByTestId('pulse-needs-all').click();
  await expect(page.getByText('Decisions waiting for you')).toBeVisible();

  await rail.getByRole('button', { name: /^Project Health/ }).click();
  await expect(page.getByText('3 decisions waiting for you')).toBeVisible();
});
