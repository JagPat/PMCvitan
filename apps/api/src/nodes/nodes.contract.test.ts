import { describe, it, expect } from 'vitest';
import { nodesManifest } from './nodes.manifest';
import { NodesQueryService } from './nodes.query';

/** #1177 VT2-B — another module asks the nodes module only what its manifest declares, and the query service answers each. */
describe('the nodes module implements its declared queries', () => {
  it('every declared query is a method of NodesQueryService', () => {
    expect(nodesManifest.queries).toEqual(['nodes.placeHiddenFrom']);
    for (const q of nodesManifest.queries) {
      expect(typeof (NodesQueryService.prototype as unknown as Record<string, unknown>)[q.split('.')[1]!], q).toBe('function');
    }
  });
});
