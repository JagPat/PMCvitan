import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildRuntimeProgram } from './module-registry/boundary-analyzer';

/**
 * #482 — the project removal writes every module's tables, which no module may do. It is allowed
 * only as an operator tool the server never loads; this keeps it that way.
 */
describe('project:remove stays outside the server', () => {
  it('is not among the files the running application loads', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const { runtimeFiles } = buildRuntimeProgram({ srcRoot: src, tsconfigPath: join(src, '..', 'tsconfig.json') });
    const loaded = [...runtimeFiles].map((f) => f.replace(/\\/g, '/'));
    expect(loaded.length, 'the runtime program was built').toBeGreaterThan(100);
    expect(loaded.some((f) => f.endsWith('/platform/capabilities.service.ts')), 'platform services are loaded').toBe(true);
    expect(loaded.filter((f) => /\/platform\/project-remove(\.cli)?\.ts$/.test(f))).toEqual([]);
  }, 120_000); // building the whole server's program takes seconds, more under a parallel run
});
