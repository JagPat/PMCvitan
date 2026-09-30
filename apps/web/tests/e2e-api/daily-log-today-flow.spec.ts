import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * #669 — the engineer's Today flow over the REAL stack (Field Lab QA 2026-09-30 regression). The server
 * persists check-in, crew and the photo count only with the SEND; until then they are the client's. Every
 * other write on the way to Send — a material recorded, a progress photo uploaded — reconciles the store
 * from the server, and before this correction that reconcile REPLACED the log with the server's unsent
 * values: the engineer was back at "Check in", the crew back to the seed, and Today never reached Send.
 *
 * This journey is the one QA ran: check in from Today, count one more mason, record a material, take a
 * photo, reload, and Send — proving after each reconcile (and the reload) that the day is where the
 * engineer left it, and proving against the server that the send carried exactly that day. Runs in
 * every api-e2e mode (snapshot + moduleQuery, legacy + outbox senders).
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `test-eng@vitan.in` is an active engineer on `ambli`, whose
 * seeded log is UNSENT and not checked in, with 10 workers across five trades and 2 progress photos.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const A = 'ambli';
const ENG = 'test-eng@vitan.in';

// the smallest bytes that read as a JPEG (SOI, a bare JFIF header, EOI); no EXIF, so no capture stamp
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64');

async function signIn(page: Page, email: string): Promise<void> {
  // an engineer lands in Gujarati; this journey names English screens, so the member chooses
  // English on the gate's own picker, which is carried into their session and saved
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: /team member/i }).click();
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}
async function apiLogin(request: APIRequestContext, email: string): Promise<{ token: string }> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return res.json();
}
type ServerLog = { checkedIn: boolean; submitted: boolean; progress: number; crew: { trade: string; count: number }[]; photos: unknown[] };
type Snapshot = { dailyLog: ServerLog | null; materials: { name: string }[] };
async function serverSnapshot(request: APIRequestContext, token: string): Promise<Snapshot> {
  const res = await request.get(`${API}/projects/${A}/snapshot`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `snapshot → ${res.status()}`).toBeTruthy();
  return res.json();
}

