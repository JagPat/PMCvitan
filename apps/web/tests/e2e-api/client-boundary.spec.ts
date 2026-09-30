import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B1 — the client boundary over the REAL stack, probed with the six reservation
 * doors STANDING (§A.2: "the boundary probed BEFORE the role is enabled"). Every request the app makes
 * to the API — the public sign-in, the shell, the snapshot, the module reads — declares
 * `x-vitan-decisions-contract: countersign-v1`, and none still declares the 4b `recorded-v1`; and the
 * shell the app reads reports `rollout.phase6_4d = 'reserved'`, which is what every later client gate
 * on an architect shape will read until 4d-iii drops the doors. Runs in every api-e2e mode.
 *
 * The realtime socket (`/socket.io/`) is a transport, not an API fetch, and static resources carry no
 * request headers of ours; only fetch/XHR requests to the API are the boundary's subject.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const A = 'ambli';
const ENG = 'test-eng@vitan.in';

async function signIn(page: Page, email: string): Promise<void> {
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

test('every API-bound request declares countersign-v1, and the shell reads rollout.phase6_4d = reserved', async ({ page, request }) => {
  const apiRequests: { url: string; contract: string | undefined }[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(API) || u.includes('/socket.io/')) return;
    if (r.resourceType() !== 'fetch' && r.resourceType() !== 'xhr') return;
    apiRequests.push({ url: u, contract: r.headers()['x-vitan-decisions-contract'] });
  });

  await page.goto('/');
  await signIn(page, ENG);
  await expect(page.getByTestId('project-switcher')).toContainText('Residence at Ambli');
  // the engineer's home (Today) has settled — the post-sign-in route lands before we navigate away
  await expect(page.getByTestId('engineer-today')).toBeVisible();
  // walk one more surface so a command-free navigation's reads are on the wire too
  await page.getByRole('button', { name: /Daily Site Log/i }).click();
  await expect(page.getByTestId('crew-total')).toBeVisible();

  // the app has made the public sign-in, the shell and the snapshot at least
  const paths = apiRequests.map((r) => new URL(r.url).pathname);
  expect(paths).toContain('/auth/login');
  expect(paths).toContain(`/projects/${A}/shell`);
  expect(paths.some((p) => p === `/projects/${A}/snapshot`)).toBe(true);
  // …and EVERY one of them declared the contract with the server's exact value
  const undeclared = apiRequests.filter((r) => r.contract !== 'countersign-v1');
  expect(undeclared, `API requests without countersign-v1: ${undeclared.map((r) => `${r.url} → ${r.contract}`).join(', ')}`).toEqual([]);
  expect(apiRequests.some((r) => r.contract === 'recorded-v1')).toBe(false);

  // the shell the app read reports the doors STANDING — the value every client gate reads
  const eng = await apiLogin(request, ENG);
  const shell = await request.get(`${API}/projects/${A}/shell`, {
    headers: { Authorization: `Bearer ${eng.token}`, 'x-vitan-decisions-contract': 'countersign-v1' },
  });
  expect(shell.ok()).toBeTruthy();
  expect((await shell.json()).rollout).toEqual({ phase6_4d: 'reserved' });
});
