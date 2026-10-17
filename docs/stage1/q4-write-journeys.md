# Stage 1 Q4 write journeys (C0–C6) on the QA project (qa-test-d135)

Written 16 Oct 2026 for the monitor. Read-only research of the code; nothing was run against the live site.
Code read at d6c7dda, the main commit that is deployed (`/health` and `/version.json` both report it).
Its only difference from 82d6cbf, where H0–H3 first went live, is #944: the operator script, its test and
the runbook (`git diff --stat 82d6cbf d6c7dda`: 4 files, none in the web or journey API code), so every
screen and route cited below is what runs live. All `file:line` cites are repo paths.

Web: `https://pms.vitan.in`. API: `https://pms-api.vitan.in` (no `/api` prefix).
Project: **qa-test-d135 only.** Accounts: qa.pmc, qa.client, qa.engineer, qa.contractor, qa.consultant
(@vitan.in). The passwords stay with the monitor and are never written here.

## 0. Ground rules for this run

1. **Gate.** Do not start until the coordinator has confirmed V1–V7 (qa-isolation-steps.md). Run **V8**
   straight after C2, the first write that sends an alert to the PMC audience (the one that fans out to org
   owners and admins). If V8 fails, stop every QA write.
2. **Names.** Every record you can title starts with `QA TEST` and carries the run date as `DD-Mon-YYYY`
   (shown here as `16-Oct-2026`; use the real date). A daily log and a site visit have no title field; they
   are dated by the server (the log's civil date; the visit's start time).
3. **Direct links.** Every screen has a project URL: `https://pms.vitan.in/projects/qa-test-d135<path>`
   (`apps/web/src/lib/screens.ts:189-191`). Paths (`apps/web/src/lib/screens.ts:35-60`):

   | Screen (English label) | Path | Who has it in the menu (`screens.ts:146-157`) |
   | --- | --- | --- |
   | Dashboard ("Home" on the bar) | `/dashboard` | everyone |
   | For You (engineer: "Today") | `/for-you` | everyone |
   | Daily Site Log (PMC bar: "Site Log"; engineer bar: "Site") | `/site/log` | pmc, engineer |
   | Today's Checklist | `/site/checklist` | engineer |
   | Inspection Review | `/review` | pmc |
   | Decision Log (engineer/contractor/consultant read "Decisions") | `/decisions` | pmc, engineer, contractor, consultant |
   | Decisions (client approval screen) | `/client/decisions` | client |
   | Drawings | `/drawings` | everyone |
   | Site Map | `/places` | everyone |
   | Site Visits | `/site-visits` | everyone |

   Anything not on the phone bar is under **More** (`packages/shared/src/i18n/dictionary.ts:453`).
4. **API probes (the refusals).** The app hides buttons a role may not use, so every refusal below is an API
   call, not a click. Sign in with `POST /auth/login` (body `{"email":…,"password":…}`) and send
   `Authorization: Bearer <token>`. The token must be scoped to qa-test-d135: if the login reply's
   `projectId` is anything else, call `POST /auth/switch` with `{"projectId":"qa-test-d135"}` and use the new
   token. Reason: a token for another project gets `403 "Token is not scoped to this project"`
   (`apps/api/src/common/auth.ts:74-76`), which would be a **false pass**. A refusal PASSES only when the
   status is 403 **and** the message is the one named in the step. The role-gate message is
   `"Your role is not permitted to perform this action"` (`apps/api/src/common/roles.ts:70-72`); the role
   lists are `packages/shared/src/domain/policy.ts:19-252`.
5. **Records to verify by API (read-only GETs, as qa.pmc):** places come in `GET /projects/qa-test-d135/snapshot`
   (there is no GET route for nodes), plus `/decisions`, `/daily-log`, `/inspections`, `/drawings`,
   `/site-visits` under `/projects/qa-test-d135` (`apps/web/src/data/apiGateway.ts:904-946`, `:1480`).
   Verify as **qa.pmc**, not as another role: these reads are shaped by role. A pending decision is hidden
   from non-deciders, and the PMC's review queue and the engineer's open re-inspection are hidden from other
   roles, so a contractor, consultant or client token can show a record that exists as missing.

## What a fresh project contains

