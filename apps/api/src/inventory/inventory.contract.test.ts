import { describe, it, expect } from 'vitest';
import { INVENTORY_COMMANDS, INVENTORY_QUERIES } from '@vitan/shared';
import { inventoryManifest } from './inventory.manifest';

/** Phase 3 Task 4 — the inventory module implements its shared contract exactly. */
describe('Task 4 — the inventory module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(inventoryManifest.commands).toEqual([...INVENTORY_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(inventoryManifest.queries).toEqual([...INVENTORY_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted from day one)', () => {
    expect(inventoryManifest.readEncapsulated).toEqual(inventoryManifest.ownsModels);
    expect([...(inventoryManifest.ownsModels ?? [])].sort()).toEqual(['stockLot', 'stockTransaction']);
  });

  it('the manifest publishes exactly the §G ledger event', () => {
    expect([...inventoryManifest.producesEvents]).toEqual(['stock.transacted']);
  });

  it('inventory reaches procurement ONLY as a workflow participant — no read edges (§G)', () => {
    expect(inventoryManifest.workflowParticipants).toEqual(['procurement']);
    expect(inventoryManifest.dependsOn).toEqual([]);
  });
});
