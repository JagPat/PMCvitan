import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { effectCoverageVersion } from '../../src/platform/external-effects';

/**
 * Phase 6 unit 4d-i-b — U1: the bound-event/actor primitive and the DORMANT actor seal
 * (docs/superpowers/plans/2026-09-21-4d-i-b-additive-units.md).
 *
 * U1 installs two things and BOTH are dark over the live catalog, whose every decision row is
 * `pairingRequired = false`:
 *
 *   (1) `phase6_t4d_tx_actor_event` / `_count` — the same-transaction `DomainEvent` lookup narrowed
 *       to one actor, the primitive U2's seals and U3's audit-less claimants will bind through.
 *   (2) `DomainEvent_t4d_pairing_actor` — the kernel actor seal: a `pairingRequired` event must be a
 *       named human (`actorKind = 'human'`, `actorId` not null). It reads the event's own catalog
 *       row by `(coverageVersion, effectKey)` and RETURNS NULL when that row is not
 *       `pairingRequired`, so over the two live 4d-i generations it never fires.
 *
 * The proof therefore has two halves. FIRST, dormancy: over the live generation a `system`/NULL
 * event of every would-be-paired type commits — U1 refuses nothing a release produces. SECOND, the
 * rule itself, made observable by planting a TEST-FLAGGED generation (the declared test bypass:
 * `session_replication_role = 'replica'` while copying the live rows with `pairingRequired = true`,
 * so the catalog's own seals are not the thing under test): at that generation a `system`/NULL
 * event is refused by the actor seal AT INSERT, while a `human` event passes it and is held only by
 * 4d-i's deferred claim seal — which is the round-4 defect (a current-generation `system` event with
 * `actorId = NULL` beside a real user's fact) closed at the event boundary itself.
 *
 * ON A COPY of the migrated test database, so the plant of a flagged generation never touches the
 * shared one.
 */

const TEMPLATE = (() => {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test';
  return new URL(raw).pathname.replace(/^\//, '');
})();
const RUN_DB = 't4dib_u1_run';

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

/** the generation the app emits under — every decision row here is pairingRequired = false */
const LIVE = effectCoverageVersion();
/** a synthetic generation this suite plants with pairingRequired = true, to make the seal fire */
const FLAGGED = 'u1-test-flagged-generation';

// the six decision types the flip (U3) will turn on; U1's seal must judge each once flagged
type Push = string;
const TYPES: { key: string; push: (target?: string) => Push }[] = [
  { key: 'decision.approved', push: () => `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` },
  { key: 'decision.reapproved', push: () => `, 'push', jsonb_build_object('body','reapproved','roles', c."pushRoles")` },
  { key: 'decision.change_requested', push: () => `` },
  { key: 'decision.change_withdrawn', push: () => `` },
  { key: 'decision.consultation_requested', push: () => `, 'push', jsonb_build_object('body','asked','roles', jsonb_build_array('engineer'),'targetUserId','mx-eng')` },
  { key: 'decision.consultation_responded', push: () => `, 'push', jsonb_build_object('body','answered','roles', jsonb_build_array('pmc'),'targetUserId','mx-pmc')` },
];

/** an event planted `emitEvent`'s way — the ALLOCATOR protocol inline: increment
 *  `ProjectEventStream."nextPosition"` then insert at `nextPosition - 1` in ONE transaction, so the
 *  allocator is never left behind the stream. No position is chosen by hand, so this satisfies
 *  `ProjectEventStream_t4d_allocation` and builds the full `DomainEvent_t4d_envelope` (intent by
 *  the catalog key, invalidate and push copied from the row) — not a legacy bypass.
 *  `actor` present → a `human` event attributed to that user; absent → a `system` event naming nobody. */
const EV = (o: { id: string; type: string; version: string; actor?: string; push?: Push }) => {
  const who = o.actor ? `'human',NULL,'${o.actor}'` : `'system','system:mx',NULL`;
  return `
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'mx-proj';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","actorId","entityType","entityId","payload","dispatchIntent")
      SELECT '${o.id}','${o.type}',1,'mx-org','mx-proj',s."nextPosition" - 1,${who},'Decision','mx-dec','{}'::jsonb,
             jsonb_build_object('effectKey','${o.type}','coverageVersion',c."coverageVersion",'invalidate',c."invalidate"${o.push ?? ''})
        FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
       WHERE s."projectId" = 'mx-proj' AND c."effectKey" = '${o.type}' AND c."coverageVersion" = '${o.version}';`;
};
const TX = (...parts: string[]) => `BEGIN; ${parts.join('\n')} COMMIT;`;
/** the declared test bypass: turn the delivered triggers off while PLANTING rows a delivered seal
 *  (the catalog's, or the pairing register's writer seal) would otherwise judge — never while
 *  exercising the seal under test, which fires at COMMIT with the role back at 'origin'. */
const HAND = (sql: string) => `SET session_replication_role = 'replica'; ${sql} SET session_replication_role = 'origin';`;
/** a pairing claim for the event, planted by hand: it exists only to SATISFY 4d-i's deferred
 *  `pairing_claimed` seal, so that the actor seal is the one thing left to judge the round-4 shape —
 *  a claimed event whose envelope names nobody. U1 installs no claimant; that is U3's work. */
const CLAIM = (ev: string) =>
  HAND(`INSERT INTO "DomainEventPairingClaim" ("projectId","eventId","claimedBy","claimedById") VALUES ('mx-proj','${ev}','DecisionApprovalRevision','${ev}-fact');`);

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
  VALUES ('mx-dec','mx-proj','MX Pending','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('mx-opt-a','mx-dec','Option A','a','Granite',0,'sw1',0), ('mx-opt-b','mx-dec','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'mx-dec';
COMMIT;
INSERT INTO "ProjectEventStream" ("projectId","nextPosition") VALUES ('mx-proj', 0) ON CONFLICT ("projectId") DO NOTHING;
-- the flagged generation: the live rows for the six types, copied verbatim except a NEW coverage
-- version and pairingRequired = true. Planted BY HAND so the catalog's own INSERT seals are not
-- what this suite measures; the seal under test fires on the EVENT, at 'origin'.
` + HAND(`
INSERT INTO "ExternalEffectCatalog" ("coverageVersion","effectKey","eventType","invalidate","pushRoles","pushFamily","frozenAudience","requiresPush","audience","pushBody","pairingRequired")
  SELECT '${FLAGGED}', c."effectKey", c."eventType", c."invalidate", c."pushRoles", c."pushFamily", c."frozenAudience", c."requiresPush", c."audience", c."pushBody", TRUE
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = '${LIVE}'
     AND c."effectKey" IN ('decision.approved','decision.reapproved','decision.change_requested','decision.change_withdrawn','decision.consultation_requested','decision.consultation_responded');
`);

function reset(): void {
  psql('postgres', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`);
  psql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEMPLATE}' AND pid <> pg_backend_pid()`);
  const created = psql('postgres', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${TEMPLATE}"`);
  expect(created.ok, created.output).toBe(true);
  const world = psql(RUN_DB, WORLD);
  expect(world.ok, `the world must plant:\n${world.output}`).toBe(true);
}

