import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import {
  selectLogDecisions,
  selectVisibleDecisions,
  selectActionItems,
  selectDeciderPending,
  selectDeciderReapproval,
} from '@/store/selectors';
import { withDeciderRoute } from '@/lib/screens';
import { jwtSub } from '@/lib/jwt';
import { viewerIsDecider, type Decision, type Role } from '@vitan/shared';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import { DraftsScreen } from '@/screens/DraftsScreen';

/**
 * Phase 6 task 4b — the WEB half of P16 (the record-only issue's UI arms) and P22 (the pending
 * audience follows the DECIDER on the client-side mirrors).
 *
 * The server's `decisionVisibleToViewer` is the authority; the store selectors mirror it with
 * the SAME shared `viewerIsDecider` predicate over `(role, sessionUserId)` — a named
 * engineer-decider sees their obligation (log, visible surfaces, action item, approval slice)
 * while a same-role non-decider and the non-deciding client see none of it, and the approval
 * ROUTE follows the decider (`withDeciderRoute`).
 */

const s = () => useStore.getState();

const dec = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: over.title ?? `Title ${over.id}`,
    room: 'Kitchen',
    status: 'pending',
    deciderKind: 'client',
    photoSwatch: 'tile',
    options: [
      { label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true },
      { label: 'B', key: 'b', material: 'Quartz', delta: 20000, swatch: 'stone', recommended: false },
    ],
    ...over,
  }) as Decision;

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
  s()._setGateway(null);
});
afterEach(() => cleanup());

describe('P22 (web half): the pending audience follows the decider on every client-side mirror', () => {
  const memberHeld = dec({ id: 'DL-M', deciderKind: 'member', deciderMembershipId: 'm-eng-a', deciderUserId: 'u-eng-a' });
  const seed = (role: Role, sessionUserId: string | null) =>
    useStore.setState({ role, sessionUserId, decisions: [memberHeld, dec({ id: 'DL-C' })] });

  it('viewerIsDecider — the ONE shared predicate: role kinds designate the role, member designates the user, none designates nobody', () => {
    expect(viewerIsDecider({ deciderKind: 'client' }, 'client')).toBe(true);
    expect(viewerIsDecider({ deciderKind: 'client' }, 'engineer')).toBe(false);
    expect(viewerIsDecider({ deciderKind: 'pmc' }, 'pmc')).toBe(true);
    expect(viewerIsDecider({ deciderKind: 'member', deciderUserId: 'u1' }, 'engineer', 'u1')).toBe(true);
    expect(viewerIsDecider({ deciderKind: 'member', deciderUserId: 'u1' }, 'engineer', 'u2')).toBe(false);
    expect(viewerIsDecider({ deciderKind: 'member', deciderUserId: 'u1' }, 'engineer', null)).toBe(false);
    expect(viewerIsDecider({ deciderKind: 'none' }, 'pmc', 'u1')).toBe(false);
  });

  it('the log + the shared visible-decisions rule show a member-held pending row ONLY to its named decider (and pmc)', () => {
    seed('engineer', 'u-eng-a'); // the NAMED decider
    expect(selectLogDecisions(s()).map((d) => d.id)).toContain('DL-M');
    expect(selectVisibleDecisions(s()).map((d) => d.id)).toContain('DL-M');

    seed('engineer', 'u-eng-b'); // a same-role NON-decider
    expect(selectLogDecisions(s()).map((d) => d.id)).not.toContain('DL-M');
    expect(selectVisibleDecisions(s()).map((d) => d.id)).not.toContain('DL-M');

    seed('client', 'u-client'); // the client no longer sees a demand they do not decide
    expect(selectLogDecisions(s()).map((d) => d.id)).not.toContain('DL-M');
    expect(selectLogDecisions(s()).map((d) => d.id)).toContain('DL-C'); // their own is unchanged

    seed('pmc', 'u-pmc');
    expect(selectLogDecisions(s()).map((d) => d.id)).toEqual(expect.arrayContaining(['DL-M', 'DL-C']));
  });

  it('the approval slice + the Inbox item follow the decider: the named engineer gets decider-pending, the non-decider nothing, the client keeps their own', () => {
    seed('engineer', 'u-eng-a');
    expect(selectDeciderPending(s()).map((d) => d.id)).toEqual(['DL-M']);
    const deciderItem = selectActionItems(s()).find((i) => i.key === 'decider-pending');
    expect(deciderItem).toBeTruthy();
    expect(deciderItem?.screen).toBe('client-decisions');

    seed('engineer', 'u-eng-b');
    expect(selectDeciderPending(s())).toEqual([]);
    expect(selectActionItems(s()).some((i) => i.key === 'decider-pending')).toBe(false);

    seed('client', 'u-client');
    expect(selectDeciderPending(s()).map((d) => d.id)).toEqual(['DL-C']);
    const clientItem = selectActionItems(s()).find((i) => i.key === 'client-pending');
    expect(clientItem?.detail).toContain('Title DL-C');
    expect(clientItem?.detail).not.toContain('Title DL-M');
  });

  it('the reapproval surface follows the decider through `change` too (the same obligation, the same audience)', () => {
    useStore.setState({
      role: 'engineer',
      sessionUserId: 'u-eng-a',
      decisions: [dec({ id: 'DL-RE', status: 'change', deciderKind: 'member', deciderMembershipId: 'm-eng-a', deciderUserId: 'u-eng-a' })],
    });
    expect(selectDeciderReapproval(s()).map((d) => d.id)).toEqual(['DL-RE']);
    expect(selectActionItems(s()).some((i) => i.key === 'decider-reapprove')).toBe(true);
    useStore.setState({ sessionUserId: 'u-eng-b' });
    expect(selectDeciderReapproval(s())).toEqual([]);
  });

  it('the ROUTE follows the decider: `client-decisions` joins the allowed set only for an open decider', () => {
    expect(withDeciderRoute(['inbox', 'drawings'], true)).toContain('client-decisions');
    expect(withDeciderRoute(['inbox', 'drawings'], false)).not.toContain('client-decisions');
    // idempotent for a role that already has it (the client)
    expect(withDeciderRoute(['inbox', 'client-decisions'], true).filter((k) => k === 'client-decisions')).toHaveLength(1);
  });

  it('jwtSub reads the viewer identity out of the session token and never throws on junk', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u-eng-a', role: 'engineer' })).toString('base64url');
    expect(jwtSub(`x.${payload}.y`)).toBe('u-eng-a');
    expect(jwtSub('not-a-jwt')).toBeNull();
    expect(jwtSub('')).toBeNull();
  });
});

