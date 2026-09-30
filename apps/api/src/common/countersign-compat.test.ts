import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ConflictException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { $Enums } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';
import { TOKEN_ROLES } from '@vitan/shared';
import { CountersignCompatInterceptor, STRIPS_ARCHITECT_ROWS, isCountersignShape } from './countersign-compat.interceptor';
import { declaredDecisionsContract } from './decisions-contract';
import { OrgsController } from '../orgs/orgs.controller';
import { MembersController } from '../orgs/members.controller';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5e (§A.2) — the `countersign-v1` client boundary: the interceptor's
 * strip and refuse arms, and the COMPLETENESS TRIPWIRE. Every enum value, DTO field, token-minting
 * route and membership surface 4d touches is classified strip / refuse / additive-ignorable with the
 * server-side rule named, and each classification is exercised against the interceptor, so a 4d shape
 * added later without a classification fails here.
 */

const API = join(__dirname, '..', '..');
const REPO = join(API, '..', '..');

const interceptor = new CountersignCompatInterceptor(new Reflector());

/** Run the interceptor for one request and one handler body. */
async function serve(opts: { contract?: string; role?: string; handler?: () => void; body: unknown }): Promise<unknown> {
  const req = { headers: opts.contract ? { 'x-vitan-decisions-contract': opts.contract } : {}, user: opts.role ? { role: opts.role } : undefined };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => opts.handler ?? (() => undefined),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(opts.body) };
  return lastValueFrom(interceptor.intercept(context, next));
}

const LESSER = [undefined, 'recorded-v1', 'something-else'] as const;

describe('the decisions contract a request declares (4d-ii-a / A5e)', () => {
  it('only the exact countersign-v1 value is the 4d contract; anything else non-empty ranks as recorded-v1', () => {
    expect(declaredDecisionsContract({})).toBe('none');
    expect(declaredDecisionsContract({ 'x-vitan-decisions-contract': '' })).toBe('none');
    expect(declaredDecisionsContract({ 'x-vitan-decisions-contract': 'recorded-v1' })).toBe('recorded-v1');
    expect(declaredDecisionsContract({ 'x-vitan-decisions-contract': 'countersign-v2' })).toBe('recorded-v1');
    expect(declaredDecisionsContract({ 'x-vitan-decisions-contract': 'countersign-v1' })).toBe('countersign-v1');
  });
});

