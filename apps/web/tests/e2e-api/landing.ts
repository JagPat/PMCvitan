import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * #811 — sign-in opens the project a user last switched into, while they still hold it. The specs share
 * one seeded database (serial, one worker), so where a user lands depends on which earlier spec switched
 * them last. A spec that needs a particular project therefore asks for it here instead of assuming the
 * user's home: these helpers are no-ops when the user already landed there.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';

export interface Session {
  token: string;
  projectId: string;
  role: string;
}

/** Sign in through the API and hold a token for `projectId` (switching to it when sign-in landed elsewhere). */
export async function loginTo(request: APIRequestContext, email: string, projectId: string): Promise<Session> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  const session = (await res.json()) as Session;
  if (session.projectId === projectId) return session;
  const sw = await request.post(`${API}/auth/switch`, {
    headers: { Authorization: `Bearer ${session.token}` },
    data: { projectId },
  });
  expect(sw.ok(), `switch ${email} → ${projectId}: ${sw.status()}`).toBeTruthy();
  return (await sw.json()) as Session;
}

/**
 * After a browser sign-in, put the switcher on the project named `name`. Waits for a real project name first
 * (hydration), then retries open-and-pick as one unit: a post-sign-in re-render can close the dropdown
 * between the two clicks.
 */
export async function openProject(page: Page, name: string): Promise<void> {
  const switcher = page.getByTestId('project-switcher');
  await expect(switcher).toContainText(/\S/);
  if (!(await switcher.textContent())?.includes(name)) {
    const option = page.getByRole('group', { name: 'Switch project' }).getByRole('button', { name: new RegExp(name) });
    await expect(async () => {
      if (!(await option.isVisible())) await switcher.click();
      await option.click({ timeout: 2000 });
    }).toPass();
  }
  await expect(switcher).toContainText(name);
}

/** Sign in through the browser's email + password form. One shared copy, so a change to the sign-in screen
 *  updates every spec that uses it. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.getByTestId('go-login').click();
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

/**
 * #482 6227430525 — the tab keeps a signed-in session across a reload, so a `page.goto` in the middle of a spec
 * no longer signs the previous user out by itself. This opens `path` signed out, as every spec here expects
 * before its next sign-in: it forgets the tab's saved session and, when there was one, opens the page again.
 */
export async function gotoSignedOut(page: Page, path: string): Promise<void> {
  await page.goto(path);
  const hadSession = await page.evaluate(() => {
    const had = sessionStorage.getItem('vitan.session.v1') !== null;
    sessionStorage.removeItem('vitan.session.v1');
    return had;
  });
  if (hadSession) await page.goto(path);
}
