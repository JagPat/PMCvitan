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
  // #584 review round 1, finding 4 — the first version of this arm asserted only that every
  // computed size was POSITIVE, which is true whether the rule is correctly scoped or has
  // escaped to every width. It therefore passed in exactly the world it existed to rule out.
  // The claim is now made of a control whose authored size is KNOWN and sub-16px: the schedule
  // surface's dense filter fields. If the mobile rule reaches desktop, this reads 16 and fails.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  // the bottom tabs are the MOBILE navigation and are display:none at this width; desktop
  // navigates through `LeftRail`, which is the whole reason this width has its own density.
  // The decision register is the surface chosen because it renders a text-entry control at
  // BOTH widths — the schedule surface renders none at desktop, so it could prove nothing here.
  await page.getByRole('button', { name: 'Decision Log' }).click();
  await expect(page.getByText('DECISION REGISTER')).toBeVisible();
  const sizes = await page.$$eval(
    "input:not([type='checkbox']):not([type='radio']):not([type='file']):not([type='range']):not([type='color']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image']), textarea, select",
    (els) => els
      .filter((el) => el instanceof HTMLElement && el.offsetParent !== null)
      .map((el) => parseFloat(getComputedStyle(el).fontSize)),
  );
  expect(sizes.length, 'the decision register must render text-entry controls at desktop').toBeGreaterThan(0);
  expect(
    sizes.filter((v) => v < 16).length,
    `at least one desktop control must keep its authored sub-16px density — sizes: ${JSON.stringify(sizes)}`,
  ).toBeGreaterThan(0);
});

/**
 * #584 review round 1, finding 1 — PHONE LANDSCAPE, where a width-only rule stops applying.
 *
 * An iPhone 14 rotated is 844 x 390 CSS px, so `max-width: 639px` alone releases the floor at
 * exactly the moment the device is still a phone and Safari still zooms. The rule's second
 * condition tests the SHORT side plus `pointer: coarse`, so this arm needs a touch device and
 * not merely a wide-and-short viewport — and it takes one through `test.use`, which inherits the
 * project's own options (`baseURL` among them). `browser.newContext()` inherits none of them.
 */
