import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { effectCoverageVersion } from '../../src/platform/external-effects';

/**
 * Phase 6 unit 4d-i-b — U2: the change-request BUNDLE SEALS and the transition RECORDERS
 * (docs/superpowers/plans/2026-09-21-4d-i-b-additive-units.md).
 *
 * U2 installs the two deferred bundle seals — `ChangeRequest_t4d_paired` (the request side) and
 * `Decision_t4d_change_paired` (the decision side) — plus the two transition recorders and the
 * transaction-scoped audit count they read. The seals JUDGE the opening, closure and reapproval
 * bundle in both write orders; they CLAIM nothing (the claimants are U3).
 *
 * BOTH seals are DARK until U3's flip. They gate on `phase6_t4d_change_pairing_active()`, which is
 * TRUE only once a coverage generation carries `pairingRequired = true` for the change/approval
 * keys — which no generation does until U3. So the proof has two halves:
 *
 *   · DORMANCY: with no flagged generation (the plain migrated database), an INCOMPLETE opening —
 *     a standard request with its decision move and event but NO audit row — COMMITS. U2 refuses
 *     nothing a release produces before the flip.
 *   · THE RULE, made observable by planting a TEST-FLAGGED generation (the declared bypass:
 *     `session_replication_role = 'replica'` while copying the live change-key rows with
 *     `pairingRequired = true`, so the catalog's own INSERT seals are not the thing under test).
 *     Its mere EXISTENCE flips the global gate on, so the bundle seals judge every change request.
 *
 * The bundles themselves emit their events at the CURRENT (unflagged) generation, so 4d-i's kernel
 * `DomainEvent_t4d_pairing_claimed` seal and U1's actor seal stay dormant on the event's own row —
 * leaving U2's bundle seals as the ONLY thing judging the bundle. That is what makes each refusal
 * below a statement about U2 and not about a claim seal U3 has yet to install.
 *
 * ON A COPY of the migrated database, rebuilt per case: the seals refuse the DELETEs a shared
 * cleanup would need, and a fresh copy is what makes "this bundle alone" a statement about it.
 */

