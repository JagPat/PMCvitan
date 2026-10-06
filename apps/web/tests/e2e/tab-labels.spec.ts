import { test, expect } from '@playwright/test';
import { rolesFor } from '../../src/lib/screens';

/**
 * B9 (F-11) — ONE NAME PER SCREEN, READ IN FULL ON THE SMALLEST PHONE.
 *
 * The bottom tabs show each screen's full name ("Decision Log", "Site Map"). A role with five tabs and no
 * More (the contractor) divides a 320px bar five ways, leaving each label about 56px; a single-line label
 * with an ellipsis then cut the name short again (Codex 4180823396). The name may wrap instead, and it must
 * never be clipped — neither across its tab nor below the bar. Measured in a real browser, per persona the
 * switcher offers, at 320px (iPhone SE first generation, the narrowest width the app supports).
 */

test.use({ viewport: { width: 320, height: 640 } });

const ROLES = rolesFor('reserved');
const EPS = 0.5;

test('every persona: every bottom-tab label is shown in full at 320px', async ({ page }) => {
  await page.goto('/');
  const personas = await page
    .locator('[data-testid="mobile-role-switcher"] select option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect([...personas].sort()).toEqual([...ROLES].sort());

  for (const persona of personas) {
    await page.goto('/');
    await page.locator('[data-testid="mobile-role-switcher"] select').selectOption(persona);
    await expect(page.getByTestId('bottom-tabs')).toBeVisible();

    const labels = await page.getByTestId('bottom-tabs').locator('button > span:last-child').evaluateAll((els) => {
      const bar = document.querySelector('[data-testid="bottom-tabs"]')!.getBoundingClientRect();
      return els.map((el) => {
        const r = el.getBoundingClientRect();
        const tab = el.parentElement!.getBoundingClientRect();
        return {
          text: el.textContent ?? '',
          clippedAcross: el.scrollWidth - el.clientWidth,
          clippedDown: el.scrollHeight - el.clientHeight,
          outsideTab: Math.max(tab.left - r.left, r.right - tab.right),
          belowBar: r.bottom - bar.bottom,
          // the TAB itself, not just its label: a wrapped label must not push the tab's box past the bar
          // (shadow review on d5a978b — the bar's height is fixed, so an over-tall tab spills into the page)
          tabBelowBar: tab.bottom - bar.bottom,
          // …and the tab's content (icon, gap, wrapped label, padding) fits the tab it is drawn in
          tabOverflow: el.parentElement!.scrollHeight - el.parentElement!.clientHeight,
        };
      });
    });
    expect(labels.length, `${persona}: the bar must render its tabs`).toBeGreaterThan(0);
    for (const l of labels) {
      const where = `${persona} — "${l.text}"`;
      expect(l.clippedAcross, `${where} is cut off across its tab`).toBeLessThanOrEqual(EPS);
      expect(l.clippedDown, `${where} is cut off below`).toBeLessThanOrEqual(EPS);
      expect(l.outsideTab, `${where} spills out of its tab`).toBeLessThanOrEqual(EPS);
      expect(l.belowBar, `${where} falls below the tab bar`).toBeLessThanOrEqual(EPS);
      expect(l.tabBelowBar, `${where}: its tab is taller than the bar`).toBeLessThanOrEqual(0);
      expect(l.tabOverflow, `${where}: its tab's content overflows the tab`).toBeLessThanOrEqual(0);
    }
  }
});
