# Production Runbook — index

The operator procedures are unchanged and still current. Under the owner decision of 2026-10-08 (delivery
speed, rule 6) they moved verbatim to [archive/RUNBOOK-2026-10-08.md](archive/RUNBOOK-2026-10-08.md), and this
file is the index. A message naming `docs/RUNBOOK.md §X` means the section headed `§X` in that file.

It covers the outbox cutover and projection repair after any release that changes the external-effect
catalog, and the one-time, diagnostic-first migration repairs. Run the steps in order. Pass your own
identity to `--operator` and a short auditable reason to `--reason`.

## Cutover steps

- 0. Phase-3 approval-register migration note (one-time, releases ≥ the round-3 correction)
- 1. Drain all OLD application instances
- 2. Deploy the new build in LEGACY/SHADOW sender mode
- 3. Rebuild ALL projections from canonical
- 3b. Re-evaluate the commercial budget register (Phase 5 Task 7A upgrade ONLY)
- 4. Inspect the diagnostics
- 5. Verify the outbox is clean
- 6. Seal the external-effect coverage
- 7. Switch to outbox sender mode
- 8. Verify health and projection readiness

## One-time repairs and abort procedures

- §CMDR. Command-receipt seal — abort states and repair (one-time, diagnostic-first)
- §T45. Tasks 4–5 integrity-correction migration + repair (one-time, diagnostic-first)
- §P4LC2. Phase 4 labour durability correction migration + repair (one-time, diagnostic-first)
- §P4LC3. Phase 4 labour worker-skill NORMALIZATION migration + repair (one-time, diagnostic-first)
- §P4T2C. Phase 4 labour commercial-INTEGRITY correction migration + repair (one-time, diagnostic-first)
- §P4T3C2. Phase 4 Task-3 correction 2 — blank manual-muster reason (one-time, diagnostic-first)
- §P4T3C3. Phase 4 Task-3 correction 3 — a marked muster that is not a real audited repair (rare)
- §P5T4. Phase 5 Task-4 vendor pinning — a purchase-order line with no resolvable order (rare)
- §P5T7BH. Phase 5 Task-7B-iii-h — legacy §I authorisations are RETIRED, not aborted on
- §P6-4a. Phase 6 task 4a — the withdraw deploy must not overlap senders across it
- §P6T4B. Phase 6 task 4b — the decider migration aborts: a published open decision has no holder
- §P6-4C. Phase 6 unit 4c-ii — the provenance migration aborts: one approval receipt backs two revisions
- §P6T4D. Phase 6 unit 4d-i — the deploy aborts on a reserved `architect` role
- §P64CIIIR. Phase 6 unit 4c-iii-r — the deploy-time `decisions.inbox` repair
- §B1. Schedule B1 — `prisma migrate deploy` aborts on `ActivityDependency`
- §ENF. Schema enforcement — the deploy aborts because a guard does not fire