qa-test-d135 was made with `POST /orgs/QA_ORG/projects` and a body with no `templateId`, `structureFrom` or
`modules`. In that case `createProject` writes only the Project row, the creator's `pmc` membership and one
`project.created` event (`apps/api/src/orgs/orgs.service.ts:563-588`); the phases, structure copy and module
instantiation run only from those three inputs, which were absent (`orgs.service.ts:543-549`, `:597-599`).
Members came from S3. So the project starts with **no places, phases, activities, decisions, drawings,
checklists, daily logs, site visits, crew trades or photos.** The project's time zone defaults to
Asia/Kolkata (`orgs.service.ts:518`).

One consequence matters for C1: a new daily log copies its **crew trades** from the previous log, and there is
no previous log (`apps/api/src/daily-log/daily-log.service.ts:166-168`). No screen or route adds a trade,
and the submit only updates rows that already exist (`daily-log.service.ts:260-262`). So the first log has
**no crew rows**; see C1.

## Order

C0 → C1 → C2 → **V8** → C3 → C4 → C5 → C6 → L (leave-open steps) → then H3 part 2 (T2 in
h1-h3-live-journeys.md) and the O2 re-run (same file).

---

## C0. Setup records (qa.pmc)

**Who:** qa.pmc. **Preconditions:** V1–V7 confirmed; project empty.

### C0.1 A published zone

1. Open `/places` (bar: **Site Map**). It shows "No locations yet" and "Start with a zone — a floor, a wing or
   the site itself — then add its rooms and objects here." (`packages/shared/src/i18n/siteMap.ts:19-21`,
   `apps/web/src/screens/PlacesScreen.tsx:346-354`).
2. Click **+ Zone** (`apps/web/src/screens/PlaceStructure.tsx:95-98`; label `placeKindLabels.zone`,
   `packages/shared/src/i18n/dictionary.ts:661`).
3. The form label reads "New zone in the project" (`siteMap.ts:260-261`). Type `QA TEST Zone 16-Oct-2026`.
4. Click **Add** (`PlaceStructure.tsx:147-148`; "Add", `siteMap.ts:244`).
- **API:** `POST /projects/qa-test-d135/nodes` body `{"name":…,"kind":"zone","parentId":null,"publish":true}`
  (`PlaceStructure.tsx:81`, `apiGateway.ts:786-787`, route `apps/api/src/nodes/nodes.controller.ts:15-16`).
- **Expected:** 2xx; the zone appears on the Site Map tree, published (no DRAFT chip). No push (node events
  carry none, `apps/api/src/platform/external-effects.ts:333-337`).

### C0.2 A room inside it (used by C6, optional elsewhere)

5. Click the zone card/tree row to stand on it. Click **+ Room** (`PlaceStructure.tsx:100-104`).
6. The label reads "New room in QA TEST Zone 16-Oct-2026". Type `QA TEST Room 16-Oct-2026`, click **Add**.
- **API:** same `POST …/nodes` with `"kind":"room"` and `parentId` = the zone id.

### C0.3 A checklist for the engineer (needed by C4)

