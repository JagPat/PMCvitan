import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { loginTo, signIn } from './landing';

/**
 * Site Visits SV1-c (#792, QA item 6) — the screen over the real server. The PMC starts a visit, names a guest
 * and ends it; the client reads the same visit with no buttons. The screen is opened by its route, not the menu
 * (the menu's "More" group is changing in its own unit).
 */

const API = 'http://localhost:3000';
const PROJECT = 'ambli';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Re-runnable: end a visit the PMC left open in an earlier run, since one visitor holds one open visit. */
async function endOpenVisits(request: APIRequestContext): Promise<void> {
  const pmc = await loginTo(request, 'pmc@vitan.in', PROJECT);
  const me = JSON.parse(Buffer.from(pmc.token.split('.')[1], 'base64url').toString()).sub as string;
  const list = await request.get(`${API}/projects/${PROJECT}/site-visits?limit=200`, { headers: bearer(pmc.token) });
  expect(list.ok()).toBeTruthy();
  for (const v of (await list.json()) as { id: string; visitorId: string; status: string }[]) {
    if (v.visitorId !== me || v.status !== 'open') continue;
    const res = await request.post(`${API}/projects/${PROJECT}/site-visits/${v.id}/end`, {
      headers: bearer(pmc.token), data: { claimedAt: new Date().toISOString() },
    });
    expect(res.ok(), `end ${v.id} → ${res.status()}`).toBeTruthy();
  }
}

async function openVisits(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await loginTo(request, email, PROJECT); // sign-in opens the project last used
  await page.goto(`/projects/${PROJECT}/site-visits`);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Site Visits' })).toBeVisible();
}

test('a PMC starts a visit, names a guest and ends it; the client reads it with no buttons', async ({ page, request, browser }) => {
  await endOpenVisits(request);
  const guest = `Guest ${Date.now()}`;

  await openVisits(page, request, 'pmc@vitan.in');
  await page.getByTestId('sv-start').click();
  const open = page.locator('[data-testid^="sv-visit-"]').filter({ hasText: 'On site now' }).first();
  await expect(open).toBeVisible();
  const testId = (await open.getAttribute('data-testid'))!;
  const card = page.getByTestId(testId);
  await card.getByLabel('Guest’s name').fill(guest);
  await card.getByRole('button', { name: 'Add guest' }).click();
  await expect(card).toContainText(`${guest} · Guest`);
  await card.getByRole('button', { name: 'End visit' }).click();
  await expect(card).toContainText('Ended');

  const ctx = await browser.newContext();
  const client = await ctx.newPage();
  await openVisits(client, request, 'client@vitan.in');
  const seen = client.getByTestId(testId);
  await expect(seen).toContainText(`${guest} · Guest`);
  await expect(seen).toContainText('Ended');
  await expect(seen.getByRole('button')).toHaveCount(0);
  await expect(client.getByTestId('sv-start')).toHaveCount(0);
  await ctx.close();
});
