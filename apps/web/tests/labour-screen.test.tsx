import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { LabourScreen } from '@/screens/LabourScreen';
import { buildWorkerFingerprints } from '@/lib/labourSelection';
import { computeLabourSpecFingerprint } from '@vitan/shared';
import type { WorkerDto, WorkerAllocationDto, CapacityCommitmentDto, RequirementListItem, LabourSpecRef } from '@vitan/shared';
import type { LabourView } from '@/store/labour';

/**
 * Phase 4 Task 6 — Codex correction round 1, the RENDERED Labour hub:
 *
 *  F-PMC (P2)  the manual muster is a `labour.override` exception the server allows ONLY to pmc —
 *              the form must be ABSENT for an engineer session (their click would be a guaranteed
 *              403 the outbox discards as if attendance were recorded).
 *  F1 (P1)     the allocate worker picker offers ONLY compatible workers — an electrician is not
 *              an option for a mason slice.
 *  F6 (P2)     the per-slice "allocated n/m" uses the server's coverage rule — a row stranded on
 *              the requirement's OLD activity does not count.
 *  F2 (P1)     a slice covered by a live same-slice commitment says so (the store action passes
 *              the commitment id — asserted in labour.test.ts; here the surface reflects it).
 */

const day = '2026-08-01';

const labourSpec = (fp: string, over: Partial<LabourSpecRef> = {}): LabourSpecRef => ({
  tradeCode: 'mason', skillCode: null, shift: 'day', labourSpecFingerprint: fp,
  decisionId: null, decisionVersion: null, optionKey: null,
  demandSlices: [{ civilDate: day, shift: 'day', personShiftQty: 1 }],
  ...over,
});

const requirement = (fp: string): RequirementListItem => ({
  id: 'rev-1', requirementId: 'REQ-1', revision: 1, activityId: 'ACT-1', type: 'labour',
  spec: null, labourSpec: labourSpec(fp), qty: '1', baseUom: 'person-shift', requiredBy: day,
  responsibleId: null, criticality: 'normal', tolerance: null, status: 'open',
  createdAt: '2026-07-01T00:00:00Z', createdById: 'u', revisions: 1,
});

const worker = (id: string, tradeCode: string): WorkerDto => ({
  id, name: id, tradeCode, skillCodes: [], activeFrom: '2026-01-01', activeTo: null,
  revokedAt: null, revokedById: null, createdAt: '2026-01-01T00:00:00Z', createdById: 'u',
});

const alloc = (over: Partial<WorkerAllocationDto>): WorkerAllocationDto => ({
  id: 'AL-1', workerId: 'W-MASON', civilDate: day, shift: 'day', activityId: 'ACT-1',
  requirementId: 'REQ-1', originRevision: 1, labourSpecFingerprint: 'fp', crewId: null,
  capacityCommitmentId: null, status: 'active', allocatedAt: '2026-08-01T02:00:00Z', allocatedById: 'u',
  releasedAt: null, releasedById: null, releaseReason: null, ...over,
});

const commitment = (fp: string): CapacityCommitmentDto => ({
  id: 'CC-1', poLineId: 'POL-1', labourSpecFingerprint: fp, civilDate: day, shift: 'day',
  personShiftQty: 1, status: 'committed', latestPromise: null, promises: [],
});

async function primeLabour(over: Partial<LabourView> = {}): Promise<LabourView> {
  const workers = [worker('W-MASON', 'mason'), worker('W-ELEC', 'electrician')];
  const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
  const view: LabourView = {
    readiness: { forecast: {} },
    requirements: [requirement(fp)],
    workforce: { workers, crews: [] },
    catalog: { trades: [], skills: [] },
    requisitions: [],
    purchaseOrders: [],
    commitments: [],
    capacity: { allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] },
    presence: { civilDate: day, musters: [], mismatches: [] },
    productivity: { activities: [] },
    workerFingerprints: await buildWorkerFingerprints(workers),
    ...over,
  };
  useStore.setState({ capabilities: ['labour'], labourView: view, labourLoad: 'ready' });
  return view;
}

beforeEach(() => {
  useStore.setState(getInitialState());
  useStore.getState()._setGateway(null);
});
afterEach(() => cleanup());

describe('CODEX F-PMC — manual muster is pmc-only on the rendered hub', () => {
  it('an ENGINEER session gets NO manual muster form (the server would 403 every click)', async () => {
    await primeLabour();
    useStore.setState({ role: 'engineer' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-attendance'));
    expect(r.queryByTestId('labour-do-muster')).toBeNull();
    expect(r.queryByTestId('labour-muster-worker-select')).toBeNull();
  });

  it('a PMC session keeps the manual exception path', async () => {
    await primeLabour();
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-attendance'));
    expect(r.getByTestId('labour-do-muster')).toBeTruthy();
  });
});

describe('CODEX F1 — the rendered picker offers only compatible workers', () => {
  it('the mason slice offers the mason and NOT the electrician', async () => {
    await primeLabour();
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const select = r.getByTestId(`labour-worker-select-REQ-1-${day}`);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('W-MASON');
    expect(values).not.toContain('W-ELEC');
  });

  it('with NO compatible worker the picker says so instead of offering the wrong crew', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const electricians = [worker('W-ELEC', 'electrician')];
    await primeLabour({
      requirements: [requirement(fp)],
      workforce: { workers: electricians, crews: [] },
      workerFingerprints: await buildWorkerFingerprints(electricians),
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const select = r.getByTestId(`labour-worker-select-REQ-1-${day}`);
    const options = Array.from(select.querySelectorAll('option'));
    expect(options).toHaveLength(1); // only the placeholder
    expect(options[0]!.textContent).toMatch(/No compatible workers/);
  });
});

describe('CODEX F6/F2 — the rendered slice line reflects coverage truth', () => {
  it('a row stranded on the OLD activity shows allocated 0/1 (the replacement is still needed)', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    await primeLabour({
      capacity: { allocations: [alloc({ activityId: 'ACT-OLD', labourSpecFingerprint: fp })], attendance: [], workFacts: [], skillSubstitutions: [] },
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    expect(r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent).toContain('allocated 0/1');
  });

  it('a CURRENT compatible allocation shows allocated 1/1; a live same-slice commitment is surfaced', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    await primeLabour({
      capacity: { allocations: [alloc({ labourSpecFingerprint: fp })], attendance: [], workFacts: [], skillSubstitutions: [] },
      commitments: [commitment(fp)],
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const text = r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!;
    expect(text).toContain('allocated 1/1');
    expect(text).toContain('supplier capacity available');
  });
});
