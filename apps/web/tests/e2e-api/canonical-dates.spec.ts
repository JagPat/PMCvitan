import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Codex round-2 finding 3 — the seed bypassed canonical dates: a freshly
 * migrated + seeded database had null schedule anchors on BOTH projects, null
 * phase/activity civil dates and a null logDate, so date derivation silently
 * degraded everywhere in API mode. The seeded snapshot must carry real civil
 * dates end-to-end, derived from the anchor exactly as the services derive them.
 */
const API = 'http://localhost:3000';
// the seed's default demo password (apps/api/prisma/seed.ts, SEED_DEMO_PASSWORD unset)
const PASSWORD = 'vitan123';
const A = 'ambli';
const B = 'test-empty-site';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function apiLogin(request: APIRequestContext, email: string): Promise<{ token: string }> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return res.json();
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test('the seeded database carries canonical civil dates end-to-end', async ({ request }) => {
  // tokens are scoped to the login's HOME project, so each project is read
  // with a member whose home it is: test-eng lives on A, test-pmc on B
  const { token } = await apiLogin(request, 'test-eng@vitan.in');

  const resA = await request.get(`${API}/projects/${A}/snapshot`, { headers: bearer(token) });
  expect(resA.ok()).toBeTruthy();
  const snapA = await resA.json();

  // the schedule anchor: DAY0 of the demo offsets; window end matches projEnd
  expect(snapA.project.scheduleStartDate).toBe('2026-06-01');
  expect(snapA.project.scheduleEndDate).toBe('2026-09-30');

  // every phase and activity carries a real planned window
  expect(snapA.phases.length).toBeGreaterThan(0);
  for (const p of snapA.phases) {
    expect(p.plannedStartDate, `phase ${p.name} plannedStartDate`).toMatch(ISO_DAY);
    expect(p.plannedEndDate, `phase ${p.name} plannedEndDate`).toMatch(ISO_DAY);
  }
  expect(snapA.activities.length).toBeGreaterThan(0);
  for (const a of snapA.activities) {
    expect(a.plannedStartDate, `activity ${a.id} plannedStartDate`).toMatch(ISO_DAY);
    expect(a.plannedEndDate, `activity ${a.id} plannedEndDate`).toMatch(ISO_DAY);
  }

  // the derivation is anchored, not arbitrary: offset 34..41 from 2026-06-01
  const act31 = snapA.activities.find((a: { id: string }) => a.id === 'ACT-31');
  expect(act31?.plannedStartDate).toBe('2026-07-05');
  expect(act31?.plannedEndDate).toBe('2026-07-12');
  // a finished activity carries its ACTUAL civil dates too (offsets 9 and 18)
  const act22 = snapA.activities.find((a: { id: string }) => a.id === 'ACT-22');
  expect(act22?.actualStartDate).toBe('2026-06-10');
  expect(act22?.actualEndDate).toBe('2026-06-19');

  // the seeded daily log is a real civil day (todayDay 32 from the anchor)
  expect(snapA.dailyLog?.logDate).toBe('2026-07-03');

  // the empty fixture project has its anchor too — an anchor is project CONFIG,
  // not an operational record, so B stays truthfully empty of records
  const { token: tokenB } = await apiLogin(request, 'test-pmc@vitan.in'); // home = B
  const resB = await request.get(`${API}/projects/${B}/snapshot`, { headers: bearer(tokenB) });
  expect(resB.ok()).toBeTruthy();
  const snapB = await resB.json();
  expect(snapB.project.scheduleStartDate).toBe('2026-07-01');
  expect(snapB.activities).toEqual([]);
});
