# Vitan PMC — Technical Architecture Audit

**Scope:** read-only audit of the full stack — NestJS API (`apps/api`), React/Vite web app (`apps/web`), shared types (`packages/shared`), and Prisma schema. No source files were modified for this report.

**Method:** static review of all 39 API source files, 54 web source files, the 435-line Prisma schema, and migrations, plus dependency/code-quality measurement. Three parallel deep-dive passes (backend+DB, frontend+state, security+auth+perf) cross-checked by hand.

> **Context:** a prior hardening change (PR #39) added fail-fast `JWT_SECRET`/`CORS_ORIGINS`, `NODE_ENV=production` in the API image, and phone-signup gating. This audit accounts for those as present. (A follow-up made the two secrets *fail-soft* rather than crash the deploy.)

---

## Executive summary

The codebase is **well-structured, cleanly typed, and thoroughly validated at the edges** — a faithful, disciplined port of a prototype into a NestJS+Prisma / React+Zustand stack with good test coverage on the API. The architecture is sound in the large.

The serious problems are concentrated in **authorization** and **operational scalability**, not in code hygiene:

- **🔴 Critical — broken access control.** `JwtGuard` enforces *tenancy* (which project) but **not role**. Any project-scoped token can approve client decisions, sign off PMC inspections, and start/complete activities. Combined with an **unauthenticated `POST /auth/worker/token`** that mints a writable token for any project id, this is an unauthenticated-write path.
- **🟠 High — no rate limiting, no session revocation, in-memory OTP.** Brute-forceable login/OTP, SMS cost-drain, 12h tokens with no logout/refresh, and an OTP store that breaks on restart or a second instance.
- **🟠 High — write-path scalability.** Every mutation rebuilds and returns the *entire* project snapshot; the portfolio does an unbounded N+1 fan-out; foreign-key columns are unindexed; file bytes default into Postgres.
- **🟠 High — frontend maintainability.** 575 inline `style` objects, a monolithic 1,165-line store, and one whole-store subscription that re-renders the schedule on every unrelated change. Accessibility gaps (no headings, non-keyboard controls).

None of these block a small pilot, but the **critical authorization gap should be fixed before any real multi-user production use.** Scores are at the end.

---

## 1. Overall project architecture

**Strengths:** Clean pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`) with shared domain types consumed by both sides. Feature-per-folder on the API (`auth`, `orgs`, `decisions`, `activities`, `inspections`, `daily-log`, `media`, `drawings`, `push`, `snapshot`, `realtime`). Controllers ↔ services ↔ Prisma separation is consistent. Validation is centralized in `contracts.ts` (Zod) applied via a single `ZodPipe`. Dependencies are current and appropriate (NestJS 10, Prisma 6, Zod, React, Zustand, socket.io).

### 1.1 Flat root `AppModule` — no feature modules — **Low**
- **Files:** `apps/api/src/app.module.ts:33-75`
- **Explanation:** All 11 controllers + 17 providers are registered in one root module. It works at this size but forfeits per-feature encapsulation, lazy wiring, and module-scoped testing; every provider is globally visible.
- **Fix:** Split into `AuthModule`, `OrgsModule`, `SiteModule`, etc., re-exported from `AppModule`.
- **Effort:** M

### 1.2 No repository layer; data-access + tenancy logic duplicated — **Medium**
- **Files:** `decisions.service.ts:26,52`, `activities.service.ts:21,41`, `inspections.service.ts:21,40`, `daily-log.service.ts:19,40`, `media.service.ts:70`, `drawings.service.ts:127`
- **Explanation:** Services call `PrismaService` directly (a valid choice), but the "load row → `if (!row || row.projectId !== projectId) throw NotFound`" tenancy guard is copy-pasted in ~10 places, and `canManage`/`orgRole` authorization is re-implemented in both `members.service.ts:26` and `orgs.service.ts:55`. A scoping bug would hide in one of these copies.
- **Fix:** Extract a `findInProjectOrThrow(model, id, projectId)` helper and a single authorization service so the invariant lives in one tested place.
- **Effort:** M

### 1.3 `packageManager` not pinned at repo root — **Low**
- **Files:** root `package.json` (no `packageManager` field); pnpm version only pinned in `apps/api/Dockerfile`
- **Explanation:** Corepack can't enforce the pnpm version outside Docker; contributors may use a mismatched pnpm.
- **Fix:** Add `"packageManager": "pnpm@10.33.0"`.
- **Effort:** S

---

## 2. State management (frontend)

### 2.1 Whole-store subscription re-renders the schedule on every change — **High**
- **Files:** `apps/web/src/screens/ScheduleScreen.tsx:30` (`useStore((s) => s)`), rows at `:29-91`
- **Explanation:** The selector returns the store's root identity; with Immer every `set(...)` mints a new root, so **every `ScheduleRow` re-renders on any state change anywhere** — including the `flash` toast, which fires two `set`s (show + auto-clear 3.2s later, `store.ts:376-380`). N activities → N re-renders per unrelated mutation. `gatesFor`/`activityReady` also recompute each render.
- **Fix:** Subscribe narrowly (pass `activities` + select only `todayDay`/linked drawing per row via `useShallow`); memoize the gate derivation.
- **Effort:** M

### 2.2 Monolithic 1,165-line store — **Medium**
- **Files:** `apps/web/src/store/store.ts:54-91` (30+-field state), `93-178` (~90 actions), single `create(immer(...))`
- **Explanation:** Shell, decisions, checklist, review queue, drawings, phases, multi-project/org/team, daily log, notifications, the whole access/login flow, offline outbox, and session are one store with one setter. Forces broad subscriptions and makes selector discipline the only guard against over-render.
- **Fix:** Split into Zustand slice-creators combined into one store; keep derived data in `selectors.ts` (already done well).
- **Effort:** L

### 2.3 Errors collapse to a single flash string; typed error discarded — **Medium**
- **Files:** `store.ts` — 28 `.catch(() => get().flash('…'))` sites; helper `:257-264`. `apiGateway.req` already attaches `.status` (`apiGateway.ts:292-297`) but only the OTP path reads it (`:1077-1088`).
- **Explanation:** 401/403/404/500/network all show the same English toast; the error object is dropped; no per-action loading/error state.
- **Fix:** Branch on `e.status` for messaging, log the raw error, expose loading/error state per async action.
- **Effort:** M

### 2.4 Business logic + demo data + English copy embedded in the store — **Medium**
- **Files:** `store.ts:410-425` (hardcoded `'Mr. Shah'`, `'03 Jul 2026'`), `787` (`crew[4].count += 1` magic index), 66 literal `flash(...)` strings bypassing i18n
- **Fix:** Move copy to the i18n catalog (keys, not literals); replace magic indices with keyed lookups.
- **Effort:** M

### 2.5 Dead second gateway abstraction; store coupled to concrete `ApiGateway` — **Medium**
- **Files:** `data/gateway.ts` (`DataGateway` interface, "not wired in yet", unused, signatures already diverged) vs `data/apiGateway.ts`; store imports the concrete class (`store.ts:51-52`)
- **Fix:** Delete or reconcile `gateway.ts`; type the store's `gateway` against an interface; extend the existing `runRemoteOrQueue` helper (`store.ts:280-298`) to the actions still hand-rolling the local/remote branch.
- **Effort:** M

### 2.6 Minor: transient form state in global store; dual offline queues — **Low**
- **Files:** `store.ts:431,449-451` (`changeText/Cost/Time` on `modal`, consumed by `ChangeModal.tsx:44-68`) — inconsistent with sibling modals that use local `useState`; `store.ts:76-77` two offline arrays (`syncQueue` label vs typed `outbox`) reconciled by hand.
- **Fix:** Local `useState` for the change-modal fields; derive the offline count from `outbox`.
- **Effort:** S

---

## 3. Backend architecture

### 3.1 No global exception filter — non-Nest errors leak as raw 500s — **High**
- **Files:** `main.ts:7-21` (no `useGlobalFilters`); trigger sites `orgs.service.ts:114`, `members.service.ts:60` (Prisma `P2002` on duplicate email/phone), `activities.service.ts:29,44` (`findUniqueOrThrow` → `P2025`), `media.service.ts:26` (`Buffer.from` on bad base64)
- **Explanation:** Hand-thrown Nest exceptions are clean, but any non-`HttpException` (Prisma errors, decode errors) falls through to a generic 500 with no normalized body — a duplicate-invite should be 409, a missing project 404. Inconsistent shape; can leak driver detail.
- **Fix:** Register an `AllExceptionsFilter`/`PrismaClientExceptionFilter` via `APP_FILTER` mapping `P2002→409`, `P2025→404`, unknown→sanitized 500; replace the two `findUniqueOrThrow` with explicit `NotFoundException`.
- **Effort:** M

### 3.2 Auth is opt-in per handler — fail-open posture — **High**
- **Files:** guards applied ad-hoc (`project.controller.ts:6`, `decisions.controller.ts:8`, `media.controller.ts:14,39`, `drawings.controller.ts` per-method); no `APP_GUARD` in `app.module.ts`
- **Explanation:** Every protected route must remember `@UseGuards(JwtGuard)`; some controllers guard per-class, others per-method. A new handler added without the decorator is silently public.
- **Fix:** Register `JwtGuard` as a global `APP_GUARD` + a `@Public()` decorator for the deliberately-open routes (`GET /media/:id`, `GET /drawings/rev/:id`, `POST /auth/*`). Inverts default to fail-closed.
- **Effort:** M

### 3.3 Path params and JWT claims are never schema-validated — **Low**
- **Files:** `common/zod.pipe.ts` (only on `@Body`); every `@Param(...)`; JWT cast without validation `common/auth.ts:39`, `auth.service.ts:104` (`user.role as Role`)
- **Explanation:** Bodies are well-covered, but `:projectId`/`:orgId`/`:userId` flow in unvalidated and the decoded JWT is cast to `AuthUser`/`Role` with no runtime check (and `role` is free-text in the DB — see 4.2).
- **Fix:** Reuse `ZodPipe` on format-sensitive params; validate the JWT payload against a Zod schema in the guard.
- **Effort:** S

*(Snapshot "god query" and portfolio N+1 are architectural but scored under §7 Performance.)*

---

## 4. Database

### 4.1 Foreign-key & hot-filter columns lack indexes — **High**
- **Files:** `apps/api/prisma/schema.prisma` (confirmed against migrations — the only indexes are the explicit `@@index`/`@unique`)
- **Explanation:** Prisma does **not** auto-index FK scalars. Missing indexes on columns filtered on every snapshot/portfolio read:

  | Column | line | read at |
  |---|---|---|
  | `Decision.projectId` | 251 | snapshot + `status:pending` portfolio |
  | `Inspection.projectId` | 350 | snapshot + portfolio |
  | `DailyLog.projectId` | 380 | snapshot + `orderBy date` |
  | `Notification.projectId` | 417 | snapshot |
  | `Project.orgId` | 70 | `orgId in (…)` switch/portfolio |
  | `User.projectId` | 222 | `findFirst role+projectId` |
  | `PushSubscription.projectId` | 122 | push fan-out |
  | child FKs `DecisionOption.decisionId`, `InspectionItem.inspectionId`, `CrewRow.dailyLogId`, `SiteMaterial.dailyLogId`, `Activity.decisionId`/`phaseId` | — | include joins / updateMany |

  *(Already covered: `Activity.projectId` and `Media.projectId` via composite prefixes; `Membership`/`OrgMembership`, `Drawing`, `DrawingRevision`, `DrawingAck`, `Phase`.)* Every snapshot currently sequential-scans `Decision`/`Inspection`/`DailyLog`/`Notification`.
- **Fix:** Add composite `@@index` matching query shape — `Decision([projectId,status])`, `Inspection([projectId,submitted,decided])`, `DailyLog([projectId,date])`, `Notification([projectId,at])`, `Project([orgId])`, `User([projectId,role])`, `PushSubscription([projectId,role])` + single-column FK indexes on the child tables. One migration.
- **Effort:** M

### 4.2 Status/role/kind columns are free-text `String`, not enums — **Medium**
- **Files:** `schema.prisma` — `Membership.role`:109, `.status`:110, `OrgMembership.role`:93, `User.role`:224, `Media.kind`:140, `Drawing.discipline`:167, `DrawingRevision.status`:184, `Inspection.kind`:351, `InspectionItem.state`:369, `ChangeRequest.status`:303, `DrawingAck.role`:209 *(vs the 4 proper enums at 18-41)*
- **Explanation:** Closed value sets stored unconstrained; integrity depends entirely on Zod at the edges, and several (`User.role`, `Membership.status`, `DrawingRevision.status`) are set from server code, not request bodies, so never validated. A bad value silently breaks the `role as Role` casts and status filters.
- **Fix:** Promote the stable ones to Prisma enums (`OrgRole`, `ProjectRole`, `MembershipStatus`, `RevisionStatus`, `Discipline`, `MediaKind`) with a backfill migration.
- **Effort:** M

### 4.3 File bytes stored in Postgres (`Bytes`) by default — **High**
- **Files:** `schema.prisma` `Media.data`:142, `DrawingRevision.data`:187; write paths `media.service.ts:41-43`, `drawings.service.ts:55-59`; 12 MB body limit `main.ts:15-16`
- **Explanation:** With S3/R2 unconfigured (the documented default), full images and drawings (PDF/DWG up to ~12 MB) are base64-decoded into the row — bloats the table and every backup, defeats TOAST assumptions, and is served back through the app process. Photos/drawings are the fastest-growing data, so the DB becomes the storage tier by default. In prod-without-S3 the bytes are also served **unauthenticated** (see §6.2).
- **Fix:** Treat object storage as required in production (fail-soft warn like `config.ts`), keep `Bytes` strictly for local dev.
- **Effort:** M

### 4.4 Dates stored as display strings — "latest daily log" is a real bug — **Medium** *(deferred branch)*
- **Files:** `Project.projStart/End`:50-51, `Decision.date`:261, `DailyLog.date`:382, `DrawingRevision.issuedAt`:193, `Media.takenAt`:148, `Notification.time`:421; bug site `daily-log.service.ts:19,40` + `snapshot.service.ts:33` (`orderBy date desc` on a string like `"03 Jul 2026"`)
- **Explanation:** `DailyLog.date` is a human string, yet `findFirst({ orderBy: { date: 'desc' } })` fetches "the latest" log. String ordering is lexicographic, so `"12 Jun 2026"` sorts **after** `"03 Jul 2026"` — once a project has >1 daily log, "latest" is effectively random. This is a **correctness bug**, not just a modeling smell. `Notification.time` ("2h ago") is a frozen label that goes stale instantly.
- **Fix:** Store real `DateTime`/`Date` columns and order on them; derive relative labels at read. *(You've earmarked date normalization for a later migration branch — but the daily-log "latest" lookup should be fixed sooner, e.g. order by an added `createdAt`.)*
- **Effort:** M

### 4.5 Unbounded, never-pruned, unindexed log tables — **Medium**
- **Files:** `Notification` read with no `take` (`snapshot.service.ts:38`); `AuditLog`, `DecisionEvent`, `DrawingAck` insert-only, no retention
- **Explanation:** Every mutation appends to `Notification`/`AuditLog`/`DecisionEvent`; `Notification` is then read *in full* on every snapshot (unindexed), so the write-path payload grows without bound over a project's life.
- **Fix:** `take: 20` + `@@index([projectId, at])` on the notification read; retention/archival for `AuditLog`/`DecisionEvent`.
- **Effort:** M

### 4.6 Loose cross-links, mixed `onDelete` — **Low**
- **Files:** `AuditLog.projectId`:427 (no relation), `Media.decisionId/dailyLogId`:150-151, `Drawing.activityId/decisionId`:169-170 (plain `String?`); `onDelete` is `RESTRICT` on most `Project`/`Decision` children but `Cascade`/`SetNull` on others
- **Explanation:** No referential integrity on the loose links (dangling ids possible); hard-delete of a Project/Decision is blocked by `RESTRICT` (masked today by soft-archive). Cascade behavior is inconsistent across the schema.
- **Fix:** Promote integrity-critical links to real optional relations with `onDelete: SetNull`; make the Project/Decision child cascades consistent.
- **Effort:** S

---

## 5. Authentication

### 5.1 🔴 Unauthenticated worker-token minting for any project — **Critical**
- **Files:** `auth.controller.ts:67-70` (no guard), `auth.service.ts:186-196`, `contracts.ts:32-37` (`projectId` defaults to `'ambli'`)
- **Explanation:** `POST /auth/worker/token` is unguarded and anyone can POST it to receive a valid JWT (`role:'worker'`) scoped to any project id they name — and project ids are public slugs that appear in URLs. This is the entry point that makes 5.2 an unauthenticated-write vulnerability.
- **Fix:** Bootstrap worker tokens from an authenticated PMC/engineer action (QR provisioning), or bind to a device-registration secret; gate behind an env flag; never default `projectId`.
- **Effort:** M

### 5.2 🔴 No role authorization on mutating endpoints — **Critical**
- **Files:** `decisions.service.ts:21,50`, `activities.service.ts:19,39`, `inspections.service.ts:19,38`, `daily-log.service.ts:18,39`, `media.controller.ts:38-44`
- **Explanation:** `JwtGuard` enforces only tenancy, never `user.role`. Domain comments say "Client approves", "PMC signs off" — but nothing enforces it. **Any** project-scoped token (including the worker token from 5.1) can approve a client's decision, sign off a PMC inspection review, start/complete activities, or block work. `drawings.controller.ts:21,33,125` *does* check role — so the gap is an inconsistency, not a design choice.
- **Fix:** Add a `@Roles()` decorator + guard (or explicit `ForbiddenException`) to each privileged handler: decision approve → client/pmc; inspection decide → pmc; activity/daily-log → engineer/pmc. Centralize.
- **Effort:** M

### 5.3 No refresh flow; 12h JWT with no revocation — **High**
- **Files:** `app.module.ts:42` (`expiresIn:'12h'`), `.env.example:9` (`JWT_REFRESH_SECRET` declared but **unused** repo-wide), `members.service.ts:79-86`
- **Explanation:** Opaque 12h bearer JWTs, no server store: at expiry the user is silently 401'd and must fully re-auth; no logout/blacklist (a leaked token is valid its full life); **member removal / role change don't take effect for up to 12h**. `switchProject` re-issues but never invalidates the prior token.
- **Fix:** Short access token (~15m) + rotating refresh token, or a token-version/`jti` denylist checked in `JwtGuard`. Wire or delete `JWT_REFRESH_SECRET`.
- **Effort:** L

### 5.4 In-memory OTP store breaks under restart / multi-instance — **High**
- **Files:** `auth/otp-store.ts:18-25` (per-process `Map`), `sms.service.ts`, `email.service.ts`
- **Explanation:** Codes for Fast2SMS/Telegram/email/stub are stored per-process. Behind a load balancer or across a restart: a code issued by instance A can't verify on instance B (intermittent login failure); the send-throttle and 5-attempt cap are per-instance so **both are bypassable**; a restart drops all in-flight codes. Fast2SMS is now the primary channel, so this hits the main path.
- **Fix:** Move the OTP store to Redis (shared TTL, atomic attempt counter, shared throttle key); keep the `Map` as a dev fallback.
- **Effort:** M

### 5.5 Weak OTP entropy / non-CSPRNG — **Medium**
- **Files:** `sms.service.ts:88-90` (4-digit, `Math.random`), `email.service.ts:43-45` (6-digit, `Math.random`)
- **Explanation:** 4-digit phone OTP (9,000 values) from `Math.random` (predictable, not crypto). With re-request every 30s × 5 guesses and no IP/global cap (§6.1), the space is realistically brute-forceable and incurs SMS cost.
- **Fix:** `crypto.randomInt(0, 1_000_000)`; make phone OTP 6 digits; add per-IP/per-account caps + backoff.
- **Effort:** S

### 5.6 Google sign-in ignores `email_verified` — **Medium**
- **Files:** `google.service.ts:37` (returns `emailVerified`), `auth.service.ts:179-183` (never reads it)
- **Fix:** Reject when `emailVerified` is false.
- **Effort:** S

### 5.7 Tenancy keyed on a magic param name — **Medium**
- **Files:** `common/auth.ts:43-46` (checks `req.params.projectId === token.projectId`); org routes deliberately name the param `:pid` to bypass it (`orgs.controller.ts:89-92`) and re-authorize in the service
- **Explanation:** Tenancy silently depends on a param being *literally named* `projectId`; renaming a param changes enforcement. Also, the check never re-verifies live membership (see 5.3).
- **Fix:** Make tenancy explicit (a decorator/metadata) rather than name-based; verify live membership on state-changing routes.
- **Effort:** M

### 5.8 Insecure demo defaults in `.env.example` / seed — **Medium**
- **Files:** `.env.example:19` (`ALLOW_DEV_AUTH="true"`), `:21` (`SEED_DEMO_PASSWORD="vitan123"`), `seed.ts:181-186`, `ensure-accounts.ts:56-79`
- **Explanation:** Secure-by-default only when unset — but the template opts *in* to `ALLOW_DEV_AUTH=true` (any `POST /auth/session {role:"pmc"}` → org-owner token) and a public weak password. An operator copying `.env.example`→`.env` ships full PMC access with a guessable credential.
- **Fix:** Default the template to `ALLOW_DEV_AUTH="false"`; remove the `vitan123` fallback (fail if unset in prod); label demo values clearly.
- **Effort:** S

---

## 6. Security

*(5.1/5.2 above are the top security issues — broken access control.)*

### 6.1 No global / IP rate limiting; brute-force & SMS cost-drain — **High**
- **Files:** `app.module.ts` (no `ThrottlerModule`), `main.ts` (no `helmet`), `auth.service.ts:132-144`
- **Explanation:** Only limiter is `OtpStore.canSend` (per-phone, 30s). `POST /auth/login` allows unlimited password guesses; `POST /auth/otp/request` throttles per phone number, so rotating numbers enables **SMS bombing / cost drain** on the paid channel; `otp/verify` is only bounded by the (bypassable, §5.4) per-code cap.
- **Fix:** `@nestjs/throttler` globally with tight `/auth/*` limits; add `helmet`; per-IP + per-account caps with lockout/backoff.
- **Effort:** M

### 6.2 Media & drawing files served publicly (IDOR-by-obscurity) — **Medium**
- **Files:** `media.controller.ts:24-35` (`GET /media/:id`, no guard), `drawings.controller.ts:49-60` (`GET /drawings/rev/:id`, no guard)
- **Explanation:** Both GETs are unauthenticated; access is "protected" only by an unguessable cuid, served `Cache-Control: public, immutable`. Drawings are confidential controlled documents; media are geotagged site photos. cuids leak via logs, `Referer`, history, shared links — no tenancy/role check on the read.
- **Fix:** Guard + project-scope the byte routes, or issue short-lived presigned URLs (S3/R2 mode).
- **Effort:** M

### 6.3 WebSocket gateway: no auth, wildcard CORS in prod — **Medium**
- **Files:** `realtime/realtime.gateway.ts:20` (`cors:{origin:true}`), `:26-30` (`handleJoin` accepts any `projectId`, no token)
- **Explanation:** Bypasses the prod CORS allowlist; an unauthenticated client can join `project:<id>` and receive every `changed` event for that project. Payload is only `{projectId}` (clients still refetch RBAC-filtered snapshots over guarded HTTP), so the leak is activity/timing metadata — but it's an unauthenticated cross-project signal channel.
- **Fix:** Authenticate the socket handshake (verify JWT + membership before `join`); drive CORS from `resolveCorsOrigins()`.
- **Effort:** M

### 6.4 OTP codes logged & returned when no provider configured — **Medium**
- **Files:** `sms.service.ts:119`, `email.service.ts:57` (log plaintext code), `auth.service.ts:147-149,164-167` (return `devCode`)
- **Explanation:** With no SMS/SMTP provider the service falls back to a dev stub that logs the code and returns `devCode` — with **no `isProduction()` guard**. A prod deploy missing provider env vars degrades to a full OTP bypass.
- **Fix:** In production, treat a missing provider as a hard 503; never log the code or emit `devCode` when `NODE_ENV=production`.
- **Effort:** S

### 6.5 Injection & secrets posture — **✅ no issues found**
- **Explanation:** Zero `$queryRaw`/`$executeRaw` — all access is parameterized Prisma. Zod validates every mutating body. Secrets are gitignored (`.gitignore:9-11`, only `.env.example` tracked); `config.ts` doesn't log secrets; provider API keys travel in headers, not query strings. Keep the Zod-per-route discipline (a lint rule would prevent a future unvalidated endpoint).

---

## 7. Performance

### 7.1 Every mutation rebuilds & returns the full project snapshot — **High**
- **Files:** `snapshot/snapshot.service.ts:21-51` (8 parallel `findMany` + nested includes, notifications with **no `take`**), returned by `decisions/activities/inspections/daily-log` services
- **Explanation:** Approving one decision re-reads all decisions+options, all activities, all inspections+items, latest daily log+crew+materials, all notifications, all drawings+revisions+acks, phases — then serializes the lot. Write-path latency grows with total project size, not change size (compounded by 4.5 unbounded notifications + 4.1 missing indexes).
- **Fix:** Return a small delta / 204 and let the client refetch on the realtime `changed` signal (plumbing exists); at minimum add `take`/`orderBy` limits to the notification and revision/ack reads.
- **Effort:** L

### 7.2 `portfolio()` unbounded N+1 fan-out + in-JS counting — **High**
- **Files:** `orgs.service.ts:239-296` — `Promise.all(scoped.map(… 4 queries))` with no concurrency bound (`:263-271`); fetches **all** activity rows just to count statuses in JS (`:267,272-275`)
- **Explanation:** An org owner sees every project, so this is `#projects × 4` simultaneous queries in one fan-out → connection-pool exhaustion at scale, plus over-fetching activity rows for counts.
- **Fix:** `activity.groupBy({ by:['status'], _count })` + `_count` for the rest; a handful of grouped queries keyed by `projectId in (…)`; bound the fan-out.
- **Effort:** M

### 7.3 Base64 media in Postgres; 12 MB body → ~2× memory per upload — **Medium**
- **Files:** `main.ts:15-16`, `media.service.ts:26-47`, `storage.service.ts:70-77`, `schema.prisma:142,187`
- **Explanation:** In the DB-stub path each upload holds the base64 string *and* the decoded Buffer in memory simultaneously (~2×), no server-side resize/compression; bytes transit the API process. *(See 4.3.)*
- **Fix:** Require S3/R2 in prod; use the existing presigned direct-to-bucket flow (`storage.service.ts:85-90`); add server-side downscaling.
- **Effort:** M

### 7.4 Missing indexes on hot read paths — **Medium** *(= 4.1; listed here for the perf lens)*

---

## 8. Frontend

### 8.1 Pervasive inline styling — 575 `style={{…}}` + 46 style consts — **High**
- **Files:** worst: `TeamAccessScreen.tsx` (116), `DrawingsScreen.tsx` (60), `ScheduleScreen.tsx` (57), `TeamScreen.tsx` (51), `DailyLogScreen.tsx` (46); duplicated const objects `fld`/`loginField`/`cardBtn`/`cardStyle`/`roleChip` across files
- **Explanation:** Only breakpoint scaffolding lives in CSS (`responsive.module.css`); all visual detail is inline — hardcoded hex/rgba repeated hundreds of times instead of the existing `var(--ink)`/`var(--hairline)` tokens, fractional font sizes (`13.5`, `12.5`) with no type scale, the same input/card/avatar objects copy-pasted. Single largest maintainability problem in the web app (and each literal is a new object per render).
- **Fix:** A few primitives (`Input`, `Field`, `Select`, `Avatar`, `Chip`, `IconButton`) + CSS Modules for repeated blocks; replace literals with the design tokens. Consolidating the duplicated field/card/avatar objects alone removes a large fraction of the 575.
- **Effort:** L

### 8.2 Component library exists but screens bypass it — **Medium**
- **Files:** library `components/index.ts` (Button w/ 9 variants, Card, Modal, StatTile…); bypassed by raw styled `<button>`/`<input>` in `TeamAccessScreen.tsx:180-194,349-368`, `ProjectSwitcher.tsx:83-84`; member-row markup duplicated within `TeamScreen.tsx:97-117` and `:194-227`
- **Fix:** Extract `MemberRow`, `Field`, `Avatar`; route all clickable actions through `Button`/`IconButton`.
- **Effort:** M

### 8.3 No heading hierarchy anywhere — **High (accessibility)**
- **Files:** 0 `<h1/h2/h3>` repo-wide; titles are styled `<div>`s (`DashboardScreen.tsx:45`, `ScheduleScreen.tsx:156`, `TeamAccessScreen.tsx:112`)
- **Explanation:** Screen readers get no document outline or heading navigation.
- **Fix:** Promote each screen's primary title to `<h1>`, section titles to `<h2>`, keep styling via class.
- **Effort:** S

### 8.4 Clickable `<div>`s not keyboard-operable — **High (accessibility)**
- **Files:** `DashboardScreen.tsx:113-127` (KPI drill-down tiles: `<div onClick>` with no `tabIndex`/`role`/`onKeyDown`)
- **Explanation:** The four primary dashboard drill-downs are unreachable by keyboard and invisible to assistive tech as controls.
- **Fix:** Render as `<button>` (or `role="button"` + `tabIndex={0}` + Enter/Space handler).
- **Effort:** S

### 8.5 Placeholders-as-labels; modal has no focus management — **Medium (accessibility)**
- **Files:** only 2 `<label>` app-wide; inputs in `TeamScreen.tsx:84-85`, `TeamAccessScreen.tsx:210-227`, `ChangeModal.tsx:44-67`; `Modal.tsx:15-56` has `role="dialog"`+Esc but no focus trap / initial / return focus
- **Fix:** Wrap fields in `<label>`/`htmlFor` (bundle into a `Field` primitive); add a ~30-line focus-trap hook to `Modal`.
- **Effort:** M

### 8.6 `TeamAccessScreen` — 570-line, 9-mode mega-component — **Medium**
- **Files:** `screens/TeamAccessScreen.tsx` (9 step branches, subscribes to 29 store values `:54-82`)
- **Fix:** Split each step into `screens/access/*` (folder exists); parent selects only `access.step`.
- **Effort:** M

### 8.7 Navigation: store-canonical URL sync with disabled-deps effects — **Low**
- **Files:** `layout/RouteBridge.tsx:13-45` (two `useEffect` with `exhaustive-deps` disabled + `didInit` ref); `screenForPath` linear scan (`screens.ts:57-60`)
- **Explanation:** `store.screen` is the source of truth and RouteBridge reconciles the URL; deep-link/refresh correctness rests entirely on this component. Works, but fragile.
- **Fix:** Consider making the router canonical (screens read the route; actions `navigate()`), removing one effect; or add a `Map` for `screenForPath`.
- **Effort:** M

---

## 9. Code quality

**Strengths (measured):** typing is clean — only **2** `: any`/`as any` across all source; **1** TODO/FIXME; **1** `console.*` in API (the boot log); no raw SQL; `.env` correctly gitignored. API test coverage is good (**15** test files for 39 sources). Zod contracts + shared types keep the client/server shapes in sync.

### 9.1 Duplicate logic — **Medium**
- **Files:** tenancy guard copy-pasted ~10× (§1.2); `canManage`/`orgRole` twice (§1.2); `fld`/`loginField`/card/avatar style objects duplicated across screens (§8.1); member-row markup duplicated (§8.2)
- **Fix:** Extract the shared helpers/primitives named above.
- **Effort:** M

### 9.2 Dead / orphaned code — **Low**
- **Files:** `data/gateway.ts` (`DataGateway`, "not wired in", diverged — §2.5); `JWT_REFRESH_SECRET` declared, unused (§5.3); `syncQueue`/`record` largely superseded by `outbox` (§2.6)
- **Fix:** Delete or reconcile.
- **Effort:** S

### 9.3 Large files — **Medium**
- **Files:** `store.ts` (1,165 — §2.2), `TeamAccessScreen.tsx` (570 — §8.6), `apiGateway.ts` (438), `DrawingsScreen.tsx` (323). The screens are large mostly from inline styling + mode-branching, not intrinsic complexity.
- **Fix:** Split per §2.2 / §8.6.
- **Effort:** L (bundled)

### 9.4 Testability — **Low**
- **Explanation:** API services are unit-tested well, but the frontend has only **6** test files for 54 sources, and the monolithic store + whole-store subscriptions make component testing harder. Bash-script tooling (`lockdown-check.sh`) is untested by CI.
- **Fix:** Add store-slice + screen tests as the store is split; smoke-test the shell scripts.
- **Effort:** M

---

## 10. Construction domain review

Mapping the six site personas to the implemented roles:

| Persona | Implemented as | Support | Notes |
|---|---|---|---|
| **Architect** | `pmc` project role + org `owner`/`admin` | ✅ Full | Approvals, review sign-off, portfolio, team/roster mgmt, project CRUD. Strong. |
| **Client** | `client` project role | ✅ Good | Decisions-waiting + project-health screens; decision approval. |
| **Site Engineer** | `engineer` project role (phone-OTP provisioned) | ✅ Good | Daily log, checklist, drawings, decision log. |
| **Contractor** | `contractor` project role | ✅ Adequate | Drawings + decision log (read-heavy); drawing build-acknowledgement. |
| **Labourer** | `worker` `WorkerDevice` (no account, tap-photo) | 🟡 Partial | Correct "no-login, supervisor-mediated" model — but the token path is **unauthenticated** (§5.1) and can't reach a feature phone (web app). |
| **Supervisor / mistri** | ❌ **No first-class role** | 🔴 Gap | The sign-in "trade/mistri" card exists in the UI but there is no `supervisor` role in the schema or RBAC; it's conflated with engineer/worker. |

**Domain findings:**
- **10.1 — No `supervisor`/mistri role — Medium.** The domain has a distinct supervisor layer (manages a crew, reports to the engineer) with no representation in `Membership.role` (`pmc|client|engineer|contractor`) or the UI's role guard. *Fix:* add `supervisor` as a project role with scoped permissions (crew/attendance, no approvals). Effort: M.
- **10.2 — Worker identity is unauthenticated — Critical (= §5.1).** The right *product* model (supervisor enrolls, no labourer device) is undermined by the open token endpoint.
- **10.3 — Roles are project-scoped only.** A person is one role per project via `Membership` — good multi-project design; but because roles aren't enforced on writes (§5.2), the role distinctions are largely advisory today.

**Verdict:** the data model and screens genuinely support all six personas' *workflows*; the gaps are (a) the missing supervisor role and (b) that role distinctions aren't *enforced* server-side.

---

## Scores

| Dimension | Score | Rationale |
|---|---|---|
| **Overall architecture** | **6.5 / 10** | Clean monorepo, consistent controller/service/contract layering, shared types, Zod validation, transactions, secure-by-default config. Held back by: no repo layer (duplicated tenancy), flat root module, monolithic frontend store, no global guard/exception filter. |
| **Security** | **4 / 10** | Excellent basics — parameterized Prisma (no injection), Zod everywhere, gitignored secrets, dev-auth gate, fail-soft config, phone-signup gate. But a **critical broken-access-control chain** (unauthenticated worker token + no role checks on writes), **no rate limiting**, public file serving, no session revocation, and OTP-code leakage-on-misconfig pull this down hard. |
| **Scalability** | **5 / 10** | Fine at seed size; degrades predictably: missing FK indexes, full-snapshot-per-mutation, unbounded portfolio N+1, blobs in Postgres, in-memory OTP (breaks multi-instance), unbounded notification/audit growth, string dates. All fixable without a rewrite. |
| **Maintainability** | **6 / 10** | Very clean typing (~2 `any`), good API test coverage, Zod contracts, shared types. Dragged by 575 inline styles, the 1,165-line store, duplicated tenancy/auth checks, dead `gateway.ts`, and thin frontend tests. |
| **Production readiness** | **4.5 / 10** | It deploys, has CI, docs, and secure-by-default config — but the critical authorization gap, absent rate limiting, in-memory OTP (loses codes on restart), blob-in-PG default, and the fact it *just crash-looped in prod* mean it is **not production-ready for real multi-user use** until §5.1/§5.2/§6.1 and the OTP store are addressed. |

### Recommended remediation order
1. **§5.1 + §5.2** (critical): guard `/auth/worker/token`; add role checks to every mutating handler. *This is the one that matters most.*
2. **§6.1 + §5.4 + §5.5**: rate limiting + Redis OTP store + CSPRNG/6-digit codes (brute-force & cost-drain on the live auth path).
3. **§3.1 + §3.2**: global exception filter + global `JwtGuard` (fail-closed).
4. **§5.3 / §6.2 / §6.3 / §6.4 / §5.8**: session revocation, file-serving auth, socket auth, OTP-leak guard, insecure demo defaults.
5. **§7.1 / §7.2 / §4.1**: snapshot delta + portfolio aggregation + FK indexes (scale with usage).
6. **§8.x / §2.x / §9.x**: frontend primitives + store split + accessibility (quality/velocity).

*Deferred by request: money and date normalization (§4.4) — a later migration branch.*

---
*Read-only audit. No refactoring performed. Generated for the Vitan PMC codebase.*
