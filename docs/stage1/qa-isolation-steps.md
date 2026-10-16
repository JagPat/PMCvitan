# QA isolation: steps and proof (Stage 1, unit Q1 + Q2)

Board decision, 16 Oct 2026 09:49 IST: move QA into its own QA-only organisation, with no code change.
No QA journey writes (Q3/Q4 writes, C1–C6) until the coordinator has checked the proof below against production.

Live app: `https://pms.vitan.in`. **API: `https://pms-api.vitan.in`, with no `/api` prefix** (corrected 16 Oct 2026
12:55 IST: the first version pointed at `pms.vitan.in/api`, which is the web app and answers 405, so S1 could not run).
Every step below is an API call with the signed-in account's bearer token, not an app screen: the app has no
"create organisation" screen, but the API route exists (`POST /orgs`, open to a signed-in PMC, `orgs.controller.ts:59`,
policy `org.create`). Live API checked on 16 Oct: `GET /health` reports commit d36028d; `POST /orgs` without a
token answers 401 "Missing bearer token", so the route is deployed. Code reference: main d36028d.
The QA password stays in the monitor's restricted secret file. Never write it into a probe file or a chat.

## Why this works (code at 41cbf0e)

- Alerts meant for "the PMC" go to the project's PMC members plus the owners/admins of the project's OWN
  organisation (`apps/api/src/orgs/orgs.participant.ts:304-317`).
- Portfolio, PMC Brief and the project switcher list a user's memberships plus every project in an organisation
  they own/administer (`apps/api/src/orgs/project-reach.ts:15-30`, `apps/api/src/auth/auth.service.ts:383-395`).
- So a QA project in an organisation whose only owner is `qa.pmc` reaches no Vitan owner or admin, as long as no
  real person is a member of it, and an archived project drops out of everyone's reach (`archivedAt` filter in
  `project-reach.ts`).

## Who does what

| Step | Who | Writes? |
| --- | --- | --- |
| P1–P3 pre-checks | Monitor | No (read-only) |
| S1–S3 setup | Monitor, signed in as `qa.pmc` | Yes, only inside the new QA organisation |
| S4 archive qa-test-356a | Jagrut (Vitan org owner), in the app | Yes, one archive in the Vitan org |
| V1–V7 proof | Monitor (V1–V4), Jagrut (V5–V6), monitor (V7) | No (read-only) |
| Verify | Coordinator, against the pass/fail lines below | No |

## P. Pre-checks (read-only, monitor)

Sign in each account with `POST https://pms-api.vitan.in/auth/login` (body `{"email":…,"password":…}`) and send the returned token as `Authorization: Bearer <token>` on every call below.

- **P1.** For each of `qa.pmc`, `qa.client`, `qa.engineer`, `qa.contractor`, `qa.consultant` @vitan.in:
  `GET /me/memberships` and `GET /me/orgs`. Record every project and org returned, with roles.
- **P2.** As `qa.pmc`, on qa-test-356a: `GET /projects/qa-test-356a/members`. Record every member's email and role.
- **P3.** STOP and report (do not run S1) if any of these is true:
  - any qa.* account is `owner` or `admin` of any organisation (P1);
  - any qa.* account belongs to a project other than qa-test-356a (P1);
  - qa-test-356a has any member whose email is not one of the five qa.* addresses (P2).

## S. Setup (monitor as qa.pmc; Jagrut for S4)

- **S1. Create the QA organisation.** As `qa.pmc`: `POST /orgs` with body `{"name":"Vitan QA (test only)"}`.
  Record the returned `id` as QA_ORG. `qa.pmc` becomes its only owner (`orgs.service.ts:253-265`).
- **S2. Create the QA project.** As `qa.pmc`, with header `Idempotency-Key: qa-stage1-project-1`:
  `POST /orgs/QA_ORG/projects` with body
  `{"name":"QA TEST Project","short":"QA TEST","descriptor":"QA test project, not a real site","siteCode":"QA-TEST"}`.
  Record the returned `id` as QA_PROJECT. `qa.pmc` is added as its PMC.
