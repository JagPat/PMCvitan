import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTERNAL_EFFECTS, effectCoverageVersion } from '../../src/platform/external-effects';
import { rawDeliveryRowsSql } from './fixtures';

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
 *     fact without audit row, transition without fact), evidence with the wrong identity, the
 *     wrong audience or the WRONG ACTOR (an event attributed to someone other than the person the
 *     fact records — #590 round 4), evidence reused from an earlier transaction or duplicated
 *     inside one, and a no-op write standing in for a real transition — including the drain
 *     window's old-generation shape, where the kernel's own pairing seal is silent by design.
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
  /** the HUMAN actor the event is attributed to (`actorId`), as `emitEvent` attributes every
   *  delivered writer's event; omitted, the event is a `system` one that names nobody */
  actor?: string;
  /** 4d-ii-a / A8b — the actor's frozen ENVELOPE pair (`actorRole`/`actorName`), as `emitEvent` writes it
   *  from the resolved pair; the A8b claimants compare it to the fact's frozen pair (P31) */
  role?: string; name?: string;
}) => {
  const p = o.proj ?? P1;
  const who = o.actor ? `'human',NULL,'${o.actor}'` : `'system','system:mx',NULL`;
  const pair = `${o.role ? `'${o.role}'` : 'NULL'},${o.name ? `'${o.name}'` : 'NULL'}`;
  return `
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = '${p.id}';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","actorId","actorRole","actorName","entityType","entityId","payload","dispatchIntent")
      SELECT '${o.id}','${o.type}',1,'${p.org}','${p.id}',s."nextPosition" - 1,${who},${pair},'Decision','${o.dec}',
             ${o.payload ?? "'{}'::jsonb"},
             jsonb_build_object('effectKey','${o.type}','coverageVersion',c."coverageVersion",'invalidate',c."invalidate"${o.push ?? ''})
        FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
       WHERE s."projectId" = '${p.id}' AND c."effectKey" = '${o.type}' AND c."coverageVersion" = '${o.version}';
    ${rawDeliveryRowsSql(o.id)};`;
};
/** the audit register row the delivered writer appends beside its fact */
const AU = (dec: string, type: string) =>
  `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES (md5(random()::text), '${dec}', '${type}', 'mx');`;
/** 4d-ii-a / A8b — the kinded FEED ROW a delivered writer binds to its event (`eventId`/`kind`); the A8b
 *  claimants and the re-issued request arm demand it (#673 round 2) */
const NOTICE = (ev: string, kind: string, dec = 'mx-dec') =>
  `INSERT INTO "Notification" ("id","projectId","text","color","time","decisionId","kind","eventId") VALUES ('${ev}-n','mx-proj','notice','#C08A2D','just now','${dec}','${kind}','${ev}');`;
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
  /** 4d-ii-a / A7d — a key the PRIOR generation never compiled: a still-serving previous release cannot
   *  emit it at all, and the PRIOR arm asserts the envelope seal's refusal instead of a commit */
  priorAbsent?: true;
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
const OPENING = (o: { cr: string; ev: string; version: string; order?: Order; audit?: boolean; dec?: string; actor?: string }) => {
  const dec = o.dec ?? 'mx-dec2';
  const fact = `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","requestedById")
      VALUES ('${o.cr}','mx-proj','${dec}','the ask',0,0,'open','mx-pmc');`;
  const event = EV({ id: o.ev, type: 'decision.change_requested', dec, version: o.version, actor: o.actor ?? 'mx-pmc' });
  const audit = o.audit === false ? '' : AU(dec, 'change_requested');
  return TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = '${dec}';`,
    o.order === 'event-first' ? event + fact : fact + event, audit);
};
/** the disagreement (4d-ii's `decisions.disagree`) on a decision parked in `awaiting_countersign` with the provisional head `mx-rev-park` */
const REJECT = (o: { cr: string; ev: string; version: string; order?: Order; actor?: string; audit?: boolean; notice?: boolean; origin?: string | null; named?: string; title?: string | null; reason?: string | null; receipt?: string; requestReason?: string }) => {
  // the disagreeing party is the request's `requestedById` AND the event's actor (no seal under
  // test judges that party's standing; 4d-ii's `decisions.disagree` binds it to the architect).
  // 4d-ii-a / A8b (#673 round 3) — `receipt` names the command whose receipt the request cites as its
  // PRIMARY result (the delivered `decisions.disagree` writes one; the provenance seal names the one
  // primary table of each command, so a resolve receipt naming the request is refused)
  const cmd = o.receipt ? `${o.cr}-cmd` : undefined;
  // #673 round 4: `requestReason` is a SQL literal for the reason the request AND the event carry (a tab-only
  // reason is blank to the eye and must be refused by the non-blank guard)
  const rr = o.requestReason ?? `'the architect disagrees'`;
  const fact = cmd
    ? `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId","requestedById","requestedByRole","requestedByName","sourceCommandId")
      VALUES ('${o.cr}','mx-proj','mx-dec',${rr},0,0,'open','countersign_rejection','mx-rev-park','mx-client','client','MX Client','${cmd}');`
    : `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId","requestedById")
      VALUES ('${o.cr}','mx-proj','mx-dec',${rr},0,0,'open','countersign_rejection','mx-rev-park','mx-client');`;
  // 4d-ii-a / A8b (#673 round 2) — the event names the request and its origin (what the kinded renderer
  // reads), and the change-request notice is bound to it; (round 3) the title and the reason it renders,
  // bound to the decision and the request — `title`/`reason` swap them, `null` omits them
  const origin = o.origin === null ? '' : `'origin','${o.origin ?? 'countersign_rejection'}',`;
  const title = o.title === null ? '' : `,'title','${o.title ?? 'MX Pending'}'`;
  const reason = o.reason === null ? '' : `,'reason',${o.reason ? `'${o.reason}'` : rr}`;
  const event = EV({ id: o.ev, type: 'decision.change_requested', dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-client',
    payload: `jsonb_build_object(${origin}'requestId','${o.named ?? o.cr}'${title}${reason})` })
    + (o.notice === false ? '' : NOTICE(o.ev, 'decision.change_requested'));
  // 4d-ii-a / A8b (#673 round 1) — the rejection's `change_requested` audit row, demanded by the re-issued request pairing
  const audit = o.audit === false ? '' : AU('mx-dec', 'change_requested');
  return TX(cmd ? RESERVE(cmd, o.receipt!, 'mx-client') : '',
    `UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec';`,
    o.order === 'event-first' ? event + fact : fact + event, audit,
    cmd ? COMPLETE(cmd, o.cr) : '');
};
/** the delivered `withdrawChange` on the reopened decision */
const WITHDRAWAL = (o: { cr: string; ev: string; version: string; order?: Order; audit?: boolean; dec?: string; actor?: string }) => {
  const dec = o.dec ?? 'mx-dec2';
  const closure = `UPDATE "ChangeRequest" SET "status" = 'withdrawn', "resolution" = 'withdrawn', "resolvedById" = 'mx-pmc', "resolvedAt" = now() WHERE "id" = '${o.cr}';`;
  const event = EV({ id: o.ev, type: 'decision.change_withdrawn', dec, version: o.version, actor: o.actor ?? 'mx-pmc' });
  const audit = o.audit === false ? '' : AU(dec, 'change_withdrawn');
  return TX(`UPDATE "Decision" SET "status" = 'approved' WHERE "id" = '${dec}';`,
    o.order === 'event-first' ? event + closure : closure + event, audit);
};
/** the delivered `approve` from `pending`: receipt, transition, finalized revision, audit, event */
/**
 * 4d-ii-a / A7a (#665's review round 1, P1) — the CURRENT writer's `decision.approved` /
 * `decision.reapproved` payload NAMES the revision the act wrote (`revisionId`), and the claimant
 * refuses an event naming any other; a PRIOR-generation writer (a still-serving previous release)
 * names none and is admitted through the drain. `named` overrides the name the bundle carries.
 */
const REVISION_PAYLOAD = (version: string, rev: string, named?: string) =>
  named !== undefined || version === CURRENT ? `jsonb_build_object('revisionId','${named ?? rev}')` : undefined;
