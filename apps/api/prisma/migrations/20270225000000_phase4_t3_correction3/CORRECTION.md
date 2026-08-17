# Correction to a claim in this migration's comments

**`migration.sql` in this directory is DEPLOYED and therefore immutable — its bytes are not edited,
including its comments.** This file sits beside it instead. Prisma reads only `migration.sql` from a
migration directory, so nothing here affects the migration's checksum or the ledger.

## The claim that is wrong

Near the "DIAGNOSE AND SEAL — ONE STATEMENT, ONE TRANSACTION" banner, the comment states:

> This migration has NO transaction wrapper: Prisma runs the file statement by statement, so every
> statement boundary is a commit.

**That is false**, and it is worth correcting in writing because it was read as evidence and produced
an incorrect review finding (PR #344, round 15, F2 — the claim that `20270815000000`'s opening
`LOCK TABLE` is released before the seals it installs).

`prisma migrate deploy` sends a migration file as a single multi-statement string. PostgreSQL runs a
multi-statement simple query in an **implicit transaction**, so the whole file commits or none of it
does. `apps/api/scripts/prisma-migration-atomicity-proof.sh` demonstrates this by execution: a probe
migration whose first statement creates a table and whose second divides by zero leaves no table
behind. That script fails loudly — and names the opposite conclusion — if the behaviour ever changes.

## What survives

The **design** the comment justified is still correct, on a narrower and true reason.
`apps/api/scripts/upgrade-proof.sh` re-applies migration files with a bare `psql -f`, which really
does autocommit per statement, and an operator running this file by hand gets the same. Under those
appliers, diagnosing in one statement and installing the guard in the next leaves a real window — after
the diagnostic has passed and before the marker prefix is reserved — in which a concurrent direct
writer can insert a pre-revoked marked row. A single `DO` block is a single statement under every
applier, which is why the diagnosis and the seal are one.

So: keep the block. Distrust only the sentence about Prisma.
