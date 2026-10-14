import { test, expect } from '@playwright/test';

/**
 * #482 QA check (14 Oct 2026, item 4) — the engineer, contractor and consultant see what waits on the client,
 * read-only, on their Decisions screen. The journey opens the screen by its route (the menu label is the UX
 * thread's), and the list offers nothing to decide.
 */
for (const role of ['Engineer', 'Contractor', 'Consultant']) {
  test(`${role} sees the "Awaiting client" list on the Decisions route, with no decide button`, async ({ page }) => {
    await page.goto('/projects/ambli/for-you');
    await page.getByRole('button', { name: role, exact: true }).click();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await page.evaluate(() => (window as unknown as { __vitanDevSeed: (p: Record<string, unknown>) => void }).__vitanDevSeed({ screen: 'decision-log' }));
    await expect(page).toHaveURL(/\/projects\/ambli\/decisions$/);

    const list = page.getByTestId('awaiting-client');
    await expect(list.getByRole('heading', { name: 'Awaiting client' })).toBeVisible();
    await expect(list.getByRole('listitem').first()).toBeVisible();
    // the only buttons on a row are its place's links; nothing approves, chooses or decides
    await expect(page.getByRole('button', { name: /\b(approve|choose|decide|select option)\b/i })).toHaveCount(0);
  });
}
