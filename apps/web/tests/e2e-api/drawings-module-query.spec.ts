import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 2 Task 10 (Module 2 — Drawings) — the drawings MODULE-OWNED read, proven end-to-end over the
 * REAL stack (NestJS + PostgreSQL + the web app) with the web app running in `moduleQuery` mode
 * (VITE_DRAWINGS_READ=moduleQuery, forwarded by the runner). This spec runs ONLY in that mode; the
 * default 'snapshot' runs skip it (the drawing register rides the snapshot there and never calls the
 * module endpoint).
 *
 * It proves the controlled-drawing lifecycle through the module path:
 *   • the drawing register is populated by the module-owned `GET …/drawings` (not the snapshot);
 *   • a controlled command carries the Task-5 `Idempotency-Key` header;
 *   • after the command, the module-owned read is REFETCHED under the same scope (finding 2), so the
 *     committed change becomes visible without a page reload.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): Project A `ambli` carries drawing A-201 (Ground Floor Plan,
 * a published `for_construction` Rev A); `test-eng@vitan.in` is an active engineer on A (home there);
 * `test-pmc@vitan.in` is a PMC on both A and B (home B). Password is the seed default.
 */

const MQ = process.env.E2E_DRAWINGS_READ === 'moduleQuery';
const A = 'ambli';
const PASSWORD = 'vitan123';

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

test.describe('drawings module-owned read (moduleQuery)', () => {
  test.skip(!MQ, 'runs only under VITE_DRAWINGS_READ=moduleQuery (E2E_DRAWINGS_READ=moduleQuery)');

  test('the module read owns the register; acknowledge carries an idempotency key and reconciles', async ({ page }) => {
    const drawingGETs: string[] = [];
    const ackPOSTs: { url: string; idem: string | undefined }[] = [];
    page.on('request', (r) => {
      const u = r.url();
      // the module read is GET /projects/:id/drawings — NOT the /drawings/rev/:id/ack sub-path
      if (r.method() === 'GET' && new RegExp(`/projects/${A}/drawings(\\?|$)`).test(u)) drawingGETs.push(u);
      if (r.method() === 'POST' && u.includes(`/projects/${A}/drawings/rev/`) && u.endsWith('/ack')) {
        ackPOSTs.push({ url: u, idem: r.headers()['idempotency-key'] });
      }
    });

    await page.goto('/');
    await signIn(page, 'test-eng@vitan.in');
    await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');

    // the module-owned GET is fetched alongside the snapshot on load — proving moduleQuery is live
    await expect
      .poll(() => drawingGETs.length, { message: 'the drawing register is served by the module read, not the snapshot' })
      .toBeGreaterThan(0);

    // onto the Drawings register — the seeded A-201 renders (served by the module read)
    await page.getByRole('button', { name: 'Drawings' }).click();
    await expect(page.getByText('DRAWINGS · REGISTER')).toBeVisible();
    await expect(page.getByTestId('drawing-A-201')).toBeVisible();

    // open A-201 and acknowledge building to its current revision — the command carries an
    // Idempotency-Key and triggers a module-read reconcile
    const getsBefore = drawingGETs.length;
    await page.getByTestId('drawing-A-201').click();
    await expect(page.getByText(/BUILDING TO REV A/)).toBeVisible();
    const ackDone = page.waitForResponse((r) => r.url().includes(`/projects/${A}/drawings/rev/`) && r.url().endsWith('/ack') && r.request().method() === 'POST' && r.status() < 400);
    await page.getByTestId('ack-drawing').click();
    await ackDone;

    // the acknowledge command carried the Task-5 idempotency key
    expect(ackPOSTs.length).toBeGreaterThan(0);
    expect(ackPOSTs[0].idem, 'the acknowledge command carries an Idempotency-Key header').toBeTruthy();

    // the module read is refetched under the same scope after the command…
    await expect.poll(() => drawingGETs.length, { message: 'a post-command module refetch must fire' }).toBeGreaterThan(getsBefore);
    // …and the confirmation replaces the button (the field is now building to Rev A)
    await expect(page.getByText(/You’re building to Rev A/)).toBeVisible();
  });

  test('issuing a drawing carries an idempotency key and the module read surfaces it', async ({ page }) => {
    const drawingGETs: string[] = [];
    const issuePOSTs: { url: string; idem: string | undefined }[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (r.method() === 'GET' && new RegExp(`/projects/${A}/drawings(\\?|$)`).test(u)) drawingGETs.push(u);
      // the issue command is POST /projects/:id/drawings (exact — not the publish/ack sub-paths)
      if (r.method() === 'POST' && new RegExp(`/projects/${A}/drawings(\\?|$)`).test(u)) {
        issuePOSTs.push({ url: u, idem: r.headers()['idempotency-key'] });
      }
    });

    await page.goto('/');
    await signIn(page, 'test-pmc@vitan.in'); // home = B
    await expect(page.getByTestId('project-switcher')).toContainText('Test Empty Site');
    // switch to Project A (where the register lives) — one-unit open-and-pick retry (a re-render
    // can close the dropdown between the two one-shot clicks and swallow the pick)
    const optionA = page.getByRole('button', { name: /Residence at Ambli/ });
    await expect(async () => {
      if (!(await optionA.isVisible())) await page.getByTestId('project-switcher').click();
      await optionA.click({ timeout: 2000 });
    }).toPass();
    await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');

    await page.getByRole('button', { name: 'Drawings' }).click();
    await expect(page.getByText('DRAWINGS · REGISTER')).toBeVisible();
    await expect.poll(() => drawingGETs.length).toBeGreaterThan(0);
    const getsBefore = drawingGETs.length;

    // issue a NEW controlled drawing (publish immediately) via the Issue modal
    await page.getByTestId('issue-drawing').click();
    await page.getByPlaceholder('Number (A-201)').fill('E-901');
    await page.getByPlaceholder('Rev').fill('A');
    await page.getByPlaceholder('Title').fill('E2E Module Drawing');
    await page.locator('input[type="file"]').setInputFiles({ name: 'e901.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e drawing fixture') });
    const issueDone = page.waitForResponse((r) => new RegExp(`/projects/${A}/drawings(\\?|$)`).test(r.url()) && r.request().method() === 'POST' && r.status() < 400);
    await page.getByTestId('publish-drawing').click();
    await issueDone;

    // the issue command carried the Task-5 idempotency key
    expect(issuePOSTs.length).toBeGreaterThan(0);
    expect(issuePOSTs[0].idem, 'the issue command carries an Idempotency-Key header').toBeTruthy();

    // the module read is refetched after the command and the new drawing appears in the register
    await expect.poll(() => drawingGETs.length, { message: 'a post-issue module refetch must fire' }).toBeGreaterThan(getsBefore);
    await expect(page.getByTestId('drawing-E-901')).toBeVisible();
  });
});
