import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Live bug 1 — owner live check (#482 6039737806): on the deployed app, Back after opening a record from
 * a notification must return to the screen it was tapped on. Proven here over the REAL stack (signed-in
 * PMC, the seeded Ambli notices), by tapping the notification itself — the test never builds the history
 * it asserts. Runs in every api-e2e read mode.
 */

const PASSWORD = 'vitan123';
const PMC = 'test-pmc@vitan.in';
const API = 'http://localhost:3000';

/**
 * Live bug 1b-3 — issue a checklist through the REAL API as Ambli's PMC, so the inspections writer stamps
 * its notice (1b-3b) and the snapshot serves the stamp. Returns the issued inspection's id and the notice
 * text. Issued here, not seeded: the seeded INSP-21 is approved by `inspections-module-query.spec.ts` in the
 * moduleQuery run, after which the bell correctly reports it unavailable (#738).
 */
async function issueChecklist(request: APIRequestContext): Promise<{ id: string; text: string }> {
  const login = await request.post(`${API}/auth/login`, { data: { email: 'pmc@vitan.in', password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const title = `Bell check ${Date.now()}`;
  const text = `New checklist issued: ${title} — Terrace`;
  const res = await request.post(`${API}/projects/ambli/inspections`, { headers, data: { title, zone: 'Terrace', items: ['Slope to drain'] } });
  expect(res.ok(), `create → ${res.status()}`).toBeTruthy();
  const notices = (await res.json()).notifications as { text: string; inspectionId?: string }[];
  const id = notices.find((n) => n.text === text)?.inspectionId;
  expect(id, 'the writer stamps the notice and the snapshot serves the stamp').toBeTruthy();
  return { id: id!, text };
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

async function openAmbli(page: Page): Promise<void> {
  // the PMC's home is the empty project B; Ambli holds the seeded notices
  const optionA = page.getByRole('group', { name: 'Switch project' }).getByRole('button', { name: /Residence at Ambli/ });
  await expect(async () => {
    if (!(await optionA.isVisible())) await page.getByTestId('project-switcher').click();
    await optionA.click({ timeout: 2000 });
  }).toPass();
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
}

async function tapNotice(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByTestId('notif-item').filter({ hasText: text }).click();
}

test('a notification opens its record, and Back and Forward walk the history the tap made', async ({ page, request }) => {
  const issued = await issueChecklist(request);
  await page.goto('/');
  await signIn(page, PMC);
  await openAmbli(page);
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);

  // decision
  await tapNotice(page, 'Living Room Flooring');
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(/\/projects\/ambli\/decisions\/DL-014$/);
  await expect(page.getByTestId('log-row-DL-014')).toHaveAttribute('aria-current', 'true');

  // inspection — live bug 1b-3: the writer stamped the notice (1b-3b), the snapshot served the stamp, and
  // the bell (#735, #738) opens that inspection on the PMC's review screen, which holds the open checklist
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
  await tapNotice(page, issued.text);
  await expect(page).toHaveURL(new RegExp(`/projects/ambli/review/${issued.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/ambli\/for-you$/);
});
