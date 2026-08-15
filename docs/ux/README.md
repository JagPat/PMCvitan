# UX Completion Programme — instructions for Claude Code

Owner-mandated stakeholder-UX completion gate for **standalone V1 / live pilot**.
Design authority for this programme. **v2** — reproduced against `main @ a35439439a30`, with corrections from external review applied.

## Read in this order

1. `UX_COMPLETION_PROGRAMME.md` — master brief. Mandates, reproduced evidence, five waves, per-unit specs with exact file paths, backend wiring, acceptance, and **§6 open questions**. Start here.
2. `WAVE_0_FOUNDATION.md` — the first wave, split into three units, written out in full as the pattern later unit briefs should follow.
3. `visual/` — two rendered design documents: reproduction evidence with mobile-IA before/after and the readiness matrix, and the transformation plan with before/after mockups for the three heaviest screens. Open in a browser. The text specs are authoritative; these show intent.

## Status — read before doing anything

> **Amendment (2026-08-15):** the owner directed that independent
> activities run in PARALLEL, superseding the original "after Task 4"
> sequencing for Wave 0. These docs LANDED (this folder) and **unit F-1a is
> IMPLEMENTED AND SHIPPED in the same PR (#342)** — do NOT re-plan or
> re-implement F-1a. The next Wave-0 unit is **F-1b**, which opens
> AUTONOMOUSLY: the §6.7 field-primitive question is settled by recorded
> default (2026-08-15 — the shared field primitive, the option the
> foundation doc marks preferred; the owner may override asynchronously);
> **F-1c** follows both. Waves 1–5 keep their original gating below.

- **The remaining Phase 6 collaborator work still gates waves 1–5.** Leave the active Task 4 plan/review/correction work completely undisturbed. Do not mix anything from this folder into it.
- **Wave 4 is blocked** on worker authentication and device binding (§6.2), and on the worker/mistri experience shape (§6.3). **Wave 5 acceptance is blocked** on weekly-report export (§6.1) and architect rejection authority (§6.5). **Wave 3 is not implementation-ready** until the `CommercialScreen` split is decided. **F-1b**'s field-primitive question is SETTLED by §6.7's recorded autonomous default (2026-08-15 — the shared primitive; owner override asynchronous). Settle each remaining question before its stage opens.
- **Re-audit before planning.** These findings were reproduced at `a35439439a30`. For WAVES 1–5, Phase 6 will change the interface inventory — re-run every reproduction step against the post-Phase-6 head and re-derive the surface map from the final screen list. A WAVE-0 unit instead re-runs its reproduction steps against the CURRENT head at the moment it opens (amended 2026-08-15: F-1a did exactly this; F-1b does the same when it opens — it does not wait for Phase 6).

## Non-negotiable rules

1. **Reproduce before you plan.** Every claim cites a file and line. Re-run each against current `HEAD`. If a claim no longer reproduces, say so and skip it — do not build against a stale finding. v1 of these docs contained four claims that were wrong or overstated; they are listed openly in the master brief's correction table. Treat this folder as a starting hypothesis, not as truth.
2. **Sequencing is fixed for Waves 1–5.** Task 4 → Phase 6 collaborator units → Waves 1–5. **Wave 0 is the exception** (amended 2026-08-15, owner parallel directive): it runs NOW as a parallel track — F-1a shipped in PR #342, F-1b opens on that merge with §6.7's recorded default, F-1c after both — and no Wave-0 unit waits for Task 4 or Phase 6. Within the programme, Wave 0 still precedes Waves 1–5.
3. **One wave open at a time.** A wave opens only when the previous has cleared exact-head Codex review. Units *within* a wave are independent and may run in parallel — **except Wave 0**, where `F-1c` (per-surface validation) depends on both `F-1a` and `F-1b` and must run after them.
4. **Scope discipline.** Decision-specific UX belongs to Task 4. Collaborator-portal UX belongs to its Phase 6 units. Nothing here authorises work in either.
5. **Do not weaken gates.** Security, authorization, evidence, migration, offline, idempotency, module-boundary and exact-head Codex gates stand unchanged. Where this plan meets a security question — worker device binding especially — fix the security question first rather than designing around it.
6. **No Phase 7.** No external-system integrations, credentials, vendor schemas or live external calls.
7. **Review-unit limit applies.** Where a change would exceed it, the brief says how to split. `CommercialScreen.tsx` (162 KB) **must** be split. Wave 0 is already split into three.
8. **Never self-certify.** These documents are design intent and reproduction evidence, not clearance. The gate closes only on **observed sessions with real stakeholder representatives** — PMC, architect, client, contractor, mistri and worker. Claude, Codex and CI cannot substitute for that evidence.
