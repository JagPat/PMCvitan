-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #410 head c1054005
-- File:   .../20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  104-108 (the top-level search_path pin)
-- Proves: MI-004 — SET LOCAL outside a transaction block
--
-- Trimmed only by DELETING whole lines outside the range; nothing inside is altered.

-- `SET LOCAL search_path = public` stays as defence in depth for anything that resolves a name
-- this file does not qualify (the foreign-key targets), and because LOCAL cannot leak into the
-- connection the deploy goes on to use. It is only a WARNING outside a transaction block, not an
-- error — which is exactly why it cannot be the only pin.
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS public."ActivityDependency" ("id" TEXT NOT NULL);
