import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ProjectMember, Role } from '@vitan/shared';

/**
 * Phase 6 unit 4b — the decider picker (plan §A.1, round 7: "a contract field no screen can set
 * is not a product path").
 *
 * The server now enforces WHO decides a decision, and freezes that holder at publication. If the
 * practice could only state it through a direct API call, the enforcement would be a wall with no
 * door: the PMC would name nobody, every decision would stay client-held by default, and the
 * removed-member recovery the publish refusal points at would not exist.
 *
 * Two arms, matching the two doors the server opens:
 *   • P16 (UI) — the create modal mints every decider kind, and the DEFAULT is byte-identical:
 *     leaving the picker alone sends a payload with no decider keys at all.
 *   • P17 (UI) — the Drafts screen re-points an unpublished draft's decider, INCLUDING a draft
 *     whose named member has left the project (the case that makes the door necessary).
 */

const roster: ProjectMember[] = [
  { userId: 'u-bhavesh', membershipId: 'm-bhavesh', name: 'Bhavesh Patel', email: null, phone: null, role: 'contractor', status: 'active' },
  { userId: 'u-gone', membershipId: 'm-gone', name: 'Temporary Hand', email: null, phone: null, role: 'contractor', status: 'removed' },
];

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
    members: roster,
    // the create form's location is inherited from the capture context, and `InheritedContext`
    // drops a value whose node no longer exists — so the tree must actually contain it
    nodes: [{ id: 'n-1', parentId: null, name: 'Kitchen', kind: 'room', order: 0 }],
    ...overrides,
  });
  return { useStore };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('P16 (UI) — the create modal states who decides', () => {
  /** Fill the two blocking fields so the save buttons arm, then save. */
  async function fillAndSave(r: ReturnType<typeof render>, issueDecision: ReturnType<typeof vi.fn>) {
    fireEvent.change(r.getByTestId('dec-title'), { target: { value: 'Veneer finish' } });
    fireEvent.change(r.getByTestId('dec-opt-0'), { target: { value: 'Teak' } });
    fireEvent.change(r.getByTestId('dec-opt-1'), { target: { value: 'Oak' } });
    await act(async () => { fireEvent.click(r.getByTestId('save-decision')); });
    return issueDecision.mock.calls.at(-1)?.[0];
  }

  it('offers the client, the practice, and every ACTIVE member — a removed member is not a candidate', async () => {
    const { useStore } = await mount();
    useStore.setState({ issueDecision: vi.fn(), loadTeam: vi.fn().mockResolvedValue(undefined) } as never);
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={{ nodeId: 'n-1' } as never} onClose={() => {}} />);

    const values = [...(r.getByTestId('dec-decider') as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toEqual(['client', 'pmc', 'member:m-bhavesh']);
  });

  it('leaving the picker alone sends NO decider keys — the pre-4b payload, byte for byte', async () => {
    const issueDecision = vi.fn();
    const { useStore } = await mount();
    useStore.setState({ issueDecision, loadTeam: vi.fn().mockResolvedValue(undefined) } as never);
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={{ nodeId: 'n-1' } as never} onClose={() => {}} />);

    const payload = await fillAndSave(r, issueDecision);
    expect(payload.deciderKind).toBe('client');
    expect('deciderMembershipId' in payload).toBe(false);
  });

  it('naming a member sends the MEMBERSHIP the server FK-binds to, not the user', async () => {
    const issueDecision = vi.fn();
    const { useStore } = await mount();
    useStore.setState({ issueDecision, loadTeam: vi.fn().mockResolvedValue(undefined) } as never);
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={{ nodeId: 'n-1' } as never} onClose={() => {}} />);

    fireEvent.change(r.getByTestId('dec-decider'), { target: { value: 'member:m-bhavesh' } });
    const payload = await fillAndSave(r, issueDecision);
    expect(payload).toMatchObject({ deciderKind: 'member', deciderMembershipId: 'm-bhavesh' });
  });

  it('the practice can hold the decision itself', async () => {
    const issueDecision = vi.fn();
    const { useStore } = await mount();
    useStore.setState({ issueDecision, loadTeam: vi.fn().mockResolvedValue(undefined) } as never);
    const { IssueDecisionModal } = await import('@/screens/modals/IssueDecisionModal');
    const r = render(<IssueDecisionModal context={{ nodeId: 'n-1' } as never} onClose={() => {}} />);

    fireEvent.change(r.getByTestId('dec-decider'), { target: { value: 'pmc' } });
    const payload = await fillAndSave(r, issueDecision);
    expect(payload).toMatchObject({ deciderKind: 'pmc' });
    expect('deciderMembershipId' in payload).toBe(false);
  });
});

describe('P17 (UI) — the Drafts screen is where a stranded holder is fixed', () => {
  const draft = {
    id: 'DL-9', title: 'Veneer finish', room: 'Kitchen', status: 'pending', draft: true, photoSwatch: 'sw1',
    deciderKind: 'member', deciderMembershipId: 'm-gone',
    options: [
      { key: 'a', label: 'A', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true },
      { key: 'b', label: 'B', material: 'Oak', delta: 0, swatch: 'sw2', recommended: false },
    ],
  };

  it('shows a holder who has LEFT as an explicit option, and re-points it to an active member', async () => {
    const setDecisionDecider = vi.fn();
    const { useStore } = await mount({ decisions: [draft] });
    useStore.setState({ setDecisionDecider, loadTeam: vi.fn().mockResolvedValue(undefined) } as never);
    const { DraftsScreen } = await import('@/screens/DraftsScreen');
    const r = render(<DraftsScreen />);

    const select = r.getByTestId('draft-decider-DL-9') as HTMLSelectElement;
    // the departed holder is NOT silently dropped — the author must see what the draft names
    expect(select.value).toBe('member:m-gone');
    expect([...select.options].map((o) => o.value)).toContain('member:m-gone');

    fireEvent.change(select, { target: { value: 'member:m-bhavesh' } });
    expect(setDecisionDecider).toHaveBeenCalledWith('DL-9', { deciderKind: 'member', deciderMembershipId: 'm-bhavesh' });
  });

  it('a client-held draft shows the client, and can be handed to the practice', async () => {
    const setDecisionDecider = vi.fn();
    const { useStore } = await mount({ decisions: [{ ...draft, deciderKind: undefined, deciderMembershipId: undefined }] });
    useStore.setState({ setDecisionDecider, loadTeam: vi.fn().mockResolvedValue(undefined) } as never);
    const { DraftsScreen } = await import('@/screens/DraftsScreen');
    const r = render(<DraftsScreen />);

    const select = r.getByTestId('draft-decider-DL-9') as HTMLSelectElement;
    expect(select.value).toBe('client');
    fireEvent.change(select, { target: { value: 'pmc' } });
    expect(setDecisionDecider).toHaveBeenCalledWith('DL-9', { deciderKind: 'pmc' });
  });
});
