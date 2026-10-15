import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Activity, Lang, Phase, ProjectNode } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 QA item 3 — the site activity schedule in Hindi and Gujarati: every state of the screen (loading,
 * opening a link, unavailable, a missing activity, the schedule itself with each kind of row, gate reasons
 * opened, a place filter), the PMC's forms (plan, add phase, override, delete confirmations, the calendar),
 * and what the schedule's actions say back show no English. English stays as it was. Activity, phase and
 * place names, ids, people's names, blocker notes and override reasons are project data, shown as recorded.
 */

const act = (over: Partial<Activity>): Activity => ({
  id: 'ACT-1', name: 'Kitchen Tiling', zone: 'Kitchen', decisionId: null, phaseId: 'ph-1', nodeId: 'z1', ps: 2, pe: 9, as: null, ae: null,
  plannedStartDate: '2026-10-14', plannedEndDate: '2026-10-21', status: 'not-started', gm: 'ok', gt: 'ok', gi: 'ok', ...over,
} as Activity);
const reading = (decision: string, inspection: string, drawing: string) => ({
  decision: { v: 'wait', source: 'derived', reason: decision },
  material: { v: 'ok', source: 'stored', reason: 'Stored site flag — material on site' },
  team: { v: 'ok', source: 'stored', reason: 'Stored site flag — team present' },
  inspection: { v: 'wait', source: 'derived', reason: inspection },
  drawing: { v: 'fail', source: 'derived', reason: drawing },
});
const ACTS: Activity[] = [
  act({ id: 'ACT-1', readiness: reading('Awaiting the client’s approval', 'Awaiting inspection INSP-4', 'A-101: awaiting acknowledgement (1/3)') as never }),
  act({ id: 'ACT-2', status: 'in-progress', as: 3, actualStartDate: '2026-10-15', readiness: reading('Decision approved and locked', 'All linked inspections accepted', 'drawing: legacy revision acknowledged') as never,
    overrides: [{ id: 'o1', gate: 'drawing', state: 'ok', reason: 'Printed set', actorName: 'Asha Mehta', expiresAt: '2026-10-30T00:00:00Z' }] }),
  act({ id: 'ACT-3', status: 'blocked', as: 3, block: 'Pump failure', readiness: reading('Change requested — awaiting the architect’s re-approval', 'Correction chain open — the rejection of INSP-2 is not yet made good', 'No linked drawing') as never }),
  act({ id: 'ACT-4', status: 'awaiting-signoff', phaseId: null, readiness: reading('Approved by the client — awaiting the architect’s countersign', 'No linked inspection', 'A-101: nobody currently on the project confirmed the governing set — re-issue or override') as never }),
  act({ id: 'ACT-5', status: 'done', as: 1, ae: 4, actualStartDate: '2026-10-13', actualEndDate: '2026-10-16', readiness: reading('Record only — no approval required', 'No linked inspection', 'A-101: current set acknowledged by every active recipient') as never }),
  // one blocker alone: its reason is spelled out
  act({ id: 'ACT-6', readiness: { ...reading('No linked decision', 'No linked inspection', 'No linked drawing'), inspection: { v: 'na', source: 'derived', reason: 'No linked inspection' }, decision: { v: 'na', source: 'derived', reason: 'No linked decision' }, drawing: { v: 'fail', source: 'derived', reason: 'A-101: no construction revision governs (review-only or superseded out)' } } as never }),
];
const PHASES: Phase[] = [{ id: 'ph-1', name: 'Finishes', order: 0, plannedStart: 0, plannedEnd: 30, plannedStartDate: '2026-10-12', plannedEndDate: '2026-11-11', activityTotal: 5, done: 1, inProgress: 1, blocked: 1, notStarted: 2, donePct: 20 }];
const NODES: ProjectNode[] = [{ id: 'z1', parentId: null, name: 'Kitchen', kind: 'zone', order: 0 }];

// project data, and the acronyms sites use as they are
const DATA = ['Kitchen Tiling', 'Kitchen', 'Finishes', 'Pump failure', 'Printed set', 'Asha Mehta', 'Villa Bodakdev', 'ACT-1', 'ACT-2', 'ACT-3', 'ACT-4', 'ACT-5', 'ACT-6', 'ACT-404', 'INSP-4', 'INSP-2', 'A-101', 'PMC'];
const words = (text: string): string[] => {
  const allow = new Set(DATA.flatMap((a) => a.match(/[A-Za-z]+/g) ?? []));
  return (text.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !allow.has(w));
};