test.describe('phone landscape', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('the field floor still applies, so iOS Safari does not zoom on rotation', async ({ page }) => {
    await page.goto('/');
    // At 844px wide the SHELL is already the desktop one — `BottomTabs` is display:none above
    // 640px — so a phone in landscape navigates through `LeftRail` and receives the authored
    // desktop density. That is precisely why the hazard is real here and why the floor's second
    // condition exists: the app has stopped treating this device as a phone, and Safari has not.
    await page.getByRole('button', { name: 'Decision Log' }).click();
    await expect(page.getByText('DECISION REGISTER')).toBeVisible();
    const small = await page.$$eval(
      "input:not([type='checkbox']):not([type='radio']):not([type='file']):not([type='range']):not([type='color']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image']), textarea, select",
      (els) => els
        .filter((el) => el instanceof HTMLElement && el.offsetParent !== null)
        .map((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), html: el.outerHTML.slice(0, 90) }))
        .filter((f) => f.size < 16),
    );
    expect(
      small,
      `these controls zoom iOS Safari in phone landscape — ${JSON.stringify(small)}`,
    ).toEqual([]);
  });
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

  // #584 review round 1, finding 2 — a sweep of what happens to be on screen measures ONE state
  // and reports on all of them. The daily log renders different controls per state, and two of
  // them were undersized behind a state this arm never entered: the `Check out` button, which
  // exists only while checked IN, and the stale-data `Retry`, which exists only while a refresh
  // is owed. So the sweep is a function now, and it runs in every state the screen can be in.
  //
  // #584 review round 3, finding 1 — AND A SWEEP OF ONE ELEMENT TYPE MEASURES ONE ELEMENT TYPE.
  // It queried `button` alone, which is not what "action target" means: `LocationPicker` renders
  // its zone/room/element choosers as `<select>` on the shared 42px field style, and the Daily Log
  // shows them whenever the project has location nodes. So a thumb target four pixels under the
  // documented floor stood inside the very screen this arm sweeps, and the arm passed. The floor
  // is about what a thumb presses, so the query names every interactive kind rather than the one
  // that happened to be undersized in round 1 — a `<select>` is pressed exactly as a button is.
  const INTERACTIVE = [
    'button:not([disabled])',
    'select:not([disabled])',
    '[role="button"]:not([aria-disabled="true"])',
    'a[href]',
    'input:not([disabled])',
  ].join(', ');

  // #584 review round 3, finding 2 — MEASURE THE STEADY STATE, NEVER THE ENTRY ANIMATION.
  // Round 2 recorded a "~0.982 ancestor content scale" on Schedule as a persistent layout
  // constraint and deferred it to F-1c. It was no such thing: `ScheduleRow` carries
  // `animation: 'vpop .3s'` and the `vpop` keyframe runs `scale(0.98)` to `transform: none`, so a
  // row measured just after mount reports 43.2px for a box that is 44px a third of a second
  // later. A size inventory that races an animation invents layout blockers, so every sweep from
  // here neutralises animation and transition first and measures what the thumb actually meets.
  const freezeMotion = async (): Promise<void> => {
    await page.addStyleTag({
      content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
    });
  };

  const sweepTargets = async (state: string): Promise<void> => {
    await freezeMotion();
    const small = await page.$$eval(INTERACTIVE, (els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        // DEV-ONLY affordances owe no field floor. The persona switcher renders under `DEV_AUTH`,
        // which is on for the local demo and dev builds and off wherever an API is configured, so
        // no site user ever presses it — but this suite runs the demo build, where it is on screen.
        // The exclusion is a marked subtree rather than a narrowed query, so it stays greppable
        // and anything NEW that appears is swept by default.
        .filter((el) => !el.closest('[data-dev-affordance]'))
        // a text field is typed into, not pressed, and the floor it answers to is the 16px
        // font-size rule the arms above measure. Only the PRESSED input types belong here.
        .filter((el) => !(el instanceof HTMLInputElement)
          || ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'color', 'range']
            .includes(el.type))
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
      `these action targets are under 44×44 and are pressed with a thumb, on site (state: ${state}) — ${JSON.stringify(small)}`,
    ).toEqual([]);
  };

  // WHAT THIS SWEEP STILL CANNOT REACH, stated rather than left to be discovered. The control
  // round 3's finding named — `photo-loc-select-zone`, the `LocationPicker` chooser — renders only
  // behind `nodes.length > 0` in `DailyLogScreen`, and the seeded demo project has no location
  // nodes; the picker's own `__new_zone__` option cannot bootstrap the first one, because the
  // picker is what the guard hides. So its height is corrected at the style constant (`fld` in
  // `LocationPicker.tsx`, 42 → 44) and the widened query below WOULD catch it on any project that
  // has places, but this fixture does not exercise it. That is a real gap in the proof and it is
  // written here rather than papered over by adding whichever OTHER surface happens to pass —
  // which is the narrowing round 2 already caught once. F-1c owns the seeded-places sweep.
  await sweepTargets('daily log — as opened');

  // CHECKED IN — `Check out` replaces `Check in at site`, and it is the only way off site.
  const checkIn = page.getByTestId('check-in');
  if (await checkIn.count()) {
    await checkIn.click();
    await expect(page.getByTestId('check-out')).toBeVisible();
    await sweepTargets('checked in');
  }

  // OFFLINE — the connectivity toggle drives the state the stale-data banner belongs to, and
  // the actions the screen locks while it is showing.
  const toggle = page.getByTestId('toggle-online');
  if (await toggle.count()) {
    await toggle.click();
    await sweepTargets('offline');
    await toggle.click();
  }

  // STALE — and this is a STATEMENT, not a skip (#584 review round 2, finding 2). The first
  // version of this arm wrote `if (await retry.count()) await sweepTargets(...)`, which reads
  // like coverage and is not: `dailyLogLoad` only reaches `error` on a FAILED MODULE READ, and
  // that read exists only under `VITE_DAILYLOG_READ=moduleQuery`, which this harness does not
  // run — the default is `snapshot`, and `toggleOnline` sets `online` and nothing else. So the
  // banner never appears here and the branch was always false.
  //
  // Asserting its ABSENCE is the honest shape: it records why the state is unreachable in this
  // suite, and it FAILS the moment that stops being true — at which point this sweep must gain
  // the state rather than silently resume skipping it. (`daily-log-retry` itself carries the
  // 44px floor; the sweep is what cannot reach it here.)
  await expect(
    page.getByTestId('daily-log-retry'),
    'the stale-snapshot banner is unreachable under the snapshot read mode this suite runs; if it '
    + 'renders, this sweep owes that state an arm',
  ).toHaveCount(0);
});

/**
 * #584 review round 2, finding 1 — THE CROSS-SURFACE AUDIT IS F-1c's, and this is the record of
 * why, with the measurement that settles it.
 *
 * The finding is accepted: sweeping only the Daily Log let this unit claim a generic audit while
 * three shipped controls stayed under the floor. Those three are FIXED on this head — the worker
 * and mistri sign-out buttons and the Places photo thumbnails — as are the Schedule surface's
 * three icon buttons, which the sweep found on the way.
 *
 * What a full sweep then measured is that the remaining violations are not size constants:
 *   · SCHEDULE applies a ~0.982 ancestor content scale, so a control whose CSS box is exactly
 *     44px is pressed at 43.2 — every control there is under the floor by construction — and its
 *     place breadcrumbs and drawing chips are inline TEXT links 18–21px tall.
 *   · the DECISION REGISTER's group-by chips are a 26px segmented control.
 * Each is a layout decision about a dense surface, not padding, and `WAVE_0_FOUNDATION.md` puts
 * "the sweep and the evidence, across all surfaces" in F-1c by name.
 *
 * So this file does NOT carry a cross-surface sweep. A sweep scoped to the surfaces that happen
 * to pass is the same narrowing round 2 caught, stated more confidently; the honest artifact is
 * the fixes above plus the measured inventory recorded in the brief for F-1c. The Daily Log's
 * multi-state sweep stays, because that surface IS this unit's named subject.
 */
