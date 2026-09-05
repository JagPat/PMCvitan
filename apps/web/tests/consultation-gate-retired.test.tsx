import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { ConsultationThread } from '@/components/ConsultationThread';
import type { Decision, ProjectMember } from '@vitan/shared';

/**
 * Phase 6 unit 4c-iv — the CLIENT half of the gate-read removal, reproduce-first.
 *
 * Through 4c-iii `ConsultationThread` returned `null` unless the shell's `capabilities` named
 * `consultation` — the same per-project gate the write surface read, mirrored so the bundle never
 * rendered controls whose every request 404s. 4c-iv retires the reads on BOTH sides in one unit:
 * the shell stops naming the capability and this component stops asking for it. So the probe is
 * the inverse of the old gate-OFF arm: with `capabilities: []` — exactly what a 4c-iv server now
 * sends — the requester's and the consultee's affordances are RENDERED. RED at the base, where the
 * first line of the component sends both viewers home.
 */

const s = () => useStore.getState();

const member = (over: Partial<ProjectMember> & { userId: string; name: string; role: ProjectMember['role'] }): ProjectMember =>
  ({ email: null, phone: null, status: 'active', membershipId: `m-${over.userId}`, ...over }) as ProjectMember;

const decision = (over: Partial<Decision> & { id: string }): Decision =>
  ({
    title: 'Countertop finish',
    room: 'Kitchen',
    status: 'pending',
    draft: false,
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

describe('Phase 6 unit 4c-iv — the client no longer reads the retired consultation gate', () => {
  it('the REQUESTER sees "Ask a member" on an open decision with capabilities: [] — the list a 4c-iv server sends', () => {
    useStore.setState({
      role: 'pmc',
      sessionUserId: 'u-pmc',
      capabilities: [],
      capabilitiesKnown: true,
      members: [member({ userId: 'u-pmc', name: 'P', role: 'pmc' }), member({ userId: 'u-eng', name: 'E', role: 'engineer' })],
    });
    const { queryByTestId } = render(<ConsultationThread decision={decision({ id: 'd1' })} />);
    expect(queryByTestId('consultation-thread-d1'), 'the thread renders without the capability').not.toBeNull();
    expect(queryByTestId('consultation-ask-d1'), 'and offers the request affordance').not.toBeNull();
  });

  it('the CONSULTEE sees the compose box for their own open question with capabilities: []', () => {
    useStore.setState({
      role: 'engineer',
      sessionUserId: 'u-eng',
      capabilities: [],
      capabilitiesKnown: true,
      members: [member({ userId: 'u-pmc', name: 'P', role: 'pmc' }), member({ userId: 'u-eng', name: 'E', role: 'engineer' })],
    });
    const d = decision({
      id: 'd2',
      approvalCycle: 0,
      consultations: [{
        id: 'c1', consulteeMembershipId: 'm-u-eng', consulteeUserId: 'u-eng', requestedById: 'u-pmc',
        question: 'Primer needed?', openCycle: 0, requestedAt: new Date().toISOString(),
      }],
    });
    const { queryByTestId } = render(<ConsultationThread decision={d} />);
    expect(queryByTestId('consultation-thread-d2')).not.toBeNull();
    expect(queryByTestId('consultation-respond-d2'), 'the consultee may answer without the capability').not.toBeNull();
  });

  it('what still gates is ROLE and OPENNESS, exactly as the server enforces them', () => {
    // a contractor is not in the `consultation.request` ceiling, and an approved decision is closed:
    // with nothing to ask and no thread to show, the component correctly renders nothing — the
    // shared policy and the decision's own state are the eligibility, not a per-project latch
    useStore.setState({
      role: 'contractor', sessionUserId: 'u-con', capabilities: [], capabilitiesKnown: true,
      members: [member({ userId: 'u-con', name: 'C', role: 'contractor' })],
    });
    const { queryByTestId } = render(<ConsultationThread decision={decision({ id: 'd3', status: 'approved' })} />);
    expect(queryByTestId('consultation-thread-d3')).toBeNull();
  });
});
