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
const TOUCH = 44;
/**
 * #584 review round 8, finding 1 — the floor is compared against the RAW rect, and this epsilon
 * is what makes that safe.
 *
 * Rounding before the comparison hid a real class of defect: a target at 43.6px read as 44 and
 * passed, in the one suite whose reason for existing is a SUB-PIXEL shrink. But the unrounded
 * rect brings its own artifact, and this arm measured it within minutes of the change — the More
 * sheet's Close button, whose layout box is EXACTLY 44×44 (`min-width`/`min-height`, no
 * transform, verified by computed style), reports ~43.99 while the sheet's `sheetUp` entry
 * animation is translating it: a fractional translate moves both edges, and the rect's width is
 * the difference of two independently snapped coordinates.
 *
 * So the predicate keeps the raw measurement and allows a TENTH of a pixel. That is two orders of
 * magnitude below every real defect this file has found — `vpop`'s scale gave 43.1, and round 8's
 * own example is 43.5–44.0 — and comfortably above edge snapping. An element genuinely one tenth
 * of a pixel short is not a thumb problem; an element half a pixel short still fails here.
 */
const SUBPIXEL = 0.1;

/**
 * Every enabled interactive element that is not a dev-only affordance.
 *
 * #584 review round 7, finding 1 — TEXT-ENTRY CONTROLS ARE POINTER TARGETS TOO, and the filter
 * below used to select them only to throw them away. The comment defending that read "a text
 * field is typed into, not pressed" — which is false about the first interaction: a thumb has to
 * LAND on the field before a keyboard exists. Two shipped controls sat under the floor behind
 * that sentence (Schedule's dialog fields at 42px, the Decision Register's inline location
 * editors at 34px), and `textarea` was never in this list at all, so no textarea anywhere in the
 * product had ever been measured. The 44×44 floor in `WAVE_0_FOUNDATION.md` is written about
 * ACTION TARGETS with no carve-out for the ones that also accept text, so there is none here.
 *
 * `type=hidden` is the one exclusion, because it has no box to measure.
 */
const INTERACTIVE = [
  'button:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]:not([aria-disabled="true"])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
].join(', ');

/**
 * The shared action-target sweep. The Daily Log arm keeps its own state-by-state version below
 * (it has to drive check-in, offline and stale states); this is the same rule applied to a
 * surface as it stands, for the groups round 5 required this unit to raise.
 */
async function sweepActionTargets(page: Page, surface: string): Promise<void> {
  const small = await page.$$eval(INTERACTIVE, (els, { floor, eps }) =>
    (els as HTMLElement[])
      .filter((el) => el.offsetParent !== null)
      .filter((el) => !el.closest('[data-dev-affordance]'))
      .map((el) => {
        // A CHECKBOX OR RADIO IS MEASURED AT ITS LABEL when one encloses it. The native box is a
        // platform affordance — 13px on every browser, and forcing it larger changes a control
        // users recognise by its size — while label activation forwards a press anywhere in the
        // label to the control. So the thumb's target genuinely IS the label, and that is what
        // the floor is about. This applies to nothing else: a button, a select or a text field
        // is its own target, and measuring an enclosing label for those would let a tall row
        // excuse a small control.
        const box = (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
          && el.closest('label')) || el;
        const r = box.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute('data-testid') || '',
          label: (el.textContent || '').trim().slice(0, 30)
            || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
          // #584 review round 8, finding 1 — the RAW rect decides, and rounding is for the
          // message only. `Math.round` used to run first, so a target at 43.6px read as 44 and
          // passed — in the one suite whose reason for existing is a SUB-PIXEL shrink: `vpop`
          // scaled 44 to 43.1, and a slightly gentler scale would have been invisible here.
          w: r.width, h: r.height,
        };
      })
      .filter((b) => b.w > 0 && b.h > 0 && (b.w < floor - eps || b.h < floor - eps))
      .map((b) => ({ ...b, w: Math.round(b.w * 10) / 10, h: Math.round(b.h * 10) / 10 })), { floor: TOUCH, eps: SUBPIXEL });

  expect(
    small,
    `${surface}: these action targets are under ${TOUCH}×${TOUCH} and are pressed with a thumb, `
    + `on site — ${JSON.stringify(small)}`,
  ).toEqual([]);

  await sweepReachable(page, surface);
}

