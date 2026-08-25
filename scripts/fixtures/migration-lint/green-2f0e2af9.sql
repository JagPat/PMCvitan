-- VERBATIM EXTRACT — do not edit to make a test pass.
-- Source: PR #415 head 2f0e2af9 (merged as d37a1c7e)
-- File:   .../20270930000000_schedule_dependency_graph/migration.sql
-- Lines:  474-476 and 2335-2337 — a plain SET with an explicit set_config save/restore,
--         replacing the inert top-level SET LOCAL that stood at PR #410 head c1054005.
-- Proves: MI-004 — the corrected form passes.
-- Trimmed only by DELETING whole lines outside the ranges; nothing inside is altered.

SELECT set_config('vitan.schedule_b1_caller_search_path',
                  current_setting('search_path'), false);
SET search_path = pg_catalog;
CREATE TABLE IF NOT EXISTS public."ActivityDependency" ("id" TEXT NOT NULL);
SELECT set_config('search_path',
                  current_setting('vitan.schedule_b1_caller_search_path', true), false);