- **S3. Add the other four.** As `qa.pmc` (switch into QA_PROJECT first with `POST /auth/switch`, body `{"projectId":"QA_PROJECT"}`, and use the new token), for each
  account call `POST /projects/QA_PROJECT/members` with its own `Idempotency-Key` (`qa-stage1-member-<role>`):
  - `{"name":"QA Client","role":"client","email":"qa.client@vitan.in"}`
  - `{"name":"QA Engineer","role":"engineer","email":"qa.engineer@vitan.in"}`
  - `{"name":"QA Contractor","role":"contractor","email":"qa.contractor@vitan.in"}`
  - `{"name":"QA Consultant","role":"consultant","email":"qa.consultant@vitan.in"}`
  The accounts already exist, so they are attached, not re-created. Do NOT add anyone to the QA organisation's
  admin roster (`POST /orgs/QA_ORG/members`).
- **S4. Archive qa-test-356a.** Jagrut, signed in as himself: Team screen, project actions, archive "QA Test
  Project" (`DELETE /orgs/<vitan org>/projects/qa-test-356a`). Its records are kept, not deleted.
  After this, the qa.* accounts only reach QA_PROJECT.

## V. Proof (read-only). Each line is PASS or FAIL.

| # | Check | Run by, step | PASS when |
| --- | --- | --- | --- |
| V1 | QA org roster | Monitor as qa.pmc: `GET /orgs/QA_ORG/members` | Exactly one row: qa.pmc@vitan.in with `orgRole` equal to `"owner"` (the field is `orgRole`, not `role`) |
| V2 | QA project members | Monitor as qa.pmc: `GET /projects/QA_PROJECT/members` | Exactly five active rows, the five qa.* emails, each in its own role (pmc, client, engineer, contractor, consultant) |
| V3 | QA accounts reach only QA | Monitor, each qa.* account: `GET /me/memberships` | Each lists QA_PROJECT only (no Vitan project, no qa-test-356a) |
| V4 | QA accounts administer nothing real | Monitor, each qa.* account: `GET /me/orgs` | qa.pmc: `owner` of QA_ORG and `owner` or `admin` of no other organisation. The other four: no `owner` or `admin` row anywhere. A plain `member` row elsewhere passes, as in P3: it gives no project reach (`orgs/project-reach.ts:22`) |
| V5 | Vitan admins don't see QA in the switcher | Jagrut, in the app: open the project switcher | Neither "QA TEST Project" nor "QA Test Project" (qa-test-356a) is listed |
| V6 | Vitan admins' totals exclude QA | Jagrut, in the app: Portfolio and PMC Brief (For You) | No QA project card or row; screenshot saved for comparison after the first QA write |
| V7 | Alerts can't reach Vitan admins | Monitor: V1 plus V2 | PASS when V1 and V2 both pass, because PMC alerts go only to QA_PROJECT's PMC members and QA_ORG's owners/admins (qa.pmc alone) |

**Isolation is proven only when V1–V7 all PASS.** Any FAIL: stop, no QA writes, report the failing line.

After the coordinator confirms, the first QA write that alerts the PMC (C2, the client's approval) adds one
more check:
- **V8.** Jagrut's bell and phone get no alert from the QA project, and their Portfolio and PMC Brief look the same as
  the V6 screenshot, while qa.pmc did get the C2 alert. FAIL stops all further QA writes.

## Notes

- Record every response (status code and the fields named above, no tokens or passwords) in a dated probe file,
  times in IST.
- Sample data (places, a decision, a checklist, a drawing) is rebuilt in QA_PROJECT only as part of Q4, after
  verification, each titled "QA TEST".
- The coordinator relays the result. The thread does not start Q3 or Q4 until then.