/**
 * #584 review round 9 — A TARGET BIG ENOUGH AND OFF THE SIDE OF ITS CONTAINER IS NOT A TARGET.
 *
 * This arm exists because of a defect THIS UNIT introduced. Round 8 raised three icon buttons in
 * the Locations manager from ~23px to 44px — the right fix by the rule this file enforces — and
 * the extra width pushed the deepest zone rows past the dialog's edge. Every sweep in this file
 * stayed green, because every sweep in this file measures SIZE. An accessibility fix made
 * controls harder to reach and the proof could not see it.
 *
 * THE MEASUREMENT, because the first draft of this arm was written from a description and was
 * GREEN against the unfixed source. At 390px, with round 8's sizes and no wrapping:
 *
 *     Delete Ground Floor   [377, 421]      the dialog body: overflow-x auto, box [20, 370],
 *     Delete Entrance       [349, 393]      scrollWidth 520 against clientWidth 350
 *
 * So the controls are NOT unreachable in the absolute sense, and saying so would be false: the
 * dialog body scrolls, and a user who discovers that can drag it ~170px sideways and press
 * Delete. The first draft treated a scrollable ancestor as a rescue and therefore reported
 * nothing — the honest reading of its own rule, applied to a rule that was too weak.
 *
 * The property worth asserting is the one this repository already applies to layout: an ACTION
 * TARGET is reachable without scrolling sideways. Content may overflow into a scroller — a wide
 * table, a diagram — but a delete button you reach by dragging a modal across a phone screen is
 * the same defect as a page that scrolls horizontally. So the box compared against is the
 * VISIBLE box of the nearest ancestor that clips or scrolls, and its scrollWidth is not a
 * defence. Vertical position is not judged: pages scroll down, and that is ordinary.
 */
async function sweepReachable(page: Page, surface: string): Promise<void> {
  const out = await page.$$eval(INTERACTIVE, (els, eps) =>
    (els as HTMLElement[])
      .filter((el) => el.offsetParent !== null)
      .filter((el) => !el.closest('[data-dev-affordance]'))
      .map((el) => {
        // the nearest ancestor that clips OR scrolls decides what "visible" means here, and its
        // scrollWidth is deliberately not consulted: a target that needs a sideways drag is the
        // thing being measured, not an excuse for it.
        let bounds = { left: 0, right: window.innerWidth };
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (getComputedStyle(p).overflowX === 'visible') continue;
          const pr = p.getBoundingClientRect();
          bounds = { left: pr.left, right: pr.right };
          break;
        }
        const r = el.getBoundingClientRect();
        return { el, r, bounds };
      })
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .filter(({ r, bounds }) => r.left < bounds.left - eps || r.right > bounds.right + eps)
      .map(({ el, r, bounds }) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid') || '',
        label: (el.textContent || '').trim().slice(0, 30)
          || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        left: Math.round(r.left), right: Math.round(r.right),
        clipLeft: Math.round(bounds.left), clipRight: Math.round(bounds.right),
      })), SUBPIXEL);

  expect(
    out,
    `${surface}: these action targets sit OUTSIDE the visible box of the container that holds `
    + `them, so reaching one means dragging that container sideways on a phone — a 44px control `
    + `you have to go looking for is not a fix — ${JSON.stringify(out)}`,
  ).toEqual([]);
}