7. Stand on the zone on `/places`. Click **Add here** (`PlacesScreen.tsx:401-405`; `siteMap.ts:30`).
8. In the "Add here" menu click **Check something here** ("Issue a checklist for the site engineer to fill
   in", `siteMap.ts:307-308`; `apps/web/src/components/CreateMenu.tsx:53-63`).
9. The "Issue checklist" form opens with the zone shown as the location and a **Change** link
   (`apps/web/src/screens/modals/IssueChecklistModal.tsx:54-62`, `packages/shared/src/i18n/dictionary.ts:903`).
10. Title: `QA TEST C4 checklist 16-Oct-2026`.
11. Under CHECKLIST ITEMS, item 1: `QA TEST item 1 pass`. Click **+ Add item**; item 2: `QA TEST item 2 fail`
    (`packages/shared/src/i18n/createForms.ts:25-27`).
12. Click **Issue to engineer** (`IssueChecklistModal.tsx:86`, `createForms.ts:29`).
- **API:** `POST /projects/qa-test-d135/inspections` body `{"title":…,"zone":…,"items":[…],"nodeId":…}`
  (`apiGateway.ts:847-848`; route `apps/api/src/inspections/inspections.controller.ts:38-39`).
- **Expected:** toast "Checklist issued: QA TEST C4 checklist 16-Oct-2026 — the engineer has been notified."
  (`apps/web/src/store/store.ts:5183`). One push to the project's engineer(s) only
  (`external-effects.ts:284`). Alternative entry: **Inspection Review → New checklist**
  (`apps/web/src/screens/InspectionReviewScreen.tsx:400-410`).

### C0 refusals (API, no write happens)

| Who | Call | Expect |
| --- | --- | --- |
| qa.engineer | `POST /projects/qa-test-d135/nodes` `{"name":"QA TEST refused","kind":"zone","parentId":null}` | 403, role message (`node.manage` = pmc, `policy.ts:200`) |
| qa.engineer | `POST /projects/qa-test-d135/inspections` `{"title":"QA TEST refused","zone":"x","items":["x"]}` | 403, role message (`inspection.create` = pmc, `policy.ts:201`) |

The drawing is issued inside C5 (its own subject), and the decision inside C2.

---

## C1. Daily log (qa.engineer)

**Who:** qa.engineer. **Preconditions:** no log yet today (true on a fresh project). Optional: one small
JPEG/PNG for a progress photo.

1. Open `/for-you` (bar: **Today**). For an engineer this screen is "Today"
   (`apps/web/src/screens/InboxScreen.tsx:75-81`). The dark card reads "Do this now" with the button
   **Start today's log** (`packages/shared/src/i18n/dictionary.ts:146`, `:177`;
   `apps/web/src/screens/EngineerToday.tsx:156`, `data-testid="today-action"`).
2. Click **Start today's log**.
   - **API:** `POST /projects/qa-test-d135/daily-log/start` with an `Idempotency-Key` header
     (`apiGateway.ts:851-852`; route `apps/api/src/daily-log/daily-log.controller.ts:33-34`).
   - **Expected:** toast "New daily log started — crew carried over at zero." (`dictionary.ts:692`). The card
     changes to **Check in at site**.
3. Click **Check in at site** (`dictionary.ts:178`).
   - **API: none.** Check-in is stored on the phone only and is sent with the log in step 6
     (`store.ts:5405-5421`). The card text says "Uses this phone's location and a selfie." but the code takes
     neither: it records the tap time only (`store.ts:5410`). Note it, do not fail on it.
   - **Expected:** the path's "Check in" step shows Done; the card moves to **Add today's crew**.
4. **Crew: cannot be recorded on this project (BLOCKED for the first log).** "Add today's crew" opens the
   Daily Site Log, because there are no trades to ask about (`EngineerToday.tsx:81-84`: `openCrew` falls back
   to `openSite` when `dailyLog.crew.length` is 0). The Site screen shows "CREW PRESENT TODAY" and "0 workers" with no rows
   (`apps/web/src/screens/DailyLogScreen.tsx:303-320`). Reason: see "What a fresh project contains". PASS this
   step when the screen shows no crew rows and no error. Go back to **Today**.
5. *(Optional photo.)* Open `/site/log` (bar: **Site**). Under "TODAY'S PROGRESS" click **Add** (camera icon,
   `DailyLogScreen.tsx:426-428`; `dictionary.ts:615`) and pick the image. "PLACE THIS PHOTO (OPTIONAL)" may be
   left empty.
   - **API:** `POST /projects/qa-test-d135/media` with `"kind":"progress"` (`store.ts` addProgressPhoto,
     `apiGateway.ts:1351-1354`).
6. Send: on **Today** click **Nothing more today — send to PMC** (`dictionary.ts:151`, `EngineerToday.tsx:161`; shown once checked
   in, `apps/web/src/lib/engineerToday.ts:46`), **or** on `/site/log` click **Submit Daily Log to PMC**
   (`DailyLogScreen.tsx:464-469`).
   - **API:** `POST /projects/qa-test-d135/daily-log/submit` body `{"checkedIn":true,"checkinTime":…,
     "progress":N,"crew":[]}` (`store.ts:5640-5646`, `apiGateway.ts:1346-1347`; route
     `daily-log.controller.ts:84-85`).
   - **Expected:** toast "Daily site log sent to PMC — attendance, materials & photos attached."
     (`dictionary.ts:708`); Today reads "Today's log is with PMC" (`dictionary.ts:182`); `GET …/daily-log`
     shows `submitted: true`. **No push** goes anywhere: `dailylog.started` and `dailylog.submitted` carry no
     push (`external-effects.ts:324-325`).