describe('the countersign-v1 interceptor (4d-ii-a / A5e)', () => {
  const standard = { id: 'DL-1', status: 'pending', deciderKind: 'client' };
  const awaiting = { id: 'DL-2', status: 'awaiting_countersign', deciderKind: 'client' };
  const architectHeld = { id: 'DL-3', status: 'pending', deciderKind: 'architect' };
  const rejection = { id: 'DL-4', status: 'change', deciderKind: 'client', changeRequest: { reason: 'r', costImpact: 0, timeImpactDays: 0, origin: 'countersign_rejection' } };
  const change = { id: 'DL-5', status: 'change', deciderKind: 'client', changeRequest: { reason: 'r', costImpact: 0, timeImpactDays: 0 } };
  const overlaid = { id: 'DL-6', status: 'pending', deciderKind: 'client', countersignRequired: true };

  it('strips every 4d decision shape from a lesser client, keeping the rest of the body and every other row', async () => {
    for (const contract of LESSER) {
      const body = await serve({ contract, body: { generation: 3, decisions: [standard, awaiting, architectHeld, rejection, change, overlaid] } });
      expect(body, String(contract)).toEqual({ generation: 3, decisions: [standard, change, overlaid] });
    }
  });

  it('serves a countersign-v1 client everything, untouched', async () => {
    const decisions = [standard, awaiting, architectHeld, rejection, change, overlaid];
    expect(await serve({ contract: 'countersign-v1', body: { decisions } })).toEqual({ decisions });
  });

  it('refuses an architect SESSION from a lesser client before the handler, and serves it to countersign-v1', async () => {
    for (const contract of LESSER) {
      await expect(serve({ contract, role: 'architect', body: { decisions: [] } }), String(contract)).rejects.toBeInstanceOf(ConflictException);
    }
    await expect(serve({ contract: 'recorded-v1', role: 'architect', body: {} })).rejects.toThrow(/reload.*countersign-v1/);
    expect(await serve({ contract: 'countersign-v1', role: 'architect', body: { ok: true } })).toEqual({ ok: true });
    expect(await serve({ contract: 'recorded-v1', role: 'pmc', body: { ok: true } })).toEqual({ ok: true });
  });

  it('refuses a minted architect TOKEN to a lesser client; every other token passes', async () => {
    for (const contract of LESSER) {
      await expect(serve({ contract, body: { token: 't', role: 'architect', projectId: 'p' } }), String(contract)).rejects.toBeInstanceOf(ConflictException);
    }
    expect(await serve({ contract: 'recorded-v1', body: { token: 't', role: 'client', projectId: 'p' } })).toEqual({ token: 't', role: 'client', projectId: 'p' });
    expect(await serve({ contract: 'countersign-v1', body: { token: 't', role: 'architect', projectId: 'p' } })).toEqual({ token: 't', role: 'architect', projectId: 'p' });
  });

  it('strips architect rows only on a marked membership surface', async () => {
    const marked = () => undefined;
    Reflect.defineMetadata(STRIPS_ARCHITECT_ROWS, true, marked);
    const rows = [{ projectId: 'p1', role: 'pmc' }, { projectId: 'p2', role: 'architect' }];
    expect(await serve({ contract: 'recorded-v1', handler: marked, body: rows })).toEqual([rows[0]]);
    expect(await serve({ contract: 'countersign-v1', handler: marked, body: rows })).toEqual(rows);
    // an unmarked array is someone else's shape: untouched
    expect(await serve({ contract: 'recorded-v1', body: rows })).toEqual(rows);
  });
});

/**
 * THE COMPLETENESS TRIPWIRE. Each 4d shape has a classification naming its server-side rule; the
 * delivered values are listed so a NEW one is caught unclassified.
 */
