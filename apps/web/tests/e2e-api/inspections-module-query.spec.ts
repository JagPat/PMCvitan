import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 2 Task 10 (Module 3 — Inspections) — the inspections MODULE-OWNED read, proven end-to-end over
 * the REAL stack (NestJS + PostgreSQL + the web app) with the web app running in `moduleQuery` mode
 * (VITE_INSPECTIONS_READ=moduleQuery, forwarded by the runner). This spec runs ONLY in that mode; the
 * default 'snapshot' runs skip it (the inspection slices ride the snapshot there and never call the
 * module endpoint).
 *
 * It proves the module path end-to-end:
 *   • the inspection slices are populated by the module-owned `GET …/inspections` (not the snapshot),
 *     fetched under the same scope lease as the snapshot on load;
 *   • the PMC's decide command carries the Task-5 `Idempotency-Key` header and the module-owned read is
 *     REFETCHED under the same scope (finding 2), so the committed change becomes visible WITHOUT a page
 *     reload — the decided review LEAVES the queue.
 *
 * Task 10 (Module 3) CORRECTION — this proof is now DETERMINISTIC and UNCONDITIONAL. The pending review is
 * a hard seed fixture (`SEED_INSPECTIONS` INSP-21 "Waterproofing Ponding Test", submitted + undecided, the
 * ONLY pending review on project A), so the decide flow always runs — the earlier `if (approve.count())`
 * guard (which let an empty queue silently skip the whole assertion) is removed.
 *
 * Seed accounts (scripts/test-api-e2e.sh): `test-pmc@vitan.in` is a PMC on project A `ambli`.
 */

const MQ = process.env.E2E_INSPECTIONS_READ === 'moduleQuery';
const A = 'ambli';
const PASSWORD = 'vitan123';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test.describe('inspections module-owned read (moduleQuery)', () => {
  test.skip(!MQ, 'runs only under VITE_INSPECTIONS_READ=moduleQuery (E2E_INSPECTIONS_READ=moduleQuery)');

  test('the module-owned GET serves the inspection slices under the same scope lease', async ({ page }) => {
    const inspectionGETs: string[] = [];
    const decidePOSTs: { url: string; idem: string | undefined }[] = [];
    page.on('request', (r) => {
      const u = r.url();
      // the module read is GET /projects/:id/inspections — NOT the /inspections/:id/submit|decide sub-paths
      if (r.method() === 'GET' && new RegExp(`/projects/${A}/inspections(\\?|$)`).test(u)) inspectionGETs.push(u);
      if (r.method() === 'POST' && u.includes(`/projects/${A}/inspections/`) && u.endsWith('/decide')) {
        decidePOSTs.push({ url: u, idem: r.headers()['idempotency-key'] });
      }
    });

    await page.goto('/');
    await signIn(page, 'test-pmc@vitan.in');
    // switch to Project A (the PMC's home may be B) if the switcher isn't already there
    const switcher = page.getByTestId('project-switcher');
    if (!(await switcher.textContent())?.includes('Residence at Ambli')) {
      await switcher.click();
      await page.getByRole('button', { name: /Residence at Ambli/ }).click();
    }
    await expect(switcher).toContainText('Residence at Ambli');

    // the module-owned GET is fetched alongside the snapshot on load — proving moduleQuery is live
    await expect
      .poll(() => inspectionGETs.length, { message: 'the inspection slices are served by the module read, not the snapshot' })
      .toBeGreaterThan(0);

    // onto the Inspection Review screen (PMC review queue). The seeded pending review (INSP-21) is
    // ALWAYS present, so we decide it unconditionally and prove the module path end-to-end.
    await page.getByRole('button', { name: 'Inspection Review' }).click();
    const approve = page.getByRole('button', { name: 'Approve Inspection' });
    // deterministic: the seed guarantees a pending review, so the decide control is present (no guard).
    await expect(approve, 'the seeded pending review (INSP-21) is in the PMC queue').toBeVisible();

    const getsBefore = inspectionGETs.length;
    const decideDone = page.waitForResponse((r) => r.url().includes(`/projects/${A}/inspections/`) && r.url().endsWith('/decide') && r.request().method() === 'POST' && r.status() < 400);
    await approve.click();
    await decideDone;

    // the decide command executed and carried the Task-5 Idempotency-Key
    expect(decidePOSTs.length, 'the decide POST executed').toBeGreaterThan(0);
    expect(decidePOSTs[0].idem, 'the decide command carries an Idempotency-Key header').toBeTruthy();

    // a post-command module refetch fires under the same scope (finding 2 reconcile)…
    await expect.poll(() => inspectionGETs.length, { message: 'a post-command module refetch must fire' }).toBeGreaterThan(getsBefore);
    // …and the decided review LEAVES the queue without a page reload — the ONLY pending review is gone,
    // so the module-owned read now serves the empty state (the decision is visible, not stale).
    await expect(page.getByText('No inspections awaiting review.')).toBeVisible();
  });
});
