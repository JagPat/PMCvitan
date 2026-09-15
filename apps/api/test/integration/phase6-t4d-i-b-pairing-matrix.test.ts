import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTERNAL_EFFECTS, effectCoverageVersion } from '../../src/platform/external-effects';

/**
 * Phase 6 unit 4d-i-b — THE BUNDLE PROOF MATRIX (#590's review round 2, six P1s, and the
 * transaction-evidence rule in docs/POLICY.md that they produced).
 *
 * WHAT WENT WRONG, ONCE. The switch-on's claimants were written as "claim the event if it is
 * there, otherwise return — a missing counterpart is some other seal's refusal". A one-sided
 * trigger cannot enforce a missing opposite row, `xmin` proves a write and not a transition, and
 * matching an event by project, decision and type does not bind it to the fact's identity or to
 * the person it announces to. Six findings, one shape.
 *
 * WHAT THIS SUITE IS. One table, `MATRIX`, per event type the compiled catalog flips to
 * `pairingRequired`: the delivered writer branch, the fact that is the act's immutable record,
 * the audit row and event it owes, the exact lifecycle transition it rides, and the seals that
 * enforce it. From each row the suite derives, as ordinary `it()`s:
 *
 *   · the COMPLETE bundle commits, fact-first and event-first, and the fact CLAIMS its event;
 *   · the same bundle at the PRIOR generation — a still-serving 4d-i writer — commits too;
 *   · every NEGATIVE variant is refused AT COMMIT: a missing counterpart (fact without event,
 *     fact without audit row, transition without fact), evidence with the wrong identity or the
 *     wrong audience, evidence reused from an earlier transaction or duplicated inside one, and a
 *     no-op write standing in for a real transition — including the drain window's
 *     old-generation shape, where the kernel's own pairing seal is silent by design.
 *
 * and `coverage` asserts that the matrix's keys ARE the compiled catalog's `pairingRequired` keys,
 * so a future flip without executable coverage fails here before it ships.
 *
 * ON A COPY of the migrated test database (`CREATE DATABASE … TEMPLATE`), rebuilt for every
 * case: the seals under test refuse the DELETEs a shared-database cleanup would need, and a
 * fresh copy is what makes "this bundle alone" a statement about the bundle.
 */

/** the URL of the migrated database this suite copies from, and of the copy */
const TEMPLATE = (() => {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test';
  return new URL(raw).pathname.replace(/^\//, '');
})();
const RUN_DB = 't4dib_matrix_run';

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

/** the generation a CURRENT writer emits under, and the one a still-serving 4d-i writer does */
const CURRENT = effectCoverageVersion();
const PRIOR = (() => {
  const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations',
    '20271220000000_phase6_t4d_i_dark_migration', 'migration.sql'), 'utf8');
  const m = sql.match(/INSERT INTO "_t4d_catalog_incoming" \("v"\) VALUES \('([0-9a-f]{64})'\)/);
  if (!m) throw new Error('the 4d-i incoming coverage generation could not be read from its migration');
  return m[1]!;
})();

// ── THE WORLD every case starts from ─────────────────────────────────────────────────────────
// Two projects in two orgs (the cross-project variants need a second one), a pmc, a client and an
// engineer on the first, a pending decision with two options, an approved one, and an allocator
// row per project. Nothing else: every fact, audit row and event a case needs is part of the
// bundle under test, which is the point.
const WORLD = `
INSERT INTO "Org" ("id","name","slug") VALUES ('mx-org','MX Org','mx-org'), ('mx-org2','MX Org 2','mx-org2');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('mx-proj','mx-org','MX Site','MX','','Finishing','MX-01','01 Jan 2026','31 Dec 2026',0,0,0),
         ('mx-proj2','mx-org2','MX Site 2','MX2','','Finishing','MX-02','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
  ('mx-pmc','mx-proj','pmc','MX PMC','+910000000101'),
  ('mx-client','mx-proj','client','MX Client','+910000000102'),
  ('mx-eng','mx-proj','engineer','MX Engineer','+910000000103'),
  ('mx-pmc2','mx-proj2','pmc','MX PMC 2','+910000000104'),
  ('mx-client2','mx-proj2','client','MX Client 2','+910000000105');
INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
  ('mx-mem-p','mx-proj','mx-pmc','pmc','active'),
  ('mx-mem-c','mx-proj','mx-client','client','active'),
  ('mx-mem-e','mx-proj','mx-eng','engineer','active'),
  ('mx-mem-p2','mx-proj2','mx-pmc2','pmc','active'),
  ('mx-mem-c2','mx-proj2','mx-client2','client','active');
BEGIN;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
  VALUES ('mx-dec','mx-proj','MX Pending','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('mx-opt-a','mx-dec','Option A','a','Granite',0,'sw1',0), ('mx-opt-b','mx-dec','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'mx-dec';
COMMIT;
BEGIN;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
  VALUES ('mx-dec2','mx-proj','MX Approved','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('mx-opt2-a','mx-dec2','Option A','a','Granite',0,'sw1',0), ('mx-opt2-b','mx-dec2','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'mx-dec2';
UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';
COMMIT;
BEGIN;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
  VALUES ('mx-decB','mx-proj2','MX Pending B','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('mx-optB-a','mx-decB','Option A','a','Granite',0,'sw1',0), ('mx-optB-b','mx-decB','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'mx-decB';
COMMIT;
INSERT INTO "ProjectEventStream" ("projectId","nextPosition") VALUES ('mx-proj', 0), ('mx-proj2', 0) ON CONFLICT ("projectId") DO NOTHING;
`;

