/**
 * The project name a given test ATTEMPT works in.
 *
 * Attempt 0 is the bare base, so an ordinary run — and a local re-run — keeps reusing one project
 * instead of piling them up. Every retry gets its own, because a retry MUST NOT inherit the project
 * a failed attempt already mutated: `commercial` activation is idempotent by RE-ASSERTING its plan,
 * and the pilot suite's plan maps zero PO lines, which is true of a fresh project and of nothing
 * else. A retry over a used project is therefore refused — correctly — and dies in `beforeAll` for
 * a different reason than the attempt it was meant to re-run.
 *
 * It lives in its own module so the rule has ONE definition that both the spec and its unit
 * coverage can import. Importing the spec itself would execute `test.describe.configure()` outside
 * a Playwright runner, so a shared derivation cannot live inside it.
 */
export function attemptName(base: string, retry: number): string {
  return retry > 0 ? `${base} retry ${retry}` : base;
}