test('Today reaches Send: check-in, crew and photos survive the material and photo reconciles and a reload', async ({ page, request }) => {
  const MAT = `TodayFlow-${test.info().workerIndex}-${test.info().retry}`;
  const eng = await apiLogin(request, ENG);
  const seeded = await serverSnapshot(request, eng.token);
  expect(seeded.dailyLog, 'the seeded ambli log').toMatchObject({ checkedIn: false, submitted: false });
  const seededPhotos = seeded.dailyLog!.photos.length;

  await page.goto('/');
  await signIn(page, ENG);
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');

  // For You is the engineer's home: Today reads the seeded unsent log — the first step is to check in
  const now = page.getByTestId('today-now');
  await expect(now).toHaveAttribute('data-action', 'checkIn');
  await expect(page.getByTestId('today-step-checkIn')).toHaveAttribute('data-state', 'next');
  // the seed's log carries an EARLIER civil date than the site's today, so Today names it as overdue
  await expect(page.getByTestId('today-overdue')).toBeVisible();

  // 1. check in from Today. The seed's crew (10 workers) and photos (2) already count, so Send is what's left.
  await page.getByTestId('today-action').click();
  await expect(page.getByTestId('today-step-checkIn')).toHaveAttribute('data-state', 'done');
  await expect(now).toHaveAttribute('data-action', 'send');
  await expect(page.getByTestId('today-count')).toHaveText('3 of 4 done');

  // 2. onto the Site screen: one more Flooring mason, then a material — the write that used to reset the day
  await page.getByRole('button', { name: /Daily Site Log/i }).click();
  await expect(page.getByText('Italian Marble (Botticino)')).toBeVisible();
  await expect(page.getByTestId('check-out')).toBeVisible(); // checked in
  await expect(page.getByTestId('crew-total')).toHaveText('10 workers');
  await page.getByRole('button', { name: 'Add Flooring mason' }).click();
  await expect(page.getByTestId('crew-total')).toHaveText('11 workers');
  await expect(page.getByText('2 progress photos')).toBeVisible();

  await page.getByTestId('add-material').click();
  await page.getByTestId('mat-name').fill(MAT);
  await page.getByTestId('mat-qty').fill('3 units');
  await page.getByTestId('save-material').click();
  // the recorded row (the success toast names the material too, so the first match is asserted, not the only one)
  await expect(page.getByText(MAT).first()).toBeVisible(); // the command's reply reconciled the log from the server
  // proven against the server: the material landed, and the server's log is STILL unsent and not checked in
  await expect
    .poll(async () => (await serverSnapshot(request, eng.token)).materials.filter((m) => m.name === MAT).length, { timeout: 10_000 })
    .toBe(1);
  expect((await serverSnapshot(request, eng.token)).dailyLog).toMatchObject({ checkedIn: false, submitted: false });
  // …and the screen kept the morning (the regression: "Check in" again, 10 workers)
  await expect(page.getByTestId('check-out')).toBeVisible();
  await expect(page.getByTestId('crew-total')).toHaveText('11 workers');
  await expect(page.getByText('2 progress photos')).toBeVisible();

  // 3. a progress photo: the upload's own `changed` broadcast refreshes the snapshot from the server too
  await page.getByTestId('progress-file').setInputFiles({ name: 'site.jpg', mimeType: 'image/jpeg', buffer: JPEG });
  await expect(page.getByText('3 progress photos')).toBeVisible();
  await expect
    .poll(async () => (await serverSnapshot(request, eng.token)).dailyLog!.photos.length, { timeout: 10_000, message: 'the server holds the photo' })
    .toBe(seededPhotos + 1);
  // the server's own count is still the seed's 2 (persisted only with the send) — the screen keeps 3
  expect((await serverSnapshot(request, eng.token)).dailyLog).toMatchObject({ progress: 2, checkedIn: false });
  await expect(page.getByText('3 progress photos')).toBeVisible();
  await expect(page.getByTestId('crew-total')).toHaveText('11 workers');
  await expect(page.getByTestId('check-out')).toBeVisible();

  // 4. a reload drops the in-memory token, so the engineer signs in again — and the day is where they
  //    left it: the deep link brings the Site screen back, with the morning on it, and Today agrees
  await page.reload();
  await signIn(page, ENG);
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  await expect(page.getByTestId('check-out')).toBeVisible();
  await expect(page.getByTestId('crew-total')).toHaveText('11 workers');
  await expect(page.getByText('3 progress photos')).toBeVisible();
  await page.getByRole('button', { name: 'For You' }).click();
  await expect(now).toHaveAttribute('data-action', 'send');
  await expect(page.getByTestId('today-step-checkIn')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('today-count')).toHaveText('3 of 4 done');

  // 5. Send from Today — the fourth step, which the regression never let the engineer reach
  await page.getByTestId('today-action').click();
  // proven against the server: the send carried exactly the engineer's day — checked in, 11 workers
  // (Flooring mason 3), 3 photos — and nothing was counted twice
  await expect
    .poll(async () => (await serverSnapshot(request, eng.token)).dailyLog?.submitted, { timeout: 10_000 })
    .toBe(true);
  const sent = (await serverSnapshot(request, eng.token)).dailyLog!;
  expect(sent).toMatchObject({ submitted: true, checkedIn: true, progress: 3 });
  expect(sent.crew.find((c) => c.trade === 'Flooring mason')?.count).toBe(3);
  expect(sent.crew.reduce((n, c) => n + c.count, 0)).toBe(11);
  // the log sent was an EARLIER day's, so once it is with PMC it is history: Today offers to start
  // today's log (never "done" for a day that has not begun), and no step of the sent log is shown as
  // today's — the same rule the unit tests pin for todayPath
  await expect(now).toHaveAttribute('data-action', 'start');
  await expect(page.getByTestId('today-overdue')).toHaveCount(0);

  // a second tap never sends twice: the Site screen holds the sent log read-only and offers a new day
  await page.getByRole('button', { name: /Daily Site Log/i }).click();
  await expect(page.getByTestId('submit-daily-log')).toBeDisabled();
  await expect(page.getByTestId('start-new-day')).toBeVisible();
});
