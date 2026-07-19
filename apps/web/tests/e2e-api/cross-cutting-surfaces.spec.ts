import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 2 Task 10 FINALIZATION — the three CROSS-CUTTING surfaces (Inbox "For You", Dashboard,
 * Portfolio) proven end-to-end with EVERY module read in `moduleQuery` mode simultaneously
 * (VITE_DECISIONS/DAILYLOG/DRAWINGS/INSPECTIONS/ACTIVITIES_READ=moduleQuery — the
 * `test:e2e:api:allmodules(:outbox)` runners).
 *
 * This is the plan's Task-10 done criterion made concrete for the shipped architecture: the
 * cross-cutting surfaces are NOT separate cross-module projection bases (that shape is exactly the
 * silently-stale-foreign-fact class the Module-3/4 corrections removed) — they COMPOSE module-owned
 * reads, each of which is served from that module's own rebuildable projection when its generation
 * is servable and from the byte-identical live slice otherwise:
 *   • Inbox + Dashboard compose CLIENT-SIDE over the module-read-fed store slices (the plan's
 *     "module-owned frontend query boundaries replacing the single store + full snapshot");
 *   • Portfolio composes SERVER-SIDE over the module query contracts
 *     (`activities.statusCounts` + `inspections.openInspectionCount` + RBAC-gated
 *     `decisions.countPending`) — the boundary analyzer forbids any direct cross-module ORM read.
 *
 * The spec pins BOTH halves: (a) all five module GETs actually serve the session (request-level
 * proof that every module read owns its surface at once), and (b) the three surfaces render
 * consistent, canonical-derived data from them — the pending-decisions count agrees byte-for-byte
 * across the decisions module read, the Inbox action item, and the Dashboard tile.
 *
 * Seed accounts (scripts/test-api-e2e.sh): `test-pmc@vitan.in` is a PMC on project A `ambli`.
 */

const ALL_MODULES =
  process.env.E2E_DECISIONS_READ === 'moduleQuery' &&
  process.env.E2E_DAILYLOG_READ === 'moduleQuery' &&
  process.env.E2E_DRAWINGS_READ === 'moduleQuery' &&
  process.env.E2E_INSPECTIONS_READ === 'moduleQuery' &&
  process.env.E2E_ACTIVITIES_READ === 'moduleQuery';
const A = 'ambli';
const PASSWORD = 'vitan123';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test.describe('cross-cutting surfaces under all-module reads', () => {
  test.skip(!ALL_MODULES, 'runs only when ALL five module reads are in moduleQuery mode (test:e2e:api:allmodules)');

  test('Inbox, Dashboard and Portfolio render from the module-owned reads, consistently', async ({ page }) => {
    const moduleGETs = new Set<string>();
    let decisionsPayload: { decisions?: { status?: string; draft?: boolean }[] } | null = null;
    page.on('response', async (r) => {
      const m = r.request().method();
      if (m !== 'GET') return;
      const u = new URL(r.url());
      const match = u.pathname.match(new RegExp(`^/projects/${A}/(decisions|daily-log|drawings|inspections|activities)$`));
      if (!match || !r.ok()) return;
      moduleGETs.add(match[1]!);
      if (match[1] === 'decisions') {
        try {
          decisionsPayload = (await r.json()) as typeof decisionsPayload;
        } catch {
          /* a navigated-away response body is unreadable — a later fetch will supply it */
        }
      }
    });

    await page.goto('/');
    await signIn(page, 'test-pmc@vitan.in');
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

    // (a) request-level proof: ALL FIVE module-owned GETs served this session's project scope.
    await expect
      .poll(() => [...moduleGETs].sort().join(','), { message: 'all five module reads must own their surfaces' })
      .toBe('activities,daily-log,decisions,drawings,inspections');
    expect(decisionsPayload).not.toBeNull();
    // the same weightless-draft rule the web selectors and the server's countPending apply
    const pendingFromModuleRead = (decisionsPayload!.decisions ?? []).filter((d) => d.status === 'pending' && !d.draft).length;
    expect(pendingFromModuleRead).toBeGreaterThan(0); // the seed carries pending decisions on ambli

    // (b) INBOX — the PMC action queue derives from those module reads: the pending-decisions item
    // carries the SAME count the decisions module read served.
    await page.getByRole('button', { name: 'For You' }).click();
    await expect(page.getByTestId('inbox-item-pmc-pending')).toContainText(
      `${pendingFromModuleRead} decision${pendingFromModuleRead === 1 ? '' : 's'} awaiting the client`,
    );

    // DASHBOARD — the pending tile shows the same module-read-served count.
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByTestId('tile-pending-value')).toHaveText(String(pendingFromModuleRead));
    // the review tile renders a number (inspections module read serving the review queue)
    await expect(page.getByTestId('tile-review-value')).toHaveText(/^\d+$/);

    // PORTFOLIO — the server-side composition over module query contracts: both seeded projects
    // roll up, and the ambli card's pending-decisions stat EQUALS the module-read count. This pins
    // the weightless-draft rule across surfaces: the seeded author-private draft (DL-015, status
    // pending, unpublished) must not inflate the portfolio count the way the pre-finalization
    // countPending did (it counted drafts; shell/dashboard/inbox all excluded them).
    await page.getByRole('button', { name: 'Portfolio' }).click();
    await expect(page.getByTestId(`portfolio-${A}`)).toBeVisible();
    await expect(page.getByTestId('portfolio-test-empty-site')).toBeVisible();
    await expect(page.getByTestId(`portfolio-${A}-decisions`)).toHaveText(`${pendingFromModuleRead} decisions`);
  });
});
