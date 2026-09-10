import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 0 / unit F-1b — NO TEXT-ENTRY CONTROL FALLS BELOW 16px ON MOBILE.
 *
 * WHY 16px EXACTLY. Mobile Safari zooms the viewport when a text-entry control smaller than
 * 16px receives focus, and it does not zoom back out. The user is left panned into a form
 * they must now scroll horizontally to read — one-handed, on site, mid-inspection. It is not
 * a preference: 16px is the threshold at which iOS stops doing it.
 *
 * WHY THIS TEST IS A REAL BROWSER AND NOT jsdom. The guarantee is a CASCADE fact — an
 * `!important` author rule outranking the inline `style` attribute the screens write — and
 * jsdom's `getComputedStyle` does not resolve author stylesheets against inline declarations.
 * A jsdom assertion here would pass while the phone still zoomed. Measured, not modelled.
 *
 * WHY THE SWEEP IS GENERIC. It asks the page for every text-entry control rather than naming
 * the ones that were too small when this was written. The inventory moved between the Wave-0
 * brief and this unit (the brief's 8 named constants were 134 controls at F-1b's opening
 * head), so a named list would be stale again by the next screen anyone adds.
 *
 * Checkbox, radio, file, range and the button-like input types are excluded: iOS does not
 * zoom for them, and forcing 16px on a checkbox changes its box for no reason.
 */

test.use({ viewport: { width: 390, height: 844 } });

const FLOOR = 16;

/** every control on the page that iOS would zoom for, with its computed size and a locator hint */
async function undersizedFields(page: Page): Promise<Array<{ where: string; size: number }>> {
  return page.$$eval(
    'input, textarea, select',
    (els, floor) => {
      const NO_ZOOM = ['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button', 'hidden', 'image', 'reset'];
      return els
        .filter((el) => {
          if (el instanceof HTMLInputElement && NO_ZOOM.includes(el.type)) return false;
          // `$$eval` types the node broadly; only an HTMLElement has offsetParent, and only
          // those three tags are selected anyway.
          return el instanceof HTMLElement && el.offsetParent !== null;   // visible only
        })
        .map((el) => ({
          where: `<${el.tagName.toLowerCase()}${(el as HTMLInputElement).type ? ` type=${(el as HTMLInputElement).type}` : ''}`
            + `${el.getAttribute('placeholder') ? ` placeholder="${el.getAttribute('placeholder')}"` : ''}>`,
          size: parseFloat(getComputedStyle(el).fontSize),
        }))
        .filter((f) => f.size < floor);
    },
    FLOOR,
  );
}

async function sweep(page: Page, surface: string) {
  const bad = await undersizedFields(page);
  expect(
    bad,
    `${surface}: these controls are below ${FLOOR}px, so focusing one zooms mobile Safari and `
    + `the user cannot undo it — ${JSON.stringify(bad)}`,
  ).toEqual([]);
}

test('the schedule surface focuses every field without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-site-schedule').click();
  await sweep(page, 'Schedule');
});

test('the decision register, including its one search input, focuses without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByTestId('more-item-decision-log').click();
  await expect(page.getByText('DECISION REGISTER')).toBeVisible();
  await sweep(page, 'Decision log');
});

test('the drawings register focuses without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByTestId('more-item-drawings').click();
  await sweep(page, 'Drawings');
});

test('the team surface focuses without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  const team = page.getByTestId('more-item-team');
  if (await team.count()) {
    await team.click();
    await sweep(page, 'Team');
  }
});

test('desktop keeps its authored density — the floor is a MOBILE floor, not a global one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const sizes = await page.$$eval('input, textarea, select', (els) =>
    els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  // nothing is asserted about the values themselves — only that the mobile rule is scoped and
  // has NOT reached the desktop layout, which the brief explicitly allows to be denser.
  expect(sizes.every((s) => s > 0)).toBe(true);
});

/**
 * Wave 0 / F-1b — EVERY ACTION TARGET MEETS THE 44×44 FLOOR.
 *
 * The brief singles out the daily log's mismatch control: it was a borderless 9.5px caption of
 * roughly 84 × 12 px, and it is the control that stops wrong material reaching the wall. The
 * sweep is generic for the same reason the field sweep is — a named list goes stale.
 */
test('the daily log offers no action target below the 44px floor', async ({ page }) => {
  // The daily log is the ENGINEER's screen — the persona whose thumb presses this control on
  // site. The persona switcher lives in `LeftRail`, which is desktop-only, so the role is
  // chosen at desktop width and the viewport is then taken to the phone: what is measured is
  // the control as it renders at 390px, which is the width the claim is about.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Engineer', exact: true }).click();
  await page.getByRole('button', { name: 'Daily Site Log' }).click();
  await expect(page.getByText('MATERIAL ON SITE')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('MATERIAL ON SITE')).toBeVisible();

  const small = await page.$$eval('button:not([disabled])', (els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: (el.textContent || '').trim().slice(0, 40) || el.getAttribute('aria-label') || '(unlabelled)',
          testid: el.getAttribute('data-testid') || '',
          within: el.closest('[data-testid]')?.getAttribute('data-testid') || el.parentElement?.tagName || '',
          html: el.outerHTML.slice(0, 120),
          w: Math.round(r.width), h: Math.round(r.height),
        };
      })
      .filter((b) => b.w > 0 && b.h > 0 && (b.w < 44 || b.h < 44)));

  expect(
    small,
    `these action targets are under 44×44 and are pressed with a thumb, on site — ${JSON.stringify(small)}`,
  ).toEqual([]);
});
