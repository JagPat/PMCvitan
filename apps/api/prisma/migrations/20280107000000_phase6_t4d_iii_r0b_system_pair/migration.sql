-- Phase 6 task 4d-iii / R0b — THE SYSTEM PAIR, ADMITTED; AND THE LEASE RECORDS ITS BUILD'S GENERATION
-- (the staging record `docs/superpowers/plans/2026-10-05-4d-iii-additive-units.md`, R0, the R0b bullet;
-- the Board's Decision 1 of 2026-10-05: every event is attributed — system events record a system role
-- plus a NAMED AUTOMATION IDENTITY).
--
-- WHAT THIS FILE DOES. It ADMITS; it requires nothing, so every delivered writer still commits.
--
--   1. THE REGISTERED AUTOMATION IDENTITIES. `platform_t4d_automation_identity(name)` is the CLOSED set
--      of names a `system` event's pair may carry: `decisions-effects` (the effects processor),
--      `commercial-activation` and `commercial-reevaluate` (the two operator paths). A new automation
--      means a new migration re-issuing this function.
--
--   2. THE EVENT ENVELOPE, RE-ISSUED with its two system arms changed (#714's review, Codex 4181088585
--      and 4181420109); every other clause is 4d-i's (`20271220000000`), byte for byte:
--      - the non-`human` refusal now admits, on a `system` actor only, the pair (`system`, a registered
--        name) beside a nonblank `systemActor`, and refuses every other non-human pair as before;
--      - the `actorId IS NULL` refusal and `phase6_t4d_actor_pair_true` apply to `human` envelopes only,
--        exactly as before. A `system` envelope is judged by its pair alone, never against `actorId`,
--        which `emitEvent` writes NULL for a system actor (its identity is in `systemActor`).
--      The pair NAMES THE AUTOMATION; `systemActor` keeps recording who or what triggered it, and the two
--      are not required to match (#714's review, Codex 4181468551): the operator-backed emitters write
--      the resolved operator's user id as `systemActor` and a FIXED registered name as the pair.
--
--   3. `ReleaseLease.serverGeneration`, nullable, with its `schema.prisma` field (#714's review, Codex
--      4181245450). The delivered `writeLease` names its INSERT columns, so it keeps committing and writes
--      NULL; R0c's writer records the compiled `SERVER_GENERATION`. R1–R3's serialized preflights then
--      refuse while any LIVE lease has `serverGeneration IS NULL OR serverGeneration < 3`.
--
--   4. THE LEASE FREEZE, RE-ISSUED to hold `serverGeneration` with the rest of the lease's identity
--      (#714's review, Codex 4181420100), so a live pre-R0c lease cannot be re-stamped NULL → 3 (or
--      2 → 3) to pass those preflights. Every other clause is 4d-i's, byte for byte.
--
-- RE-RUNNABLE, AND ON `ALWAYS_EXECUTE` (the staging record's registration rule). Every statement is
-- `CREATE OR REPLACE` or `IF NOT EXISTS`. It is NOT gated on the retirement marker: no later unit of this
-- staging re-issues either function (R4 drops doors and installs other bodies, and its closing check
-- requires this file's arm by name), so on every replay this is the definition that must stand. A later
-- unit that re-issues either function sorts after this file and must carry both arms forward.

CREATE OR REPLACE FUNCTION platform_t4d_automation_identity(p_name TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_name IN ('decisions-effects', 'commercial-activation', 'commercial-reevaluate');
$$;

CREATE OR REPLACE FUNCTION platform_t4d_event_envelope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_next BIGINT; v_allocated_here BOOLEAN;
  v_key TEXT; v_version TEXT; v_cat RECORD;
  v_push JSONB; v_roles TEXT[]; v_ceiling TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- (a) THE POSITION, and that THIS transaction allocated it (§A.2; Codex round 1, finding 3).
    -- The first version of this seal judged the actor pair alone, so a direct insert could write
    -- an otherwise-valid event at an arbitrary position without touching `ProjectEventStream`.
    -- No allocator trigger fires for that, the corrupt event commits, and the abort lands on the
    -- NEXT ordinary emit — in another transaction, naming neither the writer nor the row.
    --
    -- `emitEvent` follows increment-then-insert, so the event it is writing sits at
    -- `nextPosition - 1` of a stream row this transaction just moved. A writer that skips the
    -- increment lands on `nextPosition` (refused here) or on a taken position (refused by the
    -- `(projectId, streamPosition)` unique); a writer that increments once and inserts twice has
    -- its second insert refused. With `_t4d_allocation_bound` requiring the converse — every
    -- increment carries its event — allocations and events are one-to-one.
    SELECT s."nextPosition", s."xmin" = txid_current()::text::xid
      INTO v_next, v_allocated_here
      FROM "ProjectEventStream" s WHERE s."projectId" = NEW."projectId";
    IF v_next IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: project % has no event-stream allocator, so event % has no issued position to sit at',
        NEW."projectId", NEW."eventId";
    END IF;
    IF NEW."streamPosition" <> v_next - 1 OR NOT COALESCE(v_allocated_here, FALSE) THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % sits at position % but this transaction did not allocate it (the allocator for project % stands at %, moved here: %) — a position is taken by incrementing the allocator in the SAME transaction that writes the event, never chosen',
        NEW."eventId", NEW."streamPosition", NEW."projectId", v_next, COALESCE(v_allocated_here, FALSE);
    END IF;

    -- (b) THE INTENT, judged against the PERSISTED catalog (§A.2 (b); #582 round 2, finding 1).
    -- The first version of this seal stopped after the allocation and the actor pair, so the
    -- ONE thing the catalog rows exist to make askable was never asked: a direct insert could
    -- commit an unknown or retired coverage version, flip `invalidate` off so no consumer ever
    -- refreshed, or persist a forged push audience — and the relay's `expandMissingDeliveries`
    -- rebuilds from exactly this immutable intent, so the forgery survives every replay.
    --
    -- FOR SHARE, not a bare read (plan line 5104): the gated retirement stamp takes `FOR UPDATE`
    -- on the same row, so the two order deterministically and an event cannot commit on an
    -- intent that was retired between this check and its commit. Share locks do not conflict
    -- with each other, so concurrent emits of the same key do not serialize behind one another.
    IF NEW."dispatchIntent" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries no dispatchIntent — every event names the catalog entry that decides its external consequence, and an intent-less event is one the relay would have to guess about',
        NEW."eventId";
    END IF;
    v_key     := NEW."dispatchIntent" ->> 'effectKey';
    v_version := NEW."dispatchIntent" ->> 'coverageVersion';
    IF v_key IS NULL OR v_version IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries an intent naming effectKey % at coverageVersion % — both halves of the catalog key are required, because the key alone does not identify a definition through the drain',
        NEW."eventId", COALESCE(v_key, '<null>'), COALESCE(v_version, '<null>');
    END IF;

    SELECT c."eventType", c."invalidate", c."pushRoles", c."requiresPush", c."audience", c."retiredAt"
      INTO v_cat
      FROM "ExternalEffectCatalog" c
     WHERE c."coverageVersion" = v_version AND c."effectKey" = v_key
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % names catalog entry (%, %), which this database does not hold — an intent the seals cannot resolve is an external consequence nobody approved',
        NEW."eventId", v_version, v_key;
    END IF;
    IF v_cat."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % names catalog entry (%, %), retired at % — a retired definition still resolves for HISTORY, and may not back a new event',
        NEW."eventId", v_version, v_key, v_cat."retiredAt";
    END IF;
    IF v_cat."eventType" <> NEW."eventType" THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % is of type `%` but names catalog entry (%, %), which is declared for `%` — an effect key is per command BRANCH, and a branch cannot be borrowed by another type',
        NEW."eventId", NEW."eventType", v_version, v_key, v_cat."eventType";
    END IF;
    IF (NEW."dispatchIntent" ->> 'invalidate')
       IS DISTINCT FROM (CASE WHEN v_cat."invalidate" THEN 'true' ELSE 'false' END) THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % claims invalidate=% while catalog entry (%, %) declares % — suppressing the invalidation leaves every open surface showing the state before this act',
        NEW."eventId", COALESCE(NEW."dispatchIntent" ->> 'invalidate', '<absent>'), v_version, v_key,
        CASE WHEN v_cat."invalidate" THEN 'true' ELSE 'false' END;
    END IF;

    -- THE PUSH SHAPE. `pushRoles` is the CEILING a key may ever reach; `requiresPush` says the
    -- delivered branch ALWAYS announces, so a hand-run writer cannot seal a silent event where
    -- the service always speaks; `audience` says which shape is owed.
    v_push := NEW."dispatchIntent" -> 'push';
    IF v_push IS NOT NULL AND jsonb_typeof(v_push) <> 'object' THEN
      RAISE EXCEPTION
        'phase6 4d-i: the push of event % is a % — a push is an object of body, roles and an optional target',
        NEW."eventId", jsonb_typeof(v_push);
    END IF;
    IF v_push IS NOT NULL AND v_cat."pushRoles" IS NULL THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries a push, but catalog entry (%, %) declares no push audience at all — an announcement nobody approved is an audience invented at the write',
        NEW."eventId", v_version, v_key;
    END IF;
    IF v_push IS NULL AND v_cat."requiresPush" THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries no push, but catalog entry (%, %) declares that this branch always announces — a silent write of an act the service announces is a suppressed notice',
        NEW."eventId", v_version, v_key;
    END IF;
    IF v_push IS NOT NULL THEN
      -- THE BODY IS A NONBLANK STRING (#582 round 5, finding 1). Requiring only that `push` be an
      -- object let `{push: {body: '', roles: <the whole ceiling>}}` satisfy every clause below —
      -- and `deliveryFor` (`outbox/consumers.ts`) reads a falsy body as a `noop`, so the delivered
      -- service SILENTLY declines to announce an event the catalog says always announces. That is
      -- the exact hole `requiresPush` exists to close, reached through the body rather than
      -- through the flag: an empty string is not a quiet announcement, it is no announcement at
      -- all, and it must be refused where the intent is judged rather than discovered downstream.
      IF jsonb_typeof(v_push -> 'body') IS DISTINCT FROM 'string'
         OR btrim(v_push ->> 'body', E' \t\n\x0B\f\r') = '' THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % carries body % — a push announces, so its body is a NONBLANK string; a missing or empty one is read as a `noop` by the delivered consumer and the announcement the catalog owes never happens',
          NEW."eventId", COALESCE(jsonb_typeof(v_push -> 'body'), '<absent>');
      END IF;
      IF jsonb_typeof(v_push -> 'roles') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % names roles as % — the audience is an array, and an absent one is not an empty one',
          NEW."eventId", COALESCE(jsonb_typeof(v_push -> 'roles'), '<absent>');
      END IF;
      SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::TEXT[]) INTO v_roles
        FROM jsonb_array_elements_text(v_push -> 'roles') AS t(r);
      SELECT COALESCE(array_agg(DISTINCT r), ARRAY[]::TEXT[]) INTO v_ceiling
        FROM jsonb_array_elements_text(v_cat."pushRoles") AS t(r);
      IF NOT (v_roles <@ v_ceiling) THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % names roles %, outside the ceiling % of catalog entry (%, %) — a site may NARROW an audience and may never widen it',
          NEW."eventId", v_roles, v_ceiling, v_version, v_key;
      END IF;
      IF v_cat."audience" = 'broadcast' AND NOT (v_ceiling <@ v_roles) THEN
        RAISE EXCEPTION
          'phase6 4d-i: catalog entry (%, %) is a BROADCAST family, so the push of event % must reach its whole ceiling % and reaches % — a narrowed broadcast silently drops the roles it omits',
          v_version, v_key, NEW."eventId", v_ceiling, v_roles;
      END IF;
      -- A BROADCAST MAY NAME NO TARGET (#582 round 5, finding 6). The clause above proves the role
      -- set is the whole ceiling and stopped there, so an event could carry the full broadcast
      -- audience AND a scalar `targetUserId` — and the delivered consumer
      -- (`outbox/consumers.ts`, the targeted branch) PRIORITISES that target and returns, so
      -- exactly one user receives what the catalog declares a broadcast and everyone else is
      -- silently dropped. Widening the roles was already refused; narrowing by a back door was
      -- not. Both target shapes are rejected here, because `targetUserIds` on a non-frozen family
      -- is refused below for the same reason and a broadcast is not frozen either.
      IF v_cat."audience" = 'broadcast'
         AND ((v_push ? 'targetUserId') OR (v_push ? 'targetUserIds')) THEN
        RAISE EXCEPTION
          'phase6 4d-i: catalog entry (%, %) is a BROADCAST family, but the push of event % also names a target — the delivered consumer prefers a target over the audience, so this reaches ONE user while claiming to reach the whole ceiling %',
          v_version, v_key, NEW."eventId", v_ceiling;
      END IF;
      -- A PRESENT TARGET MUST BE A NONBLANK STRING (#582 round 9, finding 4). `->>` returns SQL
      -- NULL only for a JSON null or an absent key, so `targetUserId: ""` — or a number, or an
      -- object — reads as present here and satisfies the targeted family. The delivered consumer
      -- then takes that empty target through `consultationRequestedPushTarget`, whose
      -- `if (!targetUserId)` branch marks the delivery non-actionable, and the announcement the
      -- catalog REQUIRES is cancelled with nothing raised anywhere. This is the same blank-string
      -- class as the push body, which an earlier round corrected in one field and not the other.
      IF (v_push ? 'targetUserId')
         AND (jsonb_typeof(v_push -> 'targetUserId') <> 'string'
              OR btrim(v_push ->> 'targetUserId', E' \t\n\x0B\f\r') = '') THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % names a target that is not a nonblank string (it is a %) — a blank target is dropped as non-actionable by the consumer, so the announcement catalog entry (%, %) requires would be silently cancelled',
          NEW."eventId", jsonb_typeof(v_push -> 'targetUserId'), v_version, v_key;
      END IF;
      IF v_cat."audience" = 'targeted'
         AND NOT (v_push ? 'targetUserId') AND cardinality(v_roles) = 0 THEN
        RAISE EXCEPTION
          'phase6 4d-i: catalog entry (%, %) is a TARGETED family, so the push of event % must name the user it is for or the non-empty role audience it narrows to, and it names neither',
          v_version, v_key, NEW."eventId";
      END IF;
      -- `targetUserIds` is the FROZEN-audience array (4d-ii's countersign demand and forward);
      -- on any other family it is a set of recipients no rule resolved.
      IF (v_push ? 'targetUserIds') AND v_cat."audience" IS DISTINCT FROM 'frozen' THEN
        RAISE EXCEPTION
          'phase6 4d-i: the push of event % carries a frozen audience list, but catalog entry (%, %) is a `%` family — only a frozen-audience family resolves its recipients as a set',
          NEW."eventId", v_version, v_key, COALESCE(v_cat."audience", '<none>');
      END IF;
    END IF;

    IF (NEW."actorRole" IS NULL) <> (NEW."actorName" IS NULL) THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries half an actor envelope (role %, name %) — the pair is written together or not at all, so a fact comparing it cannot pass on one half and skip the other',
        NEW."eventId", COALESCE(NEW."actorRole", '<null>'), COALESCE(NEW."actorName", '<null>');
    END IF;
    -- AND A PRESENT HALF IS NONBLANK (#582 round 11, finding 2). Coherence is not presence: a
    -- pair of empty strings satisfies the arm above on both halves, the append-only seal below
    -- then makes it permanent, and 4d-iii's "every new human event carries the pair" is satisfied
    -- by two values that name nobody. This is the same rule the consultation pair, the change
    -- request's two pairs and the three fact tables' pairs already carry — spelled over ASCII
    -- whitespace, not the space character alone, like every other one of them.
    IF NEW."actorRole" IS NOT NULL
       AND (btrim(NEW."actorRole", E' \t\n\x0B\f\r') = ''
            OR btrim(NEW."actorName", E' \t\n\x0B\f\r') = '') THEN
      RAISE EXCEPTION
        'phase6 4d-i: event % carries a BLANK actor envelope (role `%`, name `%`) — the pair is the permanent record of WHO acted, and a blank half attributes nothing while looking attributed',
        NEW."eventId", NEW."actorRole", NEW."actorName";
    END IF;
    -- 4d-iii / R0b — THE SYSTEM PAIR, ADMITTED (the Board's Decision 1, 2026-10-05: every event is
    -- attributed). A `system` event may carry the pair when, and only when, it names the AUTOMATION: the
    -- system role together with a name from the closed registered set
    -- (`platform_t4d_automation_identity`), and a nonblank `systemActor`. The pair names the automation;
    -- `systemActor` keeps recording who or what triggered it (an operator's user id, for the two
    -- operator-backed paths), and the two are not required to match. Any other non-human pair is still
    -- refused, as before.
    IF NEW."actorRole" IS NOT NULL AND NEW."actorKind" <> 'human' THEN
      IF NOT (NEW."actorKind" = 'system'
              AND NEW."actorRole" = 'system'
              AND platform_t4d_automation_identity(NEW."actorName")
              AND btrim(COALESCE(NEW."systemActor", ''), E' \t\n\x0B\f\r') <> '') THEN
        RAISE EXCEPTION
          'phase6 4d-iii: event % is a `%` event carrying the actor envelope (`%`, `%`) — a non-human event carries a pair only as a `system` event naming a registered automation (role `system`, a name platform_t4d_automation_identity admits, a nonblank systemActor), and a human role or name on an automation would attribute its act to a person',
          NEW."eventId", NEW."actorKind", NEW."actorRole", NEW."actorName";
      END IF;
    END IF;

    -- AND NONBLANK IS NOT CORRESPONDENCE (#582's review round 17, the class-3 sweep, and the
    -- SIBLING of round 16's finding 6 — the same rule, at the table the consultation fix did not
    -- reach).
    --
    -- Everything above this point is a rule about the pair's SHAPE: written together, each half
    -- nonblank, legal only on a human actor, immutable once written. None of them asks whether
    -- the pair is TRUE of `actorId`. So a writer that names a legitimate actor could attach any
    -- nonblank role and name it liked, the freeze below would make it permanent, and the append-
    -- only event stream has no repair: 4d-iii judges new rows, never committed ones.
    --
    -- And this envelope is not a byline. §A.3 obligation 7 makes it the thing every fact's own
    -- frozen pair is COMPARED AGAINST — the fact seals ask whether the fact and the event that
    -- records the same act agree. An unjudged envelope therefore does not merely lie on its own
    -- row; it becomes the standard a judged pair is measured by, and a forged envelope written
    -- first would make the matching forged fact pass the correspondence.
    --
    -- It goes through the CORRESPONDENCE half of the shared binding, not through
    -- `phase6_t4d_actor_bound`: the reasons the envelope may carry neither the readiness fence
    -- nor the operability arm are stated at `phase6_t4d_actor_pair_true` itself.
    -- 4d-iii / R0b — judged on a HUMAN envelope only. A `system` envelope is judged by its pair alone
    -- (above) and never against `actorId`, which `emitEvent` writes NULL for a system actor.
    IF NEW."actorRole" IS NOT NULL AND NEW."actorKind" = 'human' THEN
      IF NEW."actorId" IS NULL THEN
        RAISE EXCEPTION
          'phase6 4d-i: event % carries the actor envelope (`%`, `%`) with no `actorId` — the pair is the permanent record of WHO acted, and a role and a name with nobody behind them attribute the act to an account that does not exist',
          NEW."eventId", NEW."actorRole", NEW."actorName";
      END IF;
      PERFORM phase6_t4d_actor_pair_true(NEW."projectId", NEW."actorId", NEW."actorRole",
                                         NEW."actorName", 'DomainEvent ' || NEW."eventId");
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."actorRole" IS DISTINCT FROM OLD."actorRole"
     OR NEW."actorName" IS DISTINCT FROM OLD."actorName" THEN
    RAISE EXCEPTION
      'phase6 4d-i: the actor envelope of event % is immutable — attributing a past act to a different role or name, or filling in a pair that was never recorded, is a claim about something nobody did',
      OLD."eventId";
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION platform_t4d_release_lease_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease % (release %, catalog version %) may not be DELETED — the drain attestation rests on which generation was serving and until when; a stopped process''s lease EXPIRES and stays as history, and a lease that can be removed attests to nothing',
      OLD."instanceId", OLD."release", OLD."catalogVersion";
  END IF;

  IF NEW."instanceId" IS DISTINCT FROM OLD."instanceId"
     OR NEW."release" IS DISTINCT FROM OLD."release"
     OR NEW."catalogVersion" IS DISTINCT FROM OLD."catalogVersion"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     -- 4d-iii / R0b — the build's SERVER GENERATION is identity too. R1–R3's preflights refuse while a
     -- live lease has `serverGeneration IS NULL OR < 3`, so a live pre-R0c lease re-stamped NULL → 3
     -- (or 2 → 3) would pass them while that older build still serves.
     OR NEW."serverGeneration" IS DISTINCT FROM OLD."serverGeneration" THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease %''s identity (release %, catalog version %, server generation %, started %) is FROZEN — only `leaseUntil` moves. Re-versioning a live lease into the minimum is how a preflight is talked into retiring the doors while an older generation still serves; a process at another version writes its OWN row.',
      OLD."instanceId", OLD."release", OLD."catalogVersion", COALESCE(OLD."serverGeneration"::text, '<none>'), OLD."startedAt";
  END IF;

  IF NEW."leaseUntil" < OLD."leaseUntil" THEN
    RAISE EXCEPTION
      'phase6 4d-i: release lease %''s expiry may not move BACKWARD (% → %) — renewal extends a lease, and shortening one makes a still-serving process read as stopped, which is the DELETE this seal refuses reached through an UPDATE',
      OLD."instanceId", OLD."leaseUntil", NEW."leaseUntil";
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "ReleaseLease" ADD COLUMN IF NOT EXISTS "serverGeneration" INTEGER;
DO $lease_generation_check$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReleaseLease_serverGeneration_positive'
                    AND conrelid = '"ReleaseLease"'::regclass) THEN
    ALTER TABLE "ReleaseLease" ADD CONSTRAINT "ReleaseLease_serverGeneration_positive"
      CHECK ("serverGeneration" IS NULL OR "serverGeneration" >= 1);
  END IF;
END $lease_generation_check$;

-- ── THE CLOSING VERIFICATION ────────────────────────────────────────────────────────────────────
-- Both re-issued bodies stand behind their 4d-i triggers, with the R0b arms present. The triggers are
-- 4d-i's and are not re-created here: a function re-issue changes the body every trigger naming it runs.
DO $system_pair_verify$
DECLARE v_missing TEXT := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgname = 'DomainEvent_t4d_envelope' AND NOT t.tgisinternal
                    AND p.proname = 'platform_t4d_event_envelope') THEN
    v_missing := v_missing || ' DomainEvent_t4d_envelope';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'platform_t4d_event_envelope'
                    AND position('platform_t4d_automation_identity' in prosrc) > 0
                    AND position('NEW."actorKind" = ''human'' THEN' in prosrc) > 0) THEN
    v_missing := v_missing || ' platform_t4d_event_envelope(R0b arms)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgname = 'ReleaseLease_t4d_frozen' AND NOT t.tgisinternal
                    AND p.proname = 'platform_t4d_release_lease_frozen') THEN
    v_missing := v_missing || ' ReleaseLease_t4d_frozen';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'platform_t4d_release_lease_frozen'
                    AND position('"serverGeneration"' in prosrc) > 0) THEN
    v_missing := v_missing || ' platform_t4d_release_lease_frozen(serverGeneration)';
  END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'phase6 4d-iii R0b ABORT: these do not stand as this file installs them:%', v_missing;
  END IF;
END $system_pair_verify$;