describe('P16 (web half): the record-only issue in the create + drafts surfaces', () => {
  it('choosing "record only" hides the options, and the issued payload carries deciderKind none with exactly zero options', async () => {
    const issued: unknown[] = [];
    useStore.setState({
      role: 'pmc',
      nodes: [{ id: 'zoneA', parentId: null, name: 'Zone A', kind: 'zone', order: 0 }],
      members: [],
      issueDecision: ((input: unknown) => issued.push(input)) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<IssueDecisionModal onClose={() => {}} />);

    fireEvent.change(r.getByTestId('dec-decider-kind'), { target: { value: 'none' } });
    expect(r.getByTestId('dec-record-note')).toBeTruthy();
    expect(r.queryByTestId('dec-opt-0')).toBeNull(); // the option rows are gone — a record takes none

    fireEvent.change(r.getByTestId('dec-title'), { target: { value: 'Damp patch noted' } });
    fireEvent.change(r.getByTestId('dec-loc-select-zone'), { target: { value: 'zoneA' } });
    fireEvent.click(r.getByTestId('save-decision'));

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ deciderKind: 'none', options: [], publish: true });
  });

  it('a member decider requires its member before the form is submittable; the payload carries the membership id', async () => {
    const issued: unknown[] = [];
    useStore.setState({
      role: 'pmc',
      nodes: [{ id: 'zoneA', parentId: null, name: 'Zone A', kind: 'zone', order: 0 }],
      members: [
        { userId: 'u-eng-a', membershipId: 'm-eng-a', name: 'Ravi', email: null, phone: null, role: 'engineer', status: 'active' },
      ],
      issueDecision: ((input: unknown) => issued.push(input)) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<IssueDecisionModal onClose={() => {}} />);
    fireEvent.change(r.getByTestId('dec-title'), { target: { value: 'Rebar spacing' } });
    fireEvent.change(r.getByTestId('dec-loc-select-zone'), { target: { value: 'zoneA' } });
    fireEvent.change(r.getByTestId('dec-opt-0'), { target: { value: 'Option A' } });
    fireEvent.change(r.getByTestId('dec-opt-1'), { target: { value: 'Option B' } });

    fireEvent.change(r.getByTestId('dec-decider-kind'), { target: { value: 'member' } });
    // no member chosen yet — publish must be disabled
    expect((r.getByTestId('save-decision') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('dec-decider-member'), { target: { value: 'm-eng-a' } });
    fireEvent.click(r.getByTestId('save-decision'));

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ deciderKind: 'member', deciderMembershipId: 'm-eng-a' });
  });

  it('the Drafts affordance re-points a draft decider, and converting to a record sheds the options in the SAME edit', () => {
    const updates: Array<[string, unknown]> = [];
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-D', draft: true, deciderKind: 'client' })],
      members: [
        { userId: 'u-eng-a', membershipId: 'm-eng-a', name: 'Ravi', email: null, phone: null, role: 'engineer', status: 'active' },
      ],
      updateDecisionDraft: ((id: string, input: unknown) => updates.push([id, input])) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);

    fireEvent.change(r.getByTestId('draft-decider-DL-D'), { target: { value: 'none' } });
    expect(updates.at(-1)).toEqual(['DL-D', { deciderKind: 'none', options: [] }]);

    fireEvent.change(r.getByTestId('draft-decider-DL-D'), { target: { value: 'member' } });
    expect(updates.at(-1)).toEqual(['DL-D', { deciderKind: 'member', deciderMembershipId: 'm-eng-a' }]);

    fireEvent.change(r.getByTestId('draft-decider-DL-D'), { target: { value: 'pmc' } });
    expect(updates.at(-1)).toEqual(['DL-D', { deciderKind: 'pmc' }]);
  });

  it('a DRAFT RECORD is always publish-ready (zero options is its contract); a member draft without its member is not', () => {
    useStore.setState({
      role: 'pmc',
      decisions: [
        dec({ id: 'DL-R', draft: true, deciderKind: 'none', options: [], photoSwatch: undefined }),
        dec({ id: 'DL-NM', draft: true, deciderKind: 'member', deciderMembershipId: undefined }),
      ],
      members: [],
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);
    expect((r.getByTestId('publish-DL-R') as HTMLButtonElement).disabled).toBe(false);
    expect(r.getByText(/no approval required/)).toBeTruthy();
    expect((r.getByTestId('publish-DL-NM') as HTMLButtonElement).disabled).toBe(true);
  });
});
