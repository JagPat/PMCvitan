import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Activity, Checklist, Decision, ProjectNode, Review } from '@vitan/shared';

/**
 * Completion audit for the location-context / editing-state pass.
 *
 * The shared `LocationContext` and `EditState` landed with #417 on decisions, schedule rows
 * and drawings. These probes cover the surfaces that were still answering the same two
 * questions inconsistently: an inspection under review, a field checklist, a client's
 * pending decision, and an activity that cannot be started.
 *
 * Each asserts the EXPLANATION, not just the disabled attribute — a control that is silently
 * inert is the defect, and a control that is disabled WITH its reason is the fix.
 */

const NODES: ProjectNode[] = [
  { id: 'site', parentId: null, name: 'Site', kind: 'zone', order: 0 },
  { id: 'zoneA', parentId: 'site', name: 'Zone A', kind: 'room', order: 0 },
];

async function load(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc',
    short: 'Residence at Ambli',
    nodes: NODES,
    ...overrides,
  } as never);
  return useStore;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

// ── Inspections ────────────────────────────────────────────────────────────────────────

const review = (over: Partial<Review> = {}): Review => ({
  id: 'INSP-1', title: 'Waterproofing', zone: 'legacy text', nodeId: 'zoneA',
  by: 'Ramesh', date: '01 Aug 2026', decided: false,
  items: [{ name: 'Ponding', result: 'PASS', swatch: 'tile', note: 'ok', rejected: false }],
  ...over,
});

describe('an inspection under review says WHERE it was carried out', () => {
  it('shows the filed trail, not the free-text zone', async () => {
    await load({ reviews: [review()], activeReviewId: 'INSP-1' });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    expect(r.getByTestId('review-place-INSP-1').textContent).toBe('Site›Zone A');
  });

  it('falls back to the legacy zone when the review was never filed to a node', async () => {
    await load({ reviews: [review({ nodeId: undefined })], activeReviewId: 'INSP-1' });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    expect(r.getByTestId('review-place-INSP-1').textContent).toBe('legacy text');
  });

  it('a crumb opens the Site Map at that place', async () => {
    const useStore = await load({ reviews: [review()], activeReviewId: 'INSP-1' });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    fireEvent.click(r.getByTestId('review-place-INSP-1-crumb-0'));
    expect(useStore.getState().screen).toBe('places');
    expect(useStore.getState().placeFocus).toBe('site');
  });
});

describe('a DECIDED inspection is a record, not a live queue item', () => {
  it('withdraws the decide actions and states the verdict', async () => {
    await load({ reviews: [review({ decided: true })], activeReviewId: 'INSP-1' });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    const state = r.getByTestId('review-decided-INSP-1');
    expect(state).toHaveAttribute('data-edit-state', 'locked');
    expect(state.textContent).toContain('Reviewed');
    // re-approving would re-send the decision — the store has no `decided` guard
    expect(r.queryByTestId('send-reinspection')).not.toBeInTheDocument();
    expect(r.getByTestId('review-reject-0')).toBeDisabled();
    // …and it must not prescribe a next step that presumes the outcome: a rejection ALREADY
    // created the corrective checklist, so "issue a new checklist" would duplicate it (Codex R2).
    expect(state.textContent).not.toMatch(/issue a new checklist/i);
  });

  it('a decided CLOSING review names its activity without asserting the outcome (Codex P1)', async () => {
    // `sendReinspection` also sets decided:true and keeps closing:true, but returns the
    // activity to execution — so approval cannot be inferred from `decided` alone, and
    // `Review` carries no approved/rejected field to read.
    await load({
      reviews: [review({ decided: true, closing: true, activityId: 'ACT-1', activityName: 'Terrace waterproofing' })],
      activeReviewId: 'INSP-1',
    });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    const text = r.getByTestId('review-decided-INSP-1').textContent ?? '';
    expect(text).toContain('Terrace waterproofing');
    expect(text).not.toMatch(/signed off/i);
    expect(text).not.toMatch(/marked .* done/i);
  });

  it('an UNDECIDED review keeps both actions live and shows no locked banner', async () => {
    await load({ reviews: [review()], activeReviewId: 'INSP-1' });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    expect(r.getByTestId('send-reinspection')).toBeInTheDocument();
    expect(r.getByTestId('review-reject-0')).not.toBeDisabled();
    expect(r.queryByTestId('review-decided-INSP-1')).not.toBeInTheDocument();
  });
});

