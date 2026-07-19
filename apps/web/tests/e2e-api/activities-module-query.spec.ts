import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 2 Task 10 (Module 4 — Activities) — the activities MODULE-OWNED read, proven end-to-end over
 * the REAL stack (NestJS + PostgreSQL + the web app) with the web app running in `moduleQuery` mode
 * (VITE_ACTIVITIES_READ=moduleQuery, forwarded by the runner). This spec runs ONLY in that mode; the
 * default 'snapshot' runs skip it (the activity spine rides the snapshot there and never calls the
 * module endpoint).
 *
 * It proves the module path end-to-end:
 *   • the activity spine (`activities` + `phases`) is populated by the module-owned
 *     `GET …/activities` (not the snapshot), fetched under the same scope lease as the snapshot on
 *     load — the Site Schedule renders the seeded phases + rows from it;
 *   • the PMC's plan-activity command carries the Task-5 `Idempotency-Key` header and the module-owned
 *     read is REFETCHED under the same scope (finding 2), so the committed change becomes visible
 *     WITHOUT a page reload — the newly planned activity appears on the schedule.
 *
 * This proof is DETERMINISTIC and UNCONDITIONAL: the schedule render is anchored on the hard seed
 * fixture (`SEED_ACTIVITIES` ACT-28 "Waterproofing — Terrace" in phase "Services & Waterproofing"),
 * and the command is a plan-activity CREATE — always permitted for the PMC, with no gate/readiness
 * precondition that could let the flow silently skip.
 *
 * Seed accounts (scripts/test-api-e2e.sh): `test-pmc@vitan.in` is a PMC on project A `ambli`.
 */

const MQ = process.env.E2E_ACTIVITIES_READ === 'moduleQuery';
const A = 'ambli';
const PASSWORD = 'vitan123';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test.describe('activities module-owned read (moduleQuery)', () => {
  test.skip(!MQ, 'runs only under VITE_ACTIVITIES_READ=moduleQuery (E2E_ACTIVITIES_READ=moduleQuery)');

  test('the module-owned GET serves the activity spine under the same scope lease', async ({ page }) => {
    const activityGETs: string[] = [];
    const createPOSTs: { url: string; idem: string | undefined }[] = [];
    page.on('request', (r) => {
      const u = r.url();
      // the module read is GET /projects/:id/activities — the create POST shares the path (method
      // disambiguates) and the /activities/:id/start|complete sub-paths never match (\?|$)
      if (r.method() === 'GET' && new RegExp(`/projects/${A}/activities(\\?|$)`).test(u)) activityGETs.push(u);
      if (r.method() === 'POST' && new RegExp(`/projects/${A}/activities(\\?|$)`).test(u)) {
        createPOSTs.push({ url: u, idem: r.headers()['idempotency-key'] });
      }
    });

    await page.goto('/');
    await signIn(page, 'test-pmc@vitan.in');
    // switch to Project A (the PMC's home may be B) if the switcher isn't already there. Wait for a
    // REAL project name first (hydration), then retry the open-and-pick as one unit: a post-sign-in
    // re-render can close the dropdown between the two clicks, which strands a single-shot sequence
    // waiting on an option that no longer exists (observed deterministically on slow containers).
    const switcher = page.getByTestId('project-switcher');
    await expect(switcher).toContainText(/Residence at Ambli|Test Empty Site/);
    if (!(await switcher.textContent())?.includes('Residence at Ambli')) {
      const option = page.getByRole('button', { name: /Residence at Ambli/ });
      await expect(async () => {
        if (!(await option.isVisible())) await switcher.click();
        await option.click({ timeout: 2000 });
      }).toPass();
    }
    await expect(switcher).toContainText('Residence at Ambli');

    // the module-owned GET is fetched alongside the snapshot on load — proving moduleQuery is live
    await expect
      .poll(() => activityGETs.length, { message: 'the activity spine is served by the module read, not the snapshot' })
      .toBeGreaterThan(0);

    // onto the Site Schedule screen — the module-served spine renders: the seeded activity row
    // (ACT-28) and its phase group ("Services & Waterproofing") are ALWAYS present in the seed.
    await page.getByRole('button', { name: 'Site Schedule' }).click();
    await expect(page.getByTestId('sched-ACT-28'), 'the seeded activity renders from the module read').toBeVisible();
    await expect(page.getByText('Services & Waterproofing')).toBeVisible();

    // command round-trip: the PMC plans a NEW activity (deterministic — no gate precondition), the
    // create POST carries the Task-5 Idempotency-Key, and the module read reconciles afterwards.
    const getsBefore = activityGETs.length;
    await page.getByTestId('plan-activity').click();
    await page.getByTestId('act-name').fill('E2E Module Activity');
    const createDone = page.waitForResponse((r) => new RegExp(`/projects/${A}/activities(\\?|$)`).test(r.url()) && r.request().method() === 'POST' && r.status() < 400);
    await page.getByTestId('save-activity').click();
    await createDone;

    // the create command executed and carried the Task-5 Idempotency-Key
    expect(createPOSTs.length, 'the create POST executed').toBeGreaterThan(0);
    expect(createPOSTs[0].idem, 'the create command carries an Idempotency-Key header').toBeTruthy();

    // a post-command module refetch fires under the same scope (finding 2 reconcile)…
    await expect.poll(() => activityGETs.length, { message: 'a post-command module refetch must fire' }).toBeGreaterThan(getsBefore);
    // …and the planned activity appears WITHOUT a page reload — served by the module read (the
    // command's own snapshot slice never lands under XOR). `exact` avoids also matching the
    // "Planned: …" success toast.
    await expect(page.getByText('E2E Module Activity', { exact: true })).toBeVisible();
  });
});