const APPROVAL = (o: { rev: string; ev: string; version: string; order?: Order; audit?: boolean; event?: boolean; cmd?: string; actor?: string; named?: string; revVersion?: number }) => {
  const cmd = o.cmd ?? `${o.rev}-cmd`;
  const act = `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec';
    INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
      VALUES ('${o.rev}','mx-proj','mx-dec',${o.revVersion ?? 1},'a',now(),'mx-pmc','${cmd}');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.approved', dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-pmc',
    payload: REVISION_PAYLOAD(o.version, o.rev, o.named),
    push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` });
  const audit = o.audit === false ? '' : AU('mx-dec', 'approved');
  return TX(RESERVE(cmd, 'decisions.approve', 'mx-pmc'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, 'mx-dec'));
};
/** the delivered `approve` from `change` — the reapproval: closes the open request `cr` as resolved */
const REAPPROVAL = (o: { rev: string; ev: string; cr: string; version: string; order?: Order; audit?: boolean; event?: boolean; closure?: boolean; actor?: string; named?: string }) => {
  const cmd = `${o.rev}-cmd`;
  const act = `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec2';
    ${o.closure === false ? '' : `UPDATE "ChangeRequest" SET "status" = 'resolved', "resolution" = 'reapproved', "resolvedById" = 'mx-pmc', "resolvedAt" = now() WHERE "id" = '${o.cr}';`}
    INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
      VALUES ('${o.rev}','mx-proj','mx-dec2',1,'a',now(),'mx-pmc','${cmd}');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.reapproved', dec: 'mx-dec2', version: o.version, actor: o.actor ?? 'mx-pmc',
    payload: REVISION_PAYLOAD(o.version, o.rev, o.named),
    push: `, 'push', jsonb_build_object('body','reapproved','roles', c."pushRoles")` });
  const audit = o.audit === false ? '' : AU('mx-dec2', 'reapproved');
  return TX(RESERVE(cmd, 'decisions.approve', 'mx-pmc'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, 'mx-dec2'));
};
/** the delivered `consultations.request`: receipt, fact, targeted event naming the consultation */
const CONSULT = (o: { dc: string; ev: string; version: string; order?: Order; event?: boolean; namedId?: string; consultee?: string; target?: string; proj?: Proj; dec?: string; cmd?: string; actor?: string }) => {
  const cmd = o.cmd ?? `${o.dc}-cmd`;
  const dec = o.dec ?? 'mx-dec';
  const fact = `INSERT INTO "DecisionConsultation" ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","requestedAt","sourceCommandId")
      VALUES ('${o.dc}','mx-proj','${dec}','mx-pmc','mx-mem-e','mx-eng','which finish?',0,now(),'${cmd}');`;
  const named = o.namedId ?? o.dc;
  const consultee = o.consultee ?? 'mx-eng';
  const target = o.target ?? consultee;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.consultation_requested', dec, version: o.version, proj: o.proj, actor: o.actor ?? 'mx-pmc',
    payload: `jsonb_build_object('consultationId','${named}','consulteeUserId','${consultee}')`,
    push: `, 'push', jsonb_build_object('body','asked','roles', jsonb_build_array('engineer'),'targetUserId','${target}')` });
  return TX(RESERVE(cmd, 'consultations.request', 'mx-pmc'), o.order === 'event-first' ? event + fact : fact + event, COMPLETE(cmd, o.dc));
};
/** the delivered `consultations.respond`: receipt, fact, targeted event naming consultation AND response */
const RESPOND = (o: { dcr: string; dc: string; ev: string; version: string; order?: Order; event?: boolean; namedResponse?: string; namedConsultation?: string; target?: string; actor?: string }) => {
  const cmd = `${o.dcr}-cmd`;
  const fact = `INSERT INTO "DecisionConsultationResponse" ("id","projectId","consultationId","decisionId","respondedById","response","respondedAt","sourceCommandId")
      VALUES ('${o.dcr}','mx-proj','${o.dc}','mx-dec','mx-eng','use the granite',now(),'${cmd}');`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.consultation_responded', dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-eng',
    payload: `jsonb_build_object('consultationId','${o.namedConsultation ?? o.dc}','responseId','${o.namedResponse ?? o.dcr}')`,
    push: `, 'push', jsonb_build_object('body','answered','roles', jsonb_build_array('pmc'),'targetUserId','${o.target ?? 'mx-pmc'}')` });
  return TX(RESERVE(cmd, 'consultations.respond', 'mx-eng'), o.order === 'event-first' ? event + fact : fact + event, COMPLETE(cmd, o.dcr));
};

/**
 * 4d-ii-a / A7d — the delivered `members.add` of the FIRST architect (the doors dropped, as 4d-iii
 * drops them): receipt, the transition fact FIRST, the membership write, and the standing event about
 * the membership — `{ role, membershipId, transitionId, from, to, activeCount }` with the fact's
 * frozen pair as the event's envelope — claimed by the transition. The event is written the way
 * `emitEvent` writes it (allocate, insert at nextPosition - 1), with the generation named literally
 * so the PRIOR arm can ask what a previous release's emission of a type it never compiled meets.
 */
const STANDING = (o: { mt: string; ev: string; version: string; order?: Order; event?: boolean; role?: string; eventRole?: string; count?: number; actor?: { id: string; role: string; name: string }; cmd?: string }) => {
  const cmd = o.cmd ?? `${o.mt}-cmd`;
  const role = o.role ?? 'architect';
  const actor = o.actor ?? { id: 'mx-pmc', role: 'pmc', name: 'MX PMC' };
  const fact = `INSERT INTO "MembershipTransition" ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('${o.mt}','mx-proj','mx-mem-a','mx-arch',NULL,NULL,'${role}','active','mx-pmc','pmc','MX PMC','${cmd}');`;
  const write = `INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('mx-mem-a','mx-proj','mx-arch','${role}','active');`;
  const event = o.event === false ? '' : `
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'mx-proj';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","actorId","actorRole","actorName","entityType","entityId","payload","dispatchIntent")
      SELECT '${o.ev}','membership.standing_changed',1,'mx-org','mx-proj',s."nextPosition" - 1,'human','${actor.id}','${actor.role}','${actor.name}','Membership','mx-mem-a',
             jsonb_build_object('role','${o.eventRole ?? 'architect'}','membershipId','mx-mem-a','transitionId','${o.mt}',
                                'from', jsonb_build_object('role', NULL, 'status', NULL),
                                'to', jsonb_build_object('role','${role}','status','active'),
                                'activeCount', ${o.count ?? 1}),
             jsonb_build_object('effectKey','membership.standing_changed','coverageVersion','${o.version}','invalidate',true)
        FROM "ProjectEventStream" s WHERE s."projectId" = 'mx-proj';
    ${rawDeliveryRowsSql(o.ev)};`;
  // the fact precedes the membership write (4d-i's fact-first seal); the event may precede the fact
  return TX(RESERVE(cmd, 'members.add', 'mx-pmc'), o.order === 'event-first' ? event + fact + write : fact + write + event, COMPLETE(cmd, 'mx-mem-a'));
};
/** the world the standing bundle needs: the reservation door 4d-iii drops, and the person about to be seated */
const STANDING_WORLD = `DROP TRIGGER IF EXISTS "Membership_t4d_architect_reserved" ON "Membership";
  INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('mx-arch','mx-proj','engineer','MX Architect','+910000000106');`;

/**
 * 4d-ii-a / A7d — a chain key compiled `pairingRequired` whose WRITER is a later unit's: its claimants are
 * installed ahead (asserted here to stand) and its executable bundle joins this matrix with the writer branch
 * that produces it. A8a delivered both of A7d's (`decisions.forward`; the approve under a chain), so the set
 * is empty until 4d-iii's next flip, if any.
 */
const OWED_BUNDLES: Record<string, { unit: string; claimants: string[] }> = {};

/**
 * 4d-ii-a / A8a — a chain event written the way `emitEvent` writes it, with the generation named LITERALLY
 * (so the PRIOR arm can ask what a previous release's emission of a type it never compiled meets) and the
 * FROZEN-audience shape the two chain families carry: the catalog's constant body and `targetUserIds`.
 */
const CHAIN_EV = (o: { id: string; type: string; dec: string; version: string; actor: string; payload: string; targets: string[]; body: string }) => `
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'mx-proj';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","actorId","entityType","entityId","payload","dispatchIntent")
      SELECT '${o.id}','${o.type}',1,'mx-org','mx-proj',s."nextPosition" - 1,'human',NULL,'${o.actor}','Decision','${o.dec}',
             ${o.payload},
             jsonb_build_object('effectKey','${o.type}','coverageVersion','${o.version}','invalidate',true,
                                'push', jsonb_build_object('body','${o.body}','roles', jsonb_build_array('architect'),'targetUserIds', jsonb_build_array(${o.targets.map((t) => `'${t}'`).join(',')})))
        FROM "ProjectEventStream" s WHERE s."projectId" = 'mx-proj';
    ${rawDeliveryRowsSql(o.id)};`;
/** the world the forward bundle needs: the two doors 4d-iii drops (the fact's and the audit kind's) */
const FORWARD_WORLD = `DROP TRIGGER IF EXISTS "DecisionForward_t4d_reserved" ON "DecisionForward";
  DROP TRIGGER IF EXISTS "DecisionEvent_t4d_kind_reserved" ON "DecisionEvent";`;
/**
 * 4d-ii-a / A8a — the delivered `decisions.forward`: receipt, the FACT first (4d-i's seal compares it to the
 * holder the decision carries at that instant), the holder mutation through the attribution seal's one door,
 * the frozen-audience event naming the fact (`payload.forwardId`), attributed to the actor, the new holder's
 * users frozen; the audit row; the completed receipt naming the fact. The PMC hands the client-held pending
 * decision to the engineer's membership.
 */
const FORWARD = (o: { fwd: string; ev: string; version: string; order?: Order; event?: boolean; audit?: boolean; move?: boolean; named?: string; actor?: string; to?: { kind: string; membershipId: string | null }; cmd?: string }) => {
  const cmd = o.cmd ?? `${o.fwd}-cmd`;
  const to = o.to ?? { kind: 'member', membershipId: 'mx-mem-e' };
  const toMem = to.membershipId === null ? 'NULL' : `'${to.membershipId}'`;
  const fact = `INSERT INTO "DecisionForward" ("id","projectId","decisionId","fromDesignationKind","fromDesignationMembershipId","toDesignationKind","toDesignationMembershipId","forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")
      VALUES ('${o.fwd}','mx-proj','mx-dec','client',NULL,'${to.kind}',${toMem},'mx-pmc','pmc','MX PMC','the engineer decides finishes','${cmd}');`;
  const move = o.move === false ? '' : `UPDATE "Decision" SET "deciderKind" = '${to.kind}', "deciderMembershipId" = ${toMem} WHERE "id" = 'mx-dec';`;
  const event = o.event === false ? '' : CHAIN_EV({ id: o.ev, type: 'decision.forwarded', dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-pmc',
    payload: `jsonb_build_object('forwardId','${o.named ?? o.fwd}','title','MX Pending','toLabel','MX Engineer')`,
    targets: ['mx-eng'], body: 'A decision has been forwarded to you' });
  const audit = o.audit === false ? '' : AU('mx-dec', 'forwarded');
  // the fact precedes the holder mutation (the door compares the fact to the holder it displaces); the event may precede the fact
  return TX(RESERVE(cmd, 'decisions.forward', 'mx-pmc'), o.order === 'event-first' ? event + fact + move : fact + move + event, audit, COMPLETE(cmd, o.fwd));
};
/** the world the provisional approve needs: the awaiting door dropped and an ACTIVE architect (the delivered
 *  `members.add` bundle seats one, exactly as the standing branch above commits it) */
const CHAIN_WORLD = `${STANDING_WORLD}
  DROP TRIGGER IF EXISTS "Decision_t4d_awaiting_reserved" ON "Decision";
  ${STANDING({ mt: 'mx-mt0', ev: 'mx-ev-st0', version: CURRENT })}`;
/**
 * 4d-ii-a / A8a — the delivered `decisions.approve` under an ACTIVE chain: receipt, the transition
 * `pending → awaiting_countersign` writing the frozen approval tuple as the finalizing act would, the
 * PROVISIONAL revision (`finalized = false`, `approvedFrom`, the approver's frozen pair), the audit row, and
 * the countersign DEMAND naming the revision, attributed to the approver, the architects frozen.
 */
const PROVISIONAL = (o: { rev: string; ev: string; version: string; order?: Order; event?: boolean; audit?: boolean; named?: string; actor?: string; finalized?: boolean; cmd?: string }) => {
  const cmd = o.cmd ?? `${o.rev}-cmd`;
  // the frozen holder TUPLE is written by the provisional act "exactly as the finalizing act would"
  // (4d-i's widened attribution seal; 4b's `Decision_t4b_approved_tuple_check` widened by A8a's migration)
  const act = `UPDATE "Decision" SET "status" = 'awaiting_countersign', "approvedDeciderKind" = 'client', "approvedDeciderMembershipId" = NULL, "approvedDeciderLabel" = 'Client',
      "approvedOption" = 'Option A', "material" = 'Granite', "approver" = 'MX PMC', "approvedById" = 'mx-pmc', "onBehalfOf" = 'client' WHERE "id" = 'mx-dec';
    INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","onBehalfOf","sourceCommandId","finalized","approvedFrom","approvedByName","approvedByRole")
      VALUES ('${o.rev}','mx-proj','mx-dec',1,'a',now(),'mx-pmc','client','${cmd}',${o.finalized === true ? 'TRUE' : 'FALSE'},'pending','MX PMC','pmc');`;
  const event = o.event === false ? '' : CHAIN_EV({ id: o.ev, type: 'decision.awaiting_countersign', dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-pmc',
    payload: `jsonb_build_object('revisionId','${o.named ?? o.rev}','approvedFrom','pending','title','MX Pending','deciderKind','client')`,
    targets: ['mx-arch'], body: 'A decision awaits your countersign' });
  const audit = o.audit === false ? '' : AU('mx-dec', 'approved');
  return TX(RESERVE(cmd, 'decisions.approve', 'mx-pmc'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, 'mx-dec'));
};

/** a HAND: a write past every seal, for a world state no delivered writer produces */
const HAND = (sql: string) => `SET session_replication_role = 'replica'; ${sql} SET session_replication_role = 'origin';`;

/** the world the countersign bundle needs: the chain active, the audit kind's door dropped (4d-iii's act, as the
 *  forward world drops it), and `mx-dec` PARKED by the delivered provisional approve (its head `mx-rev-park`,
 *  approver MX PMC on behalf of the client, `approvedFrom = pending`) */
const COUNTERSIGN_WORLD = `${CHAIN_WORLD}
  DROP TRIGGER IF EXISTS "DecisionEvent_t4d_kind_reserved" ON "DecisionEvent";
  ${PROVISIONAL({ rev: 'mx-rev-park', ev: 'mx-ev-aw-park', version: CURRENT })}`;
/** the world the stranded bundles need: NO architect (the chain inactive), the audit kind's and the forward's doors
 *  dropped, and `mx-dec` parked with its provisional head by HAND (the state the last architect's departure
 *  leaves; no delivered writer parks a decision under an inactive chain) */
const STRANDED_WORLD = `DROP TRIGGER IF EXISTS "DecisionEvent_t4d_kind_reserved" ON "DecisionEvent";
  DROP TRIGGER IF EXISTS "DecisionForward_t4d_reserved" ON "DecisionForward";
  ` + HAND(`UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'mx-dec';
  INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom","approvedByName","approvedByRole")
    VALUES ('mx-rev-park','mx-proj','mx-dec',1,'a',now(),'mx-client',FALSE,'pending','MX Client','client');`);
/** the finalization both finalizers perform after their fact: the head's flip and `awaiting_countersign → approved` */
const FINALIZE = (o: { flip?: boolean; land?: boolean }) =>
  `${o.flip === false ? '' : `UPDATE "DecisionApprovalRevision" SET "finalized" = TRUE WHERE "id" = 'mx-rev-park';`}
   ${o.land === false ? '' : `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec';`}`;
/**
 * 4d-ii-a / A8b — the delivered `decisions.countersign`: receipt, the FACT first naming the exact head (4d-i's
 * seal judges the architect's standing, the awaiting subject and the provisional head at the insert), the
 * head's finality flip, `awaiting_countersign → approved`, ONE `decision.approved` in the ARCHITECT's name
 * naming the revision and the fact, the `countersigned` audit row, the completed receipt naming the fact.
 */
const COUNTERSIGN = (o: { cs: string; ev: string; version: string; order?: Order; event?: boolean; audit?: boolean; fact?: boolean; flip?: boolean; land?: boolean; named?: string; namedRev?: string; actor?: string; role?: string; cmd?: string; notice?: boolean; finalization?: string | null; envelopeRole?: string; title?: string | null; deciderKind?: string | null }) => {
  const cmd = o.cmd ?? `${o.cs}-cmd`;
  const fact = o.fact === false ? '' : `INSERT INTO "DecisionCountersign" ("id","projectId","decisionId","revisionId","countersignedById","countersignedByRole","countersignedByName","sourceCommandId")
      VALUES ('${o.cs}','mx-proj','mx-dec','mx-rev-park','mx-arch','${o.role ?? 'architect'}','MX Architect','${cmd}');`;
  // #673 round 2: the DISCRIMINATOR the renderer reads, the envelope equal to the fact's pair, the bound green notice;
  // round 3: the CONTENT the renderer reads (`title`, `deciderKind`), bound to the decision — swapped or omitted here
  const finalization = o.finalization === null ? '' : `,'finalization','${o.finalization ?? 'countersign'}'`;
  const content = (o.title === null ? '' : `,'title','${o.title ?? 'MX Pending'}'`) + (o.deciderKind === null ? '' : `,'deciderKind','${o.deciderKind ?? 'client'}'`);
  const event = o.event === false ? '' : EV({ id: o.ev, type: 'decision.approved', dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-arch',
    role: o.envelopeRole ?? o.role ?? 'architect', name: 'MX Architect',
    payload: `jsonb_build_object('revisionId','${o.namedRev ?? 'mx-rev-park'}','countersignId','${o.named ?? o.cs}'${finalization}${content})`,
    push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` })
    + (o.notice === false ? '' : NOTICE(o.ev, 'decision.approved'));
  const audit = o.audit === false ? '' : AU('mx-dec', 'countersigned');
  const act = fact + FINALIZE(o);
  return TX(RESERVE(cmd, 'decisions.countersign', 'mx-arch'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, o.cs));
};
/**
 * 4d-ii-a / A8b — the delivered `decisions.resolveStrandedCountersign`: receipt, the FACT first (4d-i's seal
 * judges the PMC, the awaiting subject, the INACTIVE chain and the provisional head at the insert), then by
 * outcome — `completed`: the flip, `awaiting_countersign → approved`, ONE `decision.approved` in the PMC's name
 * naming the revision and the fact; `returned`: `awaiting_countersign → change`, the open `countersign_rejection`
 * request citing the head under the SAME receipt (the resolution is the bundle's primary; the request verifies
 * and never claims), ONE `decision.change_requested` in the PMC's name naming the revision and the fact, the
 * `change_requested` audit row — and, both: the `stranded_resolved` audit row, the completed receipt naming the fact.
 */
