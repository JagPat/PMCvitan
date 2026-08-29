import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('round-1 Codex corrections (web arms)', () => {
  it('F2: a RECORD renders as a filed fact in the log — no approver, no options arithmetic, no approval demand', async () => {
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-REC', title: 'Site access route', status: 'recorded', deciderKind: 'none', options: [], photoSwatch: undefined })],
    } as never);
    const r = render(<DecisionLogScreen />);
    const row = r.getByTestId('log-row-DL-REC');
    expect(row.textContent).toContain('Issue recorded — no approval required');
    expect(row.textContent).toContain('Filed on the register — nothing approvable');
    expect(row.textContent).toContain('RECORDED');
    // the approved-shape leakage the finding names is gone
    expect(row.textContent).not.toContain('undefined');
    expect(row.textContent).not.toContain('Infinity');
    expect(row.textContent).not.toContain('awaiting client');
  });

  it('F6: converting a record draft back to a choice collects 2–4 options and submits them WITH the kind in one edit', () => {
    const updates: Array<[string, unknown]> = [];
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-RC', draft: true, deciderKind: 'none', options: [], photoSwatch: undefined })],
      members: [],
      updateDecisionDraft: ((id: string, input: unknown) => updates.push([id, input])) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);

    // selecting a deciding kind does NOT dispatch a bare kind change — it opens the form
    fireEvent.change(r.getByTestId('draft-decider-DL-RC'), { target: { value: 'client' } });
    expect(updates).toEqual([]);
    expect(r.getByTestId('convert-form-DL-RC')).toBeTruthy();

    // Confirm stays disabled until every option names a material
    expect((r.getByTestId('convert-confirm-DL-RC') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(r.getByTestId('convert-material-DL-RC-0'), { target: { value: 'Granite' } });
    fireEvent.change(r.getByTestId('convert-material-DL-RC-1'), { target: { value: 'Quartz' } });
    fireEvent.change(r.getByTestId('convert-swatch-DL-RC-0'), { target: { value: 'marble' } });
    expect((r.getByTestId('convert-confirm-DL-RC') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(r.getByTestId('convert-confirm-DL-RC'));
    expect(updates).toEqual([
      ['DL-RC', {
        deciderKind: 'client',
        options: [
          { material: 'Granite', delta: 0, swatch: 'marble', recommended: true },
          { material: 'Quartz', delta: 0, swatch: 'tile', recommended: false },
        ],
      }],
    ]);
  });
});

describe('round-5 Codex corrections (web arms)', () => {
  it('R5-F2: the register row names the ACTUAL decider — a pmc-held pending row never says "awaiting client"', async () => {
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    useStore.setState({
      role: 'pmc',
      decisions: [
        dec({ id: 'DL-PMH', title: 'Facade fixing', deciderKind: 'pmc', ageDays: 3 }),
        dec({ id: 'DL-CLH', title: 'Kitchen top', deciderKind: 'client', ageDays: 2 }),
        dec({
          id: 'DL-MCH', title: 'Rebar detail', deciderKind: 'member', deciderUserId: 'u-eng-a', status: 'change',
          changeRequest: { reason: 'Lot rejected', costImpact: 0, timeImpactDays: 0 },
        }),
      ],
    } as never);
    const r = render(<DecisionLogScreen />);
    const pmcRow = r.getByTestId('log-row-DL-PMH');
    expect(pmcRow.textContent).toContain('awaiting the PMC');
    expect(pmcRow.textContent).not.toContain('awaiting client');
    // the client-held text stays byte-identical
    expect(r.getByTestId('log-row-DL-CLH').textContent).toContain('awaiting client');
    // the reopened member-held row directs its re-approval at the named decider
    const memberRow = r.getByTestId('log-row-DL-MCH');
    expect(memberRow.textContent).toContain('awaiting the named decider’s re-approval');
    expect(memberRow.textContent).not.toContain('the client’s re-approval');
  });

  it('R5-F3: converting a record to a NAMED member renders the picker from the FORM kind and submits the CHOSEN member', () => {
    const updates: Array<[string, unknown]> = [];
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-RM', draft: true, deciderKind: 'none', options: [], photoSwatch: undefined })],
      members: [
        { userId: 'u-eng-a', membershipId: 'm-eng-a', name: 'Ravi', email: null, phone: null, role: 'engineer', status: 'active' },
        { userId: 'u-eng-b', membershipId: 'm-eng-b', name: 'Asha', email: null, phone: null, role: 'engineer', status: 'active' },
      ],
      updateDecisionDraft: ((id: string, input: unknown) => { updates.push([id, input]); return Promise.resolve(true); }) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);

    fireEvent.change(r.getByTestId('draft-decider-DL-RM'), { target: { value: 'member' } });
    expect(updates).toEqual([]); // the conversion opens the form — nothing dispatched yet
    // the picker renders FROM THE FORM's kind (the persisted row is still a record)
    const picker = r.getByTestId('convert-member-DL-RM') as HTMLSelectElement;
    expect(picker.value).toBe('m-eng-a'); // the default is visible, not silent
    fireEvent.change(picker, { target: { value: 'm-eng-b' } });

    fireEvent.change(r.getByTestId('convert-material-DL-RM-0'), { target: { value: 'Granite' } });
    fireEvent.change(r.getByTestId('convert-material-DL-RM-1'), { target: { value: 'Quartz' } });
    fireEvent.click(r.getByTestId('convert-confirm-DL-RM'));

    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toMatchObject({ deciderKind: 'member', deciderMembershipId: 'm-eng-b' });
  });

  it('R5-F4: a confirmed conversion HOLDS publication until the server accepts it — the form closes only on success', async () => {
    const { waitFor } = await import('@testing-library/react');
    let settle!: (ok: boolean) => void;
    const inFlight = new Promise<boolean>((res) => { settle = res; });
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-RP', draft: true, deciderKind: 'none', options: [], photoSwatch: undefined })],
      members: [],
      updateDecisionDraft: (() => inFlight) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);

    fireEvent.change(r.getByTestId('draft-decider-DL-RP'), { target: { value: 'client' } });
    fireEvent.change(r.getByTestId('convert-material-DL-RP-0'), { target: { value: 'Granite' } });
    fireEvent.change(r.getByTestId('convert-material-DL-RP-1'), { target: { value: 'Quartz' } });
    // before Confirm the record is legitimately publishable as a record
    expect((r.getByTestId('publish-DL-RP') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(r.getByTestId('convert-confirm-DL-RP'));
    // the PATCH is in flight: publication is HELD, the form stays open, Confirm cannot double-fire
    await waitFor(() => expect((r.getByTestId('publish-DL-RP') as HTMLButtonElement).disabled).toBe(true));
    expect(r.getByTestId('convert-form-DL-RP')).toBeTruthy();
    expect((r.getByTestId('convert-confirm-DL-RP') as HTMLButtonElement).disabled).toBe(true);
    expect(r.getByText(/publishing is held until the edit lands/)).toBeTruthy();

    settle(true);
    await waitFor(() => expect(r.queryByTestId('convert-form-DL-RP')).toBeNull());
    expect((r.getByTestId('publish-DL-RP') as HTMLButtonElement).disabled).toBe(false);
  });

  it('R5-F4: a FAILED conversion keeps the form (and the record) exactly as the user last saw them', async () => {
    const { waitFor } = await import('@testing-library/react');
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-RF', draft: true, deciderKind: 'none', options: [], photoSwatch: undefined })],
      members: [],
      updateDecisionDraft: (() => Promise.resolve(false)) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);
    fireEvent.change(r.getByTestId('draft-decider-DL-RF'), { target: { value: 'client' } });
    fireEvent.change(r.getByTestId('convert-material-DL-RF-0'), { target: { value: 'Granite' } });
    fireEvent.change(r.getByTestId('convert-material-DL-RF-1'), { target: { value: 'Quartz' } });
    fireEvent.click(r.getByTestId('convert-confirm-DL-RF'));
    await waitFor(() => expect((r.getByTestId('convert-confirm-DL-RF') as HTMLButtonElement).disabled).toBe(false));
    // the failed edit left the form open for retry and publication usable again
    expect(r.getByTestId('convert-form-DL-RF')).toBeTruthy();
    expect((r.getByTestId('publish-DL-RF') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('round-6 Codex corrections (web arms)', () => {
  it('R6-F1: a DIRECT kind change (choice → record) rides the same publish hold as the conversion Confirm', async () => {
    const { waitFor } = await import('@testing-library/react');
    let settle!: (ok: boolean) => void;
    const inFlight = new Promise<boolean>((res) => { settle = res; });
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-DK', draft: true, deciderKind: 'client' })],
      members: [],
      updateDecisionDraft: (() => inFlight) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);
    expect((r.getByTestId('publish-DL-DK') as HTMLButtonElement).disabled).toBe(false);

    // the choice → record conversion dispatches DIRECTLY (no form) — it must hold Publish
    fireEvent.change(r.getByTestId('draft-decider-DL-DK'), { target: { value: 'none' } });
    await waitFor(() => expect((r.getByTestId('publish-DL-DK') as HTMLButtonElement).disabled).toBe(true));
    // the selector itself is held too, so edits cannot stack while one is in flight
    expect((r.getByTestId('draft-decider-DL-DK') as HTMLSelectElement).disabled).toBe(true);
    expect(r.getByText(/publishing is held until the edit lands/)).toBeTruthy();

    settle(true);
    await waitFor(() => expect((r.getByTestId('publish-DL-DK') as HTMLButtonElement).disabled).toBe(false));
    expect((r.getByTestId('draft-decider-DL-DK') as HTMLSelectElement).disabled).toBe(false);
  });

  it('R6-F1: a member RE-POINT on a member-held draft rides the same hold', async () => {
    const { waitFor } = await import('@testing-library/react');
    let settle!: (ok: boolean) => void;
    const inFlight = new Promise<boolean>((res) => { settle = res; });
    useStore.setState({
      role: 'pmc',
      decisions: [dec({ id: 'DL-MR', draft: true, deciderKind: 'member', deciderMembershipId: 'm-eng-a' })],
      members: [
        { userId: 'u-eng-a', membershipId: 'm-eng-a', name: 'Ravi', email: null, phone: null, role: 'engineer', status: 'active' },
        { userId: 'u-eng-b', membershipId: 'm-eng-b', name: 'Asha', email: null, phone: null, role: 'engineer', status: 'active' },
      ],
      updateDecisionDraft: (() => inFlight) as never,
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);
    fireEvent.change(r.getByTestId('draft-decider-member-DL-MR'), { target: { value: 'm-eng-b' } });
    await waitFor(() => expect((r.getByTestId('publish-DL-MR') as HTMLButtonElement).disabled).toBe(true));
    settle(true);
    await waitFor(() => expect((r.getByTestId('publish-DL-MR') as HTMLButtonElement).disabled).toBe(false));
  });

  it('R6-F5: Publish-all is disabled while ANY decision draft is not ready — no partial batch from a 409 mid-way', () => {
    useStore.setState({
      role: 'pmc',
      decisions: [
        dec({ id: 'DL-OK', draft: true }),
        dec({
          id: 'DL-HALF', draft: true,
          options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile', recommended: true }],
        }),
      ],
      members: [],
      loadTeam: (() => Promise.resolve()) as never,
    } as never);
    const r = render(<DraftsScreen />);
    // the per-row button already refuses; the BATCH must refuse the same readiness
    expect((r.getByTestId('publish-DL-HALF') as HTMLButtonElement).disabled).toBe(true);
    expect((r.getByTestId('publish-all') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('round-7 Codex corrections (web arms)', () => {
  it('R7-F5: the decisions nav badge carries pending + reapprovals — a decider with only a reopened change never sees zero', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useNavItems } = await import('@/layout/useNavItems');
    useStore.setState({
      role: 'engineer',
      sessionUserId: 'u-eng-a',
      decisions: [
        dec({ id: 'DL-RB', status: 'change', deciderKind: 'member', deciderUserId: 'u-eng-a' }),
      ],
    } as never);
    const { result } = renderHook(() => useNavItems());
    const item = result.current.find((m) => m.key === 'client-decisions');
    // the decider route arm added the screen; the badge must carry the SAME combined count
    expect(item).toBeTruthy();
    expect(item!.badge).toBe(1);
  });
});

describe('round-11 Codex corrections (web arms)', () => {
  it('R11-F2: EVERY change-request instruction names the ACTUAL decider — EditState and ChangeModal, with the client-held text byte-identical', async () => {
    const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
    useStore.setState({
      role: 'pmc',
      decisions: [
        dec({ id: 'DL-PCH', title: 'Facade fixing', deciderKind: 'pmc', status: 'change', changeRequest: { reason: 'Lot rejected', costImpact: 0, timeImpactDays: 0 } }),
        dec({ id: 'DL-CCH', title: 'Kitchen top', deciderKind: 'client', status: 'change', changeRequest: { reason: 'Tone', costImpact: 0, timeImpactDays: 0 } }),
      ],
    } as never);
    const r = render(<DecisionLogScreen />);
    // a pmc-held reopening directs its own decider at the PMC, never at the client
    expect(r.getByTestId('edit-state-DL-PCH').textContent).toContain('A change request is with the PMC');
    expect(r.getByTestId('edit-state-DL-PCH').textContent).not.toContain('with the client');
    // the client-held text stays byte-identical to the legacy string
    expect(r.getByTestId('edit-state-DL-CCH').textContent).toContain('A change request is with the client — the decision reopens when they answer.');
    r.unmount();

    // ChangeModal reads the decider of the decision the modal is FOR
    const { ChangeModal } = await import('@/screens/modals/ChangeModal');
    useStore.setState({
      decisions: [dec({ id: 'DL-MLK', title: 'Rebar detail', deciderKind: 'member', deciderUserId: 'u-eng-a', status: 'approved' })],
      modal: { type: 'change', decId: 'DL-MLK', title: 'Rebar detail', changeText: '', changeCost: '', changeTime: '' },
    } as never);
    const m = render(<ChangeModal />);
    expect(m.container.textContent).toContain('re-approved by the named decider');
    expect(m.container.textContent).not.toContain('re-approved by the client');
    m.unmount();
    // …and for a client-held decision the modal keeps the byte-identical legacy sentence
    useStore.setState({
      decisions: [dec({ id: 'DL-CLK', title: 'Kitchen top', deciderKind: 'client', status: 'approved' })],
      modal: { type: 'change', decId: 'DL-CLK', title: 'Kitchen top', changeText: '', changeCost: '', changeTime: '' },
    } as never);
    const c = render(<ChangeModal />);
    expect(c.container.textContent).toContain('re-approved by the client');
  });
});
