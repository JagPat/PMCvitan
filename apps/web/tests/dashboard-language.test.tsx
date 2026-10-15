import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { dashboardLabels, type Lang, type Role } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 QA item 3 — the Dashboard in Hindi and Gujarati: the header, Milestone Progress and its basis line,
 * Live from site, the decision and inspection tiles in every load state, and Retry show no English. English
 * stays as it was. The photo block and the "Site photos on record" tile are the site-photos unit's (they
 * carry their own words), so they are left out of the check here. Project, phase and record names are data.
 */

type StoreState = Record<string, unknown>;

const PHASES = [{ id: 'ph-1', name: 'Finishes', order: 0, plannedStart: 0, plannedEnd: 30, activityTotal: 2, done: 1, inProgress: 1, blocked: 0, notStarted: 0, donePct: 50 }];
const ACTS = [
  { id: 'ACT-1', name: 'Kitchen Tiling', zone: 'Kitchen', decisionId: null, phaseId: 'ph-1', nodeId: null, ps: 0, pe: 5, as: 0, ae: 4, status: 'done', gm: 'ok', gt: 'ok', gi: 'ok' },
  { id: 'ACT-2', name: 'Bath Fittings', zone: 'Bath', decisionId: null, phaseId: 'ph-1', nodeId: null, ps: 5, pe: 9, as: 5, ae: null, status: 'in-progress', gm: 'ok', gt: 'ok', gi: 'ok' },
];
const DATA = ['Villa B', 'Residence', 'Finishing', 'VB-01', 'Finishes', 'PMC'];

async function load(lang: Lang, { role = 'pmc' as Role, env = { VITE_API_URL: 'http://api.test' } as Record<string, string>, over = {} as StoreState } = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  if (env.VITE_API_URL) useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', short: 'Villa B' });
  useStore.setState({
    role, lang, screen: 'dashboard', name: 'Villa B', descriptor: 'Residence', stage: 'Finishing', siteCode: 'VB-01',
    phases: PHASES, activities: ACTS, activitiesLoad: 'ready', decisionsLoad: 'ready', inspectionsLoad: 'ready', ...over,
  });
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  return { useStore, r: render(<DashboardScreen />) };
}

/** The rendered screen without the site-photos unit's parts (the photo tile and the photo block). */
function outsidePhotos(container: HTMLElement): HTMLElement {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelector('[data-testid="tile-photos"]')?.remove();
  copy.querySelector('[data-testid="dash-photo-block"]')?.remove();
  // the photo block has no test id on main: it is the screen's last section
  const screen = copy.firstElementChild;
  if (screen?.lastElementChild && /PHOTO/.test(screen.lastElementChild.textContent ?? '')) screen.lastElementChild.remove();
  return copy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(['hi', 'gu'] as const)('the Dashboard in %s (#482 QA item 3)', (lang) => {
  it('a loaded project shows no English', async () => {
    const { r } = await load(lang);
    expect(r.getByTestId('dash-progress-pct').textContent).not.toMatch(/[A-Za-z]/);
    expect(leftoverEnglish(outsidePhotos(r.container), DATA)).toEqual([]);
  });

  it('slices that failed or are loading show no English, and Retry is in the language', async () => {
    const failed = await load(lang, { env: { VITE_API_URL: 'http://api.test', VITE_ACTIVITIES_READ: 'moduleQuery', VITE_DAILYLOG_READ: 'moduleQuery' }, over: { activities: [], activitiesLoad: 'error', decisionsLoad: 'error', inspectionsLoad: 'error', dailyLog: null, dailyLogLoad: 'error' } });
    expect(failed.r.getByTestId('dash-progress-retry').textContent).toBe(dashboardLabels.retry[lang]);
    expect(leftoverEnglish(outsidePhotos(failed.r.container), DATA)).toEqual([]);
    cleanup();
    const loading = await load(lang, { env: { VITE_API_URL: 'http://api.test', VITE_ACTIVITIES_READ: 'moduleQuery', VITE_DAILYLOG_READ: 'moduleQuery' }, over: { activities: [], activitiesLoad: 'loading', decisionsLoad: 'loading', inspectionsLoad: 'loading', dailyLog: null, dailyLogLoad: 'loading' } });
    expect(leftoverEnglish(outsidePhotos(loading.r.container), DATA)).toEqual([]);
  });

  it('the demo weekly report reads in the language', async () => {
    const { r, useStore } = await load(lang, { env: {} });
    fireEvent.click(r.getByText(new RegExp(dashboardLabels.weeklyReport[lang])));
    expect(JSON.stringify(useStore.getState())).toContain(dashboardLabels.weeklyReportDone[lang]);
  });
});

describe('the Dashboard in English is unchanged', () => {
  it('keeps its words', async () => {
    const { r } = await load('en');
    expect(r.getByText('PROJECT DASHBOARD')).toBeTruthy();
    expect(r.getByText('Site Code VB-01')).toBeTruthy();
    expect(r.getByText('Milestone Progress')).toBeTruthy();
    expect(r.getByTestId('dash-progress-basis').textContent).toBe('1 of 2 activities accepted as done');
    expect(r.getByTestId('milestone-ph-1').getAttribute('aria-label')).toBe('Finishes: 1 of 2 activities done');
    expect(r.getByText('LIVE FROM SITE')).toBeTruthy();
    expect(r.getByText('WORKERS ON SITE')).toBeTruthy();
    expect(r.getByText('DECISIONS AWAITING APPROVAL')).toBeTruthy();
    expect(r.getByText('All cleared')).toBeTruthy();
    expect(r.getByText('INSPECTIONS AWAITING REVIEW')).toBeTruthy();
    expect(r.getByText('Nothing pending')).toBeTruthy();
  });
});