/** every control on the page that iOS would zoom for, with its computed size and a locator hint */
async function visibleFields(page: Page): Promise<Array<{ where: string; size: number; under: boolean }>> {
  return page.$$eval(
    'input, textarea, select',
    (els, floor) => {
      const NO_ZOOM = ['checkbox', 'radio', 'file', 'range', 'color', 'submit', 'button', 'hidden', 'image', 'reset'];
      return els
        .filter((el) => {
          if (el instanceof HTMLInputElement && NO_ZOOM.includes(el.type)) return false;
          // DEV-ONLY affordances are not part of any surface. The persona switcher is a `<select>`
          // in the TopBar, so it rides along on EVERY screen — and measuring it is what made the
          // Schedule and Drawings arms look non-empty while the surfaces' own fields (all of them
          // behind dialogs) went unmeasured. Counting it would have satisfied the `atLeast` guard
          // below with the one control the guard exists to look past.
          if (el.closest('[data-dev-affordance]')) return false;
          // `$$eval` types the node broadly; only an HTMLElement has offsetParent, and only
          // those three tags are selected anyway.
          return el instanceof HTMLElement && el.offsetParent !== null;   // visible only
        })
        .map((el) => ({
          where: `<${el.tagName.toLowerCase()}${(el as HTMLInputElement).type ? ` type=${(el as HTMLInputElement).type}` : ''}`
            + `${el.getAttribute('placeholder') ? ` placeholder="${el.getAttribute('placeholder')}"` : ''}>`,
          size: parseFloat(getComputedStyle(el).fontSize),
        }))
        .map((f) => ({ ...f, under: f.size < floor }));
    },
    FLOOR,
  );
}

/**
 * #584 review round 4, finding 1 — A SWEEP THAT MEASURED NOTHING PASSES.
 *
 * `toEqual([])` on the undersized list is satisfied by an empty page as readily as by a correct
 * one, and on two surfaces it was exactly that: Schedule's inputs live behind the Plan activity,
 * Add phase and Override dialogs, Drawings' behind Issue drawing, and these arms only opened the
 * initial page. Both were green over ZERO fields, so a modal field-size regression would never
 * have been seen — the third time this file has been caught proving something about a set it
 * never populated (round 1: one state of many; round 3: one element type of several).
 *
 * So the count is now part of the claim: every sweep names how many fields it must find, and a
 * surface that stops rendering them fails here rather than going quietly green.
 */
async function sweep(page: Page, surface: string, atLeast: number) {
  const all = await visibleFields(page);
  expect(
    all.length,
    `${surface}: this sweep measured ${all.length} fields and was asked for at least ${atLeast}. `
    + `An empty sweep proves nothing — either the surface stopped rendering the controls this arm `
    + `exists to check, or the arm never reached the state that holds them.`,
  ).toBeGreaterThanOrEqual(atLeast);

  const bad = all.filter((f) => f.under).map(({ where, size }) => ({ where, size }));
  expect(
    bad,
    `${surface}: these controls are below ${FLOOR}px, so focusing one zooms mobile Safari and `
    + `the user cannot undo it — ${JSON.stringify(bad)}`,
  ).toEqual([]);
}

test('the schedule surface focuses every field without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-site-schedule').click();

  // the fields are in the dialogs, so the dialogs are where the sweep has to be (round 4,
  // finding 1). Each is swept while OPEN, and the count assertion below is what makes a dialog
  // that stops opening a failure here instead of a silent pass.
  await page.getByTestId('add-phase').click();
  await expect(page.getByTestId('phase-name')).toBeVisible();
  await sweep(page, 'Schedule — Add phase dialog', 1);
  await page.keyboard.press('Escape');

  await page.getByTestId('plan-activity').click();
  await sweep(page, 'Schedule — Plan activity dialog', 2);
});

test('the decision register, including its one search input, focuses without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByTestId('more-item-decision-log').click();
  await expect(page.getByText('DECISION REGISTER')).toBeVisible();
  await sweep(page, 'Decision log', 1);
});

test('the drawings register focuses without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByTestId('more-item-drawings').click();
  // same as Schedule: the register itself carries no field, the Issue drawing dialog does.
  await page.getByTestId('issue-drawing').click();
  await sweep(page, 'Drawings — Issue drawing dialog', 1);
});

test('the team surface focuses without zooming', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  const team = page.getByTestId('more-item-team');
  if (await team.count()) {
    await team.click();
    await sweep(page, 'Team', 1);
  }
});

