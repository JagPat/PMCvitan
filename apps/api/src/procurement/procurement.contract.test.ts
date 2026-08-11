import { describe, it, expect } from 'vitest';
import { PROCUREMENT_COMMANDS, PROCUREMENT_QUERIES } from '@vitan/shared';
import { procurementManifest } from './procurement.manifest';

/** Phase 3 Task 2 — the procurement module implements its shared contract exactly. */
describe('Task 2 — the procurement module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(procurementManifest.commands).toEqual([...PROCUREMENT_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(procurementManifest.queries).toEqual([...PROCUREMENT_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted from day one)', () => {
    expect(procurementManifest.readEncapsulated).toEqual(procurementManifest.ownsModels);
    expect([...(procurementManifest.ownsModels ?? [])].sort()).toEqual([
      'deliveryCommitment', 'deliveryPromise',
      'projectVendor', 'purchaseOrder', 'purchaseOrderLine', 'purchaseOrderVersion',
      'quoteComparison', 'requisition', 'requisitionLine', 'rfq', 'vendor', 'vendorQuote', 'vendorQuoteLine',
    ]);
  });

  it('the manifest publishes exactly the §G pipeline events (requisition/comparison + Task-3 po/delivery)', () => {
    expect([...procurementManifest.producesEvents].sort()).toEqual([
      'comparison.approved',
      'delivery.committed',
      'delivery.defaulted',
      'delivery.fulfilled',
      'delivery.revised',
      'po.amended',
      'po.cancelled',
      'po.closed_short',
      'po.issued',
      'requisition.approved',
      'requisition.submitted',
    ]);
  });

  it('procurement invokes exactly two participants — commercial and orgs — and READS neither', () => {
    // Phase 5 Task 1 (§C/§K): all four PO lifecycle sites write or supersede the cost-head
    // attribution inside procurement's own transaction, so the attribution and the version it
    // describes commit together. Procurement still READS nothing from commercial (`dependsOn`
    // unchanged) — that asymmetry is what makes commercial a SINK.
    //
    // Phase 6 unit 6.1a (§A): `orgs` joins for the same reason in the other direction. Creating a
    // vendor mints its orgs-owned `ExternalParty` and binding one records the `ProjectParty`
    // association, both inside procurement's own transaction through `OrgsParticipant`. The test
    // NAME changed with the fact rather than only its expectation — "invokes ONLY the commercial
    // participant" would now be a false sentence sitting above a passing assertion, which is the
    // kind of stale claim this suite exists to prevent.
    //
    // `dependsOn` is deliberately UNCHANGED: a participant edge is a write through the owner, not
    // a read of it. Probe P5 asserts both halves — this declaration, and the continued absence of
    // an `orgs -> procurement` dependency.
    expect(procurementManifest.workflowParticipants).toEqual(['commercial', 'orgs']);
    expect(procurementManifest.dependsOn).toEqual(['activities', 'decisions']);
  });
});
