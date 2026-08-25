-- CONSTRUCTED ADJACENT-DECOY PROBE — not a historical extract.
-- Proves: MI-004 checks each scoped statement's POSITION, not whether the file contains a `BEGIN`.
--
-- Codex finding F4 against PR #423 head c6e9ff17: `file.statements.some(s => s.kind === 'BEGIN')`
-- is order-blind, so ANY `BEGIN` anywhere accepted EVERY top-level `SET LOCAL` and `LOCK TABLE`.
-- The first pin below is genuinely inside a transaction and correct. The second is after the
-- COMMIT — outside every transaction, so for a caller that supplies none it is a WARNING that
-- silently changes nothing, which is the c1054005 defect exactly. It was reported clean.

BEGIN;
-- CORRECT — inside the transaction the file opened. This is the decoy that shields the next one.
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS public."Decoy" ("id" TEXT NOT NULL);
COMMIT;

-- THE DEFECT — the transaction is already closed, so this pin binds nothing.
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS public."DecoyTwo" ("id" TEXT NOT NULL);
