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

  it('procurement invokes no foreign participant; its reverse disposition edge is declared by activities', () => {
    expect(procurementManifest.workflowParticipants).toEqual([]);
    expect(procurementManifest.dependsOn).toEqual(['activities', 'decisions']);
  });
});
