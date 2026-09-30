import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Phase 6 task 4d-ii-b / B5a — the four countersign-chain commands' CLIENT BOUNDARY over the REAL stack with
 * the six reservation doors STANDING. This unit ships no UI (B5b's), so the browser proof is the API shape
 * the gateway relies on: each route the client will call REFUSES with a 409 whose body carries a `message`
 * string — exactly what `req()` captures as the refusal the store surfaces unmasked — and none of them
 * changes the decision. Runs in every api-e2e mode.
 *
 * Fixtures (scripts/test-api-e2e.sh seed): `test-pmc@vitan.in` is a PMC on `ambli`; `client@vitan.in` its
 * client. DL-014 is a seeded client-held pending decision (forwardable, never awaiting a countersign).
 */

const API = 'http://localhost:3000';
const PASSWORD = 'vitan123';
const A = 'ambli';
const HEADERS = (token: string) => ({ Authorization: `Bearer ${token}`, 'x-vitan-decisions-contract': 'countersign-v1', 'Idempotency-Key': `e2e-b5a-${Math.random().toString(36).slice(2)}` });

async function apiLogin(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}
/** the PMC's home is project B: a token FOR ambli comes from the switch route */
async function apiLoginTo(request: APIRequestContext, email: string, projectId: string): Promise<string> {
  const home = await apiLogin(request, email);
  const res = await request.post(`${API}/auth/switch`, { headers: { Authorization: `Bearer ${home}` }, data: { projectId } });
  expect(res.ok(), `switch ${email} → ${projectId}: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}
const messageOf = (body: unknown): string | undefined => {
  const m = (body as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join('; ') : undefined;
};

test('with the doors standing, every countersign-chain route refuses 409 with a message the client can surface, and the decision is untouched', async ({ request }) => {
  const pmc = await apiLoginTo(request, 'test-pmc@vitan.in', A);
  const client = await apiLogin(request, 'client@vitan.in');
  const snapRes = await request.get(`${API}/projects/${A}/snapshot`, { headers: HEADERS(pmc) });
  expect(snapRes.ok(), `snapshot → ${snapRes.status()}`).toBeTruthy();
  const before = (await snapRes.json()) as { decisions: { id: string; status: string; deciderKind?: string }[] };
  const dl014 = before.decisions.find((d) => d.id === 'DL-014');
  expect(dl014?.status).toBe('pending');

  // forward — the PMC (a `decision.forward` role) hands DL-014 to the architect: the door stands → 409
  const fwd = await request.post(`${API}/projects/${A}/decisions/DL-014/forward`, { headers: HEADERS(pmc), data: { toDesignationKind: 'architect', reason: 'e2e probe' } });
  expect(fwd.status()).toBe(409);
  expect(messageOf(await fwd.json())).toBeTruthy();

  // countersign / disagree — the ARCHITECT's acts alone: a PMC is refused before any state is read
  const cs = await request.post(`${API}/projects/${A}/decisions/DL-014/countersign`, { headers: HEADERS(pmc) });
  expect([403, 409]).toContain(cs.status());
  expect(messageOf(await cs.json())).toBeTruthy();
  const dis = await request.post(`${API}/projects/${A}/decisions/DL-014/disagree`, { headers: HEADERS(pmc), data: { path: 'reject_back', reason: 'e2e probe' } });
  expect([403, 409]).toContain(dis.status());
  expect(messageOf(await dis.json())).toBeTruthy();

  // stranded — the PMC's resolution of an awaiting decision: DL-014 awaits nothing → refused with its answer
  const str = await request.post(`${API}/projects/${A}/decisions/DL-014/stranded`, { headers: HEADERS(pmc), data: { outcome: 'completed', reason: 'e2e probe' } });
  expect(str.status()).toBe(409);
  expect(messageOf(await str.json())).toBeTruthy();

  // the client, who does not hold `decision.countersign`, is refused too — and with a message
  const cli = await request.post(`${API}/projects/${A}/decisions/DL-014/countersign`, { headers: HEADERS(client) });
  expect([403, 409]).toContain(cli.status());
  expect(messageOf(await cli.json())).toBeTruthy();

  // nothing moved
  const after = await (await request.get(`${API}/projects/${A}/snapshot`, { headers: HEADERS(pmc) })).json() as { decisions: { id: string; status: string; deciderKind?: string }[] };
  expect(after.decisions.find((d) => d.id === 'DL-014')).toEqual(dl014);
  expect(after.decisions.some((d) => d.status === 'awaiting_countersign')).toBe(false);
});
