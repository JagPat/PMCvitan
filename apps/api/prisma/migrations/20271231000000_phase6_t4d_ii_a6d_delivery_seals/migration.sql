-- Phase 6 task 4d unit 4d-ii-a / A6d — the DELIVERY ROWS and their SEALS (the 4d plan
-- `2026-09-07-decision-workflow-4d.md`, §A.3 obligation 7 — "the event's DELIVERY OBLIGATIONS are
-- demanded in the authorizing transaction, never deferred to a background pass", "The rows are a
-- pure function of the event and the persisted catalog, so EVERY emitter writes the same rows",
-- "BOTH halves are taken in the DATABASE, by the seals, not by the callers").
--
-- WHAT THIS FILE INSTALLS. Three seals and the two functions they judge by:
--
--   platform_t4d_delivery_action(rule, types, eventType, intent) — THE derivation. One SQL function,
--     the persisted rule applied to an event: `all` dispatches every event; `invalidate` dispatches
--     iff the intent's `invalidate` is true; `push` dispatches iff the intent carries a push WITH a
--     body (#661's review round 1, finding 2: an intent carrying `push: { body: '' }` is a no-op);
--     `types` dispatches iff the event's type is in the row's `subscribedEventTypes`. NULL for a row
--     with no rule (nothing derives). The TypeScript `dispatchActionFor` is its mirror, and the live
--     suite holds the two equal over the closed event list and every intent shape.
--   platform_t4d_push_payload(intent) — THE projection of a push-bearing intent into a delivery's
--     payload: `{body, roles, targetUserId}` (null-coalesced, the shape the previous release wrote)
--     plus `targetUserIds` as the canonical SORTED, DISTINCT array where the intent carries one and
--     absent where it does not. NULL when the intent carries no push body.
--
--   `DomainEvent_t4d_deliveries` (DEFERRED constraint trigger, AFTER INSERT) — the OBLIGATION: at
--     commit, for every catalog row that is ACTIVE and carries a rule, exactly one delivery row for
--     the new event whose action is what the rule derives. A bundle without its rows is refused at
--     commit, naming the consumer and the rule. It takes the registration key SHARED at the head of
--     its body — the SHARE half of A6c's barrier, taken by the SEAL so a direct writer that never
--     calls the platform's helper is serialized against a registration exactly as the emitter is
--     (#572's review round 26, finding 1) — and then locks EVERY catalog row `FOR SHARE`, active or
--     not, before it filters (#567's round 1, finding 3: an unlocked inactive row could be flipped
--     and committed between the event's read and its commit). A row carrying NO rule (a consumer no
--     migration knew: planted history) is owed nothing, because nothing derives for it; a row whose
--     consumer DEACTIVATED after the emitter's read is admitted — the seal REQUIRES rows for the
--     active set, it never forbids one.
--   `OutboxDelivery_t4d_bound` (BEFORE INSERT) — EVERY row, whatever its consumer's activation
--     state, carries the action its consumer's persisted rule derives for its event (#563's round 1,
--     finding 3); a row for a rule-less consumer is refused (it derives from nothing); a `dispatch`
--     row of a `push`-rule consumer carries exactly the projection above and `subject = entityId`
--     (#560's round 1, findings 4 and 6: a correctly sealed event could carry a delivery rewritten to
--     one chosen architect or a foreign body); a `noop` row of that consumer carries no payload; a
--     row of any other rule carries neither payload nor subject. One row is admitted with an action
--     the rule does not derive: a `noop` BORN CANCELLED (`cancelledAt` set, `succeeded`) for an event
--     whose rule derives `dispatch` — the 4a recovery-gap tombstone, which `cancelQueuedPushBySubject`
--     writes so a later expansion finds the row present and materializes no stale push.
--   `OutboxDelivery_t4d_frozen` (BEFORE UPDATE) — `id`, `eventId`, `projectId`, `streamPosition`,
--     `consumer`, `consumerKind` and `payload` never move; `subject` moves only NULL → the row's own
--     event's `entityId` (the 4a subject stamp for a row an old instance wrote subjectless);
--     `deliveryAction` moves only `dispatch → noop`, and only through the transitions the delivered
--     code performs — the 4a cancellation MARK (`cancelledAt` set in the same statement, payload
--     preserved), the leased-cancel COMPLETION (a row whose mark is already set), and the LEGACY
--     neutralization (the event carries no intent, or an intent no unretired catalog row backs — a
--     pre-intent or pre-cutover event with nothing to send, which `dispatchExternal` and the cutover
--     seal retire; #562's round 2, finding 5); `cancelledAt` moves only NULL → a timestamp, never
--     cleared and never rewritten (#561's round 1, finding 4). `status`, `attempts`, `nextAttemptAt`,
--     `leaseOwner`, `leaseExpiresAt`, `lastError` and `updatedAt` stay the operationally mutable set.
--
-- WHY THE SEALS JUDGE BY THE PERSISTED RULE. A trigger cannot read a TypeScript function, so the
-- obligation is judged against the rule the catalog row carries (A6c), and a process that booted no
-- registry — a standalone CLI, a hand-run bundle — writes the same rows a booted API does, because
-- the rows are a function of the event and the catalog and of nothing process-local.
--
-- RE-RUNNABLE (on `ALWAYS_EXECUTE`): `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`. No
-- column, no data change: the three seals judge writes from the moment they exist and rewrite no
-- row that already exists.

-- ── 1. the derivation and the projection ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_delivery_action(p_rule TEXT, p_types TEXT[], p_event_type TEXT, p_intent JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_rule
    WHEN 'all'        THEN 'dispatch'
    WHEN 'invalidate' THEN CASE WHEN p_intent -> 'invalidate' = 'true'::jsonb THEN 'dispatch' ELSE 'noop' END
    WHEN 'push'       THEN CASE WHEN coalesce(p_intent -> 'push' ->> 'body', '') <> '' THEN 'dispatch' ELSE 'noop' END
    WHEN 'types'      THEN CASE WHEN p_event_type = ANY (coalesce(p_types, ARRAY[]::TEXT[])) THEN 'dispatch' ELSE 'noop' END
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION platform_t4d_push_payload(p_intent JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN coalesce(p_intent -> 'push' ->> 'body', '') = '' THEN NULL ELSE
    jsonb_build_object(
      'body',         p_intent -> 'push' -> 'body',
      'roles',        coalesce(p_intent -> 'push' -> 'roles', 'null'::jsonb),
      'targetUserId', coalesce(p_intent -> 'push' -> 'targetUserId', 'null'::jsonb))
    || CASE WHEN jsonb_typeof(p_intent -> 'push' -> 'targetUserIds') = 'array'
         -- canonical: distinct, sorted by code unit (the order the TypeScript projection sorts in)
         THEN jsonb_build_object('targetUserIds', (
                SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u COLLATE "C"), '[]'::jsonb)
                  FROM (SELECT DISTINCT value #>> '{}' AS u FROM jsonb_array_elements(p_intent -> 'push' -> 'targetUserIds')) s))
         ELSE '{}'::jsonb
       END
  END
$$;

-- ── 2. the obligation: DomainEvent_t4d_deliveries (deferred) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_event_deliveries() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  v_action TEXT;
  v_row RECORD;
BEGIN
  -- the SHARE half of the registration barrier, taken by the seal for every writer: a registration
  -- (which takes the key EXCLUSIVE on its INSERT) is serialized against every in-flight event, while
  -- events never serialize against each other; the lock is reentrant, so an emitter that took it
  -- early re-acquires for free. Taken BEFORE the catalog rows, so the order is key -> rows, one way.
  PERFORM pg_advisory_xact_lock_shared(hashtext('OutboxConsumerCatalog:registration'));
  -- EVERY catalog row locked FOR SHARE — active and inactive alike — before the active filter: an
  -- activation's FOR UPDATE either committed before this read or waits for this commit.
  FOR r IN SELECT c."consumer", c."active", c."dispatchRule", c."subscribedEventTypes"
             FROM "OutboxConsumerCatalog" c ORDER BY c."consumer" FOR SHARE
  LOOP
    -- inactive: nothing is owed. No rule: nothing derives, so nothing is owed — a row no migration
    -- knew (planted history); a compiled consumer meeting it is refused at startup by name (A6c).
    IF NOT r."active" OR r."dispatchRule" IS NULL THEN CONTINUE; END IF;
    v_action := platform_t4d_delivery_action(r."dispatchRule", r."subscribedEventTypes", NEW."eventType", NEW."dispatchIntent");
    -- the row must be THIS transaction's: a delivery names its event through the composite FK, and
    -- an event this transaction inserted is visible to no other, so any row that exists is ours
    SELECT d."deliveryAction", d."cancelledAt" INTO v_row
      FROM "OutboxDelivery" d WHERE d."eventId" = NEW."eventId" AND d."consumer" = r."consumer";
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-ii: event % (type `%`) owes consumer "%" a delivery row — its catalog row is ACTIVE and carries rule % — and none was written in this transaction. An event''s delivery obligations are demanded in the authorizing transaction, never left to a background pass: the row set is `deliveryRowsFor(event, catalog)`, a function of the event and the persisted catalog alone (4d plan §A.3 obligation 7; #558 round 1, finding 7).',
        NEW."eventId", NEW."eventType", r."consumer", r."dispatchRule";
    END IF;
    IF v_row."deliveryAction" IS DISTINCT FROM v_action
       AND NOT (v_action = 'dispatch' AND v_row."deliveryAction" = 'noop' AND v_row."cancelledAt" IS NOT NULL) THEN
      RAISE EXCEPTION
        'phase6 4d-ii: event % (type `%`) carries a delivery row for consumer "%" whose action is `%`, but the row''s persisted rule % derives `%` for this event (4d plan §A.3 obligation 7).',
        NEW."eventId", NEW."eventType", r."consumer", v_row."deliveryAction", r."dispatchRule", v_action;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DomainEvent_t4d_deliveries" ON "DomainEvent";
CREATE CONSTRAINT TRIGGER "DomainEvent_t4d_deliveries"
  AFTER INSERT ON "DomainEvent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_event_deliveries();

-- ── 3. the binding: OutboxDelivery_t4d_bound (BEFORE INSERT) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_delivery_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_rule TEXT;
  v_types TEXT[];
  v_known BOOLEAN := false;
  v_event_type TEXT;
  v_intent JSONB;
  v_entity TEXT;
  v_action TEXT;
  v_payload JSONB;
BEGIN
  SELECT c."dispatchRule", c."subscribedEventTypes", true INTO v_rule, v_types, v_known
    FROM "OutboxConsumerCatalog" c WHERE c."consumer" = NEW."consumer";
  -- an undeclared consumer is the composite FK's refusal, by name; this seal judges declared ones
  IF NOT v_known THEN RETURN NEW; END IF;
  IF v_rule IS NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii: consumer "%" carries NO persisted dispatch rule (a row no catalog-data migration knew), so no delivery action derives for it and this row for event % is refused — a delivery is judged against its consumer''s rule, and a row that derives from nothing cannot be judged (4d plan §A.3 obligation 7).',
      NEW."consumer", NEW."eventId";
  END IF;
  SELECT e."eventType", e."dispatchIntent", e."entityId" INTO v_event_type, v_intent, v_entity
    FROM "DomainEvent" e WHERE e."eventId" = NEW."eventId";
  -- a delivery for no event is the composite FK's refusal
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_action := platform_t4d_delivery_action(v_rule, v_types, v_event_type, v_intent);
  IF NEW."deliveryAction" IS DISTINCT FROM v_action
     -- born cancelled: the 4a recovery-gap tombstone — `noop`, marked, done, for an event whose rule
     -- derives `dispatch`; it exists so a later expansion finds the row present and writes no stale push
     AND NOT (v_action = 'dispatch' AND NEW."deliveryAction" = 'noop' AND NEW."cancelledAt" IS NOT NULL AND NEW."status" = 'succeeded') THEN
    RAISE EXCEPTION
      'phase6 4d-ii: delivery for consumer "%" of event % (type `%`) carries action `%`, but the consumer''s persisted rule % derives `%` for this event — every delivery row, active consumer or not, carries the action its rule derives (4d plan §A.3 obligation 7; #563 round 1, finding 3).',
      NEW."consumer", NEW."eventId", v_event_type, NEW."deliveryAction", v_rule, v_action;
  END IF;

  IF v_rule = 'push' THEN
    IF NEW."deliveryAction" = 'dispatch' THEN
      v_payload := platform_t4d_push_payload(v_intent);
      IF NEW."payload" IS NULL OR jsonb_typeof(NEW."payload") <> 'object'
         OR NEW."payload" -> 'body' IS DISTINCT FROM v_payload -> 'body'
         OR coalesce(NEW."payload" -> 'roles', 'null'::jsonb) IS DISTINCT FROM v_payload -> 'roles'
         OR coalesce(NEW."payload" -> 'targetUserId', 'null'::jsonb) IS DISTINCT FROM v_payload -> 'targetUserId'
         OR (v_payload ? 'targetUserIds' AND NEW."payload" -> 'targetUserIds' IS DISTINCT FROM v_payload -> 'targetUserIds')
         OR (NOT v_payload ? 'targetUserIds' AND NEW."payload" ? 'targetUserIds')
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW."payload") k WHERE k NOT IN ('body', 'roles', 'targetUserId', 'targetUserIds')) THEN
        RAISE EXCEPTION
          'phase6 4d-ii: the push delivery for event % carries a payload that is not the PROJECTION of the event''s immutable intent — expected % (body, roles, targetUserId, and targetUserIds as the sorted distinct array where the intent carries one), got %. A delivery''s payload is the platform''s projection of the intent, never a body or an audience of the writer''s choosing (4d plan §A.3 obligation 7; #560 round 1, finding 6).',
          NEW."eventId", v_payload, NEW."payload";
      END IF;
      IF NEW."subject" IS DISTINCT FROM v_entity THEN
        RAISE EXCEPTION
          'phase6 4d-ii: the push delivery for event % carries subject % but the event is about entity % — a push delivery''s subject is its event''s entityId, the key a cancellation targets (4d plan §A.3 obligation 7; Phase 6 task 4a).',
          NEW."eventId", coalesce(NEW."subject", '<null>'), v_entity;
      END IF;
    ELSE
      -- a no-op push row was never built a body; the tombstone carries the subject it was cancelled by
      IF NEW."payload" IS NOT NULL OR (NEW."subject" IS NOT NULL AND NEW."subject" <> v_entity) THEN
        RAISE EXCEPTION
          'phase6 4d-ii: the no-op push delivery for event % carries a payload or a foreign subject — a row that dispatches nothing carries no body, and a subject only its own event''s entityId (4d plan §A.3 obligation 7).',
          NEW."eventId";
      END IF;
    END IF;
  ELSIF NEW."payload" IS NOT NULL OR NEW."subject" IS NOT NULL THEN
    RAISE EXCEPTION
      'phase6 4d-ii: the delivery for consumer "%" (rule %) of event % carries a payload or a subject — only a push-rule delivery projects the intent; the socket and the ordered consumers read the event by position (4d plan §A.3 obligation 7).',
      NEW."consumer", v_rule, NEW."eventId";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxDelivery_t4d_bound" ON "OutboxDelivery";
CREATE TRIGGER "OutboxDelivery_t4d_bound" BEFORE INSERT ON "OutboxDelivery"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_delivery_bound();

-- ── 4. the freeze: OutboxDelivery_t4d_frozen (BEFORE UPDATE) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform_t4d_delivery_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_entity TEXT;
  v_legacy BOOLEAN;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
     OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."streamPosition" IS DISTINCT FROM OLD."streamPosition"
     OR NEW."consumer" IS DISTINCT FROM OLD."consumer"
     OR NEW."consumerKind" IS DISTINCT FROM OLD."consumerKind"
     OR NEW."payload" IS DISTINCT FROM OLD."payload" THEN
    RAISE EXCEPTION
      'phase6 4d-ii: "OutboxDelivery" % (consumer "%", event %) — its identity and its payload are FROZEN: eventId, projectId, streamPosition, consumer, consumerKind and payload never move after insert. The payload is the projection of an immutable intent; a neutralized row keeps it for audit (4d plan §A.3 obligation 7; #560 round 1, finding 6).',
      OLD."id", OLD."consumer", OLD."eventId";
  END IF;

  IF NEW."subject" IS DISTINCT FROM OLD."subject" THEN
    -- the one admitted move: the 4a stamp — a row an old instance wrote subjectless takes its OWN
    -- event's entityId, copied, never invented, and never rewritten once set
    SELECT e."entityId" INTO v_entity FROM "DomainEvent" e WHERE e."eventId" = OLD."eventId";
    IF NOT (OLD."subject" IS NULL AND NEW."subject" = v_entity) THEN
      RAISE EXCEPTION
        'phase6 4d-ii: "OutboxDelivery" % (consumer "%") — subject may move only from NULL to the row''s own event''s entityId (%), never to % (4d plan §A.3 obligation 7; Phase 6 task 4a round 4).',
        OLD."id", OLD."consumer", v_entity, coalesce(NEW."subject", '<null>');
    END IF;
  END IF;

  IF NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" THEN
    IF OLD."cancelledAt" IS NOT NULL OR NEW."cancelledAt" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-ii: "OutboxDelivery" % (consumer "%") — the cancellation mark is written once, NULL -> a timestamp, and is never cleared or rewritten: a cleared mark would resurrect a stale announcement on the next redrive (4d plan §A.3 obligation 7; #561 round 1, finding 4).',
        OLD."id", OLD."consumer";
    END IF;
  END IF;

  IF NEW."deliveryAction" IS DISTINCT FROM OLD."deliveryAction" THEN
    IF NOT (OLD."deliveryAction" = 'dispatch' AND NEW."deliveryAction" = 'noop') THEN
      RAISE EXCEPTION
        'phase6 4d-ii: "OutboxDelivery" % (consumer "%") — deliveryAction moves only dispatch -> noop, never % -> % (4d plan §A.3 obligation 7).',
        OLD."id", OLD."consumer", OLD."deliveryAction", NEW."deliveryAction";
    END IF;
    -- the LEGACY neutralization: the event carries no intent, or an intent no unretired catalog row
    -- backs — a pre-intent or pre-cutover event with nothing to send
    SELECT e."dispatchIntent" IS NULL
           OR NOT EXISTS (SELECT 1 FROM "ExternalEffectCatalog" c
                           WHERE c."coverageVersion" = e."dispatchIntent" ->> 'coverageVersion'
                             AND c."effectKey" = e."dispatchIntent" ->> 'effectKey'
                             AND c."retiredAt" IS NULL)
      INTO v_legacy
      FROM "DomainEvent" e WHERE e."eventId" = OLD."eventId";
    IF NOT (
         (OLD."cancelledAt" IS NULL AND NEW."cancelledAt" IS NOT NULL)  -- the MARK, in its own statement
      OR OLD."cancelledAt" IS NOT NULL                                   -- the COMPLETION of a row already marked
      OR coalesce(v_legacy, false)                                       -- the LEGACY neutralization
    ) THEN
      RAISE EXCEPTION
        'phase6 4d-ii: "OutboxDelivery" % (consumer "%", event %) — dispatch -> noop is admitted only as the cancellation MARK (cancelledAt set in this statement), the COMPLETION of a row already marked, or the LEGACY neutralization of an event with no current intent; this UPDATE is none of them (4d plan §A.3 obligation 7; #562 round 2, finding 5).',
        OLD."id", OLD."consumer", OLD."eventId";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "OutboxDelivery_t4d_frozen" ON "OutboxDelivery";
CREATE TRIGGER "OutboxDelivery_t4d_frozen" BEFORE UPDATE ON "OutboxDelivery"
  FOR EACH ROW EXECUTE FUNCTION platform_t4d_delivery_frozen();
