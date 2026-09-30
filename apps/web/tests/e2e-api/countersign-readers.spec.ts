import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B3 — the readers over the REAL stack with the six reservation doors STANDING (the
 * web arm of P31, the reader tripwire's Inbox item and badge). No row can be `awaiting_countersign`, so:
 *
 * - the approval badge the client sees is the shell's `counts.pendingDecisions` (the server's `countPending`:
 *   the client-held pending decisions, the countersign arms empty) PLUS the client's re-approvals — the one
 *   arm the badge carries that the server count omits (round-7 F5: a reopened decision is outstanding work);
 * - the Decision Log answers the value (its "Awaiting countersign" filter chip is offered) while no row
 *   carries it and the Decision Log badge — the viewer's countersign obligations — is absent;
 * - and B3 changed nothing a delivered role sees: the client's register shows exactly the rows the server
 *   serves, none of them provisional.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `client@vitan.in` is the client of `ambli`, with the seeded
 * client-held pending decisions and the one reopened decision.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const A = 'ambli';
const CLIENT = 'client@vitan.in';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}
async function apiLogin(request: APIRequestContext, email: string): Promise<{ token: string }> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return res.json();
}
/** the rail's nav button for a screen, and the count its badge renders ('' when no badge) */
const navButton = (page: Page, label: string) => page.locator('nav button').filter({ hasText: label });
const badgeOf = async (page: Page, label: string): Promise<string> =>
  ((await navButton(page, label).innerText()).replace(label, '').trim());

test('with the doors standing, the client’s approval badge is the shell’s countPending plus their re-approvals, and the register answers awaiting_countersign with no row carrying it', async ({ page, request }) => {
  // the server's side of the relation, read independently of the app
  const cli = await apiLogin(request, CLIENT);
  const headers = { Authorization: `Bearer ${cli.token}`, 'x-vitan-decisions-contract': 'countersign-v1' };
  const shell = await request.get(`${API}/projects/${A}/shell`, { headers });
  expect(shell.ok()).toBeTruthy();
  const shellJson = (await shell.json()) as { counts: { pendingDecisions: number }; rollout?: { phase6_4d: string } };
  expect(shellJson.rollout).toEqual({ phase6_4d: 'reserved' });
  const snapshot = await request.get(`${API}/projects/${A}/snapshot`, { headers });
  expect(snapshot.ok()).toBeTruthy();
  const decisions = ((await snapshot.json()) as { decisions: { status: string; deciderKind?: string; draft?: boolean }[] }).decisions;
  const pending = decisions.filter((d) => d.status === 'pending' && !d.draft && (d.deciderKind ?? 'client') === 'client').length;
  const reapprovals = decisions.filter((d) => d.status === 'change' && !d.draft && (d.deciderKind ?? 'client') === 'client').length;
  // the server's countPending for the client is exactly their pending approvals (no countersign arm can be non-zero)
  expect(shellJson.counts.pendingDecisions).toBe(pending);
  expect(pending).toBeGreaterThan(0);
  expect(decisions.some((d) => d.status === 'awaiting_countersign')).toBe(false);

  await page.goto('/');
  await signIn(page, CLIENT);
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');

  // the approval badge: the shell's count plus the re-approvals — never an awaiting row (there is none)
  await expect(navButton(page, 'Decisions Waiting')).toBeVisible();
  await expect.poll(() => badgeOf(page, 'Decisions Waiting')).toBe(String(shellJson.counts.pendingDecisions + reapprovals));
  // the Decision Log badge is the viewer's countersign obligations — a client has none, and no row is awaiting
  expect(await badgeOf(page, 'Decision Log')).toBe('');

  // the register answers the value: the filter chip is offered; no served row carries it
  await navButton(page, 'Decision Log').click();
  await expect(page.getByTestId('filter-awaiting_countersign')).toBeVisible();
  await expect(page.getByTestId('filter-recorded')).toBeVisible();
  const rows = page.locator('[data-testid^="log-row-"]');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBe(decisions.filter((d) => !d.draft).length);
  await expect(page.getByText('AWAITING COUNTERSIGN', { exact: true })).toHaveCount(0); // exact: the filter chip reads "Awaiting countersign"
  await expect(page.getByText('PROVISIONAL', { exact: true })).toHaveCount(0);
  // narrowing to the awaiting rows shows honestly nothing
  await page.getByTestId('filter-awaiting_countersign').click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No decisions match your filters.')).toBeVisible();
});
