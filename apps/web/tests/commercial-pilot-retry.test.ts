import { describe, expect, it } from 'vitest';
import { attemptName } from './e2e-api/attempt-name';
// The spec's SOURCE, not its module: importing the spec would execute
// `test.describe.configure()` outside a Playwright runner. Vite's `?raw` gives the text without
// evaluating it, and unlike a filesystem read it needs neither `process.cwd()` — which this
// package's narrow `process` type does not carry — nor a path that survives the build layout.
import SPEC from './e2e-api/commercial-pilot.spec.ts?raw';

/**
 * The retry-isolation rule, covered where it runs every `pnpm check` rather than only when a
 * browser suite happens to retry.
 *
 * The e2e probe in the spec proves the DERIVATION and the isolation PROPERTY — a used project
 * refuses the zero-line plan, a fresh one accepts it. What it cannot prove is that `beforeAll`
 * still CALLS the derivation: during an ordinary green run `testInfo.retry` is 0, so reverting
 * `beforeAll` to the bare constants would leave every test passing and quietly restore the poison.
 *
 * So the second half here is a coupling pin, in the style this repository already uses for module
 * boundaries. It is deliberately brittle to a refactor: failing loudly on a rename is the correct
 * cost for a rule whose breakage is otherwise invisible until CI burns a whole cycle.
 */
describe('commercial-pilot retry isolation', () => {
  it('gives attempt 0 the bare name and every retry its own', () => {
    expect(attemptName('Base', 0)).toBe('Base');

    const names = [0, 1, 2, 3].map((retry) => attemptName('Base', retry));
    expect(new Set(names).size, 'every attempt must resolve to a distinct project name').toBe(names.length);

    // Attempt 0 stays the bare base ON PURPOSE: an ordinary run and a local re-run keep reusing one
    // project instead of piling them up. Only a retry needs a new one.
    expect(names[0]).toBe('Base');
    for (const name of names.slice(1)) expect(name.startsWith('Base')).toBe(true);
  });

  it('is actually used by beforeAll and by both browser sign-ins', () => {
    // The derivation is reached for BOTH projects…
    expect(SPEC).toMatch(/pilotName\s*=\s*attemptName\(PILOT_NAME,\s*testInfo\.retry\)/u);
    expect(SPEC).toMatch(/plainName\s*=\s*attemptName\(PLAIN_NAME,\s*testInfo\.retry\)/u);

    // …the projects are provisioned from the RESOLVED names, not the constants…
    expect(SPEC).toMatch(/ensureProject\(request,\s*home,\s*orgId,\s*pilotName\)/u);
    expect(SPEC).toMatch(/ensureProject\(request,\s*home,\s*orgId,\s*plainName\)/u);

    // …and so are the browser sign-ins. Without this a retry would sign in to the PREVIOUS
    // attempt's project and assert the browser against state its own API half never touched —
    // a quieter failure than the one being fixed.
    expect(SPEC).not.toMatch(/signInToProject\(page,\s*PMC,\s*PILOT_NAME\)/u);
    expect(SPEC).not.toMatch(/signInToProject\(page,\s*PMC,\s*PLAIN_NAME\)/u);
    expect(SPEC).toMatch(/signInToProject\(page,\s*PMC,\s*pilotName\)/u);
    expect(SPEC).toMatch(/signInToProject\(page,\s*PMC,\s*plainName\)/u);
  });
});