async function load(lang: Lang, over: Record<string, unknown> = {}, { mode = 'snapshot', demo = false } = {}) {
  vi.stubEnv('VITE_API_URL', demo ? '' : 'http://api.test');
  vi.stubEnv('VITE_ACTIVITIES_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', short: 'Villa Bodakdev', lang,
    activities: ACTS, phases: PHASES, nodes: NODES, scheduleStartDate: '2026-10-12', projStart: '12 Oct 2026', projEnd: '30 Jun 2027', elapsedPct: 4,
    ...over,
  });
  const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
  return { useStore, ScheduleScreen };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const STATES: [string, Record<string, unknown>, { mode?: string }?][] = [
  ['loading', { activities: [], activitiesLoad: 'loading' }, { mode: 'moduleQuery' }],
  ['unavailable', { activities: [], activitiesLoad: 'error' }, { mode: 'moduleQuery' }],
  ['a link to a missing activity', { routeItem: 'ACT-404' }],
  ['a link while the schedule loads', { routeItem: 'ACT-404', activitiesLoad: 'loading' }, { mode: 'moduleQuery' }],
  ['the schedule', {}],
  ['the PMC on the schedule', { role: 'pmc' }],
  ['no phases', { phases: [] }],
];

describe('the schedule in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const [name, over, opts] of STATES) {
      it(`${lang}, ${name}: no leftover English`, async () => {
        const { ScheduleScreen } = await load(lang, over, opts);
        render(<ScheduleScreen />);
        expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      });
    }

    it(`${lang}: every row's gate reasons, opened`, async () => {
      const { ScheduleScreen } = await load(lang, { role: 'pmc' });
      const r = render(<ScheduleScreen />);
      for (const a of ACTS) fireEvent.click(r.getByTestId(`gates-${a.id}`));
      for (const a of ACTS) expect(r.getByTestId(`gate-reasons-${a.id}`)).toBeInTheDocument();
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      // the gate dots' tooltips, which `leftoverEnglish` reads too, carry the same lines
      expect(r.getByTestId('gates-ACT-1').getAttribute('title')).toBeTruthy();
    });

    it(`${lang}: a place filter, with and without work there`, async () => {
      const { ScheduleScreen } = await load(lang, { nodes: [...NODES, { id: 'z2', parentId: null, name: 'Kitchen', kind: 'zone', order: 1 }] });
      const r = render(<ScheduleScreen />);
      fireEvent.change(r.getByTestId('sched-place-filter'), { target: { value: 'z1' } });
      expect(r.getByTestId('sched-place-count')).toBeInTheDocument();
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      fireEvent.change(r.getByTestId('sched-place-filter'), { target: { value: 'z2' } });
      expect(r.getByTestId('sched-place-empty')).toBeInTheDocument();
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    });

    for (const form of ['plan', 'calendar', 'phase', 'override', 'edit', 'delete', 'remove phase'] as const) {
      it(`${lang}: the PMC's ${form} form`, async () => {
        const { ScheduleScreen } = await load(lang, { role: 'pmc' });
        const r = render(<ScheduleScreen />);
        if (form === 'plan' || form === 'calendar') fireEvent.click(r.getByTestId('plan-activity'));
        if (form === 'calendar') fireEvent.click(r.getByTestId('act-start'));
        if (form === 'phase') fireEvent.click(r.getByTestId('add-phase'));
        if (form === 'override') fireEvent.click(r.getByTestId('override-ACT-1'));
        if (form === 'edit' || form === 'delete') fireEvent.click(r.getByTestId('edit-ACT-1'));
        if (form === 'delete') fireEvent.click(r.getByTestId('activity-delete'));
        if (form === 'remove phase') fireEvent.click(r.getByRole('button', { name: /Finishes/ }));
        expect(r.getByRole('dialog')).toBeInTheDocument();
        expect(leftoverEnglish(document.body, DATA)).toEqual([]);
      });
    }

    it(`${lang}: what the schedule's actions say back`, async () => {
      const said: string[] = [];
      const demo = await load(lang, {}, { demo: true });
      const s = () => demo.useStore.getState();
      const run = (go: () => unknown) => { go(); said.push(s().toast ?? ''); };
      run(() => s().startActivity('ACT-1'));
      run(() => s().completeActivity('ACT-2'));
      run(() => s().createActivity({ name: 'Kitchen Tiling' } as never));
      run(() => s().overrideGate('ACT-1', { gate: 'drawing', state: 'ok', reason: 'Printed set', expiresAt: '2026-10-30T00:00:00Z' }));
      run(() => s().createPhase('Finishes'));
      // live and offline: the queued start and completion name themselves in the language
      const live = await load(lang, { online: false });
      const l = () => live.useStore.getState();
      for (const go of [() => l().startActivity('ACT-1'), () => l().completeActivity('ACT-2')]) {
        go();
        said.push(l().toast ?? '');
      }
      expect(said.filter((t) => !t)).toEqual([]);
      for (const t of said) expect(words(t)).toEqual([]);
    });
  }

  it('the gate reasons the readiness tables serve all read in Hindi and Gujarati; an override\'s typed reason is kept', async () => {
    const { gateReasonIn, WITHDRAWN_REASON_HONEST, WITHDRAWN_REASON_REDACTED, RECORDED_DRAFT_REASON, RECORDED_PUBLISHED_REASON, awaitingCountersignReason, deriveDecisionReading } = await import('@vitan/shared');
    const served = [
      WITHDRAWN_REASON_HONEST, WITHDRAWN_REASON_REDACTED, RECORDED_DRAFT_REASON, RECORDED_PUBLISHED_REASON,
      ...(['client', 'pmc', 'member', 'architect'] as const).flatMap((k) => [
        awaitingCountersignReason(k),
        deriveDecisionReading('pending', false, false, k).reason,
        deriveDecisionReading('change', false, false, k).reason,
      ]),
      'A-101: legacy revision awaiting a first acknowledgement', 'Stored site flag (demo)',
    ];
    for (const lang of ['hi', 'gu'] as const) {
      for (const reason of served) expect([reason, words(gateReasonIn(reason, 'derived', lang))]).toEqual([reason, []]);
      expect(gateReasonIn('Printed set', 'override', lang)).toBe('Printed set');
      expect(gateReasonIn('A newer sentence', 'derived', lang)).toBe('A newer sentence');
      // a drawing number that looks like a sentence is kept whole, as served
      expect(gateReasonIn('X: legacy revision acknowledged: awaiting acknowledgement (1/2)', 'derived', lang)).toMatch(/^X: legacy revision acknowledged: /);
    }
    for (const reason of served) expect(gateReasonIn(reason, 'derived', 'en')).toBe(reason);
  });

  it('English reads as before', async () => {
    const { ScheduleScreen } = await load('en', { role: 'pmc' });
    const r = render(<ScheduleScreen />);
    const text = document.body.textContent ?? '';
    for (const line of ['SITE ACTIVITY SCHEDULE', 'What is starting, running & ending on site', 'Project 12 Oct 2026 → 30 Jun 2027', '4% time elapsed',
      'GATES TO START:', 'Mark complete', 'Awaiting sign-off', 'Completed', 'NOT STARTED', 'IN PROGRESS', 'Plan 14 Oct 2026 → 21 Oct 2026',
      'Actual 15 Oct 2026 → ongoing', 'Blocked — Pump failure. Resolve the blocker on site; the activity returns to the schedule once it clears.',
      'Cannot start yet — waiting on decision locked, inspection passed and drawings acknowledged.',
      'Cannot start yet — drawings acknowledged: A-101: no construction revision governs (review-only or superseded out)',
      'OVERRIDE · drawing → ok · Asha Mehta · expires 30 Oct · Printed set', 'UNPHASED', '1/5 done · 20%']) {
      expect(text).toContain(line);
    }
    fireEvent.click(r.getByTestId('gates-ACT-1'));
    expect(r.getByTestId('gate-reasons-ACT-1').textContent).toContain('Decision locked — Awaiting the client’s approval');
    expect(r.getByTestId('gate-reasons-ACT-1').textContent).toContain('Material on site — Stored site flag — material on site (stored flag)');
  });
});
