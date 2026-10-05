/**
 * Phase 6 task 4d-iii / R0a-2 — the actor envelope, answered for MOCKED-prisma unit tests.
 *
 * Since R0a-2, `emitEvent` refuses a human event whose frozen pair does not resolve (the Board's
 * Decision 2). The pair is resolved by `resolveActorEnvelope`'s raw reads: it locks the standing
 * registers, asks `platform_user_holds_role_windowed`, and reads the `UserIdentity` name. A unit
 * test's in-memory `$queryRaw` knows none of those, so every human event it emitted would now be
 * refused. This wraps a test's own `$queryRaw` stub so those reads answer "the token role stands, and
 * the account is named {@link name}". Every other query still reaches the test's stub unchanged.
 *
 * The real predicate and the refusal are proven against PostgreSQL in the integration suite
 * (`phase6-t4d-iii-r0a2-emit-refusal.test.ts`). This stub only lets unit tests that are about
 * something else keep emitting.
 */
type RawQuery = { sql?: string; strings?: readonly string[]; values?: unknown[] } | readonly string[] | undefined;

export function answerActorEnvelope<R>(
  inner: (q: RawQuery, ...rest: unknown[]) => Promise<R>,
  name = 'Test User',
): (q: RawQuery, ...rest: unknown[]) => Promise<R | unknown[]> {
  return async (q: RawQuery, ...rest: unknown[]) => {
    const text = Array.isArray(q) ? q.join('?') : ((q as { sql?: string })?.sql ?? ((q as { strings?: readonly string[] })?.strings ?? []).join('?'));
    if (text.includes('platform_user_holds_role_windowed')) return [{ holds: true }];
    if (text.includes('"UserIdentity"')) return [{ displayName: name }];
    if (text.includes('"OrgUserAuthority"') || text.includes('"ProjectUserStanding"')) return [];
    return inner(q, ...rest);
  };
}