const TEMPLATE = (() => {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test';
  return new URL(raw).pathname.replace(/^\//, '');
})();
const RUN_DB = 't4dib_u2_run';

function url(db: string): string {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test';
  const u = new URL(raw);
  u.search = '';
  u.pathname = `/${db}`;
  return u.toString();
}

/** psql, returning {ok, output}. Never throws on SQL error — the outcome IS the measurement. */
function psql(db: string, sql: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', url(db), '-c', sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** the generation the app emits under — every change-key row here is pairingRequired = false */
const CURRENT = effectCoverageVersion();
/** a synthetic generation this suite plants with pairingRequired = true, to flip the gate on */
const FLAGGED = 'u2-test-flagged-generation';

// ── THE WORLD every case starts from: a pmc/client/engineer, a pending decision and an approved one
const WORLD = `
INSERT INTO "Org" ("id","name","slug") VALUES ('mx-org','MX Org','mx-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('mx-proj','mx-org','MX Site','MX','','Finishing','MX-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
  ('mx-pmc','mx-proj','pmc','MX PMC','+910000000101'),
  ('mx-client','mx-proj','client','MX Client','+910000000102'),
  ('mx-eng','mx-proj','engineer','MX Engineer','+910000000103');
INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
  ('mx-mem-p','mx-proj','mx-pmc','pmc','active'),
  ('mx-mem-c','mx-proj','mx-client','client','active'),
  ('mx-mem-e','mx-proj','mx-eng','engineer','active');
BEGIN;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
  VALUES ('mx-dec2','mx-proj','MX Approved','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('mx-opt2-a','mx-dec2','Option A','a','Granite',0,'sw1',0), ('mx-opt2-b','mx-dec2','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'mx-dec2';
UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';
COMMIT;
INSERT INTO "ProjectEventStream" ("projectId","nextPosition") VALUES ('mx-proj', 0) ON CONFLICT ("projectId") DO NOTHING;
`;

/** the declared test bypass: writes past every seal, for a world state (or catalog row) no
 *  delivered writer produces. Never wraps the operation UNDER TEST, whose seals fire at commit. */
const HAND = (sql: string) => `SET session_replication_role = 'replica'; ${sql} SET session_replication_role = 'origin';`;

/** flip the gate on: the live change-key rows, copied verbatim except a NEW coverage version and
 *  pairingRequired = true. Planted BY HAND so the catalog's own INSERT seals are not what this
 *  suite measures; the bundle seals fire on the change request, at 'origin'. */
const PLANT_FLAG = HAND(`
INSERT INTO "ExternalEffectCatalog" ("coverageVersion","effectKey","eventType","invalidate","pushRoles","pushFamily","frozenAudience","requiresPush","audience","pushBody","pairingRequired")
  SELECT '${FLAGGED}', c."effectKey", c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience", c."requiresPush", c."audience", c."pushBody", TRUE
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = '${CURRENT}'
     AND c."effectKey" IN ('decision.change_requested','decision.change_withdrawn','decision.approved','decision.reapproved');
`);

/** an event planted `emitEvent`'s way — the ALLOCATOR protocol inline: increment
 *  `ProjectEventStream."nextPosition"` then insert at `nextPosition - 1` in ONE transaction, so the
 *  allocator is never left behind the stream. No position is chosen by hand, so this satisfies
 *  `ProjectEventStream_t4d_allocation` and builds the full `DomainEvent_t4d_envelope` (intent by the
 *  catalog key, invalidate and push copied from the row) — not a legacy bypass. Emitted at CURRENT
 *  so 4d-i's kernel claim seal and U1's actor seal stay dormant on the event's own row, leaving U2's
 *  bundle seal the one thing to judge. */
const EV = (o: { id: string; type: string; dec: string; actor: string; push?: string }) => `
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'mx-proj';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","actorId","entityType","entityId","payload","dispatchIntent")
      SELECT '${o.id}','${o.type}',1,'mx-org','mx-proj',s."nextPosition" - 1,'human',NULL,'${o.actor}','Decision','${o.dec}','{}'::jsonb,
             jsonb_build_object('effectKey','${o.type}','coverageVersion',c."coverageVersion",'invalidate',c."invalidate"${o.push ?? ''})
        FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
       WHERE s."projectId" = 'mx-proj' AND c."effectKey" = '${o.type}' AND c."coverageVersion" = '${CURRENT}';`;
/** the audit register row the delivered writer appends beside its fact */
const AU = (dec: string, type: string) =>
  `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES (md5(random()::text), '${dec}', '${type}', 'mx');`;
const TX = (...parts: string[]) => `BEGIN; ${parts.join('\n')} COMMIT;`;

type Order = 'fact-first' | 'event-first';
/** the delivered `requestChange` on the approved mx-dec2, at CURRENT */
const OPENING = (o: { cr: string; ev: string; order?: Order; audit?: boolean; event?: boolean }) => {
  const fact = `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","requestedById")
      VALUES ('${o.cr}','mx-proj','mx-dec2','the ask',0,0,'open','mx-pmc');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.change_requested', dec: 'mx-dec2', actor: 'mx-pmc' });
  const audit = o.audit === false ? '' : AU('mx-dec2', 'change_requested');
  return TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
    o.order === 'event-first' ? event + fact : fact + event, audit);
};
/** the decision moved into `change` with its event and audit but NO request — the missing converse */
const OPENING_NO_REQUEST = (ev: string) => TX(
  `UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
  EV({ id: ev, type: 'decision.change_requested', dec: 'mx-dec2', actor: 'mx-pmc' }),
  AU('mx-dec2', 'change_requested'));
/** the delivered `withdrawChange`: restore the decision, close the request, audit, event */
const WITHDRAWAL = (o: { cr: string; ev: string; order?: Order; audit?: boolean }) => {
  const closure = `UPDATE "ChangeRequest" SET "status" = 'withdrawn', "resolution" = 'withdrawn', "resolvedById" = 'mx-pmc', "resolvedAt" = now() WHERE "id" = '${o.cr}';`;
  const event = EV({ id: o.ev, type: 'decision.change_withdrawn', dec: 'mx-dec2', actor: 'mx-pmc' });
  const audit = o.audit === false ? '' : AU('mx-dec2', 'change_withdrawn');
  return TX(`UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';`,
    o.order === 'event-first' ? event + closure : closure + event, audit);
};
/** the delivered `approve` from `change` — the reapproval: closes the open request as resolved */
const REAPPROVAL = (o: { rev: string; ev: string; cr: string; closure?: boolean }) => {
  const cmd = `${o.rev}-cmd`;
  const act = `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';
    ${o.closure === false ? '' : `UPDATE "ChangeRequest" SET "status" = 'resolved', "resolution" = 'reapproved', "resolvedById" = 'mx-pmc', "resolvedAt" = now() WHERE "id" = '${o.cr}';`}
    INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
      VALUES ('${o.rev}','mx-proj','mx-dec2',1,'a',now(),'mx-pmc','${cmd}');`;
  const event = EV({ id: o.ev, type: 'decision.reapproved', dec: 'mx-dec2', actor: 'mx-pmc',
    push: `, 'push', jsonb_build_object('body','reapproved','roles', c."pushRoles")` });
  const audit = AU('mx-dec2', 'reapproved');
  return TX(
    `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
       VALUES ('${cmd}','project','mx-org','mx-proj','mx-pmc','decisions.approve','${cmd}-key','${cmd}-hash','reserved');`,
    act + event, audit,
    `UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'mx-dec2' WHERE "id" = '${cmd}';`);
};

function reset(): void {
  psql('postgres', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`);
  psql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEMPLATE}' AND pid <> pg_backend_pid()`);
  const created = psql('postgres', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${TEMPLATE}"`);
  expect(created.ok, created.output).toBe(true);
  const world = psql(RUN_DB, WORLD);
  expect(world.ok, `the world must plant:\n${world.output}`).toBe(true);
}

describe('phase 6 unit 4d-i-b U2 — the change-request bundle seals and transition recorders', () => {
  beforeEach(reset);

  // ── DORMANCY: with no flagged generation the seals never fire, so an incomplete bundle commits.
  it('is DARK before the flip: an opening with its move and event but NO audit row commits', () => {
    const r = psql(RUN_DB, OPENING({ cr: 'cr-dark', ev: 'ev-dark', audit: false }));
    expect(r.ok, `with no generation flagged the bundle seal must refuse nothing:\n${r.output}`).toBe(true);
  });

  it('is DARK before the flip: the gate function reports inactive', () => {
    const r = psql(RUN_DB, `SELECT phase6_t4d_change_pairing_active() AS active;`);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toMatch(/\bf\b/u);   // active = false
  });

  it('a flagged generation flips the gate active', () => {
    psql(RUN_DB, PLANT_FLAG);
    const r = psql(RUN_DB, `SELECT phase6_t4d_change_pairing_active() AS active;`);
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toMatch(/\bt\b/u);   // active = true
  });

  // ── THE OPENING BUNDLE, once the gate is active — both write orders commit.
  for (const order of ['fact-first', 'event-first'] as Order[]) {
    it(`the complete standard opening commits ${order}`, () => {
      psql(RUN_DB, PLANT_FLAG);
      const r = psql(RUN_DB, OPENING({ cr: `cr-${order}`, ev: `ev-${order}`, order }));
      expect(r.ok, `a complete opening must commit ${order}:\n${r.output}`).toBe(true);
    });
  }

  it('the opening is refused when the audit row is missing (request side)', () => {
    psql(RUN_DB, PLANT_FLAG);
    const r = psql(RUN_DB, OPENING({ cr: 'cr-na', ev: 'ev-na', audit: false }));
    expect(r.ok, r.output).toBe(false);
    expect(r.output).toMatch(/with 0 `change_requested` audit row/u);
  });

  it('the opening is refused when the event is missing (request side)', () => {
    psql(RUN_DB, PLANT_FLAG);
    const r = psql(RUN_DB, OPENING({ cr: 'cr-ne', ev: 'ev-ne', event: false }));
    expect(r.ok, r.output).toBe(false);
    expect(r.output).toMatch(/with 0 `decision\.change_requested` event/u);
  });

  it('a move into change with NO request is refused (decision side — the converse)', () => {
    psql(RUN_DB, PLANT_FLAG);
    const r = psql(RUN_DB, OPENING_NO_REQUEST('ev-nr'));
    expect(r.ok, r.output).toBe(false);
    expect(r.output).toMatch(/approved → change[\s\S]*with 0 open `standard` change request\(s\) born here/u);
  });

  // ── THE WITHDRAWAL BUNDLE — the closure paired with the restoration.
  it('the complete withdrawal commits', () => {
    psql(RUN_DB, PLANT_FLAG);
    expect(psql(RUN_DB, OPENING({ cr: 'cr-w', ev: 'ev-ow' })).ok, 'the opening must land first').toBe(true);
    const r = psql(RUN_DB, WITHDRAWAL({ cr: 'cr-w', ev: 'ev-wd' }));
    expect(r.ok, `a complete withdrawal must commit:\n${r.output}`).toBe(true);
  });

  it('the withdrawal is refused when its audit row is missing (request side)', () => {
    psql(RUN_DB, PLANT_FLAG);
    expect(psql(RUN_DB, OPENING({ cr: 'cr-w2', ev: 'ev-ow2' })).ok).toBe(true);
    const r = psql(RUN_DB, WITHDRAWAL({ cr: 'cr-w2', ev: 'ev-wd2', audit: false }));
    expect(r.ok, r.output).toBe(false);
    expect(r.output).toMatch(/with 0 `change_withdrawn` audit row/u);
  });

  // ── THE REAPPROVAL BUNDLE — the resolution paired with the reapproval's own transition.
  it('the complete reapproval closure commits', () => {
    psql(RUN_DB, PLANT_FLAG);
    expect(psql(RUN_DB, OPENING({ cr: 'cr-r', ev: 'ev-or' })).ok).toBe(true);
    const r = psql(RUN_DB, REAPPROVAL({ rev: 'mx-rev-r', ev: 'ev-re', cr: 'cr-r' }));
    expect(r.ok, `a complete reapproval closure must commit:\n${r.output}`).toBe(true);
  });

  it('a reapproval that leaves its request OPEN is refused (decision side — the missing closure)', () => {
    psql(RUN_DB, PLANT_FLAG);
    expect(psql(RUN_DB, OPENING({ cr: 'cr-r2', ev: 'ev-or2' })).ok).toBe(true);
    const r = psql(RUN_DB, REAPPROVAL({ rev: 'mx-rev-r2', ev: 'ev-re2', cr: 'cr-r2', closure: false }));
    expect(r.ok, r.output).toBe(false);
    expect(r.output).toMatch(/change → approved[\s\S]*with 0 change request\(s\) closed here/u);
  });
});
