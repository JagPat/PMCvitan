import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Role } from '@vitan/shared';

/**
 * Unit C1 — the universal create control.
 *
 * The proposal (`docs/ux/CREATE_CONTROL_PROPOSAL.md`) mounts the EXISTING `CreateMenu` in the
 * two shells rather than spending a bottom-tab slot, and it carries one obligation the
 * screen-owned mount in `PlacesScreen` never had: every shell mount renders OUTSIDE
 * `ProjectLoadBoundary`, so nothing unmounts it during a project transition.
 *
 * `switchProject` empties every project-owned field BEFORE its auth request goes out, while
 * `activeProjectId` and the gateway keep addressing the OLD project until `applyAuthResult`
 * lands; a failed switch deliberately keeps that identity too. So a control left standing in
 * that window can file the new project's record into the old one.
 *
 * These are the six acceptance tests §6 names.
 */

async function mount(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'project-a',
    projectScopeGeneration: 1,
    projectLoadState: 'ready',
    role: 'pmc' as Role,
    ...overrides,
  });
  const { CreateControl, CreateRailButton } = await import('@/layout/CreateControl');
  return { useStore, CreateControl, CreateRailButton };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** 1 — a role whose `createOptionsFor` is empty is offered no control, at either width. */
describe('the control is offered only to roles the menu has options for', () => {
  it.each(['client', 'contractor', 'consultant'] as Role[])(
    'renders neither trigger for %s',
    async (role) => {
      const { CreateControl, CreateRailButton } = await mount({ role });
      const r = render(<><CreateControl /><CreateRailButton /></>);
      expect(r.queryByTestId('create-fab')).toBeNull();
      expect(r.queryByTestId('create-rail')).toBeNull();
    },
  );

  it.each(['pmc', 'engineer'] as Role[])('renders both triggers for %s', async (role) => {
    const { CreateControl, CreateRailButton } = await mount({ role });
    const r = render(<><CreateControl /><CreateRailButton /></>);
    expect(r.queryByTestId('create-fab')).not.toBeNull();
    expect(r.queryByTestId('create-rail')).not.toBeNull();
  });
});

/**
 * 2 — each shell renders only at its own width.
 *
 * Asserted against the STYLESHEET rather than a simulated viewport, because that is where the
 * rule actually lives and it is the half an earlier draft got wrong: `TopBar` is display:none
 * from 640px upward, so a control mounted there would be invisible at every desktop width.
 * The two queries must be exact complements of the shells they sit in.
 */
describe('the two triggers are width complements', () => {
  it('hides the mobile trigger where LeftRail shows, and the rail trigger where TopBar shows', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/layout/CreateControl.module.css', 'utf8');
    const rail = readFileSync('src/layout/LeftRail.module.css', 'utf8');
    const top = readFileSync('src/layout/TopBar.module.css', 'utf8');

    // the mobile trigger is hidden exactly where the desktop rail appears
    expect(css).toMatch(/@media \(min-width: 640px\)[\s\S]*?\.fab[\s\S]*?display: none/);
    expect(rail).toMatch(/@media \(max-width: 639\.98px\)[\s\S]*?\.rail[\s\S]*?display: none/);

    // the rail trigger is hidden exactly where the mobile top bar appears
    expect(css).toMatch(/@media \(max-width: 639\.98px\)[\s\S]*?\.railButton[\s\S]*?display: none/);
    expect(top).toMatch(/@media \(min-width: 640px\)[\s\S]*?\.bar[\s\S]*?display: none/);
  });
});

/** 3 & 4 — the trigger is unavailable whenever project data is not trustworthy. */
describe('the trigger is gated on project-load state', () => {
  it.each(['switching', 'loading', 'error'] as const)('offers no trigger while %s', async (state) => {
    const { CreateControl, CreateRailButton } = await mount({ projectLoadState: state });
    const r = render(<><CreateControl /><CreateRailButton /></>);
    expect(r.queryByTestId('create-fab')).toBeNull();
    expect(r.queryByTestId('create-rail')).toBeNull();
  });

  it.each(['ready', 'idle'] as const)('offers the trigger while %s', async (state) => {
    const { CreateControl, CreateRailButton } = await mount({ projectLoadState: state });
    const r = render(<><CreateControl /><CreateRailButton /></>);
    expect(r.queryByTestId('create-fab')).not.toBeNull();
    expect(r.queryByTestId('create-rail')).not.toBeNull();
  });
});

/**
 * 5 — an OPEN MENU does not survive the transition.
 *
 * Driven the way a real user reaches it: not by clicking the switcher, but by a URL-borne
 * project change, which `RouteBridge` turns into `switchProject` and which sets `switching`
 * before anything else.
 */
describe('an open create flow does not survive the project leaving ready', () => {
  it('drops the open menu, and does not restore it when the new project is ready', async () => {
    const { useStore, CreateControl } = await mount();
    const r = render(<CreateControl />);

    fireEvent.click(r.getByTestId('create-fab'));
    expect(r.queryByTestId('create-decision')).not.toBeNull();

    // the transition: project data is emptied before the auth request goes out
    await act(async () => {
      useStore.setState({ projectLoadState: 'switching' } as never);
    });
    expect(r.queryByTestId('create-decision')).toBeNull();
    expect(r.queryByTestId('create-fab')).toBeNull();

    // and it does not spring back — the user would otherwise land in a menu they opened
    // against a different project
    await act(async () => {
      useStore.setState({ projectLoadState: 'ready', activeProjectId: 'project-b' } as never);
    });
    expect(r.queryByTestId('create-fab')).not.toBeNull();
    expect(r.queryByTestId('create-decision')).toBeNull();
    expect(useStore.getState().createOpen).toBe(false);
  });

  /**
   * 6 — an OPEN MODAL cannot write across the transition.
   *
   * This is the test that actually covers the window; 3 and 4 only narrow the entry. It asserts
   * both halves: the form is gone, AND nothing reached the old project's gateway.
   */
  it('drops an open create modal and files nothing against the project being left', async () => {
    const { useStore, CreateControl } = await mount();
    const issueDecision = vi.fn();
    const createDecision = vi.fn().mockResolvedValue({ id: 'd1' });
    // Phase 6 unit 4b — the decision form now offers a DECIDER picker, whose candidates are the
    // project's active members, so opening it loads the roster. The stub answers with an empty
    // team: this probe is about the project-switch window, not about the picker.
    const listMembers = vi.fn().mockResolvedValue([]);
    useStore.getState()._setGateway({ createDecision, listMembers } as never);
    useStore.setState({ issueDecision } as never);

    const r = render(<CreateControl />);
    fireEvent.click(r.getByTestId('create-fab'));
    fireEvent.click(r.getByTestId('create-decision'));
    expect(r.queryByTestId('dec-title')).not.toBeNull();

    await act(async () => {
      useStore.setState({ projectLoadState: 'switching' } as never);
    });

    // the form is gone, so there is nothing left to submit
    expect(r.queryByTestId('dec-title')).toBeNull();
    expect(r.queryByTestId('save-decision')).toBeNull();
    // and the project being left received nothing
    expect(issueDecision).not.toHaveBeenCalled();
    expect(createDecision).not.toHaveBeenCalled();
  });
});
