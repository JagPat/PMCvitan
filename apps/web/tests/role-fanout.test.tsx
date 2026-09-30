import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { emptyProjectData } from '@/store/projectScope';
import { selectRoles, selectPhase6_4dOpen } from '@/store/selectors';
import { ALL_ROLES, RESERVED_ROLES, ROLE_LABEL, rolesFor, screensFor } from '@/lib/screens';
import { RolePicker } from '@/layout/RolePicker';
import { TeamScreen } from '@/screens/TeamScreen';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import type { ProjectMember } from '@vitan/shared';
import rolePickerSource from '@/layout/RolePicker.tsx?raw';
import topBarSource from '@/layout/TopBar.tsx?raw';
import teamSource from '@/screens/TeamScreen.tsx?raw';
import draftsSource from '@/screens/DraftsScreen.tsx?raw';
import screensSource from '@/lib/screens.ts?raw';

/**
 * Phase 6 task 4d-ii-b / B2 — the ROLE FAN-OUT and the architect PERSONA (§A.1; the web arms of P28,
 * the role lists and pickers, and of P28b / P34: the pickers follow the ONE shell read).
 *
 * `architect` joined the vocabulary in 4d-ii-a (A5a) with its labels; B1 read the shell's
 * `rollout.phase6_4d` into the store fail-closed. B2 makes every persona switcher and role picker read
 * that ONE value through `selectRoles`: while the shell reads `'reserved'` (the doors stand; the server
 * refuses an architect membership or designation 409) no switcher or picker offers the role, and when it
 * reads `'open'` every one of them offers it at once. A member ALREADY in a role the rollout hides still
 * shows that role. The persona itself has its screens, so a session in the role lands somewhere.
 */

const s = () => useStore.getState();
const member = (userId: string, role: ProjectMember['role'], over: Partial<ProjectMember> = {}): ProjectMember =>
  ({ userId, membershipId: `m-${userId}`, name: userId, email: `${userId}@vitan.in`, phone: null, role, status: 'active', ...over }) as ProjectMember;

describe('B2 — rolesFor / selectRoles: one rollout-aware persona list', () => {
  beforeEach(() => { useStore.setState(getInitialState()); s()._setGateway(null); });
  afterEach(() => { cleanup(); });

  it('reserved hides exactly the reserved roles; open offers every persona, in switcher order', () => {
    expect(RESERVED_ROLES).toEqual(['architect']);
    expect(ALL_ROLES).toEqual(Object.keys(ROLE_LABEL));
    expect(rolesFor('reserved')).toEqual(ALL_ROLES.filter((r) => r !== 'architect'));
    expect(rolesFor('reserved')).not.toContain('architect');
    expect(rolesFor('open')).toEqual(ALL_ROLES);
    expect(rolesFor('open')).toContain('architect');
  });

  it('the store selector follows the shell value B1 stores, and starts reserved', () => {
    expect(selectPhase6_4dOpen(s())).toBe(false);
    expect(selectRoles(s())).not.toContain('architect');
    useStore.setState((st) => { st.phase6_4dRollout = 'open'; });
    expect(selectRoles(s())).toContain('architect');
    // a scope change tears the value down with the project — and the list follows
    useStore.setState((st) => { Object.assign(st, emptyProjectData()); });
    expect(selectRoles(s())).not.toContain('architect');
  });

  it('the architect persona has screens and a session in it lands on the home, never on an undefined screen', () => {
    const keys = screensFor('architect').map((m) => m.key);
    expect(keys[0]).toBe('inbox');
    expect(keys).toEqual(expect.arrayContaining(['inbox', 'decision-log', 'drawings', 'places']));
    s().setRole('architect');
    expect(s().role).toBe('architect');
    expect(s().screen).toBe('inbox');
  });
});

describe('B2 — every switcher and picker reads the one list', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.role = 'pmc'; st.activeProjectId = 'ambli'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { cleanup(); });

  it('the rail persona switcher offers no Architect while reserved, and offers it when open', () => {
    let r = render(<RolePicker />);
    expect(r.queryByRole('button', { name: 'Architect' })).toBeNull();
    expect(r.getByRole('button', { name: 'Consultant' })).toBeTruthy();
    cleanup();
    useStore.setState((st) => { st.phase6_4dRollout = 'open'; });
    r = render(<RolePicker />);
    expect(r.getByRole('button', { name: 'Architect' })).toBeTruthy();
  });

  it('the Team pickers offer no architect while reserved, offer it when open, and never misstate an existing architect row', () => {
    useStore.setState((st) => { st.members = [member('u-eng', 'engineer'), member('u-arch', 'architect')]; });
    let r = render(<TeamScreen />);
    const options = (testId: string) => Array.from((r.getByTestId(testId) as HTMLSelectElement).options).map((o) => o.value);
    // the add-member picker: the five delivered roles only
    expect(options('member-role')).toEqual(['pmc', 'client', 'engineer', 'contractor', 'consultant']);
    // an engineer's row: the same five; an ARCHITECT's row keeps its own role selectable so it reads true
    expect(options('member-role-u-eng')).not.toContain('architect');
    expect(options('member-role-u-arch')).toContain('architect');
    expect((r.getByTestId('member-role-u-arch') as HTMLSelectElement).value).toBe('architect');
    cleanup();
    useStore.setState((st) => { st.phase6_4dRollout = 'open'; });
    r = render(<TeamScreen />);
    expect(options('member-role')).toContain('architect');
    expect(options('member-role-u-eng')).toContain('architect');
  });

  it('the decider picker offers "The architect" only when the chain is open', () => {
    let r = render(<IssueDecisionModal onClose={() => {}} />);
    const values = () => Array.from((r.getByTestId('dec-decider-kind') as HTMLSelectElement).options).map((o) => o.value);
    expect(values()).toEqual(['client', 'pmc', 'member', 'none']);
    cleanup();
    useStore.setState((st) => { st.phase6_4dRollout = 'open'; });
    r = render(<IssueDecisionModal onClose={() => {}} />);
    expect(values()).toEqual(['client', 'pmc', 'member', 'architect', 'none']);
  });

  it('source pins: no static persona list survives; both switchers, the Team pickers and both decider pickers read the store', () => {
    expect(screensSource).not.toMatch(/export const ROLES\b/);
    expect(screensSource).not.toMatch(/PERSONAS_OWED/);
    for (const src of [rolePickerSource, topBarSource, teamSource]) {
      expect(src).toMatch(/selectRoles/);
      expect(src).not.toMatch(/\bROLES\b/);
    }
    expect(draftsSource).toMatch(/\{chainOpen && <option value="architect">/);
    expect(draftsSource).toMatch(/selectPhase6_4dOpen/);
  });
});