describe('phase 6 unit 4d-i-b U1 — the bound event/actor primitive and the dormant actor seal', () => {
  beforeAll(reset);

  // ── DORMANCY: over the live catalog the seal never fires, so nothing a release emits is refused.
  for (const t of TYPES) {
    it(`is DARK over the live generation: a system/NULL-actor \`${t.key}\` event commits`, () => {
      const r = psql(RUN_DB, TX(EV({ id: `dk-${t.key}`, type: t.key, version: LIVE, push: t.push() })));
      expect(r.ok, `a system event of a pairingRequired-eligible type must still commit while no generation carries the flag:\n${r.output}`).toBe(true);
    });
  }

  // ── THE ROUND-4 DEFECT, made observable at a flagged generation: a CLAIMED system/NULL event.
  // The claim satisfies 4d-i's `pairing_claimed` seal, so the ONLY thing standing between this
  // event and commit is the actor seal — exactly the gap round 4 found (a `system` event with
  // `actorId = NULL` beside a fact that claimed it). Both seals are deferred and `pairing_actor`
  // sorts first, so the refusal is the actor seal's.
  for (const t of TYPES) {
    it(`at a flagged generation, a CLAIMED \`${t.key}\` event with NO actor is refused by the actor seal`, () => {
      const r = psql(RUN_DB, TX(EV({ id: `sys-${t.key}`, type: t.key, version: FLAGGED, push: t.push() }), CLAIM(`sys-${t.key}`)));
      expect(r.ok, `a claimed system/NULL-actor pairingRequired event must be refused by the actor seal:\n${r.output}`).toBe(false);
      expect(r.output).toMatch(/pairingRequired but is attributed to actorKind=system/u);
    });

    it(`at a flagged generation, a CLAIMED \`${t.key}\` event WITH a human actor commits`, () => {
      const r = psql(RUN_DB, TX(EV({ id: `hum-${t.key}`, type: t.key, version: FLAGGED, actor: 'mx-pmc', push: t.push() }), CLAIM(`hum-${t.key}`)));
      // named human + a claim: the actor seal admits it and `pairing_claimed` is satisfied, so the
      // whole bundle commits — the legitimate shape the flip (U3) will produce.
      expect(r.ok, `a claimed, human-attributed pairingRequired event must commit:\n${r.output}`).toBe(true);
    });
  }

  // ── THE PRIMITIVE: the same-transaction event bound to a given actor, and only that actor.
  it('phase6_t4d_tx_actor_event returns the event bound to an actor and excludes another actor', () => {
    const probe = `BEGIN;
      ${EV({ id: 'pr-pmc', type: 'decision.approved', version: LIVE, actor: 'mx-pmc', push: `, 'push', jsonb_build_object('body','approved','roles', c."pushRoles")` })}
      ${EV({ id: 'pr-cli', type: 'decision.change_requested', version: LIVE, actor: 'mx-client' })}
      SELECT
        phase6_t4d_tx_actor_event('mx-proj','mx-dec', ARRAY['decision.approved','decision.reapproved'], 'mx-pmc')   AS pmc_hit,
        phase6_t4d_tx_actor_event_count('mx-proj','mx-dec', ARRAY['decision.approved','decision.reapproved'], 'mx-pmc') AS pmc_n,
        phase6_t4d_tx_actor_event('mx-proj','mx-dec', ARRAY['decision.approved','decision.reapproved'], 'mx-eng')    AS eng_hit,
        phase6_t4d_tx_actor_event_count('mx-proj','mx-dec', ARRAY['decision.approved','decision.reapproved'], 'mx-eng') AS eng_n;
      COMMIT;`;
    const r = psql(RUN_DB, probe);
    expect(r.ok, r.output).toBe(true);
    // the approver's event is found and counted once; the engineer, who acted on nothing, gets neither
    expect(r.output).toMatch(/pr-pmc\s*\|\s*1\s*\|\s*\|\s*0/u);
  });
});