describe('the demo producer carries the location into the review it generates (Codex R2)', () => {
  it("a closing review inherits the completed activity's filed node, not just its free text", async () => {
    // The earlier probes constructed a Review WITH nodeId, so they bypassed the producer:
    // `completeActivity` built its closing review from `zone` alone, and every generated
    // closing inspection therefore read as unplaced however the activity was filed.
    const useStore = await load({
      activities: [{
        id: 'ACT-9', name: 'Terrace waterproofing', zone: 'Terrace', decisionId: null, phaseId: null,
        nodeId: 'zoneA', ps: 0, pe: 5, as: 1, ae: null, status: 'in-progress',
        gm: 'ok', gt: 'ok', gi: 'ok',
      }],
    });
    act(() => { useStore.getState().completeActivity('ACT-9'); });

    const closing = useStore.getState().reviews.find((r) => r.closing && r.activityId === 'ACT-9');
    expect(closing).toBeDefined();
    expect(closing!.nodeId).toBe('zoneA');

    // …and the screen therefore renders the real trail rather than the free-text fallback
    act(() => { useStore.setState({ activeReviewId: closing!.id }); });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    expect(r.getByTestId(`review-place-${closing!.id}`).textContent).toBe('Site›Zone A');
  });

  it("a submitted checklist's review inherits the checklist's filed node (Codex R1/#421)", async () => {
    // The other producer on this path: submitting a checklist pushes a review built from
    // `zone` alone, so every review reaching the PMC queue through the normal field workflow
    // read as unplaced — the fix on `completeActivity` covered only the closing case.
    const useStore = await load({
      role: 'engineer',
      checklist: checklist({ items: [{ name: 'Ponding test', state: 'pass', photos: 0, note: '' }] }),
    });
    act(() => { useStore.getState().submitInspection(); });

    const generated = useStore.getState().reviews.find((r) => r.id === 'CHK-1');
    expect(generated).toBeDefined();
    expect(generated!.nodeId).toBe('zoneA');

    act(() => { useStore.setState({ role: 'pmc', activeReviewId: 'CHK-1' }); });
    const { InspectionReviewScreen } = await import('@/screens/InspectionReviewScreen');
    const r = render(<InspectionReviewScreen />);
    expect(r.getByTestId('review-place-CHK-1').textContent).toBe('Site›Zone A');
  });
});

// ── Field checklist ────────────────────────────────────────────────────────────────────

const checklist = (over: Partial<Checklist> = {}): Checklist => ({
  id: 'CHK-1', title: 'Waterproofing — 2nd coat', zone: 'legacy text', nodeId: 'zoneA',
  date: '01 Aug 2026', submitted: false,
  items: [{ name: 'Ponding test', state: null, photos: 0, note: '' }],
  ...over,
});

