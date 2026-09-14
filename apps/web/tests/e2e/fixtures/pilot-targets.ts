import type { CommercialView, CommercialClaimView } from '../../../src/store/commercial';
import type { LabourView } from '../../../src/store/labour';
import type { LabourSpecRef, RequirementListItem, WorkerDto, WorkerAllocationDto } from '@vitan/shared';

const bundle = (): CommercialView => ({
  budget: { positions: [], openExceptions: 0 },
  cashForecast: {
    heads: [],
    totals: {
      budget: '1000.00', committed: '0.00', receivedNotBilled: '0.00', awaitingCertification: '0.00',
      certifiedPayable: '0.00', approved: '0.00', paid: '0.00', exposure: '0.00', headroom: '1000.00',
    },
    refreshedAt: null,
  },
  costHeads: [],
  attributions: [],
});

const claim = (): CommercialClaimView => ({
  bill: {
    id: 'bill-1', vendorId: 'v-1', vendorBillNumber: 'V-1', status: 'certified',
    documentDate: '2026-08-20', statusChangedAt: '2026-08-21T00:00:00.000Z',
    statusReason: null, disputeReason: null, lifecycleVersion: 0,
    createdAt: '2026-08-20T00:00:00.000Z', createdById: 'u-1',
    versions: [{
      id: 'ver-1', version: 1, supersedesVersion: null, claimedAmount: '100.00', lines: [],
      createdAt: '2026-08-20T00:00:00.000Z', createdById: 'u-1',
      supersededAt: null, supersededById: null, supersedeReason: null, live: true,
    }],
  },
  verification: {
    billId: 'bill-1', versionId: 'ver-1', verdict: 'matched', lines: [], exceptions: [],
    billStatus: 'certified',
  },
  certificate: null,
  deductions: {
    billId: 'bill-1', certificateId: null, certifiedAmount: null, deductions: [],
    withheld: '0.00', netPayable: null, billStatus: 'certified',
    advance: { vendorId: 'v-1', advanced: '0.00', recovered: '0.00', recoverable: '0.00' },
  },
  payments: {
    billId: 'bill-1', certificateId: null, approvals: [],
    approved: '0.00', paid: '0.00', approvable: null, billStatus: 'certified',
  },
  measurements: {},
  certifyPreflight: { grantState: 'none', grantId: null, callerActorId: 'u-self', lifecycleVersion: 0, sodCandidates: [] },
  approvePreflight: { grantState: 'none', grantId: null, callerIsCertifier: false, grantCandidates: [] },
});

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

const worker = (id: string, tradeCode: string, over: Partial<WorkerDto> = {}): WorkerDto => ({
  id, name: id, tradeCode, skillCodes: [], activeFrom: '2026-01-01', activeTo: null,
  revokedAt: null, revokedById: null, createdAt: '2026-01-01T00:00:00Z', createdById: 'u', ...over,
});

const alloc = (over: Partial<WorkerAllocationDto>): WorkerAllocationDto => ({
  id: 'AL-1', workerId: 'W-MASON', civilDate: day, shift: 'day', activityId: 'ACT-1',
  requirementId: 'REQ-1', originRevision: 1, labourSpecFingerprint: 'fp', crewId: null,
  capacityCommitmentId: null, status: 'active', allocatedAt: '2026-08-01T02:00:00Z', allocatedById: 'u',
  releasedAt: null, releasedById: null, releaseReason: null, ...over,
});


export function pilotTargetState() {
  const fp = 'target-fixture-mason';
  const labour: LabourView = {
    readiness: { forecast: {} }, requirements: [requirement(fp)],
    workforce: { workers: [worker('W-MASON', 'mason')], crews: [] },
    catalog: { trades: [], skills: [] }, requisitions: [], purchaseOrders: [], commitments: [],
    capacity: { allocations: [alloc({ labourSpecFingerprint: fp })], attendance: [], workFacts: [], skillSubstitutions: [] },
    presence: { civilDate: day, musters: [], mismatches: [] }, productivity: { activities: [] },
    workerFingerprints: { 'W-MASON': [fp] },
  };
  return {
    capabilities: ['commercial', 'labour'], capabilitiesKnown: true,
    commercialView: bundle(), commercialLoad: 'ready',
    commercialBills: [claim().bill], commercialBillsLoad: 'ready',
    commercialClaims: { 'bill-1': claim() }, commercialClaimLoad: { 'bill-1': 'ready' },
    commercialAdvancesLoad: 'ready',
    labourView: labour, labourLoad: 'ready',
  };
}