/**
 * #584 review round 7, finding 2 — THE CROSS-SURFACE AUDIT, ACTUALLY TAKEN.
 *
 * This is the fourth time the same finding has been raised, and each of the first three times I
 * answered it by re-scoping the PROOF instead of meeting the CRITERION. Round 2: sweep the Daily
 * Log only, defer the rest to F-1c. Round 5: sweep the two surfaces this unit had changed. Round
 * 7 named three more shipped controls under the floor — `TeamAccessScreen`'s zero-padding Back
 * action, its ~36px language chips, `PhotoViewer`'s 40×40 close — and it would have named a
 * fourth set next round, because the deferral was the defect, not the list.
 *
 * `WAVE_0_FOUNDATION.md`'s F-1b completion criterion is "every action target ≥44×44" with no
 * exception written into it. So the sweep is now what that sentence describes: for EVERY persona
 * the product offers, walk EVERY surface that persona's navigation reaches — the bottom tabs and
 * every row of the More sheet — and measure every pointer target on each.
 *
 * Nothing here is a named list. The personas come from the switcher's own options and the
 * surfaces from the nav's own test ids, so a screen added tomorrow is swept the day it appears
 * rather than the day someone remembers to add it. That is the property the three narrowed
 * versions never had, and it is why this arm replaces them instead of joining them.
 *
 * WHAT IT STILL CANNOT REACH is stated rather than implied: modal dialogs, multi-step flows past
 * their first step, and states that need a server (a recorded gate override; the stale-snapshot
 * banner). Those are swept where they ARE drivable — the Schedule and Drawings dialogs below —
 * or guarded at source in `ux-consistency.test.tsx`. F-1c owns the seeded-places and
 * authenticated-flow states.
 */
test('every persona, every surface its navigation reaches, holds the 44px floor', async ({ page }) => {
  await page.goto('/');
  const personas = await page
    .locator('[data-dev-affordance="role-switcher"] select option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(personas.length, 'the persona switcher must offer the roles this sweep walks').toBeGreaterThan(1);

  for (const persona of personas) {
    await page.goto('/');
    await page.locator('[data-dev-affordance="role-switcher"] select').selectOption(persona);

    const tabs = await page
      .locator('[data-testid^="tab-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!).filter((t) => t !== 'tab-more'));
    expect(tabs.length, `${persona}: the bottom tabs must render for this persona`).toBeGreaterThan(0);
    for (const tab of tabs) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(tab)).toBeVisible();
      await sweepActionTargets(page, `${persona} — ${tab}`);
    }

    // `More` renders only when the persona has more screens than the tab bar holds — a narrow
    // role (the client's) has none, and that is a fact about the nav, not a state to force.
    const more = page.getByTestId('tab-more');
    if (!(await more.count())) continue;

    await more.click();
    await sweepActionTargets(page, `${persona} — the More sheet itself`);
    const rows = await page
      .locator('[data-testid^="more-item-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
    expect(rows.length, `${persona}: the More sheet opened and offered no rows to sweep`).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    for (const row of rows) {
      await page.getByTestId('tab-more').click();
      const item = page.getByTestId(row);
      await expect(item).toBeVisible();
      await item.click();
      await expect(page.getByTestId('tab-more')).toBeVisible();
      await sweepActionTargets(page, `${persona} — ${row}`);
    }
  }
});

/**
 * #584 review round 8, finding 2 — THE DIALOGS ARE DISCOVERED, NOT NAMED.
 *
 * Round 7 replaced a named SURFACE list with a walk of the navigation's own items, and then
 * opened four dialogs BY NAME beside it. That was the same defect one level down, and it took
 * one round to prove: `Manage locations` is reachable from the Decision Register, holds the
 * tree's rename / delete / add controls, and no arm here opened it — so its 23px glyph buttons
 * and its dashed add-child chips sat under the floor while the suite was green.
 *
 * So this arm opens dialogs the way a person finds them: it presses each control on a surface
 * and asks whether a dialog appeared. Anything that opens one is swept; anything that does not
 * is left alone. Nothing is named, so a dialog added tomorrow is swept the day it appears — the
 * property the four-name list never had.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is press controls INSIDE a dialog. A modal's own buttons
 * commit, delete and publish, and a sweep that fires them is not measuring a surface any more —
 * it is driving the app somewhere the next assertion cannot predict. The dialog is opened,
 * measured, and dismissed with Escape, and the page is reloaded between surfaces so a control
 * that changed state cannot leak into the next one.
 */
test('every dialog a surface can open holds the 44px floor', async ({ page }) => {
  // pressing every control on three surfaces is minutes of work, not seconds, and the project
  // default is 30s. The cost is the price of discovery: a named list runs in two seconds and is
  // wrong one round later, which this file has now demonstrated twice.
  test.setTimeout(300_000);
  const surfaces = ['tab-site-schedule', 'more-item-decision-log', 'more-item-drawings'];
  const seen: string[] = [];

  const openSurface = async (surface: string): Promise<void> => {
    await page.goto('/');
    if (surface.startsWith('more-item-')) {
      await page.getByTestId('tab-more').click();
      await page.getByTestId(surface).click();
    } else {
      await page.getByTestId(surface).click();
    }
    await expect(page.getByTestId('tab-more')).toBeVisible();
  };

  for (const surface of surfaces) {
    await openSurface(surface);
    const openerCount = await page.locator('button:not([disabled])').count();

    for (let i = 0; i < openerCount; i += 1) {
      // THE SURFACE IS RELOADED BEFORE EVERY PRESS, and that is not caution — the first draft
      // walked `nth(i)` over a list captured once, and opening a dialog inserts ITS buttons into
      // that list. The indices drifted, the arm re-measured one dialog several times, and the
      // `opened` count still passed while `Manage locations` — the dialog round 8 is about — was
      // never reached. Measured, not reasoned: the arm was green against the UNFIXED source.
      await openSurface(surface);
      const button = page.locator('button:not([disabled])').nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      if (await button.evaluate((el) => !!el.closest('[data-dev-affordance]')).catch(() => true)) continue;

      await button.click({ timeout: 1_500 }).catch(() => undefined);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.count().catch(() => 0)) {
        const label = (await dialog.first().textContent().catch(() => '') || '').trim().slice(0, 40);
        await sweepActionTargets(page, `${surface} — dialog "${label}"`);
        seen.push(label);
      }
    }
  }
  const opened = new Set(seen).size;

  // and the count is part of the claim, exactly as it is for the field sweeps: an arm that
  // opened NO dialog would pass this test having measured nothing at all, which is the failure
  // rounds 4 and 7 both caught in this file.
  expect(
    opened,
    'this arm must actually open dialogs — three surfaces that stop offering any would make it '
    + 'pass over an empty measurement, which is the shape this file keeps being caught in',
  ).toBeGreaterThanOrEqual(4);

  // and the DISTINCT dialogs are named in the failure, so a future reader can see which states
  // this arm actually entered rather than trusting a number.
  expect(
    [...new Set(seen)].join(' | '),
    'the Locations manager is the dialog round 8 named, and the first draft of this arm never '
    + 'reached it — so its presence is asserted rather than assumed',
  ).toContain('Locations');
});

