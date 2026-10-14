import { expect, type Locator, type Page } from '@playwright/test';

/**
 * #482 QA item 2 — the desktop rail shows at most five rows and folds the rest under "More". Specs that reach
 * a screen by its rail button go through these helpers, so they find it whether it is a main row or inside
 * More, and an assertion that a screen is absent from the menu also looks inside More.
 */

/** Open the rail's "More" when it is there and folded, once the rail has drawn its rows. A no-op on a rail
 *  without More. */
export async function openRailMore(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('button').first().waitFor();
  const more = page.getByTestId('rail-more');
  if ((await more.count()) === 0 || !(await more.isVisible())) return;
  if ((await more.getAttribute('aria-expanded')) === 'false') await more.click();
}

/** The rail button for a screen, with More opened first so a folded screen counts too. */
export async function navButton(page: Page, name: string | RegExp): Promise<Locator> {
  await openRailMore(page);
  return page.getByRole('navigation').getByRole('button', { name });
}

/** Click a screen's rail button, opening "More" first when the screen is folded inside it. Retries while the
 *  shell is still loading, since the rail's rows (and whether there is a More) settle with the project. */
export async function openNav(page: Page, name: string | RegExp): Promise<void> {
  const target = page.getByRole('navigation').getByRole('button', { name }).first();
  await expect(async () => {
    if (!(await target.isVisible())) await openRailMore(page);
    await expect(target).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await target.click();
}