function reset(): void {
  psql('postgres', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`);
  psql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEMPLATE}' AND pid <> pg_backend_pid()`);
  const created = psql('postgres', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${TEMPLATE}"`);
  expect(created.ok, created.output).toBe(true);
  const world = psql(RUN_DB, WORLD);
  expect(world.ok, `the world must plant:\n${world.output}`).toBe(true);
}

// ── THE STATEMENTS a bundle is made of ───────────────────────────────────────────────────────
type Proj = { id: string; org: string };
const P1: Proj = { id: 'mx-proj', org: 'mx-org' };
const P2: Proj = { id: 'mx-proj2', org: 'mx-org2' };

/**
 * an event planted the way `emitEvent` plants one: allocate, then insert at nextPosition - 1, in
 * the SAME transaction — `insertRawEvent`'s protocol, written inline because these bundles run as
 * one psql transaction with the fact and the helper opens a transaction of its own. No position
 * is chosen by hand and no allocation seal is bypassed.
 */
const EV = (o: {
  id: string; type: string; dec: string; version: string; proj?: Proj;
  payload?: string; push?: string;
}) => {
  const p = o.proj ?? P1;
  return `
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = '${p.id}';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","payload","dispatchIntent")
      SELECT '${o.id}','${o.type}',1,'${p.org}','${p.id}',s."nextPosition" - 1,'system','system:mx','Decision','${o.dec}',
             ${o.payload ?? "'{}'::jsonb"},
             jsonb_build_object('effectKey','${o.type}','coverageVersion',c."coverageVersion",'invalidate',c."invalidate"${o.push ?? ''})
        FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
       WHERE s."projectId" = '${p.id}' AND c."effectKey" = '${o.type}' AND c."coverageVersion" = '${o.version}';`;
};
/** the audit register row the delivered writer appends beside its fact */
const AU = (dec: string, type: string) =>
  `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES (md5(random()::text), '${dec}', '${type}', 'mx');`;
/** a command receipt: RESERVED on insert, completed by update, as the ledger protocol demands */
const RESERVE = (id: string, type: string, actor: string, proj: Proj = P1) =>
  `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
     VALUES ('${id}','project','${proj.org}','${proj.id}','${actor}','${type}','${id}-key','${id}-hash','reserved');`;
const COMPLETE = (id: string, resultRef: string) =>
  `UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = '${resultRef}' WHERE "id" = '${id}';`;
const TX = (...parts: string[]) => `BEGIN; ${parts.join('\n')} COMMIT;`;

/** the pairing claims a database holds, sorted by code unit */
const CLAIMS = () => psql(RUN_DB,
  `SELECT "eventId" || ':' || "claimedBy" || ':' || "claimedById" FROM "DomainEventPairingClaim"`)
  .output.trim().split('\n').filter((l) => l && !/^\(|^-|eventId|column/.test(l)).map((l) => l.trim()).sort();

type Order = 'fact-first' | 'event-first';
type Variant = {
  /** the exact defect this variant plants, in the words the finding used */
  name: string;
  /** an optional world beyond `WORLD` — committed BEFORE the bundle, as earlier transactions */
  setup?: string;
  bundle: string;
  /** the seal's own message, so a refusal by an unrelated rule cannot pass the arm */
  refusal: RegExp;
};
type Branch = {
  key: string;
  writer: string;
  fact: string;
  audit: string | null;
  transition: string;
  enforcedBy: string[];
  /** an optional world beyond `WORLD`, committed before the positive bundle */
  setup?: string;
  positive: (order: Order, version: string) => string;
  /** the claim the positive bundle must leave behind: `eventId:table:rowId` */
  claim: string;
  negatives: Variant[];
};

// ── SHARED BUNDLE PIECES ─────────────────────────────────────────────────────────────────────
/** the delivered `requestChange` on the approved decision, at `version` */
const OPENING = (o: { cr: string; ev: string; version: string; order?: Order; audit?: boolean; dec?: string }) => {
  const dec = o.dec ?? 'mx-dec2';
  const fact = `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","requestedById")
      VALUES ('${o.cr}','mx-proj','${dec}','the ask',0,0,'open','mx-pmc');`;
  const event = EV({ id: o.ev, type: 'decision.change_requested', dec, version: o.version });
  const audit = o.audit === false ? '' : AU(dec, 'change_requested');
  return TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = '${dec}';`,
    o.order === 'event-first' ? event + fact : fact + event, audit);
};
/** the delivered `withdrawChange` on the reopened decision */
const WITHDRAWAL = (o: { cr: string; ev: string; version: string; order?: Order; audit?: boolean; dec?: string }) => {
  const dec = o.dec ?? 'mx-dec2';
  const closure = `UPDATE "ChangeRequest" SET "status" = 'withdrawn', "resolution" = 'withdrawn', "resolvedById" = 'mx-pmc', "resolvedAt" = now() WHERE "id" = '${o.cr}';`;
  const event = EV({ id: o.ev, type: 'decision.change_withdrawn', dec, version: o.version });
  const audit = o.audit === false ? '' : AU(dec, 'change_withdrawn');
  return TX(`UPDATE "Decision" SET "status" = 'approved' WHERE "id" = '${dec}';`,
    o.order === 'event-first' ? event + closure : closure + event, audit);
};
/** the delivered `approve` from `pending`: receipt, transition, finalized revision, audit, event */
const APPROVAL = (o: { rev: string; ev: string; version: string; order?: Order; audit?: boolean; event?: boolean; cmd?: string }) => {
  const cmd = o.cmd ?? `${o.rev}-cmd`;
  const act = `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec';
    INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
      VALUES ('${o.rev}','mx-proj','mx-dec',1,'a',now(),'mx-pmc','${cmd}');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.approved', dec: 'mx-dec', version: o.version,
    push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` });
  const audit = o.audit === false ? '' : AU('mx-dec', 'approved');
  return TX(RESERVE(cmd, 'decisions.approve', 'mx-pmc'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, 'mx-dec'));
};
/** the delivered `approve` from `change` — the reapproval: closes the open request `cr` as resolved */
const REAPPROVAL = (o: { rev: string; ev: string; cr: string; version: string; order?: Order; audit?: boolean; event?: boolean; closure?: boolean }) => {
  const cmd = `${o.rev}-cmd`;
  const act = `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';
    ${o.closure === false ? '' : `UPDATE "ChangeRequest" SET "status" = 'resolved', "resolution" = 'reapproved', "resolvedById" = 'mx-pmc', "resolvedAt" = now() WHERE "id" = '${o.cr}';`}
    INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
      VALUES ('${o.rev}','mx-proj','mx-dec2',1,'a',now(),'mx-pmc','${cmd}');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.reapproved', dec: 'mx-dec2', version: o.version,
    push: `, 'push', jsonb_build_object('body','reapproved','roles', c."pushRoles")` });
  const audit = o.audit === false ? '' : AU('mx-dec2', 'reapproved');
  return TX(RESERVE(cmd, 'decisions.approve', 'mx-pmc'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, 'mx-dec2'));
};
/** the delivered `consultations.request`: receipt, fact, targeted event naming the consultation */
const CONSULT = (o: { dc: string; ev: string; version: string; order?: Order; event?: boolean; namedId?: string; consultee?: string; target?: string; proj?: Proj; dec?: string; cmd?: string }) => {
  const cmd = o.cmd ?? `${o.dc}-cmd`;
  const dec = o.dec ?? 'mx-dec';
  const fact = `INSERT INTO "DecisionConsultation" ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","requestedAt","sourceCommandId")
      VALUES ('${o.dc}','mx-proj','${dec}','mx-pmc','mx-mem-e','mx-eng','which finish?',0,now(),'${cmd}');`;
  const named = o.namedId ?? o.dc;
  const consultee = o.consultee ?? 'mx-eng';
  const target = o.target ?? consultee;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.consultation_requested', dec, version: o.version, proj: o.proj,
    payload: `jsonb_build_object('consultationId','${named}','consulteeUserId','${consultee}')`,
    push: `, 'push', jsonb_build_object('body','asked','roles', jsonb_build_array('engineer'),'targetUserId','${target}')` });
  return TX(RESERVE(cmd, 'consultations.request', 'mx-pmc'), o.order === 'event-first' ? event + fact : fact + event, COMPLETE(cmd, o.dc));
};
/** the delivered `consultations.respond`: receipt, fact, targeted event naming consultation AND response */
const RESPOND = (o: { dcr: string; dc: string; ev: string; version: string; order?: Order; event?: boolean; namedResponse?: string; namedConsultation?: string; target?: string }) => {
  const cmd = `${o.dcr}-cmd`;
  const fact = `INSERT INTO "DecisionConsultationResponse" ("id","projectId","consultationId","decisionId","respondedById","response","respondedAt","sourceCommandId")
      VALUES ('${o.dcr}','mx-proj','${o.dc}','mx-dec','mx-eng','use the granite',now(),'${cmd}');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.consultation_responded', dec: 'mx-dec', version: o.version,
    payload: `jsonb_build_object('consultationId','${o.namedConsultation ?? o.dc}','responseId','${o.namedResponse ?? o.dcr}')`,
    push: `, 'push', jsonb_build_object('body','answered','roles', jsonb_build_array('pmc'),'targetUserId','${o.target ?? 'mx-pmc'}')` });
  return TX(RESERVE(cmd, 'consultations.respond', 'mx-eng'), o.order === 'event-first' ? event + fact : fact + event, COMPLETE(cmd, o.dcr));
};

/** a HAND: a write past every seal, for a world state no delivered writer produces */
const HAND = (sql: string) => `SET session_replication_role = 'replica'; ${sql} SET session_replication_role = 'origin';`;

// ── THE MATRIX ───────────────────────────────────────────────────────────────────────────────
const MATRIX: Branch[] = [
  {
    key: 'decision.approved',
    writer: 'decisions.approve (from pending)',
    fact: 'DecisionApprovalRevision (finalized birth)',
    audit: 'DecisionEvent.approved',
    transition: 'Decision pending → approved (recorded by Decision_t4d_approval_transition)',
    enforcedBy: ['DecisionApprovalRevision_t4d_claim', 'DecisionApprovalRevision_t4d_claim_deferred',
      'DecisionApprovalRevision_t4d_birth_paired', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    positive: (order, version) => APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version, order }),
    claim: 'mx-ev-ap:DecisionApprovalRevision:mx-rev',
    negatives: [
      { name: 'the finalized revision is written with NO approval event and NO audit row (finding 5)',
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, event: false, audit: false }),
        refusal: /approval revision .* with 0 approval-family event/ },
      { name: 'the finalized revision is written with its event but NO audit row',
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, audit: false }),
        refusal: /with 0 `approved` \/ `reapproved` audit row/ },
      { name: 'an approval event from an EARLIER transaction cannot stand in for this one (reused evidence)',
        setup: TX(EV({ id: 'mx-ev-old', type: 'decision.approved', dec: 'mx-dec', version: PRIOR,
          push: `, 'push', jsonb_build_object('body','earlier','roles', c."pushRoles")` })),
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, event: false }),
        // the audit row is refused by the 4d-i correspondence seal (no same-transaction event), and
        // without the audit row the revision claimant refuses for the same reason: an earlier
        // transaction's event is not THIS transaction's evidence under either seal
        refusal: /has no matching decision\.approved event in this transaction|approval revision .* with 0 approval-family event/ },
      { name: 'TWO revisions born beside one event (duplicated evidence)',
        bundle: TX(RESERVE('mx-c1', 'decisions.approve', 'mx-pmc'), RESERVE('mx-c2', 'decisions.approve', 'mx-pmc'),
          `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec';
           INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
             VALUES ('mx-rev-1','mx-proj','mx-dec',1,'a',now(),'mx-pmc','mx-c1'), ('mx-rev-2','mx-proj','mx-dec',2,'a',now(),'mx-pmc','mx-c2');`,
          AU('mx-dec', 'approved'), EV({ id: 'mx-ev-ap', type: 'decision.approved', dec: 'mx-dec', version: CURRENT,
            push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` }),
          COMPLETE('mx-c1', 'mx-dec'), COMPLETE('mx-c2', 'mx-dec')),
        refusal: /rows BORN in this transaction|approval revision/ },
    ],
  },
  {
    key: 'decision.reapproved',
    writer: 'decisions.approve (from change — the reapproval)',
    fact: 'DecisionApprovalRevision (finalized birth) + the open request resolved',
    audit: 'DecisionEvent.reapproved',
    transition: 'Decision change → approved and ChangeRequest open → resolved (both recorded)',
    enforcedBy: ['DecisionApprovalRevision_t4d_claim', 'DecisionApprovalRevision_t4d_claim_deferred',
      'ChangeRequest_t4d_paired', 'Decision_t4d_change_paired', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: OPENING({ cr: 'mx-cr', ev: 'mx-ev-open', version: PRIOR }),
    positive: (order, version) => REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version, order }),
    claim: 'mx-ev-re:DecisionApprovalRevision:mx-rev2',
    negatives: [
      { name: 'the reapproval writes its revision and closure with NO event and NO audit row (finding 5, sibling)',
        bundle: REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version: CURRENT, event: false, audit: false }),
        refusal: /approval revision .* with 0 approval-family event|resolved in this transaction with 0 approval-family event/ },
      { name: 'the reapproval writes its event but NO audit row',
        bundle: REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version: CURRENT, audit: false }),
        refusal: /with 0 `approved` \/ `reapproved` audit row/ },
      { name: 'the reapproval moves the decision and writes its revision but leaves the request OPEN (missing converse)',
        bundle: REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version: CURRENT, closure: false }),
        refusal: /change → approved.* with 0 change request\(s\) closed here/ },
    ],
  },
  {
    key: 'decision.change_requested',
    writer: 'decisions.change (requestChange)',
    fact: 'ChangeRequest born open, origin standard',
    audit: 'DecisionEvent.change_requested',
    transition: 'Decision approved → change (recorded) and the request opened (recorded)',
    enforcedBy: ['ChangeRequest_t4d_paired', 'ChangeRequest_t4d_claim', 'Decision_t4d_change_paired',
      'ChangeRequest_t4d_lifecycle_transition', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    positive: (order, version) => OPENING({ cr: 'mx-cr', ev: 'mx-ev-open', version, order }),
    claim: 'mx-ev-open:ChangeRequest:mx-cr',
    negatives: [
      { name: 'the standard opening is written with its event but NO audit row (finding 6)',
        bundle: OPENING({ cr: 'mx-cr', ev: 'mx-ev-open', version: CURRENT, audit: false }),
        refusal: /with 0 `change_requested` audit row/ },
      { name: 'the standard opening is written with NO event',
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
          `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","requestedById")
             VALUES ('mx-cr','mx-proj','mx-dec2','the ask',0,0,'open','mx-pmc');`, AU('mx-dec2', 'change_requested')),
        refusal: /with 0 `decision.change_requested` event|has no matching/ },
      { name: 'the decision is moved into change with its event and audit row but NO request (missing converse)',
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
          EV({ id: 'mx-ev-open', type: 'decision.change_requested', dec: 'mx-dec2', version: CURRENT }), AU('mx-dec2', 'change_requested')),
        refusal: /approved → change.* with 0 open `standard` change request\(s\) born here/ },
      { name: 'a countersign_rejection request is opened beside a NO-OP update of a decision already in change (finding 2)',
        // the world no delivered writer produces before 4d-ii: a decision sitting in `change` with
        // no open request, and a provisional revision for the request to cite
        setup: HAND(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';
          INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom")
            VALUES ('mx-rev-prov','mx-proj','mx-dec2',1,'a',now(),'mx-client',FALSE,'pending');`),
        bundle: TX(`UPDATE "Decision" SET "room" = "room" WHERE "id" = 'mx-dec2';`,
          `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId","requestedById")
             VALUES ('mx-cr-rej','mx-proj','mx-dec2','forged disagreement',0,0,'open','countersign_rejection','mx-rev-prov','mx-pmc');`,
          EV({ id: 'mx-ev-rej', type: 'decision.change_requested', dec: 'mx-dec2', version: CURRENT })),
        refusal: /no `awaiting_countersign → change` move of decision/ },
    ],
  },
  {
    key: 'decision.change_withdrawn',
    writer: 'decisions.withdrawChange',
    fact: 'ChangeRequest open → withdrawn',
    audit: 'DecisionEvent.change_withdrawn',
    transition: 'Decision change → approved (recorded) and the request withdrawn (recorded)',
    enforcedBy: ['ChangeRequest_t4d_paired', 'ChangeRequest_t4d_claim', 'Decision_t4d_change_paired',
      'ChangeRequest_t4d_lifecycle_transition', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: OPENING({ cr: 'mx-cr', ev: 'mx-ev-open', version: PRIOR }),
    positive: (order, version) => WITHDRAWAL({ cr: 'mx-cr', ev: 'mx-ev-wd', version, order }),
    claim: 'mx-ev-wd:ChangeRequest:mx-cr',
    negatives: [
      { name: 'the withdrawal is written with its event but NO audit row (finding 6)',
        bundle: WITHDRAWAL({ cr: 'mx-cr', ev: 'mx-ev-wd', version: CURRENT, audit: false }),
        refusal: /with 0 `change_withdrawn` audit row/ },
      { name: 'a HISTORICAL withdrawn request is no-op updated to stand in for the closure, at the drain generation (finding 4)',
        // an older request, opened and withdrawn in earlier transactions, then the live one
        setup: [WITHDRAWAL({ cr: 'mx-cr', ev: 'mx-ev-wd0', version: PRIOR }),
          OPENING({ cr: 'mx-cr-live', ev: 'mx-ev-open2', version: PRIOR })].join('\n'),
        bundle: TX(`UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';`,
          `UPDATE "ChangeRequest" SET "reason" = "reason" WHERE "id" = 'mx-cr';`,
          AU('mx-dec2', 'change_withdrawn'),
          EV({ id: 'mx-ev-wd', type: 'decision.change_withdrawn', dec: 'mx-dec2', version: PRIOR })),
        refusal: /change → approved.* with 0 change request\(s\) closed here/ },
    ],
  },
  {
    key: 'decision.consultation_requested',
    writer: 'consultations.request',
    fact: 'DecisionConsultation',
    audit: null,
    transition: 'none — a receipt-backed insert; the event names the consultation and targets the consultee',
    enforcedBy: ['DecisionConsultation_t4d_claim', 'DecisionConsultation_t4d_claim_deferred', 'DomainEvent_t4d_pairing_claimed'],
    positive: (order, version) => CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version, order }),
    claim: 'mx-ev-dc:DecisionConsultation:mx-dc',
    negatives: [
      { name: 'the consultation is written with NO event (finding 1)',
        bundle: CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version: CURRENT, event: false }),
        refusal: /consultation .* with 0 `decision.consultation_requested` event/ },
      { name: 'the event names ANOTHER consultation (wrong identity, finding 3)',
        bundle: CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version: CURRENT, namedId: 'mx-dc-other' }),
        refusal: /consultation .* with 0 `decision.consultation_requested` event/ },
      { name: 'the event targets a DIFFERENT user than the consultee (wrong audience, finding 3)',
        bundle: CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version: CURRENT, consultee: 'mx-client', target: 'mx-client' }),
        refusal: /consultation .* with 0 `decision.consultation_requested` event/ },
      { name: 'the event is emitted under ANOTHER project for its own decision (cross-project)',
        bundle: CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version: CURRENT, proj: P2, dec: 'mx-decB' }).replace(
          // the FACT stays on mx-proj / mx-dec; only the event moves projects
          `VALUES ('mx-dc','mx-proj','mx-decB'`, `VALUES ('mx-dc','mx-proj','mx-dec'`),
        refusal: /consultation .* with 0 `decision.consultation_requested` event|requires a pairing claim/ },
    ],
  },
  {
    key: 'decision.consultation_responded',
    writer: 'consultations.respond',
    fact: 'DecisionConsultationResponse',
    audit: null,
    transition: 'none — a receipt-backed insert; the event names consultation and response and targets the requester',
    enforcedBy: ['DecisionConsultationResponse_t4d_claim', 'DecisionConsultationResponse_t4d_claim_deferred', 'DomainEvent_t4d_pairing_claimed'],
    setup: CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version: PRIOR }),
    positive: (order, version) => RESPOND({ dcr: 'mx-dcr', dc: 'mx-dc', ev: 'mx-ev-dcr', version, order }),
    claim: 'mx-ev-dcr:DecisionConsultationResponse:mx-dcr',
    negatives: [
      { name: 'the response is written with NO event (finding 1)',
        bundle: RESPOND({ dcr: 'mx-dcr', dc: 'mx-dc', ev: 'mx-ev-dcr', version: CURRENT, event: false }),
        refusal: /response .* with 0 `decision.consultation_responded` event/ },
      { name: 'the event names ANOTHER response (wrong identity, finding 3)',
        bundle: RESPOND({ dcr: 'mx-dcr', dc: 'mx-dc', ev: 'mx-ev-dcr', version: CURRENT, namedResponse: 'mx-dcr-other' }),
        refusal: /response .* with 0 `decision.consultation_responded` event/ },
      { name: 'the event targets the CONSULTEE instead of the requester (wrong audience, finding 3)',
        bundle: RESPOND({ dcr: 'mx-dcr', dc: 'mx-dc', ev: 'mx-ev-dcr', version: CURRENT, target: 'mx-eng' }),
        refusal: /response .* with 0 `decision.consultation_responded` event/ },
    ],
  },
];