/**
 * #584 review round 9 — THE THIRD OPTION, which no sweep in this file could reach.
 *
 * The dialog sweep above deliberately presses nothing INSIDE a dialog, and it is right not to:
 * a modal's own buttons commit, delete and publish. But the decision modal's per-option REMOVE
 * control only exists once there are more than two options, so that rule left a control this
 * unit resized measured by nothing at all.
 *
 * This arm is the narrow, named exception. It presses exactly one control — "+ Add another
 * option" — which adds a blank row and commits nothing, then measures the state that press
 * creates. It is deliberately not folded into the discovery sweep: that arm's value is that it
 * names nothing, and an exception written INTO it would be the beginning of a list again.
 *
 * It asserts REACHABILITY as well as size, because the three-option row is the widest this
 * dialog can be and is therefore where the round-8 regression would reappear.
 */
test('the decision modal holds the floor with a third option, and keeps its controls in reach', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByTestId('more-item-decision-log').click();

  const issue = page.getByTestId('issue-decision');
  await expect(
    issue,
    'this arm measures the ISSUE dialog; if the persona cannot open it the arm would pass having '
    + 'measured nothing, which is the failure this file keeps being caught in',
  ).toBeVisible();
  await issue.click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  // two options are the born state, so the remove control does not exist yet — asserted, so a
  // future change that ships three by default cannot make this arm measure the wrong state.
  await expect(page.getByTestId('dec-opt-0-remove')).toHaveCount(0);

  await dialog.getByRole('button', { name: '+ Add another option' }).click();
  await expect(page.getByTestId('dec-opt-2')).toBeVisible();
  await expect(
    page.getByTestId('dec-opt-2-remove'),
    'the third option is what BRINGS the remove control into existence — if it is absent the '
    + 'press above did not do what this arm claims',
  ).toBeVisible();

  await sweepActionTargets(page, 'decision modal — three options');
});

