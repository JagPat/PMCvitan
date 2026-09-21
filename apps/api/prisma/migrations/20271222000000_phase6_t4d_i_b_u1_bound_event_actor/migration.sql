-- Phase 6 task 4d, unit 4d-i-b — U1: THE BOUND EVENT/ACTOR PRIMITIVE, BEFORE ANY FLIP
-- (docs/superpowers/plans/2026-09-21-4d-i-b-additive-units.md — the additive U1/U2/U3
-- redesign the owner directed on 2026-09-21, issue #482 comment 5757145200, superseding the
-- single switch-on migration that stopped at its third P1-bearing reviewed head.)
--
-- 4d-i installed the pairing MECHANISM and left every catalog row `pairingRequired = false`.
-- The switch-on is a NEW coverage generation that turns six rows `true` — and that flip belongs
-- to U3, WITH its claimants, because a flag without its claimant refuses legitimate events and a
-- claimant without the flag claims into a register nothing reads. U1 and U2 install the
-- machinery the flip will need, and BOTH are dark: with no generation carrying the flag, nothing
-- here refuses anything a release produces.
--
-- U1 IS TWO THINGS, AND NEITHER BITES UNTIL U3:
--
--   (1) THE BOUND-EVENT PRIMITIVE. `phase6_t4d_tx_actor_event(project, decision, types, actor)`
--       and its `_count`: the same-transaction (`xmin = txid_current()`) `DomainEvent` lookup
--       narrowed to ONE actor. This is the kernel-side `platform_tx_bound_event` the §A.3
--       correspondence names — the STABLE read U2's bundle seals and U3's audit-less claimants
--       (the two consultation facts and the `countersign_rejection` request) call to bind an
--       event to the actor its fact records. It is installed FIRST so both later units witness
--       it; nothing calls it yet, so it is inert until they do.
--
--   (2) THE DORMANT ACTOR SEAL. `DomainEvent_t4d_pairing_actor` — the converse companion of
--       4d-i's kernel `DomainEvent_t4d_pairing_claimed`, owned by the KERNEL and driven by the
--       CATALOG the same way: it reads the event's OWN catalog row by its full key
--       `(coverageVersion, effectKey)` from `dispatchIntent`, and if that row is not
--       `pairingRequired` it RETURNS NULL. So over 4d-i's two generations — every row `false` —
--       it never fires. The moment a generation carries the flag (U3), it refuses a
--       `pairingRequired` event whose envelope is not a named human: `actorKind = 'human'` with a
--       non-null `actorId`. That is the round-4 defect closed at the event boundary itself — a
--       current-generation `system` event with `actorId = NULL` beside a fact approved by a real
--       user is refused HERE, not left to each claimant to catch.
--
--       STRICT, not NULL-tolerant, by construction: every writer of a paired event
--       (4c-ii's and later) emits a `human` event whose `actorId` is the acting user; a `system`
--       event announcing an ask, an answer, an approval or a disagreement is not a shape any
--       release produces. The seal's bypass points are declared by name where they live — the
--       seed's DL-003 plant and the test harnesses arrive with U3's flip, since only a flagged
--       generation makes this seal observable; under U1 it is dark and needs none.
--
-- WHAT IS NOT HERE, by the U1/U2/U3 ordering:
--   · the change-request bundle seals and the transition recorders — U2;
--   · the flip (the new `ExternalEffectCatalog` generation and its `canonicalCatalog()`
--     preimage), every claimant, and the full 51-case matrix — U3, together.
--   It adds no table and no column. Its one trigger is over `DomainEvent`, which 4d-i shaped.
--
-- PERMANENT and driven by the catalog, so it is never skipped on a retired database and needs no
-- retirement snapshot: a retired generation still resolves for history, and this seal reads the
-- generation the event NAMES. RE-RUNNABLE (`CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`).

BEGIN;

-- ── THE DEPLOYMENT WINDOW, ALL-OR-NOTHING, BEFORE ANYTHING ELSE ─────────────────────────────
-- The shape both 4d-i halves take (#582's rounds 8, 36 and 37): every PRE-EXISTING table this
-- file takes a lock on, in ONE `NOWAIT` acquisition inside a subtransaction, so a partial set is
-- released by the exception rollback, retried, and after the cap the migration FAILS CLOSED —
-- clean and re-runnable. This transaction is then never a waiting party on the table, so it
-- cannot be one side of a deadlock with a serving `emitEvent`, whatever order that command locks.
--
-- The set is derived from this file's own DDL: the ONE table that gains a trigger below is
-- `DomainEvent`. The primitive functions add no trigger and lock nothing.
DO $t4dib_u1_window$
DECLARE attempts INT := 0;
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "DomainEvent" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 600 THEN
        RAISE EXCEPTION 'phase6 4d-i-b U1: could not obtain the deployment window on "DomainEvent" after % attempts — retry the deploy when writer traffic quiets. Nothing has been changed. See docs/RUNBOOK.md §P6T4D.', attempts;
      END IF;
      PERFORM pg_sleep(0.2);
    END;
  END LOOP;
END $t4dib_u1_window$;


-- ── THE PREREQUISITE IS 4d-i's CATALOG, AND IT IS VERIFIED, NOT ASSUMED ─────────────────────
-- The actor seal reads `ExternalEffectCatalog`, which 4d-i's dark migration creates. A plpgsql body
-- is not validated at CREATE time, so without the catalog the trigger would break the FIRST real
-- DomainEvent insert in production rather than here; a database without it is NAMED. It is the ONE
-- object this unit needs — deliberately NOT the sibling `platform_t4d_event_pairing_claimed` seal,
-- which the seal-stripped harness omits while this file must still apply — so the check is the
-- table alone (a present catalog is all this seal reads).
DO $t4dib_u1_prereq$
BEGIN
  IF to_regclass('"ExternalEffectCatalog"') IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i-b U1 ABORT: this unit installs a catalog-driven seal that reads "ExternalEffectCatalog", which this database does not hold. 4d-i''s dark migration (20271220000000) creates it and applies before this file; on the db-push / P3005 baseline path `scripts/migrate.sh` EXECUTES 4d-i from ALWAYS_EXECUTE for exactly this reason. Apply it first. See docs/RUNBOOK.md §P6T4D.';
  END IF;
END $t4dib_u1_prereq$;


-- ════════════════════════════════════════════════════════════════════════════════════════════
-- (1) THE BOUND-EVENT PRIMITIVE — the event bound to the ACTOR the fact records
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- One act has one actor. The fact names who performed it (`requestedById`, `respondedById`,
-- `approvedById`, `resolvedById`); the event's envelope names who is announced as performing it
-- (`actorId`). The branches that carry NO `DecisionEvent` audit row by the delivered contract
-- (the two consultation facts; the `countersign_rejection` request) are judged by nobody in
-- 4d-i's `DecisionEvent_t4d_correspondence`, so their own claimants (U3) ask through this — the
-- kernel's `platform_tx_event` / `platform_tx_event_count` narrowed to one actor. STABLE reads,
-- scoped to THIS transaction's rows, so an earlier transaction's event is never mistaken for one
-- this bundle produced.
CREATE OR REPLACE FUNCTION phase6_t4d_tx_actor_event(
  p_project TEXT, p_decision TEXT, p_types TEXT[], p_actor TEXT
) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT e."eventId" FROM "DomainEvent" e
   WHERE e."projectId" = p_project
     AND e."entityType" = 'Decision' AND e."entityId" = p_decision
     AND e."eventType" = ANY (p_types)
     AND e."actorId" = p_actor
     AND e."xmin" = txid_current()::text::xid
   ORDER BY e."streamPosition" DESC
   LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION phase6_t4d_tx_actor_event_count(
  p_project TEXT, p_decision TEXT, p_types TEXT[], p_actor TEXT
) RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM "DomainEvent" e
   WHERE e."projectId" = p_project
     AND e."entityType" = 'Decision' AND e."entityId" = p_decision
     AND e."eventType" = ANY (p_types)
     AND e."actorId" = p_actor
     AND e."xmin" = txid_current()::text::xid;
$$;


-- ════════════════════════════════════════════════════════════════════════════════════════════
-- (2) THE DORMANT ACTOR SEAL — a pairingRequired event is a NAMED human act
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The converse companion of 4d-i's `DomainEvent_t4d_pairing_claimed`: that seal says a
-- `pairingRequired` event must be CLAIMED by a fact; this one says the same event must NAME the
-- human who acted. Owned by the KERNEL and driven by the CATALOG, so no peer module installs a
-- trigger on the kernel's table (#568's review round 1, finding 2) — this is the kernel's own
-- companion, installed beside the claim seal it mirrors.
--
-- THE EVENT'S OWN CATALOG ROW, by its full key `(coverageVersion, effectKey)` (#582 round 2,
-- finding 4): the primary key reads at most one row, needs no ordering, and is NOT filtered by
-- `retiredAt` — the row the event NAMES is the policy that governed it when emitted. If that row
-- is not `pairingRequired`, the seal RETURNS NULL. Over 4d-i's two generations every row is
-- `false`, so this seal is DARK until U3 seeds a generation that flips the six decision types;
-- a legacy event carrying no intent resolves both keys to NULL, matches nothing, and is admitted.
CREATE OR REPLACE FUNCTION platform_t4d_event_pairing_actor() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_required BOOLEAN;
BEGIN
  SELECT c."pairingRequired" INTO v_required
    FROM "ExternalEffectCatalog" c
   WHERE c."coverageVersion" = NEW."dispatchIntent" ->> 'coverageVersion'
     AND c."effectKey"       = NEW."dispatchIntent" ->> 'effectKey';
  IF v_required IS DISTINCT FROM TRUE THEN RETURN NULL; END IF;

  -- A paired event records one person's act; its envelope must name that person. A `system`
  -- announcement with `actorId = NULL` is exactly the shape the round-4 defect let commit beside
  -- a fact approved by a real user.
  IF NEW."actorKind" IS DISTINCT FROM 'human' OR NEW."actorId" IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-i-b: event % of type `%` is pairingRequired but is attributed to actorKind=% / actorId=% — a paired event records one person''s act and its envelope must name a human actor, never a system announcement with no actor',
      NEW."eventId", NEW."eventType", COALESCE(NEW."actorKind", '<null>'), COALESCE(NEW."actorId", '<null>');
  END IF;
  RETURN NULL;
END $$;

-- IMMEDIATE — a NOT-DEFERRABLE constraint trigger, beside `DomainEvent_t4d_pairing_claimed` but
-- unlike it. The two columns it judges are the event's OWN, frozen at INSERT (the envelope seal and
-- the append-only trigger forbid changing them later), so it needs nothing a later statement writes
-- and is checked at the END OF THE INSERT STATEMENT, never deferred to commit. `pairing_claimed`
-- IS deferred because THAT seal waits on a fact written later; this one does not. Firing immediately
-- also means it leaves no pending trigger event, so a legacy-shape plant that disables the deferred
-- DomainEvent seals by name and re-enables them mid-transaction is not blocked by this one — it is
-- dark for a pre-4d shape anyway (no pairingRequired row backs it), so it needs no place in that
-- bypass. Round-4's claimed-`system`-event shape is refused here at INSERT; the reproduce-first
-- proof shows a claimed system event committing only once this seal is dropped.
DROP TRIGGER IF EXISTS "DomainEvent_t4d_pairing_actor" ON "DomainEvent";
CREATE CONSTRAINT TRIGGER "DomainEvent_t4d_pairing_actor"
  AFTER INSERT ON "DomainEvent"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_event_pairing_actor();

COMMIT;
