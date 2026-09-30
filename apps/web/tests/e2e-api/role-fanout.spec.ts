import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B2 — the role fan-out over the REAL stack with the six reservation doors
 * STANDING: the shell reads `rollout.phase6_4d = 'reserved'` (B1), so the Team screen's role pickers
 * and the decider picker offer NO architect — the server would refuse the membership or the designation
 * 409 (P28b / P34's web arm: the pickers follow the ONE shell read, and the client offers nothing the
 * server refuses). Runs in every api-e2e mode.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `test-pmc@vitan.in` is a PMC whose home is project B.
 */

const PASSWORD = 'vitan123';
const PMC = 'test-pmc@vitan.in';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}
const optionValues = (page: Page, testId: string) =>
  page.getByTestId(testId).locator('option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));

test('with the doors standing, no picker offers the architect: the Team role pickers and the decider picker follow the reserved shell', async ({ page }) => {
  await page.goto('/');
  await signIn(page, PMC);
  await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');

  // the Team screen: the add-member picker offers the five delivered roles and never the architect
  await page.getByRole('button', { name: 'Team' }).click();
  await expect(page.getByTestId('member-role')).toBeVisible();
  const memberRoles = await optionValues(page, 'member-role');
  expect(memberRoles).toEqual(['pmc', 'client', 'engineer', 'contractor', 'consultant']);
  expect(memberRoles).not.toContain('architect');

  // the decider picker on a new decision: no architect designation while reserved
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await page.getByTestId('issue-decision').click();
  await expect(page.getByTestId('dec-decider-kind')).toBeVisible();
  const deciderKinds = await optionValues(page, 'dec-decider-kind');
  expect(deciderKinds).toEqual(['client', 'pmc', 'member', 'none']);
});