describe('the countersign-v1 completeness tripwire (4d-ii-a / A5e)', () => {
  type Classification = 'delivered' | `strip: ${string}` | `refuse: ${string}` | `additive-ignorable: ${string}` | `owed by ${string}` | `not served: ${string}`;

  const STATUS: Record<string, Classification> = {
    pending: 'delivered', approved: 'delivered', change: 'delivered', withdrawn: 'delivered', recorded: 'delivered',
    awaiting_countersign: 'strip: a decisions row with this status (isCountersignShape)',
  };
  const DECIDER_KIND: Record<string, Classification> = {
    client: 'delivered', pmc: 'delivered', member: 'delivered', none: 'delivered',
    architect: 'strip: a decisions row designated to the role (isCountersignShape)',
  };
  const TOKEN_ROLE: Record<string, Classification> = {
    pmc: 'delivered', client: 'delivered', engineer: 'delivered', contractor: 'delivered', consultant: 'delivered', worker: 'delivered',
    architect: 'refuse: an authenticated architect request, and a minted architect token (CountersignCompatInterceptor); strip: architect rows on the membership surfaces',
  };
  const DECISION_FIELD: Record<string, Classification> = Object.fromEntries([
    ...['id', 'title', 'room', 'nodeId', 'status', 'draft', 'ageDays', 'photoSwatch', 'deciderKind', 'deciderMembershipId',
      'deciderUserId', 'options', 'approvedOption', 'material', 'approver', 'date', 'cost', 'onBehalfOf', 'changeRequest',
      'withdrawnAt', 'withdrawnBy', 'withdrawReason', 'consultations', 'approvalCycle'].map((k) => [k, 'delivered' as Classification]),
    ['countersignRequired', 'additive-ignorable: an optional flag a stale bundle never reads'],
  ]);
  const CHANGE_REQUEST_FIELD: Record<string, Classification> = {
    reason: 'delivered', costImpact: 'delivered', timeImpactDays: 'delivered', requestedById: 'delivered',
    origin: 'strip: a decisions row whose open request is not standard (isCountersignShape)',
  };
  /** The DTOs 4d introduces that a later unit serves. 4d-ii-a / A8a serves the forward through the
   *  DELIVERED holder fields (`deciderKind`/`deciderMembershipId`/`deciderUserId` move with it; a
   *  forward to the architect role is stripped by the designation arm above) and adds no DTO; a
   *  forward-history shape, if the client unit wants one, is 4d-ii-b's to classify. */
  const OWED_DTOS: Record<string, Classification> = {
    // 4d-ii-b / B5b closed the entry: the client renders NO forward history — the register reads the holder from
    // the delivered decider fields A8a moves — so no DTO exists to classify. Should one be added later, it must
    // be classified here (strip / refuse / additive-ignorable) in the same change (the assertion below).
    DecisionForward: 'not served: 4d-ii-b renders no forward history; the holder is read from the delivered decider fields',
  };

  const sharedTypes = readFileSync(join(REPO, 'packages/shared/src/domain/types.ts'), 'utf8');
  const block = (src: string, opener: string) => {
    const at = src.indexOf(opener);
    expect(at, opener).toBeGreaterThanOrEqual(0);
    return src.slice(at, src.indexOf('\n}', at));
  };
  const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('every decision status, decider kind and token role is classified', () => {
    expect(Object.keys($Enums.DecisionStatus).sort()).toEqual(Object.keys(STATUS).sort());
    expect(Object.keys($Enums.DeciderKind).sort()).toEqual(Object.keys(DECIDER_KIND).sort());
    expect([...TOKEN_ROLES].sort()).toEqual(Object.keys(TOKEN_ROLE).sort());
  });

  /**
   * Both declarations of the wire shape are scanned: the shared `Decision` the client reads, and the
   * API's `DecisionDto` the serializer returns and the projection stores (#657's review round 1: a
   * field the serializer emits must be declared on the DTO it returns, or the canonical type cannot
   * represent the wire the boundary depends on).
   */
  const DTO_DECLARATIONS: Array<[string, string]> = [
    ['packages/shared/src/domain/types.ts', 'export interface Decision {'],
    ['apps/api/src/snapshot/types.ts', 'export interface DecisionDto {'],
  ];

  it('every field of the Decision DTO, and of its change request, is classified, in both declarations', () => {
    for (const [file, opener] of DTO_DECLARATIONS) {
      const decision = withoutComments(block(readFileSync(join(REPO, file), 'utf8'), opener));
      const top = [...decision.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
      expect(top.sort(), file).toEqual(Object.keys(DECISION_FIELD).sort());
      const at = decision.indexOf('changeRequest?: {');
      const cr = decision.slice(at + 'changeRequest?: {'.length, decision.indexOf('}', at));
      const nested = [...cr.matchAll(/(\w+)\??:/g)].map((m) => m[1]!);
      expect(nested.sort(), `${file} changeRequest`).toEqual(Object.keys(CHANGE_REQUEST_FIELD).sort());
    }
  });

  it('a 4d DTO a later unit serves is classified before it exists', () => {
    for (const [dto, verdict] of Object.entries(OWED_DTOS)) {
      const exists = new RegExp(`export (interface|type) ${dto}\\b`).test(sharedTypes);
      const unclassified = verdict.startsWith('owed by') || verdict.startsWith('not served');
      expect(exists && unclassified, `${dto} now exists: classify it (strip / refuse / additive-ignorable)`).toBe(false);
    }
  });

  it('every strip classification is borne out by the interceptor, and the additive field passes', () => {
    const row = (over: object) => ({ id: 'DL', status: 'pending', deciderKind: 'client', ...over });
    for (const [status, c] of Object.entries(STATUS)) expect(isCountersignShape(row({ status })), status).toBe(c.startsWith('strip'));
    for (const [deciderKind, c] of Object.entries(DECIDER_KIND)) expect(isCountersignShape(row({ deciderKind })), deciderKind).toBe(c.startsWith('strip'));
    expect(isCountersignShape(row({ changeRequest: { origin: 'countersign_rejection' } }))).toBe(CHANGE_REQUEST_FIELD.origin!.startsWith('strip'));
    expect(isCountersignShape(row({ changeRequest: { origin: 'standard' } }))).toBe(false);
    expect(isCountersignShape(row({ countersignRequired: true }))).toBe(false);
  });

  it('every token role classified refuse is refused, as a session and as a minted token', async () => {
    for (const [role, c] of Object.entries(TOKEN_ROLE)) {
      const refused = c.startsWith('refuse');
      const session = serve({ contract: 'recorded-v1', role, body: { ok: true } });
      const minted = serve({ contract: 'recorded-v1', body: { token: 't', role, projectId: 'p' } });
      if (refused) {
        await expect(session, role).rejects.toBeInstanceOf(ConflictException);
        await expect(minted, role).rejects.toBeInstanceOf(ConflictException);
      } else {
        await expect(session, role).resolves.toEqual({ ok: true });
        await expect(minted, role).resolves.toEqual({ token: 't', role, projectId: 'p' });
      }
    }
  });

  /**
   * Every route whose service method returns a `TokenResult` is enumerated from source: the auth
   * service's `Promise<TokenResult>` methods, then every controller call to one. Each is covered by the
   * interceptor's token rule, which judges the RESPONSE (any body with a `token` and the role), so a
   * route added later is covered by construction; the registry makes it seen.
   */
  it('every token-minting route is enumerated and covered', () => {
    const service = readFileSync(join(API, 'src/auth/auth.service.ts'), 'utf8');
    const minting = [...service.matchAll(/async (\w+)\([^)]*\)[^{]*?Promise<TokenResult>/gs)].map((m) => m[1]!);
    expect(minting.length).toBeGreaterThan(0);
    const ROUTES: Record<string, Classification> = {
      'src/auth/auth.controller.ts switchProject': 'refuse: a minted architect token (the switch into an architect membership)',
      'src/auth/auth.controller.ts session': 'refuse: a minted architect token (the dev session)',
      'src/auth/auth.controller.ts login': 'refuse: a minted architect token (sign-in)',
      'src/auth/auth.controller.ts signInUser': 'refuse: a minted architect token (/auth/password/complete)',
      'src/auth/auth.controller.ts verifyOtp': 'refuse: a minted architect token (sign-in)',
      'src/auth/auth.controller.ts verifyEmailOtp': 'refuse: a minted architect token (sign-in)',
      'src/auth/auth.controller.ts googleSignIn': 'refuse: a minted architect token (sign-in)',
      'src/auth/auth.controller.ts workerToken': 'refuse: a minted architect token (the device flow mints `worker`; covered all the same)',
    };
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.controller.ts')) {
          const src = readFileSync(full, 'utf8');
          for (const m of minting) if (new RegExp(`\\.${m}\\(`).test(src)) found.push(`${relative(API, full).split('\\').join('/')} ${m}`);
        }
      }
    };
    walk(join(API, 'src'));
    expect(found.sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it('the membership surfaces that carry a role are marked to strip architect rows', () => {
    const reflector = new Reflector();
    const SURFACES: Array<[string, (...a: never[]) => unknown]> = [
      ['/me/memberships', OrgsController.prototype.memberships],
      ['/me/portfolio', OrgsController.prototype.portfolio],
      ['/projects/:projectId/members', MembersController.prototype.list],
    ];
    for (const [route, handler] of SURFACES) expect(reflector.get(STRIPS_ARCHITECT_ROWS, handler), route).toBe(true);
  });
});
