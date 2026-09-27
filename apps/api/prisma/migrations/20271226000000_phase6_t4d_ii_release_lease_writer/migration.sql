-- Phase 6 task 4d unit 4d-ii-a — the 4d-ii WRITERS WITNESS, installed with the `ReleaseLease` startup
-- writer it declares (owner disposition of 2026-09-27: taken ahead of the rest of A6).
--
-- WHY NOW. 4d-i's audits (`$dark_registers$`, `$legacy_shape_kernel$` in 20271220; `$dark_tables$`,
-- `$legacy_shape$` in 20271221; U3's foreign-generation audit) refuse to ADOPT 4d-shaped data on a
-- replay unless `phase6_t4d_ii_installed()` is true: the witness below AND at least one lease. The
-- additive staging let writers land first — A1 writes the event envelope pair, A2 the change
-- request's provenance and frozen pair — so a P3005 baseline replay over a database holding what
-- they wrote aborts on rows they wrote correctly. Only one kind of database reaches that replay
-- with such rows: a really-migrated one restored WITHOUT its `_prisma_migrations` ledger. A
-- `prisma db push` database never does — it has none of the §C guards, and `migrate.sh` refuses to
-- baseline it before any migration is replayed (t3c seals exit 5).
--
-- WHAT THIS CLOSES, AND WHAT IT CANNOT (#646 review, finding 4114478871). From the first start of
-- this release the database carries the witness AND a lease, and both are restored with it, so a
-- ledger-lost restore taken after that start replays through 4d-i with the audits stood down —
-- the witness does not have to sort before 4d-i, because it is already there. A restore taken
-- while ONLY A1/A2-era processes had served carries no lease, and nothing this release installs can
-- supply evidence that a process served before it existed: writing a lease from the deploy runner
-- ahead of the replay would make the deploying release attest for itself, the stand-in 4d-i's
-- round 40 refused. That restore's recovery is its ledger, not a reset of the rows (RUNBOOK
-- §P6T4D, "A restored database that lost its migration ledger"). `scripts/upgrade-proof.sh` replays
-- 4d-i over the same A1-shaped event both ways.
--
-- WHY THE SERVICE SHIPS IN THE SAME UNIT. Declaring the witness is what opens `ReleaseLease` to
-- INSERT, and an INSERT is permanent (`ReleaseLease_t4d_frozen` refuses DELETE and any `leaseUntil`
-- decrease). Declared with no writer, the door is open with nothing sanctioned behind it — the
-- window #582's round 36 closed. A writer with no declaration meets the door and cannot boot.
-- Neither order is safe apart.
--
-- WHAT THIS DOES:
--   1. installs `platform_t4d_ii_writers_installed()`, returning true — the DECLARATION 4d-i reads
--      through `phase6_t4d_ii_declared()`. The SERVING witness, `phase6_t4d_ii_installed()`, also
--      needs a lease, which only the startup writer (`src/platform/release-lease.service.ts`)
--      writes, so the data audits stand down only where 4d-ii processes actually ran.
--   2. drops `ReleaseLease_t4d_insert_reserved`. 4d-i drops it only when REPLAYED over a declared
--      database, which an ordinary ledger-backed deploy never does, so the declaration alone would
--      leave the door standing and the writer refused.
--
-- RE-RUNNABLE (it is on `ALWAYS_EXECUTE`): `CREATE OR REPLACE FUNCTION` and `DROP TRIGGER IF EXISTS`
-- only. It sorts after 4d-i, which `ALWAYS_EXECUTE` also re-runs; a 4d-i replay over a database
-- this file has declared drops the door itself and does not put it back.

CREATE OR REPLACE FUNCTION platform_t4d_ii_writers_installed() RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

DROP TRIGGER IF EXISTS "ReleaseLease_t4d_insert_reserved" ON "ReleaseLease";