**C1 refusals (API):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.client, qa.contractor, qa.consultant | `POST /projects/qa-test-d135/daily-log/start` (no body) | 403, role message (`dailyLog.start` = engineer, pmc; `policy.ts:220`) |
| qa.contractor | `POST /projects/qa-test-d135/daily-log/submit` `{"checkedIn":true,"checkinTime":"x","progress":0,"crew":[]}` | 403, role message (`policy.ts:226`) |

(C1 emits no push at all, see above, so it cannot test alert isolation. V8 runs after C2 instead.)

---

## C2. Decision approval (qa.pmc issues, qa.client approves)

**Preconditions:** C0.1 zone exists.

**PMC issues:**

1. As qa.pmc, open `/places`, stand on `QA TEST Zone 16-Oct-2026`, click **Add here**, then **Something to
   decide here** ("Put options to the client to choose between", `siteMap.ts:315-316`).
2. The "New decision" form opens (`apps/web/src/screens/modals/IssueDecisionModal.tsx:106`;
   `createForms.ts:38`) with the zone shown as LOCATION and a **Change** link.
3. Title: `QA TEST C2 decision 16-Oct-2026`.
4. WHO DECIDES: leave **The client** (default, `IssueDecisionModal.tsx:116-124`; `createForms.ts:44-46`).
5. OPTION A material: `QA TEST option A`. OPTION B material: `QA TEST option B`
   (placeholder "Material (e.g. Italian Marble)", `createForms.ts:58`). Leave More details closed (price
   delta 0).
6. Click **Publish to client** (`IssueDecisionModal.tsx:200`; `createForms.ts:69`). It is disabled until
   title, place and both materials are filled (`IssueDecisionModal.tsx:74-80`).
- **API:** `POST /projects/qa-test-d135/decisions` body `{title,nodeId,options:[…],publish:true}` with an
  `Idempotency-Key` (`store.ts:4921-4932`, `apiGateway.ts:772-774`; route
  `apps/api/src/decisions/decisions.controller.ts:39-40`).
- **Expected:** toast "Decision issued: QA TEST C2 decision 16-Oct-2026 — the client has been asked to choose."
  (`store.ts:4944`). `GET …/decisions` shows it `pending`, decider `client`. Record its id (DEC_C2).

**Refusals while it is still pending (run these BEFORE the client approves; once approved every approve
answers 409 "Decision is already approved and locked" instead, `decisions.service.ts:427`):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.engineer, qa.contractor, qa.consultant | `POST /projects/qa-test-d135/decisions/DEC_C2/approve` `{"optionIndex":0}` | 403 "Only this decision's decider (or the PMC on their behalf) can approve it" (`decisions.service.ts:456-461`; the route admits these roles as a ceiling, `policy.ts:27`) |
| qa.client | `POST /projects/qa-test-d135/decisions` `{"title":"QA TEST refused","nodeId":"<zone id>","options":[{"material":"a","delta":0,"swatch":"tile","recommended":false},{"material":"b","delta":0,"swatch":"tile","recommended":false}]}` | 403, role message (`decision.create` = pmc, `policy.ts:20`) |

Do **not** approve as qa.pmc: the PMC may approve on the client's behalf (`decisions.service.ts:459`), which
would close it wrongly.

**Client approves:**

7. As qa.client, open `/client/decisions` (menu **Decisions**). Heading "Decisions waiting for you", one card
   with the zone trail and the title (`apps/web/src/screens/ClientDecisionsScreen.tsx:81-84`, `:138-148`).
8. Click **Approve Option A** (`ClientDecisionsScreen.tsx:172-174`; options are labelled "Option A/B" by the
   server, `decisions.service.ts:244`).
9. The confirm sheet reads "CONFIRM APPROVAL", "Decision · Will be locked"
   (`apps/web/src/screens/modals/ApproveModal.tsx:41-73`; `dictionary.ts:462-466`). Click **Approve & Lock**
   (`ApproveModal.tsx:86-88`; `dictionary.ts:479`). (No architect is a member, so the countersign wording
   does not appear.)
