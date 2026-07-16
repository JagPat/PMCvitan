import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * PR C Task 5 — the mode-invariant SYNCHRONOUS-consequence assertions, run in BOTH sender modes
 * (`test:e2e:api:legacy` and `test:e2e:api:outbox`). What this suite proves is that the durable,
 * in-transaction consequences a browser reads back are IDENTICAL whichever sender owns external
 * dispatch:
 *
 *   - a private DRAFT decision stays invisible to the client and notifies no one;
 *   - a PUBLISHED decision reaches the client and records EXACTLY one notification;
 *   - a keyed RETRY of the publish is a replay — no duplicate decision row, no second notice.
 *
 * SCOPE (honest): every assertion reads the DB snapshot, and the `Notification` row + the decision
 * row are written INSIDE the command transaction — synchronous in either mode — so this validates
 * the exactly-once command effect (the idempotency ledger) and draft privacy, mode-agnostically. It
 * does NOT observe the ASYNCHRONOUS external delivery (the socket invalidation / Web Push), which is
 * not surfaced through the API; that path — the relay as the sole sender after the outbox cutover,
 * and the legacy dispatcher's lease-coordinated send + at-least-once retry — is covered by the
 * unit/integration suites (external-effect-dispatcher.test.ts + outbox.test.ts over live PG).
 *
 * Pure API (the same contracts the UI calls); it shares the seeded database with the pillar chain
 * (serial, one worker) and uses run-unique titles in the seeded `ambli` project so it never
 * collides with the other suites.
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const PID = 'ambli';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const OPTIONS = [
  { label: 'A', material: 'A', delta: 0, swatch: 's1', recommended: true },
  { label: 'B', material: 'B', delta: 1, swatch: 's2', recommended: false },
];

async function login(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return (await res.json()).token;
}
async function snapshot(request: APIRequestContext, token: string): Promise<{
  decisions: Array<{ title: string }>;
  notifications: Array<{ text: string }>;
}> {
  const res = await request.get(`${API}/projects/${PID}/snapshot`, { headers: bearer(token) });
  expect(res.ok(), `snapshot → ${res.status()}`).toBeTruthy();
  return res.json();
}

test.describe('PR C dual-mode: exactly-one external consequence (mode-agnostic)', () => {
  const uniq = `DM-${Date.now()}`;
  let pmc = '';
  let client = '';

  test.beforeAll(async ({ request }) => {
    pmc = await login(request, 'pmc@vitan.in'); // author, home = ambli
    client = await login(request, 'client@vitan.in'); // the decision audience, home = ambli
  });

  test('a DRAFT decision stays private to its author and notifies no one', async ({ request }) => {
    const title = `${uniq}-draft`;
    const res = await request.post(`${API}/projects/${PID}/decisions`, {
      headers: bearer(pmc),
      data: { title, room: 'Hall', publish: false, options: OPTIONS },
    });
    expect(res.ok(), `create draft → ${res.status()}`).toBeTruthy();

    // the author sees the draft; the client does NOT, and is not notified
    expect((await snapshot(request, pmc)).decisions.some((d) => d.title === title), 'author sees the draft').toBe(true);
    const cs = await snapshot(request, client);
    expect(cs.decisions.some((d) => d.title === title), 'a draft is invisible to the client').toBe(false);
    expect(cs.notifications.filter((n) => n.text.includes(title)).length, 'a draft notifies no one').toBe(0);
  });

  test('a PUBLISHED decision reaches the client and notifies EXACTLY once; a keyed retry adds nothing', async ({ request }) => {
    const title = `${uniq}-pub`;
    const key = `${uniq}-pub-key`;
    const data = { title, room: 'Hall', publish: true, options: OPTIONS };

    const first = await request.post(`${API}/projects/${PID}/decisions`, { headers: { ...bearer(pmc), 'Idempotency-Key': key }, data });
    expect(first.ok(), `publish → ${first.status()}`).toBeTruthy();
    // a RETRY with the SAME key + payload is a replay — it must create no second row and re-notify no one
    const retry = await request.post(`${API}/projects/${PID}/decisions`, { headers: { ...bearer(pmc), 'Idempotency-Key': key }, data });
    expect(retry.ok(), `retry → ${retry.status()}`).toBeTruthy();

    const cs = await snapshot(request, client);
    expect(cs.decisions.filter((d) => d.title === title).length, 'the keyed retry created no duplicate decision row').toBe(1);
    expect(cs.notifications.filter((n) => n.text.includes(title)).length, 'the client is notified exactly once (the replay re-notified nothing)').toBe(1);
  });
});
