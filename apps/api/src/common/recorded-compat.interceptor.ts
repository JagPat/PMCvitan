import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';

/** The header a 4b-aware client sends on every API call (the web gateway attaches it
 *  unconditionally). Its VALUE names the first contract the client understands. */
export const DECISIONS_CONTRACT_HEADER = 'x-vitan-decisions-contract';
export const DECISIONS_CONTRACT_RECORDED = 'recorded-v1';

/**
 * Phase 6 unit 4b, replacement round (Codex R2-F1) — protect the PREVIOUS web release from the
 * new `recorded` status. A browser tab still running the pre-4b bundle indexes its four-entry
 * `decisionChip` map with `d.status` and dereferences the result, so a `recorded` row served to
 * it crashes the Decision Log and Places screens; the server-process side of the same exposure
 * is already excluded by the §P6-4a drain-first deploy (one API process, old stops before new
 * starts), but browser tabs cannot be drained.
 *
 * The version boundary is a REQUEST CONTRACT header: a 4b-aware client declares
 * `x-vitan-decisions-contract: recorded-v1` and receives the full register; a request without
 * the declaration (every pre-4b bundle — the header did not exist there) has `recorded` rows
 * STRIPPED from any `decisions` array in the response at the transport boundary. A record is
 * team-visible information demanding nothing, so hiding it from a stale bundle loses no
 * actionable state — the tab renders exactly the register shapes it was built for, and the next
 * full page load picks up the new bundle and the records with it. Transport-layer and
 * removable: no service or serializer carries the compat branch.
 */
@Injectable()
export class RecordedCompatInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const declared = req.headers?.[DECISIONS_CONTRACT_HEADER];
    if (typeof declared === 'string' && declared.length > 0) return next.handle();
    return next.handle().pipe(map((body) => stripRecordedRows(body)));
  }
}

/** Strip `status: 'recorded'` rows from a response body's `decisions` array (snapshot and
 *  module-read shapes alike); every other body passes through untouched. Exported for tests. */
export function stripRecordedRows<T>(body: T): T {
  if (
    body !== null
    && typeof body === 'object'
    && Array.isArray((body as { decisions?: unknown }).decisions)
  ) {
    const decisions = (body as unknown as { decisions: Array<{ status?: unknown }> }).decisions
      .filter((d) => d?.status !== 'recorded');
    return { ...(body as object), decisions } as T;
  }
  return body;
}