describe('phase 6 unit 4d-i-b — the bundle proof matrix: every pairingRequired type, both orders, every missing half', () => {
  beforeAll(() => {
    const has = psql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${TEMPLATE}'`);
    expect(has.ok, `the migrated database ${TEMPLATE} must exist to be copied:\n${has.output}`).toBe(true);
  });
  afterAll(() => { psql('postgres', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`); });

  it('coverage: the matrix names exactly the compiled catalog\'s pairingRequired keys', () => {
    const flagged = Object.entries(EXTERNAL_EFFECTS as Record<string, { pairingRequired?: true }>)
      .filter(([, d]) => d.pairingRequired === true).map(([k]) => k).sort();
    expect(MATRIX.map((b) => b.key).sort(), 'a flipped type without executable bundle coverage fails here').toEqual(flagged);
    for (const b of MATRIX) {
      expect(b.negatives.length, `${b.key} needs at least a missing-counterpart variant`).toBeGreaterThan(0);
      expect(b.enforcedBy.length, `${b.key} names its enforcement`).toBeGreaterThan(0);
    }
  });

  for (const b of MATRIX) {
    describe(b.key, () => {
      const run = (setup: string | undefined, bundle: string) => {
        reset();
        if (setup) {
          const s = psql(RUN_DB, setup);
          expect(s.ok, `the case's setup (earlier transactions) must commit:\n${s.output}`).toBe(true);
        }
        return psql(RUN_DB, bundle);
      };

      for (const order of ['fact-first', 'event-first'] as Order[]) {
        it(`${b.writer}: the complete bundle commits ${order} at the CURRENT generation and the fact claims its event`, () => {
          const r = run(b.setup, b.positive(order, CURRENT));
          expect(r.ok, `the delivered writer's bundle must COMMIT:\n${r.output}`).toBe(true);
          expect(CLAIMS()).toContain(b.claim);
        }, 120_000);
      }
      it(`${b.writer}: the complete bundle commits at the PRIOR generation — a still-serving 4d-i writer keeps working through the drain`, () => {
        const r = run(b.setup, b.positive('fact-first', PRIOR));
        expect(r.ok, `a previous-release writer's bundle must COMMIT:\n${r.output}`).toBe(true);
      }, 120_000);
      for (const v of b.negatives) {
        it(`${b.writer}: ${v.name} — refused at commit`, () => {
          const r = run([b.setup, v.setup].filter(Boolean).join('\n') || undefined, v.bundle);
          expect(r.ok, `the defective bundle must be REFUSED, and it COMMITTED`).toBe(false);
          expect(r.output).toMatch(v.refusal);
        }, 120_000);
      }
    });
  }
});
