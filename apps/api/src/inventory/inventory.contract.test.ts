import { describe, it, expect } from 'vitest';
import { INVENTORY_COMMANDS, INVENTORY_QUERIES } from '@vitan/shared';
import { inventoryManifest } from './inventory.manifest';

/** Phase 3 Tasks 4–5 — the inventory module implements its shared contract exactly. */
describe('Tasks 4–5 — the inventory module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract (13 incl. the Task-5 store-to-site flows)', () => {
    expect(inventoryManifest.commands).toEqual([...INVENTORY_COMMANDS]);
    expect(INVENTORY_COMMANDS).toHaveLength(13);
  });

  it('the manifest queries EQUAL the shared query contract (store + the §E issues read)', () => {
    expect(inventoryManifest.queries).toEqual([...INVENTORY_QUERIES]);
    expect([...INVENTORY_QUERIES]).toEqual(['stock.store', 'stock.issues']);
  });

  it('the module read-encapsulates every model it owns (fully extracted from day one)', () => {
    expect(inventoryManifest.readEncapsulated).toEqual(inventoryManifest.ownsModels);
    expect([...(inventoryManifest.ownsModels ?? [])].sort()).toEqual(['materialIssue', 'stockLot', 'stockTransaction']);
  });

  it('the manifest publishes exactly the §G ledger + issue events', () => {
    expect([...inventoryManifest.producesEvents].sort()).toEqual(['issue.recorded', 'stock.transacted']);
  });

  it('inventory reaches procurement AND activities ONLY as workflow participants — no read edges (§G)', () => {
    expect(inventoryManifest.workflowParticipants).toEqual(['procurement', 'activities']);
    expect(inventoryManifest.dependsOn).toEqual([]);
  });
});