- **API:** `POST /projects/qa-test-d135/decisions/DEC_C2/approve` body `{"optionIndex":0}` with an
  `Idempotency-Key` (`store.ts:2996`, `apiGateway.ts:1265-1266`; route `decisions.controller.ts:80-81`).
- **Expected:** toast "Approved & locked — saved to the server." (`dictionary.ts:525`); the card leaves the
  waiting list; `GET …/decisions` (as qa.pmc) shows DEC_C2 `approved`, option A.
- **Push:** `decision.approved` alerts the PMC audience (`apps/api/src/platform/external-effects.ts:112`), so
  qa.pmc should get it. This is the first QA write that would reach a Vitan org owner or admin if isolation
  were broken.

### V8 check (stop rule), right after C2

- Jagrut's bell and phone get **no** alert from the QA project from C0, C1 or C2.
- Jagrut's Portfolio and PMC Brief are unchanged versus the V6 screenshot.
- qa.pmc **did** get the C2 approval alert (bell, or phone if push is on for that login). If qa.pmc got
  nothing, the check proves nothing: stop and report, and the coordinator checks the alert's recipients.

Any failure stops all further QA writes.

---

## C3. Change request on the approved decision (qa.client)

**Preconditions:** DEC_C2 is `approved` (C2).

**Refusals first (route gate, works in any state):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.contractor, qa.consultant (and qa.engineer) | `POST /projects/qa-test-d135/decisions/DEC_C2/change` `{"reason":"QA TEST refused","costImpact":0,"timeImpactDays":0}` | 403, role message (`decision.change` = pmc, client; `policy.ts:34-36`) |

**Client raises it:**

1. As qa.client, on `/client/decisions` scroll to the history below the waiting list
   (`ClientDecisionsScreen.tsx:127`). The DEC_C2 row shows it is locked with the button **Request change**
   (`apps/web/src/screens/DecisionLogScreen.tsx:450-456`; `packages/shared/src/i18n/decisions.ts:57`).
   The contractor and consultant do not get this button (`DecisionLogScreen.tsx:284`).
2. Click **Request change**. The sheet reads "CHANGE REQUEST" and the decision title
   (`apps/web/src/screens/modals/ChangeModal.tsx:50-55`; `dictionary.ts:492`).
3. REASON FOR CHANGE: `QA TEST change request 16-Oct-2026`.
4. COST IMPACT (₹): `45000`. TIME IMPACT (DAYS): `4` (`ChangeModal.tsx:68-96`; `dictionary.ts:493-498`).
5. Click **Submit for Re-approval** (`ChangeModal.tsx:102-104`; `dictionary.ts:500`).
- **API:** `POST /projects/qa-test-d135/decisions/DEC_C2/change` body
  `{"reason":…,"costImpact":45000,"timeImpactDays":4}` with an `Idempotency-Key` (`store.ts:3109-3127`,
  `apiGateway.ts:1268-1269`; route `decisions.controller.ts:157-158`).
- **Expected:** toast "Change Request submitted for client re-approval." (`dictionary.ts:541-542`);
  `GET …/decisions` shows DEC_C2 `change` with the reason, 45000 and 4. The card returns to the client's list
  under "Needs your re-approval" (`ClientDecisionsScreen.tsx:88-99`). **Do not re-approve it** (it is the
  client-held decision left for H3, see L).

**Refusals on the reopened decision (status `change`):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.contractor, qa.consultant | `POST /projects/qa-test-d135/decisions/DEC_C2/approve` `{"optionIndex":1}` | 403 "Only this decision's decider (or the PMC on their behalf) can approve it" (`decisions.service.ts:459-461`) |

---

## C4. Inspection send-back (qa.engineer submits, qa.pmc sends back)

**Preconditions:** C0.3 checklist issued. One small JPEG/PNG for the evidence photo.

**Engineer submits:**