const STRANDED = (o: { sr: string; ev: string; version: string; outcome: 'completed' | 'returned'; order?: Order; event?: boolean; audit?: boolean; fact?: boolean; flip?: boolean; land?: boolean; request?: boolean; named?: string; actor?: string; role?: string; cmd?: string; notice?: boolean; announced?: 'completed' | 'returned'; title?: string | null; deciderKind?: string | null; rev?: string; requestRev?: string; srReason?: string }) => {
  const cmd = o.cmd ?? `${o.sr}-cmd`;
  // #673 round 3: `rev` is the head the resolution disposes of (the event names it too); `requestRev` the
  // one the returned bundle's request records — the provenance seal demands they are the same
  const rev = o.rev ?? 'mx-rev-park';
  const fact = o.fact === false ? '' : `INSERT INTO "DecisionStrandedResolution" ("id","projectId","decisionId","revisionId","outcome","resolvedById","resolvedByRole","resolvedByName","reason","sourceCommandId")
      VALUES ('${o.sr}','mx-proj','mx-dec','${rev}','${o.outcome}','mx-pmc','${o.role ?? 'pmc'}','MX PMC','${o.srReason ?? 'nobody left to countersign'}','${cmd}');`;
  const family = o.outcome === 'completed' ? 'decision.approved' : 'decision.change_requested';
  // #673 round 2: the DISCRIMINATOR the renderer reads (`finalization` for completed, `outcome` for returned —
  // `announced` swaps it), the envelope equal to the fact's pair, the bound notice of the family's kind
  const announced = o.announced ?? o.outcome;
  const discriminator = announced === 'completed' ? `'finalization','stranded_completed'` : `'outcome','returned'`;
  // #673 round 3: the CONTENT the renderer reads — the green notice's `title` and `deciderKind`, the change-request
  // notice's `title` (and `reason`, bound by the request arm) — bound to the decision; swapped or omitted here
  const title = o.title === null ? '' : `,'title','${o.title ?? 'MX Pending'}'`;
  const kind = o.deciderKind === null ? '' : `,'deciderKind','${o.deciderKind ?? 'client'}'`;
  const content = o.outcome === 'completed' ? title + kind : `,'origin','countersign_rejection','requestId','${o.sr}-cr'${title},'reason','nobody left to countersign'`;
  const event = o.event === false ? '' : EV({ id: o.ev, type: family, dec: 'mx-dec', version: o.version, actor: o.actor ?? 'mx-pmc',
    role: 'pmc', name: 'MX PMC',
    payload: `jsonb_build_object('revisionId','${rev}','resolutionId','${o.named ?? o.sr}',${discriminator}${content})`,
    push: o.outcome === 'completed' ? `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` : undefined })
    + (o.notice === false ? '' : NOTICE(o.ev, family));
  const act = o.outcome === 'completed'
    ? fact + FINALIZE(o)
    : fact + (o.land === false ? '' : `UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec';`)
      + (o.request === false ? '' : `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId","requestedById","requestedByRole","requestedByName","sourceCommandId")
          VALUES ('${o.sr}-cr','mx-proj','mx-dec','nobody left to countersign',0,0,'open','countersign_rejection','${o.requestRev ?? rev}','mx-pmc','pmc','MX PMC','${cmd}');`);
  const audit = (o.audit === false ? '' : AU('mx-dec', 'stranded_resolved')) + (o.outcome === 'returned' && o.request !== false ? AU('mx-dec', 'change_requested') : '');
  return TX(RESERVE(cmd, 'decisions.resolveStrandedCountersign', 'mx-pmc'), o.order === 'event-first' ? event + act : act + event, audit, COMPLETE(cmd, o.sr));
};

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
        refusal: /naming .* as its approver, and this transaction carries 0 approval-family event/ },
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
        refusal: /has no matching decision\.approved event in this transaction|naming .* as its approver, and this transaction carries 0 approval-family event/ },
      { name: 'the approval event is attributed to ANOTHER user than the revision\'s approver (wrong actor)',
        // bound by 4d-i's `DecisionEvent_t4d_correspondence`, which this unit's mandatory audit
        // row now makes fire on every approval; the message is that seal's
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, actor: 'mx-client' }),
        // the revision claimant now binds the actor itself and refuses the event not attributed to
        // its approver, alongside 4d-i's correspondence — either deferred seal may fire first
        refusal: /names an actor other than mx-pmc|naming .* as its approver, and this transaction carries 0 approval-family event/ },
      { name: 'the finalized revision names NO approver (approvedById NULL) beside a HUMAN-attributed event (Codex U3 round 1)',
        // 4d-i's correspondence SKIPS a NULL fact actor, so a human `decision.approved` over an
        // approver-less finalized head is unbound there; the claimant must refuse it, not admit it —
        // either it refuses the approver-less head, or it declines to claim and the kernel pairing
        // seal aborts the unclaimed pairing-required event
        bundle: TX(RESERVE('mx-rev-cmd', 'decisions.approve', 'mx-pmc'),
          `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec';
           INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
             VALUES ('mx-rev','mx-proj','mx-dec',1,'a',now(),NULL,'mx-rev-cmd');`,
          EV({ id: 'mx-ev-ap', type: 'decision.approved', dec: 'mx-dec', version: CURRENT, actor: 'mx-pmc',
            push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` }),
          AU('mx-dec', 'approved'), COMPLETE('mx-rev-cmd', 'mx-dec')),
        refusal: /naming <nobody> as its approver|requires a pairing claim and none was made/ },
      { name: 'TWO revisions born beside one event (duplicated evidence)',
        bundle: TX(RESERVE('mx-c1', 'decisions.approve', 'mx-pmc'), RESERVE('mx-c2', 'decisions.approve', 'mx-pmc'),
          `UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'mx-dec';
           INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
             VALUES ('mx-rev-1','mx-proj','mx-dec',1,'a',now(),'mx-pmc','mx-c1'), ('mx-rev-2','mx-proj','mx-dec',2,'a',now(),'mx-pmc','mx-c2');`,
          AU('mx-dec', 'approved'), EV({ id: 'mx-ev-ap', type: 'decision.approved', dec: 'mx-dec', version: CURRENT, actor: 'mx-pmc',
            push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` }),
          COMPLETE('mx-c1', 'mx-dec'), COMPLETE('mx-c2', 'mx-dec')),
        refusal: /rows BORN in this transaction|approval revision/ },
      // 4d-ii-a / A7a (#665's review round 1, P1): the payload's `revisionId` is bound to the head
      { name: 'the approval event names ANOTHER decision\'s revision as the one this act wrote (A7a: the green notice would render that revision\'s option under this decision)',
        setup: HAND(`INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
                       VALUES ('mx-rev-other','mx-proj','mx-dec2',1,'b',now(),'mx-pmc');`),
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, named: 'mx-rev-other' }),
        refusal: /names revision `mx-rev-other` as the one its act wrote, but the finalized head born in this transaction is mx-rev/ },
      { name: 'the approval event names an OLDER revision of this decision, not the head this act wrote (A7a)',
        setup: HAND(`INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
                       VALUES ('mx-rev-v1','mx-proj','mx-dec',1,'b',now(),'mx-pmc');`),
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, named: 'mx-rev-v1', revVersion: 2 }),
        refusal: /names revision `mx-rev-v1` as the one its act wrote, but the finalized head born in this transaction is mx-rev/ },
      { name: 'the approval event names a revision that does not exist (A7a)',
        bundle: APPROVAL({ rev: 'mx-rev', ev: 'mx-ev-ap', version: CURRENT, named: 'mx-rev-nowhere', order: 'event-first' }),
        refusal: /names revision `mx-rev-nowhere` as the one its act wrote/ },
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
      { name: 'the reapproval event is attributed to ANOTHER user than the revision\'s approver (wrong actor)',
        bundle: REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version: CURRENT, actor: 'mx-client' }),
        refusal: /names an actor other than mx-pmc|naming .* as its approver, and this transaction carries 0 approval-family event/ },
      { name: 'the reapproval moves the decision and writes its revision but leaves the request OPEN (missing converse)',
        bundle: REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version: CURRENT, closure: false }),
        refusal: /change → approved.* with 0 change request\(s\) closed here/ },
      // 4d-ii-a / A7a (#665's review round 1, P1)
      { name: 'the reapproval event names ANOTHER decision\'s revision as the one this act wrote (A7a)',
        setup: HAND(`INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
                       VALUES ('mx-rev-other','mx-proj','mx-dec',1,'b',now(),'mx-pmc');`),
        bundle: REAPPROVAL({ rev: 'mx-rev2', ev: 'mx-ev-re', cr: 'mx-cr', version: CURRENT, named: 'mx-rev-other' }),
        refusal: /names revision `mx-rev-other` as the one its act wrote, but the finalized head born in this transaction is mx-rev2/ },
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
      { name: 'the standard opening\'s event is attributed to ANOTHER user than the request\'s requester (wrong actor)',
        bundle: OPENING({ cr: 'mx-cr', ev: 'mx-ev-open', version: CURRENT, actor: 'mx-client' }),
        // the standard request now binds its own actor too, alongside 4d-i's correspondence
        refusal: /names an actor other than mx-pmc|names .* as its requester, and this transaction carries 0 `decision.change_requested` event/ },
      { name: 'the standard opening names NO requester (requestedById NULL) beside a HUMAN-attributed event (Codex U3 round 1)',
        // 4d-i's correspondence SKIPS a NULL fact actor, so a human `decision.change_requested` over
        // a requester-less standard request is unbound there; the request must bind its own actor and
        // refuse — else it declines to claim and the kernel pairing seal aborts the unclaimed event
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
          `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","requestedById")
             VALUES ('mx-cr','mx-proj','mx-dec2','the ask',0,0,'open',NULL);`,
          EV({ id: 'mx-ev-open', type: 'decision.change_requested', dec: 'mx-dec2', version: CURRENT, actor: 'mx-pmc' }),
          AU('mx-dec2', 'change_requested')),
        refusal: /names <nobody> as its requester|requires a pairing claim and none was made/ },
      { name: 'the standard opening is written with NO event',
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
          `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","requestedById")
             VALUES ('mx-cr','mx-proj','mx-dec2','the ask',0,0,'open','mx-pmc');`, AU('mx-dec2', 'change_requested')),
        refusal: /with 0 `decision.change_requested` event|has no matching|names .* as its requester, and this transaction carries 0 `decision.change_requested` event/ },
      { name: 'the decision is moved into change with its event and audit row but NO request (missing converse)',
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';`,
          EV({ id: 'mx-ev-open', type: 'decision.change_requested', dec: 'mx-dec2', version: CURRENT, actor: 'mx-pmc' }), AU('mx-dec2', 'change_requested')),
        // the decision-side converse (Decision UPDATE queued first) and 4d-i's audit correspondence
        // (the audit row records an act no request wrote) both bind the arm to the missing request
        refusal: /approved → change.* with 0 open `standard` change request\(s\) born here|has no matching change request written by this transaction/ },
      { name: 'a countersign_rejection request is opened beside a NO-OP update of a decision already in change (finding 2)',
        // the world no delivered writer produces before 4d-ii: a decision sitting in `change` with
        // no open request, and a provisional revision for the request to cite
        setup: HAND(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec2';
          INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom")
            VALUES ('mx-rev-prov','mx-proj','mx-dec2',1,'a',now(),'mx-client',FALSE,'pending');`),
        bundle: TX(`UPDATE "Decision" SET "room" = "room" WHERE "id" = 'mx-dec2';`,
          `INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId","requestedById")
             VALUES ('mx-cr-rej','mx-proj','mx-dec2','forged disagreement',0,0,'open','countersign_rejection','mx-rev-prov','mx-pmc');`,
          EV({ id: 'mx-ev-rej', type: 'decision.change_requested', dec: 'mx-dec2', version: CURRENT, actor: 'mx-pmc' })),
        refusal: /no `awaiting_countersign → change` move of decision/ },
    ],
  },
  {
    // the SECOND writer branch of `decision.change_requested` — the architect's disagreement
    // (reject-back / forward-on, 4d-ii's `decisions.disagree`): `awaiting_countersign → change`
    // with an open `countersign_rejection` request citing the provisional head. The world no
    // delivered writer produces before 4d-ii is planted by HAND (the reservation door admits
    // leaving `awaiting_countersign`; only entering it is reserved), and the bundle itself runs
    // through every seal. #590's review round 3: the first head claimed this branch's event only
    // in the deferred seal, so the event-first order below was refused as unclaimed.
    key: 'decision.change_requested',
    writer: 'decisions.disagree (countersign_rejection)',
    fact: 'ChangeRequest (origin countersign_rejection, citing the provisional revision)',
    audit: 'DecisionEvent.change_requested (demanded since A8b, #673 round 1)',
    transition: 'Decision awaiting_countersign → change (recorded as change_from_awaiting)',
    enforcedBy: ['ChangeRequest_t4d_paired', 'ChangeRequest_t4d_claim', 'Decision_t4d_disagreement_paired',
      'Decision_t4d_change_transition', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: HAND(`UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'mx-dec';
      INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom")
        VALUES ('mx-rev-park','mx-proj','mx-dec',1,'a',now(),'mx-client',FALSE,'pending');`),
    // the positive cites the disagreement's receipt as the delivered writer does (#673 round 3: the
    // provenance seal names the request as `decisions.disagree`'s ONE primary table)
    positive: (order, version) => REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version, order, receipt: 'decisions.disagree' }),
    claim: 'mx-ev-rej:ChangeRequest:mx-cr-rej',
    negatives: [
      { name: 'the decision is moved out of awaiting_countersign with its event but NO rejection request (missing converse)',
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec';`,
          EV({ id: 'mx-ev-rej', type: 'decision.change_requested', dec: 'mx-dec', version: CURRENT, actor: 'mx-client' })),
        // two seals refuse this — this unit's decision-side arm (queued first, by name) and 4d-i's
        // disagreement door — and either message binds the arm to the missing request
        refusal: /awaiting_countersign → change.* with 0 open `countersign_rejection` change request\(s\) born here|in this transaction with no open `countersign_rejection` request/ },
      { name: 'the disagreement\'s event is attributed to ANOTHER user than the request\'s requester (wrong actor, #590 round 4)',
        // the request's own seal binds the event's actor to `requestedById`; since A8b the audit row
        // is demanded too, so 4d-i's correspondence binds the same pair through the register
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, actor: 'mx-pmc' }),
        refusal: /countersign_rejection request .* names mx-client as its requester, and this transaction carries 0 `decision.change_requested` event\(s\) attributed to that person|names an actor other than/ },
      { name: 'the disagreement is written with its request and event but NO `change_requested` audit row (A8b, #673 round 1)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, audit: false }),
        refusal: /countersign_rejection request .* was opened in this transaction with 0 `change_requested` audit row\(s\)/ },
      { name: 'the disagreement is written with its request, event and audit row but NO bound change-request notice (A8b, #673 round 2)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, notice: false }),
        refusal: /with 0 bound notice\(s\) of kind `decision\.change_requested`/ },
      { name: 'the disagreement\'s event carries NO origin (the renderer would render nothing; A8b, #673 round 2)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, origin: null }),
        refusal: /with 0 `decision\.change_requested` event\(s\) naming it \(`payload\.requestId`\), its origin/ },
      { name: 'the disagreement\'s event names ANOTHER request (A8b, #673 round 2)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, named: 'mx-cr-other' }),
        refusal: /with 0 `decision\.change_requested` event\(s\) naming it \(`payload\.requestId`\), its origin/ },
      { name: 'the disagreement\'s event carries NO title (the renderer would render nothing; A8b, #673 round 3)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, title: null }),
        refusal: /with 0 `decision\.change_requested` event\(s\) naming it .* the decision's title \(`payload\.title`\) and its own reason/ },
      { name: 'the disagreement\'s event carries ANOTHER decision\'s title (A8b, #673 round 3)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, title: 'MX Approved' }),
        refusal: /with 0 `decision\.change_requested` event\(s\) naming it .* the decision's title \(`payload\.title`\) and its own reason/ },
      { name: 'the disagreement\'s event carries a reason the request never recorded (a forged notice; A8b, #673 round 3)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, reason: 'words the request never carried' }),
        refusal: /with 0 `decision\.change_requested` event\(s\) naming it .* the decision's title \(`payload\.title`\) and its own reason/ },
      { name: 'the disagreement\'s event carries NO reason (A8b, #673 round 3)',
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, reason: null }),
        refusal: /with 0 `decision\.change_requested` event\(s\) naming it .* the decision's title \(`payload\.title`\) and its own reason/ },
      { name: 'the request\'s reason is a TAB alone, carried faithfully by the event (blank to the eye; A8b, #673 round 4)',
        // at 6c13a5c this bundle COMMITTED: `btrim`'s default set is the space alone
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, requestReason: `E'\\t'` }),
        refusal: /countersign_rejection request mx-cr-rej of decision mx-dec carries a blank reason/ },
      { name: 'the rejection request is named as the PRIMARY result of a `decisions.resolveStrandedCountersign` receipt with NO resolution written (the PMC\'s return without its fact; A8b, #673 round 3)',
        // at b193f77 this bundle COMMITTED: the receipt arm returned for any row the receipt named
        bundle: REJECT({ cr: 'mx-cr-rej', ev: 'mx-ev-rej', version: CURRENT, receipt: 'decisions.resolveStrandedCountersign' }),
        refusal: /ChangeRequest\.mx-cr-rej is named as the PRIMARY result of its `decisions\.resolveStrandedCountersign` receipt, but that command's primary fact is a DecisionStrandedResolution row/ },
      { name: 'a rejection request PLANTED EARLIER is no-op updated to stand in for the one this disagreement owes, at the drain generation (no-op substitution)',
        // 4d-i's disagreement door reads the request by `xmin`, which the touch supplies; at the
        // prior generation the event owes no claim, so at cc923fdd this bundle COMMITTED — a
        // decision reopened with a reason another act wrote
        setup: HAND(`INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId")
          VALUES ('mx-cr-old','mx-proj','mx-dec','an earlier disagreement',0,0,'open','countersign_rejection','mx-rev-park');`),
        bundle: TX(`UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'mx-dec';`,
          `UPDATE "ChangeRequest" SET "reason" = "reason" WHERE "id" = 'mx-cr-old';`,
          EV({ id: 'mx-ev-rej', type: 'decision.change_requested', dec: 'mx-dec', version: PRIOR }), AU('mx-dec', 'change_requested')),
        refusal: /awaiting_countersign → change.* with 0 open `countersign_rejection` change request\(s\) born here/ },
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
      { name: 'the withdrawal\'s event is attributed to ANOTHER user than the closure\'s resolver (wrong actor)',
        bundle: WITHDRAWAL({ cr: 'mx-cr', ev: 'mx-ev-wd', version: CURRENT, actor: 'mx-client' }),
        refusal: /names an actor other than mx-pmc/ },
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
      { name: 'the event is attributed to ANOTHER user than the consultation\'s requester (wrong actor, #590 round 4)',
        // identified and targeted correctly, and announced as the consultee's own ask
        bundle: CONSULT({ dc: 'mx-dc', ev: 'mx-ev-dc', version: CURRENT, actor: 'mx-eng' }),
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
      { name: 'the event is attributed to ANOTHER user than the response\'s responder (wrong actor, #590 round 4)',
        // identified and targeted correctly, and announced as the requester's own answer
        bundle: RESPOND({ dcr: 'mx-dcr', dc: 'mx-dc', ev: 'mx-ev-dcr', version: CURRENT, actor: 'mx-pmc' }),
        refusal: /response .* with 0 `decision.consultation_responded` event/ },
    ],
  },
  // 4d-ii-a / A7d — the architect-standing flip: the transition is the branch's primary fact
  {
    key: 'membership.standing_changed',
    priorAbsent: true,
    writer: 'members.add (the first architect — the chain activates)',
    fact: 'MembershipTransition (NULL/NULL → architect/active)',
    audit: null,
    transition: 'Membership INSERT (architect, active) under a members.add receipt; the register head reads 1',
    enforcedBy: ['MembershipTransition_t4d_claim', 'MembershipTransition_t4d_claim_deferred', 'Membership_t4d_architect_paired', 'DomainEvent_t4d_pairing_claimed'],
    setup: STANDING_WORLD,
    positive: (order, version) => STANDING({ mt: 'mx-mt', ev: 'mx-ev-st', version, order }),
    claim: 'mx-ev-st:MembershipTransition:mx-mt',
    negatives: [
      { name: 'the flipping transition is written with NO standing event',
        bundle: STANDING({ mt: 'mx-mt', ev: 'mx-ev-st', version: CURRENT, event: false }),
        refusal: /flips the project's architect standing, and this transaction carries 0 `membership.standing_changed` event/ },
      { name: 'the event records an activeCount that is not the register\'s head at commit',
        bundle: STANDING({ mt: 'mx-mt', ev: 'mx-ev-st', version: CURRENT, count: 2 }),
        refusal: /records an `activeCount` that is not the architect register's head at commit/ },
      { name: 'the event is attributed to ANOTHER user than the transition\'s actor (wrong actor)',
        bundle: STANDING({ mt: 'mx-mt', ev: 'mx-ev-st', version: CURRENT, actor: { id: 'mx-client', role: 'client', name: 'MX Client' } }),
        refusal: /carries 0 `membership.standing_changed` event|requires a pairing claim and none was made/ },
      { name: 'a transition that flips NOTHING (an engineer\'s add) is announced as a standing change',
        bundle: STANDING({ mt: 'mx-mt', ev: 'mx-ev-st', version: CURRENT, role: 'engineer' }),
        refusal: /flips no architect standing, yet this transaction carries 1|requires a pairing claim and none was made/ },
    ],
  },
  // 4d-ii-a / A8a — the hand-off: the forward fact is the branch's primary fact
  {
    key: 'decision.forwarded',
    priorAbsent: true,
    writer: 'decisions.forward (the PMC hands the client-held pending decision to the engineer)',
    fact: 'DecisionForward (client/NULL → member/mx-mem-e, the actor\'s frozen pair)',
    audit: 'DecisionEvent.forwarded',
    transition: 'Decision holder client → member through the attribution seal\'s one door, under a decisions.forward receipt naming the fact',
    enforcedBy: ['DecisionForward_t4d_claim', 'DecisionForward_t4d_claim_deferred', 'DecisionForward_t4d_seal', 'DecisionForward_t4d_paired',
      'DecisionForward_t4d_provenance_bound', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: FORWARD_WORLD,
    positive: (order, version) => FORWARD({ fwd: 'mx-fwd', ev: 'mx-ev-fw', version, order }),
    claim: 'mx-ev-fw:DecisionForward:mx-fwd',
    negatives: [
      { name: 'the forward is written with NO event',
        bundle: FORWARD({ fwd: 'mx-fwd', ev: 'mx-ev-fw', version: CURRENT, event: false }),
        refusal: /with 0 `decision.forwarded` event\(s\) that name it/ },
      { name: 'the event names ANOTHER forward (wrong identity)',
        bundle: FORWARD({ fwd: 'mx-fwd', ev: 'mx-ev-fw', version: CURRENT, named: 'mx-fwd-other' }),
        refusal: /with 0 `decision.forwarded` event\(s\) that name it/ },
      { name: 'the event is attributed to ANOTHER user than the forward\'s actor (wrong actor)',
        bundle: FORWARD({ fwd: 'mx-fwd', ev: 'mx-ev-fw', version: CURRENT, actor: 'mx-client' }),
        refusal: /with 0 `decision.forwarded` event\(s\) that name it|requires a pairing claim and none was made|names an actor other than/ },
      { name: 'the fact is written and announced but the holder never moves (orphan evidence)',
        bundle: FORWARD({ fwd: 'mx-fwd', ev: 'mx-ev-fw', version: CURRENT, move: false }),
        refusal: /ORPHAN evidence of a hand-off that did not happen/ },
      { name: 'the same-target no-op: the client-held decision is handed to the client role',
        bundle: FORWARD({ fwd: 'mx-fwd', ev: 'mx-ev-fw', version: CURRENT, to: { kind: 'client', membershipId: null } }),
        refusal: /DecisionForward_designation_moves_check/ },
      // NOT a negative here: a forward bundle WITHOUT its `forwarded` audit row COMMITS under the delivered
      // seals (the correspondence seal judges from the audit row's side, and no forward seal demands the
      // row) — the service writes it, and the DB-side demand is a residual stated in A8a's packet.
    ],
  },
  // 4d-ii-a / A8a — the countersign demand: the provisional revision is the branch's primary fact
  {
    key: 'decision.awaiting_countersign',
    priorAbsent: true,
    writer: 'decisions.approve under an ACTIVE chain (the provisional approve from pending)',
    fact: 'DecisionApprovalRevision (provisional birth: finalized = false, approvedFrom = pending, the approver\'s frozen pair)',
    audit: 'DecisionEvent.approved',
    transition: 'Decision pending → awaiting_countersign, the tuple written as the finalizing act would (recorded by Decision_t4d_approval_transition)',
    enforcedBy: ['DecisionApprovalRevision_t4d_claim', 'DecisionApprovalRevision_t4d_claim_deferred', 'DecisionApprovalRevision_t4d_birth',
      'DecisionApprovalRevision_t4d_birth_paired', 'Decision_t4d_entry_seal', 'Decision_t4d_awaiting_paired', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: CHAIN_WORLD,
    positive: (order, version) => PROVISIONAL({ rev: 'mx-rev', ev: 'mx-ev-aw', version, order }),
    claim: 'mx-ev-aw:DecisionApprovalRevision:mx-rev',
    negatives: [
      { name: 'the provisional revision is written with NO demand event',
        bundle: PROVISIONAL({ rev: 'mx-rev', ev: 'mx-ev-aw', version: CURRENT, event: false }),
        refusal: /carries 0 `decision.awaiting_countersign` event\(s\)/ },
      { name: 'the demand names ANOTHER revision (wrong identity)',
        bundle: PROVISIONAL({ rev: 'mx-rev', ev: 'mx-ev-aw', version: CURRENT, named: 'mx-rev-other' }),
        refusal: /carries 0 `decision.awaiting_countersign` event\(s\)/ },
      { name: 'the demand is attributed to ANOTHER user than the revision\'s approver (wrong actor)',
        bundle: PROVISIONAL({ rev: 'mx-rev', ev: 'mx-ev-aw', version: CURRENT, actor: 'mx-client' }),
        refusal: /carries 0 `decision.awaiting_countersign` event\(s\)|requires a pairing claim and none was made|names an actor other than/ },
      { name: 'the provisional revision is written with its demand but NO audit row',
        bundle: PROVISIONAL({ rev: 'mx-rev', ev: 'mx-ev-aw', version: CURRENT, audit: false }),
        refusal: /born provisional in this transaction with 0 `approved` \/ `reapproved` audit row/ },
      { name: 'a revision BORN finalized under an ACTIVE chain (the writer choosing the birth value)',
        bundle: PROVISIONAL({ rev: 'mx-rev', ev: 'mx-ev-aw', version: CURRENT, finalized: true }),
        refusal: /born finalized=t on a project whose architect chain is ACTIVE/ },
    ],
  },
  // 4d-ii-a / A8b — the countersign: the fact naming the exact head is the branch's primary fact
  {
    key: 'decision.approved',
    writer: 'decisions.countersign (the architect finalizes the parked provisional approval)',
    fact: 'DecisionCountersign (naming the exact head revision, the architect\'s frozen pair)',
    audit: 'DecisionEvent.countersigned',
    transition: 'Decision awaiting_countersign → approved with the head\'s finality flip, under a decisions.countersign receipt naming the fact',
    enforcedBy: ['DecisionCountersign_t4d_claim', 'DecisionCountersign_t4d_claim_deferred', 'DecisionCountersign_t4d_seal', 'DecisionCountersign_t4d_paired',
      'DecisionCountersign_t4d_provenance_bound', 'DecisionApprovalRevision_t4d_flip_paired', 'DecisionApprovalRevision_t4d_one_flip',
      'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: COUNTERSIGN_WORLD,
    positive: (order, version) => COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version, order }),
    claim: 'mx-ev-cs:DecisionCountersign:mx-cs',
    negatives: [
      { name: 'the countersign is written with NO finalizing event',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, event: false }),
        refusal: /with 0 finalizing event\(s\)|carries 0 `decision\.approved`/ },
      { name: 'the event names ANOTHER countersign (wrong identity)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, named: 'mx-cs-other' }),
        refusal: /with 0 finalizing event\(s\)|requires a pairing claim and none was made/ },
      { name: 'the event names ANOTHER revision than the one the fact finalized (wrong identity)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, namedRev: 'mx-rev-other' }),
        refusal: /with 0 finalizing event\(s\)|requires a pairing claim and none was made/ },
      { name: 'the event is attributed to ANOTHER user than the countersigner (wrong actor)',
        // with the envelope pair on the event (#673 round 2) 4d-i's envelope-truth seal refuses first:
        // the other user does not hold the frozen role; either message binds the arm
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, actor: 'mx-pmc' }),
        refusal: /with 0 finalizing event\(s\)|requires a pairing claim and none was made|names an actor other than|a role that actor does not hold/ },
      { name: 'the fact and the event are written but the head is never FLIPPED (a countersign that finalizes nothing)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, flip: false }),
        refusal: /which is not finalized at commit/ },
      { name: 'the fact, the flip and the event are written but the decision stays `awaiting_countersign` (the status never lands)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, land: false }),
        refusal: /at commit the decision is `awaiting_countersign` rather than `approved`/ },
      { name: 'the flip, the landing and the event with NO fact behind them (the forged finalization)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, fact: false }),
        refusal: /with neither a DecisionCountersign nor a `completed` DecisionStrandedResolution naming it|requires a pairing claim and none was made/ },
      { name: 'the countersign is written with its event but NO `countersigned` audit row',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, audit: false }),
        refusal: /with 0 `countersigned` audit row\(s\)/ },
      { name: 'the fact freezes the role `pmc` (a countersign is the architect\'s act)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, role: 'pmc' }),
        refusal: /freezes the role `pmc` — a countersign is the ARCHITECT/ },
      { name: 'the countersign is written with its event and audit row but NO bound green notice (#673 round 2)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, notice: false }),
        refusal: /with 0 bound notice\(s\) of the approval family/ },
      { name: 'the event names NO finalization (the renderer would render an ordinary approval; #673 round 2)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, finalization: null }),
        refusal: /with 0 finalizing event\(s\)|requires a pairing claim and none was made/ },
      { name: 'the event names ANOTHER finalization (`stranded_completed` on a countersign; #673 round 2)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, finalization: 'stranded_completed' }),
        refusal: /with 0 finalizing event\(s\)|requires a pairing claim and none was made/ },
      { name: 'the event\'s envelope carries a role other than the fact\'s frozen pair (P31; #673 round 2)',
        // 4d-i's envelope-truth seal refuses a role the actor does not hold before the claimant compares
        // the pair; a role the actor DOES hold but the fact did not freeze is the claimant's refusal
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, envelopeRole: 'pmc' }),
        refusal: /with 0 finalizing event\(s\)|requires a pairing claim and none was made|a role that actor does not hold/ },
      { name: 'the finalizing event carries NO title (the renderer would render nothing; A8b, #673 round 3)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, title: null }),
        refusal: /with 0 finalizing event\(s\) .* the decision as the log renders it \(`payload\.title` and `payload\.deciderKind` equal to the decision's\)/ },
      { name: 'the finalizing event carries ANOTHER decision\'s title (A8b, #673 round 3)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, title: 'MX Approved' }),
        refusal: /with 0 finalizing event\(s\) .* the decision as the log renders it \(`payload\.title` and `payload\.deciderKind` equal to the decision's\)/ },
      { name: 'the decision\'s title is a NEWLINE alone, carried faithfully by the event (blank to the eye; A8b, #673 round 4)',
        setup: HAND(`UPDATE "Decision" SET "title" = E'\\n' WHERE "id" = 'mx-dec';`),
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, title: '\\n' }),
        refusal: /countersign mx-cs names decision mx-dec, whose title is blank/ },
      { name: 'the finalizing event carries ANOTHER decider kind than the decision\'s (A8b, #673 round 3)',
        bundle: COUNTERSIGN({ cs: 'mx-cs', ev: 'mx-ev-cs', version: CURRENT, deciderKind: 'pmc' }),
        refusal: /with 0 finalizing event\(s\) .* the decision as the log renders it \(`payload\.title` and `payload\.deciderKind` equal to the decision's\)/ },
    ],
  },
  // 4d-ii-a / A8b — the stranded resolution, COMPLETED: the fact is the branch's primary fact
  {
    key: 'decision.approved',
    writer: 'decisions.resolveStrandedCountersign (completed: the PMC finalizes under the inactive chain)',
    fact: 'DecisionStrandedResolution (outcome completed, naming the exact head, the PMC\'s frozen pair)',
    audit: 'DecisionEvent.stranded_resolved',
    transition: 'Decision awaiting_countersign → approved with the head\'s finality flip, under a decisions.resolveStrandedCountersign receipt naming the fact',
    enforcedBy: ['DecisionStrandedResolution_t4d_claim', 'DecisionStrandedResolution_t4d_claim_deferred', 'DecisionStrandedResolution_t4d_seal', 'DecisionStrandedResolution_t4d_paired',
      'DecisionStrandedResolution_t4d_provenance_bound', 'DecisionApprovalRevision_t4d_flip_paired', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: STRANDED_WORLD,
    positive: (order, version) => STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version, order, outcome: 'completed' }),
    claim: 'mx-ev-sr:DecisionStrandedResolution:mx-sr',
    negatives: [
      { name: 'the resolution is written with NO finalizing event',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', event: false }),
        refusal: /with 0 event\(s\) of its outcome's family|carries 0 `decision\.approved`/ },
      { name: 'the event names ANOTHER resolution (wrong identity)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', named: 'mx-sr-other' }),
        refusal: /with 0 event\(s\) of its outcome's family|requires a pairing claim and none was made/ },
      { name: 'the event is attributed to ANOTHER user than the resolver (wrong actor)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', actor: 'mx-client' }),
        refusal: /with 0 event\(s\) of its outcome's family|requires a pairing claim and none was made|names an actor other than|a role that actor does not hold/ },
      { name: 'the fact and the event are written but the head is never flipped and the decision never lands',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', flip: false, land: false }),
        refusal: /owes BOTH the finality flip on revision mx-rev-park and the `awaiting_countersign → approved` transition/ },
      { name: 'the resolution is written with its event but NO `stranded_resolved` audit row',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', audit: false }),
        refusal: /with 0 `stranded_resolved` audit row\(s\)/ },
      { name: 'the project still holds an ACTIVE architect (the decision is not stranded; the countersign is the legal path)',
        setup: `${STANDING_WORLD} ${STANDING({ mt: 'mx-mt1', ev: 'mx-ev-st1', version: CURRENT })}`,
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed' }),
        refusal: /still holds an ACTIVE architect, so decision mx-dec is not stranded/ },
      { name: 'the fact freezes the role `architect` (resolving a stranded decision is the PMC\'s named act)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', role: 'architect' }),
        refusal: /freezes the role `architect` — resolving a stranded decision is the PMC/ },
      { name: 'the completed resolution is written with its event and audit row but NO bound green notice (#673 round 2)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', notice: false }),
        refusal: /with 0 bound notice\(s\) of its outcome's family/ },
      { name: 'the completed resolution\'s event announces `returned` (the discriminator swapped; #673 round 2)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', announced: 'returned' }),
        refusal: /with 0 event\(s\) of its outcome's family|requires a pairing claim and none was made/ },
      { name: 'the completing event carries ANOTHER decision\'s title (A8b, #673 round 3)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', title: 'MX Approved' }),
        refusal: /with 0 event\(s\) of its outcome's family .* the decision as the log renders it \(`payload\.title` equal to the decision's; `completed`: `payload\.deciderKind` too\)/ },
      { name: 'the completing event carries NO decider kind (the renderer would render nothing; A8b, #673 round 3)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'completed', deciderKind: null }),
        refusal: /with 0 event\(s\) of its outcome's family .* the decision as the log renders it \(`payload\.title` equal to the decision's; `completed`: `payload\.deciderKind` too\)/ },
    ],
  },
  // 4d-ii-a / A8b — the stranded resolution, RETURNED: the resolution claims; the request it opens verifies
  {
    key: 'decision.change_requested',
    writer: 'decisions.resolveStrandedCountersign (returned: the PMC reopens under the inactive chain)',
    fact: 'DecisionStrandedResolution (outcome returned, naming the exact head) with the open countersign_rejection ChangeRequest citing it under the same receipt',
    audit: 'DecisionEvent.stranded_resolved (and the request\'s change_requested)',
    transition: 'Decision awaiting_countersign → change (recorded as change_from_awaiting), the request opened under a decisions.resolveStrandedCountersign receipt naming the resolution',
    enforcedBy: ['DecisionStrandedResolution_t4d_claim', 'DecisionStrandedResolution_t4d_claim_deferred', 'DecisionStrandedResolution_t4d_seal', 'DecisionStrandedResolution_t4d_paired',
      'DecisionStrandedResolution_t4d_provenance_bound', 'ChangeRequest_t4d_source_bound', 'ChangeRequest_t4d_paired', 'ChangeRequest_t4d_claim',
      'Decision_t4d_disagreement_paired', 'Decision_t4d_change_paired', 'DecisionEvent_t4d_correspondence', 'DomainEvent_t4d_pairing_claimed'],
    setup: STRANDED_WORLD,
    positive: (order, version) => STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version, order, outcome: 'returned' }),
    claim: 'mx-ev-sr:DecisionStrandedResolution:mx-sr',
    negatives: [
      { name: 'the returned resolution is written with NO reopening event',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', event: false }),
        refusal: /with 0 event\(s\) of its outcome's family|carries 0 `decision\.change_requested`/ },
      { name: 'the event names ANOTHER resolution (wrong identity)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', named: 'mx-sr-other' }),
        refusal: /with 0 event\(s\) of its outcome's family|requires a pairing claim and none was made/ },
      { name: 'the event is attributed to ANOTHER user than the resolver (wrong actor)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', actor: 'mx-client' }),
        refusal: /with 0 event\(s\) of its outcome's family|requires a pairing claim and none was made|names an actor other than|names .* as its requester|a role that actor does not hold/ },
      { name: 'the resolution and the transition are written with NO rejection request (the return that nothing can close)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', request: false }),
        refusal: /with no open `countersign_rejection` request/ },
      { name: 'the resolution, the request and the event are written but the decision stays `awaiting_countersign`',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', land: false }),
        refusal: /at commit the decision is `awaiting_countersign` rather than `change`|is `awaiting_countersign`, not `change`/ },
      { name: 'the returned resolution is written with its event but NO `stranded_resolved` audit row',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', audit: false }),
        refusal: /with 0 `stranded_resolved` audit row\(s\)/ },
      { name: 'the project still holds an ACTIVE architect (the return is refused; the disagreement is the architect\'s)',
        setup: `${STANDING_WORLD} ${STANDING({ mt: 'mx-mt1', ev: 'mx-ev-st1', version: CURRENT })}`,
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned' }),
        refusal: /still holds an ACTIVE architect, so decision mx-dec is not stranded/ },
      { name: 'the returned resolution is written with its request, event and audit rows but NO bound change-request notice (#673 round 2)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', notice: false }),
        refusal: /with 0 bound notice\(s\)/ },
      { name: 'the returned resolution\'s event announces `completed` (the discriminator swapped; #673 round 2)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', announced: 'completed' }),
        refusal: /with 0 event\(s\) of its outcome's family|requires a pairing claim and none was made/ },
      { name: 'the returning event carries NO title (the renderer would render nothing; A8b, #673 round 3)',
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', title: null }),
        refusal: /with 0 event\(s\) of its outcome's family .* the decision as the log renders it \(`payload\.title` equal to the decision's/ },
      { name: 'the resolution records ANOTHER reason than the request, the event and the notice it opens (A8b, #673 round 4)',
        // at 6c13a5c this bundle COMMITTED: the bundle arm paired the two by receipt, decision, outcome and revision alone
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', srReason: 'a reason the request never carried' }),
        refusal: /the receipt cited by ChangeRequest\.mx-sr-cr names result mx-sr, which is neither this row nor the PRIMARY fact of its `decisions\.resolveStrandedCountersign` bundle citing the same receipt for the same decision and stating the SAME reason/ },
      { name: 'the returned bundle\'s request names an EARLIER revision than the one the resolution disposed of (A8b, #673 round 3)',
        // the world after a rejected head was re-approved: the fresh provisional head (version 2) stands
        // above the earlier revision the rejection disposed of; the resolution disposes of the head while
        // the immutable request records the earlier one — at b193f77 this bundle COMMITTED
        setup: HAND(`INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom","approvedByName","approvedByRole")
          VALUES ('mx-rev-other','mx-proj','mx-dec',2,'a',now(),'mx-client',FALSE,'pending','MX Client','client');`),
        bundle: STRANDED({ sr: 'mx-sr', ev: 'mx-ev-sr', version: CURRENT, outcome: 'returned', rev: 'mx-rev-other', requestRev: 'mx-rev-park' }),
        refusal: /the receipt cited by ChangeRequest\.mx-sr-cr names result mx-sr, which is neither this row nor the PRIMARY fact of its `decisions\.resolveStrandedCountersign` bundle .* naming, for a request, the SAME revision the request cites/ },
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
    // a key may carry more than one WRITER BRANCH (`decision.change_requested`: the standard
    // opening and the disagreement's `countersign_rejection`), so the set of keys is compared;
    // 4d-ii-a / A7d: a key whose writer is a later unit's is OWED, its claimants asserted to stand
    expect([...new Set([...MATRIX.map((b) => b.key), ...Object.keys(OWED_BUNDLES)])].sort(), 'a flipped type without executable bundle coverage fails here').toEqual(flagged);
    for (const [key, owed] of Object.entries(OWED_BUNDLES)) {
      expect(MATRIX.some((b) => b.key === key), `${key} is owed to ${owed.unit}: not yet in the matrix`).toBe(false);
      const standing = psql(TEMPLATE, `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname = ANY (ARRAY['${owed.claimants.join("','")}'])`);
      expect(standing.output.trim(), `${key}'s claimants stand`).toMatch(new RegExp(`\\b${owed.claimants.length}\\b`));
    }
    for (const b of MATRIX) {
      expect(b.negatives.length, `${b.key} needs at least a missing-counterpart variant`).toBeGreaterThan(0);
      expect(b.enforcedBy.length, `${b.key} names its enforcement`).toBeGreaterThan(0);
    }
  });

  for (const b of MATRIX) {
    describe(`${b.key} · ${b.writer}`, () => {
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
      if (b.priorAbsent) {
        it(`${b.writer}: at the PRIOR generation the type does not exist — a previous release cannot emit it, and the envelope seal says so`, () => {
          const r = run(b.setup, b.positive('fact-first', PRIOR));
          expect(r.ok, 'an emission under a generation that never carried the key must be REFUSED').toBe(false);
          expect(r.output).toMatch(/which this database does not hold/);
        }, 120_000);
      } else {
        it(`${b.writer}: the complete bundle commits at the PRIOR generation — a still-serving 4d-i writer keeps working through the drain`, () => {
          const r = run(b.setup, b.positive('fact-first', PRIOR));
          expect(r.ok, `a previous-release writer's bundle must COMMIT:\n${r.output}`).toBe(true);
        }, 120_000);
      }
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