describe("the field checklist says where it is, and why it is read-only", () => {
  it('shows the filed trail', async () => {
    await load({ role: 'engineer', checklist: checklist() });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const r = render(<EngineerChecklistScreen />);
    expect(r.getByTestId('checklist-place').textContent).toBe('Site›Zone A');
  });

  it('an editable checklist carries NO frozen banner', async () => {
    await load({ role: 'engineer', checklist: checklist() });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const r = render(<EngineerChecklistScreen />);
    expect(r.queryByTestId('checklist-frozen-reason')).not.toBeInTheDocument();
    expect(r.getByTestId('evidence-0')).not.toBeDisabled();
  });

  it('a SUBMITTED checklist explains the lock beside the controls it disables', async () => {
    await load({ role: 'engineer', checklist: checklist({ submitted: true }) });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const r = render(<EngineerChecklistScreen />);
    const state = r.getByTestId('checklist-frozen-reason');
    expect(state).toHaveAttribute('data-edit-state', 'locked');
    expect(state.textContent).toContain('Submitted');
    expect(r.getByTestId('evidence-0')).toBeDisabled();
    // `Checklist` carries no `decided` field, and the serializer can still return an
    // ALREADY-REVIEWED checklist as the engineer's current one — so the lock must not
    // claim a review is still pending (Codex P2).
    expect(state.textContent).not.toMatch(/to review/i);
    expect(state.textContent).not.toMatch(/awaiting/i);
  });

  it('a QUEUED submission reads as a transient pause, not a permanent lock', async () => {
    const useStore = await load({ role: 'engineer', checklist: checklist() });
    // `checklistFrozen` is scoped to THIS checklist and scope generation — a submission for
    // another checklist must not freeze this one, so the fixture matches both.
    act(() => {
      useStore.setState({
        submission: { inspectionId: 'CHK-1', generation: useStore.getState().projectScopeGeneration, status: 'queued', attempt: 1 },
      } as never);
    });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const r = render(<EngineerChecklistScreen />);
    const state = r.getByTestId('checklist-frozen-reason');
    expect(state).toHaveAttribute('data-edit-state', 'paused');
    expect(state.textContent).toContain('reconnect');
  });
});

// ── Client decisions ───────────────────────────────────────────────────────────────────

const decision = (over: Partial<Decision> = {}): Decision => ({
  // Phase 6 task 4b — the client-held designation (the migration backfill) so the viewer-scoped
  // approval surface still shows the row to the client.
  id: 'DL-1', title: 'Floor tile', room: 'legacy room', nodeId: 'zoneA', status: 'pending', deciderKind: 'client',
  options: [
    { key: 'a', material: 'Kota', delta: 0, swatch: 'tile', recommended: true },
    { key: 'b', material: 'Marble', delta: 40000, swatch: 'tile', recommended: false },
  ],
  ageDays: 3, photoSwatch: 'tile', date: '01 Aug 2026',
  ...over,
} as Decision);

describe("the client's pending decision shows the same coordinate the PMC reads", () => {
  it('renders the filed trail rather than the free-text room', async () => {
    await load({ role: 'client', decisions: [decision()] });
    const { ClientDecisionsScreen } = await import('@/screens/ClientDecisionsScreen');
    const r = render(<ClientDecisionsScreen />);
    expect(r.getByTestId('client-decision-place-DL-1').textContent).toBe('Site›Zone A');
  });

  it('a legacy decision with no node still shows its room, as plain text', async () => {
    await load({ role: 'client', decisions: [decision({ nodeId: undefined })] });
    const { ClientDecisionsScreen } = await import('@/screens/ClientDecisionsScreen');
    const r = render(<ClientDecisionsScreen />);
    const place = r.getByTestId('client-decision-place-DL-1');
    expect(place.textContent).toBe('legacy room');
    expect(r.queryByTestId('client-decision-place-DL-1-crumb-0')).not.toBeInTheDocument();
  });

  it('a crumb takes the client to that place on the Site Map', async () => {
    const useStore = await load({ role: 'client', decisions: [decision()] });
    const { ClientDecisionsScreen } = await import('@/screens/ClientDecisionsScreen');
    const r = render(<ClientDecisionsScreen />);
    fireEvent.click(r.getByTestId('client-decision-place-DL-1-crumb-1'));
    expect(useStore.getState().screen).toBe('places');
    expect(useStore.getState().placeFocus).toBe('zoneA');
  });
});

// ── Schedule restrictions ──────────────────────────────────────────────────────────────

const activity = (over: Partial<Activity> = {}): Activity => ({
  id: 'ACT-1', name: 'Terrace waterproofing', zone: 'Terrace', decisionId: null, phaseId: null,
  nodeId: 'zoneA', ps: 0, pe: 5, as: null, ae: null, status: 'not-started',
  gm: 'ok', gt: 'ok', gi: 'ok',
  ...over,
} as Activity);