1. As qa.engineer, open `/site/checklist` (More → **Today's Checklist**). Eyebrow "TODAY'S INSPECTION",
   title `QA TEST C4 checklist 16-Oct-2026` (`apps/web/src/screens/EngineerChecklistScreen.tsx:217-218`;
   `dictionary.ts:727`). If more than one checklist is open, pick its tab first (`:229-245`).
2. Item 1: click **Pass**. Item 2: click **Fail** (`EngineerChecklistScreen.tsx:306-308`; `dictionary.ts`
   checklistLabels pass/fail).
3. Item 2 now shows "Fail requires a note + photo evidence". Type `QA TEST failed item 16-Oct-2026` in
   "Describe the issue…" (`EngineerChecklistScreen.tsx:351-363`).
4. Click the camera button on item 2 (aria-label **Add photo**, `EngineerChecklistScreen.tsx:310-316`) and
   choose the image (the hidden input is `data-testid="evidence-file-input"`, `:408`).
   - **API:** `POST /projects/qa-test-d135/media` with `"kind":"inspection"` and the item id
     (`store.ts:3363`, `apiGateway.ts:1351-1354`). The Dashboard photo tile goes up by exactly 1 from its
     count before this step (it is 2, not 1, if C1's optional photo was added).
5. Click **Submit Inspection** (`EngineerChecklistScreen.tsx:413-442`).
   - **API:** `POST /projects/qa-test-d135/inspections/<INSP_C4>/submit` body `{"items":[…]}`
     (`apiGateway.ts:1338-1339`; route `inspections.controller.ts:50-51`). Without the photo the server
     answers 400 "A failed item needs linked photo evidence…" (`inspections.service.ts:185`).
   - **Expected:** button reads "Submitted ✓ — awaiting architect" (`dictionary.ts` checklistLabels
     `submitted`). No push (`external-effects.ts:285`).

**PMC sends it back:**

6. As qa.pmc, open `/review` (More → **Inspection Review**). Eyebrow "INSPECTION REVIEW", the checklist title,
   "AWAITING REVIEW", item 2 with its photo and FAIL chip (`InspectionReviewScreen.tsx:197-297`).
7. Because an item failed, **Send back for re-inspection** is the first (red) button and **Approve Inspection**
   is second (`InspectionReviewScreen.tsx:332-336`). Click **Send back for re-inspection**. (Clicking
   **Reject item** first is optional: the server adds every FAIL item anyway, `inspections.service.ts:337`.)
- **API:** `POST /projects/qa-test-d135/inspections/<INSP_C4>/decide` body
  `{"approve":false,"rejectedItemIds":[]}` with an `Idempotency-Key` (`store.ts:3607-3621`,
  `apiGateway.ts:1341-1344`; route `inspections.controller.ts:63-64`).
- **Expected:** toast "1 re-inspection task(s) created with due dates." (`store.ts:3621`). The decided
  inspection then leaves `/review`, because the review queue holds only submitted, undecided inspections
  (`inspections-serialize.ts:285`); the "REVIEWED" view is not shown on live data. The proof is that
  a new checklist `Re-inspection: QA TEST C4 checklist 16-Oct-2026` holding only item 2, assigned to
  qa.engineer, is created (`inspections.service.ts:367`, `:420-436`) and pushed to the engineer
  (`external-effects.ts:293`). **Leave the re-inspection unfilled** (it is the failed item left for H3).

**C4 refusals (API):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.contractor, qa.client | `POST /projects/qa-test-d135/inspections/<INSP_C4>/submit` `{"items":[]}` (before step 5) | 403, role message (`inspection.submit` = engineer, pmc; `policy.ts:211`) |
| qa.engineer, qa.contractor, qa.consultant, qa.client | `POST /projects/qa-test-d135/inspections/<INSP_C4>/decide` `{"approve":false,"rejectedItemIds":[]}` (after step 5, before step 7) | 403, role message (`inspection.decide` = pmc; `policy.ts:212`) |

---

## C5. Drawing issue and acknowledgement

**Preconditions:** C0.1 zone. One small PDF or PNG (under about 3 MB: below 4,000,000 base64 characters the
file goes inline in the API body, above it the app needs a presigned bucket upload,
`apps/web/src/data/apiGateway.ts:314`, `:1392-1417`).

**PMC issues (this is the C0 "drawing" record):**

1. As qa.pmc, open `/drawings` (More → **Drawings**). Eyebrow "DRAWINGS · REGISTER", "No drawings issued yet."
   (`packages/shared/src/i18n/drawings.ts`).
2. Click **Issue drawing** (`apps/web/src/screens/DrawingsScreen.tsx:116-119`).
3. In "New drawing" (`DrawingsScreen.tsx:517`): Number (A-201) `QA-TEST-A101`; Rev `A` (default); Title
   `QA TEST C5 drawing 16-Oct-2026`; discipline **Architectural** (default); LOCATION (OPTIONAL): pick
   `QA TEST Zone 16-Oct-2026`; choose the file (`DrawingsScreen.tsx:519-555`).
4. Click **Publish** (`DrawingsScreen.tsx:561`). The web form always issues status "for construction"
   (`DrawingsScreen.tsx:509`).
- **API:** `POST /projects/qa-test-d135/drawings` with `publish:true`, the file inline, and an
  `Idempotency-Key` (`store.ts:3637-3675`, `apiGateway.ts:1414-1417`; route
  `apps/api/src/drawings/drawings.controller.ts:32-34`).
- **Expected:** toast "Drawing issued: QA-TEST-A101 Rev A — team notified." (`drawings.ts` drawingsText
  `issued`). Push to engineer and contractor only (`external-effects.ts:308`). `GET …/drawings` shows it with
  `current.id` = REV_C5 and the issued-to list.

**Contractor and engineer acknowledge:**

5. As qa.contractor, open `/drawings` (bar: **Drawings**). Click the `QA-TEST-A101` card.
6. Under "Issued to — not yet confirmed" click **I’m building to Rev A** (`DrawingsScreen.tsx:313-317`;
   `drawings.ts` drawingsText `ackButton`).
   - **API:** `POST /projects/qa-test-d135/drawings/rev/REV_C5/ack` with an `Idempotency-Key`
     (`apiGateway.ts:1436-1437`; route `drawings.controller.ts:71-73`).
   - **Expected:** the button is replaced by "You’re building to Rev A" and the contractor is listed with a
     tick. One push to the PMC (`external-effects.ts:317`; body "<name> is building to QA-TEST-A101 Rev A",
     `drawings.service.ts:404-405`).
7. Repeat steps 5–6 as qa.engineer (Drawings is under More for the engineer).

**Consultant:** opens `/drawings`, sees the drawing (no discipline was set at S3, so no discipline filter,
`apps/api/src/orgs/members.service.ts:227-228`, `DrawingsScreen.tsx:68-73`) and **no acknowledge button**
(`DrawingsScreen.tsx:272`). **Consultant drawing review does not exist**: there is no review action in the
policy (`policy.ts:234-241`) or the drawing routes (`drawings.controller.ts:23-123`), and the web form can
only issue "for construction". Mark "consultant reviews" **N/A (not built)**.

**C5 refusals (API):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.consultant, qa.client | `POST /projects/qa-test-d135/drawings/rev/REV_C5/ack` | 403, role message (`drawing.acknowledge` = pmc, engineer, contractor; `policy.ts:238`) |
| qa.engineer, qa.contractor | `POST /projects/qa-test-d135/drawings` `{}` | 403, role message (`drawing.issue` = pmc; `policy.ts:234`) |

---

## C6. Site visit (qa.consultant)

**Preconditions:** none (a starting place is optional). C0 places make the place list non-empty.

1. As qa.consultant, open `/site-visits` (More → **Site Visits**). Heading "Site Visits"
   (`apps/web/src/lib/siteVisitWords.ts:10`); "No site visits yet." (`:52`).
2. "Starting place (optional)": pick `QA TEST Room 16-Oct-2026` or leave **No place**
   (`apps/web/src/screens/SiteVisitsScreen.tsx:65-70`; `siteVisitWords.ts:17-18`).
3. Click **Start visit** (`SiteVisitsScreen.tsx:72-76`; `siteVisitWords.ts:16`). The browser may ask for
   location; allow or block, the app waits at most 5 s and starts either way
   (`apps/web/src/lib/useSiteVisits.ts:60-78`; note text `siteVisitWords.ts:19-20`).
   - **API:** `POST /projects/qa-test-d135/site-visits` body `{"id":<uuid>,"claimedAt":…,"nodeId"?,
     "location"?}` with an `Idempotency-Key` (`useSiteVisits.ts:346-350`, `apiGateway.ts:1482-1483`,
     `:1503-1508`; route `apps/api/src/site-visits/site-visits.controller.ts:30-31`).
   - **Expected:** a card with status "On site now" (`siteVisitWords.ts:24`) and **End visit**. No push
     (`external-effects.ts:365-366`). Record VISIT_C6.
4. *(Refusal while open.)* As qa.pmc: `POST /projects/qa-test-d135/site-visits/VISIT_C6/end`
   `{"claimedAt":"<now ISO>"}` → 403 "Only the visitor can end their site visit"
   (`apps/api/src/site-visits/site-visits.service.ts:121`).
5. As qa.consultant click **End visit** (`SiteVisitsScreen.tsx:241`; `siteVisitWords.ts:47`).
   - **API:** `POST /projects/qa-test-d135/site-visits/VISIT_C6/end` body `{"claimedAt":…}`
     (`apiGateway.ts:1485-1486`; route `site-visits.controller.ts:41-42`).
   - **Expected:** status "Ended" (`siteVisitWords.ts:25`) with "Ended at …".

**C6 refusals (API):**

| Who | Call | Expect |
| --- | --- | --- |
| qa.engineer, qa.contractor, qa.client | `POST /projects/qa-test-d135/site-visits` `{"id":"<new uuid>","claimedAt":"<now ISO>"}` | 403, role message (`siteVisit.start` = pmc, consultant; `policy.ts:216`) |

---

## L. Leaves for H3 part 2

What the journeys above leave open, and the one extra step needed:

| H3 needs | Left open by | State to check | PMC tile should read (T2) |
| --- | --- | --- | --- |
| A client-held pending decision | **C3** (DEC_C2 reopened, not re-approved) | `GET …/decisions`: DEC_C2 `change`, decider client | "Waiting on the client ·" (`apps/web/src/screens/dashboardWaitingOn.ts:27-31`; reopened decisions count, `apps/web/src/store/selectors.ts:109-111`) |
| A failed item in a re-inspection | **C4** (the `Re-inspection: …` checklist, unfilled) | `GET …/inspections`: child with `reinspectionOfId` = INSP_C4, `submitted:false`, one item | "Waiting on the engineer ·" (`dashboardWaitingOn.ts:53-64`) |
| An undecided inspection review | **Nothing**: C4 decides its review | — | needs **L1** |

**L1. Leave one review undecided (extra step).**

1. As qa.pmc, issue a second checklist exactly as C0.3 steps 7–12, titled
   `QA TEST H3 open review 16-Oct-2026`, one item `QA TEST item pass`.
2. As qa.engineer, open `/site/checklist`, pick **this** tab (not the `Re-inspection: …` tab, which must stay
   unfilled), mark the item **Pass**, click **Submit Inspection**.
   (`POST …/inspections/<INSP_L1>/submit`.)
3. As qa.pmc, open `/review` and confirm it shows "AWAITING REVIEW". **Do not click Approve or Send back.**
- **Expected:** review tile "Waiting on you ·" (`dashboardWaitingOn.ts:42-45`).

Do not, before T2 runs: re-approve DEC_C2 (client), fill the re-inspection (engineer), or decide INSP_L1 (PMC).

---

## Summary of what is possible

| Journey | Possible in the web app? | Notes |
| --- | --- | --- |
| C0 places | Yes (Site Map → + Zone / + Room) | Published at once |
| C0 checklist | Yes (Site Map → Add here → Check something here, or Inspection Review → New checklist) | |
| C1 daily log | Yes, except crew | **Crew BLOCKED** on a first log: no trade rows exist and nothing can add one. Check-in has no API call and no GPS/selfie despite its text |
| C2 decision | Yes | Engineer/contractor/consultant approve → 403 only while pending; afterwards 409 |
| C3 change request | Yes (client) | Contractor/consultant: 403 on change (route) and on approve of the reopened decision (service) |
| C4 send-back | Yes | Needs an image file for the evidence |
| C5 drawing | Yes for issue and acknowledge | Needs a small PDF/PNG. **Consultant review: N/A, not built.** Consultant ack → 403 |
| C6 site visit | Yes | Only the visitor can end it (PMC → 403) |
