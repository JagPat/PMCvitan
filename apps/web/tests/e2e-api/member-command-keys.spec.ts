import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B6 — the client `Idempotency-Key` on the member commands, proved against the REAL
 * server (no UI changes in this unit, so the browser proof is the API contract the gateway now relies on):
 * a KEYED add replayed under the same key runs ONCE (one membership, both replies successful — the ledger's
 * dedup, 4d-ii-a / A3b), a keyed role change and a keyed removal are accepted, and a keyed removal replayed
 * under its key is accepted again without error. Runs in every api-e2e mode.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `test-pmc@vitan.in` is a PMC on `ambli` (home: project B).
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const A = 'ambli';

async function apiLogin(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}
async function apiLoginTo(request: APIRequestContext, email: string, projectId: string): Promise<string> {
  const home = await apiLogin(request, email);
  const res = await request.post(`${API}/auth/switch`, { headers: { Authorization: `Bearer ${home}` }, data: { projectId } });
  expect(res.ok(), `switch ${email} → ${projectId}: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}
const headers = (token: string, key?: string) => ({
  Authorization: `Bearer ${token}`,
  'x-vitan-decisions-contract': 'countersign-v1',
  ...(key ? { 'Idempotency-Key': key } : {}),
});
const stamp = Math.random().toString(36).slice(2, 8);

test('a keyed member add replayed under the same key runs once; a keyed role change and a keyed removal (replayed too) are accepted', async ({ request }) => {
  const pmc = await apiLoginTo(request, 'test-pmc@vitan.in', A);
  const email = `b6-${stamp}@vitan.in`;
  const input = { name: `B6 Probe ${stamp}`, role: 'engineer', email };
  const addKey = `e2e-b6-add-${stamp}`;

  // the act, then the user's retry of the SAME act under the SAME key
  const first = await request.post(`${API}/projects/${A}/members`, { headers: headers(pmc, addKey), data: input });
  expect(first.ok(), `add → ${first.status()} ${await first.text()}`).toBeTruthy();
  const replay = await request.post(`${API}/projects/${A}/members`, { headers: headers(pmc, addKey), data: input });
  expect(replay.ok(), `replayed add → ${replay.status()} ${await replay.text()}`).toBeTruthy();

  const list = await request.get(`${API}/projects/${A}/members`, { headers: headers(pmc) });
  expect(list.ok()).toBeTruthy();
  const members = (await list.json()) as { userId: string; email: string | null; role: string; status: string }[];
  const mine = members.filter((m) => m.email === email);
  expect(mine, 'the ledger ran the keyed act once').toHaveLength(1);
  const userId = mine[0].userId;
  expect(mine[0].role).toBe('engineer');

  // a keyed role change
  const role = await request.patch(`${API}/projects/${A}/members/${userId}`, { headers: headers(pmc, `e2e-b6-role-${stamp}`), data: { role: 'contractor' } });
  expect(role.ok(), `role → ${role.status()} ${await role.text()}`).toBeTruthy();
  const after = (await (await request.get(`${API}/projects/${A}/members`, { headers: headers(pmc) })).json()) as { userId: string; role: string }[];
  expect(after.find((m) => m.userId === userId)?.role).toBe('contractor');

  // a keyed removal, and its replay under the same key
  const removeKey = `e2e-b6-remove-${stamp}`;
  const removed = await request.delete(`${API}/projects/${A}/members/${userId}`, { headers: headers(pmc, removeKey) });
  expect(removed.ok(), `remove → ${removed.status()} ${await removed.text()}`).toBeTruthy();
  const removedAgain = await request.delete(`${API}/projects/${A}/members/${userId}`, { headers: headers(pmc, removeKey) });
  expect(removedAgain.ok(), `replayed remove → ${removedAgain.status()} ${await removedAgain.text()}`).toBeTruthy();
  const finalList = (await (await request.get(`${API}/projects/${A}/members`, { headers: headers(pmc) })).json()) as { userId: string; status: string }[];
  const gone = finalList.find((m) => m.userId === userId);
  expect(!gone || gone.status !== 'active', 'the member is no longer active').toBe(true);
});