/**
 * #584 review round 4, finding 2 — the ENTRY ANIMATION may not shrink a pressed control.
 *
 * This arm exists because the fix it guards is invisible to every other arm here: the Daily Log
 * sweep measures a surface `vpop` does not wrap, so the keyframe could regain its `scale()`
 * tomorrow and this file would stay green. It measures the FIRST frames deliberately — no wait
 * for the animation, no frozen motion — because that is the window in which the defect existed:
 * a row scaled to 0.98 renders its 44×44 edit button at ~43.1×43.1 while the thumb is already
 * moving toward it.
 */
test('a schedule row\'s controls hold the 44px floor from their first frame', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('tab-site-schedule').click();

  // the first row to render, measured immediately — `vpop` runs for 300ms and we want this
  // inside that window, so nothing here waits for it to settle.
  const edit = page.locator('[data-testid^="edit-"]').first();
  await expect(edit).toBeVisible();
  const box = await edit.boundingBox();
  expect(box, 'the schedule must render at least one row control to measure').not.toBeNull();
  expect(
    Math.min(box!.width, box!.height),
    `a schedule row control measures ${box!.width}×${box!.height} during its entry animation. `
    + `A transform on the ROW scales its controls with it, so the target is under the 44px floor `
    + `exactly while it is arriving under a thumb — the animation may move the box, never resize it.`,
  ).toBeGreaterThanOrEqual(44);
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
  // #584 review round 7, finding 1 — and the same widening as the shared `INTERACTIVE` above:
  // `textarea` was never listed, and every non-button input type was selected only to be
  // discarded. See the note on the module-level constant for why that carve-out was wrong.
  const INTERACTIVE = [
    'button:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="button"]:not([aria-disabled="true"])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"])',
  ].join(', ');

  // #584 review round 4, finding 2 — MEASURE WHAT THE THUMB MEETS, ANIMATION AND ALL.
  // Round 3 answered a mis-diagnosed "ancestor content scale" by FREEZING animation before every
  // sweep. That was the wrong half of the problem. The scale was not a layout constraint, but it
  // was not harmless either: `vpop` scaled the whole row, so its 44×44 buttons really were
  // ~43.1×43.1 for the first 300ms — undersized exactly while the row is arriving under a thumb
  // reaching for it. Freezing animation stopped this test seeing that and changed nothing for the
  // user. The scale is now gone from the keyframe (`global.css`), and this sweep deliberately does
  // NOT freeze motion, so any future entry animation that shrinks a control is caught here rather
  // than hidden. `translateY` moves a box without resizing it, which is why the rise survives.
  const sweepTargets = async (state: string): Promise<void> => {
    const small = await page.$$eval(INTERACTIVE, (els, eps) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        // DEV-ONLY affordances owe no field floor. The persona switcher renders under `DEV_AUTH`,
        // which is on for the local demo and dev builds and off wherever an API is configured, so
        // no site user ever presses it — but this suite runs the demo build, where it is on screen.
        // The exclusion is a marked subtree rather than a narrowed query, so it stays greppable
        // and anything NEW that appears is swept by default.
        .filter((el) => !el.closest('[data-dev-affordance]'))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: (el.textContent || '').trim().slice(0, 40) || el.getAttribute('aria-label') || '(unlabelled)',
            testid: el.getAttribute('data-testid') || '',
            within: el.closest('[data-testid]')?.getAttribute('data-testid') || el.parentElement?.tagName || '',
            html: el.outerHTML.slice(0, 120),
            // #584 review round 8, finding 1 — raw, for the reason on the shared sweep above.
            w: r.width, h: r.height,
          };
        })
        .filter((b) => b.w > 0 && b.h > 0 && (b.w < 44 - eps || b.h < 44 - eps))
        .map((b) => ({ ...b, w: Math.round(b.w * 10) / 10, h: Math.round(b.h * 10) / 10 })), SUBPIXEL);

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

