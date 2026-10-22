/**
 * A file whose tests each call `vi.resetModules()` and import the app anew pays for its first import of each module
 * (the worker fetching, transforming and evaluating it) inside the first test that imports it, within that test's 5 s,
 * which a loaded runner can spend on the import alone. A file awaits this at its top level instead, while vitest
 * collects it, where no timeout applies; each test's own import then only re-evaluates modules the worker already holds,
 * so it still gets fresh module state. `warm-imports-rule.test.ts` holds every such file to it.
 */
export const warmImports = async (...load: Array<() => Promise<unknown>>) => {
  for (const l of load) await l();
};