describe('the schedule says WHY an activity cannot be acted on', () => {
  it('a SINGLE blocking gate is named WITH its derived reason — the actionable case', async () => {
    await load({ activities: [activity({ gm: 'wait' })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    const state = r.getByTestId('sched-restriction-ACT-1');
    expect(state).toHaveAttribute('data-edit-state', 'workflow');
    expect(state.textContent).toContain('Cannot start yet');
    expect(state.textContent?.toLowerCase()).toContain('material on site');
    expect(state.textContent).not.toContain('waiting on'); // the multi-gate form
  });

  it('SEVERAL blocking gates are named but not each explained — four reasons is a paragraph on a phone', async () => {
    await load({ activities: [activity({ gm: 'wait', gt: 'wait', gi: 'fail' })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    const text = r.getByTestId('sched-restriction-ACT-1').textContent ?? '';
    expect(text).toContain('waiting on');
    expect(text.toLowerCase()).toContain('material on site');
    expect(text.toLowerCase()).toContain('team present');
    // compact enough to read at 390px rather than a wall of derived sentences
    expect(text.length).toBeLessThan(160);
  });

  it('a blocked activity surfaces the blocker text and the next valid step', async () => {
    await load({ activities: [activity({ status: 'blocked', block: 'Ponding test failed — drain slope' })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    const state = r.getByTestId('sched-restriction-ACT-1');
    expect(state.textContent).toContain('Ponding test failed — drain slope');
    // A gate override records a GateOverride and nothing else; `start` refuses any status
    // but not_started, so offering it here sends the PMC down a dead end (Codex P2).
    expect(state.textContent).not.toMatch(/override/i);
  });

  it('an activity awaiting sign-off says whose decision completes it', async () => {
    await load({ activities: [activity({ status: 'awaiting-signoff' })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.getByTestId('sched-restriction-ACT-1').textContent).toContain('closing inspection sign-off');
  });

  it('a READY activity gets no banner — restraint, not a component quota', async () => {
    await load({ activities: [activity()] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.getByTestId('start-ACT-1')).toBeInTheDocument();
    expect(r.queryByTestId('sched-restriction-ACT-1')).not.toBeInTheDocument();
  });

  it('a running activity gets no banner either', async () => {
    await load({ activities: [activity({ status: 'in-progress', as: 1 })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.queryByTestId('sched-restriction-ACT-1')).not.toBeInTheDocument();
  });

  it('the override affordance is withdrawn on a blocked row, not just argued against (Codex R1/#421)', async () => {
    // Saying "resolve the blocker" while still offering the shield leaves the dead end in
    // place: the PMC records an audited override and the activity stays unstartable.
    await load({ activities: [activity({ status: 'blocked', block: 'Ponding test failed' })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.queryByTestId('override-ACT-1')).not.toBeInTheDocument();
    // …and the row still explains itself rather than going silent
    expect(r.getByTestId('sched-restriction-ACT-1').textContent).toContain('Ponding test failed');
  });

  it('a startable row keeps the override — the withdrawal is scoped to blocked', async () => {
    await load({ activities: [activity({ gm: 'wait' })] });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.getByTestId('override-ACT-1')).toBeInTheDocument();
  });

  it('an override ALREADY recorded on a blocked row stays revocable', async () => {
    // Withdrawing the record affordance must not strand governance: an override that exists
    // is still the PMC's to revoke, whatever the activity's status.
    await load({
      activities: [activity({
        status: 'blocked', block: 'Ponding test failed',
        overrides: [{ id: 'OV-1', gate: 'material', state: 'ok', actorName: 'A. Patel', reason: 'set on site', expiresAt: '2026-12-01T00:00:00.000Z' }],
      })],
    });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.queryByTestId('override-ACT-1')).not.toBeInTheDocument();
    const chip = r.getByTestId('override-chip-OV-1');
    expect(chip.querySelector('button[aria-label="Revoke override"]')).not.toBeNull();
  });
});
