import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Decision } from '@vitan/shared';

/**
 * UX Wave 0 unit F-1b, review round 14 — THE THREE STATES THE BROWSER SWEEP CANNOT REACH.
 *
 * `mobile-fields.spec.ts` measures real geometry in a real browser, which is the only way to
 * prove a 44×44 target. But it can only measure what it RENDERS, and five review rounds running
 * it has been the reach and not the rule that failed: round 9 a third option, round 11 an empty
 * discipline, round 12 a server-backed category, round 13 a state opened by INTERACTION, and now
 * three states no walk can enter at all —
 *
 *   · the consultation RESPONDER's compose box, which renders only when `sessionUserId` is the
 *     consultee of an unanswered question. The sweep signs in as each persona in turn and asks
 *     the questions; being asked one is a different session.
 *   · the Team Access PHONE and worker OTP steps, three and four transitions into a state
 *     machine the sweep never advances, because advancing it signs the sweep out.
 *   · a Team screen COMPANY row, which needs `companies` to be non-empty — the demo store ships
 *     it empty and round 13's server-backed seed populated `members` and `failedEvidence` only.
 *
 * So these arms render the component in that exact state directly. jsdom performs no layout, so
 * they do NOT measure a box — they assert that the floor DECLARATION reaches the element in the
 * state that renders it, which is the half the browser sweep could not observe at all. The
 * browser keeps the geometry for every state it does reach; this file keeps the states it
 * cannot. Neither claim is the other's.
 */

const FLOOR = 44;

/** the inline floor as the element carries it, in px */
function declaredFloor(el: HTMLElement): { minHeight: number; minWidth: number } {
  return {
    minHeight: parseFloat(el.style.minHeight || '0') || 0,
    minWidth: parseFloat(el.style.minWidth || '0') || 0,
  };
}

async function freshStore() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  return { useStore, scope };
}

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.resetModules(); });
beforeEach(() => { vi.unstubAllEnvs(); });

describe('F-1b — the 44px floor in states the browser sweep cannot enter', () => {
  it('the CONSULTEE\'s recommendation selector carries the floor', async () => {
    const { useStore, scope } = await freshStore();
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'villa-b',
      projectLoadState: 'ready',
      role: 'architect',
      // the viewer IS the consultee — the session the sweep never has
      sessionUserId: 'u-architect',
      members: [
        { membershipId: 'm-1', userId: 'u-architect', name: 'Ar. Meera', role: 'architect', status: 'active' },
        { membershipId: 'm-2', userId: 'u-pmc', name: 'PMC', role: 'pmc', status: 'active' },
      ] as never,
    });
    const decision: Decision = {
      id: 'D-1', title: 'Floor tile', room: 'Hall', status: 'pending', draft: false,
      photoSwatch: 'sw', deciderKind: 'client', approvalCycle: 0,
      options: [
        { key: 'a', label: 'Granite', material: 'Granite', delta: 0, swatch: 's1' },
        { key: 'b', label: 'Quartz', material: 'Quartz', delta: 100, swatch: 's2' },
      ],
      consultations: [{
        id: 'c-1', consulteeMembershipId: 'm-1', consulteeUserId: 'u-architect',
        requestedById: 'u-pmc', question: 'Which reads better in daylight?', openCycle: 0,
        requestedAt: '2026-09-11T00:00:00.000Z',
      }],
    } as never;

    const { ConsultationThread } = await import('@/components/ConsultationThread');
    const { getByTestId, getByLabelText } = render(<ConsultationThread decision={decision} />);

    // the state really is the responder's — if this box is absent the assertion below would be
    // measuring nothing, which is the failure mode this whole file exists to answer
    expect(getByTestId('consultation-respond-D-1')).toBeTruthy();
    const select = getByLabelText('Recommend an option') as HTMLElement;
    expect(declaredFloor(select).minHeight).toBeGreaterThanOrEqual(FLOOR);
  });

  it('a COMPANY row\'s edit and remove actions carry the floor', async () => {
    const { useStore, scope } = await freshStore();
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'villa-b',
      projectLoadState: 'ready',
      role: 'pmc',
      sessionUserId: 'u-pmc',
      // TeamScreen resolves authority from the MEMBERSHIP when it has one and falls back to the
      // session role only when it does not — so the demo memberships have to be replaced, not
      // just the role. Leaving them is how the first version of this arm rendered the company
      // row with no actions on it and measured nothing.
      memberships: [{ projectId: 'villa-b', role: 'pmc', orgId: 'org-1' }] as never,
      // the demo store ships this EMPTY, which is why no walk has ever rendered these two buttons
      companies: [{ id: 'co-1', name: 'Shree Consultants', contactName: 'R. Shah', contactPhone: '', contactEmail: '', notes: '' }] as never,
    });
    const { TeamScreen } = await import('@/screens/TeamScreen');
    const { getByLabelText } = render(<TeamScreen />);
    for (const label of ['Edit Shree Consultants', 'Remove Shree Consultants']) {
      const btn = getByLabelText(label) as HTMLElement;
      const box = declaredFloor(btn);
      expect(box.minHeight, `${label} height`).toBeGreaterThanOrEqual(FLOOR);
      expect(box.minWidth, `${label} width`).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it('the Team Access phone and worker-OTP text actions carry the floor', async () => {
    const { useStore } = await freshStore();
    // THE PHONE STEP — three transitions in, and the sweep cannot take them without signing out
    useStore.setState((s) => ({ access: { ...(s as { access: object }).access, step: 'phone', trade: 'mason' } } as never));
    const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
    const phone = render(<TeamAccessScreen />);
    const goLogin = phone.getByTestId('go-login') as HTMLElement;
    expect(declaredFloor(goLogin).minHeight, 'Sign in with email').toBeGreaterThanOrEqual(FLOOR);
    cleanup();

    // THE WORKER OTP STEP — one further transition, and it needs a code the sweep cannot produce
    useStore.setState((s) => ({ access: { ...(s as { access: object }).access, step: 'otp', phone: '9876543210' } } as never));
    const otp = render(<TeamAccessScreen />);
    const resend = otp.getByRole('button', { name: /resend/i }) as HTMLElement;
    expect(declaredFloor(resend).minHeight, 'Resend').toBeGreaterThanOrEqual(FLOOR);
  });
});
