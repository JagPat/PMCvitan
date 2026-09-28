import { ConflictException, Injectable, SetMetadata, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { countersignReloadMessage, declaredDecisionsContract, understandsCountersign } from './decisions-contract';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5e (§A.2, "Browser tabs cannot be drained, so they stand behind a
 * CLIENT CONTRACT boundary") — the `countersign-v1` interceptor, beside the untouched 4b one.
 *
 * Once 4d-iii lets a chain activate, a tab built before 4d could approve a decision, receive the
 * unknown `awaiting_countersign`, report "Approved & locked" and hold no countersign-aware action
 * state; or receive a token whose `architect` role its bundle cannot map. For a request declaring LESS
 * than `countersign-v1`, this interceptor:
 *
 * - STRIPS from every `decisions` array each row carrying a shape the contract introduced
 *   (`awaiting_countersign`, the `architect` designation, an open change request whose `origin` is not
 *   `standard`). Such a row demands nothing a stale tab could do that a reload does not restore.
 * - REFUSES with a reload 409 every request authenticated as an `architect` (the session and shell
 *   reads among them), and every response that MINTS a token carrying the role — `/auth/switch` and
 *   each sign-in route returning a `TokenResult` — because the delivered store hands that role
 *   straight to `screensFor`. A role the bundle cannot map is refused, never hidden.
 * - STRIPS `architect` rows from the surfaces marked `@StripsArchitectRows()`: `/me/memberships`, the
 *   roster `/projects/:projectId/members` and `/me/portfolio`.
 *
 * The additive `countersignRequired` passes through (a stale bundle ignores it). Commands are not
 * judged here: a boundary-time chain read can race the activation it guards, so the declared contract
 * rides the request's `AuthUser` into the command, which re-judges it under its readiness lock
 * (`assertCountersignClient`). Dark until 4d-iii: no row, role or token of these shapes can exist
 * while 4d-i's doors stand.
 */
@Injectable()
export class CountersignCompatInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined>; user?: { role?: string } }>();
    if (understandsCountersign(declaredDecisionsContract(req.headers))) return next.handle();
    if (req.user?.role === 'architect') throw new ConflictException(countersignReloadMessage('The architect role'));
    const stripsArchitectRows = this.reflector.get<boolean>(STRIPS_ARCHITECT_ROWS, context.getHandler()) === true;
    return next.handle().pipe(map((body) => lesserClientBody(body, stripsArchitectRows)));
  }
}

/** Metadata marking a handler whose response is an array of rows carrying a membership `role`. */
export const STRIPS_ARCHITECT_ROWS = 'vitan:countersign-strips-architect-rows';
export const StripsArchitectRows = () => SetMetadata(STRIPS_ARCHITECT_ROWS, true);

/** A decision row's 4d shapes, as the DTO carries them. */
interface DecisionShape {
  status?: unknown;
  deciderKind?: unknown;
  changeRequest?: { origin?: unknown } | null;
}

/** True when a decision row carries a shape `countersign-v1` introduced. Exported for the tripwire. */
export function isCountersignShape(d: DecisionShape | null | undefined): boolean {
  if (!d) return false;
  if (d.status === 'awaiting_countersign' || d.deciderKind === 'architect') return true;
  const origin = d.changeRequest?.origin;
  return origin !== undefined && origin !== 'standard';
}

/**
 * The body a lesser client receives: a minted `architect` token refused, `decisions` rows of a 4d shape
 * stripped, and (on a marked surface) `architect` rows stripped. Every other body passes untouched.
 * Exported for tests.
 */
export function lesserClientBody<T>(body: T, stripsArchitectRows: boolean): T {
  if (body === null || typeof body !== 'object') return body;
  if (stripsArchitectRows && Array.isArray(body)) {
    return (body as unknown[]).filter((row) => (row as { role?: unknown } | null)?.role !== 'architect') as T;
  }
  const obj = body as { token?: unknown; role?: unknown; decisions?: unknown };
  if (typeof obj.token === 'string' && obj.role === 'architect') {
    throw new ConflictException(countersignReloadMessage('The architect role'));
  }
  if (Array.isArray(obj.decisions)) {
    return { ...(body as object), decisions: (obj.decisions as DecisionShape[]).filter((d) => !isCountersignShape(d)) } as T;
  }
  return body;
}
