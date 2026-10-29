/**
 * The Vitan PMC application store.
 *
 * A faithful port of the prototype's single `DCLogic` class: one shared state
 * object plus actions that mirror its methods. Cross-slice flows (approve→lock,
 * material-mismatch→block, offline queue→flush) are expressed directly, exactly
 * as the prototype does. This store is the current "local gateway"; when the API
 * lands (Phase 7) these actions move behind the `DataGateway` and TanStack Query.
 *
 * Derived values (counts, filtered lists, timeline geometry) are NOT stored here
 * — they live in ./selectors and are recomputed from this state, so the
 * interconnected flows stay consistent by construction.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { castDraft, current } from 'immer';
import {
  SEED_ACTIVITIES,
  SEED_CHECKLIST,
  SEED_DAILY_LOG,
  SEED_DECISIONS,
  SEED_NOTIFICATIONS,
  SEED_REVIEW,
  SEED_DRAWINGS,
  SEED_PHASES,
  SEED_NODES,
  SEED_PHOTOS,
  SEED_MATERIALS,
  SEED_PLACED_INSPECTIONS,
  PROJECT,
  type AccessState,
  type AccessErrorKey,
  type AccessWho,
  type Activity,
  type AppNotification,
  type Checklist,
  type DailyLog,
  type Decision,
  type Drawing,
  type MembershipSummary,
  type OrgMember,
  type OrgRole,
  type OrgSummary,
  type Phase,
  type PmcBriefResult,
  type PortfolioProject,
  type ProjectMember,
  type ProjectCompany,
  type ProjectNode,
  type Photo,
  type Material,
  type SwatchKey,
  type PlacedInspection,
  type ItemState,
  type Lang,
  accessDict,
  signInErrors,
  signInText,
  type SignInErrorKey,
  type ModalState,
  type Review,
  type ReservationPlan,
  type Role,
  type ScreenKey,
  type Worker,
  type MeasurementRegisterDto,
  type ForwardDecisionInput,
  type DisagreeDecisionInput,
  type ResolveStrandedCountersignInput,
  ROLE_POLICY,
} from '@vitan/shared';
import { routableScreensFor, screensFor } from '@/lib/screens';
import { deleteWaitsForUpload, uploadQueued, type KeptSitePhoto } from '@/lib/queuedSitePhotos';
import { deleteSitePhotoRow, dropSentMarkers, holdSitePhotoLock, isSitePhotoSent, listSitePhotoRows, markSitePhotoSent, putSitePhotoRow, sitePhotosLocked, SITE_PHOTO_SENT_KEEP_MS, sitePhotoStorageAvailable, SitePhotoBusy, SitePhotoUnreadable, type SitePhotoRow } from '@/data/sitePhotoStore';
import { readImpact } from '@/lib/impactInput';
import { dailyLogCommandInFlight } from './dailyLogPending';
import { type DailyLogDraft, adoptLegacyDraft, dailyLogIdentity, dailyLogKey, draftAppliesTo, draftHoldsWork, legacyDraftExtras, overlayDailyLogDraft, parseDailyLogDraft } from './dailyLogDraft';
import { emptyProjectData, emptyModuleReadState, isCurrentProjectScope, projectScopeOf, type NodeCreatePending, type ProjectLoadState, type ProjectScope } from './projectScope';
import { applySeenConfirmed, applySeenFailure, claimSeenChunk, emptyNotifSeen, planSeenChunks, reconcileSeen, type NotifSeenState } from '@/lib/notificationSeen';
import type { MaterialsView } from './materials';
import type { LabourView } from './labour';
import type { SodRule, VendorAdvanceListDto } from '@vitan/shared';
import { dailyLogCommandLabels as DLC, dailyLogToast as DLT, dailyLogToastText as DLX, syncResultText as SYNC, locationResultText as LOC, checklistToast as CHT, checklistText as CHX, decisionToastText as DTX, serverRefusalText as SRV, changeSubmittedToast, drawingToast as DWT, drawingToastText as DWX, scheduleToast as SCT, scheduleToastText as SCX, placeToastText as PLT, inspectionReviewLabels as IRL, inspectionReviewText as IRT, inspectionTitle, SNAPSHOT_SITE_PHOTO_LIMIT, sitePhotoDeletable, sitePhotoLabels as SPL } from '@vitan/shared';
import type { CommercialBillRow, CommercialClaimView, CommercialView } from './commercial';
import { subtreeIds, ancestorIds } from '@/lib/locationTree';
import { jwtSub } from '@/lib/jwt';
import { unlinkPushOnSignOut } from '@/data/push';
import type { ApiGateway, ApiSnapshot, OutboxOp, IssueDrawingInput, AddMemberInput, AddOrgMemberInput, NewProjectInput, CompanyInput, ArchivedProject, NewActivityInput, NewDecisionInput, UpdateDecisionDraftInput, OrgTemplateModule, OrgProjectTemplate, OverrideGateInput, AllocateLabourInput, RecordVendorBillInput, TakeMeasurementInput, AmendVendorBillInput } from '@/data/apiGateway';
import {
  beginCreateSend, createHoldScope, currentCreateHoldView, releaseCreate, reserveCreateRetry, reserveNewCreate, serverKeepsCreateReceipts,
  settleCreate, SERVER_NOT_READY, SERVER_NOT_READY_RETRY, type CreateHoldView, type CreateRecord, type Reservation,
} from './projectCreateHold';
import { createQueueKeyGuard, queueActIdent, type QueueWrite } from '@/store/queueKeyGuard';
import { isDone } from '@/store/queueLedger';
import { keepUnsentLocked, underQueueLock, writeQueueKey } from '@/store/queueKeyLock';
import { QW } from '@/lib/queueWords';
import { queueStrip, type UnreadableKey } from '@/store/queueUnreadable';
import { resolveMediaUrl, replayOutboxOp, isTerminalOutboxError, isDeletedPhoto, isMediaNotFound, SitePhotoGone, isCountersignChainOp, refusalMessage, isSiteVisitOp, siteVisitOf, isOpenVisitConflict, ownOpenVisit, moveSiteVisitOps, tellSiteVisits, siteVisitListeners, type SiteVisit, type UploadMediaInput, newIdempotencyKey, PROJECT_ID, API_BASE, DEV_AUTH, activitiesReadMode, decisionsReadMode, dailyLogReadMode, drawingsReadMode, inspectionsReadMode, type ModuleActivities, type ModuleDecisions, type ModuleDailyLog, type ModuleDrawings, type ModuleInspections, type Phase6_4dRollout, type NodeCreatedSnapshot } from '@/data/apiGateway';
import { readLedgerQueue, type QueueScopes } from '@/data/storedActs';
import { deleteEvidence, evidenceAvailable, listEvidence, putEvidence, retryEvidence } from '@/data/evidenceStore';
import { clearVisitPhotoStart, clearVisitPoster, failVisitPhotosOn, listVisitPhotos, moveVisitPhotos, posterLapsed, posterWaits, storageAvailable, visitPhotoScope, visitsHeldByPhotos, VisitPhotoUnreadable, withinWait, type SiteVisitAddFileOp, type VisitPhotoRow } from '@/data/visitPhotoStore';
import { parseLocation } from '@/lib/screens';
import { setClampedTimeout, type ClampedTimer } from '@/lib/clampedTimer';
import { reserveCoalesceKey, issueCoalesceKey, consumeCoalesceKey, requisitionCoalesceKey, isMaterialsOpType, normalizeMaterialsOutbox } from '@/lib/materialsKeys';
import { allocateCoalesceKey, musterCoalesceKey, workCoalesceKey, labourRequisitionCoalesceKey, releaseCoalesceKey, isLabourOpType, normalizeLabourOutbox, bindSig } from '@/lib/labourKeys';
import { COMMERCIAL_OP_PERMISSION, advanceCoalesceKey, budgetCoalesceKey, costHeadCoalesceKey, attributionCoalesceKey, measureCoalesceKey, correctionCoalesceKey, billCoalesceKey, billTransitionCoalesceKey, sodGrantCoalesceKey, deductionCoalesceKey, deductionReleaseCoalesceKey, approveCoalesceKey, payCoalesceKey, reverseCoalesceKey, commercialWriteBlocked, readClearsKey, isCommercialOpType, type CommercialRead, normalizeCommercialOutbox } from '@/lib/commercialKeys';
import { checkinClock, todayCivil } from '@/lib/civilDate';
import { hasStamp, type CaptureStamp } from '@/lib/captureStamp';
import { buildWorkerFingerprints } from '@/lib/labourSelection';
import { emitGuideOutcome, guideRunToken, recordGuidedDrawing, recordGuidedPhotoPick } from '@/guide/outcomes';
import { saveSession, clearSession, loadSession } from '@/lib/sessionPersist';
import { readDeviceLang } from '@/lib/langPreference';

/**
 * The project to open on a cold load: from the URL (`/projects/:id/…`) so a refresh or a
 * shared deep-link restores it, else the default. Only honoured in API mode — the local demo
 * has a single seeded project, so an arbitrary URL id would mislabel the seeded data.
 */
function initialProjectId(): string {
  if (!API_BASE) return PROJECT_ID;
  const fromUrl = typeof window !== 'undefined' ? parseLocation(window.location.pathname).projectId : null;
  return fromUrl ?? PROJECT_ID;
}

/**
 * The screen to open on a cold load: from the URL so a refresh or deep link restores where you
 * were, before the router effects run (otherwise the store→URL sync clobbers the deep link with
 * the default). Role-gating still happens in RouteBridge; falls back to the universal home.
 */
/** What a new-project create came to (legacy-copy recovery). `created` is final even when `opened`
 *  is false — the project exists, so the dialog closes and must not invite a duplicate retry.
 *  `refused`: a DEFINITE refusal (`isTerminalOutboxError`, or nothing was sent): nothing was made, and the
 *  message says why. `unknown`: no answer, a 5xx, or a 401/408/429 — or another attempt holds the create:
 *  no NEW create starts, and an unconfirmed attempt is finished only by `retryProjectCreate`, under its own
 *  idempotency key. `stale`: the signed-in user changed while it was out; the reply is dropped. */
export type CreateProjectOutcome =
  | { kind: 'created'; projectId: string; opened: boolean }
  | { kind: 'refused'; message: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'stale' };

function initialScreen(): ScreenKey {
  const fromUrl = typeof window !== 'undefined' ? parseLocation(window.location.pathname).screen : null;
  return fromUrl ?? 'dashboard';
}

/** Issue-decision payload from the UI: an option may carry a captured photo (base64),
 *  uploaded first so it becomes the created option's photoUrl. */
export interface IssueDecisionPayload extends Omit<NewDecisionInput, 'options'> {
  options: (NewDecisionInput['options'][number] & { photo?: { mime: string; data: string } })[];
}

/** A single unsubmitted local field edit: the value the engineer set and the
 *  monotonic revision at which they set it (gate round 6). */
export interface FieldMark<T> { rev: number; value: T; }
/** Unsubmitted per-field checklist edits, keyed by inspection id then inspection-item id, scoped to
 *  ONE scope-generation. `rev` is a monotonic counter shared across all fields so a later edit always
 *  outranks an earlier one.
 *
 *  Keyed by INSPECTION rather than holding one at a time: with more than one checklist issued the
 *  engineer can move between them, and a single-inspection record dropped the other's unsubmitted
 *  work the moment they typed in the second. */
export interface ChecklistMarks {
  generation: number;          // the projectScopeGeneration they were made under
  rev: number;                 // monotonic edit counter, shared across inspections
  byInspection: Record<string, Record<string, { state?: FieldMark<ItemState>; note?: FieldMark<string> }>>;
}

/** The submission lifecycle of the checklist (gate round 8). Once the engineer
 *  dispatches a submit the payload is FROZEN — no further edits until the outcome:
 *  - `submitting`  an online submit is in flight (in-memory; a reload resolves it
 *                  from the server's next snapshot);
 *  - `queued`      an offline submit is queued (durable in the outbox, so the
 *                  freeze is rebuilt after a reload);
 *  - `idle`        nothing pending — editable, unless the SERVER already confirms
 *                  the checklist `submitted` (that is read-only on its own).
 *  Scoped to one (inspection, generation): a re-auth / project switch strands it. */
export type ChecklistSubmissionStatus = 'idle' | 'submitting' | 'queued';
export interface ChecklistSubmission {
  inspectionId: string | null;
  generation: number;
  status: ChecklistSubmissionStatus;
  // A unique, monotonic id for the ONLINE submit dispatch that owns this state
  // (gate round 10). The (project, generation) scope guard (round 9) cannot tell
  // two dispatches apart WITHIN one session — a delayed response from a superseded
  // submit shares the live generation. Each online dispatch stamps a fresh attempt
  // here; its continuation ignores itself once `attempt` no longer matches (a newer
  // submit, or a socket-delivered checklist swap that retired it). 0 = no in-flight
  // online attempt owns this state.
  attempt: number;
}

/** Gate round 11 — central snapshot ordering. A full project snapshot has SCOPE
 *  identity (project + generation) but, before this, no freshness/ownership
 *  ordering: any producer whose (project, generation) still matched could apply
 *  its snapshot last-response-wins — so a slow offline replay could overwrite a
 *  newer socket refresh or online submit. A `SnapshotLease` stamps every producer
 *  with a monotonic sequence captured when its request STARTS; only the newest
 *  eligible lease may apply. Applying returns one of these outcomes; a caller must
 *  consume the result and never announce success unless it is `applied`. */
export type SnapshotApplyResult = 'applied' | 'superseded' | 'scope-moved' | 'invalid-project';
export interface SnapshotLease {
  scope: ProjectScope;
  sequence: number;
}

/** Structured outcome of a durable-outbox flush, keyed by each processed op's idempotency key.
 *  Queue ABSENCE alone never proves success (a terminal 4xx also removes the op), so a caller that
 *  needs to confirm ITS OWN commands classifies by these keys: `succeededKeys` (replayed OK),
 *  `droppedKeys` (terminally rejected — a 4xx, discarded), `pendingKeys` (still queued: transient
 *  stop / scope-moved remainder / offline). `ran` is false when this call coalesced behind an
 *  in-flight flush (deferred to that flush's rerun) or there was no gateway / nothing to flush. */
/** #482 — how an act went, as the in-app guide hears it: taken by the server, refused, or (offline, or left to send again)
 *  kept on this phone to send, or not kept */
type ActReport = 'sent' | 'failed' | 'queued' | 'not-kept';

export interface OutboxFlushResult {
  ran: boolean;
  scopeMoved: boolean;
  succeededKeys: string[];
  droppedKeys: string[];
  pendingKeys: string[];
  /** What this flush had to say, held for a caller that says its own acts' word (`ownWord`): the other commands' lines,
   *  then the counts and refusals. Set only on that caller's own run, in the scope it ran in (#1134 residual) */
  word?: string;
}

/** The read slices a committed command's reconcile can be owed for (live bug 1b). */
export type ReconcileSlice = 'decisions' | 'dailyLog' | 'drawings' | 'inspections' | 'activities';
export const RECONCILE_SLICES: readonly ReconcileSlice[] = ['decisions', 'dailyLog', 'drawings', 'inspections', 'activities'];
export const noReconcileOwed = (): Record<ReconcileSlice, boolean> =>
  ({ decisions: false, dailyLog: false, drawings: false, inspections: false, activities: false });

/** How long one module-owned read may take before the pull treats it as failed (Codex 4211133323). */
export const MODULE_READ_TIMEOUT_MS = 30_000;

export interface AppState {
  role: Role;
  screen: ScreenKey;
  lang: Lang;
  notifOpen: boolean;
  /** The universal create control's menu is open. Shell state, like `notifOpen`: the trigger
   *  lives in `LeftRail` (desktop) and the flow renders in `AppShell`, so the flag is shared
   *  rather than duplicated. Whether it may be ACTED on is a separate question — see
   *  `projectDataUsable`, which every reader applies. */
  createOpen: boolean;
  toast: string | null;
  modal: ModalState;
  decisions: Decision[];
  // Phase 2 Task 9 — when decisionsReadMode() === 'moduleQuery', `decisions` is owned by the
  // module-owned read (XOR), and these track its explicit load state for the decision surfaces:
  // 'idle' (snapshot-owned, the default mode), 'loading', 'ready', or 'error' (fetch failed — the
  // last-good decisions are kept and a Retry boundary is exposed). `decisionsSource` records whether
  // the projection or its live fallback served the current data.
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  /** Live bug 1 (Codex 4204448859) — the CURRENT scope owes a committed command its confirmed truth:
   *  the command's own snapshot landed (notifications included) but the reads it does not carry (every
   *  module-owned slice) are still the pre-command ones until the reconcile lands. While true, no screen
   *  or notice may judge a record's state or absence from those slices. Mirrors the scope coordinator's
   *  command obligation; set when it is scheduled, cleared when a confirming snapshot clears it. */
  commandReconcilePending: boolean;
  /** Live bug 1b (Codex 4209988801) — WHICH slices the owed reconcile is still owed for. A slice is
   *  cleared as soon as a post-command pull refreshes IT (the applied snapshot for a snapshot-owned
   *  slice, its own successful read for a module-owned one), so one failed module read leaves only that
   *  slice unsettled, never every other. `commandReconcilePending` is true while any slice is owed. */
  commandReconcileOwed: Record<ReconcileSlice, boolean>;
  decisionsSource: 'projection' | 'live' | null;
  // Phase 2 Task 10 — the daily-log XOR read-ownership state, mirroring decisions. When
  // dailyLogReadMode() === 'moduleQuery', `dailyLog` + `materials` are owned by the module-owned read;
  // these track its explicit load state for the daily-log surfaces ('idle' in snapshot mode).
  dailyLogLoad: 'idle' | 'loading' | 'ready' | 'error';
  dailyLogSource: 'projection' | 'live' | null;
  // a committed daily-log start/submit still awaiting its module read (see ModuleReadState)
  dailyLogReconcileAfter: number | null;
  dailyLogReconcileKind: 'start' | 'send' | null;
  /** #482 site photos — a photo filed on the log on screen was deleted: its photo count is not shown until a pull that
   *  BEGAN after the delete's answer brings the server's own count (the snapshot sequence then; null = the count holds) */
  dailyLogPhotoCountAfter: number | null;
  // Phase 2 Task 10 (Module 2 — Drawings) — the drawings XOR read-ownership state, mirroring decisions.
  // When drawingsReadMode() === 'moduleQuery', `drawings` is owned by the module-owned read (baked
  // per-viewer); these track its explicit load state for the drawing surfaces ('idle' in snapshot mode).
  drawingsLoad: 'idle' | 'loading' | 'ready' | 'error';
  drawingsSource: 'projection' | 'live' | null;
  // Phase 2 Task 10 (Module 3 — Inspections) — the inspections XOR read-ownership state, mirroring
  // drawings. When inspectionsReadMode() === 'moduleQuery', the inspection slices (checklist / reviews /
  // review / reinspectionCreated / placedInspections) are owned by the module-owned read (baked per-
  // viewer/role); these track its explicit load state for the inspection surfaces ('idle' in snapshot mode).
  inspectionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  inspectionsSource: 'projection' | 'live' | null;
  // Phase 2 Task 10 (Module 4 — Activities) — the activities XOR read-ownership state, mirroring
  // inspections. When activitiesReadMode() === 'moduleQuery', the activity spine (`activities` +
  // `phases`) is owned by the module-owned read (readiness baked fresh on both paths); these track its
  // explicit load state for the schedule surfaces ('idle' in snapshot mode).
  activitiesLoad: 'idle' | 'loading' | 'ready' | 'error';
  activitiesSource: 'projection' | 'live' | null;
  // Phase 2 Task 9 — the enabled module ids from the project-shell summary (the single enablement
  // source). Drives manifest-driven nav: a screen whose module is disabled is hidden. Empty = not yet
  // loaded → the nav shows every role screen (no flash), matching today's behaviour.
  enabledModules: string[];
  // Phase 3 Task 7 (§D) — the PER-PROJECT pilot capabilities from the shell (`['materials']` on a pilot
  // project, `[]` otherwise). The Materials nav/screens gate on `'materials'`, so a non-pilot project
  // shows none. Project-owned → torn down on scope change (never leaks a pilot flag across a switch).
  capabilities: string[];
  // Phase 4 Task 6 correction (Codex F-deeplink) — whether the ACTIVE project's shell has reported
  // its capabilities yet. `false` (unknown) means RouteBridge must NOT bounce a capability-gated
  // deep link — a cold `/projects/<pilot>/labour` load would otherwise be ejected before the shell
  // lands. Once `true`, a capability-gated screen the project lacks is redirected like any
  // forbidden screen. Project-owned → reset on every scope change with `capabilities`.
  capabilitiesKnown: boolean;
  // Phase 6 task 4d-ii-b / B1 — the architect chain's rollout state from the shell (`rollout.phase6_4d`):
  // `'reserved'` while 4d-i's doors stand, `'open'` once 4d-iii drops them. The ONE value every client
  // gate on an architect shape reads (B2's pickers and persona switchers, B5b's Forward affordance).
  // `'reserved'` until a shell read for THIS project says otherwise — never assumed open, and a shell
  // from a server older than A5b (no `rollout` field) reads as reserved too. Project-owned → torn down
  // to `'reserved'` on every scope change, so a switch never carries one project's state to another.
  phase6_4dRollout: Phase6_4dRollout;
  // Phase 3 Task 7 — the pilot Materials bundle + its module-query load status (greenfield, no snapshot
  // fallback → no `source`). `null`/'idle' on a non-pilot project; the pilot's shell load triggers it.
  materialsView: MaterialsView | null;
  materialsLoad: 'idle' | 'loading' | 'ready' | 'error';
  // Phase 3 Task 7 (correction 2) — the SERVER-computed reservation plan per activity whose cover UI is
  // open (keyed by activityId), and the in-flight materials command keys (coalesce + disable-while-
  // pending). Both project-owned (torn down on scope change via emptyProjectData).
  reservationPlans: Record<string, ReservationPlan>;
  materialsPending: string[];
  // Phase 4 Task 6 (§J) — the pilot LABOUR bundle + its module-query load status + the in-flight
  // labour field-op coalesce keys. Same discipline as materials: greenfield module reads (no
  // snapshot fallback), `null`/'idle' off-pilot, project-owned → torn down on scope change.
  labourView: LabourView | null;
  labourLoad: 'idle' | 'loading' | 'ready' | 'error';
  // Phase 5 Task 7B-i (§M) — the pilot COMMERCIAL money-position bundle and its module-query load
  // status. Same discipline again: greenfield module reads with no snapshot fallback,
  // `null`/'idle' off-pilot, project-owned → torn down on scope change. 7B-i was READ ONLY and
  // said so here; 7B-iii-a lands the first §M writes, hence `commercialPending` above.
  commercialView: CommercialView | null;
  commercialLoad: 'idle' | 'loading' | 'ready' | 'error';
  /** Task 7B-ii — the claim LIST and, per claim, its whole lifecycle. Keyed by bill id because a
   *  user opens one claim at a time and the previously-opened one stays useful while they look at
   *  another; a single-slot field would blank the first the moment the second was clicked. */
  commercialBills: CommercialBillRow[] | null;
  commercialBillsLoad: 'idle' | 'loading' | 'ready' | 'error';
  commercialClaims: Record<string, CommercialClaimView>;
  commercialClaimLoad: Record<string, 'loading' | 'ready' | 'error'>;
  /** 7B-vi (§H) — the advances read. Project-scoped like every other commercial read, and a
   *  SINGLE slot rather than a per-vendor map: the read carries the whole project's advances in
   *  one snapshot, because `recoverable` is a fold and rows read apart from positions can state a
   *  set of advances and a ceiling that were never true together. */
  commercialAdvances: VendorAdvanceListDto | null;
  commercialAdvancesLoad: 'idle' | 'loading' | 'ready' | 'error';
  /** §D — the cap RESERVATION each pending write holds, keyed by its COALESCE KEY.
   *
   *  Keyed by the coalesce key, not by line, so the reservation's lifecycle IS the key's: round 3
   *  rebuilt a per-line map from the live outbox on every read, and a money read landing after the
   *  op left the outbox dropped the reservation while the KEY was still retained — the cap freed
   *  authority the screen had not yet been told about. Two structures with two rules disagree; one
   *  structure keyed by the other cannot. */
  commercialPendingQty: Record<string, { lineId: string; qty: string }>;
  /** §D — per-LINE measurement registers, and the read a measurement becomes VISIBLE in. */
  commercialLineRegisters: Record<string, MeasurementRegisterDto>;
  commercialLineRegisterLoad: Record<string, 'loading' | 'ready' | 'error'>;
  /** Task 7B-iii-a (§M) — coalesce keys of commercial commands in flight (disable-while-pending). */
  commercialPending: string[];
  labourPending: string[];
  // Codex round 13 — the ORIGINAL allocate input per retained coalesce key (the key alone loses
  // `capacityCommitmentId`, so a resolved supplier draw stopped reserving its commitment in the
  // success→reload gap). Same lifecycle as `labourPending`; torn down with the scope.
  labourPendingInputs: Record<string, AllocateLabourInput>;
  labourOnboardPending: Record<string, string>;
  labourBindPending: Record<string, string>;
  nodeCreatePending: Record<string, NodeCreatePending>;
  nodes: ProjectNode[]; // the project location tree (zones → rooms → elements)
  /** the Site Map's pending focus when it is entered from a location breadcrumb (project-owned) */
  placeFocus: string | null;
  /** U2b — the decision the client's decisions screen shows on its own screen (project-owned) */
  decisionFocus: string | null;
  /** Audit F-02 — the activity the schedule brings into view when opened from a place (project-owned) */
  activityFocus: string | null;
  /** #633 — the Site Map place a record was opened from, offered as the way back on that screen (project-owned) */
  returnPlace: { nodeId: string | null; screen: ScreenKey; item: string | null } | null;
  /** B6 — the one item the current screen's URL names (place, open drawing, highlighted decision; project-owned) */
  routeItem: string | null;
  checklist: Checklist | null; // null = no checklist issued for this project (never a ''-id sentinel)
  /** EVERY open (issued, unsubmitted) checklist. `checklist` is the one the field view opens;
   *  this is the whole outstanding set, so a second issued checklist no longer hides the first
   *  and the PMC who issued them can see what is still out on site. */
  openChecklists: Checklist[];
  /** Which open checklist the engineer chose to work on; null ⇒ whichever one the server serves as
   *  the default. Held rather than derived so it SURVIVES a snapshot refresh: without it every
   *  background refresh would drag them back to the server's default mid-inspection. */
  selectedChecklistId: string | null;
  // Unsubmitted per-field checklist edits (gate round 6). The engineer's marks
  // live only in this client until they submit; any snapshot refresh — this
  // upload's own OR a concurrent useApiSync `changed` refresh — would otherwise
  // discard them. Each field records the value the engineer set AND a monotonic
  // revision, keyed by inspection-item id, so applySnapshot restores the LATEST
  // per-field intent (including an intentional clear — state→null / note→'') by
  // an explicit edit record, never by value comparison (which cannot tell an
  // intentional clear from a background wipe). Scoped to one (inspection,
  // generation); reset when the checklist changes, the scope moves, or on submit.
  checklistMarks: ChecklistMarks;
  // The checklist's submission lifecycle (gate round 8). While a submit is pending
  // (submitting / queued) — or the server already confirms `submitted` — the
  // checklist is FROZEN: no edit may change the payload. A failure unlocks it
  // without losing the marks; an offline-queued submit's freeze survives a reload
  // (rebuilt from the durable outbox by `reconcileSubmission`).
  submission: ChecklistSubmission;
  reviews: Review[]; // the PMC review queue (submitted, undecided inspections)
  activeReviewId: string | null; // which queued review the PMC is looking at (null ⇒ first pending)
  reinspectionCreated: boolean;
  drawings: Drawing[]; // the drawings register (Slice 1)
  photos: Photo[]; // site photos placed on the location tree (the Place view's reality layer)
  /** #482 site photos — the viewer's own site photos still in their delete hour past the newest window `photos` holds
   *  (the snapshot's `myDeletablePhotos`), so that hour's Delete is never out of reach; never counted as photos */
  myDeletablePhotos: Photo[];
  /** #482 site photos — a delete took a photo out of a full window: its count stays a floor until a snapshot rebuilds
   *  the window (Codex 4337661439) */
  photosWindowShort: boolean;
  /** #917 — this project's site photos whose online send lost its answer, read from their rows on this phone (their
   *  outbox ops carry the key only), so the Dashboard shows them as queued; rebuilt from the rows at each flush */
  sitePhotosKept: KeptSitePhoto[];
  materials: Material[]; // all deliveries across the project, with their place (Site Map)
  placedInspections: PlacedInspection[]; // inspections on the tree for the Site Map (pmc/engineer only)
  phases: Phase[]; // project phases with rollups (Orgs Slice 3)
  // multi-project (Orgs Slice 2)
  activeProjectId: string; // the project the session is scoped to
  memberships: MembershipSummary[]; // projects the user can switch between
  myOrgs: OrgSummary[]; // orgs the user administers/belongs to
  orgMembers: OrgMember[]; // the active org's admin roster (owner/admin/member)
  orgModules: OrgTemplateModule[]; // the org's reusable structure modules (Templates Slice 2)
  orgTemplates: OrgProjectTemplate[]; // the org's named presets (Templates Slice 3)
  members: ProjectMember[]; // the active project's team (Team screen)
  portfolio: PortfolioProject[]; // cross-project monitoring rollup (Orgs Slice 3)
  /** U3b — the PMC's cross-project daily brief (`GET /me/brief`); null until a server answers */
  brief: PmcBriefResult | null;
  /** when `brief` was read (epoch ms); the screen shows it only while fresh (`briefIsFresh`) */
  briefAt: number | null;
  online: boolean;
  syncQueue: string[];
  outbox: OutboxOp[];
  /** WEB-02 step A: this scope's queue keys this release cannot read, and whether the last Set aside could not copy them */
  queueUnreadable: UnreadableKey[]; queueSetAsideFailed: boolean;
  /** SV2: the visits whose acts the last flush held behind a photo this phone may still keep but could not read, for the
   *  project and sign-in it ran in; null when it held none. The Site Visits screen says so, with "Send anyway". */
  siteVisitsHeld: { project: string; generation: number; visits: string[] } | null;
  /** SV2: the held visits the person chose to send anyway (`sendSiteVisitAnyway`), by user, project and visit; memory
   *  only, so a reload holds them again until the phone can read its photos. */
  siteVisitsSentAnyway: string[];
  /** #482 site photos unit 3 — this device's online photo uploads for a log, from the pick until the server's own
   *  count is seen to hold them (`dailyLog.myPhotoKeys`), or until a pull begun after its answer (`after`, the snapshot
   *  sequence then) carried the log: one deleted before any read named it is then not counted for ever (#1195 gap-check);
   *  memory only (a reload re-reads the server's count). */
  photoUploadsInFlight: { clientKey: string; dailyLogId: string; settled: boolean; after?: number }[];
  /** #482 site photos — the upload keys of this tab's site photo uploads sent online and not yet answered (an answer of
   *  any kind, or a network error, ends one); memory only, as the request itself is */
  photoUploadsSending: string[];
  /** #482 (Codex 4403491374, 4403818412) — the review decisions this tab sent and has not settled yet, one entry each,
   *  named by the project and person they were sent for (`reviewSendingScope`): sent online with no answer, or replayed from
   *  the queue by a flush that has not ended (its row leaves the queue before the flush's snapshot is taken); memory only,
   *  as the request itself is. The review guide points at no decide control while one of the current scope's is on its
   *  way (`reviewDecisionWaits`), so a second press is never guided into a second decision; one sent for another project
   *  or person holds nothing back here (#1220), while one for this project still does after a switch away and back */
  reviewDecisionsSending: string[];
  /** FAILED evidence (terminal non-dedupe rejection) awaiting the user's Retry/Delete (Task 4),
   *  each row still carrying WHICH work it belongs to. `inspectionId` /
   *  `inspectionItemId` are kept because Delete on this list is the one non-server path that drops
   *  bytes permanently, and the panel is project-wide while the checklist picker is not: without the
   *  association, switching to checklist B put A's retained photo under a Delete button labelled only
   *  `upload rejected (400)` (#571 round 7, finding 4). */
  failedEvidence: { clientKey: string; reason: string; mime: string; inspectionId: string; inspectionItemId: string }[];
  /** evidence photos durably saved offline, awaiting upload (Task 4) */
  pendingEvidenceCount: number;
  /** #482 site photos — the upload keys of those pending evidence rows, as last read from IndexedDB; null until they have
   *  been read for this scope (a reload, a sign-in or a project switch empties it), so a delete can wait for them */
  pendingEvidenceKeys: string[] | null;
  access: AccessState;
  activities: Activity[];
  dailyLog: DailyLog | null; // null = no daily log started for this project
  // #669 Today regression — the engineer's UNSENT work on `dailyLog` (check-in, crew counts, photos
  // taken) as the canonical project- and log-scoped pending draft: every reconcile overlays it onto
  // the server's log, it is persisted beside the outbox (same user + project key) and dropped once
  // the server's log is no longer the one it was written against (see store/dailyLogDraft.ts).
  dailyLogDraft: DailyLogDraft | null;
  // Owner ruling (#692) — a draft written by a release before the log carried its id, met by a log
  // that has one: nothing in it proves which log of its civil day it was for, so it is never laid
  // over the log. It is kept here, intact and persisted beside the draft, until the engineer adds it
  // to this log (same unsent civil day only) or discards it.
  legacyDailyLogDraft: DailyLogDraft | null;
  notifications: AppNotification[];
  /** Top 10 #4b unit D (#778) — the bell's per-notice read marks (project-owned; see lib/notificationSeen.ts). */
  notifSeen: NotifSeenState;
  // real session (set by a phone-OTP sign-in; null = passwordless dev auth)
  /** Legacy-copy recovery — the create hold the new-project dialog shows, DERIVED for the signed-in
   *  identity from its durable record and this document's own reservations (`./projectCreateHold`). It is
   *  re-derived by `syncProjectCreateHold`, never written as truth. */
  projectCreateHold: CreateHoldView;
  sessionToken: string | null;
  userName: string | null;
  /** Phase 6 task 4b (§A.3) — the signed-in USER id (the JWT's `sub`), the viewer half of the
   *  shared viewer/decider predicate: a named member-decider is recognised by comparing this to
   *  `Decision.deciderUserId`. Null under dev/demo auth — an unknown viewer is simply never the
   *  named decider (the server remains the authority; this only mirrors its filter). */
  sessionUserId: string | null;
  // live project identity — seeded from PROJECT, replaced wholesale by each snapshot
  // (so switching projects re-labels every screen; never read the PROJECT seed in a screen)
  name: string;
  short: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  location: string;
  /** Phase 4 Task 6 correction (Codex F-TZ) — the project's IANA timezone from the snapshot
   *  (`null` until known / in the local demo). The server evaluates execution readiness against
   *  `clock.today(project.timeZone)`, so field surfaces stamping a civil "today" (the manual
   *  muster, the presence read) MUST derive it from this — never the browser's local date. */
  timeZone: string | null;
  projStart: string;
  projEnd: string;
  /** Task 6: the schedule anchor (the civil day offset 0 refers to) + real window end */
  scheduleStartDate: string | null;
  scheduleEndDate: string | null;
  elapsedPct: number;
  todayDay: number;
  milestonePct: number;
  /** The project-scope lifecycle (Phase 0 Task 2). A switch empties project data
   *  in the same set() that marks it 'switching', so old records can never render
   *  or arrive under the next project's identity. */
  pendingProjectId: string | null; // the project a switch is negotiating for (null = none)
  projectScopeGeneration: number; // bumped on every scope change; stale responses are dropped
  projectLoadState: ProjectLoadState;
  projectLoadError: string | null; // user-readable, recoverable (set with loadState 'error')
  // firms & consultants on the active project (client company, contractor, MEP/structural, …)
  companies: ProjectCompany[];
  // archived projects (owner/admin restore UI, lazy-loaded)
  archivedProjects: ArchivedProject[];
}

export interface AppActions {
  // shell
  setRole: (role: Role) => void;
  signOut: () => void;
  /** the sign-out teardown (round-1 Codex F1: runs after the bounded push unlink on a
   *  push-capable browser; directly everywhere else) */
  completeSignOut: () => void;
  setScreen: (k: ScreenKey) => void;
  /** open the Site Map focused on one location — the breadcrumbs' navigation door */
  openPlace: (nodeId: string | null) => void;
  /** the Site Map has adopted `placeFocus` and will not re-adopt it */
  clearPlaceFocus: () => void;
  /** Audit F-02 — open the schedule with one activity brought into view (from a place's Work list) */
  openActivity: (activityId: string, fromPlace?: { nodeId: string | null }) => void;
  /** the schedule has shown `activityFocus` and will not re-show it */
  clearActivityFocus: () => void;
  /** U2b — open one decision on its own screen (the Pulse's "one thing needs you") */
  openDecision: (decisionId: string) => void;
  /** …and back to the list of decisions */
  closeDecision: () => void;
  /** B6 — open the Drawings register with one drawing in the viewer */
  openDrawing: (drawingId: string, fromPlace?: { nodeId: string | null }) => void;
  /** B6 — name (or clear) the current screen's item; the URL follows it (RouteBridge) */
  setRouteItem: (item: string | null) => void;
  /** Live bug 1 — open a screen AT one of its records (a notification tap): the screen, its item
   *  (a client's decision focus on `client-decisions`), and the panel closed, in one step. */
  openItem: (screen: ScreenKey, item: string | null, fromPlace?: { nodeId: string | null }) => void;
  setLang: (l: Lang) => void;
  toggleNotif: () => void;
  /** Top 10 #4b unit D (#778) — opening the bell marks the displayed unread notices seen, in sequential
   *  chunks of at most 200, suppressing an id only while its mark is in flight or once the server confirms it. */
  markShownNotificationsSeen: () => Promise<void>;
  openCreate: () => void;
  closeCreate: () => void;
  flash: (msg: string) => void;
  openQr: () => void;
  closeModal: () => void;
  // decisions
  openApprove: (decId: string, optIdx: number) => void;
  confirmApprove: () => void;
  /**
   * Phase 6 unit 4c-ii — ask a named member for advice on an open decision (pmc), and answer as
   * the named consultee. Both go through the durable outbox under ONE stable key, so a
   * lost-response retry records the append-only fact exactly once.
   */
  requestConsultation: (decId: string, consulteeMembershipId: string, question: string) => void;
  respondToConsultation: (decId: string, consultationId: string, response: string, recommendedOptionIndex?: number) => void;
  openChange: (decId: string) => void;
  submitChange: () => void;
  /** Withdraw the open change request — the decision re-locks (requester or PMC only). */
  withdrawChange: (decId: string) => void;
  /**
   * Phase 6 task 4d-ii-b / B5a — the four countersign-chain commands (4d-ii-a / A8a, A8b), WRITE-AHEAD to
   * the durable outbox under ONE fresh idempotency key per act: a lost or uncertain response replays the
   * SAME act under the SAME key, and an equivalent act still pending on the same decision is coalesced
   * (a double-click runs once) — while a LATER act of the same kind, after the first settles, is a new
   * act under a new key (self-countersign stays two explicit acts under two keys, P32's client half).
   * The server's refusal (409 while the doors stand, an ineligible state, a lesser client under an active
   * chain) is surfaced as the server's own message. No UI in this unit (B5b's); no demo-mode fabrication:
   * without the server these do nothing but say so.
   */
  forwardDecision: (decId: string, input: ForwardDecisionInput) => void;
  countersignDecision: (decId: string) => void;
  disagreeDecision: (decId: string, input: DisagreeDecisionInput) => void;
  resolveStrandedCountersign: (decId: string, input: ResolveStrandedCountersignInput) => void;
  /** Withdraw a PUBLISHED, never-approved decision — pmc only, reason required (Phase 6 task 4a). */
  openWithdraw: (decId: string) => void;
  confirmWithdraw: () => void;
  setWithdrawReason: (v: string) => void;
  setChangeText: (v: string) => void;
  setChangeCost: (v: string) => void;
  setChangeTime: (v: string) => void;
  // inspection (engineer checklist)
  /** Move the edit slot to another OPEN checklist. Unsubmitted work on the one being left is not
   *  lost: marks are recorded per inspection, so switching back restores it. A no-op for an id that
   *  is not currently outstanding. */
  selectChecklist: (id: string) => void;
  setItem: (idx: number, val: Exclude<ItemState, null>) => void;
  addPhoto: (idx: number) => void;
  /** Capture REAL evidence for a checklist item (Task 4): durably stored (IndexedDB)
   *  BEFORE any success message, uploaded now or on reconnect, exactly once. */
  /** `capturedOn` is the checklist the photo was TAKEN on, pinned by the caller before the async
   *  file read — the edit slot can move while it runs. */
  addChecklistEvidence: (idx: number, dataUrl: string, capturedOn?: string) => Promise<void>;
  /** The user's Retry on a failed evidence photo — re-queues with the SAME clientKey. */
  retryFailedEvidence: (clientKey: string) => Promise<void>;
  /** The user's explicit Delete of a failed evidence photo — the ONLY non-server path that drops bytes. */
  deleteFailedEvidence: (clientKey: string) => Promise<void>;
  /** Refresh the pending/failed evidence mirrors from IndexedDB (reload/scope change). */
  hydrateEvidence: () => Promise<void>;
  setNote: (idx: number, txt: string) => void;
  submitInspection: () => void;
  // inspection (pmc review)
  setActiveReview: (id: string) => void;
  toggleReject: (idx: number) => void;
  approveInspection: () => void;
  sendReinspection: () => void;
  // drawings register
  issueDrawing: (input: IssueDrawingInput) => void;
  /** Publish a private draft drawing → issue it to the build team (works offline in the demo). */
  publishDrawing: (drawingId: string) => void;
  acknowledgeDrawing: (drawingId: string) => void;
  // location spine: re-file a drawing / photo onto a location node (null = unfile)
  fileDrawing: (drawingId: string, nodeId: string | null) => void;
  filePhoto: (photoId: string, nodeId: string | null) => void;
  // multi-project + team
  loadOrgData: () => void;
  loadPortfolio: () => void;
  /** U3b — load the PMC's daily brief (session-scoped, like the portfolio) */
  loadBrief: () => void;
  /** #482 QA — the "Awaiting client" summary from the server; null with no server (the local demo), where the
   *  caller reads the seeded decisions instead. The caller keeps the rows and drops a reply from another scope. */
  fetchAwaitingClient: () => Promise<Awaited<ReturnType<ApiGateway['awaitingClient']>> | null>;
  loadShell: () => void;
  /** Phase 3 Task 7 — fetch the pilot Materials bundle (readiness + requirements + procurement + POs +
   *  stock + issues) together, ONLY when the active project has the `materials` capability. Scope-guarded
   *  + honest load states; a non-pilot project is a no-op (the surfaces are absent from nav). */
  loadMaterials: () => void;
  /** Phase 3 Task 7 (correction 2) — the pilot MATERIALS operational commands. NO browser-side
   *  multi-command orchestration: the shortage is covered by EXPLICIT single commands the user drives —
   *  reserve a SERVER-offered candidate, or raise ONE requisition for the server-computed residual. Each
   *  command is WRITE-AHEAD to the durable outbox with a STABLE idempotency key before the network send
   *  (a lost/uncertain response replays under the SAME key), coalesced while pending, scope-guarded, and
   *  reconciled through loadMaterials after the flush. Every one is a no-op off-pilot (capability-gated). */
  /** Fetch the SERVER's canonical reservation plan for one activity's shortage (candidates + residual). */
  loadReservationPlan: (activityId: string) => void;
  /** Reserve ONE server-offered candidate: exact (lotId, storeLocation, qty) to the activity. Keyed by
   *  (lotId, storeLocation, activityId) so a double-click/lost-response replay reserves exactly once. */
  reserveCandidate: (activityId: string, lotId: string, storeLocation: string, qty: string) => void;
  /** Raise ONE requisition for the residual shortage the server computed (never a fan-out of commands). */
  raiseRequisition: (activityId: string, title: string, lines: ReadonlyArray<{ requirementId: string; revision: number; qty: string }>) => void;
  /** Issue reserved stock from a SPECIFIC store location to the activity (creates the §E MaterialIssue). */
  issueMaterial: (lotId: string, storeLocation: string, activityId: string, qty: string) => void;
  /** Record consumption against a §E MaterialIssue. */
  consumeMaterial: (issueId: string, qty: string) => void;
  /** Phase 4 Task 6 (§J) — fetch the pilot LABOUR bundle (readiness + demand + workforce + catalog +
   *  commercial chain + capacity + today's presence + productivity) together, ONLY when the active
   *  project has the `labour` capability. Scope-guarded + honest load states; a no-op off-pilot. */
  loadLabour: () => Promise<void>;
  /** Phase 5 Task 7B-i (§M) — fetch the money-position bundle. Inert off the `commercial` pilot,
   *  scope-guarded, and latest-request owned: an older reply (success OR failure) never overwrites
   *  a newer one. READ ONLY — the §M write actions and their outbox lifecycle land in 7B-iii. */
  loadCommercial: () => Promise<void>;
  loadCommercialBills: () => Promise<void>;
  loadCommercialClaim: (billId: string) => Promise<void>;
  /** 7B-vi (§H) — loads the advances AND settles the advance key. No claim read can: an advance
   *  names a counterparty and no claim. */
  loadCommercialAdvances: () => Promise<void>;
  payAdvance: (vendorId: string, amount: string, reason: string, method: string, reference: string | null) => void;
  loadCommercialLineRegister: (labourPoLineId: string) => Promise<void>;
  /** §M writes (7B-iii-a). Each dispatches ONE server command through the durable write-ahead
   *  outbox under a fresh idempotency key, coalesced while pending on its deterministic key. */
  setCommercialBudget: (costHeadCode: string, amount: string, reason: string) => void;
  defineCostHead: (code: string, name: string) => void;
  reattributeCommitment: (
    line: { poLineId: string } | { labourPoLineId: string },
    costHeadCode: string,
    reason: string,
  ) => void;
  /** §D/§F writes (7B-iii-b) — the engineer's six, on the SAME lifecycle. */
  takeMeasurement: (input: TakeMeasurementInput) => void;
  correctMeasurement: (measurementId: string, quantity: string, reason: string, labourPoLineId: string) => void;
  recordVendorBill: (input: RecordVendorBillInput) => void;
  submitVendorBill: (billId: string) => void;
  amendVendorBill: (input: AmendVendorBillInput) => void;
  rejectVendorBill: (billId: string, reason: string) => void;
  /** §E/§F writes (7B-iii-c-i) — the verification chain, on the SAME claim lifecycle. */
  beginVerification: (billId: string) => void;
  verifyVendorBill: (billId: string) => void;
  /** §G/§H writes (7B-iii-d) — the payer's SETTLEMENT chain. Four commands, four DISTINCT
   *  permissions, and each names the DOCUMENT it acts on, so an id cannot silently mean a
   *  different row later.
   *
   *  `approvePayment` was deliberately NOT here: it needs server facts this contract did not
   *  expose — the `certifier-may-not-approve` grant state and the claim's current revision — and a
   *  control whose authority is guessed client-side is the write-ahead lie this chain exists to
   *  prevent. 7B-iv adds them contract-first and the control with them. (`payAdvance` is 7B-vi.) */
  recordDeduction: (billId: string, type: string, amount: string, reason: string | null) => void;
  /** Round 4 — each takes the CLAIM as well as the row it acts on. The row is what the SERVER is
   *  told; the claim is what makes the key settleable, because the read that settles it covers a
   *  claim and a row can be gone by the time that read lands. */
  releaseDeduction: (billId: string, deductionId: string, amount: string, reason: string) => void;
  /** the ONE command carrying a viewed-fact pin — the server refuses it if the claim has moved */
  approvePayment: (billId: string, amount: string, lifecycleVersion: number) => void;
  /** §H — names a VENDOR, not a claim: money paid before any claim exists */
  recordPayment: (billId: string, approvalId: string, amount: string, method: string, reference: string | null) => void;
  reversePayment: (billId: string, paymentId: string, amount: string, reason: string) => void;
  /** §I write (7B-iii-g) — the APPROVER authorises one actor for one otherwise-forbidden act.
   *
   *  Carries the three facts the approver was LOOKING AT, all from the one authoritative claim
   *  reading: the version, the status that version was in, and the claim's monotonic revision. The
   *  server refuses the grant if any has moved, so a queued authorisation is refused rather than
   *  silently re-pinned onto a claim its approver never saw. */
  grantSodException: (
    billId: string, actorId: string, reason: string,
    viewed: { versionId: string; status: string; lifecycleVersion: number },
    /** WHICH §I rule is excused. Required rather than defaulted: the two rules govern different
     *  acts, and a caller that does not say which one it means is a caller that will eventually
     *  mean the wrong one. */
    rule: SodRule,
  ) => void;
  /** §F/§I writes (7B-iii-f) — the certification authority chain. */
  /** …and the claim REVISION the certifier read, from the same authoritative claim reading that
   *  offered the button — so a certify queued offline is refused rather than silently re-aimed at
   *  whichever passage of the claim is live when it replays. */
  certifyBill: (billId: string, versionId: string, lifecycleVersion: number) => void;
  supersedeCertificate: (billId: string, reason: string, certificateId: string) => void;
  /** The §J offline/idempotent labour FIELD ops — each ONE server command through the durable
   *  write-ahead outbox (fresh idempotencyKey per action + deterministic coalesceKey while pending,
   *  the materials PR-#208/#209 lifecycle), reconciled through loadLabour after the flush. */
  allocateWorker: (activityId: string, requirementId: string, originRevision: number, civilDate: string, workerId: string, capacityCommitmentId?: string | null, labourSpecFingerprint?: string | null) => void;
  musterWorker: (workerId: string, civilDate: string, shift: 'day' | 'night', manualReason: string) => void;
  recordWorkedMinutes: (allocationId: string, workedMinutes: number) => void;
  raiseLabourRequisition: (title: string, lines: ReadonlyArray<{ requirementId: string; revision: number; civilDate: string; personShiftQty: number }>) => void;
  /** The §J roster commands (Team-screen onboarding; direct, pmc-authored, low-frequency). */
  releaseAllocation: (allocationId: string, reason: string) => void;
  onboardLabourWorker: (name: string, tradeCode: string, skillCodes: string[], activeFrom: string) => void;
  bindLabourDevice: (deviceId: string, workerId: string) => void;
  /** Atomically re-scope to another project. Empties project data BEFORE the auth
   *  request; adopts the SERVER-returned project on success. Resolves true only when
   *  the switch was authenticated. `targetScreen` survives the switch when the new
   *  role is allowed to see it (deep links); `targetItem`, when given, is the one record it opens there
   *  (Top 10 #3 gap 13, #799 — a brief task about one record in another project). */
  switchProject: (projectId: string, targetScreen?: ScreenKey, targetItem?: string) => Promise<boolean>;
  /** Resolves to what happened, so the new-project dialog closes only on a confirmed create and
   *  keeps its inputs with the reason otherwise (see `CreateProjectOutcome`). */
  createProject: (orgId: string, input: NewProjectInput) => Promise<CreateProjectOutcome>;
  /** Finish an UNCONFIRMED create by resending the same attempt under its own idempotency key: the server
   *  replays the first create if it committed, and makes the project once if it did not. */
  retryProjectCreate: () => Promise<CreateProjectOutcome>;
  /** Re-derive `projectCreateHold` for the CURRENT identity — after any create transition, an identity
   *  change, or another tab's change to the record (the dialog's storage event). */
  syncProjectCreateHold: () => void;
  updateProjectDetails: (orgId: string, projectId: string, input: Partial<NewProjectInput>) => void;
  deleteProject: (orgId: string, projectId: string) => void;
  restoreProject: (orgId: string, projectId: string) => void;
  loadArchivedProjects: (orgId: string) => void;
  // companies & consultants
  addCompany: (input: CompanyInput) => void;
  updateCompany: (companyId: string, input: Partial<CompanyInput>) => void;
  removeCompany: (companyId: string) => void;
  // authoring: decisions + planning/scheduling (PMC)
  issueDecision: (input: IssueDecisionPayload) => void;
  /** Publish a private draft decision → issue it to the client (works offline in the demo). */
  publishDecision: (decisionId: string) => void;
  /** Phase 6 task 4b — edit an UNPUBLISHED draft: re-point its decider (kind / named member),
   *  convert to/from a record (`none` ⟺ `recorded` with options replaced as one pair), or
   *  replace its options. Server-only (drafts are server-authored in API mode). */
  /** Resolves true when the server accepted the edit (round-5 Codex F4 — the Drafts screen
   *  holds Publish on the draft while a record⟺choice conversion is in flight). */
  updateDecisionDraft: (decisionId: string, input: UpdateDecisionDraftInput) => Promise<boolean>;
  /** Publish EVERY draft (decisions + drawings) in one action — the Drafts workspace "Publish all". */
  publishAllDrafts: () => void;
  /** Create a zone/room/element and resolve to its new id (for the inline location picker).
   *  `publish: false` keeps it a private draft only its author sees until published. */
  addLocationNode: (input: { name: string; kind: 'zone' | 'room' | 'element'; parentId?: string | null; publish?: boolean }) => Promise<string | null>;
  renameNode: (nodeId: string, name: string) => void;
  /** Publish a private draft location (and its draft branch) — reveals it to everyone (works offline in the demo). */
  publishNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  createActivity: (input: NewActivityInput) => void;
  updateActivity: (activityId: string, input: Partial<NewActivityInput>) => void;
  /** Task 6: record / revoke a manual readiness exception (PMC, server-recorded) */
  overrideGate: (activityId: string, input: OverrideGateInput) => void;
  revokeOverride: (activityId: string, overrideId: string) => void;
  /** Resolves whether the server accepted the deletion (#780: a refused delete releases no route). */
  deleteActivity: (activityId: string) => Promise<boolean>;
  createPhase: (name: string) => void;
  deletePhase: (phaseId: string) => void;
  issueChecklist: (input: { title: string; zone: string; items: string[]; nodeId?: string }) => void;
  startDailyLog: () => void;
  addSiteMaterial: (input: { name: string; qty: string; zone?: string; decisionId?: string; swatch?: string; nodeId?: string }) => void;
  /** Read the project's team; resolves false when the read failed (Site Visits' picker then offers a retry). */
  loadTeam: () => Promise<boolean | void>;
  addMember: (input: AddMemberInput) => void;
  updateMemberRole: (userId: string, role: Role, discipline?: string) => void;
  removeMember: (userId: string) => void;
  // org roster (owner/admin/member)
  loadOrgMembers: (orgId: string) => void;
  /** Load the org's reusable structure modules — the template menu (Templates Slice 2). */
  loadOrgModules: (orgId: string) => void;
  /** Save a zone's subtree (rooms/objects + its checklists) as a reusable org module. */
  saveZoneAsModule: (zoneId: string, zoneName: string) => void;
  /** Load the org's named presets (Templates Slice 3). */
  loadOrgTemplates: (orgId: string) => void;
  /** Save the ACTIVE project's whole structure as a named preset ("G+2 Residence"). */
  saveProjectAsTemplate: (name: string) => void;
  addOrgMember: (orgId: string, input: AddOrgMemberInput) => void;
  updateOrgMemberRole: (orgId: string, userId: string, role: OrgRole) => void;
  correctInvitationEmail: (orgId: string, userId: string, email: string) => void;
  removeOrgMember: (orgId: string, userId: string) => void;
  // schedule
  startActivity: (id: string) => void;
  completeActivity: (id: string) => void;
  // daily log
  checkIn: () => void;
  checkOut: () => void;
  scanWorker: () => void;
  crewStep: (idx: number, delta: number) => void;
  /** U1 — the engineer answered every crew question for the open log (a no-crew day included) */
  confirmCrew: () => void;
  /** Owner ruling (#692) — the engineer confirmed: the kept-aside legacy draft becomes this log's */
  adoptLegacyDailyLogDraft: () => void;
  /** …or discarded it */
  discardLegacyDailyLogDraft: () => void;
  addProgress: () => void;
  /**
   * `stamp` is what the PHOTO's own EXIF carries — empty when the file records nothing.
   * `pickedIn` is the scope the file was CHOSEN in: the picker's `FileReader` resolves after
   * an async boundary, so without it a photo chosen in project A can arrive here once B's
   * gateway is installed.
   * `pickedForLog` is the server id of the daily log on screen when the file was chosen (null: none), captured
   * with `pickedIn` for the same reason: a same-project refresh can replace the log before the read resolves.
   * Omitted, the log on screen now is used.
   */
  /** `guideRun`: the in-app guide run the photo was chosen under (taken before the file was read); now when not given */
  addProgressPhoto: (dataUrl: string, nodeId?: string | null, stamp?: CaptureStamp, pickedIn?: ProjectScope, pickedForLog?: string | null, guideRun?: number) => void;
  /** #482 site photos — delete a site photo the viewer added, within the hour (needs a connection). Settles when the
   *  server has answered; a second ask for the same photo while one is on its way joins it. */
  deleteSitePhoto: (photoId: string) => Promise<void>;
  submitDailyLog: () => void;
  flagMismatch: (idx: number) => void;
  record: (label: string) => void;
  toggleOnline: () => void;
  /** Replay the durable outbox in order. `okMsg` (write-ahead command path) announces the command's
   *  success instead of the batch "N synced" summary. Resolves a structured
   *  `OutboxFlushResult` so a caller can confirm ITS OWN ops by key (queue absence ≠ success — a
   *  terminal 4xx also removes the op). `act` is the command's act: its `okMsg` waits for the flush that sends that act,
   *  this one or a later one, whichever call it came with (#1133); a line always comes with its act (#1134 r2).
   *  `ownWord` lists acts whose word is the caller's: when this call runs the flush, those acts are left out of its counts
   *  and the flush says nothing itself, handing back the rest of its line (`word`) for the caller's one flash. A caller that
   *  cannot say it when the flush ends (`saysNow` false: another of its requests is still out) has the flush say it then,
   *  in the flush's own scope, as any flush does. */
  flushOutbox: (opts?: { okMsg: string | (() => string); act: OutboxOp; ownWord?: never; saysNow?: never }
    | { ownWord: string[]; saysNow?: () => boolean; okMsg?: never; act?: never }) => Promise<OutboxFlushResult>;
  /** Site Visits SV1-c unit 2 (#792, F53): put one site-visit act in the durable outbox and send it (write-ahead,
   *  as the Daily Log does); `offlineMsg` is what the viewer is told when the app is offline. False without the server. */
  queueSiteVisitAct: (op: OutboxOp, offlineMsg: string) => boolean;
  /** SV2: a visit photo the server took has not shown in its list yet: read again on the visit photo retry. */
  retrySiteVisits: () => void;
  /** SV2: the person sends a held visit's acts without waiting for a photo the phone cannot read just now: for this page
   *  load only (Codex 4323247780). */
  sendSiteVisitAnyway: (visitId: string) => void;
  hydrateOutbox: () => void;
  /** WEB-02 step A: copy this scope's unreadable queue keys aside (Set aside), or reload for a newer release's */
  setAsideUnreadableQueue: () => Promise<void>; reloadForNewerQueue: () => void;
  // team access
  accWho: (who: Exclude<AccessWho, null>) => void;
  accTrade: (t: string) => void;
  accSetPhone: (v: string) => void;
  accGoLogin: () => void;
  login: (email: string, password: string) => void;
  accSetEmail: (v: string) => void;
  accGoPasswordSetup: () => void;
  requestPasswordSetup: () => void;
  verifyPasswordSetup: () => void;
  completePasswordSetup: (password: string, confirmation: string) => void;
  accGoEmailOtp: () => void;
  requestEmailOtp: () => void;
  accSetCode: (v: string) => void;
  emailOtpVerify: () => void;
  requestOtp: () => void;
  otpPress: (d: string) => void;
  otpVerify: () => void;
  pickWorker: (w: Worker) => void;
  accReset: () => void;
  speakJob: () => void;
  workerDone: () => void;
  // API bridge (Phase 7b) — injected by useApiSync when VITE_API_URL is set
  /** The scope a project-scoped request is issued FOR (Task 3): capture before
   *  awaiting, apply the response only while the scope is still current. */
  captureProjectScope: () => ProjectScope;
  /** Refetch the active project's snapshot after a load error (the boundary's Retry). */
  retryProjectLoad: () => void;
  _setGateway: (g: ApiGateway | null) => void;
  /** Tests only: whether an outbox flush is in flight (the flush lock). The store outlives a test, and so does a flush
   *  still running when it ends: a test waits for it to settle before the next begins, or the next test's flushes are
   *  coalesced into it. */
  _outboxFlushing: () => boolean;
  /** Tests only: settles once every queue-key release so far has asked its flush (or found the app offline). A test waits
   *  on it, the flushes and the queue's locks, never on a count of turns or a clock. */
  _queueReleased: () => Promise<void>;
  /** adopt the session this tab saved before a reload, if one is still valid; true when one was adopted */
  restoreSession: () => boolean;
  /** Site Visits SV1-c (#792) — the gateway a screen that keeps its own state (the Site Visits screen) sends
   *  through; null in the local demo. Read it at each send, with `captureProjectScope`, like the store's own paths. */
  serverGateway: () => ApiGateway | null;
  /** Apply a delivered snapshot as the newest snapshot intent for the current scope
   *  (gate round 11 — begins a fresh lease, then routes through the coordinator).
   *  Models a pushed/socket-delivered snapshot; returns true only when `applied`, so
   *  callers can't mark a stale/rejected response as ready. Prefer `requestFreshSnapshot`
   *  for a pull; the internal command paths use the coordinator's `acceptSnapshot`. */
  applySnapshot: (snap: ApiSnapshot, capturedScope?: ProjectScope) => boolean;
  /** Pull one coalesced fresh snapshot through the coordinator (socket refresh,
   *  initial load, retry, invalid-project recovery). At most one in flight per scope. */
  requestFreshSnapshot: () => void;
}

export type Store = AppState & AppActions;

/** Task 10 correction — the SINGLE drawing-mutation readiness predicate, used BOTH to disable the
 *  controls in the UI and to defensively reject the command in the store (belt-and-braces). Under module
 *  read-ownership a drawing mutation must never run against a register whose module read hasn't settled
 *  ('idle'/'loading'/'error') — the store would be acting on stale or absent data. In the default
 *  'snapshot' mode the snapshot slice is authoritative, so mutations are never blocked (`drawingsLoad`
 *  stays 'idle' there and this returns false). */
export function drawingMutationsBlocked(s: Pick<AppState, 'drawingsLoad'>): boolean {
  return drawingsReadMode() === 'moduleQuery' && s.drawingsLoad !== 'ready';
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** U3b — the newest brief request; a reply to any earlier one is superseded and dropped (the landing,
 *  poll and focus reads overlap, and an older reply may carry a project whose access was since removed). */
let briefRequestSeq = 0;

/** The HTTP status the gateway attached to a failed request (`req` sets `status`); undefined for a
 *  failure with no response at all (offline, DNS, CORS). */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** A phone sign-in failure before it is put into words (#886): the gate words it in its current language. */
type AccessErrorWhy =
  | { key: 'noServer' | 'sendFailed' | 'tooManyLater' | 'wrongCode' | 'checkFailed' | 'retryRefused' }
  | { key: 'tooManyWait'; seconds: number }
  // #482 V-1018-6: the email and password screens' failures, worded the same way
  | { key: Exclude<SignInErrorKey, 'tooManySignIns' | 'tooManyCodes'> }
  | { key: 'tooManySignIns' | 'tooManyCodes'; seconds: number | null };

/**
 * What a failed request for a phone sign-in code tells the person (#827 one-screen sign-in). A throttle names
 * the real wait when the server sends one and otherwise says "later", never a guessed minute. Any other failure
 * (no SMS channel, or the email carrying the code could not be sent) points to the email sign-in below, so a
 * broken send never looks like a code that is on its way.
 */
function otpRequestFailure(err: unknown): AccessErrorWhy {
  const status = httpStatusOf(err);
  if (status === 429) return otpThrottle(err);
  if (status === undefined) return { key: 'noServer' };
  return { key: 'sendFailed' };
}

/** A failed code check (#886). Only a refusal from the server means a wrong or expired code; no answer at all
 *  or a server fault says the code could not be checked, so the typed code stays for another try. A refusal of
 *  that retry may only mean the first check went through and used the code up, so it asks for a new code
 *  instead of calling the code wrong. */
function otpVerifyFailure(err: unknown, retry: boolean): AccessErrorWhy {
  const status = httpStatusOf(err);
  if (status === 429) return otpThrottle(err);
  // 408: the check timed out on the way (a server or proxy), so the code was never judged
  if (status === undefined || status === 408 || status >= 500) return { key: 'checkFailed' };
  return { key: retry ? 'retryRefused' : 'wrongCode' };
}

/** A throttled code request or code check (429): the real wait from the server's `retryAfter` when it sends
 *  one, otherwise "try again later". */
function otpThrottle(err: unknown): AccessErrorWhy {
  const seconds = (err as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof seconds !== 'number' || !(seconds > 0)) return { key: 'tooManyLater' };
  return { key: 'tooManyWait', seconds };
}

/** "Wait 30 seconds" / "Wait 1 minute" / "Wait 4 minutes" in the gate's language, from the server's seconds */
function waitPhrase(seconds: number, lang: Lang): string {
  const t = accessDict[lang];
  const minutes = Math.ceil(seconds / 60);
  return seconds < 60
    ? t.waitSeconds.replace('{n}', String(Math.ceil(seconds)))
    : minutes === 1 ? t.waitMinute : t.waitMinutes.replace('{n}', String(minutes));
}

function accessErrorText(why: AccessErrorWhy, lang: Lang): string {
  const t = accessDict[lang];
  switch (why.key) {
    case 'tooManyWait':
      return t.tooManyWait.replace('{wait}', waitPhrase(why.seconds, lang));
    case 'tooManySignIns':
    case 'tooManyCodes': {
      const e = signInErrors[lang];
      return e[why.key].replace('{wait}', why.seconds !== null && why.seconds > 0 ? waitPhrase(why.seconds, lang) : e.waitFew);
    }
    case 'noServer': case 'sendFailed': case 'tooManyLater': case 'wrongCode': case 'checkFailed': case 'retryRefused':
      return t[why.key];
    default:
      return signInErrors[lang][why.key];
  }
}

function accessError(why: AccessErrorWhy, lang: Lang): AccessErrorKey {
  return { ...why, text: accessErrorText(why, lang) } as AccessErrorKey;
}

/** Records a sign-in failure on the access state, worded in the gate's current language and keyed so a later
 *  language switch re-words it (#886, extended to every sign-in screen by #482 V-1018-6). */
function failAccess(s: { lang: Lang; access: AccessState }, why: AccessErrorWhy): void {
  const k = accessError(why, s.lang);
  s.access.error = k.text;
  s.access.errorKey = k;
}

/** The sign-in error to show, in the gate's current language (#886: a switch after a failure re-translates
 *  it). Every other write of `access.error` clears `errorKey`, so a key is always the current error's own. */
export function shownAccessError(access: Pick<AccessState, 'error' | 'errorKey'>, lang: Lang): string | null {
  const k = access.errorKey;
  if (!access.error || !k) return access.error;
  return accessErrorText(k, lang);
}

/** How long a throttled (429) caller should wait, from the seconds the server says remain in its window
 *  (#808: a fixed "10 minutes" overstated a window that may be seconds from resetting); null when it sends none. */
function throttleSeconds(err: unknown): number | null {
  const seconds = (err as { retryAfter?: unknown } | null)?.retryAfter;
  return typeof seconds === 'number' && seconds > 0 ? seconds : null;
}

/**
 * What a failed email + password sign-in tells the person. It used to be "Wrong email or password." for EVERY
 * failure (#482, 12 Oct 2026), so a throttle, a removed project access, or a server or network fault read as a
 * bad password. Each now says what happened. A plain 401 still reveals nothing about whether the account
 * exists, and points an account that never set a password at the setup flow.
 */
function signInFailure(err: unknown): AccessErrorWhy {
  const status = httpStatusOf(err);
  const serverMessage = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (status === 429) return { key: 'tooManySignIns', seconds: throttleSeconds(err) };
  // the server's own words for a removed access, in the gate's language (V-1018-6)
  if (status === 401 && typeof serverMessage === 'string' && /access has been removed/i.test(serverMessage)) return { key: 'accessRemoved' };
  if (status === undefined) return { key: 'noServer' };
  if (status >= 500) return { key: 'serverDown' };
  return { key: 'wrongPassword' };
}

/** A pristine access-flow state (used to init and to reset after sign-out). */
function freshAccess(generation = 0): AccessState {
  return {
    generation,
    // #827 one-screen sign-in: a live build opens on the phone number (team members are the only ones who
    // sign in there); the API-less demo keeps "Who are you?" for its trade and worker prototypes
    step: API_BASE ? 'phone' : 'who',
    who: API_BASE ? 'team' : null,
    trade: null,
    phone: '',
    email: '',
    otp: '',
    worker: null,
    sending: false,
    error: null,
    devCode: null,
    passwordRequestId: null,
    passwordSetupToken: null,
  };
}

/** A fresh copy of the seeded initial state (deep-cloned so resets never share references). */
/** Record an unsubmitted per-field checklist edit (gate round 6) so any later
 *  snapshot refresh restores the engineer's latest intent for that field —
 *  including an intentional clear. Resets the edit set when the checklist or the
 *  scope generation changed; no-ops for items without a server id (demo rows). */
function recordChecklistMark(
  s: AppState,
  inspectionId: string,
  itemId: string | undefined,
  field: 'state' | 'note',
  value: ItemState | string,
): void {
  if (!itemId) return;
  const m = s.checklistMarks;
  if (m.generation !== s.projectScopeGeneration) {
    // a re-auth or project switch strands the old session's edits (gate round-4 finding 3)
    m.generation = s.projectScopeGeneration;
    m.byInspection = {};
    m.rev = 0;
  }
  const byItem = (m.byInspection[inspectionId] ??= {});
  const entry = (byItem[itemId] ??= {});
  const rev = ++m.rev;
  if (field === 'state') entry.state = { rev, value: value as ItemState };
  else entry.note = { rev, value: value as string };
}

/**
 * Overlay the engineer's UNSUBMITTED per-field marks for whatever checklist now owns the edit slot.
 *
 * ONE rule serving two callers, because they must not disagree about what the engineer is looking
 * at: a snapshot refresh (which replaces the server's copy underneath them) and a deliberate switch
 * to another open checklist. In both cases the rendered checklist is server truth plus this
 * engineer's latest intent for THAT inspection, and nothing else. Each field carries the value the
 * engineer set, so an intentional clear (state→null, note→'') is restored as faithfully as a set —
 * no value-guessing, which cannot tell an intentional clear from a background wipe (gate round 6).
 */
function overlayChecklistMarks(s: AppState): void {
  const c = s.checklist;
  if (!c) return;
  const m = s.checklistMarks;
  if (m.generation !== s.projectScopeGeneration) return;
  const byItem = m.byInspection[c.id];
  if (!byItem) return;
  if (c.submitted) {
    // gate round 7: the SERVER confirms this inspection is submitted — the marks are now
    // server-owned. Drop the records and take server truth. Until this ack lands (a pending or
    // REJECTED submit leaves the server checklist `submitted: false`) the records are retained and
    // overlaid, so unconfirmed work survives a failed submit + a refresh.
    delete m.byInspection[c.id];
    return;
  }
  for (const it of c.items) {
    if (!it.id) continue;
    const edit = byItem[it.id];
    if (edit?.state) it.state = edit.state.value;
    if (edit?.note) it.note = edit.note.value;
  }
}

/** The PMC's UNSENT rejection marks, by review then item row id: only undecided reviews carry them. */
function reviewRejectionMarks(reviews: readonly Review[]): Map<string, Set<string>> {
  const marks = new Map<string, Set<string>>();
  for (const r of reviews) {
    if (r.decided) continue;
    const ids = r.items.filter((it) => it.rejected && it.id).map((it) => it.id!);
    if (ids.length) marks.set(r.id, new Set(ids));
  }
  return marks;
}

/**
 * The review queue's counterpart of `overlayChecklistMarks`: a PMC's "Reject item" marks exist only in
 * this store until Send, and every reconcile replaces the queue with the server's copy, so a background
 * refresh landing between the marks and Send used to wipe them (the decision then went out without the
 * rows the PMC named). The marks are carried onto the SAME review while it is still undecided, matched by
 * item row id; once the server reports the review decided, its own record of what was rejected stands.
 */
function restoreReviewRejectionMarks(reviews: Review[], marks: Map<string, Set<string>>): Review[] {
  if (marks.size === 0) return reviews;
  // new objects, never in-place writes: the server's copy may already be frozen in another slice
  return reviews.map((r) => {
    const ids = r.decided ? undefined : marks.get(r.id);
    if (!ids) return r;
    return { ...r, items: r.items.map((it) => (it.id && ids.has(it.id) ? { ...it, rejected: true } : it)) };
  });
}

/**
 * Which checklist owns the edit slot after a read: the engineer's chosen one while it is still
 * open, else the server's default (the oldest open one). A selection that has left the open set —
 * submitted, or belonging to a project this scope has moved away from — is DROPPED rather than
 * pinning the slot to a checklist that is no longer outstanding.
 */
/**
 * The outstanding set a read serves — from EITHER endpoint, by one rule.
 *
 * `openChecklists` is this release's field. A client deployed ahead of its API talks to a server
 * that has never heard of it, and the honest answer to "what else is out on site?" from such a
 * server is the one checklist it does return — but ONLY while that checklist is still open. When
 * nothing is open the server deliberately serves the oldest SUBMITTED one so a finished checklist
 * stays readable, and wrapping THAT would report completed work as outstanding and awaiting the
 * engineer. An older server simply cannot tell us about a second open checklist, and an empty list
 * is the honest answer to that.
 *
 * Written once and shared because it was written twice and diverged: the snapshot branch derived the
 * fallback and the module branch coerced the missing field to `[]`, so a client-first rollout in
 * `moduleQuery` mode reported no work out on site while the same response carried an unsubmitted
 * checklist (#571 round 7, finding 5). The two branches differ in WHERE the payload comes from and
 * in nothing else, so the compatibility rule cannot live inside either of them.
 */
const outstandingFrom = (
  openChecklists: readonly Checklist[] | undefined,
  checklist: Checklist | null | undefined,
): Checklist[] => (openChecklists ? [...openChecklists] : (checklist && !checklist.submitted ? [checklist] : []));

/**
 * Write the checklist in the edit slot back over its entry in the outstanding list.
 *
 * Field STATE and NOTE survive a switch through `checklistMarks`, which the engineer's own edits
 * record per inspection. The demo path's photo counter and local evidence thumbnails do not: they
 * live only on the checklist object, so switching away and back restored a clean clone from the list
 * and silently dropped them — and a failed item whose only photo vanished cannot be submitted at all.
 * Mirroring the slot back before it is replaced keeps the list the single source the switch reads
 * from, rather than adding a second per-inspection record for two fields.
 */
/** A stable, synchronous digest of `text` (two seeded 53-bit cyrb53 passes, hex): the same text gives the same
 *  value in every tab and on every load. An identity, not a security boundary. */
function contentHash(text: string): string {
  const pass = (seed: number): string => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return `${pass(1)}${pass(2)}`;
}

function parkEditSlot(s: AppState): void {
  const c = s.checklist;
  if (!c) return;
  const i = s.openChecklists.findIndex((o) => o.id === c.id);
  if (i >= 0) s.openChecklists[i] = structuredClone(current(c)) as Checklist;
}

function ownerOfEditSlot(
  open: readonly Checklist[],
  fallback: Checklist | null,
  selectedId: string | null,
): { checklist: Checklist | null; selectedId: string | null } {
  const chosen = selectedId ? open.find((c) => c.id === selectedId) : undefined;
  // Cloned either way. The slot's checklist is EDITED in place, and it must never share an object
  // with an entry in the outstanding list — a payload that happened to serve the same checklist
  // under both keys would otherwise let a field edit rewrite the list the picker renders.
  return chosen
    ? { checklist: structuredClone(chosen) as Checklist, selectedId }
    : { checklist: fallback ? (structuredClone(fallback) as Checklist) : null, selectedId: null };
}

/** Is the current checklist FROZEN against edits (gate round 8)? True once the
 *  SERVER confirms it submitted (read-only), OR while a submit for THIS inspection
 *  is pending in the current scope (submitting / queued). Every checklist mutation
 *  (state, note, photo, evidence) consults this so nothing changes the payload once
 *  it has been dispatched. */
export function checklistFrozen(
  s: Pick<AppState, 'checklist' | 'submission' | 'projectScopeGeneration' | 'outbox'>,
): boolean {
  return inspectionFrozen(s, s.checklist);
}

/** The same freeze rule, asked about a NAMED checklist rather than whichever one is in the edit slot.
 *  An evidence capture is answered for the checklist the photo was TAKEN on, which an async read can
 *  outlive — judging it against the slot would let a submitted checklist accept a photo (or a frozen
 *  slot refuse one that belongs to an editable checklist behind it). */
export function inspectionFrozen(
  s: Pick<AppState, 'submission' | 'projectScopeGeneration' | 'outbox'>,
  c: Checklist | null | undefined,
): boolean {
  if (!c) return false;
  if (c.submitted) return true;
  // THE DURABLE QUEUED SUBMIT IS ASKED FIRST, because the slot below can be describing a DIFFERENT
  // checklist (#571 round 10, finding 3). This function was already made per-checklist — that was
  // the round-4 fix — but its evidence stayed the SINGLE `submission` slot, and `reconcileSubmission`
  // repoints that slot at whichever checklist the read is about. So: queue A's submit offline, switch
  // to B, and the slot describes B; a photo for A whose `FileReader` is still running then finds
  // `inspectionFrozen(s, A)` false and mutates A's items and queues its evidence AFTER A's payload
  // was frozen. On reconnect the submit op precedes that upload, so a failed item loses the evidence
  // its submission needed, or evidence lands on an already-submitted record.
  //
  // The outbox is the durable fact and `reconcileSubmission` already derives the slot's `queued`
  // status from exactly this predicate — asking it here is the same question at the same source, so
  // a checklist with a queued submit is frozen whether or not it currently owns the slot.
  if (s.outbox.some((op) => op.t === 'submitInspection' && op.inspectionId === c.id)) return true;
  const sub = s.submission;
  return (
    sub.inspectionId === c.id &&
    sub.generation === s.projectScopeGeneration &&
    (sub.status === 'submitting' || sub.status === 'queued')
  );
}

/** Derive the submission freeze from server truth + the durable outbox (gate round
 *  8) so a snapshot refresh or a reload never loses OR forges it. Called wherever
 *  the checklist or the outbox changes. A server-`submitted` checklist is read-only
 *  (status idles — the freeze comes from `submitted`); a still-unsubmitted checklist
 *  with a queued submit op stays FROZEN as `queued` (this rebuilds the freeze after a
 *  reload); an in-flight `submitting` freeze is preserved until its promise resolves;
 *  anything else (a different checklist, a re-auth/switch, a dropped submit) idles. */
/**
 * §M — release the commercial coalesce keys THIS read makes visible, and retain every other.
 *
 * Rebuilt from the live outbox rather than simply deleted, so a transient-failed op (still queued)
 * keeps its key and its button stays disabled, while a resolved op's key clears WITH the truth that
 * read just applied. One function for all four reads: three hand-written copies of this rule was
 * how `com:bill:` came to be released by two of them.
 */
function releaseCommercialKeys(
  s: {
    outbox: readonly unknown[];
    commercialPending: string[];
    commercialPendingQty: Record<string, { lineId: string; qty: string }>;
  },
  r: CommercialRead,
): void {
  const live = s.outbox.flatMap((o) =>
    isCommercialOpType((o as { t?: unknown }).t) && typeof (o as { coalesceKey?: unknown }).coalesceKey === 'string'
      ? [(o as { coalesceKey: string }).coalesceKey]
      : [],
  );
  s.commercialPending = [
    ...s.commercialPending.filter((k) => !readClearsKey(k, r)),
    ...live.filter((k) => readClearsKey(k, r)),
  ];
  // A reservation lives exactly as long as its key. Pruning to the surviving key set is the WHOLE
  // rule — there is no second derivation that could disagree with it.
  const held = new Set(s.commercialPending);
  for (const key of Object.keys(s.commercialPendingQty)) {
    if (!held.has(key)) delete s.commercialPendingQty[key];
  }
}

/** #482 (#1220) — the project and person a review decision on its way was sent for (`reviewDecisionsSending`). Not the
 *  scope's generation: a switch away and back starts a new one while that decision is still on its way */
export const reviewSendingScope = (s: Pick<AppState, 'activeProjectId' | 'sessionUserId'>): string => `${s.activeProjectId}\u0000${s.sessionUserId ?? ''}`;

/** #482 — the review guide waits on a decision already on its way: this review's, queued on this phone to send, or any
 *  sent online, or replayed from the queue, in this project scope and not settled yet (Codex 4403491374, 4403818412: the
 *  run waits on that answer, and must not lead a press on this review or another meanwhile; #1220: one sent in a scope
 *  since left is not this one's). It neither offers nor points at a review then (pressing again would decide twice) */
export function reviewDecisionWaits(s: Pick<AppState, 'outbox' | 'reviewDecisionsSending' | 'activeProjectId' | 'sessionUserId'>, reviewId: string): boolean {
  return s.reviewDecisionsSending.includes(reviewSendingScope(s)) || s.outbox.some((o) => o.t === 'decideReview' && o.inspectionId === reviewId);
}

/** take one entry back by value (the first): the others, this scope's or another's, stay */
function dropOne(list: string[], entry: string): void {
  const at = list.indexOf(entry);
  if (at >= 0) list.splice(at, 1);
}

/** The cap reservation a commercial op holds, or null if it spends no line authority. */

export function capReservationOf(op: unknown): { lineId: string; qty: string } | null {
  const o = op as {
    t?: unknown; labourPoLineId?: unknown; input?: { labourPoLineId?: unknown; quantity?: unknown };
  };
  const isMeasure = o.t === 'takeMeasurement';
  const isCorrection = o.t === 'correctMeasurement';
  if (!isMeasure && !isCorrection) return null;
  const lineId = isMeasure ? o.input?.labourPoLineId : o.labourPoLineId;
  const qty = o.input?.quantity;
  if (typeof lineId !== 'string' || typeof qty !== 'string') return null;
  // a WITHDRAWAL frees authority rather than spending it, so it reserves nothing
  if (isCorrection && qty.startsWith('-')) return null;
  return { lineId, qty };
}

function reconcileSubmission(s: AppState): void {
  const sub = s.submission;
  const c = s.checklist;
  const gen = s.projectScopeGeneration;
  // gate round 10: any branch that CHANGES ownership (a different checklist, a
  // server-confirmed submit, a reload of a queued submit, an idle reset) RETIRES
  // whatever online attempt held this state — reset `attempt` to 0 so that attempt's
  // in-flight continuation is ignored when it lands. The ONE branch that keeps an
  // in-flight online submit alive preserves its `attempt`.
  if (!c) {
    sub.inspectionId = null;
    sub.generation = gen;
    sub.status = 'idle';
    sub.attempt = 0;
    return;
  }
  if (c.submitted) {
    sub.inspectionId = c.id;
    sub.generation = gen;
    sub.status = 'idle';
    sub.attempt = 0;
    return;
  }
  const queued = s.outbox.some((op) => op.t === 'submitInspection' && op.inspectionId === c.id);
  if (queued) {
    sub.inspectionId = c.id;
    sub.generation = gen;
    sub.status = 'queued';
    sub.attempt = 0;
  } else if (sub.inspectionId === c.id && sub.generation === gen && sub.status === 'submitting') {
    // an online submit is still in flight for THIS inspection — keep the freeze AND
    // its owning attempt until that submit's own continuation resolves it
  } else {
    sub.inspectionId = c.id;
    sub.generation = gen;
    sub.status = 'idle';
    sub.attempt = 0;
  }
}

export function getInitialState(): AppState {
  return {
    // land on the admin (PMC) view by default — create/manage projects, teams,
    // portfolio. The persona switcher graduates to team/individual views.
    role: 'pmc',
    // the Dashboard is every role's home (#811); For You is the live cross-cutting action queue.
    // Seeded from the URL on a cold load so a refresh / deep link restores the screen.
    screen: initialScreen(),
    // #482 V-1018-6 — the gate opens in the language last chosen on this device; the person's own choice
    // replaces it once they sign in (`LangPreference`)
    lang: readDeviceLang() ?? 'en',
    notifOpen: false,
    createOpen: false,
    toast: null,
    modal: { type: null },
    decisions: structuredClone(SEED_DECISIONS),
    decisionsLoad: 'idle',
    commandReconcilePending: false,
    commandReconcileOwed: noReconcileOwed(),
    decisionsSource: null,
    dailyLogLoad: 'idle',
    dailyLogSource: null,
    dailyLogReconcileAfter: null,
    dailyLogPhotoCountAfter: null,
    dailyLogReconcileKind: null,
    drawingsLoad: 'idle',
    drawingsSource: null,
    inspectionsLoad: 'idle',
    inspectionsSource: null,
    activitiesLoad: 'idle',
    activitiesSource: null,
    enabledModules: [],
    capabilities: [],
    capabilitiesKnown: false,
    phase6_4dRollout: 'reserved',
    materialsView: null,
    materialsLoad: 'idle',
    reservationPlans: {},
    materialsPending: [],
    labourView: null,
    labourLoad: 'idle',
    // Phase 5 Task 7B-i (§M) — project-owned like the other two hubs, so a project switch cannot
    // leave one project's money on another's screen.
    commercialView: null,
    commercialLoad: 'idle',
    commercialBills: null,
    commercialBillsLoad: 'idle',
    commercialClaims: {},
    commercialClaimLoad: {},
    commercialAdvances: null,
    commercialAdvancesLoad: 'idle',
    commercialPendingQty: {},
    commercialLineRegisters: {},
    commercialLineRegisterLoad: {},
    commercialPending: [],
    labourPending: [],
    labourPendingInputs: {},
    labourOnboardPending: {},
    nodeCreatePending: {},
    labourBindPending: {},
    nodes: structuredClone(SEED_NODES), // the demo location tree (server snapshot replaces it)
    placeFocus: null,
    decisionFocus: null,
    activityFocus: null,
    returnPlace: null,
    routeItem: null,
    checklist: structuredClone(SEED_CHECKLIST),
    openChecklists: [structuredClone(SEED_CHECKLIST)],
    selectedChecklistId: null,
    checklistMarks: { generation: 0, rev: 0, byInspection: {} },
    submission: { inspectionId: null, generation: 0, status: 'idle', attempt: 0 },
    reviews: [structuredClone(SEED_REVIEW)],
    activeReviewId: null,
    reinspectionCreated: false,
    drawings: structuredClone(SEED_DRAWINGS),
    photos: structuredClone(SEED_PHOTOS), // placed site photos for the demo Site Map
    myDeletablePhotos: [],
    photosWindowShort: false,
    sitePhotosKept: [],
    materials: structuredClone(SEED_MATERIALS), // placed deliveries for the demo Site Map
    placedInspections: structuredClone(SEED_PLACED_INSPECTIONS), // placed inspections for the demo Site Map
    phases: structuredClone(SEED_PHASES),
    activeProjectId: initialProjectId(),
    memberships: [],
    myOrgs: [],
    orgMembers: [],
    orgModules: [],
    orgTemplates: [],
    members: [],
    portfolio: [],
    brief: null,
    briefAt: null,
    online: true,
    syncQueue: [],
    outbox: [],
    queueUnreadable: [], queueSetAsideFailed: false,
    siteVisitsHeld: null,
    siteVisitsSentAnyway: [],
    photoUploadsInFlight: [],
    photoUploadsSending: [],
    reviewDecisionsSending: [],
    failedEvidence: [],
    pendingEvidenceCount: 0,
    pendingEvidenceKeys: null,
    access: freshAccess(),
    activities: structuredClone(SEED_ACTIVITIES),
    dailyLog: structuredClone(SEED_DAILY_LOG),
    dailyLogDraft: null,
    legacyDailyLogDraft: null,
    notifications: structuredClone(SEED_NOTIFICATIONS),
    notifSeen: emptyNotifSeen(),
    projectCreateHold: null,
    sessionToken: null,
    userName: null,
    sessionUserId: null,
    // #953 — behind real sign-in the project's identity comes only from its snapshot: the bundled sample
    // project's name must never label a real person's loader (a reload restores onto the URL's project,
    // which keeps these fields until the snapshot lands). The demo and dev-auth builds, which render the
    // seeded store before any snapshot, keep the sample.
    name: DEV_AUTH ? PROJECT.name : '',
    short: DEV_AUTH ? PROJECT.short : '',
    descriptor: DEV_AUTH ? PROJECT.descriptor : '',
    stage: DEV_AUTH ? PROJECT.stage : '',
    siteCode: DEV_AUTH ? PROJECT.siteCode : '',
    location: '',
    timeZone: null,
    projStart: PROJECT.projStart,
    projEnd: PROJECT.projEnd,
    scheduleStartDate: PROJECT.scheduleStartDate,
    scheduleEndDate: PROJECT.scheduleEndDate,
    elapsedPct: PROJECT.elapsedPct,
    todayDay: PROJECT.todayDay,
    milestonePct: PROJECT.milestonePct,
    pendingProjectId: null,
    projectScopeGeneration: 0,
    projectLoadState: 'idle',
    projectLoadError: null,
    companies: [],
    archivedProjects: [],
  };
}

/** #482 site photos — a deleted photo leaves every slice that still holds its signed path: an item's evidence on a
 *  checklist or a review, and a decision option's sample photo. The paths name the photo (`/media/<id>?t=…`). */
function forgetMedia(s: AppState, mediaId: string): void {
  const path = `/media/${mediaId}`;
  const names = (url: string | undefined): boolean => {
    const at = url?.indexOf(path) ?? -1;
    if (at < 0) return false;
    const next = url![at + path.length];
    return next === undefined || next === '?' || next === '#';
  };
  const items = (list: { evidence?: string[] }[]): void => {
    for (const it of list) if (it.evidence?.some(names)) it.evidence = it.evidence.filter((u) => !names(u));
  };
  if (s.checklist) items(s.checklist.items);
  for (const c of s.openChecklists) items(c.items);
  for (const r of s.reviews) items(r.items);
  for (const d of s.decisions) for (const o of d.options) if (names(o.photoUrl)) delete o.photoUrl;
  // and the viewer's own photos past the window
  s.myDeletablePhotos = s.myDeletablePhotos.filter((p) => p.id !== mediaId);
}

export const useStore = create<Store>()(
  immer((set, get) => {
    // API bridge (Phase 7b): injected by useApiSync when VITE_API_URL is set.
    // When present, mutating actions persist through the API and reconcile from
    // the returned snapshot; when null, they mutate the seeded local store.
    let gateway: ApiGateway | null = null;
    /** the token a reload adopted from this tab's saved session (#482 6227430525), until another replaces it */
    let restoredToken: string | null = null;
    /** the project a restored session's URL named when it is not the saved session's own (switched to on install) */
    let restoreSwitchTarget: { projectId: string; screen: ScreenKey } | null = null;
    // #482 — decision publishes still on their way, per project scope (project + generation, which a
    // switch or sign-in moves), for the in-app guide's Publish step (see `issueDecision`)
    const decisionPublishesInFlight = new Map<string, number>();

    /** Latest-request ownership for the Materials bundle (correction finding 2). Each `loadMaterials()`
     *  claims the next token; only the newest same-project load may write the view or change its load
     *  state — an older success/failure that resolves later is dropped, so a slow refresh can never
     *  overwrite a newer result. */
    let materialsLoadSeq = 0;
    // Phase 4 Task 6 (§J) — the labour twin of materialsLoadSeq: only the NEWEST in-scope labour
    // bundle request may write labourView (an older success or failure resolving late is dropped).
    let labourLoadSeq = 0;
    let commercialLoadSeq = 0;
    let commercialBillsSeq = 0;
    // PER-CLAIM, not one shared counter (the PR #208 F3 lesson, applied before it can bite): a
    // single token would let opening claim B cancel a still-useful load of claim A, and a slow A
    // returning after B would be dropped even though nothing newer asked for A.
    const commercialClaimSeq: Record<string, number> = {};
    let commercialAdvancesSeq = 0;
    /** Per-LINE ownership for the §D register read, for the same reason as the per-claim one. */
    const commercialLineSeq: Record<string, number> = {};
    /**
     * Codex Q-a — how many commercial writes have SETTLED. A read captures this at START; if it has
     * moved by the time the read applies, a write settled while the read was in flight, so the read
     * cannot be shown to have observed it and releases no keys. This is a causality question, and a
     * per-line token cannot answer it: that token orders reads against each other only.
     */
    let commercialWritesSettled = 0;
    /** Codex I2 — ONE monotonic counter shared by the claim list and the claim bundle, so their
     *  successes are comparable. Two counters would order each read against itself and answer
     *  nothing about which of the two is fresher, which is the whole question. */
    /** Per-activity latest-request ownership for the reservation plan (correction 3, finding 2). Each
     *  `loadReservationPlan(activityId)` claims the next generation for that activity; only the newest
     *  request in the current project scope may write `reservationPlans[activityId]`, so a slow older
     *  request can never overwrite a newer post-command reconciliation with stale candidates. */
    const reservationPlanSeq = new Map<string, number>();

    /** The scope a network request is issued FOR — pass to applySnapshot so a reply
     *  that lands after the scope changed (switch, sign-in) is dropped, not applied. */
    const currentScope = (): ProjectScope => projectScopeOf(get());

    /** Is a scope captured at request time still the live one? Guards EVERY
     *  post-await project mutation — including raw-DTO paths that don't go
     *  through applySnapshot (companies, photo upload). Codex gate finding 3. */
    const scopeStillCurrent = (scope: ProjectScope): boolean =>
      isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, scope);

    // ---- gate round 11/12/13: central snapshot-ordering coordinator ----
    // Ownership and refresh coalescing are keyed by FULL scope (project + generation),
    // not one store-global slot (gate round 12, finding 1). A monotonic sequence
    // (never timestamps) is global only as an id source; a lease is the newest snapshot
    // intent for ITS OWN scope. So a stale old-scope lease can never change another
    // scope's owner, and a new scope's pull runs independently of an old scope's
    // in-flight pull.
    //
    // Gate round 13/14: a superseded command/submit records a durable RECONCILIATION
    // OBLIGATION on its scope — preserved until CONFIRMED, not a fire-and-forget flag.
    // `createdAfterSequence` pins each obligation so a refresh that began BEFORE it can
    // neither satisfy nor clear it (a stale `submitted:false` snapshot can't disarm a
    // submit recovery). Gate round 14: command and submit obligations are held
    // SEPARATELY and COMPOSE — a later command can never overwrite an unconfirmed
    // submit (and vice-versa). A command clears when a post-threshold reconcile
    // APPLIES; a submit clears only when a post-threshold snapshot retires that exact
    // attempt. If the mandatory reconcile fails — or a submit reconcile applies
    // still-unconfirmed while its command sibling is satisfied — the recoverable
    // error/Retry boundary is exposed rather than a silent stuck state.
    interface SubmitObligation { inspectionId: string; attempt: number; createdAfterSequence: number; }
    interface ScopeCoordinator {
      newestLeaseSeq: number;
      refreshInFlight: boolean;
      refreshQueued: boolean;
      commandAfterSequence: number | null; // a committed generic command owed confirmed truth
      commandOwed: Set<ReconcileSlice>;     // the slices it is still owed for (cleared slice by slice)
      submit: SubmitObligation | null;      // a frozen submit owed confirmation
      /** #482 — told once a pull that began after they asked has settled (`afterFreshPull`) */
      afterPull?: (() => void)[];
    }
    type ReconcileObligation =
      | { kind: 'command'; createdAfterSequence: number; modulesOnly?: boolean }
      | { kind: 'submit'; inspectionId: string; attempt: number; createdAfterSequence: number };
    let snapshotSeq = 0;
    // Serialize outbox flushes (finding 1 — write-ahead commands can fire a flush per command while one
    // is already in flight). At most one flush runs; a request made during a flush re-runs once after it
    // settles, so a command persisted mid-flush is still sent. Idempotency keys make an overlap harmless,
    // but serializing keeps ordering and avoids redundant sends.
    let outboxFlushing = false;
    let outboxFlushQueued = false;
    /** #1133 (Codex 4374997251, #1134 r1 4376641813): each command's success line, by its act's idempotency key and the
     *  queue it is in, from its flush call until a flush settles that act: the flush the server accepts it in says the
     *  line, one that refuses it for good drops it, and one that leaves it queued (held, offline, a failed send) keeps it */
    let okWaiting: { okMsg: string | (() => string); key: string; queue: string }[] = [];
    /** #482 — a write-ahead act the in-app guide waits on, by its key: the flush that settles it tells it (`runWriteAhead`) */
    const actWatches = new Map<string, (how: 'sent' | 'failed' | 'pending') => void>();
    /** #482 — the keys of the acts the flush now running has taken: that flush tells their watches, also after the signal goes */
    let flushingKeys: ReadonlySet<string> = new Set();
    /** #482 — online acts whose write-ahead has not run yet: the flush called once it has runs and tells them */
    const writingKeys = new Set<string>();
    const scopeCoordinators = new Map<string, ScopeCoordinator>();
    const scopeKey = (scope: ProjectScope): string => `${scope.projectId}::${scope.generation}`;
    /** Drop coordinators for scopes we've LEFT that have no pull in flight — a scope
     *  we moved away from owns nothing anymore, so its pending obligations are
     *  cancelled with it (gate round 13, semantic 6); the current scope is always kept,
     *  and a coordinator with an in-flight pull self-prunes when that pull settles. */
    const pruneScopeCoordinators = (): void => {
      const liveKey = scopeKey(currentScope());
      for (const [key, c] of scopeCoordinators) {
        if (key !== liveKey && !c.refreshInFlight) scopeCoordinators.delete(key);
      }
    };
    const coordinatorFor = (scope: ProjectScope): ScopeCoordinator => {
      const key = scopeKey(scope);
      let c = scopeCoordinators.get(key);
      if (!c) {
        c = { newestLeaseSeq: 0, refreshInFlight: false, refreshQueued: false, commandAfterSequence: null, commandOwed: new Set(), submit: null };
        scopeCoordinators.set(key, c);
        pruneScopeCoordinators(); // a new scope appeared — sweep the ones we've left
      }
      return c;
    };
    const beginSnapshotLease = (scope: ProjectScope): SnapshotLease => {
      const sequence = ++snapshotSeq;
      coordinatorFor(scope).newestLeaseSeq = sequence; // advance ONLY this scope's owner
      return { scope, sequence };
    };

    /** The pure state-copy for a snapshot. PRODUCTION CODE MUST NOT CALL THIS
     *  DIRECTLY — only `acceptSnapshot` may, after the ordering checks. A source-scan
     *  test (`snapshot-ordering.test.ts`) enforces the single call site so an
     *  unsequenced apply cannot be reintroduced. */
    // ── #669 Today regression — the pending daily-log draft (store/dailyLogDraft.ts) ──
    // The signed-in user (JWT sub), as the outbox scopes it — 'anon' for the passwordless dev session.
    const sessionSub = (): string => {
      const token = get().sessionToken;
      if (!token) return 'anon';
      try {
        return (JSON.parse(atob(token.split('.')[1])) as { sub?: string }).sub ?? 'anon';
      } catch {
        return 'anon'; // malformed token — the anonymous scope
      }
    };
    // Legacy-copy recovery — project create on the hold engine (`./projectCreateHold`, #720): the record,
    // its cross-tab lock and its transitions live there; what follows binds them to this store's session,
    // gateway and screen.
    const currentCreateHoldScope = (): string =>
      createHoldScope(get().sessionToken ? sessionSub() : null, get().sessionUserId);
    /** What a create is bound to, captured at the CLICK, so a sign-out, persona change or project switch
     *  begun while it waits or while it is out is seen as one. */
    type CreateSendContext = { scope: string; identity: string; project: { id: string | null; generation: number } };
    const sessionIdentity = (): string => `${sessionSub()}|${get().sessionUserId ?? ''}`;
    const captureCreateContext = (): CreateSendContext => ({
      scope: currentCreateHoldScope(),
      identity: sessionIdentity(),
      project: { id: get().activeProjectId, generation: get().projectScopeGeneration },
    });
    const UNCONFIRMED = 'The server did not confirm the project was created. Try again — it is safe: the server answers a retry of this same request without making a second project.';
    const UNCONFIRMED_FOR_DEPARTED = 'Your last project create was not confirmed by the server. Try again — it is safe: the server answers a retry of that same request without making a second project.';
    const SUPERSEDED = 'This create was finished or taken over in another tab, so nothing more was sent from here. Check the project list before creating it again.';
    /**
     * Send ONE reserved attempt and settle it from the reply. A new create (`was` null) and "Try again"
     * (`was` the record it retries) both come here, after their reservation. Nothing is sent to a server that
     * keeps no receipts (a bundle served ahead of its API, Codex 4187372404), nor once the click's user has
     * left, nor once another tab has taken the attempt over (the engine's fence, Codex 4192524390).
     */
    const sendReserved = async (gw: ApiGateway, r: Reservation, was: Extract<CreateRecord, { state: 'held' }> | null, ctx: CreateSendContext): Promise<CreateProjectOutcome> => {
      const { scope } = ctx;
      const sync = () => get().syncProjectCreateHold();
      const sameUser = () => sessionIdentity() === ctx.identity;
      if (!(await serverKeepsCreateReceipts(() => gw.serverFeatures()))) {
        await releaseCreate(scope, r, was);
        sync();
        return was ? { kind: 'unknown', message: SERVER_NOT_READY_RETRY } : { kind: 'refused', message: SERVER_NOT_READY };
      }
      if (!sameUser()) {
        await releaseCreate(scope, r, was);
        sync();
        return { kind: 'stale' };
      }
      // the identity is checked again at the SEND, inside the lock: the gateway sends with whoever's token is
      // current then, so a sign-in as another user while this waited for the lock must send nothing
      const departed = new Error('the click\'s user left before the send');
      const sent = await beginCreateSend(scope, r, () => (sameUser() ? gw.createProject(r.orgId, r.input, r.attempt) : Promise.reject(departed)));
      sync();
      if (sent.kind === 'superseded') {
        get().loadOrgData();
        return { kind: 'unknown', message: SUPERSEDED };
      }
      if (sent.kind === 'refused') return { kind: 'refused', message: sent.message };

      let created: { id: string; short: string };
      try {
        created = await sent.reply;
      } catch (err) {
        if (err === departed) {
          await releaseCreate(scope, r, was); // never sent: put it back as it was
          sync();
          return { kind: 'stale' };
        }
        // A DEFINITE refusal (the outbox's own rule: a 4xx other than 401/408/429, Codex 4185009892) rolled
        // the whole initialization back, its receipt with it: nothing was made, so the reason is the
        // server's own (e.g. the copied structure's rename advice). Anything else may still commit, so the
        // attempt is kept for "Try again" under the same key — never guessed by name (Codex 4180668018) or
        // by a list check (Codex 4185707835). A reply after its user left keeps THEIR attempt (4187663041).
        const definite = isTerminalOutboxError(err);
        await settleCreate(scope, r, definite ? { kind: 'refused' } : { kind: 'unknown', message: sameUser() ? UNCONFIRMED : UNCONFIRMED_FOR_DEPARTED });
        sync();
        if (!sameUser()) return { kind: 'stale' };
        if (definite) return { kind: 'refused', message: refusalMessage(err) ?? 'Could not create the project — check your access.' };
        get().loadOrgData();
        return { kind: 'unknown', message: UNCONFIRMED };
      }
      await settleCreate(scope, r, { kind: 'confirmed' });
      sync();
      // the reply belongs to the user who sent it: one landing after a sign-out or persona change is dropped
      if (!sameUser()) return { kind: 'stale' };
      get().loadOrgData();
      // Created (or replayed). It opens only in the project SCOPE it was sent from — a switch begun while it
      // was out bumps the generation at once (Codex 4180481920) — and opening is a separate step that can
      // fail on its own, so the dialog still closes and nothing invites a second create.
      const sameScope = get().pendingProjectId === null && get().activeProjectId === ctx.project.id
        && get().projectScopeGeneration === ctx.project.generation;
      if (!sameScope) {
        get().flash('Project created: ' + created.short + ' — open it from the project switcher.');
        return { kind: 'created', projectId: created.id, opened: false };
      }
      get().flash('Project created: ' + created.short + '.');
      const opened = await get().switchProject(created.id);
      if (!opened && sameUser()) get().flash('Project created: ' + created.short + ', but it could not be opened — pick it from the project switcher.');
      return { kind: 'created', projectId: created.id, opened };
    };
    // Persisted beside the outbox under the SAME user + project scope (WEB-02), so work recorded in
    // one project (or by one user on a shared device) is never laid over another's log.
    const dailyLogDraftKey = (): string => `vitan.dailyLogDraft.${sessionSub()}.${get().activeProjectId}`;
    // the kept-aside legacy draft (owner ruling, #692), under its own key in the same scope
    const legacyDailyLogDraftKey = (): string => `vitan.dailyLogDraft.legacy.${sessionSub()}.${get().activeProjectId}`;
    const persistDailyLogDraft = (): void => {
      try {
        const storage = globalThis.localStorage;
        if (!storage) return;
        const draft = get().dailyLogDraft;
        if (!draft) storage.removeItem(dailyLogDraftKey());
        else if (draft.projectId === get().activeProjectId) storage.setItem(dailyLogDraftKey(), JSON.stringify(draft));
        // a draft for another project is never written under this project's key
        const legacy = get().legacyDailyLogDraft;
        if (!legacy) storage.removeItem(legacyDailyLogDraftKey());
        else if (legacy.projectId === get().activeProjectId) storage.setItem(legacyDailyLogDraftKey(), JSON.stringify(legacy));
      } catch {
        /* storage unavailable — the in-session draft still works */
      }
    };
    /** A queued photo upload from an earlier release has no `clientKey`; give it one (#482), so each replay of it
     *  is the same photo on the server. Ops that already carry a key, and every other op, pass unchanged.
     *  The key is DERIVED from the queue's scope, the upload's own content and its place among identical
     *  uploads, never minted: two tabs hydrating the same queue (or a reload whose write-back failed) reach
     *  the same key, so their replays are still one photo. */
    const keyQueuedPhotoUploads = (ops: OutboxOp[], scope: string): { ops: OutboxOp[]; changed: boolean } => {
      let changed = false;
      const seen = new Map<string, number>();
      const keyed = ops.map((o) => {
        if (o.t !== 'uploadMedia' || o.input.clientKey) return o;
        changed = true;
        const content = `${scope}\n${JSON.stringify(o.input)}`;
        const nth = seen.get(content) ?? 0;
        seen.set(content, nth + 1);
        const keyedOp = { ...o, input: { ...o.input, clientKey: `legacy-photo-${contentHash(content)}-${nth}` } };
        queueKeys.adopt(scope, o, keyedOp); // L2b (G1): the keyed photo is the same occurrence, in the same place
        return keyedOp;
      });
      return { ops: keyed, changed };
    };
    /** Land the SERVER's log on the store with the engineer's unsent draft laid over it; the draft
     *  that no longer applies (the log was sent, a new day replaced it, or there is no log) is dropped
     *  in the same update. The one place `s.dailyLog` takes a server log. */
    const applyServerDailyLog = (s: AppState, serverLog: DailyLog | null, projectId: string): void => {
      const r = overlayDailyLogDraft(serverLog, s.dailyLogDraft, projectId);
      s.dailyLog = r.log;
      s.dailyLogDraft = r.draft;
      // a draft written before the log carried an id is kept aside, never laid over it (#692)
      if (r.legacy) s.legacyDailyLogDraft = r.legacy;
      storedProgress = serverLog?.id && !serverLog.submitted && serverLog.photoCount === undefined
        ? { identity: dailyLogIdentity(serverLog), progress: serverLog.progress } : null;
      drainSentSitePhotos(s, projectId);
      recountDailyLogPhotos(s);
    };
    /** #917 (#1167): a server that sends no `photoCount` — the count it stored for the log on show, as it landed. The count
     *  shown is always that, plus the photos the draft holds, plus the site photos queued here for the log, so a queued
     *  photo is counted from the queue alone and nothing has to take it back out of the draft */
    let storedProgress: { identity: string; progress: number } | null = null;
    /** #917 (#1167): the site photos queued here for this log, by key: an op with its kept row filed on the log, that the
     *  log does not already show from the server and the draft does not already hold */
    const queuedSitePhotos = (s: AppState, log: DailyLog): Set<string> => {
      const drafted = draftAppliesTo(s.dailyLogDraft, log, s.activeProjectId) ? s.dailyLogDraft!.sentPhotoKeys ?? [] : [];
      const keys = new Set<string>();
      for (const o of s.outbox) {
        if (o.t !== 'uploadSitePhoto' || drafted.includes(o.clientKey) || log.photos.some((p) => p.id && p.clientKey === o.clientKey)) continue;
        if (s.sitePhotosKept.some((k) => k.clientKey === o.clientKey && k.dailyLogId === log.id)) keys.add(o.clientKey);
      }
      return keys;
    };
    /** #482 site photos unit 3 — a server that counts the day's photos (`photoCount`: every member's photos filed on
     *  the log) is the count, plus this device's uploads for that log the server does not hold
     *  yet: queued ones and online ones in flight, each known by its upload key, so a photo the server already holds
     *  (its reply lost, or a refresh that landed before the reply) is never counted twice. A server that sends no
     *  `photoCount` keeps the count as before (the stored count plus the photos taken here). The added uploads are
     *  shown only: Send stores the server's own count, so an upload that never lands is never stored. */
    // A server that sends no `photoCount`: the count it stored, the draft's photos and the site photos queued here
    // (`storedProgress`, #1167). A log that landed before this release's count, or a sent one, keeps its count as it is
    const recountDailyLogPhotos = (s: AppState): void => {
      const log = s.dailyLog;
      if (!log?.id) return;
      if (log.photoCount === undefined) {
        if (log.submitted || storedProgress?.identity !== dailyLogIdentity(log)) return;
        const drafted = draftAppliesTo(s.dailyLogDraft, log, s.activeProjectId) ? s.dailyLogDraft!.photosAdded ?? 0 : 0;
        log.progress = storedProgress.progress + drafted + queuedSitePhotos(s, log).size;
        return;
      }
      const held = new Set(log.myPhotoKeys ?? []);
      // an upload the server is seen to hold, or one settled for a log no longer on screen, needs no more counting
      s.photoUploadsInFlight = s.photoUploadsInFlight.filter((u) => !u.settled || (u.dailyLogId === log.id && !held.has(u.clientKey)));
      const mine = new Set<string>();
      for (const o of s.outbox) {
        if (o.t === 'uploadMedia' && o.input.dailyLogId === log.id && o.input.clientKey && !held.has(o.input.clientKey)) mine.add(o.input.clientKey);
        // #917: queued by its key, its log read from its row on this phone
        if (o.t === 'uploadSitePhoto' && !held.has(o.clientKey) && s.sitePhotosKept.some((k) => k.clientKey === o.clientKey && k.dailyLogId === log.id)) mine.add(o.clientKey);
      }
      for (const u of s.photoUploadsInFlight) if (u.dailyLogId === log.id && !held.has(u.clientKey)) mine.add(u.clientKey);
      log.progress = log.photoCount + mine.size;
    };
    /** Record what the engineer just did on the log on screen into the pending draft for THAT log
     *  (a draft written against another log is superseded). A sent log takes no draft. */
    const recordDailyLogDraft = (s: AppState, mutate: (d: DailyLogDraft) => void): void => {
      if (!s.dailyLog || s.dailyLog.submitted) return;
      const logKey = dailyLogKey(s.dailyLog);
      const logId = s.dailyLog.id;
      // a draft written against another log — another project, another civil day, or another log of
      // the same day (a different server id) — is superseded, never carried over (U1, #690)
      const prior = s.dailyLogDraft;
      // a draft written before the log carried an id is never bound to this one by a tap: it is kept
      // aside, intact, for the engineer to confirm or discard (owner ruling, #692)
      if (prior && !prior.logId && logId && prior.projectId === s.activeProjectId && draftHoldsWork(prior)) {
        s.legacyDailyLogDraft = prior;
      }
      const other = !prior
        || prior.projectId !== s.activeProjectId
        || prior.logKey !== logKey
        || (!!logId && prior.logId !== logId);
      if (other) s.dailyLogDraft = { projectId: s.activeProjectId, logKey, ...(logId ? { logId } : {}) };
      mutate(s.dailyLogDraft!);
    };
    /** …a crew count set on one row (absolute — the latest count), the draft's crew rule. Keyed by the
     *  row's position with its trade (`crewRows`), so a free-text trade name can never collide with
     *  another row's key and each row's count is kept for that row. */
    const recordDraftCrew = (s: AppState, idx: number, count: number): void => {
      const row = s.dailyLog?.crew[idx];
      if (!row) return;
      recordDailyLogDraft(s, (d) => { d.crewRows = { ...(d.crewRows ?? {}), [String(idx)]: { trade: row.trade, count } }; });
    };
    /** …one more progress photo taken for this log on this device. */
    const recordDraftPhoto = (s: AppState): void =>
      recordDailyLogDraft(s, (d) => { d.photosAdded = (d.photosAdded ?? 0) + 1; });
    /** #917 (#1167): …one more, a site photo whose send the server confirmed, once by its key: met again (its answer here
     *  and then its op's copy settled by its marker, or after a reload) it adds nothing. A photo only queued is never in
     *  the draft: the queue counts it (`queuedSitePhotos`), so a refusal or a gone row has nothing to take back here.
     *  One the log on show already holds from the server adds nothing, as a yes then adds nothing */
    const recordDraftSentPhoto = (s: AppState, clientKey: string): void => {
      if (s.dailyLog?.photos.some((p) => p.id && p.clientKey === clientKey)) return;
      recordDailyLogDraft(s, (d) => {
        if (d.sentPhotoKeys?.includes(clientKey)) return;
        d.photosAdded = (d.photosAdded ?? 0) + 1;
        d.sentPhotoKeys = [...(d.sentPhotoKeys ?? []), clientKey];
      });
    };
    /** #917 (#1167, Codex 4411296873): a site photo whose send was confirmed while its log was not on show (a replay at
     *  boot, or a module read not landed yet) waits here, by key, for that log, under the same person and project as the
     *  draft (so a sign-out or a switch never carries it across). Only ever added to; the log's next landing moves it
     *  into its draft. An entry ends when its log lands and takes it, when a log of another id lands (the draft for
     *  another log is superseded then, U1 #690), or when its log is sent; nothing ends before it is counted. At most
     *  `SENT_SITE_PHOTOS_MAX` entries of other logs: one more drops the oldest of those, never one for the newest entry's
     *  log, which may still be open (Stage 1 gap-check, PR3). So a project nobody opens again keeps a few lines only.
     *  Every write runs under the list's own Web Lock (the queue keys' helper), reading the list as it stands then and
     *  merging by key, so another tab's entries stay. An entry not yet written (no lock, or storage refused it) is kept
     *  in memory, taken by a landing here, and written again by the next write of the list */
    const SENT_SITE_PHOTOS_MAX = 50;
    type SentSitePhoto = { logId: string; clientKey: string };
    const sentSitePhotosKey = (projectId: string): string => `vitan.dailyLogSentPhotos.${sessionSub()}.${projectId}`;
    const sentSitePhotosUnwritten = new Map<string, SentSitePhoto[]>();
    /** …the list within its bound: over it, the oldest entries of logs other than the newest entry's go first */
    const boundSent = (list: SentSitePhoto[]): SentSitePhoto[] => {
      const newest = list.at(-1)?.logId;
      let over = list.length - SENT_SITE_PHOTOS_MAX;
      return list.filter((e) => (over > 0 && e.logId !== newest ? (over -= 1, false) : true));
    };
    const readSentSitePhotos = (key: string): SentSitePhoto[] => {
      try {
        const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]');
        return Array.isArray(raw)
          ? raw.filter((e): e is SentSitePhoto => !!e && typeof e === 'object' && typeof (e as { logId?: unknown }).logId === 'string' && typeof (e as { clientKey?: unknown }).clientKey === 'string')
          : [];
      } catch { return []; }
    };
    /** Change the list as it stands under its lock (`change` gets the stored entries and this tab's unwritten ones, merged by
     *  key); this tab's unwritten entries are let go once a write lands */
    const writeSentSitePhotos = (key: string, change: (list: SentSitePhoto[]) => SentSitePhoto[]): void => {
      const pending = [...(sentSitePhotosUnwritten.get(key) ?? [])];
      void underQueueLock(key, () => {
        const storage = globalThis.localStorage;
        if (!storage) return false;
        const stored = readSentSitePhotos(key);
        const list = boundSent(change([...stored, ...pending.filter((e) => !stored.some((x) => x.clientKey === e.clientKey))]));
        try {
          if (list.length === 0) storage.removeItem(key);
          else storage.setItem(key, JSON.stringify(list));
          return true;
        } catch { return false; }
      }).then((done) => {
        if (!done) return;
        const left = (sentSitePhotosUnwritten.get(key) ?? []).filter((e) => !pending.some((x) => x.clientKey === e.clientKey));
        if (left.length) sentSitePhotosUnwritten.set(key, left); else sentSitePhotosUnwritten.delete(key);
      });
    };
    /** #917 (#1167): a confirmed send, in the draft of the log it was filed on: at once when that log is on show, otherwise
     *  kept for it until it lands */
    const confirmSitePhoto = (s: AppState, clientKey: string, dailyLogId: string | undefined, projectId: string): void => {
      if (!dailyLogId) return;
      if (s.dailyLog?.id === dailyLogId && projectId === s.activeProjectId) {
        if (!s.dailyLog.submitted) recordDraftSentPhoto(s, clientKey);
        return;
      }
      const key = sentSitePhotosKey(projectId);
      const entry = { logId: dailyLogId, clientKey };
      const unwritten = sentSitePhotosUnwritten.get(key) ?? [];
      if (!unwritten.some((e) => e.clientKey === clientKey)) sentSitePhotosUnwritten.set(key, boundSent([...unwritten, entry]));
      writeSentSitePhotos(key, (list) => (list.some((e) => e.clientKey === clientKey) ? list : [...list, entry]));
    };
    /** …moved into the draft of the log that landed (the draft is written by the apply that called this). A sent log takes
     *  none, and its entries end with it */
    const drainSentSitePhotos = (s: AppState, projectId: string): void => {
      const log = s.dailyLog;
      if (!log?.id || projectId !== s.activeProjectId) return;
      const key = sentSitePhotosKey(projectId);
      const stored = readSentSitePhotos(key);
      const unwritten = sentSitePhotosUnwritten.get(key) ?? [];
      if (stored.length === 0 && unwritten.length === 0) return;
      const landed = log.id;
      // taken into its draft (a key the draft holds adds nothing), or superseded by this log; ended in the list as it
      // stands under its lock, so an entry another tab adds meanwhile for this log stays for the next landing
      const taken = [...stored, ...unwritten].filter((e) => e.logId === landed).map((e) => e.clientKey);
      if (!log.submitted) for (const k of taken) recordDraftSentPhoto(s, k);
      sentSitePhotosUnwritten.delete(key);
      writeSentSitePhotos(key, (list) => list.filter((e) => e.logId === landed && !taken.includes(e.clientKey)));
    };

    const applySnapshotCore = (snap: ApiSnapshot, decisionsResult?: ModuleDecisions | null, dailyLogResult?: ModuleDailyLog | null, drawingsResult?: ModuleDrawings | null, inspectionsResult?: ModuleInspections | null, activitiesResult?: ModuleActivities | null): void => {
      set((s) => {
        s.projectLoadState = 'ready'; // the active project's data has landed
        s.projectLoadError = null;
        s.pendingProjectId = null;
        // Phase 2 Task 9 — XOR read-ownership for decisions. In 'snapshot' mode (default) the snapshot
        // slice OWNS `s.decisions` (unchanged). In 'moduleQuery' mode the module-owned read owns it and
        // the snapshot's slice is IGNORED: a `decisionsResult` (fetched under THIS same scope lease)
        // sets it (ready); a `null` result means the module fetch FAILED — keep the last-good decisions
        // and expose an error boundary; `undefined` means no fetch accompanied this apply (a command's
        // own snapshot response) — leave `s.decisions` untouched until the follow-up module refresh.
        if (decisionsReadMode() === 'snapshot') {
          s.decisions = snap.decisions;
        } else if (decisionsResult) {
          s.decisions = decisionsResult.decisions;
          s.decisionsLoad = 'ready';
          s.decisionsSource = decisionsResult.source;
        } else if (decisionsResult === null) {
          s.decisionsLoad = 'error';
        }
        // Phase 2 Task 10 (Module 4 — Activities) — XOR read-ownership for the activity spine
        // (`activities` here, `phases` below), mirroring inspections. 'snapshot' mode (default): the
        // snapshot slices OWN them (unchanged). 'moduleQuery' mode: the module-owned read (readiness
        // baked FRESH from the foreign query contracts on both paths, fetched under THIS same scope
        // lease) owns them, and the snapshot's slices are IGNORED. A result sets them (ready); `null` =
        // the module fetch FAILED (keep last-good, expose an error boundary); `undefined` = no fetch
        // accompanied this apply (a command's own snapshot) — leave untouched until the follow-up refresh.
        const actModule = activitiesReadMode() === 'moduleQuery';
        if (!actModule) {
          s.activities = snap.activities;
        } else if (activitiesResult) {
          s.activities = structuredClone(activitiesResult.activities) as typeof s.activities;
          s.activitiesLoad = 'ready';
          s.activitiesSource = activitiesResult.source;
        } else if (activitiesResult === null) {
          s.activitiesLoad = 'error';
        }
        // The snapshot is the whole truth for its project. checklist/dailyLog are
        // assigned DIRECTLY, including null — absence means "this project has none",
        // never "keep the previous project's".
        // Phase 2 Task 10 (Module 3 — Inspections) — XOR read-ownership for the inspection slices
        // (checklist / reviews / reinspectionCreated / placedInspections), mirroring drawings. 'snapshot'
        // mode (default): the snapshot slices OWN them (unchanged). 'moduleQuery' mode: the module-owned
        // read (baked PER-VIEWER/ROLE — the PMC-only review queue, fresh signed evidence paths — under THIS
        // same scope lease) owns them, and the snapshot's slices are IGNORED. A result sets them (ready);
        // `null` = the module fetch FAILED (keep last-good, expose an error boundary); `undefined` = no
        // fetch accompanied this apply (a command's own snapshot) — leave untouched until the follow-up
        // refresh. The engineer's unsubmitted per-field marks + the submission freeze are re-applied below
        // to whatever checklist now owns the slot, so mark preservation is source-independent.
        const inspModule = inspectionsReadMode() === 'moduleQuery';
        if (!inspModule) {
          // The snapshot serves the whole outstanding set too. It is the DEFAULT read path
          // (`VITE_INSPECTIONS_READ` unset), so a list derived here from the single `checklist`
          // would have left the second issued checklist invisible on the path nearly every
          // deployment uses — the fix would only have worked once the non-default module read was
          // switched on. The fallback covers a client that outran its server.
          // The old-server fallback is `outstandingFrom` — the SAME rule the module branch below
          // takes, because "the server did not send the field" means the same thing on both.
          const open = outstandingFrom(snap.openChecklists, snap.checklist);
          s.openChecklists = open;
          const owner = ownerOfEditSlot(open, snap.checklist ?? null, s.selectedChecklistId);
          s.checklist = owner.checklist;
          s.selectedChecklistId = owner.selectedId;
        } else if (inspectionsResult) {
          // A CLIENT-FIRST rollout reaches a previous-release API here too: that endpoint returns
          // `checklist` and has no `openChecklists` at all, and coercing the missing field to `[]`
          // told the PMC no work was out on site while the very same response carried an unsubmitted
          // checklist. Same rule, same function as the snapshot branch above.
          const open = outstandingFrom(inspectionsResult.openChecklists, inspectionsResult.checklist);
          s.openChecklists = open;
          const owner = ownerOfEditSlot(open, inspectionsResult.checklist ?? null, s.selectedChecklistId);
          s.checklist = owner.checklist;
          s.selectedChecklistId = owner.selectedId;
          s.inspectionsLoad = 'ready';
          s.inspectionsSource = inspectionsResult.source;
        } else if (inspectionsResult === null) {
          s.inspectionsLoad = 'error';
        }
        // gate round 6: overlay the engineer's UNSUBMITTED per-field edits back onto the fresh
        // server checklist. This is the ONE place marks survive a refresh — the upload's own
        // snapshot AND every background useApiSync `changed` refresh flow through here, so
        // preservation is uniform. `overlayChecklistMarks` is also what a deliberate switch between
        // open checklists calls, so both paths restore intent by exactly the same rule.
        overlayChecklistMarks(s);
        // gate round 8: re-derive the submission freeze from this fresh server
        // truth + the durable outbox. A background `changed` refresh mid-submit
        // must keep the checklist frozen; a reload rebuilds a queued submit's
        // freeze; a server-confirmed submit idles the pending status.
        reconcileSubmission(s);
        // XOR (Task 10 Module 3): the review queue + reinspection flag follow the same ownership as the
        // checklist above. moduleQuery + result → module slices; moduleQuery + null/undefined → keep
        // last-good (the checklist block already set the load/error state for this apply). The PMC's
        // unsent rejection marks survive the replacement (`restoreReviewRejectionMarks`).
        const rejectionMarks = reviewRejectionMarks(s.reviews);
        if (!inspModule) {
          s.reviews = snap.reviews ?? (snap.review ? [snap.review] : []);
          s.reinspectionCreated = snap.reinspectionCreated;
        } else if (inspectionsResult) {
          s.reviews = [...inspectionsResult.reviews];
          s.reinspectionCreated = inspectionsResult.reinspectionCreated;
        }
        s.reviews = restoreReviewRejectionMarks(s.reviews, rejectionMarks);
        if (s.activeReviewId && !s.reviews.some((r) => r.id === s.activeReviewId)) s.activeReviewId = null;
        // Phase 2 Task 10 (Module 2 — Drawings) — XOR read-ownership for the drawing register, mirroring
        // decisions/daily-log. 'snapshot' mode (default): the snapshot slice OWNS `s.drawings` (unchanged).
        // 'moduleQuery' mode: the module-owned read (baked PER-VIEWER — author-visible drafts, this
        // caller's ack/recipient state, a fresh time-limited signed url — under THIS same scope lease)
        // owns it, and the snapshot's slice is IGNORED. A `drawingsResult` sets it (ready); `null` = the
        // module fetch FAILED (keep last-good, expose an error boundary); `undefined` = no fetch
        // accompanied this apply (a command's own snapshot) — leave untouched until the follow-up refresh.
        if (drawingsReadMode() === 'snapshot') {
          s.drawings = snap.drawings ?? [];
        } else if (drawingsResult) {
          s.drawings = [...drawingsResult.drawings];
          s.drawingsLoad = 'ready';
          s.drawingsSource = drawingsResult.source;
        } else if (drawingsResult === null) {
          s.drawingsLoad = 'error';
        }
        // Placed site photos come back as signed API-relative serve paths — resolve
        // them against the API base so the Place view's <img src> hits the API.
        s.photos = (snap.photos ?? []).map((p) => ({ ...p, url: resolveMediaUrl(p.url) }));
        s.photosWindowShort = false; // the window is the server's again
        // #482 site photos — the viewer's own photos in their hour past that window: under the same lease, so a pull
        // superseded by a delete can no more refill this list than the window
        s.myDeletablePhotos = (snap.myDeletablePhotos ?? []).map((p) => ({ ...p, url: resolveMediaUrl(p.url) }));
        // (s.materials + s.dailyLog are set together under the daily-log XOR below)
        // pmc/engineer get the placed inspections; other roles get [] from the server
        // XOR (Task 10 Module 3): the Site-Map inspection placements follow the same ownership.
        if (!inspModule) {
          s.placedInspections = snap.placedInspections ?? [];
        } else if (inspectionsResult) {
          s.placedInspections = [...inspectionsResult.placedInspections];
        }
        // XOR (Task 10 Module 4): the phases follow the same ownership as the activities above.
        // moduleQuery + result → module slice; moduleQuery + null/undefined → keep last-good (the
        // activities block already set the load/error state for this apply).
        if (!actModule) {
          s.phases = snap.phases ?? [];
        } else if (activitiesResult) {
          s.phases = structuredClone(activitiesResult.phases) as typeof s.phases;
        }
        // Phase 2 Task 10 — XOR read-ownership for the daily-log slice (log core + crew + materials),
        // mirroring decisions. The media progress PHOTOS are ALWAYS composed from the snapshot (media,
        // not daily-log, owns them) — they come back as signed API-relative serve paths (/media/:id?t=…)
        // resolved against the API base — so both modes attach the identical `progressPhotos`; only the
        // log CORE + materials switch ownership. 'snapshot' mode (default): the snapshot slice owns them
        // (unchanged). 'moduleQuery' mode: a `dailyLogResult` (fetched under THIS same scope lease) owns
        // them (ready); `null` = the module fetch FAILED (keep last-good, expose an error boundary);
        // `undefined` = no fetch accompanied this apply (a command's own snapshot) — leave untouched.
        //
        // #669 Today regression — whichever mode owns the log CORE, the engineer's UNSENT work on it
        // (check-in, crew, photos taken — persisted by the server only with the send) is laid over the
        // server's log by `applyServerDailyLog` in the SAME update, so a material recorded or a photo
        // uploaded on the way to Send never resets the day. Only a branch that actually REPLACES the log
        // overlays: an apply that leaves `s.dailyLog` untouched (moduleQuery + no module read) must not
        // lay the draft over an already-overlaid log.
        const progressPhotos = (snap.dailyLog?.photos ?? []).map((p) => ({ ...p, url: resolveMediaUrl(p.url) }));
        if (dailyLogReadMode() === 'snapshot') {
          applyServerDailyLog(s, snap.dailyLog ? { ...snap.dailyLog, photos: progressPhotos } : null, snap.project.id);
          s.materials = snap.materials ?? [];
        } else if (dailyLogResult) {
          // The module read is the shared wire contract (DailyLogModuleResult, finding 5): its `swatch`
          // fields are open strings and its arrays readonly. Narrow them to the store's DTO (SwatchKey,
          // mutable) at this ONE boundary — the values are always valid swatch keys (a closed set).
          const core = dailyLogResult.dailyLog;
          applyServerDailyLog(s, core
            ? {
                // the log's own id (U1, #690): the draft and Today's crew questions bind to it, so it is
                // carried on the module read exactly as on the snapshot path
                ...(core.id ? { id: core.id } : {}),
                date: core.date, logDate: core.logDate, checkedIn: core.checkedIn, checkinTime: core.checkinTime,
                submitted: core.submitted, progress: core.progress,
                crew: core.crew.map((c) => ({ trade: c.trade, count: c.count })),
                // the log before it (U1b): "Same as yesterday" reads it on either read path
                ...(core.previous !== undefined
                  ? { previous: core.previous && { logDate: core.previous.logDate, crew: core.previous.crew.map((c) => ({ trade: c.trade, count: c.count })) } }
                  : {}),
                materials: core.materials.map((m) => ({ name: m.name, decisionId: m.decisionId, qty: m.qty, zone: m.zone, matched: m.matched, swatch: m.swatch as SwatchKey, photo: m.photo })),
                photos: progressPhotos,
                // the day's photo count is the snapshot's (#482 unit 3: media is not the daily-log module's to read),
                // and only for the log it counted
                ...(core.id && snap.dailyLog?.id === core.id && snap.dailyLog.photoCount !== undefined
                  ? { photoCount: snap.dailyLog.photoCount, myPhotoKeys: snap.dailyLog.myPhotoKeys ?? [] }
                  : {}),
              }
            : null, snap.project.id);
          s.materials = dailyLogResult.materials.map((m) => ({ id: m.id, name: m.name, qty: m.qty, zone: m.zone, matched: m.matched, swatch: m.swatch as SwatchKey, decisionId: m.decisionId, nodeId: m.nodeId }));
          s.dailyLogLoad = 'ready';
          s.dailyLogSource = dailyLogResult.source;
        } else if (dailyLogResult === null) {
          s.dailyLogLoad = 'error';
        }
        s.notifications = snap.notifications;
        // Top 10 #4b unit D — the server's `unread` retires confirmed marks and re-arms unacknowledged ones
        reconcileSeen(s.notifSeen, s.notifications);
        s.companies = snap.companies ?? [];
        s.name = snap.project.name;
        s.short = snap.project.short;
        s.descriptor = snap.project.descriptor;
        s.stage = snap.project.stage;
        s.siteCode = snap.project.siteCode;
        s.location = snap.project.location ?? '';
        s.timeZone = snap.project.timeZone ?? null;
        s.projStart = snap.project.projStart;
        s.projEnd = snap.project.projEnd;
        s.scheduleStartDate = snap.project.scheduleStartDate ?? null;
        s.scheduleEndDate = snap.project.scheduleEndDate ?? null;
        s.elapsedPct = snap.project.elapsedPct;
        s.todayDay = snap.project.todayDay;
        s.milestonePct = snap.project.milestonePct;
        s.nodes = snap.nodes ?? [];
      });
      persistDailyLogDraft();
    };

    /** The ONE ordered entry point for applying a snapshot. Checks, in order:
     *  (1) current-scope — a project switch / re-auth since the request started;
     *  (2) newest-sequence — a newer lease (socket refresh, mutation or submit) has
     *      taken ownership, so this response is stale even in the same scope;
     *  (3) snapshot-project — the payload is for a different project (wrong-project);
     *  then applies. The result MUST be consumed; success is announced only for
     *  `applied`. `superseded` / `scope-moved` are silent no-ops; `invalid-project`
     *  never reports success and the caller requests a fresh snapshot to recover. */
    const acceptSnapshot = (snap: ApiSnapshot, lease: SnapshotLease, decisionsResult?: ModuleDecisions | null, dailyLogResult?: ModuleDailyLog | null, drawingsResult?: ModuleDrawings | null, inspectionsResult?: ModuleInspections | null, activitiesResult?: ModuleActivities | null): SnapshotApplyResult => {
      const st = get();
      if (!isCurrentProjectScope(st.activeProjectId, st.projectScopeGeneration, lease.scope)) return 'scope-moved';
      // newest-owner is checked against THIS lease's own scope, so a stale lease in a
      // scope we've left can never mark a live scope's response superseded (round 12).
      if (lease.sequence !== coordinatorFor(lease.scope).newestLeaseSeq) return 'superseded';
      if (snap.project.id !== lease.scope.projectId) return 'invalid-project';
      // Task 9/10 — the module decisions + daily-log + drawings + inspections + activities reads (if any)
      // rode the SAME lease as the snapshot, so they pass the identical scope/newest-owner ordering checks:
      // a stale module response is dropped with its snapshot, never applied over a newer scope's data.
      const prevTimeZone = st.timeZone;
      applySnapshotCore(snap, decisionsResult, dailyLogResult, drawingsResult, inspectionsResult, activitiesResult);
      // COMMAND and SUBMIT obligations clear INDEPENDENTLY (gate round 14). Only a pull that BEGAN AFTER
      // an obligation's threshold can satisfy it (round 13, semantic 2) — a stale in-flight refresh can't
      // disarm it. Codex 4210609574 — ANY applied snapshot satisfies the slices it refreshed (a command's
      // own applied snapshot included), not only the reconcile pull.
      const c = coordinatorFor(lease.scope);
      if (c.commandAfterSequence !== null && lease.sequence > c.commandAfterSequence) {
        // Round 2 finding 2: a command reconcile is CONFIRMED only once every slice it is owed for
        // reflects it. A module read that failed came back `null` and one this snapshot did not carry is
        // `undefined` — its committed change is NOT in that slice, so the slice stays owed (and its own
        // error state offers Retry); a snapshot-owned slice was refreshed by this applied snapshot. Live
        // bug 1b (Codex 4209988801) — each slice clears ON ITS OWN, so a failed read unsettles only itself.
        const read: Record<ReconcileSlice, unknown> = {
          decisions: decisionsResult, dailyLog: dailyLogResult, drawings: drawingsResult, inspections: inspectionsResult, activities: activitiesResult,
        };
        for (const slice of RECONCILE_SLICES) if (!sliceModuleOwned(slice) || read[slice] != null) c.commandOwed.delete(slice);
        // the committed command's change is now in every slice it was owed for
        if (c.commandOwed.size === 0) c.commandAfterSequence = null;
      }
      // Codex 4211133315 — likewise the submit obligation: any applied snapshot that began after it and
      // retired its exact attempt (applySnapshotCore's reconcile) confirms it, a command's own included
      if (c.submit && lease.sequence > c.submit.createdAfterSequence && !submitStillPending(c.submit)) c.submit = null;
      publishCommandOwed(c);
      // a committed daily-log command is reflected once a pull that BEGAN after it carries the
      // daily-log module read — success shows the new log, failure the read's own error state
      const after = get().dailyLogReconcileAfter;
      // (a send another tab made sets it under snapshot reads too: the snapshot carries the log, U2)
      if (after !== null && (dailyLogResult !== undefined || dailyLogReadMode() === 'snapshot') && lease.sequence > after) {
        set((s) => { s.dailyLogReconcileAfter = null; s.dailyLogReconcileKind = null; });
      }
      // #482 site photos — the day's photo count after a delete is the server's, read by a pull that began after the
      // delete was answered; a pull begun earlier may have counted the photo still there (Codex 4322142057)
      // ...and an upload answered here is counted from its answer only until a pull begun after that answer carried the log:
      // that pull's count is the server's, holding it or not (a photo deleted meanwhile, #1195 gap-check)
      const answered = (u: AppState['photoUploadsInFlight'][number]): boolean => u.settled && u.after !== undefined && lease.sequence > u.after;
      if ((dailyLogReadMode() === 'snapshot' || dailyLogResult != null) && get().photoUploadsInFlight.some(answered)) {
        set((s) => { s.photoUploadsInFlight = s.photoUploadsInFlight.filter((u) => !answered(u)); recountDailyLogPhotos(s); });
      }
      const countAfter = get().dailyLogPhotoCountAfter;
      if (countAfter !== null && lease.sequence > countAfter && (dailyLogReadMode() === 'snapshot' || dailyLogResult != null)) {
        set((s) => { s.dailyLogPhotoCountAfter = null; });
      }
      // Phase 4 Task 6 (Codex round 2) — on a cold labour-pilot boot the shell can trigger the
      // FIRST labour load before any snapshot has delivered the project timezone, so that load's
      // presence read fell back to the BROWSER's civil day. When an applied snapshot CHANGES the
      // known timezone, reload the labour bundle so today's presence re-reads for the SITE's civil
      // day (loadLabour is capability-guarded — a no-op off-pilot; both boot orders converge).
      if (get().timeZone !== prevTimeZone) get().loadLabour();
      return 'applied';
    };

    /** Codex 4211133323 — a module read that never settles (the gateway's fetches carry no timeout) must
     *  not hold every other slice of the pull: each read is bounded, and one that fails OR times out is a
     *  failed read (`null` — its slice keeps its last-good data, its error state and Retry). */
    const boundedModuleRead = <T,>(read: Promise<T>): Promise<T | null> => new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), MODULE_READ_TIMEOUT_MS);
      read.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
    const RECOVERABLE_LOAD_ERROR = 'Could not load this project — check your connection and access, then retry.';
    /** Coalesced fresh-snapshot pull for ONE scope — the ONE way to fetch current
     *  truth (socket refresh, initial load, retry, invalid-project recovery, and the
     *  reconcile a superseded command/submit schedules). At most one is in flight PER
     *  SCOPE (round 12); a request made while its scope's pull runs schedules exactly
     *  one more after it settles — even when that pull FAILED, so a superseded command
     *  still gets a recovery attempt. A pull only ever mutates its OWN scope; a scope
     *  we've left neither reruns nor surfaces errors. Never a loop: the rerun fires at
     *  most once per settle and only while nothing new re-queues it. */
    /** Is the pending submit named by an obligation STILL in flight (not yet confirmed
     *  by server truth)? Confirmed = its freeze has retired — a different inspection,
     *  a newer attempt, or an idle/read-only submission all count as "no longer owed". */
    const submitStillPending = (ob: SubmitObligation): boolean => {
      const sub = get().submission;
      return sub.status === 'submitting' && sub.inspectionId === ob.inspectionId && sub.attempt === ob.attempt;
    };
    /** #482 — settles once a pull of this scope that began after this call has settled (applied or failed): one now, or,
     *  while one is already on its way (it may predate what the caller needs it to show), the rerun queued after it */
    const afterFreshPull = (scope: ProjectScope): Promise<void> => new Promise((resolve) => {
      if (!gateway) { resolve(); return; }
      const c = coordinatorFor(scope);
      if (!c.refreshInFlight) { void requestFreshSnapshot(scope).catch(() => undefined).finally(resolve); return; }
      (c.afterPull ??= []).push(resolve);
      c.refreshQueued = true;
    });
    const requestFreshSnapshot = async (scope: ProjectScope = currentScope()): Promise<void> => {
      if (!gateway) return;
      const c = coordinatorFor(scope);
      if (c.refreshInFlight) { c.refreshQueued = true; return; }
      c.refreshInFlight = true;
      const g = gateway;
      // #948 Codex 4300725700 — the token THIS gateway carries, not the store's: a project switch adopts the new
      // token before the old gateway is replaced, and a refusal of the old token must not end the new session
      const tokenAtStart = g.authToken ?? null;
      const lease = beginSnapshotLease(scope);
      // the flag is the CURRENT scope's: a scope switched to carries only its own obligation
      if (scopeStillCurrent(scope)) publishCommandOwed(c);
      // initial load / retry surfaces 'loading'; a background refresh (already
      // 'ready') stays ready — stale-while-revalidate, no flash on every socket ping.
      if (scopeStillCurrent(scope) && get().projectLoadState !== 'ready') set((s) => { s.projectLoadState = 'loading'; });
      // Task 9 — in 'moduleQuery' mode surface the decisions module's own loading state for its
      // surfaces (guarded by scope, like the project load state), while snapshot mode leaves it idle.
      if (decisionsReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().decisionsLoad !== 'ready') {
        set((s) => { s.decisionsLoad = 'loading'; });
      }
      // Task 10 — same for the daily-log module read.
      if (dailyLogReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().dailyLogLoad !== 'ready') {
        set((s) => { s.dailyLogLoad = 'loading'; });
      }
      // Task 10 (Module 2 — Drawings) — same for the drawings module read.
      if (drawingsReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().drawingsLoad !== 'ready') {
        set((s) => { s.drawingsLoad = 'loading'; });
      }
      // Task 10 (Module 3 — Inspections) — same for the inspections module read.
      if (inspectionsReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().inspectionsLoad !== 'ready') {
        set((s) => { s.inspectionsLoad = 'loading'; });
      }
      // Task 10 (Module 4 — Activities) — same for the activities module read.
      if (activitiesReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().activitiesLoad !== 'ready') {
        set((s) => { s.activitiesLoad = 'loading'; });
      }
      try {
        // Task 9/10 — in 'moduleQuery' mode fetch the module-owned decisions and/or daily-log ALONGSIDE
        // the snapshot, under the SAME lease. Each module fetch is resilient: a failure yields `null` (an
        // explicit error state that keeps the last-good data) rather than failing the whole pull, so the
        // rest of the project still loads. In 'snapshot' mode no extra fetch happens (undefined → unchanged).
        const [snap, decisionsResult, dailyLogResult, drawingsResult, inspectionsResult, activitiesResult] = await Promise.all([
          g.snapshot(),
          decisionsReadMode() === 'moduleQuery'
            ? boundedModuleRead<ModuleDecisions>(g.decisions())
            : Promise.resolve(undefined as ModuleDecisions | undefined),
          dailyLogReadMode() === 'moduleQuery'
            ? boundedModuleRead<ModuleDailyLog>(g.dailyLog())
            : Promise.resolve(undefined as ModuleDailyLog | undefined),
          drawingsReadMode() === 'moduleQuery'
            ? boundedModuleRead<ModuleDrawings>(g.drawings())
            : Promise.resolve(undefined as ModuleDrawings | undefined),
          inspectionsReadMode() === 'moduleQuery'
            ? boundedModuleRead<ModuleInspections>(g.inspections())
            : Promise.resolve(undefined as ModuleInspections | undefined),
          activitiesReadMode() === 'moduleQuery'
            ? boundedModuleRead<ModuleActivities>(g.activities())
            : Promise.resolve(undefined as ModuleActivities | undefined),
        ]);
        const result = acceptSnapshot(snap, lease, decisionsResult, dailyLogResult, drawingsResult, inspectionsResult, activitiesResult);
        if (result === 'applied') {
          // Both obligations were judged in `acceptSnapshot`, independently (gate round 14) and only by a
          // pull that BEGAN AFTER their threshold (round 13, semantic 2). A command slice whose module read
          // FAILED stays owed: its own error state (last-good kept) exposes a Retry that re-runs this pull.
          // Bounded — no auto-loop re-queues it, and the project itself is fresh, so no project-level error
          // boundary is raised for it.
          if (c.submit && lease.sequence > c.submit.createdAfterSequence && scopeStillCurrent(scope)) {
            // applied, but the submit is STILL unconfirmed (a confirmed one was retired by
            // `acceptSnapshot`) — keep the submit obligation + freeze/marks and expose Retry EVEN THOUGH
            // the same snapshot may have satisfied the command obligation (gate round 14: they compose).
            set((s) => { s.projectLoadState = 'error'; s.projectLoadError = RECOVERABLE_LOAD_ERROR; });
          }
        } else if (result === 'invalid-project' && scopeStillCurrent(scope)) {
          set((s) => { s.projectLoadState = 'error'; s.projectLoadError = RECOVERABLE_LOAD_ERROR; });
        }
        // superseded / scope-moved: a newer owner or the queued rerun supplies truth.
      } catch (err) {
        // #482 6227430525 — the server refused this session's token (expired early, or the account's
        // access was removed): a session restored after a reload must not sit signed in on screens that
        // cannot load. A 401 ends any session; a 403 ends a RESTORED one (its project or role is no longer
        // the person's: removed, archived, role changed), which a fresh sign-in would have refused. Only the
        // token this pull carried; a sign-in that replaced it meanwhile is kept.
        const refusal = (err as { status?: number } | null)?.status;
        if (
          tokenAtStart !== null && get().sessionToken === tokenAtStart
          && (refusal === 401 || (refusal === 403 && tokenAtStart === restoredToken))
        ) {
          get().signOut();
          return;
        }
        // The pull failed. Surface the recoverable error/Retry boundary when the user is
        // waiting on THIS scope's data — an initial load / switch, or the MANDATORY
        // reconcile for ANY outstanding obligation (a pull that began after its threshold).
        // A pre-obligation refresh failing does NOT surface it — its own reconcile follows.
        if (scopeStillCurrent(scope)) set((s) => {
          const failedMandatory =
            (c.commandAfterSequence !== null && lease.sequence > c.commandAfterSequence) ||
            (c.submit !== null && lease.sequence > c.submit.createdAfterSequence);
          if (s.projectLoadState === 'switching' || s.projectLoadState === 'loading' || failedMandatory) {
            s.projectLoadState = 'error';
            s.projectLoadError = RECOVERABLE_LOAD_ERROR;
          }
        });
      } finally {
        c.refreshInFlight = false;
        // Rerun once if something queued a follow-up (a coalesced refresh OR a superseded
        // command/submit's reconcile) AND this scope is still current — this fires even
        // after a FAILED pull, so the mandatory reconcile always follows the settling
        // refresh. Bounded (semantic 7): the rerun fires at most once per settle; after a
        // failed / unconfirmed mandatory reconcile nothing re-queues, so we wait for Retry.
        const rerun = c.refreshQueued && scopeStillCurrent(scope);
        c.refreshQueued = false;
        // #482 — those waiting for a pull that began after they asked hear when the rerun settles (it begins after them),
        // or now when none follows (the scope was left: they check it themselves)
        const waiters = c.afterPull?.splice(0) ?? [];
        const tell = () => { for (const w of waiters) w(); };
        if (rerun) void requestFreshSnapshot(scope).catch(() => undefined).finally(tell);
        else { tell(); pruneScopeCoordinators(); }
      }
    };

    /** MERGE a reconciliation obligation onto a CURRENT-scope command/submit whose own
     *  snapshot was `superseded`, then queue/start the recovery pull (gate round 13/14).
     *  `superseded` proves a newer lease exists, NOT that it will land — the newer
     *  refresh may fail. Command and submit obligations are held SEPARATELY and NEVER
     *  overwrite each other (gate round 14). Each is pinned with `createdAfterSequence`
     *  so a refresh already in flight can't satisfy it. A moved scope owns its own truth,
     *  so a stale-scope reconcile is dropped. */
    const scheduleReconcile = (scope: ProjectScope, obligation: ReconcileObligation): void => {
      if (!scopeStillCurrent(scope)) return;
      const c = coordinatorFor(scope);
      if (obligation.kind === 'command') {
        // Live bug 1b (Codex 4209321885/4209988801) — the slices it is owed for: every module-owned
        // read (a command snapshot never carries one), and every snapshot-owned slice too unless the
        // command's own snapshot APPLIED (`modulesOnly`). Owed slices accumulate across commands.
        for (const slice of RECONCILE_SLICES) {
          if (!obligation.modulesOnly || sliceModuleOwned(slice)) c.commandOwed.add(slice);
        }
        // keep the LATEST command threshold: a snapshot crossing it necessarily reflects
        // every earlier committed command too, so no command obligation is ever dropped.
        c.commandAfterSequence = c.commandAfterSequence === null
          ? obligation.createdAfterSequence
          : Math.max(c.commandAfterSequence, obligation.createdAfterSequence);
        publishCommandOwed(c);
      } else {
        // the newest submit attempt owns the freeze (round 10 retired any older one)
        c.submit = { inspectionId: obligation.inspectionId, attempt: obligation.attempt, createdAfterSequence: obligation.createdAfterSequence };
        publishCommandOwed(c);
      }
      if (c.refreshInFlight) c.refreshQueued = true; // runs after the in-flight pull settles (even on failure)
      else void requestFreshSnapshot(scope);
    };

    /** Is ANY read surface module-owned right now (Task 9 decisions / Task 10 daily-log
     *  in 'moduleQuery' mode)? Under module ownership a command's OWN snapshot response
     *  deliberately does NOT carry the module slice (applySnapshotCore leaves it
     *  untouched to preserve the XOR), so a committed command needs a follow-up module
     *  refresh to become visible — see the reconcile in `consumeSnapshotResult`. */
    const sliceModuleOwned = (slice: ReconcileSlice): boolean =>
      ({ decisions: decisionsReadMode, dailyLog: dailyLogReadMode, drawings: drawingsReadMode, inspections: inspectionsReadMode, activities: activitiesReadMode })[slice]() === 'moduleQuery';
    /** Mirror the CURRENT scope's command obligation into the store (the judges read it there). */
    const publishCommandOwed = (c: ScopeCoordinator): void => {
      const pending = c.commandAfterSequence !== null;
      const owed = noReconcileOwed();
      if (pending) for (const slice of c.commandOwed) owed[slice] = true;
      // Codex 4210609583 — a committed submit awaiting confirmation has retained the pre-submit
      // inspection slice too, so that slice is owed until the submit obligation clears
      if (c.submit !== null) owed.inspections = true;
      const s0 = get();
      if (s0.commandReconcilePending === pending && RECONCILE_SLICES.every((k) => s0.commandReconcileOwed[k] === owed[k])) return;
      set((s) => { s.commandReconcilePending = pending; s.commandReconcileOwed = owed; });
    };
    const anyModuleOwnedRead = (): boolean =>
      decisionsReadMode() === 'moduleQuery' || dailyLogReadMode() === 'moduleQuery' || drawingsReadMode() === 'moduleQuery' || inspectionsReadMode() === 'moduleQuery' || activitiesReadMode() === 'moduleQuery';

    /** Consume an `acceptSnapshot` result on a COMMAND path (a user-initiated
     *  mutation: approve, publish, issue, evidence upload…). The command's success
     *  is independent of the snapshot ORDERING race: the mutation committed on the
     *  server the moment its call resolved. So announce success whenever the reply
     *  landed in the CAPTURED scope — `applied` (this snapshot is freshest) OR
     *  `superseded` (a newer same-scope refresh, almost always the mutation's OWN
     *  `changed` broadcast, already carries the committed truth).
     *
     *  A committed command must then be reflected in the reads the user actually sees:
     *   • `superseded` NEVER ran applySnapshotCore — the store is stale in EVERY mode —
     *     so a reconcile is always required (round 13): the newer refresh may fail, and
     *     the committed change must land or a Retry be exposed — never silently absent.
     *   • `applied` ran applySnapshotCore, which refreshes the snapshot-owned reads. But
     *     under MODULE ownership (Task 9/10 correction, finding 2) the command's own
     *     snapshot carries no module slice, so applySnapshotCore left `decisions` /
     *     `dailyLog` untouched — the module read is now stale. Schedule the same
     *     scope-guarded reconcile so `requestFreshSnapshot` refetches the module-owned
     *     read under the SAME captured scope; finding-1's servability gate falls a
     *     lagging/blocked projection back to canonical, so the committed change is never
     *     hidden. In pure 'snapshot' mode an `applied` command already carried its slice,
     *     so no extra reconcile is scheduled.
     *
     *  The reconcile is pinned to the command's CAPTURED scope, and `scheduleReconcile`
     *  drops it if that scope has since MOVED — a stale continuation never mutates data,
     *  load state or toast in the new scope. Suppress the toast only when the scope moved
     *  (a switch / re-auth) or the payload was `invalid-project` (never claim success;
     *  recover under the captured scope). */
    const consumeSnapshotResult = (result: SnapshotApplyResult, okMsg?: string, scope: ProjectScope = currentScope()): void => {
      if (result === 'applied' || result === 'superseded') {
        if (okMsg) get().flash(okMsg);
        if (result === 'superseded' || anyModuleOwnedRead()) {
          scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq, modulesOnly: result === 'applied' });
        }
      } else if (result === 'invalid-project') {
        void requestFreshSnapshot(scope);
      }
    };

    // round-5 Codex F4 — resolves true when the server ACCEPTED the command (a snapshot came
    // back), false on failure: a caller that must hold a dependent action (the Drafts screen
    // holds Publish while a conversion PATCH is in flight) can await the settle. Every existing
    // fire-and-forget call site ignores the returned promise unchanged.
    // Phase 6 task 4d-ii-b / B4 — a command's success copy may FOLLOW the accepted snapshot instead of
    // being fixed up front: `okMsg` is a string, or a function of the snapshot the server returned
    // (evaluated once, before the reconcile announces it), so an approval can say what actually
    // happened — locked, or parked awaiting the architect's countersign — from the row as served.
    type OkMsg = string | ((snap: ApiSnapshot) => string);
    /** #698 Codex findings (audit B1 on the brief-backed home) — the PMC's brief counts each project's
     *  inspections awaiting review as of when it was ASKED, so a decision the server has just committed
     *  leaves it naming that inspection while it is still fresh. The rule: once a review decision
     *  commits, NO brief read asked before the commit may land. So the brief stops counting as fresh
     *  (For You falls back to the live list, whose `pmc-reviews` already drops the decided review) and
     *  is asked again; the new read supersedes every earlier one (`briefRequestSeq`). That holds
     *  whether or not a brief has landed yet: a FIRST read still in flight is superseded too (finding
     *  4173586628). Only a session that has never asked for a brief has nothing to supersede.
     *  The brief is the PERSON's (kept across their project switches, dropped on any identity change),
     *  so the refresh is the decider's alone: `decidedBy` is who was signed in when the decision was
     *  sent, and a reply landing after someone else signed in leaves that person's brief untouched
     *  (finding 4173756348). A project switch by the same person still refreshes it: their decision
     *  changed the count their cross-project brief carries. */
    const refreshBriefAfterReview = (decidedBy: string | null): void => {
      if (briefRequestSeq === 0 || decidedBy === null || get().sessionUserId !== decidedBy) return;
      set((s) => { s.briefAt = null; });
      get().loadBrief();
    };

    /** `refused` (#699 shadow review): a command the server can REFUSE for a reason the viewer must see
     *  (a location still holding decisions they cannot see, an inspected activity) says that reason,
     *  instead of the network copy that would send them retrying a request that will never succeed. */
    // `unreachable`: the network-failure line in the viewer's language, passed only by callers whose screen
    // is translated (#827); every other caller keeps the English line, so an English screen stays English
    const runRemote = (call: () => Promise<ApiSnapshot>, okMsg: OkMsg, refused?: (why: string) => string, unreachable?: () => string): Promise<boolean> => {
      const lease = beginSnapshotLease(currentScope()); // capture BEFORE the request
      return call()
        .then((snap) => { consumeSnapshotResult(acceptSnapshot(snap, lease), typeof okMsg === 'function' ? okMsg(snap) : okMsg, lease.scope); return true; })
        .catch((err: unknown) => {
          if (!scopeStillCurrent(lease.scope)) return false;
          // a terminal refusal is never reported as a network failure, even when its body carried no
          // readable reason (a proxy's error page): retrying it would fail the same way (#699 shadow review)
          if (refused && isTerminalOutboxError(err)) get().flash(refused(refusalMessage(err) ?? 'the server refused it'));
          else get().flash(unreachable ? unreachable() : 'Could not reach the server — please try again.');
          return false;
        });
    };

    // WEB-02: queued offline writes are scoped to WHO queued them and WHERE — the
    // storage key carries the signed-in user (JWT sub) + the active project, so work
    // queued in one project (or by one user on a shared device) is never replayed
    // into another. `hydrateOutbox` swaps the in-memory queue whenever that scope
    // changes (useApiSync re-runs it on every token / project change).
    const LEGACY_OUTBOX_KEY = 'vitan.outbox';
    /** #1085 r2: per queue key, the user scopes its acts may name, recorded as each key's name is derived (Codex
     *  4346169609: an evidence act naming another user's scope read that user's row). A key named once keeps its
     *  scopes for the tab's life, so the flush's write of a scope it moved off still reads that key as its own */
    const queueKeyScopes = new Map<string, QueueScopes>();
    const outboxKey = (): string => {
      // passwordless dev auth keeps no token: its session user scopes the queue, so two identities never share
      // queued acts (Codex 4278754328; the create hold's rule, createHoldScope)
      const user = get().sessionUserId;
      let sub = user ? `dev:${user}` : 'anon';
      // evidence rows are scoped by the token alone (`evidenceScope`), photo rows as the key is (`visitPhotoScope`)
      let evidence = 'anon';
      const token = get().sessionToken;
      if (token) {
        try {
          sub = (JSON.parse(atob(token.split('.')[1])) as { sub?: string }).sub ?? 'anon';
          evidence = sub;
        } catch {
          /* malformed token — treat as the anonymous scope */
        }
      }
      const key = `vitan.outbox.${sub}.${get().activeProjectId}`;
      const scopes = { evidence, visitPhoto: sub };
      queueKeyScopes.set(key, scopes);
      queueKeyScopes.set(key.replace(/^vitan\.outbox\./, 'vitan.siteVisitQueue.'), scopes);
      return key;
    };
    /** Site Visits (#792): site visit acts are kept under a key of their own, beside the outbox's, so a bundle from
     *  before them (a rollback, an old tab) never reads one: its replay has no case for them and would drop them as
     *  sent (Codex 4278991737). The two lists are each in the order made; a site visit act never waits on another op. */
    /** #482 site photos — the order this device picked the photos it uploads, by the photo's server id once its
     *  reply lands: replies can come back in another order, and the list stays newest first by pick. */
    let photoPickSeq = 0;
    const photoPickedAt = new Map<string, number>();
    /** #482 site photos — the deletes on their way, by photo id */
    const sitePhotoDeletes = new Map<string, Promise<void>>();
    // #482 site photos — the photos this tab has seen deleted: a late upload answer never lists one again (Codex 4322715807)
    const deletedPhotoIds = new Set<string>();
    /** #482 site photos — a photo the server says is gone (a delete's yes or 404, a send's 410) leaves every local copy in
     *  the same update: the photo list (Dashboard, Site Map), the viewer's own list past the window, the log's gallery, and
     *  every evidence or sample path naming it; and no late upload answer lists it again */
    const dropDeletedPhoto = (s: AppState, photoId: string): void => {
      deletedPhotoIds.add(photoId);
      // taken out of a full window: an older photo may lie just past it, so the count stays a floor until a
      // snapshot rebuilds the window, and one that fails leaves it a floor (Codex 4337661439)
      if (s.photos.length >= SNAPSHOT_SITE_PHOTO_LIMIT && s.photos.some((p) => p.id === photoId)) s.photosWindowShort = true;
      s.photos = s.photos.filter((p) => p.id !== photoId);
      if (s.dailyLog) s.dailyLog.photos = s.dailyLog.photos.filter((p) => p.id !== photoId);
      forgetMedia(s, photoId);
    };
    // #917: the keys of this tab's online site photo sends not yet answered. A flush does not give their rows an op:
    // the send itself queues one if its answer is lost
    const sitePhotoSendsDirect = new Set<string>();
    /** What the Dashboard and the day's count need of a kept site photo: never its whole upload. */
    const keptFrom = (input: UploadMediaInput & { clientKey: string }): KeptSitePhoto => ({
      clientKey: input.clientKey, mime: input.mime, data: input.data,
      ...(input.takenAt ? { takenAt: input.takenAt } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.dailyLogId ? { dailyLogId: input.dailyLogId } : {}),
    });
    /** #917: a site photo the server refused for good, or whose row is gone, leaves what this device showed while it was
     *  queued: its data URL in the log's gallery, the count it added there, and its kept copy (Codex 4389428627,
     *  4389716748). The count was the queue's (#1167): leaving the queue takes it back, after a reload too (Codex
     *  4392115360), and the draft, which holds only confirmed sends, is not touched */
    const forgetQueuedSitePhoto = (s: AppState, clientKey: string): void => {
      const log = s.dailyLog;
      if (log) log.photos = log.photos.filter((p) => p.id || p.clientKey !== clientKey);
      s.sitePhotosKept = s.sitePhotosKept.filter((k) => k.clientKey !== clientKey);
      // and a count kept for it once it was sent (a 410 settles it after `afterSent`, #1195)
      s.photoUploadsInFlight = s.photoUploadsInFlight.filter((u) => u.clientKey !== clientKey);
      recountDailyLogPhotos(s);
    };
    /** #917: the rows are the site photo queue's only record (its ops are never stored). Give every row of the queue on
     *  show its op, except one a tab is sending now (this tab's direct send, or any tab holding its lock: that send
     *  queues its own op if its answer is lost) and a "sent" marker, and show as queued every row this tab holds an op
     *  for, one another tab is sending included. Run on every load and at every flush. Bounded: a phone that does not
     *  answer rebuilds nothing, and the next flush reads again. A read for a queue no longer on show changes nothing.
     *  Markers past their keep are dropped here, for every person and project. */
    // #917: a kept row that could not be read, one whose sending tab closed before its answer, or an op held for its row
    // is tried again after a bounded wait (5 s, doubling to a minute), never left for a later write that may not come
    // while the app stays online (Codex 4389428598). Its own timer: no other screen reads again for it
    let sitePhotoRetry: { timer: ClampedTimer; mine: () => boolean } | null = null;
    let sitePhotoRetryMs = 5000;
    /** #917: a direct send's row change the phone could not write (its "sent" marker, or its removal after a refusal), by
     *  key. Made again on every retry, in any project, online or not; the send stays this tab's and its lock held until
     *  it lands (Codex 4389428586, Stage 1 r3) */
    const sitePhotoRowChanges = new Map<string, () => Promise<void>>();
    /** #917 (#1170): bumped each time a row settles here (a direct send let go, a flush done), so a read of the rows made
     *  before it is never applied: it may still list a row now marked sent or refused, with its lock already let go */
    let sitePhotoSettles = 0;
    const retrySitePhotos = (): void => {
      if (sitePhotoRetry?.mine()) return;
      sitePhotoRetry?.timer.clear();
      const g = gateway;
      const scope = currentScope();
      const key = outboxKey();
      const mine = () => gateway === g && scopeStillCurrent(scope) && outboxKey() === key;
      const wait = sitePhotoRetryMs;
      sitePhotoRetryMs = Math.min(sitePhotoRetryMs * 2, 60_000);
      const timer = setClampedTimeout(() => {
        sitePhotoRetry = null;
        if (sitePhotoRowChanges.size > 0) {
          void Promise.all([...sitePhotoRowChanges.values()].map((change) => change())).then(() => { if (sitePhotoRowChanges.size > 0) retrySitePhotos(); });
        }
        if (!mine() || !get().online) return;
        if (get().outbox.some((o) => o.t === 'uploadSitePhoto')) void get().flushOutbox();
        else reconcileSitePhotos();
      }, wait);
      sitePhotoRetry = { timer, mine };
    };
    const reconcileSitePhotos = (): void => {
      if (!gateway || !sitePhotoStorageAvailable()) return;
      const readScope = currentScope();
      const readKey = outboxKey();
      const rowScope = visitPhotoScope(get().sessionToken, get().sessionUserId);
      const project = gateway.project;
      const settles = sitePhotoSettles;
      void dropSentMarkers(Date.now() - SITE_PHOTO_SENT_KEEP_MS).catch(() => {});
      void Promise.all([listSitePhotoRows(rowScope, project), sitePhotosLocked(rowScope, project)]).then(([rows, locked]) => {
        if (!scopeStillCurrent(readScope) || outboxKey() !== readKey) return;
        // a row settled while this read was out: read again, so a sent photo is never queued again (Codex 4393007605)
        if (settles !== sitePhotoSettles) { reconcileSitePhotos(); return; }
        const full = rows.filter((r): r is SitePhotoRow => !isSitePhotoSent(r));
        // a row a tab is sending now gets no op here; one this tab already queues stays on show while another tab sends it
        const missing = full.filter((r) => !sitePhotoSendsDirect.has(r.clientKey) && !locked.has(r.clientKey) && !uploadQueued(get().outbox, r.clientKey));
        // #1238: the rows and the locks are two reads, so a lock another tab took for a row written after the rows were
        // read is seen with no row behind it. That tab may close before its answer and leave the row unsent: read again
        const lockedUnseen = [...locked].some((k) => !sitePhotoSendsDirect.has(k) && !rows.some((r) => r.clientKey === k));
        if (missing.length === 0 && full.length === 0 && get().sitePhotosKept.length === 0 && !lockedUnseen) {
          // nothing kept and nothing to send: the next wait starts again at 5 s (Codex 4392115375)
          if (sitePhotoRowChanges.size === 0 && !get().outbox.some((o) => o.t === 'uploadSitePhoto')) sitePhotoRetryMs = 5000;
          return;
        }
        set((s) => {
          for (const r of missing) s.outbox.push({ t: 'uploadSitePhoto', scope: rowScope, clientKey: r.clientKey });
          // #1187: a row whose sending tab closed before its answer is counted on its log from here on, by its key, as
          // every queued photo is (a server that sends no count included), and once only, after a reload too
          // a row sent (by this tab's flush or another tab) whose op here has not settled yet keeps its entry: its op's
          // `afterSent` reads its log from it, to move it from the queue into the draft (Stage 1 gap-check, PR1 and PR5)
          const sentHere = s.sitePhotosKept.filter((k) => s.outbox.some((o) => o.t === 'uploadSitePhoto' && o.clientKey === k.clientKey) && rows.some((r) => r.clientKey === k.clientKey && isSitePhotoSent(r) && !r.refused));
          s.sitePhotosKept = [...full.filter((r) => s.outbox.some((o) => o.t === 'uploadSitePhoto' && o.clientKey === r.clientKey)).map((r) => keptFrom(r.input)), ...sentHere];
          recountDailyLogPhotos(s);
        });
        // (its op is never stored: the row is already its record on this phone)
        if (missing.length > 0 && get().online) void get().flushOutbox();
        // a row another tab is sending, and no op here: if that tab closes before it is answered, nothing else would
        // give the row its op while this tab stays online with nothing queued. Read again (Codex 4389428598)
        else if (lockedUnseen || full.some((r) => locked.has(r.clientKey) && !sitePhotoSendsDirect.has(r.clientKey) && !uploadQueued(get().outbox, r.clientKey))) retrySitePhotos();
        // the wait starts again only once no row is held by another tab: a row held for that tab's life keeps backing off
        else if (sitePhotoRowChanges.size === 0 && !get().outbox.some((o) => o.t === 'uploadSitePhoto') && !full.some((r) => locked.has(r.clientKey) && !sitePhotoSendsDirect.has(r.clientKey))) sitePhotoRetryMs = 5000;
      }, () => {
        // not read: a photo may be kept whether or not any act is queued, so this is tried again (Codex 4389428598)
        if (scopeStillCurrent(readScope) && outboxKey() === readKey) retrySitePhotos();
      });
    };
    const siteVisitKeyOf = (key: string): string => key.replace(/^vitan\.outbox\./, 'vitan.siteVisitQueue.');
    /** SV2 (#792): a visit photo's act is never stored here. Its one record is its `visitPhotoStore` row (act, bytes,
     *  and the start it waits on), and the act is rebuilt from that row on every load (`reconcileVisitPhotos`). So a
     *  release before it, which replays every `siteVisit…` act it finds and has no case for a photo, never meets one,
     *  and this lane is stored exactly as before (Codex 4320122193, 4320404449, 4320404441). */
    const isStoredVisitOp = (o: OutboxOp): boolean => isSiteVisitOp(o) && o.t !== 'siteVisitAddFile';
    /** #917: a site photo's op is never stored either: its row is its record, and the op is rebuilt from it on every load
     *  and flush (`reconcileSitePhotos`). So no release, one before #917 or one that knows no such kind, ever reads one. */
    const isStoredGenericOp = (o: OutboxOp): boolean => !isSiteVisitOp(o) && o.t !== 'uploadSitePhoto';
    /** the release drains asked so far, settled once each has asked its flush or found the app offline (tests wait on it,
     *  `_queueReleased`, #1134 r1 4376641821) */
    let releaseDrains: Promise<void> = Promise.resolve();
    /** WEB-02 step A: both queue keys are read and written only through `queueKeys`, which never writes a key this
     *  release cannot read; each read of this scope's keys lists such a key in the strip */
    const strip = queueStrip({ get, set, scope: () => [outboxKey(), siteVisitKeyOf(outboxKey())], keys: () => queueKeys, writes: () => queueWrites() });
    // a queue-key hold let go (the key heard readable or cleared, or written) resumes sending, as a kept photo put back
    // does: once, after the write or event that let it go, and a flush running then runs again (#1132 r2, 4374538874)
    const queueKeys = createQueueKeyGuard(strip.noteRead, (key) => queueKeyScopes.get(key), () => {
      const drain = Promise.resolve().then(() => { if (get().online) void get().flushOutbox(); });
      releaseDrains = Promise.all([releaseDrains, drain]).then(() => undefined);
    });
    /** Every scope change (an auth result, a persona switch, a sign-out, and each load of a scope's queue) ends the old
     *  scope's queue-key memory and its strip list here, first, before any storage access: a storage that throws can
     *  then never leave the old scope's list on the next one (Codex 4351952392, the third such leak's root cause) */
    const resetQueueScope = (): void => {
      queueKeys.forget();
      aheadUnsaved.clear(); // what this tab held back for the scope it left goes with that scope's memory
      set({ queueUnreadable: [], queueSetAsideFailed: false });
    };
    /** each stored key's write from memory: the general queue, then the visit lane */
    const queueWrites = (): QueueWrite[] => [
      { key: outboxKey(), mine: get().outbox.filter(isStoredGenericOp), takes: isStoredGenericOp },
      { key: siteVisitKeyOf(outboxKey()), mine: get().outbox.filter(isStoredVisitOp), takes: isStoredVisitOp },
    ];
    /** the new acts no write has yet stored in their key. A flush sends none while its write is still running (#1099 r1,
     *  Codex 4358186328); once that write has run and not stored it, the flush writes it again and then sends it from
     *  memory, said not saved: its ask's made record is its retry record on this phone, and an act this tab could not
     *  store is never held from the server (#1113 r1 re-check) */
    // L2b: an unkeyed act by the act itself, never its identity: two identical unkeyed acts are two, and one's write
    // says nothing of the other's (the store keeps a queued act as the same object until the flush removes it). A keyed
    // act by its identity: a photo row read back from IndexedDB and a visit act the flush re-creates are new objects
    // for the same act (re-check N5)
    const aheadUnsaved = new Set<OutboxOp | string>();
    const aheadId = (o: OutboxOp): OutboxOp | string => { const i = queueActIdent(o); return i.startsWith('json:') ? o : i; };
    /** acts now on this phone: their key's write holds them, or a kept photo's row (IndexedDB) does */
    const storedHere = (acts: OutboxOp[]): void => { for (const o of acts) aheadUnsaved.delete(aheadId(o)); };
    /** step B2f-1: each key is written under its own cross-tab lock (`writeQueueKey`, main's write inside it). Memory is
     *  read as it is now, so the writes run in the order the acts were made; true only when both keys' writes landed */
    const persistOutbox = async (): Promise<boolean> => {
      try {
        const storage = globalThis.localStorage;
        if (!storage) return false;
        return (await Promise.all(queueWrites().map(async (w) => {
          const kept = await writeQueueKey(queueKeys, storage, w.key, w.mine, w.takes);
          if (kept) storedHere(w.mine);
          return kept;
        }))).every(Boolean);
      } catch {
        return false; // storage unavailable — the in-session outbox still works, and nothing says it is saved
      }
    };
    /** step B2f-1: every write of a new act (write-ahead or offline) is tracked here until it has run; a flush sends the
     *  acts queued before it only once their writes have run, and leaves the acts queued during that wait to its drain
     *  pass (#1113 r1 Codex 4367242045, r2 Codex 4367436925) */
    const aheadWrites = new Set<Promise<boolean>>();
    const writeAhead = (acts: OutboxOp[]): Promise<boolean> => {
      for (const o of acts) aheadUnsaved.add(aheadId(o));
      const written = persistOutbox();
      aheadWrites.add(written);
      void written.finally(() => aheadWrites.delete(written));
      return written;
    };
    /** whether `acts` are on this phone: their own key's write held them, or a kept photo's row does, whatever the other
     *  key's write did (#1113 r1, Codex 4367242052) */
    const storedNow = (acts: OutboxOp[]): boolean => acts.every((o) => !aheadUnsaved.has(aheadId(o)));
    /** an offline act is said saved only once the locked write of its own key holds it (Codex 4344812898, 4344270659,
     *  4367242052); its write is tracked as a write-ahead's is, so no flush sends it first (Codex 4367242045). The line
     *  is shown only while the scope, person and key it was made in still hold (#1099 r3, Codex 4360928308) */
    const flashSaved = (msg: string, acts: OutboxOp[], onWritten?: (stored: boolean) => void): void => {
      const stillThere = madeHere();
      void writeAhead(acts).then(() => {
        const stored = storedNow(acts);
        onWritten?.(stored);
        if (stillThere()) get().flash(stored ? msg : QW.notSavedYet[get().lang]);
      });
    };
    /** the scope, person and key an act is made in: a write that returns after any of them moved says nothing and starts
     *  nothing there (#1099 r2, Codex 4358855946) */
    const madeHere = (): (() => boolean) => {
      const made = { scope: currentScope(), token: get().sessionToken, key: outboxKey() };
      return () => scopeStillCurrent(made.scope) && get().sessionToken === made.token && outboxKey() === made.key;
    };
    /** another tab's write of this scope's queue key is read and listed, never written back (`null`: storage cleared);
     *  memory's acts for it go with it, for the guard to copy aside or hold (U3) */
    globalThis.addEventListener?.('storage', (e: StorageEvent) => {
      const storage = globalThis.localStorage;
      if (storage && e.storageArea === storage && get().sessionUserId) for (const w of queueWrites()) if (e.key === null || e.key === w.key) queueKeys.heard(storage, w.key, w.mine);
    });

    // Evidence bytes share the outbox's user scope (WEB-02): the IndexedDB entries are
    // keyed (sub, projectId, clientKey), so a user/project switch neither loses nor leaks.
    const evidenceScope = (): string => {
      let sub = 'anon';
      const token = get().sessionToken;
      if (token) {
        try {
          sub = (JSON.parse(atob(token.split('.')[1])) as { sub?: string }).sub ?? 'anon';
        } catch { /* anonymous scope */ }
      }
      return sub;
    };
    /** Reconcile the store with the durable evidence rows: refresh the UI mirrors
     *  (pending count, the FAILED Retry/Delete surface) AND — gate finding 2 —
     *  treat IndexedDB as the CANONICAL evidence queue: every PENDING row must
     *  have a replay op. An op lost to a failed localStorage persistence (quota,
     *  private mode, wiped storage) is reconstructed here, idempotently per
     *  clientKey — the server dedupes on (projectId, clientKey), so even a
     *  duplicate replay is harmless.
     *
     *  Gate round-2 finding 2: a reconciliation is a READ followed by a write —
     *  the read can go stale while it is in flight (a project switch, a flush
     *  that confirmed uploads, a dead-letter). EVERYTHING the write depends on
     *  is captured BEFORE the await and re-validated after it, and an epoch
     *  makes reconciliations single-winner: any flush / retry / delete / newer
     *  reconciliation invalidates the ones already in flight, so only the
     *  NEWEST truth may mutate the store. */
    let evidenceEpoch = 0;
    const invalidateEvidenceReconciles = (): number => ++evidenceEpoch;
    // gate round 10: a monotonic id stamped on every ONLINE submit dispatch, so a
    // continuation can tell whether it still owns the submission (see submitInspection).
    let submitAttemptSeq = 0;
    const reconcileEvidence = async (): Promise<void> => {
      const epoch = invalidateEvidenceReconciles(); // this reconciliation supersedes older ones
      const scope = evidenceScope();
      const projectId = get().activeProjectId;
      const projScope = currentScope();
      const storageKey = outboxKey();
      try {
        const entries = await listEvidence(scope, projectId);
        // REJECT a stale result: every captured coordinate must still be live
        if (epoch !== evidenceEpoch) return; // a newer reconciliation / flush / retry / delete owns the truth now
        if (!scopeStillCurrent(projScope)) return; // the project switched mid-read
        if (evidenceScope() !== scope || get().activeProjectId !== projectId || outboxKey() !== storageKey) return;

        // the stored entry has always known its checklist and item — carry them, do not discard them
        const failed = entries.filter((e) => e.status === 'failed').map((e) => ({ clientKey: e.clientKey, reason: e.failReason ?? 'upload rejected', mime: e.mime, inspectionId: e.inspectionId, inspectionItemId: e.inspectionItemId }));
        const pending = entries.filter((e) => e.status === 'pending'); // only pending rows earn a replay op
        let reconstructed = false;
        set((s) => {
          s.failedEvidence = failed;
          s.pendingEvidenceCount = pending.length;
          s.pendingEvidenceKeys = pending.map((e) => e.clientKey);
          const queued = new Set(s.outbox.filter((o) => o.t === 'uploadEvidence').map((o) => o.clientKey));
          for (const e of pending) {
            if (queued.has(e.clientKey)) continue;
            s.outbox.push({ t: 'uploadEvidence', scope, clientKey: e.clientKey });
            reconstructed = true;
          }
        });
        if (reconstructed) void persistOutbox(); // the bytes' rows are the durable record: the acts are rebuilt from them
      } catch {
        /* evidence store unavailable — the mirrors stay empty */
        // with no IndexedDB at all nothing can be pending on this device; a read that failed otherwise leaves the keys
        // unknown, and an own evidence photo's Delete keeps waiting (#482 site photos)
        if (!evidenceAvailable() && epoch === evidenceEpoch && scopeStillCurrent(projScope) && evidenceScope() === scope && get().activeProjectId === projectId) {
          set((s) => { s.pendingEvidenceKeys = []; });
        }
      }
    };
    /** Site Visits SV2 (#792): `visitPhotoStore` is the one record of a visit photo, and the outbox holds its act only
     *  in memory. Each queued row's act is put back, exactly as it was queued (same key: the server adds the file once),
     *  with the visit's start ahead of it when the row kept one the outbox no longer holds (Codex 4320122186). A
     *  rebuilt photo goes after its visit's start and before that visit's later acts: it was taken while the visit was
     *  not closed. Putting back is idempotent, so it is done on every load and at the start of every flush: a row
     *  whose act the queue lost for any reason (a reload, a photo kept just after its refused start was settled, Codex
     *  4321084743) has it again by the next send. Returns whether anything was put back. */
    const putBackVisitPhotos = (rows: VisitPhotoRow[]): boolean => {
      let rebuilt = false;
      // when each queued photo was taken: its row's creation time, else when its act was queued
      const created = new Map(rows.map((r) => [r.op.idempotencyKey, r.createdAt]));
      const takenAt = (o: SiteVisitAddFileOp): number => created.get(o.idempotencyKey) ?? (o.queuedAt ? Date.parse(o.queuedAt) : NaN);
      // V2b-2: a sent clip whose still frame is still to send has its act put back too, last, to send the frame alone
      // (its row is filed: the clip is never uploaded again). It starts no flush of its own, nor, once the server lists
      // its clip, the Site Visits screen's retry: the next flush made for any other reason sends it, so a server that
      // keeps failing the frame is not asked again on a beat of its own
      const posters: OutboxOp[] = [];
      // one whose frame waited past its bound is not put back, and its frame is let go here, so the bound holds when
      // the Site Visits screen (whose reads settle rows) is never opened again (Codex 4400008717)
      for (const row of rows) {
        if (posterLapsed(row)) void withinWait(() => clearVisitPoster(row.userScope, row.projectId, row.clientKey)).catch(() => {});
      }
      set((s) => {
        const queued = new Set(s.outbox.filter(isSiteVisitOp).map((o) => o.idempotencyKey));
        for (const row of rows) {
          if (posterWaits(row)) {
            if (!queued.has(row.op.idempotencyKey)) {
              s.outbox.push(row.op);
              queued.add(row.op.idempotencyKey);
              posters.push(row.op);
            }
            continue;
          }
          if (row.state !== 'queued') continue;
          // the start it needs, when the queue lost it, goes back ahead of it even when the photo's own act is still
          // queued (one kept just after its start was settled, then queued alone: Codex 4321998492). A start the
          // server already has answers its replay with the same visit
          const start = row.start && !queued.has(row.start.idempotencyKey) ? row.start : null;
          const present = queued.has(row.op.idempotencyKey);
          if (!start && present) continue;
          const visitId = row.op.visitId;
          let at: number;
          if (present) {
            at = s.outbox.findIndex((o) => isSiteVisitOp(o) && o.idempotencyKey === row.op.idempotencyKey);
          } else {
            // after its visit's start, and after the act adding the place it was taken at when that is queued (a photo
            // can only be taken at a place already on the visit); then before the visit's next later act (an end, a
            // close, a place or person), else last (coordinator, sv2-unit-h)
            const own = s.outbox.findIndex((o) => o.t === 'siteVisitStart' && o.body.id === visitId);
            const node = row.op.file.nodeId;
            let place = -1;
            if (node) s.outbox.forEach((o, k) => { if (o.t === 'siteVisitAddPlace' && o.visitId === visitId && o.body.nodeId === node) place = k; });
            const lo = Math.max(own + 1, place + 1);
            const later = s.outbox.findIndex((o, k) => k >= lo && isSiteVisitOp(o) && o.t !== 'siteVisitAddFile' && o.t !== 'siteVisitStart' && o.visitId === visitId);
            const hi = later >= 0 ? later : s.outbox.length;
            // and in the order the photos were taken: ahead of any queued photo taken after it (one queued in another
            // tab, or rebuilt before it) (r4323657318)
            const newer = s.outbox.findIndex((o, k) => k >= lo && k < hi && o.t === 'siteVisitAddFile' && takenAt(o) > row.createdAt);
            at = newer >= 0 ? newer : hi;
          }
          const put: OutboxOp[] = [];
          if (start) {
            put.push(start);
            queued.add(start.idempotencyKey);
          }
          if (!present) {
            put.push(row.op);
            queued.add(row.op.idempotencyKey);
          }
          s.outbox.splice(at, 0, ...put);
          rebuilt = true;
        }
      });
      // a kept photo's row holds its act and the start it needs: their retry record is on this phone
      for (const row of rows) if (row.state === 'queued') storedHere([row.op, ...(row.start ? [row.start] : [])]);
      storedHere(posters);
      if (rebuilt) void persistOutbox();
      return rebuilt;
    };
    /** The read made on load, so the queue shows a kept photo before anything is sent. One a flush overtook is read
     *  again when that flush settles; what it rebuilds is sent at once when online: no screen may be open to send it
     *  (Codex 4320122176). A read that fails changes nothing: every flush reads again before it sends. */
    let visitPhotoEpoch = 0;
    // bumped by every flush, at its start and end: a read a flush overtook (not a newer read) must be made again
    let visitPhotoFlushes = 0;
    let visitPhotoRecheck = false;
    const reconcileVisitPhotos = async (): Promise<void> => {
      const epoch = ++visitPhotoEpoch;
      const flushes = visitPhotoFlushes;
      const scope = visitPhotoScope(get().sessionToken, get().sessionUserId);
      const projectId = get().activeProjectId;
      const projScope = currentScope();
      const storageKey = outboxKey();
      try {
        // bounded: a read that never answers is one that failed (below)
        const rows = await withinWait(() => listVisitPhotos(scope, projectId));
        if (!scopeStillCurrent(projScope) || outboxKey() !== storageKey) return;
        if (epoch !== visitPhotoEpoch) {
          if (visitPhotoFlushes !== flushes) {
            if (outboxFlushing) visitPhotoRecheck = true;
            else void reconcileVisitPhotos();
          }
          return;
        }
        if (putBackVisitPhotos(rows) && get().online) void get().flushOutbox();
      } catch {
        // not read: a photo may be waiting with no act queued, so the flush that reads again is not left to chance. A
        // phone keeping none for this project has none to wait for (Codex 4322430052)
        if (keepsVisitPhotos(scope, projectId)) retryVisitPhotos();
      }
    };
    /** How long a flush waits for its own read of the kept photos before it sends the rest of the queue without the
     *  site visit acts. A visit photo still waiting arms one retry: when the phone's record of them could not be read
     *  (on load or in a flush), when its send met no answer, a busy or failing server (after the server's own wait,
     *  when it gives one), or when one sent has not yet shown in the server's list (`retrySiteVisits`). The delay
     *  doubles from 5 seconds to a minute and stays there: there is no limit on tries, since every one of these waits
     *  on something that will change. It starts again at 5 seconds once a visit act goes through. Offline it does
     *  nothing (the browser's `online` sends everything), and it belongs to the queue it was armed for: after a
     *  project switch, sign-in or sign-out it sends nothing, and the queue then on show arms its own. */
    const VISIT_PHOTO_WAIT_MS = 5000;
    // a visit the person chose to send without waiting for a photo the phone could not read (`siteVisitsSentAnyway`)
    const releaseKey = (scope: string, projectId: string, visitId: string): string => JSON.stringify([scope, projectId, visitId]);
    const keepsVisitPhotos = (scope: string, projectId: string): boolean => {
      const held = visitsHeldByPhotos(scope, projectId);
      return held === 'all' || held.size > 0;
    };
    const VISIT_PHOTO_RETRY_MAX_MS = 60_000;
    // the longest a server's own wait is honoured: a bad answer never parks a photo for longer
    const VISIT_PHOTO_RETRY_AFTER_MAX_MS = 10 * 60_000;
    let visitPhotoRetryMs = VISIT_PHOTO_WAIT_MS;
    let visitPhotoRetry: { timer: ClampedTimer; mine: () => boolean; at: number } | null = null;
    // the queue the wait was last grown for: another queue starts from 5 seconds
    let visitPhotoRetryFor: (() => boolean) | null = null;
    const retryVisitPhotos = (atLeastMs = 0): void => {
      // one armed for this queue stands, unless a server's own wait ends after it: then it moves to that later time,
      // never sooner (Codex 4322430055)
      if (visitPhotoRetry?.mine() && Date.now() + atLeastMs <= visitPhotoRetry.at) return;
      if (visitPhotoRetry) visitPhotoRetry.timer.clear();
      if (!visitPhotoRetryFor?.()) visitPhotoRetryMs = VISIT_PHOTO_WAIT_MS;
      const g = gateway;
      const scope = currentScope();
      const key = outboxKey();
      const token = get().sessionToken;
      const mine = () => gateway === g && scopeStillCurrent(scope) && outboxKey() === key && get().sessionToken === token;
      visitPhotoRetryFor = mine;
      const wait = Math.max(visitPhotoRetryMs, atLeastMs);
      visitPhotoRetryMs = Math.min(visitPhotoRetryMs * 2, VISIT_PHOTO_RETRY_MAX_MS);
      const timer = setClampedTimeout(() => {
        visitPhotoRetry = null;
        if (!mine()) return;
        if (!get().online) return;
        // the Site Visits screen reads again (a sent photo it still waits to see), and the queue is sent
        if (g) tellSiteVisits({ kind: 'retry', project: g.project, generation: scope.generation });
        void get().flushOutbox();
      }, wait);
      visitPhotoRetry = { timer, mine, at: Date.now() + wait };
    };
    /** A scope change: the retry armed for the old scope goes (its `mine()` already sends nothing), and the wait
     *  starts again at 5 seconds. */
    const dropVisitPhotoRetry = (): void => {
      visitPhotoRetry?.timer.clear();
      visitPhotoRetry = null;
      visitPhotoRetryFor = null;
      visitPhotoRetryMs = VISIT_PHOTO_WAIT_MS;
    };
    /** Gate round-3: an evidence COMMAND (offline capture / Retry / Delete)
     *  crosses an IndexedDB await too. Its durable operation must run under the
     *  coordinates captured BEFORE the await, and every post-await store /
     *  toast / persistence mutation must be refused unless that context is
     *  still current — otherwise a project or session switch landing mid-await
     *  writes the OLD scope's operation into the NEW scope's outbox, pending
     *  count and storage key. When the context has moved, the durable row is
     *  left alone: its own scope's reconciliation reconstructs it. */
    const captureEvidenceContext = () => ({
      scope: evidenceScope(),
      projectId: get().activeProjectId,
      projScope: currentScope(),
      storageKey: outboxKey(),
    });
    const evidenceContextStillCurrent = (ctx: ReturnType<typeof captureEvidenceContext>): boolean =>
      scopeStillCurrent(ctx.projScope)
      && evidenceScope() === ctx.scope
      && get().activeProjectId === ctx.projectId
      && outboxKey() === ctx.storageKey;

    /** #482 — a review decision's outcome for the review guide, under the run it is made in (taken before anything else,
     *  so a later run never hears it) */
    const reviewDecideReport = (reviewId: string | null) => {
      const guideRun = guideRunToken();
      // keyed by the review decided (#1220): the guide follows the review its own press decided, not another
      return (result: ActReport) =>
        emitGuideOutcome(result === 'sent' || result === 'queued' ? 'review-decided' : result === 'failed' ? 'review-decide-failed' : 'review-decide-not-kept', reviewId, guideRun);
    };
    /** the online send of a review decision, marked as on its way, in the scope it was sent in, until any answer (or a
     *  network error) ends it */
    const sendingDecision = (call: () => Promise<ApiSnapshot>) => (): Promise<ApiSnapshot> => {
      const entry = reviewSendingScope(get());
      set((s) => { s.reviewDecisionsSending.push(entry); });
      return call().finally(() => { set((s) => { dropOne(s.reviewDecisionsSending, entry); }); });
    };
    /**
     * Route a mutation through the gateway when online, or queue it (Phase 8
     * offline outbox) when offline. Returns true when the action was handled
     * here (remote or queued); false means "no gateway — do the local mutation".
     */
    const runRemoteOrQueue = (
      op: OutboxOp,
      label: string,
      call: () => Promise<ApiSnapshot>,
      okMsg: OkMsg,
      // #827: a translated caller's queued line in the viewer's language; it also gets the network-failure
      // line in that language. Without it, the label plus the standard English lines, as before
      offlineMsg?: string,
      // #482 — how it went, for the in-app guide: `sent` (the server took it), `failed`, or, offline, `queued` with
      // whether this phone kept it. Told only while the scope it was made in is still current
      report?: (result: ActReport) => void,
    ): boolean => {
      if (!gateway) return false;
      if (get().online) {
        // #482 F-C4.2 — a refusal says the server's reason, never "Could not reach the server": a translated
        // caller in the viewer's language, every other in English, as the network line already does
        const lang = () => (offlineMsg !== undefined ? get().lang : 'en');
        const scope = currentScope();
        // an answer for another project is not this act taken (the guide's issue and publish steps read it so too)
        let answered: ApiSnapshot | null = null;
        const sent = () => call().then((snap) => { answered = snap; return snap; });
        void runRemote(sent, okMsg, (why) => SRV.refused(why, lang()), offlineMsg !== undefined ? () => DTX.unreachable[get().lang] : undefined).then((ok) => {
          if (scopeStillCurrent(scope)) report?.(ok && answered?.project.id === scope.projectId ? 'sent' : 'failed');
        });
        return true;
      }
      set((s) => {
        s.outbox.push(op);
        s.syncQueue.push(label);
      });
      const stillThere = madeHere();
      // said once the locked write holds it
      flashSaved(offlineMsg ?? label + ' — saved offline, will sync when you reconnect.', [op], report && ((stored) => { if (stillThere()) report(stored ? 'queued' : 'not-kept'); }));
      return true;
    };

    /** Phase 6 task 4d-ii-b / B4 — the approval's success copy, read from the RETURNED snapshot: under an
     *  active architect chain the approve compare-and-set lands the decision `awaiting_countersign` (4d-ii-a /
     *  A8a), and the toast must say so rather than "locked"; the delivered copy stands for a final approval,
     *  and for a row the returned slice does not carry (nothing is invented from its absence). */
    const approveOutcomeCopy = (decId: string) => (snap: ApiSnapshot): string =>
      snap.decisions.find((d) => d.id === decId)?.status === 'awaiting_countersign'
        ? DTX.approvedAwaiting[get().lang]
        : DTX.approvedSaved[get().lang];

    /** #827 — "Approve DL-009 — saved offline, …" in the viewer's language; the decision id is data. */
    const queuedLine = (verb: Record<Lang, string>, decId: string): string => DLX.savedOffline(`${verb[get().lang]} ${decId}`, get().lang);

    /**
     * WRITE-AHEAD command path (Task 10 correction round 2, finding 1). Unlike `runRemoteOrQueue`
     * (which only persists when OFFLINE and fires a bare network call when online), this ALWAYS
     * persists the op — with its stable idempotency key — to the durable outbox BEFORE any network
     * request, online or offline. Then:
     *   • online  → flush immediately; `flushOutbox` reuses the persisted op's key, removes it only on
     *     confirmed success/replay, KEEPS it (and its key) on a transient failure (network / timeout /
     *     5xx) so a retry or a reload replays the SAME op, and drops it on a terminal 4xx — all
     *     scope-guarded. The command's success toast fires via the reconcile's `okMsg`.
     *   • offline → the op waits in the outbox and syncs on reconnect.
     * So a lost/uncertain online response never strands a command without its key: the ledger applies
     * it exactly once however many times it is retried. Returns true when handled (gateway present).
     */
    // `offlineMsg`: what the toast says when the op is queued offline (#827: the daily log says it in the
    // viewer's language); without it, the label plus the standard English line, as before
    // okMsg may be a function: it is then read when the result is shown, so a translated success line
    // follows a language the viewer switched to while the command was on its way (#835)
    // `inRow`: acts a kept photo's row (IndexedDB) already holds, so on this phone before any key's write
    // #482 `report`: how the act went, for the in-app guide, told once and only in the scope it was made in: online, by
    // the flush that settles it (`sent`, `failed` when refused for good, or, left waiting to send again, `queued` when this
    // phone keeps it and `not-kept` when it does not); offline, once its write has run (`queued` or `not-kept`)
    const runWriteAhead = (op: OutboxOp, label: string, okMsg: string | (() => string), offlineMsg?: string, inRow: OutboxOp[] = [], report?: (result: ActReport) => void): boolean => {
      if (!gateway) return false;
      set((s) => { s.outbox.push(op); if (!s.online) s.syncQueue.push(label); });
      storedHere(inRow);
      // stored before any network call: no flush takes the outbox while a write-ahead's write is still waiting
      const written = writeAhead(inRow.includes(op) ? [] : [op]);
      // on this phone once its own key's write holds it, or a photo's row does, whatever the other key's write does
      const stored = () => storedNow([op]);
      const stillThere = madeHere();
      const key = 'idempotencyKey' in op ? op.idempotencyKey : undefined;
      // watched online and offline alike: the signal can come back before an offline act's write runs, and the flush
      // that then sends it is the one that knows how it went (Codex 4398620511)
      const watch = report && key ? (how: 'sent' | 'failed' | 'pending') => {
        actWatches.delete(key);
        // left to send again: kept on this phone or not, once its write has run (the signal can go before it does)
        if (how === 'pending') void written.then(() => { if (stillThere()) report(stored() ? 'queued' : 'not-kept'); });
        else if (stillThere()) report(how);
      } : undefined;
      if (watch && key) { writingKeys.add(key); actWatches.set(key, watch); }
      if (get().online) {
        // sent once its write has run; one that write could not store is said not saved, and sent from memory with its
        // ask's made record on this phone (#1113 r1 re-check: never held from the server)
        void written.then(() => {
          // the flush below takes it at once (or, coalesced, the running flush's end tells it if offline)
          if (key) writingKeys.delete(key);
          if (!stillThere()) { if (key) actWatches.delete(key); return; }
          if (!stored()) get().flash(QW.notSavedYet[get().lang]);
          void get().flushOutbox({ okMsg, act: op });
        });
      } else {
        void written.then(() => {
          if (key) writingKeys.delete(key);
          if (!stillThere()) { if (key) actWatches.delete(key); return; }
          get().flash(stored() ? (offlineMsg ?? label + ' — saved offline, will sync when you reconnect.') : QW.notSavedYet[get().lang]);
          // still offline and taken by no flush: told now; back online, the flush the reconnect started tells it
          if (!key) report?.(stored() ? 'queued' : 'not-kept');
          else if (actWatches.get(key) === watch && !get().online && !flushingKeys.has(key)) watch?.('pending');
        });
      }
      return true;
    };

    /** Phase 6 task 4d-ii-b / B5a — dispatch ONE countersign-chain act (`forward`, `countersign`, `disagree`,
     *  `resolveStranded`). Write-ahead under the op's fresh key; COALESCED against an equivalent act (same
     *  kind, same decision) still in the outbox — a double-click or a click while the first act awaits its
     *  reply runs once, under the FIRST key — never against a settled one, so the next legitimate act of the
     *  same kind is a new act under a new key. Without the server it does nothing but say so: the chain
     *  has no demo model, and fabricating a countersign locally would show a lock the server never granted. */
    const dispatchChainAct = (op: OutboxOp & { t: 'forwardDecision' | 'countersignDecision' | 'disagreeDecision' | 'resolveStrandedCountersign'; decisionId: string }, label: string, okMsg: string): void => {
      if (!gateway) { get().flash('This needs the server.'); return; }
      if (get().outbox.some((o) => o.t === op.t && 'decisionId' in o && o.decisionId === op.decisionId)) {
        get().flash(label + ' — already in progress.');
        return;
      }
      runWriteAhead(op, label, okMsg);
    };

    /** Phase 6 task 4d-ii-b / B6 — the member commands' per-act keys. An ACT is one intended change on one
     *  project scope (`<project>:<generation>:add:<request>`, `…:role:<user>:<role>:<discipline>`, `…:remove:<user>`);
     *  its key is minted on the first attempt and REUSED until the act settles — a confirmed success or a
     *  terminal (4xx) refusal — so the user's retry after a lost or uncertain response reaches the server's
     *  ledger under the same key and runs once, while the next identical act (adding the same person again
     *  after a success) is a new act under a new key. Held in memory only: a reload is a new act too, which
     *  the server's own dedup of a keyless call already covered before this unit.
     *
     *  The rule the proofs rest on (review rounds 1–3 on this unit): A SETTLE REMOVES ONLY THE KEY IT
     *  DISPATCHED, AND AN ACT BELONGS TO THE SCOPE IT WAS ATTEMPTED IN. The map entry is `boundAct → key`,
     *  where the bound act carries the FULL scope of the attempt — the project AND the scope generation
     *  (`ProjectScope`, the same identity every post-await guard in this store keys on): a sign-in, a
     *  sign-out or a project switch is a new generation, so the next identity on the same project never
     *  meets this one's keys or in-flight locks, and this one's late completion can never touch theirs. A
     *  completion names both the bound act and the key it was sent under (never "whatever the act holds
     *  now"). Two more guards make that hold under any interleaving within a scope:
     *  - `dispatchMemberAct` lets ONE request per bound act be in flight — a second attempt while the first
     *    is unanswered is not sent (it would share the key; its completion could then settle a key minted
     *    after the first one settled). The user's retry is the attempt AFTER a response, never beside one.
     *  - `settleMemberAct(boundAct, key)` is a compare-and-delete: the entry goes only if it still holds
     *    that key, so a completion can never remove a key it did not carry. The in-flight lock is released
     *    the same way (only by the key that took it), and the completion's UI effects run only while the
     *    attempt's scope is still the live one. */
    const memberActKeys = new Map<string, string>();
    const memberActsInFlight = new Map<string, string>();
    /** #482 step 3c — the guide run each add on its way was pressed under (bound act → run), so the same add pressed again
     *  in that run keeps the guide waiting on the first one's answer, and a refusal while another add of the run is on its
     *  way leaves the guide waiting for that one */
    const addRunsInFlight = new Map<string, number>();
    const memberAct = (scope: ProjectScope, act: string): string => `${scope.projectId}:${scope.generation}:${act}`;
    const memberActKey = (boundAct: string): string => {
      const existing = memberActKeys.get(boundAct);
      if (existing) return existing;
      const fresh = newIdempotencyKey();
      memberActKeys.set(boundAct, fresh);
      return fresh;
    };
    const settleMemberAct = (boundAct: string, key: string): void => {
      if (memberActKeys.get(boundAct) === key) memberActKeys.delete(boundAct);
    };
    /** One dispatch of a member act in the CURRENT scope: refuse a second attempt while the first is
     *  unanswered; mint or reuse the act's key; settle exactly that key on a success or a terminal refusal;
     *  keep it on a transient failure for the user's retry; run the UI effects only while the attempt's
     *  scope is still live. `label` names the act in the "already in progress" notice. False when it was not
     *  sent (that notice). */
    const dispatchMemberAct = (
      act: string,
      label: string,
      send: (key: string) => Promise<unknown>,
      onOk: () => void,
      onFail: () => void,
    ): boolean => {
      const scope = currentScope();
      const boundAct = memberAct(scope, act);
      if (memberActsInFlight.has(boundAct)) {
        get().flash(label + ' — already in progress.');
        return false;
      }
      const key = memberActKey(boundAct);
      memberActsInFlight.set(boundAct, key);
      send(key)
        .then(() => { settleMemberAct(boundAct, key); if (scopeStillCurrent(scope)) onOk(); })
        .catch((err: unknown) => {
          if (isTerminalOutboxError(err)) settleMemberAct(boundAct, key);
          if (scopeStillCurrent(scope)) onFail();
        })
        .finally(() => { if (memberActsInFlight.get(boundAct) === key) memberActsInFlight.delete(boundAct); });
      return true;
    };
    /** The add act is the REQUEST as the server hashes it (`MembersService.add`: name, role, the email
     *  lower-cased, the phone, the discipline only for a consultant) — a keyed replay with a different
     *  hash is a 409 on the server, so a re-entry that corrects any field must be a NEW act under a new
     *  key, and only the byte-identical request (or the same email in another case) reuses the key. */
    const addMemberAct = (input: AddMemberInput): string => 'add:' + JSON.stringify({
      name: input.name,
      role: input.role,
      email: input.email?.toLowerCase() ?? null,
      phone: input.phone ?? null,
      discipline: input.role === 'consultant' ? (input.discipline ?? null) : null,
    });

    // ── Phase 3 Task 7 (correction 2) — the pilot MATERIALS single-command dispatch. Every operational
    //    materials command (reserve a candidate, raise the residual requisition, issue, consume) goes
    //    through HERE: one WRITE-AHEAD op with a STABLE idempotency key, COALESCED against an identical
    //    in-flight op, and tracked in `materialsPending` for disable-while-pending. NO browser-side
    //    fan-out — the shortage is covered by explicit single user actions. ──
    const isMaterialsOp = (op: OutboxOp): boolean => isMaterialsOpType(op.t);
    const coalesceKeyOf = (op: OutboxOp): string | undefined => ('coalesceKey' in op ? op.coalesceKey : undefined);
    /** Dispatch ONE pilot-materials command. No-op off-pilot. Correction 3 (finding 1): coalescing is by
     *  the deterministic COALESCE key (double-click / reload while pending), NEVER the idempotency key —
     *  the op already carries a FRESH per-action `idempotencyKey` (reused on retry, different next time).
     *  So a double-click runs once, but a later legitimate identical action (after this one resolves and
     *  leaves `materialsPending`) dispatches afresh under a new idempotency key. */
    const dispatchMaterials = (op: OutboxOp & { idempotencyKey: string; coalesceKey: string }, label: string, okMsg: string): void => {
      if (!gateway || !get().capabilities.includes('materials')) return;
      const ck = op.coalesceKey;
      // coalesce: an EQUIVALENT action already awaiting (in the durable outbox) or marked pending is a
      // no-op, so one queued op + one disabled button per pending action.
      const queued = get().outbox.some((o) => coalesceKeyOf(o) === ck);
      if (queued || get().materialsPending.includes(ck)) return;
      set((s) => { s.materialsPending.push(ck); });
      runWriteAhead(op, label, okMsg);
    };

    // ── Phase 4 Task 6 (§J) — the pilot LABOUR single-command dispatch: the labour twin of
    //    `dispatchMaterials` with the SAME two-key lifecycle (fresh per-action `idempotencyKey`
    //    reused on retry; deterministic `coalesceKey` deduping an equivalent action while pending,
    //    tracked in `labourPending` for disable-while-pending). No-op off the labour pilot. ──
    const isLabourOp = (op: OutboxOp): boolean => isLabourOpType(op.t);
    const dispatchLabour = (op: OutboxOp & { idempotencyKey: string; coalesceKey: string }, label: string, okMsg: string): void => {
      if (!gateway || !get().capabilities.includes('labour')) return;
      const ck = op.coalesceKey;
      const queued = get().outbox.some((o) => coalesceKeyOf(o) === ck);
      if (queued || get().labourPending.includes(ck)) return;
      set((s) => {
        s.labourPending.push(ck);
        // Codex round 13 — retain the ORIGINAL allocate input alongside the key: the coalesce key
        // alone loses `capacityCommitmentId`, so in the success→reload gap a resolved supplier
        // draw stopped reserving its commitment and a second same-slice worker re-picked it.
        if (op.t === 'allocateLabour') s.labourPendingInputs[ck] = op.input;
      });
      runWriteAhead(op, label, okMsg);
    };

    // ── Phase 5 Task 7B-iii-a (§M) — the pilot COMMERCIAL single-command dispatch: the third
    //    instance of the SAME two-key lifecycle, cloned from labour (the corrected one) rather
    //    than from materials. No-op off the commercial pilot. ──
    const isCommercialOp = (op: OutboxOp): boolean => isCommercialOpType(op.t);
    /** The permission each §M write requires, so the AUTHORITY check below reads the policy the
     *  server enforces rather than a copy of its answer (Codex J1). */

    const dispatchCommercial = (op: OutboxOp & { idempotencyKey: string; coalesceKey: string }, label: string, okMsg: string): void => {
      if (!gateway || !get().capabilities.includes('commercial')) return;
      // Codex J1, defence in depth. The screen hides a control the role may not use, but the
      // outbox is DURABLE and this dispatcher is reachable without it — and an op queued without
      // authority is not merely refused, it is refused AFTER the user was told it was saved. The
      // capability is already guarded one line up; authority is the same kind of precondition and
      // was the missing half.
      const permission = COMMERCIAL_OP_PERMISSION[op.t as keyof typeof COMMERCIAL_OP_PERMISSION];
      if (permission && !(ROLE_POLICY[permission] as readonly string[]).includes(get().role)) return;
      const ck = op.coalesceKey;
      // Conflict, not just equality — see `commercialWriteBlocked`. The §F verbs carry different
      // keys for one claim, so exact-match coalescing let a reject queue behind a pending submit.
      const queuedKeys = get().outbox.flatMap((o) => { const k = coalesceKeyOf(o); return k ? [k] : []; });
      if (commercialWriteBlocked(ck, queuedKeys) || commercialWriteBlocked(ck, get().commercialPending)) return;
      set((s) => {
        s.commercialPending.push(ck);
        // and the queued QUANTITY, so the remaining-authority cap can subtract work that is in
        // flight but not yet folded into any register
        const reservation = capReservationOf(op);
        if (reservation) s.commercialPendingQty[ck] = reservation;
      });
      runWriteAhead(op, label, okMsg);
    };

    /** Adopt a server auth result as the real session — the ONE adoption path for
     *  every API sign-in (password, email-OTP, phone-OTP) AND the project
     *  switch. The token is scoped to exactly the project the SERVER returns
     *  (never the caller's requested/URL project): leaving `activeProjectId`
     *  elsewhere would send this token to another project's routes and 403 every
     *  call, stranding stale data on screen under the wrong identity. */
    const applyAuthResult = (
      res: { role: Role; token: string; name?: string; projectId?: string },
      opts?: { msg?: string; targetScreen?: ScreenKey; targetItem?: string; quiet?: boolean },
    ): void => {
      resetQueueScope();
      set((s) => {
        const changedProject = !!res.projectId && res.projectId !== s.activeProjectId;
        const wasPending = s.pendingProjectId !== null;
        s.role = res.role;
        // #798 — a link-only screen (the PMC's Daily Log) is a target a switch may land on too
        const allowed = routableScreensFor(res.role);
        // a role-allowed target screen survives the transition (deep links); anything
        // else lands on the role's home
        // B2 — never land on an undefined screen: a role whose list were ever empty falls back to the home
        s.screen = opts?.targetScreen && allowed.includes(opts.targetScreen) ? opts.targetScreen : (allowed[0] ?? 'inbox');
        // #799 — the record a switch was asked to open, only on the screen it was asked for (the openItem rule)
        if (opts?.targetItem !== undefined) {
          const item = s.screen === opts.targetScreen ? opts.targetItem : null;
          s.decisionFocus = s.screen === 'client-decisions' ? item : null;
          s.routeItem = s.screen === 'client-decisions' ? null : item;
        }
        s.sessionToken = res.token;
        s.userName = res.name ?? null;
        // the brief spans this person's projects, so a switch keeps it; another identity never sees it
        if (jwtSub(res.token) !== s.sessionUserId) { s.brief = null; s.briefAt = null; }
        s.sessionUserId = jwtSub(res.token);
        s.access = freshAccess(s.access.generation + 1);
        // EVERY auth result is a new session identity, so it always starts a new
        // scope generation — a reply issued FOR the previous identity (even on the
        // SAME project: a different user/role sees different records) can never
        // satisfy the current scope guard. Codex gate finding 6.
        s.projectScopeGeneration += 1;
        // SV2: a held visit, and a person's Send anyway, belong to the scope they were made in
        s.siteVisitsHeld = null;
        s.siteVisitsSentAnyway = [];
        dropVisitPhotoRetry(); // and the retry armed for it: the scope's own load arms its own
        // Codex 4210609591 — a new scope owes nothing of the old one's commands (its coordinator is abandoned)
        s.commandReconcilePending = false;
        s.commandReconcileOwed = noReconcileOwed();
        if (res.projectId && changedProject) {
          s.activeProjectId = res.projectId; // the SERVER-returned scope, verbatim
          // If a switch already emptied the data for THIS project, don't clear twice.
          // Otherwise (sign-in adoption, or the server re-scoped us elsewhere):
          // empty data + blank identity until the snapshot lands.
          if (s.pendingProjectId !== res.projectId) {
            s.name = '';
            s.short = '';
            s.descriptor = '';
            s.stage = '';
            s.siteCode = '';
            s.timeZone = null; // the next project's zone is unknown until its snapshot lands
            Object.assign(s, emptyProjectData());
            Object.assign(s, emptyModuleReadState()); // finding 4: a new project's reads start fresh, not stale-'ready'
          }
        } else if (!wasPending) {
          // same-project re-authentication: the previous identity's records are not
          // this identity's truth — clear and let the post-auth refresh refetch them
          Object.assign(s, emptyProjectData());
          Object.assign(s, emptyModuleReadState()); // finding 4: the new identity's module reads are not yet loaded
        }
        // in every branch the project data is now empty — awaiting this identity's snapshot
        s.projectLoadState = 'loading';
        s.projectLoadError = null;
        s.pendingProjectId = null;
      });
      get().syncProjectCreateHold(); // a create hold is the signed-in identity's own (Codex 4192524377)
      // #482 6227430525 — keep the adopted session for this tab, so a reload does not sign the person out
      saveSession({ token: res.token, role: res.role, name: res.name, projectId: res.projectId ?? get().activeProjectId });
      if (!opts?.quiet) get().flash(opts?.msg ?? 'Signed in as ' + (res.name ?? res.role) + '.');
    };

    /** Local-demo passwordless sign-in: map an email to a role (else engineer). */
    const localEmailSignIn = (em: string): void => {
      const role: Role = em.startsWith('pmc@') ? 'pmc' : em.startsWith('client@') ? 'client' : em.startsWith('contractor@') ? 'contractor' : 'engineer';
      set((s) => {
        s.role = role;
        s.screen = screensFor(role)[0]?.key ?? 'inbox';
        s.access = freshAccess(s.access.generation + 1);
      });
      get().flash('Signed in as ' + role + ' (demo).');
    };

    /** Index in `reviews` of the review the PMC is acting on: the explicitly
     *  selected one, else the first pending, else the first. -1 when the queue is empty. */
    const activeReviewIdx = (): number => {
      const st = get();
      if (!st.reviews.length) return -1;
      const byId = st.activeReviewId ? st.reviews.findIndex((r) => r.id === st.activeReviewId) : -1;
      if (byId >= 0) return byId;
      const pending = st.reviews.findIndex((r) => !r.decided);
      return pending >= 0 ? pending : 0;
    };

    return {
    ...getInitialState(),
    captureProjectScope: currentScope,
    retryProjectLoad: () => {
      if (!gateway) return;
      set((s) => { s.projectLoadError = null; });
      // gate round 11: the boundary's Retry is a coalesced fresh pull through the
      // coordinator — it surfaces loading, applies only if it's still the newest,
      // and re-exposes the recoverable error on failure / wrong-project.
      void requestFreshSnapshot();
    },
    _setGateway: (g) => {
      gateway = g;
    },
    _outboxFlushing: () => outboxFlushing,
    _queueReleased: () => releaseDrains,
    restoreSession: () => {
      // #482 6227430525 — a reload adopts the session this tab saved, through the one adoption path, so a
      // reload lands back where the person was instead of on the sign-in screen. Never under dev auth.
      if (!API_BASE || DEV_AUTH || get().sessionToken !== null) return false;
      const saved = loadSession();
      if (!saved) return false;
      // the screen the URL names (`initialScreen`) survives the adoption, as a deep link does
      const screen = get().screen;
      const urlProject = typeof window !== 'undefined' ? parseLocation(window.location.pathname).projectId : null;
      applyAuthResult(saved, { quiet: true, targetScreen: screen });
      restoredToken = saved.token;
      restoreSwitchTarget = urlProject && saved.projectId && urlProject !== saved.projectId ? { projectId: urlProject, screen } : null;
      return true;
    },
    serverGateway: () => gateway,
    // gate round 11: the PUBLIC apply is a coordinator entry — it begins a FRESH
    // lease (a delivered snapshot is the newest intent) and routes through
    // acceptSnapshot, returning true only for `applied`. Internal command paths do
    // NOT use this; they capture their lease before their request and call the
    // coordinator's acceptSnapshot directly.
    applySnapshot: (snap, capturedScope) =>
      acceptSnapshot(snap, beginSnapshotLease(capturedScope ?? currentScope())) === 'applied',
    requestFreshSnapshot: () => { void requestFreshSnapshot(); },

    // ---- shell ----
    setRole: (role) => {
      const first = screensFor(role)[0]?.key ?? 'inbox';
      const applySwitch = () => { resetQueueScope(); clearSession(); set((s) => {
        s.role = role;
        s.screen = first;
        s.notifOpen = false;
        // a persona switch changes which options `createOptionsFor` yields, so an open menu
        // would be showing the previous role's list
        s.createOpen = false;
        s.modal = { type: null };
        // an explicit persona switch is dev auth — drop any real OTP session
        s.sessionToken = null;
        s.userName = null;
        s.sessionUserId = null;
        // Codex 4219959023 — against the API, a persona switch is a NEW identity exactly like a
        // re-authentication: the previous persona's records (an engineer sees only the checklists
        // assigned to them) are not this persona's truth, and a reply issued for the old persona must
        // not satisfy the new scope. Clear them and show loading until the new persona's snapshot
        // lands, so no screen — nor the bell's read-time check — judges against the old slices. The
        // local demo (no gateway) keeps its seeded store.
        if (gateway) {
          s.projectScopeGeneration += 1;
          // SV2: a held visit, and a person's Send anyway, belong to the scope they were made in
          s.siteVisitsHeld = null;
          s.siteVisitsSentAnyway = [];
          dropVisitPhotoRetry(); // and the retry armed for it: the scope's own load arms its own
          s.commandReconcilePending = false;
          s.commandReconcileOwed = noReconcileOwed();
          Object.assign(s, emptyProjectData());
          Object.assign(s, emptyModuleReadState());
          s.projectLoadState = 'loading';
          s.projectLoadError = null;
        }
      }); get().syncProjectCreateHold(); };
      // round-11 Codex F3 — on a push-capable browser a persona switch is a DEPARTURE exactly
      // like sign-out: the departing identity's subscription link is severed BEFORE the switch
      // completes (the same bounded handoff signOut runs, the same session-identity condition —
      // dev-auth holds its JWT in the gateway and the request authenticates there). Without it
      // the endpoint stayed linked to persona A until persona B's connect re-subscribed — and
      // indefinitely if that connect failed — so A's targeted decision pushes could reach the
      // browser B now holds. The switch itself (which re-runs the connect effect and issues the
      // NEW persona's token) waits for the bounded handoff, so the unlink rides A's authority.
      const pushCapable =
        typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        && typeof window !== 'undefined' && 'PushManager' in window;
      if (gateway && (get().sessionToken !== null || get().sessionUserId !== null) && pushCapable) {
        const gw = gateway;
        void Promise.race([
          unlinkPushOnSignOut(gw),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]).finally(applySwitch);
        return;
      }
      applySwitch();
    },
    /**
     * End the real session and return to the sign-in screen. Clears the token,
     * resets the access flow to 'who', and drops back to a neutral role/screen.
     * With dev auth off, the AppShell auth-gate then shows the sign-in screen.
     */
    signOut: () => {
      // #948 Codex 4300725697 — forget the tab's saved session at once: a reload during the bounded push unlink
      // below must not restore the session being signed out (the in-memory token stays for the unlink request)
      clearSession();
      restoreSwitchTarget = null;
      // Phase 6 task 4b (§A.3 round 13) — UNLINK this browser's push subscription BEFORE the
      // token clears (the request needs the still-valid session): a shared device must not keep
      // receiving the departing user's decider-targeted content. Round-1 Codex F1: the handoff
      // WAITS (bounded) for the unlink on a push-capable browser, so it does not complete while
      // the departing user's request is still in flight — AND the server clears a link only when
      // it still belongs to the caller, so a delayed request can never strip the next user's
      // re-attributed link. On a browser with no push surface the teardown stays synchronous.
      const pushCapable =
        typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        && typeof window !== 'undefined' && 'PushManager' in window;
      // round-10 Codex F3 — the unlink decision keys on the SESSION IDENTITY, never the adopted
      // token alone: a gateway-backed dev-auth session holds its JWT inside the gateway
      // (`sessionToken` stays null; round-7 F3 records the identity as `sessionUserId`), and
      // skipping the unlink there left the departing persona's targeted link live on a shared
      // demo device until the JWT expired. The gateway authenticates the request itself.
      if (gateway && (get().sessionToken !== null || get().sessionUserId !== null) && pushCapable) {
        const gw = gateway;
        void Promise.race([
          unlinkPushOnSignOut(gw),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]).finally(() => get().completeSignOut());
        return;
      }
      get().completeSignOut();
    },
    /** The sign-out teardown itself — separated so the push unlink can complete first on a
     *  push-capable browser (round-1 Codex F1) while every other environment stays synchronous. */
    completeSignOut: () => {
      resetQueueScope(); // WEB-02 step A: this tab's memory of its keys, and their strip list, leave with the session
      clearSession();
      restoreSwitchTarget = null;
      set((s) => {
        s.sessionToken = null;
        s.userName = null;
        s.sessionUserId = null;
        s.brief = null; // the departing PMC's cross-project brief leaves with them
        s.briefAt = null;
        s.access = freshAccess(s.access.generation + 1);
        s.role = 'client';
        s.screen = screensFor('client')[0].key;
        // V-1018-6 — the gate the person returns to reads in the language last chosen on this device
        s.lang = readDeviceLang() ?? s.lang;
        s.notifOpen = false;
        s.createOpen = false;
        s.modal = { type: null };
        // WEB-02: quarantine this user's queued work — it stays persisted under THEIR
        // scope key and resumes on their next sign-in; the next user never replays it.
        s.outbox = [];
        s.syncQueue = [];
        s.pendingEvidenceKeys = null;
        // Ending the session ends the scope (Codex gate finding 6): the signed-out
        // user's records leave memory, and the generation bump refuses any of their
        // replies still in flight — nothing survives for the next identity to see.
        s.projectScopeGeneration += 1;
        // SV2: a held visit, and a person's Send anyway, belong to the scope they were made in
        s.siteVisitsHeld = null;
        s.siteVisitsSentAnyway = [];
        dropVisitPhotoRetry(); // and the retry armed for it: the scope's own load arms its own
        // Codex 4210609591 — a new scope owes nothing of the old one's commands (its coordinator is abandoned)
        s.commandReconcilePending = false;
        s.commandReconcileOwed = noReconcileOwed();
        s.timeZone = null; // the demo store has no project zone; the next sign-in's snapshot supplies one
        Object.assign(s, emptyProjectData());
        Object.assign(s, emptyModuleReadState()); // finding 4: sign-out tears down the module read state too
        s.projectLoadState = 'idle';
        s.projectLoadError = null;
        s.pendingProjectId = null;
      });
      get().syncProjectCreateHold(); // the departed user's attempt stays theirs, in their own record
    },
    setScreen: (k) =>
      set((s) => {
        s.screen = k;
        s.notifOpen = false;
        // a screen opened from the nav starts at its list, never at a decision left open earlier
        s.decisionFocus = null;
        s.routeItem = null;
        // #781 Codex 4240026312 — a Site Map hand-off still waiting for the schedule to settle is abandoned with
        // the visit: a later visit opens at the top, never at that activity
        s.activityFocus = null;
        s.returnPlace = null; // #633 — a nav visit leaves the Site Map's return behind
      }),
    openDecision: (decisionId) =>
      set((s) => {
        s.returnPlace = null;
        s.decisionFocus = decisionId;
        s.routeItem = null;
        s.screen = 'client-decisions';
        s.notifOpen = false;
      }),
    closeDecision: () =>
      set((s) => {
        s.decisionFocus = null;
        s.returnPlace = null; // #633 — leaving the record leaves its way back behind
      }),
    openDrawing: (drawingId, fromPlace) =>
      set((s) => {
        s.returnPlace = fromPlace ? { nodeId: fromPlace.nodeId, screen: 'drawings', item: drawingId } : null;
        s.routeItem = drawingId;
        s.decisionFocus = null;
        s.screen = 'drawings';
        s.notifOpen = false;
      }),
    setRouteItem: (item) =>
      set((s) => {
        if (s.screen === 'client-decisions') s.decisionFocus = item;
        else s.routeItem = item;
        // #826 Codex 4258001532 — the way back belongs to the visit that opened the record: leaving it (closing
        // it, or opening another) drops it, so reopening the same record from its list offers none
        if (s.returnPlace && s.returnPlace.item !== item) s.returnPlace = null;
      }),
    openItem: (screen, item, fromPlace) =>
      set((s) => {
        s.returnPlace = fromPlace ? { nodeId: fromPlace.nodeId, screen, item } : null;
        s.screen = screen;
        s.notifOpen = false;
        s.decisionFocus = screen === 'client-decisions' ? item : null;
        s.routeItem = screen === 'client-decisions' ? null : item;
        s.activityFocus = null; // #781 Codex 4240026312 — a new record link supersedes a pending hand-off
      }),
    openPlace: (nodeId) =>
      set((s) => {
        s.returnPlace = null;
        s.placeFocus = nodeId;
        s.routeItem = nodeId;
        s.decisionFocus = null;
        s.screen = 'places';
        s.notifOpen = false;
      }),
    clearPlaceFocus: () =>
      set((s) => {
        s.placeFocus = null;
      }),
    openActivity: (activityId, fromPlace) =>
      set((s) => {
        s.returnPlace = fromPlace ? { nodeId: fromPlace.nodeId, screen: 'site-schedule', item: activityId } : null;
        s.activityFocus = activityId;
        // Top 10 #3c (#774) — the activity is the URL's item (`/schedule/<id>`): reload-safe and shareable
        s.routeItem = activityId;
        s.screen = 'site-schedule';
        s.notifOpen = false;
      }),
    clearActivityFocus: () =>
      set((s) => {
        s.activityFocus = null;
      }),
    setLang: (l) => set((s) => { s.lang = l; }),
    toggleNotif: () => {
      set((s) => { s.notifOpen = !s.notifOpen; });
      if (get().notifOpen) void get().markShownNotificationsSeen();
    },
    markShownNotificationsSeen: async () => {
      // the API path only: a local/demo store has no receipts to write
      const gw = gateway;
      if (!gw) return;
      const scope = projectScopeOf(get());
      const inScope = () => gateway === gw && isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, scope);
      // sequential chunks, each its own attempt and its own confirmation; a failed chunk does not stop the next
      for (const planned of planSeenChunks(get().notifications, get().notifSeen)) {
        if (!inScope()) return;
        // claim at SEND time, not plan time: an id another open confirmed or claimed since stays its own
        let attempt = 0;
        let ids: string[] = [];
        set((s) => { ({ attempt, ids } = claimSeenChunk(s.notifSeen, planned)); });
        if (ids.length === 0) continue;
        try {
          const { confirmed } = await gw.markNotificationsSeen(ids);
          // an answer that returns after a project switch has nothing to change
          if (!inScope()) return;
          set((s) => { applySeenConfirmed(s.notifSeen, attempt, ids, Array.isArray(confirmed) ? confirmed : []); });
        } catch {
          if (!inScope()) return;
          set((s) => { applySeenFailure(s.notifSeen, attempt, ids); });
        }
      }
    },
    openCreate: () => set((s) => { s.createOpen = true; }),
    closeCreate: () => set((s) => { s.createOpen = false; }),
    flash: (msg) => {
      set((s) => { s.toast = msg; });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set((s) => { s.toast = null; }), 3200);
    },
    openQr: () => set((s) => { s.modal = { type: 'qr' }; }),
    closeModal: () => set((s) => { s.modal = { type: null }; }),

    // ---- decisions ----
    openApprove: (decId, optIdx) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      const o = d.options[optIdx];
      set((s) => {
        s.modal = {
          type: 'approve',
          decId,
          optIdx,
          title: d.title,
          optionLabel: o.label,
          material: o.material,
          delta: o.delta,
          swatch: o.swatch,
        };
      });
    },
    confirmApprove: () => {
      const { decId, optIdx } = get().modal;
      if (decId == null || optIdx == null) return;
      set((s) => { s.modal = { type: null }; });
      // one stable idempotency key for this approval — the online send and any offline replay
      // reach the server under it, so a lost-response retry re-locks once (Phase 2 Task 5).
      const approveKey = newIdempotencyKey();
      // #482 — the guide's confirm step follows this decision under the run it was confirmed in
      const guideRun = guideRunToken();
      const reportApprove = (result: ActReport) =>
        emitGuideOutcome(result === 'sent' || result === 'queued' ? 'decision-approved' : result === 'failed' ? 'decision-approve-failed' : 'decision-approve-not-kept', decId, guideRun);
      if (runRemoteOrQueue({ t: 'approve', decisionId: decId, optionIndex: optIdx, idempotencyKey: approveKey }, 'Approve ' + decId, () => gateway!.approveDecision(decId, optIdx, approveKey), approveOutcomeCopy(decId), queuedLine(DTX.approveLabel, decId), reportApprove)) return;
      const src = get().decisions.find((x) => x.id === decId);
      const material = src ? src.options[optIdx].material : '';
      const title = src ? src.title : '';
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) {
          const o = d.options[optIdx];
          d.status = 'approved';
          d.approvedOption = o.label;
          d.material = o.material;
          d.cost = o.delta;
          d.approver = 'Mr. Shah';
          d.date = '03 Jul 2026';
          d.photoSwatch = o.swatch;
          delete d.changeRequest; // a re-approval RESOLVES the open change request
        }
        s.notifications.unshift({
          text: 'Client approved ' + title + ' — ' + material, time: 'just now', color: '#3F7A54', decisionId: decId,
          // #839 — the demo's approval carries its facts as the server's does, so the bell can translate it
          facts: { kind: 'approval', byClient: true, actorName: 'Mr. Shah', actorRole: 'client', title, material, onBehalfOf: null, ending: null },
        });
        s.modal = { type: null };
      });
      get().flash(DTX.approvedDemo[get().lang]);
      reportApprove('sent');
    },
    // Both consultation commands take the WRITE-AHEAD path (review finding F4), not
    // `runRemoteOrQueue`. The distinction matters here precisely because a consultation is an
    // append-only FACT: `runRemoteOrQueue` mints the idempotency key in memory and, when online,
    // fires a bare call that persists nothing — so a lost or uncertain response strands the
    // command with its key, and the only recovery available to the user is to ask again, which
    // arrives under a DIFFERENT key and appends a SECOND consultation. Writing the op to the
    // durable outbox first means the same key is replayed until the server confirms, and the
    // ledger applies it exactly once however many times that takes.
    requestConsultation: (decId, consulteeMembershipId, question) => {
      const text = question.trim();
      if (!text) return;
      // ONE stable key for this question — persisted WITH the op, so the online flush, a retry
      // after a lost response, and an offline replay all reach the server under it.
      const key = newIdempotencyKey();
      if (
        runWriteAhead(
          { t: 'consultationRequest', decisionId: decId, consulteeMembershipId, question: text, idempotencyKey: key },
          'Consult ' + decId,
          () => DTX.asked[get().lang],
          queuedLine(DTX.consultLabel, decId),
        )
      ) {
        set((s) => { s.modal = { type: null }; });
        return;
      }
      // demo/offline-only fallback: the server is the authority on the thread, so nothing is
      // fabricated locally beyond closing the sheet.
      set((s) => { s.modal = { type: null }; });
      get().flash(DTX.asked[get().lang]);
    },
    respondToConsultation: (decId, consultationId, response, recommendedOptionIndex) => {
      const text = response.trim();
      if (!text) return;
      const key = newIdempotencyKey();
      // #482 — the guide's Send step follows this one consultation (`<decision>:<consultation>`) under the run it was sent in
      const guideRun = guideRunToken();
      const reportAdvice = (result: ActReport) =>
        emitGuideOutcome(result === 'sent' || result === 'queued' ? 'advice-sent' : result === 'failed' ? 'advice-send-failed' : 'advice-not-kept', `${decId}:${consultationId}`, guideRun);
      if (
        runWriteAhead(
          { t: 'consultationRespond', decisionId: decId, consultationId, response: text, ...(recommendedOptionIndex !== undefined ? { recommendedOptionIndex } : {}), idempotencyKey: key },
          'Advise ' + decId,
          () => DTX.advised[get().lang],
          queuedLine(DTX.adviseLabel, decId),
          [],
          reportAdvice,
        )
      ) {
        set((s) => { s.modal = { type: null }; });
        return;
      }
      set((s) => { s.modal = { type: null }; });
      get().flash(DTX.advised[get().lang]);
      // demo: nothing is recorded (the server owns the thread), so the guide does not count it answered
      reportAdvice('not-kept');
    },
    // ── Phase 6 task 4d-ii-b / B5a — the four countersign-chain commands. Each is one write-ahead act
    //    under ONE fresh key (`dispatchChainAct`): coalesced while an equivalent act on the same decision
    //    is still in the outbox, replayed under the same key after a lost response, and refused-as-said
    //    when the server 409s it (the flush surfaces the server's message). Reasons are required where
    //    the shared contract requires them; a blank one is refused here before any key is minted. ──
    forwardDecision: (decId, input) => {
      const reason = input.reason.trim();
      if (!reason) { get().flash('A reason is required to forward a decision.'); return; }
      dispatchChainAct({ t: 'forwardDecision', decisionId: decId, input: { ...input, reason }, idempotencyKey: newIdempotencyKey() }, 'Forward ' + decId, 'Forwarded — the new decider will see it.');
    },
    countersignDecision: (decId) => {
      dispatchChainAct({ t: 'countersignDecision', decisionId: decId, idempotencyKey: newIdempotencyKey() }, 'Countersign ' + decId, 'Countersigned — the decision is locked.');
    },
    disagreeDecision: (decId, input) => {
      const reason = input.reason.trim();
      if (!reason) { get().flash('A reason is required to send a decision back.'); return; }
      dispatchChainAct(
        { t: 'disagreeDecision', decisionId: decId, input: { ...input, reason }, idempotencyKey: newIdempotencyKey() },
        'Disagree ' + decId,
        input.path === 'forward_on' ? 'Sent on to the new decider as a change request.' : 'Sent back to the decider as a change request.',
      );
    },
    resolveStrandedCountersign: (decId, input) => {
      const reason = input.reason.trim();
      if (!reason) { get().flash('A reason is required to resolve a stranded countersign.'); return; }
      dispatchChainAct(
        { t: 'resolveStrandedCountersign', decisionId: decId, input: { ...input, reason }, idempotencyKey: newIdempotencyKey() },
        'Resolve ' + decId,
        input.outcome === 'completed' ? 'Countersign resolved — the decision is locked.' : 'Returned to the decider as a change request.',
      );
    },
    openChange: (decId) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      set((s) => {
        s.modal = { type: 'change', decId, title: d.title, changeText: '', changeCost: '', changeTime: '' };
      });
    },
    submitChange: () => {
      const { decId, changeText, changeCost, changeTime } = get().modal;
      if (decId == null) return;
      const reason = changeText?.trim() || 'Change requested';
      // #482 comment 5923291892 (family-wide): the impacts are read exactly or refused, never repaired —
      // "12.50" is not 1250, "abc" is not 0, and a Unicode minus keeps its sign. A refused entry sends
      // NOTHING and leaves the modal open on its field's reason (the modal disables Submit as well).
      const costReading = readImpact(String(changeCost ?? ''), 'cost');
      const timeReading = readImpact(String(changeTime ?? ''), 'days');
      if (!costReading.ok || !timeReading.ok) return;
      const costImpact = costReading.value;
      const timeImpactDays = timeReading.value;
      // round-11 Codex F2 — the confirmation names the ACTUAL decider whose re-approval the
      // request now awaits; the client-held text stays byte-identical (the legacy default)
      const changeKind = get().decisions.find((x) => x.id === decId)?.deciderKind ?? 'client';
      const changeToast = (): string => changeSubmittedToast(changeKind, get().lang);
      set((s) => { s.modal = { type: null }; });
      const changeKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'change', decisionId: decId, reason, costImpact, timeImpactDays, idempotencyKey: changeKey }, 'Change ' + decId, () => gateway!.requestChange(decId, reason, costImpact, timeImpactDays, changeKey), changeToast, queuedLine(DTX.changeLabel, decId))) return;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) {
          d.status = 'change';
          d.changeRequest = { reason, costImpact, timeImpactDays };
        }
        s.modal = { type: null };
      });
      get().flash(changeSubmittedToast('client', get().lang));
    },
    withdrawChange: (decId) => {
      const withdrawKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'changeWithdraw', decisionId: decId, idempotencyKey: withdrawKey }, 'Withdraw change ' + decId, () => gateway!.withdrawChange(decId, withdrawKey), () => DTX.changeWithdrawn[get().lang], queuedLine(DTX.withdrawLabel, decId))) return;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d && d.status === 'change') {
          d.status = 'approved';
          delete d.changeRequest;
        }
      });
      get().flash(DTX.changeWithdrawn[get().lang]);
    },
    openWithdraw: (decId) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      set((s) => {
        s.modal = { type: 'withdraw', decId, title: d.title, withdrawReason: '' };
      });
    },
    confirmWithdraw: () => {
      const { decId, withdrawReason } = get().modal;
      if (decId == null) return;
      const reason = withdrawReason?.trim() ?? '';
      if (!reason) return; // the contract refuses a blank reason; the modal disables confirm
      set((s) => { s.modal = { type: null }; });
      // a fresh key per deliberate action; the queued op replays under the SAME key exactly once
      const withdrawDecisionKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'withdraw', decisionId: decId, reason, idempotencyKey: withdrawDecisionKey }, 'Withdraw ' + decId, () => gateway!.withdrawDecision(decId, reason, withdrawDecisionKey), 'Decision withdrawn — recorded in the register.')) return;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d && d.status === 'pending') {
          d.status = 'withdrawn';
          d.withdrawReason = reason;
          // round 8 (Codex): the demo/no-API path mirrors the server's notice retirement — a
          // bell row still saying "awaiting approval" for a decision every surface now hides
          // is a live false instruction. Demo notices carry no decisionId, so retirement
          // matches the canonical text shape, multiplicity-guarded exactly like the server:
          // if another still-pending decision shares the title, the text is ambiguous and the
          // row is LEFT, never guessed at.
          const noticeText = `Decision awaiting approval: ${d.title}`;
          const sharers = s.decisions.filter((o) => o.id !== d.id && o.title === d.title && o.status === 'pending' && !o.draft).length;
          if (sharers === 0) s.notifications = s.notifications.filter((n) => n.text !== noticeText);
        }
        s.modal = { type: null };
      });
      get().flash('Decision withdrawn — recorded in the register.');
    },
    setWithdrawReason: (v) => set((s) => { s.modal.withdrawReason = v; }),
    setChangeText: (v) => set((s) => { s.modal.changeText = v; }),
    setChangeCost: (v) => set((s) => { s.modal.changeCost = v; }),
    setChangeTime: (v) => set((s) => { s.modal.changeTime = v; }),

    // ---- engineer checklist (a null checklist = none issued; every action no-ops) ----
    selectChecklist: (id) => {
      // read the target from FINALIZED state, not from inside the recipe: the clone must be of a
      // plain checklist, and a draft proxy is not a safe `structuredClone` source.
      const target = get().openChecklists.find((c) => c.id === id);
      if (!target || get().checklist?.id === id) return;
      // An ONLINE submit in flight owns the submission record, and that record holds ONE
      // inspection. `reconcileSubmission` below would retire it — its `else` arm fires the moment
      // `sub.inspectionId` stops matching the checklist in the slot — leaving the submitted
      // checklist editable while its request is still open and stamping `attempt: 0`, so
      // `isThisAttempt()` discards the response when it lands. A `queued` offline submit has no
      // such problem: its freeze is rebuilt from the DURABLE outbox on every reconcile, so it
      // survives any number of switches. Refusing the switch for the seconds an online submit is
      // unresolved is therefore exactly the restriction the defect needs, and it leaves the
      // submission lifecycle — eleven gate rounds of it — untouched.
      const sub = get().submission;
      if (sub.status === 'submitting' && sub.generation === get().projectScopeGeneration) {
        get().flash(CHT.switchWait[get().lang]);
        return;
      }
      const fresh = structuredClone(target);
      set((s) => {
        // keep whatever the engineer has done to the checklist they are leaving — including the demo
        // path's photo counter and thumbnails, which no mark records
        parkEditSlot(s);
        s.selectedChecklistId = id;
        s.checklist = fresh;
        // server truth + THIS inspection's unsubmitted intent — the same rule a refresh applies.
        overlayChecklistMarks(s);
        // the freeze is per-inspection: a checklist with a QUEUED submit must open frozen, and one
        // without must not inherit the previous checklist's freeze. Safe here precisely because the
        // guard above has already excluded the one status this single record cannot survive.
        reconcileSubmission(s);
      });
    },
    setItem: (idx, val) =>
      set((s) => {
        const c = s.checklist;
        const it = c?.items[idx];
        if (!c || !it) return;
        if (checklistFrozen(s)) return; // gate round 8: no edits once the payload is frozen
        it.state = it.state === val ? null : val;
        recordChecklistMark(s, c.id, it.id, 'state', it.state);
      }),
    addPhoto: (idx) => set((s) => { if (checklistFrozen(s)) return; const it = s.checklist?.items[idx]; if (it) it.photos += 1; }),
    addChecklistEvidence: async (idx, dataUrl, capturedOn) => {
      // THE PHOTO BELONGS TO THE CHECKLIST IT WAS TAKEN ON. Reading the file is asynchronous, and the
      // engineer can move the edit slot while it runs (more than one checklist is out on site — that is
      // the whole point of the picker). Re-reading the slot here addressed the OTHER checklist at the
      // same item index, so the durable upload named the wrong inspection and item: a photo filed as
      // evidence against work it is not evidence of. `capturedOn` is pinned at the moment the camera
      // was opened; the checklist is resolved from it, falling back to the slot only for a caller that
      // pins nothing.
      const resolveCaptured = (): Checklist | null => {
        const st = get();
        if (!capturedOn) return st.checklist;
        if (st.checklist?.id === capturedOn) return st.checklist;
        return st.openChecklists.find((o) => o.id === capturedOn) ?? null;
      };
      const c = resolveCaptured();
      const item = c?.items[idx];
      if (!c || !item) {
        // The checklist the photo was taken on is no longer outstanding (submitted, decided, or the
        // project moved). Say so rather than dropping the capture in silence.
        if (capturedOn) get().flash(CHT.noLongerOpen[get().lang]);
        return;
      }
      if (inspectionFrozen(get(), c)) { get().flash(CHT.noMoreChanges[get().lang]); return; } // gate round 8
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) {
        get().flash(CHT.readFailed[get().lang]);
        return;
      }
      const [, mime, base64] = m;
      // hard size cap (the capture flow should downscale before calling this;
      // an oversize photo is REFUSED explicitly, never silently truncated)
      if (base64.length > 5_600_000) { // ~4 MB decoded
        get().flash(CHT.tooLarge[get().lang]);
        return;
      }
      // ONE rule for every local thumbnail this function writes. Round 4 fixed the offline branch
      // to mirror onto the CAPTURED checklist wherever it lives and left the demo branch addressing
      // the edit slot, so round 5 found the same defect one branch over: a demo capture that
      // finished reading after a switch updated neither copy and still said "Photo attached", and
      // the engineer who switched back saw no evidence on a FAILED item they then could not submit.
      // Fixing the reported branch again would leave the next one, so the rule lives here once.
      //
      // Both copies are written on purpose. `ownerOfEditSlot` structuredClones the slot precisely so
      // it never shares an object with its `openChecklists` entry, so the captured checklist exists
      // as two independent copies and a write to one alone makes them disagree until the next apply.
      const mirrorCapture = (s: AppState): void => {
        const apply = (target: Checklist | undefined): void => {
          const it = target?.items[idx];
          if (!it) return;
          // Server-backed rows carry ids and are matched by them. A demo checklist's items may have
          // none, and there the index within the already-id-matched checklist IS the identity.
          if (item.id && it.id !== item.id) return;
          it.photos += 1;
          it.evidence = [...(it.evidence ?? []), dataUrl];
        };
        if (s.checklist?.id === c.id) apply(s.checklist);
        apply(s.openChecklists.find((o) => o.id === c.id));
      };
      // demo (no gateway): the counter + a local thumbnail are the whole story
      if (!gateway) {
        // Demo has no durable row, so these copies ARE the record — which is exactly why declining
        // to write loses the photo outright rather than merely delaying it.
        set(mirrorCapture);
        get().flash(CHT.attachedDemo[get().lang]);
        return;
      }
      if (!item.id) {
        get().flash(CHT.predates[get().lang]);
        return;
      }
      const clientKey = (globalThis.crypto?.randomUUID?.() ?? `ev-${Math.random().toString(36).slice(2)}`);
      const meta = { inspectionId: c.id, inspectionItemId: item.id };

      if (!get().online) {
        // OFFLINE: durability is part of the command result — "saved offline" is
        // shown ONLY after the IndexedDB write commits; a quota/write failure (or
        // no IndexedDB at all) surfaces as an explicit failure and queues NOTHING.
        if (!evidenceAvailable()) {
          get().flash(CHT.noStorage[get().lang]);
          return;
        }
        // gate round-3: the durable row belongs to the scope the user captured
        // it in — pin that scope BEFORE the write and never mutate another one
        const ctx = captureEvidenceContext();
        try {
          await putEvidence({ userScope: ctx.scope, projectId: ctx.projectId, clientKey, mime, data: base64, ...meta });
        } catch {
          if (evidenceContextStillCurrent(ctx)) get().flash(CHT.noSpace[get().lang]);
          return;
        }
        // gate round-4 finding 1: the context check comes FIRST — only a
        // completion still belonging to the ACTIVE context may invalidate that
        // context's in-flight reconciliation. A capture whose scope moved
        // mid-write returns untouched (its row's own scope reconstructs it);
        // bumping the shared epoch here would cancel the NEW scope's own
        // hydration and hide its pending/failed evidence.
        if (!evidenceContextStillCurrent(ctx)) return;
        // a NEW pending row exists in THIS scope — reconciliations already in
        // flight read a world without it and must not overwrite its mirrors
        invalidateEvidenceReconciles();
        set((s) => {
          s.outbox.push({ t: 'uploadEvidence', scope: ctx.scope, clientKey });
          s.syncQueue.push('Evidence photo');
          // The local thumbnail belongs to the checklist the photo was CAPTURED on, and the edit slot
          // can have moved during the IndexedDB write. `evidenceContextStillCurrent` guards the SCOPE
          // (project + generation), which a switch between two checklists of the same project does
          // not change — so addressing the slot lands one inspection's photo under another.
          //
          // DECLINING to write was not enough. Offline there is no refresh to correct it: the
          // engineer switches back and the captured checklist still reads `photos: 0` with no
          // evidence, so a FAILED item cannot be queued for submission until signal returns, even
          // though its durable row is already queued. So the mirror is applied to the CAPTURED
          // checklist wherever it lives — the slot when it is still there, and its own
          // `openChecklists` entry when the engineer has moved on. Both are the same inspection;
          // `overlayChecklistMarks` and `ownerOfEditSlot` reconcile them on the next apply.
          mirrorCapture(s);
          s.pendingEvidenceCount += 1;
        });
        // the bytes' row is the durable record (the act is rebuilt from it), so the line does not depend on the write
        const stillThere = madeHere();
        await persistOutbox();
        if (stillThere()) get().flash(CHT.savedOffline[get().lang]);
        return;
      }
      // ONLINE: upload now with the idempotency key; reconcile from the snapshot.
      // The engineer's UNSUBMITTED field marks are preserved across the refresh by
      // applySnapshot itself (gate round 6 — the ONE preservation path, keyed by
      // row id + scope generation), so this path just uploads and reconciles.
      const scope = currentScope();
      try {
        await gateway.uploadMedia({ kind: 'inspection', mime, data: base64, clientKey, ...meta });
        if (!scopeStillCurrent(scope)) return;
        // gate round 11: capture the snapshot lease BEFORE the refetch, then route
        // through the coordinator — a newer socket refresh / submit that began
        // meanwhile supersedes this reconcile, and the success toast fires only when
        // the snapshot is actually `applied` (never on a superseded / wrong-project one).
        const lease = beginSnapshotLease(scope);
        const snap = await gateway.snapshot();
        consumeSnapshotResult(acceptSnapshot(snap, lease), CHT.uploaded[get().lang], lease.scope);
      } catch {
        // the failure belongs to the scope the capture was made in — a moved
        // scope (gate round-4 finding 3) hears nothing
        if (scopeStillCurrent(scope)) get().flash(CHT.uploadFailed[get().lang]);
      }
    },
    retryFailedEvidence: async (clientKey) => {
      invalidateEvidenceReconciles(); // the row is about to change state under any in-flight read
      const ctx = captureEvidenceContext(); // the row being revived belongs to THIS scope
      const revived = await retryEvidence(ctx.scope, ctx.projectId, clientKey).catch(() => null);
      if (!revived) return;
      // gate round-3: moved mid-revive — the now-pending row reconstructs in its own scope
      if (!evidenceContextStillCurrent(ctx)) return;
      set((s) => {
        s.failedEvidence = s.failedEvidence.filter((f) => f.clientKey !== clientKey);
        s.outbox.push({ t: 'uploadEvidence', scope: ctx.scope, clientKey }); // SAME key — the server dedupes
        s.syncQueue.push('Evidence photo (retry)');
        s.pendingEvidenceCount += 1;
      });
      await persistOutbox();
      if (evidenceContextStillCurrent(ctx) && get().online) void get().flushOutbox();
    },
    deleteFailedEvidence: async (clientKey) => {
      invalidateEvidenceReconciles(); // the row is about to vanish under any in-flight read
      const ctx = captureEvidenceContext();
      // the user's explicit decision — the only non-server path that drops bytes
      try {
        await deleteEvidence(ctx.scope, ctx.projectId, clientKey);
      } catch {
        // gate round-4 finding 2: the deletion did NOT happen — the bytes are
        // still on the device, so the Retry/Delete surface must stay and the
        // UI must never claim success. Surface the failure only to the scope
        // the user acted in; a moved scope hears nothing.
        if (!evidenceContextStillCurrent(ctx)) return;
        get().flash(CHT.deleteFailed[get().lang]);
        return;
      }
      // gate round-3: the delete honored the user's decision in ITS scope; a
      // switch that landed mid-await leaves the NEW scope's UI untouched
      if (!evidenceContextStillCurrent(ctx)) return;
      set((s) => { s.failedEvidence = s.failedEvidence.filter((f) => f.clientKey !== clientKey); });
      get().flash(CHT.deleted[get().lang]);
    },
    hydrateEvidence: async () => reconcileEvidence(),
    setNote: (idx, txt) => set((s) => { const c = s.checklist; const it = c?.items[idx]; if (c && it) { if (checklistFrozen(s)) return; it.note = txt; recordChecklistMark(s, c.id, it.id, 'note', txt); } }),
    submitInspection: () => {
      const c = get().checklist;
      if (!c || !c.items.length) {
        get().flash(CHT.noneIssued[get().lang]);
        return;
      }
      // gate round 8: once the payload is frozen (submitting / queued / already
      // server-submitted) a repeat submit is a no-op — no double submission, and
      // no edit can slip in between the click and the outcome.
      if (checklistFrozen(get())) {
        get().flash(CHT.alreadySubmitted[get().lang]);
        return;
      }
      const undone = c.items.filter((it) => !it.state).length;
      // a fail needs EVIDENCE: a linked photo (the server's proof, Task 4) or the
      // legacy counter (demo). The deprecated counter alone must not block a fail
      // whose photo is a real linked Media row (Task 7 acceptance finding).
      const failNoPhoto = c.items.filter((it) => it.state === 'fail' && it.photos === 0 && (it.evidence?.length ?? 0) === 0).length;
      if (undone > 0) {
        get().flash(CHX.markAll(c.items.length, get().lang));
        return;
      }
      if (failNoPhoto > 0) {
        get().flash(CHT.failNeedsPhoto[get().lang]);
        return;
      }
      if (gateway) {
        if (get().online) {
          // gate round 8: FREEZE the checklist the instant we dispatch — no edit may
          // change the payload while the submit is in flight (the round-7 finding:
          // an edit made during the pending window was silently reverted when the
          // ack arrived). On success the server's submitted checklist lands and
          // applySnapshot drops the marks (gate round 7). On FAILURE we UNLOCK the
          // checklist WITHOUT losing the marks so the engineer can fix and resubmit.
          // gate round 10: stamp this dispatch with a unique attempt id. The
          // (project, generation) scope guard (round 9) cannot separate two submits
          // WITHIN one session — a socket-delivered checklist swap can retire this
          // submit and start another under the SAME generation. `attempt` makes each
          // dispatch identifiable; `isThisAttempt()` is true only while THIS dispatch
          // still owns the submission (no newer submit, and no reconcile has retired it).
          const attempt = ++submitAttemptSeq;
          set((s) => { s.submission = { inspectionId: c.id, generation: s.projectScopeGeneration, status: 'submitting', attempt }; });
          const scope = currentScope();
          // gate round 11: the submit needs BOTH guards — the attempt id owns the
          // COMMAND lifecycle (round 10), and a snapshot lease captured at dispatch
          // owns snapshot FRESHNESS (so a newer socket refresh / submit that began
          // while this was in flight supersedes this response even in the same scope).
          const lease = beginSnapshotLease(scope);
          const isThisAttempt = (): boolean => scopeStillCurrent(scope) && get().submission.attempt === attempt;
          gateway
            .submitInspection(c.id, c.items)
            .then((snap) => {
              if (!isThisAttempt()) return; // a newer submit/socket/session retired this command
              const result = acceptSnapshot(snap, lease);
              if (result === 'applied') {
                emitGuideOutcome('inspection-submitted', c.id);
                get().flash(CHT.submitted[get().lang]);
                // Live bug 1b — the same rule as `consumeSnapshotResult`: an APPLIED snapshot carries no
                // module slice, so under module ownership the submit still owes the read that shows it
                // (the submitted checklist leaving the outstanding set; the slice is owed until it lands)
                if (anyModuleOwnedRead()) scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq, modulesOnly: true });
              } else if (result === 'superseded') {
                // gate round 12/13: the submit committed, but a newer refresh owns the
                // view. Keep the checklist FROZEN (don't unlock — the submit succeeded)
                // and record a SUBMIT reconcile requirement naming THIS attempt, so the
                // requirement clears only when this exact submit is confirmed by server
                // truth (not by a stale unsubmitted snapshot); if the mandatory reconcile
                // fails or lands still-unconfirmed, a recoverable error/Retry is exposed
                // instead of freezing forever.
                emitGuideOutcome('inspection-submitted', c.id);
                scheduleReconcile(scope, { kind: 'submit', inspectionId: c.id, attempt, createdAfterSequence: snapshotSeq });
              } else if (result === 'invalid-project') {
                // manifestation 2: a rejected (wrong-project) payload must NOT report
                // success and must NOT leave the checklist frozen forever — unlock the
                // attempt and pull a fresh snapshot to recover current truth.
                set((s) => { if (s.submission.attempt === attempt && s.submission.status === 'submitting') s.submission.status = 'idle'; });
                emitGuideOutcome('inspection-submit-failed', c.id);
                void requestFreshSnapshot();
              }
              // scope-moved: silent — the new scope owns its own truth.
            })
            .catch(() => {
              // A retired attempt (round 9/10) or a superseded session must not unlock
              // the live submit or toast — a socket refresh may already have confirmed.
              if (!isThisAttempt()) return;
              set((s) => {
                if (s.submission.attempt === attempt && s.submission.status === 'submitting') {
                  s.submission.status = 'idle';
                }
              });
              emitGuideOutcome('inspection-submit-failed', c.id);
              get().flash(CHT.submitFailed[get().lang]);
            });
          return;
        }
        // offline: QUEUE the submit (persisted) and freeze as 'queued'. The freeze
        // survives a reload because reconcileSubmission rebuilds it from the outbox.
        const submit: OutboxOp = { t: 'submitInspection', inspectionId: c.id, items: c.items };
        set((s) => {
          s.outbox.push(submit);
          s.syncQueue.push('Submit inspection');
          s.submission = { inspectionId: c.id, generation: s.projectScopeGeneration, status: 'queued', attempt: 0 };
        });
        emitGuideOutcome('inspection-submitted', c.id);
        flashSaved(CHT.savedOfflineSubmit[get().lang], [submit]); // said only once the locked write holds it (Codex 4344812898)
        return;
      }
      // demo (no gateway): the submit succeeds locally and synchronously — the
      // marks are now recorded on the (local) submitted checklist, so drop them.
      set((s) => {
        if (!s.checklist) return;
        s.checklist.submitted = true;
        s.submission = { inspectionId: null, generation: s.projectScopeGeneration, status: 'idle', attempt: 0 };
        delete s.checklistMarks.byInspection[s.checklist.id];
        // THE REVIEW IS BUILT FIRST, from the checklist that was actually submitted. The advance below
        // replaces `s.checklist` with the next OPEN one, so reading the slot afterwards filed the
        // still-unsubmitted checklist into the PMC's queue — with PASS/FAIL results derived from marks
        // nobody had made — and lost the submitted one entirely. `current` first: `s.checklist` is an
        // immer draft, and the advance mutates the slot out from under any reference kept into it.
        const submitted = structuredClone(current(s.checklist)) as Checklist;
        // demo (no API): the submitted checklist enters the PMC review queue,
        // mapping each item's pass/fail state to a PASS/FAIL result.
        if (!s.reviews.some((r) => r.id === submitted.id)) {
          s.reviews.push({
            id: submitted.id,
            title: submitted.title,
            ...(submitted.reinspectionOfId ? { reinspectionOfId: submitted.reinspectionOfId } : {}),
            zone: submitted.zone,
            // the review inherits the checklist's FILED location, not just its legacy zone
            // text: a checklist raised against a room is reviewed at that room, and dropping
            // `nodeId` here would leave every demo-path review reading as unplaced.
            ...(submitted.nodeId ? { nodeId: submitted.nodeId } : {}),
            by: 'Site Engineer',
            date: submitted.date,
            decided: false,
            items: submitted.items.map((it) => ({
              name: it.name,
              result: it.state === 'fail' ? 'FAIL' : 'PASS',
              swatch: 'concrete',
              note: it.note,
              rejected: false,
            })),
          });
        }
        // a submitted checklist is no longer outstanding: drop it from the open set so the demo path
        // agrees with what the server would serve. The edit slot must MOVE with it — leaving the
        // submitted checklist in the slot drops the open count to one, which hides the picker and
        // makes the checklist still out on site unreachable. The server path has no such problem: its
        // next snapshot re-picks the slot from the open set.
        s.openChecklists = s.openChecklists.filter((c) => c.id !== submitted.id);
        if (s.selectedChecklistId === submitted.id) s.selectedChecklistId = null;
        const next = s.openChecklists[0];
        // `current` first: `next` is an immer draft, and a draft proxy is not a cloneable source
        if (next) { s.checklist = structuredClone(current(next)) as Checklist; s.selectedChecklistId = next.id; }
      });
      emitGuideOutcome('inspection-submitted', c.id);
      get().flash(CHT.submitted[get().lang]);
    },

    // ---- pmc review (queue) ----
    setActiveReview: (id) => set((s) => { s.activeReviewId = id; }),
    toggleReject: (idx) =>
      set((s) => {
        const i = activeReviewIdx();
        if (i < 0) return;
        s.reviews[i].items[idx].rejected = !s.reviews[i].items[idx].rejected;
      }),
    approveInspection: () => {
      // #482: how the decision went, for the review guide, under the run it was made in
      const i = activeReviewIdx();
      const reportDecide = reviewDecideReport(i < 0 ? null : get().reviews[i]!.id);
      if (i < 0) { reportDecide('failed'); return; }
      const review = get().reviews[i];
      // Task 5: approving a CLOSING review is the sign-off that completes its activity
      // #482 V-1018-2 — what the decision says back, in the viewer's language when it is said (names and ids are
      // data): an online decision's toast reads the language at settlement (Codex 4307111788)
      const lang = get().lang;
      const approvedMsg = (l: Lang): string => (review.closing ? IRT.signedOffToast(review.activityName ?? inspectionTitle(review, l), l) : IRT.approvedToast(review.id, l));
      const msg = approvedMsg(lang);
      // Task 10 (Module 3) correction — one stable idempotency key for this decision: the online send
      // and any offline replay reach the server under it, so a lost-response retry decides once.
      const approveReviewKey = newIdempotencyKey();
      const decidedBy = get().sessionUserId;
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: true, rejectedItemIds: [], idempotencyKey: approveReviewKey }, IRL.approveQueued.en, sendingDecision(() => gateway!.decideReview(review.id, true, [], approveReviewKey).then((snap) => { refreshBriefAfterReview(decidedBy); return snap; })), () => approvedMsg(get().lang), DLX.savedOffline(IRL.approveQueued[lang], lang), reportDecide)) return;
      set((s) => {
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) {
          s.reviews[j].decided = true;
          // #482 F-C4.4 (Codex 4306414397) — approval records no rejection (the server's decide sends none), so an
          // item marked "Reject item" before Approve is not shown as sent back
          for (const it of s.reviews[j].items) it.rejected = false;
        }
        if (review.closing && review.activityId) {
          const a = s.activities.find((x) => x.id === review.activityId);
          if (a) a.status = 'done'; // the PMC's acceptance IS the completion
        }
        s.activeReviewId = review.id; // keep the just-decided review on screen (REVIEWED)
      });
      get().flash(msg);
      reportDecide('sent');
    },
    sendReinspection: () => {
      const i = activeReviewIdx();
      const reportDecide = reviewDecideReport(i < 0 ? null : get().reviews[i]!.id);
      if (i < 0) { reportDecide('failed'); return; }
      const review = get().reviews[i];
      const n = review.items.filter((it) => it.rejected || it.result === 'FAIL').length;
      const lang = get().lang;
      // nothing marked to send back: refused here, and told, so the guide does not wait on it
      if (n === 0) {
        get().flash(IRL.noneRejected[lang]);
        reportDecide('failed');
        return;
      }
      // gate finding 3: rejection names exact ROWS by server id (labels are not unique)
      const rejectedIds = review.items.filter((it) => it.rejected && it.id).map((it) => it.id!);
      // Task 10 (Module 3) correction — the rejection decision carries its own stable idempotency key.
      const rejectReviewKey = newIdempotencyKey();
      const decidedBy = get().sessionUserId;
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: false, rejectedItemIds: rejectedIds, idempotencyKey: rejectReviewKey }, IRL.sendBackQueued.en, sendingDecision(() => gateway!.decideReview(review.id, false, rejectedIds, rejectReviewKey).then((snap) => { refreshBriefAfterReview(decidedBy); return snap; })), () => IRT.reinspectionsToast(n, get().lang), DLX.savedOffline(IRL.sendBackQueued[lang], lang), reportDecide)) return;
      set((s) => {
        s.reinspectionCreated = true;
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) Object.assign(s.reviews[j], { decided: true, reinspectionSent: true });
        if (review.closing && review.activityId) {
          // Task 5: rejecting the closing sign-off returns the activity to execution
          const a = s.activities.find((x) => x.id === review.activityId);
          if (a) a.status = 'in-progress';
        }
        s.activeReviewId = review.id;
      });
      get().flash(IRT.reinspectionsToast(n, lang));
      reportDecide('sent');
    },

    // ---- drawings register ----
    issueDrawing: (input) => {
      // #482 — a publish's outcome for the drawing guide, under the run it is made in (a draft saved is not one)
      const guideRun = guideRunToken();
      // a revision already in the register under this number and label is not this publish's (the server refuses a label
      // used before): the guide is never finished by seeing it
      const labelTaken = get().drawings.some((d) => d.number === input.number && d.revisions.some((r) => r.rev === input.rev));
      if (input.publish && !labelTaken) recordGuidedDrawing(guideRun, input.number, input.rev);
      const reportPublish = (ok: boolean) => { if (input.publish) emitGuideOutcome(ok ? 'drawing-published' : 'drawing-publish-failed', null, guideRun); };
      if (gateway) {
        // Task 10 correction (C3) — never issue against a register whose module read hasn't settled.
        if (drawingMutationsBlocked(get())) { get().flash(DWT.stillLoading[get().lang]); reportPublish(false); return; }
        const gw = gateway;
        // gate round 12: capture the scope BEFORE the request and guard EVERY continuation on it.
        const scope = currentScope();
        // Task 10 correction (C1/C2) — a stable key + a payload PREPARED ONCE. The command-ledger records
        // the issue EXACTLY ONCE under this key; a bounded retry re-POSTs the SAME prepared body under the
        // SAME key, so a committed-but-unacked response replays the one success (no duplicate revision).
        const key = newIdempotencyKey();
        void (async () => {
          let prepared;
          try {
            // PHASE 1 (once): compute the content digest + (large file) upload the bytes to the bucket. A
            // retry NEVER re-runs this — it would re-presign a new storageKey / re-upload the bytes.
            prepared = await gw.prepareIssue(input);
          } catch {
            if (scopeStillCurrent(scope)) { get().flash(DWT.prepareFailed[get().lang]); reportPublish(false); }
            return;
          }
          // PHASE 2 (bounded same-key retry): the register-write. A transient failure (network / 5xx /
          // timeout) is retried under the SAME key + SAME prepared body; a business-rule 4xx is terminal.
          let committed = false;
          for (let attempt = 0; attempt < 2 && !committed; attempt++) {
            if (!scopeStillCurrent(scope)) return; // a switch mid-retry — B is not ours to touch
            try {
              await gw.submitIssue(prepared, key);
              committed = true;
            } catch (err) {
              if (isTerminalOutboxError(err)) {
                if (scopeStillCurrent(scope)) { get().flash(DWT.rejected[get().lang]); reportPublish(false); }
                return;
              }
              // transient — keep the SAME key + prepared body and retry
            }
          }
          if (!scopeStillCurrent(scope)) return;
          if (committed) {
            get().flash(DWX.issued(input.number, input.rev, get().lang));
            reportPublish(true);
            requestFreshSnapshot(scope); // one coalesced, coordinator-ordered refresh for THIS scope
            return;
          }
          // STILL uncertain after the bounded retry — the command MAY have committed under our key. RECONCILE
          // from fresh state BEFORE any failure message (never a premature "please try again"): the ledger
          // dedupes, so if it landed the register now shows the ONE revision; if it truly never committed it
          // simply isn't there and the user can re-issue. No false-failure toast either way.
          // #482 — the drawing guide is told not published once a refresh that began after this has settled (a pull already
          // on its way may predate the publish): a revision it brings finishes the guide all the same (its `settled` is
          // looked at on a failure report), and otherwise it goes back to Issue drawing
          void afterFreshPull(scope).then(() => { if (scopeStillCurrent(scope)) reportPublish(false); });
        })();
        return;
      }
      // local demo: add to the register (or add a rev + supersede the prior)
      set((s) => {
        const newRev = {
          id: `${input.number}-${input.rev}`,
          rev: input.rev,
          status: input.status ?? 'for_construction',
          mime: input.mime,
          url: `data:${input.mime};base64,${input.data}`,
          sizeBytes: Math.floor((input.data.length * 3) / 4),
          note: input.note ?? '',
          issuedBy: 'You (demo)',
          issuedAt: 'just now',
          acks: [],
        };
        const existing = s.drawings.find((d) => d.number === input.number);
        if (existing) {
          existing.revisions.forEach((r) => { if (r.status !== 'superseded') r.status = 'superseded'; });
          existing.revisions.unshift(newRev);
          existing.current = newRev;
          existing.title = input.title;
          existing.discipline = input.discipline;
          existing.nodeId = input.nodeId ?? existing.nodeId;
          existing.ackedByMe = false; // a fresh rev needs re-acknowledgement
          if (input.publish) existing.draft = false;
        } else {
          s.drawings.unshift({
            id: `DWG-${s.drawings.length + 1}`,
            number: input.number,
            title: input.title,
            discipline: input.discipline,
            zone: input.zone ?? null,
            activityId: input.activityId ?? null,
            decisionId: input.decisionId ?? null,
            nodeId: input.nodeId,
            draft: !input.publish, // a new drawing is a private draft unless issued now
            ackedByMe: false,
            current: newRev,
            revisions: [newRev],
          });
        }
      });
      get().flash(
        input.publish
          ? DWX.issuedDemo(input.number, input.rev, get().lang)
          : DWX.draftSavedDemo(input.number, get().lang),
      );
      reportPublish(true);
    },
    publishDrawing: (drawingId) => {
      const d = get().drawings.find((x) => x.id === drawingId);
      if (!d) return;
      // API mode: the server flips publishedAt, notifies the build team, returns a snapshot.
      if (gateway) {
        // Task 10 correction (C3) — don't publish against a register whose module read hasn't settled.
        if (drawingMutationsBlocked(get())) { get().flash(DWT.stillLoading[get().lang]); return; }
        // Task 10 correction (C2) — WRITE-AHEAD: persist the publish op + stable key BEFORE the network
        // call, so a lost/uncertain response replays the SAME op under the SAME key (published exactly
        // once) and the reconcile snapshot restores truth.
        const key = newIdempotencyKey();
        runWriteAhead(
          { t: 'publishDrawing', drawingId, idempotencyKey: key },
          'Publish ' + d.number,
          `Published: ${d.number} — the build team has been notified.`,
        );
        return;
      }
      // Demo (no server): flip the draft live locally + raise the build-team notification.
      set((s) => {
        const row = s.drawings.find((x) => x.id === drawingId);
        if (!row || !row.draft) return;
        row.draft = false;
        s.notifications.unshift({ text: `Drawing issued: ${row.number} — ${row.title}`, time: 'just now', color: '#C08A2D' });
      });
      get().flash(`Published: ${d.number} — the build team has been notified.`);
    },
    publishAllDrafts: () => {
      const decIds = get().decisions.filter((d) => d.draft).map((d) => d.id);
      const dwgIds = get().drawings.filter((d) => d.draft).map((d) => d.id);
      const total = decIds.length + dwgIds.length;
      if (total === 0) return;
      const doneMsg = `Published ${total} draft${total === 1 ? '' : 's'} — the team has been notified.`;
      const done = () => get().flash(doneMsg);
      // API mode: decisions publish directly (preserved); DRAWINGS are write-ahead + drained by the flush.
      if (gateway) {
        // Task 10 correction (C3) — when drawing drafts are in the batch, don't publish from a register
        // whose module read hasn't settled (we'd be publishing stale/absent drawing data).
        if (dwgIds.length > 0 && drawingMutationsBlocked(get())) { get().flash('The drawing register is still loading — publish drafts once it settles.'); return; }
        const gw = gateway;
        const scope = currentScope();
        // Task 10 correction (C2b) — the DRAWING publishes are WRITE-AHEAD to the durable outbox with a
        // stable key EACH, persisted BEFORE any network request, then drained by the SAME flush/reconcile
        // machinery every other write-ahead command uses (`runWriteAhead`). The flush is triggered HERE,
        // synchronously in THIS scope: it pins its (project, generation) + gateway before any await, so a
        // project switch mid-flight leaves these ops queued for THIS project and never crosses scopes nor
        // supersedes another scope's live pull. A lost response / reload / replay reuses each op's ORIGINAL
        // key and publishes exactly once — never a direct `gw.publishDrawing` with a freshly-minted key.
        // Precompute each drawing publish op's STABLE key so completion is judged by classifying EXACTLY
        // the ops THIS call created — never "any publishDrawing op left in the queue". Queue absence alone
        // can't tell a published draft from a terminally-rejected 4xx (the flush removes both), so success
        // is confirmed only when every targeted key is reported succeeded by the flush.
        const drawingKeys = dwgIds.map(() => newIdempotencyKey());
        let flushDone: Promise<OutboxFlushResult | undefined> = Promise.resolve(undefined);
        let decisionsOut = decIds.length > 0;
        if (dwgIds.length > 0) {
          set((s) => {
            dwgIds.forEach((id, i) => {
              const number = s.drawings.find((x) => x.id === id)?.number ?? id;
              s.outbox.push({ t: 'publishDrawing', drawingId: id, idempotencyKey: drawingKeys[i] });
              if (!s.online) s.syncQueue.push('Publish ' + number);
            });
          });
          // no flush sends these while their locked write is still running (`aheadWrites`)
          void writeAhead(get().outbox.filter((o) => o.t === 'publishDrawing' && drawingKeys.includes((o as { idempotencyKey?: string }).idempotencyKey ?? '')));
          // the flush's word waits for the publish's only while no decision publish is still out (#1134 residual, gap-check Q4)
          if (get().online) flushDone = get().flushOutbox({ ownWord: drawingKeys, saysNow: () => !decisionsOut });
        }
        void (async () => {
          // Decisions: the existing direct publish + reconcile (behavior preserved). Drawings are handled
          // entirely by the write-ahead flush above; the flush reconciles the register on its own.
          let decOk = true;
          if (decIds.length > 0) {
            try {
              for (const id of decIds) await gw.publishDecision(id, newIdempotencyKey());
              const lease = beginSnapshotLease(scope);
              const result = acceptSnapshot(await gw.snapshot(), lease);
              // Codex 4206188320 — the same rule as `consumeSnapshotResult`: an APPLIED snapshot carries
              // no module slice, so under module ownership the publish still owes its reconcile (and
              // the decision slice is not settled until it lands)
              if (result === 'superseded' || (result === 'applied' && anyModuleOwnedRead())) {
                scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq, modulesOnly: result === 'applied' });
              } else if (result === 'invalid-project') void requestFreshSnapshot();
            } catch {
              decOk = false;
            }
            decisionsOut = false;
          }
          // Let the drawing flush finish draining before judging success.
          const flushRes = await flushDone.catch(() => undefined);
          if (!scopeStillCurrent(scope)) return;
          // Classify ONLY the drawing ops THIS call created, by their keys:
          //  • dropped  — the flush terminally REJECTED it (a 4xx); the drawing stays a draft.
          //  • pending  — still sitting in the durable queue (offline, transient stop, coalesced flush).
          //  • succeeded — replayed OK (neither dropped nor still queued).
          const targeted = new Set(drawingKeys);
          const droppedMine = flushRes ? flushRes.droppedKeys.filter((k) => targeted.has(k)) : [];
          const dwgPending = get().outbox.some((o) => o.t === 'publishDrawing' && targeted.has(o.idempotencyKey));
          // the flush that sent these said nothing itself: its word (other commands' lines, its counts) follows the
          // publish's own in one flash, so neither replaces the other (#1134 residual)
          const say = (msg: string) => get().flash(flushRes?.word ? `${msg} ${flushRes.word}` : msg);
          if (droppedMine.length > 0) {
            // A terminal rejection is NEVER overwritten by "Published N": report the honest (partial) failure.
            const n = droppedMine.length;
            say(n === dwgIds.length
              ? `${n === 1 ? 'The drawing draft was' : `All ${n} drawing drafts were`} rejected and not published — please review and try again.`
              : `${n} drawing draft${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} rejected and not published — the rest went through. Please review and retry.`);
          } else if (!decOk) {
            say('Could not publish every draft — some may still be drafts. Please try again.');
          } else if (dwgPending) {
            // NEVER claim complete success while a targeted drawing op is still queued (offline, transient).
            say(get().online
              ? 'Publishing… drawing drafts are still syncing and will finish shortly.'
              : 'Saved — drawing drafts will publish when you reconnect.');
          } else {
            // decisions OK AND every targeted drawing op confirmed succeeded (or there were no drawings).
            say(doneMsg);
          }
        })();
        return;
      }
      // Demo (no server): flip them all live in one pass + raise each item's notification.
      set((s) => {
        for (const row of s.decisions) {
          if (row.draft && decIds.includes(row.id)) {
            row.draft = false;
            s.notifications.unshift({ text: `Decision awaiting approval: ${row.title}`, time: 'just now', color: '#C08A2D', decisionId: row.id });
          }
        }
        for (const row of s.drawings) {
          if (row.draft && dwgIds.includes(row.id)) {
            row.draft = false;
            s.notifications.unshift({ text: `Drawing issued: ${row.number} — ${row.title}`, time: 'just now', color: '#C08A2D' });
          }
        }
      });
      done();
    },
    acknowledgeDrawing: (drawingId) => {
      const drawing = get().drawings.find((d) => d.id === drawingId);
      if (!drawing?.current || drawing.ackedByMe) return;
      const rev = drawing.current;
      if (gateway) {
        // Task 10 correction (C3) — don't acknowledge against a register whose module read hasn't settled.
        if (drawingMutationsBlocked(get())) { get().flash(DWT.stillLoading[get().lang]); return; }
        // Phase 2 Task 10 (Module 2 — Drawings; finding-1 write-ahead discipline): persist the ack
        // op + its stable idempotency key to the durable outbox BEFORE any network request (online
        // too), then flush. A lost/uncertain online response leaves the op (and its key) persisted,
        // so a retry or a reload replays the SAME op under the SAME key and the command-ledger
        // records the acknowledgement EXACTLY ONCE (actor-scoped). Mark `ackedByMe` optimistically
        // so the field reflects the intent immediately; the reconcile snapshot (the ack replay
        // refetches it) restores the truthful register. The success toast fires via the reconcile.
        const ackKey = newIdempotencyKey();
        set((s) => { const d = s.drawings.find((x) => x.id === drawingId); if (d) d.ackedByMe = true; });
        runWriteAhead(
          { t: 'ackDrawing', revisionId: rev.id, idempotencyKey: ackKey },
          'Acknowledge ' + drawing.number,
          () => DWX.acknowledged(drawing.number, rev.rev, false, get().lang),
          DLX.savedOffline(DWX.ackCommand(drawing.number, get().lang), get().lang),
        );
        return;
      }
      // local demo: mark building-to on the current rev
      const label = get().userName ?? { pmc: 'Project manager (PMC)', client: 'Client', engineer: 'Site Engineer', contractor: 'Contractor', consultant: 'Consultant', architect: 'Architect' }[get().role] ?? 'You';
      set((s) => {
        const d = s.drawings.find((x) => x.id === drawingId);
        if (!d?.current) return;
        d.ackedByMe = true;
        const ack = { userName: label, role: s.role, at: 'just now' };
        d.current.acks.push(ack);
        const inHistory = d.revisions.find((r) => r.id === d.current!.id);
        if (inHistory) inHistory.acks.push(ack);
      });
      get().flash(DWX.acknowledged(drawing.number, rev.rev, true, get().lang));
    },
    fileDrawing: (drawingId, nodeId) => {
      if (gateway) {
        // Task 10 correction (C3) — don't re-file/unfile against a register whose module read hasn't settled.
        if (drawingMutationsBlocked(get())) { get().flash(DWT.stillLoading[get().lang]); return; }
        // Task 10 correction (C2) — WRITE-AHEAD: persist the re-file op + stable key BEFORE the network
        // call, so a lost/uncertain response replays the SAME op under the SAME key (applied exactly once).
        const key = newIdempotencyKey();
        runWriteAhead(
          { t: 'setDrawingNode', drawingId, nodeId, idempotencyKey: key },
          nodeId ? 'File drawing' : 'Unfile drawing',
          () => (nodeId ? DWT.filed : DWT.unfiled)[get().lang],
          DLX.savedOffline((nodeId ? DWT.fileCommand : DWT.unfileCommand)[get().lang], get().lang),
        );
        return;
      }
      set((s) => {
        const d = s.drawings.find((x) => x.id === drawingId);
        if (d) d.nodeId = nodeId ?? undefined;
      });
      get().flash((nodeId ? DWT.filedDemo : DWT.unfiledDemo)[get().lang]);
    },
    deleteSitePhoto: (photoId) => {
      const lang = (): Lang => get().lang;
      if (gateway) {
        // one delete per photo at a time: a second tap never races the first into a "not found" (Codex 4317884827)
        const pending = sitePhotoDeletes.get(photoId);
        if (pending) return pending;
        // a delete does not come back, so it is never queued: with no signal the member is told to connect
        if (!get().online) {
          get().flash(SPL.deleteOffline[lang()]);
          return Promise.resolve();
        }
        // its upload is still queued on this device (its reply was lost, or it has not gone yet): a send of that upload
        // after the delete would add the photo again, and one may already be on its way, so the photo is deleted only
        // once the upload has landed and left the queue (Codex 4322142028, 4318519735)
        // An evidence photo's bytes may also still be pending in IndexedDB, back in the outbox only once they are read
        const photo = get().photos.find((p) => p.id === photoId) ?? get().myDeletablePhotos.find((p) => p.id === photoId);
        if (photo && deleteWaitsForUpload(photo, get().outbox, get().pendingEvidenceKeys, get().photoUploadsSending)) {
          get().flash(SPL.stillUploading[lang()]);
          return Promise.resolve();
        }
        const scope = currentScope();
        // a snapshot asked for before the delete is superseded by it, as for every command, so one still on its way
        // can never bring the photo back; only a pull that began after the delete is applied (Codex 4318519722)
        beginSnapshotLease(scope);
        // the photo is gone on the server. `onLog`: whether it was counted on the log on screen, when the answer says
        const settleDeleted = (onLog: (s: AppState) => boolean) => {
          // a pull begun while the DELETE was on its way may have read the photo before it went: every pull begun
          // before this answer is superseded here, whether it is still waiting or already back (Codex 4322459274)
          beginSnapshotLease(scope);
          // the server's yes is the delete: the photo leaves at once, and a fresh snapshot then settles the counts.
          // A failed refresh never turns a done delete into a "try again" (Codex 4316959524).
          set((s) => {
            // filed on the log on screen: its count is the server's to say again, read after this answer; until then
            // none is shown rather than one that may still hold the photo (Codex 4322142057)
            if (onLog(s)) s.dailyLogPhotoCountAfter = snapshotSeq;
            // nor is it kept as evidence on a checklist or review still held here (Codex 4322142035)
            dropDeletedPhoto(s, photoId);
          });
          get().flash(SPL.deleted[lang()]);
          // the reconcile every command owes: only a pull begun after this answer settles it, and one that fails
          // leaves it owed, with Retry, while the photo stays gone
          scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq });
        };
        const done = gateway
          .deleteMedia(photoId)
          .then((res) => {
            if (!scopeStillCurrent(scope)) return;
            // the server says which log counted it (`null`: none). An answer that does not say (an earlier release's
            // `{ ok: true }`) is read as the 404's is: the on-screen log's count is read again (Codex 4340876895)
            settleDeleted((s) => (res.dailyLogId === undefined ? s.dailyLog !== null : !!res.dailyLogId && s.dailyLog?.id === res.dailyLogId));
          })
          .catch((err: unknown) => {
            if (!scopeStillCurrent(scope)) return;
            // the server's own "not found" (by its text, never a route's or a proxy's 404): the photo is already gone. An earlier delete whose answer was lost (#991) took it, or someone
            // else did, and either way it is deleted, so a retry after an unknown answer settles here and never shows a
            // refusal. Which log counted it is not said, and the log's gallery holds only the project's newest 12, so its
            // absence there says nothing: the on-screen log's count is read again whenever a log is on screen (Codex 4337661426).
            if (isMediaNotFound(err)) {
              settleDeleted((s) => s.dailyLog !== null);
              return;
            }
            get().flash(isTerminalOutboxError(err) ? SRV.refused(refusalMessage(err) ?? 'the server refused it', lang()) : DTX.unreachable[lang()]);
            // the pull the delete superseded is asked for again, so nothing it carried is lost
            void requestFreshSnapshot(scope);
          })
          .finally(() => { sitePhotoDeletes.delete(photoId); });
        sitePhotoDeletes.set(photoId, done);
        return done;
      }
      set((s) => {
        s.photos = s.photos.filter((p) => p.id !== photoId);
        s.myDeletablePhotos = s.myDeletablePhotos.filter((p) => p.id !== photoId);
      });
      get().flash(SPL.deleted[lang()]);
      return Promise.resolve();
    },
    filePhoto: (photoId, nodeId) => {
      if (gateway) {
        runRemote(() => gateway!.setMediaNode(photoId, nodeId), nodeId ? 'Photo filed to location.' : 'Photo unfiled.');
        return;
      }
      set((s) => {
        const p = s.photos.find((x) => x.id === photoId);
        if (p) p.nodeId = nodeId ?? undefined;
      });
      get().flash(nodeId ? 'Photo filed to location (demo).' : 'Photo unfiled (demo).');
    },

    // ---- multi-project + team (Orgs Slice 2) ----
    loadOrgData: () => {
      if (!gateway) return;
      // session-scoped (not project-scoped): ignore replies after sign-out / re-auth
      const tok = get().sessionToken;
      gateway.listMemberships().then((ms) => {
        set((s) => { if (s.sessionToken === tok) s.memberships = ms; });
        // #948 Codex 4300725705 / 4300786709 — a restored session opened on a link to ANOTHER project switches
        // there only once its memberships confirm the person belongs to it; a stale, mistyped or foreign link
        // is dropped, and the session stays on its own project, which is already loading
        const target = restoreSwitchTarget;
        if (target && tok !== null && tok === restoredToken && get().sessionToken === tok) {
          restoreSwitchTarget = null;
          if (ms.some((m) => m.projectId === target.projectId)) void get().switchProject(target.projectId, target.screen);
        }
      }).catch(() => {});
      gateway.myOrgs().then((os) => set((s) => { if (s.sessionToken === tok) s.myOrgs = os; })).catch(() => {});
    },
    loadPortfolio: () => {
      if (!gateway) return;
      const tok = get().sessionToken; // session-scoped: drop replies after sign-out / re-auth
      gateway.getPortfolio().then((p) => set((s) => { if (s.sessionToken === tok) s.portfolio = p; })).catch(() => {});
    },
    loadBrief: () => {
      if (!gateway) return;
      const tok = get().sessionToken; // session-scoped: drop replies after sign-out / re-auth
      // only the NEWEST request's reply is kept, and it is stamped with when it was ASKED (the server's
      // answer is as of then): an older reply landing late can neither bring back a project the newer
      // one dropped nor restart the freshness window
      const seq = ++briefRequestSeq;
      const askedAt = Date.now();
      gateway
        .getBrief()
        .then((b) => set((s) => {
          if (s.sessionToken !== tok || seq !== briefRequestSeq) return;
          s.brief = castDraft(b);
          s.briefAt = askedAt;
        }))
        .catch(() => {});
    },
    fetchAwaitingClient: () => (gateway ? gateway.awaitingClient() : Promise.resolve(null)),
    // Phase 2 Task 9 — the project-shell summary: populate `enabledModules` for the manifest-driven
    // nav. Project-scoped — a reply that lands after a switch / re-auth is dropped (guarded by scope).
    loadShell: () => {
      if (!gateway) return;
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      gateway.shell().then((shell) => {
        set((s) => {
          if (isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope)) {
            s.enabledModules = shell.enabledModules;
            s.capabilities = shell.capabilities;
            // B1 — the rollout state, fail closed: only the exact `'open'` opens; anything else (including
            // an absent field from an older server) stays reserved.
            s.phase6_4dRollout = shell.rollout?.phase6_4d === 'open' ? 'open' : 'reserved';
            // F-deeplink — the shell has now REPORTED this project's capabilities, so RouteBridge
            // may enforce the capability gate on deep links (it never bounces while unknown).
            s.capabilitiesKnown = true;
          }
        });
        // Phase 3 Task 7 — on a PILOT project, pull the Materials bundle once the capability is known.
        if (isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, scope) && shell.capabilities.includes('materials')) {
          get().loadMaterials();
        }
        // Phase 4 Task 6 (§J) — same discipline for the Labour bundle on a labour-pilot project.
        if (isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, scope) && shell.capabilities.includes('labour')) {
          get().loadLabour();
        }
        // Phase 5 Task 7B-i (§M) — same stance for the commercial pilot: the hub's reads only fire
        // once the shell has REPORTED the capability, so a non-pilot project issues none of them.
        if (isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, scope) && shell.capabilities.includes('commercial')) {
          void get().loadCommercial();
        }
      }).catch(() => {
        // Codex round 12 — a swallowed shell failure left `capabilitiesKnown` false FOREVER while
        // the capability-gated `loadMaterials`/`loadLabour` stayed inert no-ops: a bookmarked pilot
        // URL rendered a permanent "loading" screen with no retry. Surface the failure through the
        // module load states (the hubs' honest unavailable+Retry path — their Retry falls back to
        // `loadShell()` while capabilities are unknown). Scope-guarded like the success arm, and
        // only while capabilities are UNKNOWN: once a shell has reported, the hubs' own loads are
        // live and a later background shell failure must not flip their states.
        set((s) => {
          if (isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope) && !s.capabilitiesKnown) {
            if (s.materialsLoad === 'idle') s.materialsLoad = 'error';
            if (s.labourLoad === 'idle') s.labourLoad = 'error';
            // Codex F2 (7B-i) — the third hub needs the same transition, or a cold bookmarked
            // `/commercial` load whose shell request fails renders a permanent "loading" with no
            // Retry: `capabilitiesKnown` stays false, so `loadCommercial()` is an inert no-op and
            // nothing else can move `commercialLoad` off 'idle'.
            if (s.commercialLoad === 'idle') s.commercialLoad = 'error';
          }
        });
      });
    },
    loadMaterials: () => {
      if (!gateway) return;
      if (!get().capabilities.includes('materials')) return; // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      // correction finding 2 — latest-request ownership: claim the next token; a stale reply (older
      // token) is dropped even when the project scope is unchanged, so a slow refresh can never
      // overwrite a newer one or flip its load state.
      const seq = ++materialsLoadSeq;
      const owns = (s: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === materialsLoadSeq && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
      if (get().materialsLoad !== 'ready') set((s) => { s.materialsLoad = 'loading'; }); // stale-while-revalidate
      Promise.all([
        gateway.materialReadiness(),
        gateway.materialRequirements(),
        gateway.materialRequisitions(),
        gateway.materialPurchaseOrders(),
        gateway.materialStock(),
        gateway.materialIssues(),
      ]).then(([readiness, requirements, requisitions, purchaseOrders, stock, issues]) => set((s) => {
        if (!owns(s)) return; // dropped after a switch/re-auth OR superseded by a newer load
        // castDraft: the Phase-3 read DTOs are `readonly` (immutable server snapshots stored as-is,
        // never mutated in the draft), so immer's WritableDraft recursion needs the explicit cast.
        s.materialsView = castDraft<MaterialsView>({
          readiness,
          requirements: requirements.requirements,
          requisitions: requisitions.requisitions,
          purchaseOrders: purchaseOrders.purchaseOrders,
          stock: stock.lots,
          issues: issues.issues,
        });
        s.materialsLoad = 'ready';
      })).catch(() => set((s) => {
        // keep the last-good bundle; expose a Retry boundary (finding 4: honest, not stale-'ready').
        // An OLDER failure never overwrites a NEWER result's load state (finding 2).
        if (owns(s)) s.materialsLoad = 'error';
      }));
    },
    // ── Phase 3 Task 7 (correction 2) — the pilot MATERIALS is OPERATIONAL with NO browser-side
    //    multi-command orchestration. The SERVER computes the canonical reservation plan (candidates +
    //    residual); the browser dispatches EXPLICIT single commands, each write-ahead + idempotency-keyed
    //    + coalesced, reconciling `loadMaterials` after the flush. Every one is inert off-pilot. ──
    loadReservationPlan: (activityId) => {
      if (!gateway || !get().capabilities.includes('materials')) return;
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      // correction 3 (finding 2) — per-activity newest-wins: claim the next generation; only THIS request,
      // if it is still the newest AND the project scope is unchanged, may write the plan. A slow older
      // request that resolves after a newer reconciliation is dropped (never re-displays stale candidates).
      const gen = (reservationPlanSeq.get(activityId) ?? 0) + 1;
      reservationPlanSeq.set(activityId, gen);
      gateway.materialReservationPlan(activityId).then((plan) => set((s) => {
        if (reservationPlanSeq.get(activityId) === gen && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope)) {
          s.reservationPlans[activityId] = castDraft(plan);
        }
      })).catch(() => { /* the cover UI falls back to "no candidates"; the user can retry */ });
    },
    reserveCandidate: (activityId, lotId, storeLocation, qty) => {
      // correction 3 (finding 1) — a FRESH idempotency key per action (reused on retry, DIFFERENT for the
      // next legitimate reserve after this resolves); coalesced only while pending by (lot, store, activity).
      dispatchMaterials(
        { t: 'reserveStock', input: { lotId, storeLocation, activityId, qty }, idempotencyKey: newIdempotencyKey(), coalesceKey: reserveCoalesceKey(activityId, lotId, storeLocation) },
        'Reserve stock to the activity',
        'Stock reserved to the activity.',
      );
    },
    raiseRequisition: (activityId, title, lines) => {
      // one residual requisition per action: a double-click coalesces on the residual content; a later,
      // DIFFERENT residual is a distinct command. Fresh idempotency key per action. Never a fan-out.
      dispatchMaterials(
        { t: 'createRequisition', input: { title, lines: lines.map((l) => ({ requirementId: l.requirementId, revision: l.revision, qty: l.qty })) }, idempotencyKey: newIdempotencyKey(), coalesceKey: requisitionCoalesceKey(activityId, lines) },
        'Raise a requisition for the shortfall',
        'Requisition raised to procure the shortfall.',
      );
    },
    issueMaterial: (lotId, storeLocation, activityId, qty) => {
      dispatchMaterials(
        { t: 'issueStock', input: { lotId, storeLocation, activityId, qty }, idempotencyKey: newIdempotencyKey(), coalesceKey: issueCoalesceKey(activityId, lotId, storeLocation, qty) },
        'Issue stock to site',
        'Issued to site.',
      );
    },
    consumeMaterial: (issueId, qty) => {
      dispatchMaterials(
        { t: 'consumeStock', input: { issueId, qty }, idempotencyKey: newIdempotencyKey(), coalesceKey: consumeCoalesceKey(issueId, qty) },
        'Record consumption',
        'Consumption recorded.',
      );
    },
    // ── Phase 4 Task 6 (§J) — the pilot LABOUR bundle + field ops, cloning the materials
    //    discipline exactly: greenfield module-query reads with honest load states + latest-request
    //    ownership, and ONE write-ahead server command per user action. All inert off-pilot. ──
    loadLabour: () => {
      if (!gateway) return Promise.resolve();
      if (!get().capabilities.includes('labour')) return Promise.resolve(); // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      // latest-request ownership (the materials finding-2 discipline): claim the next token; a stale
      // reply (older token) is dropped even when the project scope is unchanged.
      const seq = ++labourLoadSeq;
      const owns = (s: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === labourLoadSeq && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
      if (get().labourLoad !== 'ready') set((s) => { s.labourLoad = 'loading'; }); // stale-while-revalidate
      // Today's presence read uses the PROJECT-timezone civil date (Codex F-TZ): the server
      // evaluates readiness against `clock.today(project.timeZone)`, so a viewer in another
      // timezone must still read (and muster against) the SITE's "today", never the browser's.
      const today = todayCivil(get().timeZone);
      // round 10 — the promise is RETURNED (resolving after the bundle applies or the failure is
      // recorded) so the roster commands can await the reload before spending their held keys.
      return Promise.all([
        gateway.labourReadiness(),
        gateway.materialRequirements(), // the SHARED type-neutral list; the hub filters to labour rows
        gateway.labourWorkforce(),
        gateway.labourCatalog(),
        gateway.labourRequisitions(),
        gateway.labourPurchaseOrders(),
        gateway.labourCommitments(),
        gateway.labourCapacity(),
        gateway.labourPresence(today),
        gateway.labourProductivity(),
      ]).then(async ([readiness, requirements, workforce, catalog, requisitions, purchaseOrders, commitments, capacity, presence, productivity]) => {
        // F1 (compatible pickers) — every fingerprint each worker's own (trade, skills) identity
        // can satisfy, computed ONCE per load with the SAME shared WebCrypto fingerprint the
        // server pins, so the allocate UI can offer only workers the coverage rule would count.
        const workerFingerprints = await buildWorkerFingerprints(workforce.workers);
        set((s) => {
          if (!owns(s)) return; // dropped after a switch/re-auth OR superseded by a newer load
          // castDraft: the labour read DTOs are `readonly` server snapshots stored as-is, never mutated.
          s.labourView = castDraft<LabourView>({
            readiness,
            requirements: requirements.requirements,
            workforce,
            catalog,
            requisitions: requisitions.requisitions,
            purchaseOrders: purchaseOrders.purchaseOrders,
            commitments: commitments.commitments,
            capacity,
            presence,
            productivity,
            workerFingerprints,
          });
          s.labourLoad = 'ready';
          // Codex round 8 — the fresh bundle IS on screen now: rebuild `labourPending` from the
          // live outbox (pending == still-queued ops). A key resolved by the flush clears HERE —
          // never in the gap where the old bundle still rendered — and a transient-failed op's
          // key survives because its op is still queued.
          s.labourPending = s.outbox.flatMap((o) =>
            isLabourOpType((o as { t?: unknown }).t) && typeof (o as { coalesceKey?: unknown }).coalesceKey === 'string'
              ? [(o as { coalesceKey: string }).coalesceKey]
              : [],
          );
          // Codex round 13 — the retained-input register follows the SAME lifecycle: a resolved
          // op's input clears here WITH its key (the fresh truth is on screen); a still-queued
          // op's input survives because its key does.
          const live = new Set(s.labourPending);
          for (const k of Object.keys(s.labourPendingInputs)) {
            if (!live.has(k)) delete s.labourPendingInputs[k];
          }
        });
      }).catch(() => set((s) => {
        // keep the last-good bundle; expose a Retry boundary. An OLDER failure never
        // overwrites a NEWER result's load state.
        if (owns(s)) s.labourLoad = 'error';
      }));
    },

    // ── Phase 5 Task 7B-i (§M) — the MONEY-POSITION bundle ─────────────────────────────────────
    //
    // The commercial twin of `loadLabour`, cloning the cleared discipline rather than inventing a
    // third one: capability gate → scope capture → latest-request token → stale-while-revalidate →
    // ownership-checked apply → ownership-checked failure.
    //
    // The token is the part that matters and the part a test can pass without. `loadCommercial()`
    // is called from the shell, from Retry, from a socket refresh and from a project switch, so two
    // can be in flight at once — and `Promise.all` over FOUR reads makes an older bundle finishing
    // late entirely ordinary. Without `seq`, that older bundle would overwrite a newer one's money,
    // and an older FAILURE would flip a healthy hub to its error boundary. Both directions are
    // asserted in `commercial.test.ts`, verified RED against a build with the token removed.
    loadCommercial: () => {
      if (!gateway) return Promise.resolve();
      if (!get().capabilities.includes('commercial')) return Promise.resolve(); // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      const seq = ++commercialLoadSeq;
      const owns = (s: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === commercialLoadSeq && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
      // Codex I2 — the STATUS says what the read is DOING; the VALUE says what we have. Keeping the
      // status at 'ready' through a refresh was stale-while-revalidate implemented in the wrong
      // place: every consumer already gates blanking on the value (`… && !commercial`), so the
      // guard bought no protection and cost the one thing only the status can say — that a read is
      // in flight right now. Set it honestly and let the value carry the last-good picture.
      // Q-a, hoisted: captured at START, so a read that began before a write settled applies its
      // value and releases nothing.
      const settledAtStart = commercialWritesSettled;
      set((s) => { s.commercialLoad = 'loading'; });
      // Codex round 2 — ONE request, not four. Four reads assemble a page from four database
      // moments, and a re-attribution committing between two of them renders an impossible money
      // position (the obligation under MEP in the budget, the register still naming CIVIL). The
      // server folds all four in one repeatable-read transaction.
      return gateway.commercialMoneyPosition().then((position) => {
        set((s) => {
          if (!owns(s)) return; // dropped after a switch/re-auth OR superseded by a newer load
          // castDraft: this is a `readonly` server snapshot stored as-is, never mutated.
          s.commercialView = castDraft<CommercialView>(position);
          s.commercialLoad = 'ready';
          // Task 7B-iii-a — the fresh money IS on screen now: rebuild `commercialPending` from
          // the live outbox (pending == still-queued). A key resolved by the flush clears HERE,
          // never in the gap where the pre-command figure still rendered; a transient-failed
          // op's key survives because its op is still queued. Labour round 8, inherited.
          // Codex N1 — release only the keys THIS read makes visible; every other key is retained.
          // The money read resolving says nothing about whether the claim register on screen is
          // current, and it is the faster of the two; clearing a measurement's key on it reopened
          // the very window M1 closed.
          releaseCommercialKeys(s, { read: 'money', observedWrite: commercialWritesSettled === settledAtStart });
        });
      }).catch(() => set((s) => {
        // keep the last-good bundle and expose a Retry boundary. An OLDER failure never overwrites
        // a NEWER result's load state — the direction the labour hub needed a finding to learn.
        if (owns(s)) s.commercialLoad = 'error';
      }));
    },

    /**
     * Task 7B-ii — the claim LIST. Its own load and its own token, because "which claims exist" is
     * a different question from "where does the money stand" and neither figure is derived from
     * the other; see `commercialClaim` in the gateway for why that distinction decides bundling.
     */
    loadCommercialBills: () => {
      if (!gateway) return Promise.resolve();
      if (!get().capabilities.includes('commercial')) return Promise.resolve(); // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      const seq = ++commercialBillsSeq;
      const owns = (s: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === commercialBillsSeq && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
      const settledAtStart = commercialWritesSettled; // Q-a, hoisted — see `CommercialRead`
      set((s) => { s.commercialBillsLoad = 'loading'; }); // honest status; the value survives (I2)
      // UNWRAP: the route returns the wrapper `VendorBillListDto`, like every other list route.
      // Storing the envelope would put an object where the screen maps an array.
      return gateway.commercialBills().then(({ bills }) => {
        set((s) => {
          if (!owns(s)) return;
          s.commercialBills = castDraft<CommercialBillRow[]>(bills);
          s.commercialBillsLoad = 'ready';
          // …and the list's own keys — a LODGE becomes visible here, and here only: this is the
          // list the lodge form's duplicate guard reads.
          releaseCommercialKeys(s, { read: 'bills', observedWrite: commercialWritesSettled === settledAtStart });
        });
      }).catch(() => set((s) => { if (owns(s)) s.commercialBillsLoad = 'error'; }));
    },

    /**
     * Task 7B-ii — ONE claim's whole lifecycle, from the server's single repeatable-read bundle.
     *
     * The token is PER CLAIM. A shared counter would make opening claim B drop a still-wanted load
     * of claim A, and would let a slow A that nothing newer asked for be discarded — the same class
     * of defect the reservation-plan generation fixed in PR #208, avoided here rather than found.
     */

    /**
     * 7B-vi (§H) — load the advances, and SETTLE the advance key.
     *
     * No claim read carries a counterparty, so until this landed the advance key had no release
     * path at all: the op settled, no read cleared it, and the button stayed disabled until a
     * hydration or a scope change rebuilt the pending set. A key with no settling read is not
     * "pending", it is STUCK — 7B-iii-g's F2, and the reason this read ships with the control.
     *
     * Same latest-request ownership and scope guard as every other commercial read: an older
     * response that resolves late is dropped rather than overwriting a newer one.
     */
    loadCommercialAdvances: () => {
      if (!gateway) return Promise.resolve();
      if (!get().capabilities.includes('commercial')) return Promise.resolve(); // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      const seq = (commercialAdvancesSeq += 1);
      const owns = (s: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === commercialAdvancesSeq && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
      const settledAtStart = commercialWritesSettled;
      set((s) => { s.commercialAdvancesLoad = 'loading'; });
      return gateway.commercialAdvances().then((advances) => {
        set((s) => {
          if (!owns(s)) return;
          s.commercialAdvances = castDraft(advances);
          s.commercialAdvancesLoad = 'ready';
          releaseCommercialKeys(s, {
            read: 'advances', observedWrite: commercialWritesSettled === settledAtStart,
          });
        });
      }).catch(() => set((s) => { if (owns(s)) s.commercialAdvancesLoad = 'error'; }));
    },

    loadCommercialClaim: (billId: string) => {
      if (!gateway) return Promise.resolve();
      if (!get().capabilities.includes('commercial')) return Promise.resolve(); // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      const seq = (commercialClaimSeq[billId] = (commercialClaimSeq[billId] ?? 0) + 1);
      const owns = (s: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === commercialClaimSeq[billId] && isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
      // Codex I2 — stale-while-revalidate lives in the VALUE, which is retained here exactly as
      // before; the status goes to 'loading' because that is what is true. Holding it at 'ready'
      // through a refresh made a lifecycle an accountant is about to authorise money against
      // indistinguishable from one a completed current read had just confirmed.
      const settledAtStart = commercialWritesSettled; // Q-a, hoisted — see `CommercialRead`
      set((s) => { s.commercialClaimLoad[billId] = 'loading'; });
      return gateway.commercialClaim(billId).then((claim) => {
        set((s) => {
          if (!owns(s)) return;
          s.commercialClaims[billId] = castDraft<CommercialClaimView>(claim);
          s.commercialClaimLoad[billId] = 'ready';
          // THIS claim's lifecycle transitions are visible now. A lodge is not (the list carries
          // it), and neither is a measurement (its LINE's register carries it) — with two claims
          // open, releasing those here is N1 one resource over.
          // 7B-iii-d round 4 — the payer's keys are SCOPED TO THIS BILL, so this read settles
          // them without being handed a row list. Passing the ids the read returned looked more
          // honest and was strictly worse: a withholding released in full and then superseded is
          // absent from the next read, so its key could never be named and stayed pending for
          // ever. Absence IS the effect when the parent is gone.
          releaseCommercialKeys(s, {
            read: 'claim', billId,
            observedWrite: commercialWritesSettled === settledAtStart,
          });
        });
      }).catch(() => set((s) => { if (owns(s)) s.commercialClaimLoad[billId] = 'error'; }));
    },

    /**
     * §D — ONE labour PO line's measurement register, read from the line's own route.
     *
     * This is the read that makes a measurement VISIBLE. The claim bundle carries registers only
     * for a LIVE version's lines and a lodged claim is `draft`, so without this a measurement is
     * recorded by the server and shows nothing — an invitation to take it twice.
     */
    loadCommercialLineRegister: (labourPoLineId: string) => {
      if (!gateway) return Promise.resolve();
      if (!get().capabilities.includes('commercial')) return Promise.resolve(); // inert off-pilot
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      const seq = (commercialLineSeq[labourPoLineId] = (commercialLineSeq[labourPoLineId] ?? 0) + 1);
      const settledAtStart = commercialWritesSettled; // Q-a, hoisted — see `CommercialRead`
      const owns = (st: { activeProjectId: string; projectScopeGeneration: number }) =>
        seq === commercialLineSeq[labourPoLineId]
        && isCurrentProjectScope(st.activeProjectId, st.projectScopeGeneration, scope);
      set((st) => { st.commercialLineRegisterLoad[labourPoLineId] = 'loading'; });
      return gateway.commercialLineRegister(labourPoLineId).then((register) => {
        set((st) => {
          if (!owns(st)) return;
          st.commercialLineRegisters[labourPoLineId] = castDraft<MeasurementRegisterDto>(register);
          st.commercialLineRegisterLoad[labourPoLineId] = 'ready';
          releaseCommercialKeys(st, {
            read: 'lineRegister',
            labourPoLineId,
            rowIds: register.rows.map((r) => r.id),
            observedWrite: commercialWritesSettled === settledAtStart,
          });
        });
      }).catch(() => set((st) => { if (owns(st)) st.commercialLineRegisterLoad[labourPoLineId] = 'error'; }));
    },

    // ── §M WRITES (7B-iii-a) ────────────────────────────────────────────────────────────────
    // Each mints a FRESH idempotency key per deliberate action (exactly-once replay on a lost
    // response) and a DETERMINISTIC coalesce key (dedupe an equivalent action while pending).

    setCommercialBudget: (costHeadCode, amount, reason) => {
      // 7B-vi — the key is derived from the SAME object the command carries, so the identity
      // cannot drift from the payload the way a hand-listed subset does.
      const input = { costHeadCode, amount, reason };
      dispatchCommercial(
        {
          t: 'setCommercialBudget',
          input,
          idempotencyKey: newIdempotencyKey(),
          coalesceKey: budgetCoalesceKey(input),
        },
        `Budget for ${costHeadCode}`,
        'Budget set.',
      );
    },
    defineCostHead: (code, name) => {
      dispatchCommercial(
        {
          t: 'defineCostHead',
          input: { code, name },
          idempotencyKey: newIdempotencyKey(),
          coalesceKey: costHeadCoalesceKey(code),
        },
        `Cost head ${code}`,
        'Cost head defined.',
      );
    },
    takeMeasurement: (input) => {
      dispatchCommercial(
        { t: 'takeMeasurement', input, idempotencyKey: newIdempotencyKey(),
          coalesceKey: measureCoalesceKey(input.labourPoLineId, input.activityId) },
        `Measure ${input.labourPoLineId}`, 'Measurement recorded.',
      );
    },
    correctMeasurement: (measurementId, quantity, reason, labourPoLineId) => {
      dispatchCommercial(
        // `labourPoLineId` rides on the OP, not in `input`: the server's contract takes only the
        // measurement id, and a correction is issued from a row inside one line's register, so the
        // screen knows the line. The cap needs it, because a POSITIVE correction consumes the same
        // line authority a measurement does — counting only `takeMeasurement` let a queued +5 and
        // a queued measurement of 5 both pass against one remaining 5.
        { t: 'correctMeasurement', input: { measurementId, quantity, reason }, labourPoLineId,
          idempotencyKey: newIdempotencyKey(),
          coalesceKey: correctionCoalesceKey(measurementId, quantity) },
        `Correct ${measurementId}`, 'Correction recorded.',
      );
    },
    recordVendorBill: (input) => {
      dispatchCommercial(
        { t: 'recordVendorBill', input, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billCoalesceKey(input.vendorId, input.vendorBillNumber) },
        `Claim ${input.vendorBillNumber}`, 'Claim lodged.',
      );
    },
    submitVendorBill: (billId) => {
      dispatchCommercial(
        { t: 'submitVendorBill', input: { billId }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(billId, 'submit') },
        `Submit ${billId}`, 'Claim submitted.',
      );
    },
    amendVendorBill: (input) => {
      dispatchCommercial(
        { t: 'amendVendorBill', input, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(input.billId, 'amend') },
        `Amend ${input.billId}`, 'Claim amended.',
      );
    },
    rejectVendorBill: (billId, reason) => {
      dispatchCommercial(
        { t: 'rejectVendorBill', input: { billId, reason }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(billId, 'reject') },
        `Reject ${billId}`, 'Claim rejected.',
      );
    },
    beginVerification: (billId) => {
      dispatchCommercial(
        { t: 'beginVerification', input: { billId }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(billId, 'begin-verification') },
        `Verify ${billId}`, 'Verification opened.',
      );
    },
    verifyVendorBill: (billId) => {
      dispatchCommercial(
        { t: 'verifyVendorBill', input: { billId }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(billId, 'verify') },
        `Verify ${billId}`, 'Verification recorded.',
      );
    },
    certifyBill: (billId, versionId, lifecycleVersion) => {
      dispatchCommercial(
        { t: 'certifyBill', input: { billId, versionId, lifecycleVersion }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(billId, 'certify') },
        `Certify ${billId}`, 'Claim certified.',
      );
    },
    recordDeduction: (billId, type, amount, reason) => {
      dispatchCommercial(
        { t: 'recordDeduction', input: { billId, type, amount, reason }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: deductionCoalesceKey(billId) },
        `Withhold on ${billId}`, 'Withholding recorded.',
      );
    },
    releaseDeduction: (billId, deductionId, amount, reason) => {
      dispatchCommercial(
        { t: 'releaseDeduction', input: { deductionId, amount, reason }, idempotencyKey: newIdempotencyKey(),
          // keyed on the WITHHOLDING: two releases race one unreleased balance, while releases
          // against different withholdings are independent and must not coalesce
          coalesceKey: deductionReleaseCoalesceKey(billId, deductionId) },
        `Release ${deductionId}`, 'Withholding released.',
      );
    },
    approvePayment: (billId, amount, lifecycleVersion) => {
      dispatchCommercial(
        { t: 'approvePayment', input: { billId, amount, lifecycleVersion }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: approveCoalesceKey(billId) },
        `Approve on ${billId}`, 'Payment approved.',
      );
    },
    payAdvance: (vendorId, amount, reason, method, reference) => {
      // 7B-vi — the coalesce key is derived from the SAME object the command carries, so the
      // identity cannot drift from the payload the way a hand-listed subset does. `method` and
      // `reference` are in it because they are in the input, not because a round found them.
      const input = { vendorId, amount, reason, method, reference };
      dispatchCommercial(
        { t: 'payAdvance', input, idempotencyKey: newIdempotencyKey(),
          coalesceKey: advanceCoalesceKey(input) },
        `Advance to ${vendorId}`, 'Advance paid.',
      );
    },
    recordPayment: (billId, approvalId, amount, method, reference) => {
      dispatchCommercial(
        { t: 'recordPayment', input: { approvalId, amount, method, reference }, idempotencyKey: newIdempotencyKey(),
          // keyed on the APPROVAL — §G bound 5 caps paid at what THAT approval authorised
          coalesceKey: payCoalesceKey(billId, approvalId) },
        `Pay ${approvalId}`, 'Payment recorded.',
      );
    },
    reversePayment: (billId, paymentId, amount, reason) => {
      dispatchCommercial(
        { t: 'reversePayment', input: { paymentId, amount, reason }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: reverseCoalesceKey(billId, paymentId) },
        `Reverse ${paymentId}`, 'Payment reversed.',
      );
    },
    grantSodException: (billId, actorId, reason, viewed, rule) => {
      dispatchCommercial(
        { t: 'grantSodException',
          input: { billId, actorId, reason, rule, ...viewed },
          idempotencyKey: newIdempotencyKey(),
          // per PERSON, not per claim: two approvers may authorise two different actors on one
          // claim concurrently and both are real. What the key does NOT do is exempt the grant
          // from the claim's transition conflict — see `commercialWriteBlocked` (R5-1).
          coalesceKey: sodGrantCoalesceKey(billId, actorId, rule) },
        `Authorise ${actorId} on ${billId}`, 'Authorisation recorded.',
      );
    },
    supersedeCertificate: (billId, reason, certificateId) => {
      dispatchCommercial(
        { t: 'supersedeCertificate', input: { billId, reason, certificateId }, idempotencyKey: newIdempotencyKey(),
          coalesceKey: billTransitionCoalesceKey(billId, 'supersede') },
        `Supersede ${billId}`, 'Certificate superseded.',
      );
    },
    reattributeCommitment: (line, costHeadCode, reason) => {
      // The XOR is the server's contract AND the PG CHECK; the caller passes one shape or the
      // other, so a request naming both or neither is unrepresentable here rather than refused.
      const lineId = 'poLineId' in line ? line.poLineId : line.labourPoLineId;
      dispatchCommercial(
        {
          t: 'reattributeCommitment',
          input: { ...line, costHeadCode, reason },
          idempotencyKey: newIdempotencyKey(),
          coalesceKey: attributionCoalesceKey(lineId),
        },
        `Re-attribute ${lineId}`,
        'Commitment re-attributed.',
      );
    },
    allocateWorker: (activityId, requirementId, originRevision, civilDate, workerId, capacityCommitmentId, labourSpecFingerprint) => {
      // fresh idempotency key per deliberate action; coalesced while pending on the exact
      // (activity, requirement, date, worker) target — one live allocation per worker/slice.
      // F2 (drawdown) — a commitment-covered slice passes the matching commitment id so the
      // server's §F bound-3 drawdown consumes the supplier capacity; null = own workforce.
      // Codex round 3 (P1) — the command PINS the head revision the worker was selected against:
      // an offline-queued replay landing after a requirement revision is a terminal 409 the flush
      // reconciles, never a silent allocation onto a different trade/skill/shift demand.
      dispatchLabour(
        // Codex round 8 — the SATISFYING identity the worker was offered under rides the command
        // as the eligibility BASIS: the server VERIFIES it is the head identity or an ACTIVE
        // approved substitution (409 on a revoked/unknown authority) while the persisted identity
        // stays the HEAD per the sealed §C FK. Absent (a head-identity worker) keeps
        // pre-round-8 bytes; round 10 makes revocation itself release substitution-only rows.
        { t: 'allocateLabour', input: { activityId, requirementId, originRevision, civilDate, workerId, ...(capacityCommitmentId ? { capacityCommitmentId } : {}), ...(labourSpecFingerprint ? { labourSpecFingerprint } : {}) }, idempotencyKey: newIdempotencyKey(), coalesceKey: allocateCoalesceKey(activityId, requirementId, originRevision, civilDate, workerId) },
        'Allocate the worker to the activity',
        'Worker allocated to the activity.',
      );
    },
    musterWorker: (workerId, civilDate, shift, manualReason) => {
      // The store's muster path is the pmc-attributable MANUAL exception (a dead battery is site
      // reality); device-evidenced musters arrive from the worker's own bound device, not this hub.
      dispatchLabour(
        { t: 'recordAttendance', input: { workerId, civilDate, shift, manualReason }, idempotencyKey: newIdempotencyKey(), coalesceKey: musterCoalesceKey(workerId, civilDate, shift) },
        'Record the worker’s attendance',
        'Attendance recorded.',
      );
    },
    recordWorkedMinutes: (allocationId, workedMinutes) => {
      dispatchLabour(
        { t: 'recordLabourWork', input: { allocationId, workedMinutes }, idempotencyKey: newIdempotencyKey(), coalesceKey: workCoalesceKey(allocationId, workedMinutes) },
        'Record worked minutes',
        'Worked minutes recorded.',
      );
    },
    releaseAllocation: (allocationId, reason) => {
      // Codex round 11 — the corrective the hub's stranded states point at, exposed IN the hub:
      // one release command per allocation through the same durable outbox lifecycle.
      dispatchLabour(
        { t: 'releaseLabourAllocation', allocationId, reason, idempotencyKey: newIdempotencyKey(), coalesceKey: releaseCoalesceKey(allocationId) },
        'Release the allocation',
        'Allocation released.',
      );
    },
    raiseLabourRequisition: (title, lines) => {
      // one labour requisition per action: a double-click coalesces on the slice content; a later,
      // DIFFERENT slice set is a distinct command. Never a fan-out.
      dispatchLabour(
        { t: 'createLabourRequisition', input: { title, lines: lines.map((l) => ({ requirementId: l.requirementId, revision: l.revision, civilDate: l.civilDate, personShiftQty: l.personShiftQty })) }, idempotencyKey: newIdempotencyKey(), coalesceKey: labourRequisitionCoalesceKey(lines) },
        'Raise a labour requisition',
        'Labour requisition raised.',
      );
    },
    onboardLabourWorker: (name, tradeCode, skillCodes, activeFrom) => {
      // Roster commands are pmc-authored, low-frequency Team-screen actions reconciled by
      // reloading the labour bundle (no outbox lifecycle). Codex round 5 — a committed-but-lost
      // response must NOT duplicate the worker on retry: the roster has no natural uniqueness on
      // (name, trade), so the ledger's idempotency key IS the identity. The key for the submitted
      // form is minted ONCE and reused verbatim until a CONFIRMED success clears it; a later
      // deliberate identical onboarding (after confirmation) mints a fresh key, and a CHANGED
      // form is a different command with its own fresh key.
      if (!gateway || !get().capabilities.includes('labour')) return;
      // Codex round 8 — held keys are keyed BY FORM SIGNATURE: a second form submitted while
      // the first is unresolved must not evict the first form's key (a single slot did — the
      // first form's retry then minted a fresh key and could duplicate the Worker).
      const sig = JSON.stringify([name, tradeCode, skillCodes, activeFrom]);
      const key = get().labourOnboardPending[sig] ?? newIdempotencyKey();
      set((s) => { s.labourOnboardPending[sig] = key; });
      const lease = beginSnapshotLease(currentScope());
      gateway!.onboardWorker({ name, tradeCode, skillCodes, activeFrom }, key)
        .then(async (created) => {
          // Codex round 10 — the command's own 2xx is NOT roster truth: the Team roster renders
          // the module-owned labour bundle, so the key is spent ONLY once the FRESH bundle
          // contains the row. If the reload fails or stays stale the key survives, the retry
          // replays the SAME key, and the ledger returns the ORIGINAL worker — never a
          // duplicate identity minted under a fresh key while the screen showed no worker.
          await get().loadLabour();
          if (scopeStillCurrent(lease.scope) && get().labourView?.workforce.workers.some((w) => w.id === created.id)) {
            set((s) => { if (s.labourOnboardPending[sig] === key) delete s.labourOnboardPending[sig]; });
          }
          return gateway!.snapshot();
        })
        .then((snap) => consumeSnapshotResult(acceptSnapshot(snap, lease), 'Worker onboarded to the project roster.', lease.scope))
        .catch(() => {
          // failure (including a LOST committed response) RETAINS the key for the retry
          if (scopeStillCurrent(lease.scope)) get().flash('Could not reach the server — please try again.');
        });
    },
    bindLabourDevice: (deviceId, workerId) => {
      // Codex round 6 — the same held-key discipline as `onboardLabourWorker`: the bind CAS
      // succeeds ONCE (a re-bind of the same pair is the server's "already bound" 409), so a
      // committed-but-lost response retried with a FRESH key would report failure for a binding
      // that succeeded. The key for the submitted (device, worker) pair is minted once and
      // reused verbatim until a CONFIRMED success — the ledger replays the original result.
      if (!gateway || !get().capabilities.includes('labour')) return;
      const sig = bindSig(deviceId, workerId);
      const key = get().labourBindPending[sig] ?? newIdempotencyKey();
      set((s) => { s.labourBindPending[sig] = key; });
      const lease = beginSnapshotLease(currentScope());
      gateway!.bindWorkerDevice(deviceId, workerId, key)
        .then(
          async () => {
            // Codex round 10 — the key is spent only after the post-bind RECONCILE succeeds:
            // deleting it on the bind's own 2xx meant a failed follow-up snapshot reported
            // "could not reach the server" with the key already gone, and the retry's FRESH key
            // hit the CAS's terminal "already bound" 409 for a binding that succeeded. The
            // reconcile failure path retains the key, so the retry replays the SAME key and
            // the ledger returns the original success.
            try {
              await get().loadLabour();
              const snap = await gateway!.snapshot();
              consumeSnapshotResult(acceptSnapshot(snap, lease), 'Device bound to the worker.', lease.scope);
              if (scopeStillCurrent(lease.scope)) {
                set((s) => { if (s.labourBindPending[sig] === key) delete s.labourBindPending[sig]; });
              }
            } catch {
              // the bind COMMITTED but the reconcile failed — RETAIN the key (round 10)
              if (scopeStillCurrent(lease.scope)) get().flash('Could not reach the server — please try again.');
            }
          },
          (e: unknown) => {
            // Codex round 14 — the BIND REQUEST itself was answered. A TERMINAL business
            // rejection (a mistyped device id 404; a device already bound to ANOTHER worker
            // 409) means NO binding by this key exists to replay — holding the key would leave
            // `isDeviceBindPending` reserving the DEVICE against every worker until a
            // reload/scope reset, so the pmc could not correct the id or pick the right
            // worker. Clear the held key so the corrected form mints a fresh attempt. A
            // transient/network failure (no status, 401/408/429, 5xx) still RETAINS the key —
            // a committed-but-LOST response must replay the SAME idempotency key (round 6).
            if (!scopeStillCurrent(lease.scope)) return;
            if (isTerminalOutboxError(e)) {
              set((s) => { if (s.labourBindPending[sig] === key) delete s.labourBindPending[sig]; });
              get().flash('Device binding was refused — check the device id and worker.');
            } else {
              get().flash('Could not reach the server — please try again.');
            }
          },
        );
    },
    switchProject: (projectId, targetScreen, targetItem) => {
      if (!gateway || projectId === get().activeProjectId) return Promise.resolve(false);
      const membership = get().memberships.find((m) => m.projectId === projectId);
      const short = membership?.short ?? 'project';
      // the OLD project's identity, restored if the switch fails (we keep its auth scope)
      const prev = (({ name, short: sh, descriptor, stage, siteCode }) => ({ name, short: sh, descriptor, stage, siteCode }))(get());
      // #824 — the old project's module set, restored with its identity if the switch fails: the entry below
      // empties it, and an empty set means "no module filter", so a failed switch would otherwise reopen
      // modules the old project switched off (its shell is not reloaded, since the active project never changed)
      const prevModules = get().enabledModules;
      // ATOMIC ENTRY — before the auth request goes out: bump the scope generation
      // (in-flight replies for the old scope will be dropped), mark the transition,
      // and EMPTY every project-owned field. Old records can neither render nor
      // arrive while authorization is pending.
      set((s) => {
        s.projectScopeGeneration += 1;
        // SV2: a held visit, and a person's Send anyway, belong to the scope they were made in
        s.siteVisitsHeld = null;
        s.siteVisitsSentAnyway = [];
        dropVisitPhotoRetry(); // and the retry armed for it: the scope's own load arms its own
        // Codex 4210609591 — a new scope owes nothing of the old one's commands (its coordinator is abandoned)
        s.commandReconcilePending = false;
        s.commandReconcileOwed = noReconcileOwed();
        s.pendingProjectId = projectId;
        s.projectLoadState = 'switching';
        s.projectLoadError = null;
        // optimistic label from the membership; the snapshot supplies the rest
        s.name = membership?.name ?? short;
        s.short = short;
        s.descriptor = '';
        s.stage = '';
        s.siteCode = '';
        s.timeZone = null; // the target project's zone is unknown until its snapshot lands
        Object.assign(s, emptyProjectData());
        Object.assign(s, emptyModuleReadState()); // finding 4: the target project's reads are not loaded yet
      });
      const switchGeneration = get().projectScopeGeneration;
      return gateway
        .switchProject(projectId)
        .then((res) => {
          // adopt the SERVER-returned project/role/token (never the requested id);
          // useApiSync re-inits the gateway for the new scope and refetches.
          applyAuthResult(res, { msg: 'Switched to ' + short + '.', targetScreen, targetItem });
          return true;
        })
        .catch(() => {
          // authorization failed: keep the OLD authenticated identity (token/project
          // unchanged), keep project data empty (never resurface half-cleared records),
          // and surface a recoverable error.
          set((s) => {
            s.pendingProjectId = null;
            s.projectLoadState = 'error';
            s.projectLoadError = 'Could not switch to ' + short + ' — check your access and try again.';
            s.name = prev.name;
            s.short = prev.short;
            s.descriptor = prev.descriptor;
            s.stage = prev.stage;
            s.siteCode = prev.siteCode;
            // only into the scope this switch left: a sign-out or re-auth meanwhile owns the state now
            if (s.projectScopeGeneration === switchGeneration) s.enabledModules = prevModules;
          });
          // #1201: the site photo retry armed before the switch was let go with the scope it was made in, and the old
          // project's queue is still here: armed again for the scope it is back in, so a queued photo is not left unsent
          if (get().projectScopeGeneration === switchGeneration) retrySitePhotos();
          get().flash('Could not switch project — please try again.');
          return false;
        });
    },
    createProject: async (orgId, input) => {
      if (!gateway) return { kind: 'refused', message: 'Creating projects needs the server.' };
      const gw = gateway;
      const ctx = captureCreateContext();
      // one attempt at a time per identity, across dialogs, tabs and reloads: the check, the key and the
      // record are ONE reservation under the identity's lock (Codex 4184306919, 4187151998)
      const reserved = await reserveNewCreate(ctx.scope, orgId, input);
      get().syncProjectCreateHold();
      if (reserved.kind === 'held') return { kind: 'unknown', message: reserved.message };
      if (reserved.kind === 'refused') return { kind: 'refused', message: reserved.message };
      return sendReserved(gw, reserved.reservation, null, ctx);
    },
    retryProjectCreate: async () => {
      if (!gateway) return { kind: 'refused', message: 'Creating projects needs the server.' };
      const gw = gateway;
      const ctx = captureCreateContext();
      // only the HELD attempt of THIS identity is retried, as itself — the same org, request and key
      const reserved = await reserveCreateRetry(ctx.scope);
      get().syncProjectCreateHold();
      if (reserved.kind !== 'reserved') return { kind: 'unknown', message: reserved.message };
      return sendReserved(gw, reserved.reservation, reserved.was, ctx);
    },
    syncProjectCreateHold: () => {
      const view = currentCreateHoldView(currentCreateHoldScope());
      if (JSON.stringify(view) !== JSON.stringify(get().projectCreateHold)) set((s) => { s.projectCreateHold = view; });
    },
    updateProjectDetails: (orgId, projectId, input) => {
      if (!gateway) {
        get().flash('Editing projects needs the server.');
        return;
      }
      gateway
        .updateProject(orgId, projectId, input)
        .then((p) => {
          get().flash('Project updated: ' + p.short + '.');
          get().loadOrgData();
          get().loadPortfolio();
        })
        .catch(() => get().flash('Could not update the project — check your access.'));
    },
    deleteProject: (orgId, projectId) => {
      if (!gateway) {
        get().flash('Deleting projects needs the server.');
        return;
      }
      gateway
        .deleteProject(orgId, projectId)
        .then(() => {
          get().flash('Project archived — it’s hidden from everyone. Ask to restore it if needed.');
          // if we archived the project we're in, switch to another we can access
          if (projectId === get().activeProjectId) {
            const next = get().memberships.find((m) => m.projectId !== projectId);
            if (next) get().switchProject(next.projectId);
          }
          get().loadOrgData();
          get().loadPortfolio();
        })
        .catch(() => get().flash('Could not archive the project — check your access.'));
    },
    restoreProject: (orgId, projectId) => {
      if (!gateway) {
        get().flash('Restoring projects needs the server.');
        return;
      }
      gateway
        .restoreProject(orgId, projectId)
        .then(() => {
          get().flash('Project restored — it’s visible again.');
          get().loadArchivedProjects(orgId);
          get().loadOrgData();
          get().loadPortfolio();
        })
        .catch(() => get().flash('Could not restore the project — check your access.'));
    },
    loadArchivedProjects: (orgId) => {
      if (!gateway) return;
      // session-scoped: a reply from a previous sign-in never lands in this one
      const tok = get().sessionToken;
      gateway.listArchivedProjects(orgId).then((rows: ArchivedProject[]) => set((s) => { if (s.sessionToken === tok) s.archivedProjects = rows; })).catch(() => {});
    },
    // Company mutations reconcile from raw DTOs (no snapshot), so each captures the
    // scope its request was issued FOR and drops the reply if the scope moved on —
    // a late reply from project A must never surface under project B (finding 3).
    addCompany: (input) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      const scope = currentScope();
      gateway
        .addCompany(input)
        .then((c) => {
          if (!scopeStillCurrent(scope)) return;
          set((s) => { s.companies.push(c); });
          get().flash(`Added ${c.name}.`);
        })
        .catch(() => get().flash('Could not add the company — check your access.'));
    },
    updateCompany: (companyId, input) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      const scope = currentScope();
      gateway
        .updateCompany(companyId, input)
        .then((c) => {
          if (!scopeStillCurrent(scope)) return;
          set((s) => { const i = s.companies.findIndex((x) => x.id === companyId); if (i >= 0) s.companies[i] = c; });
          get().flash(`Updated ${c.name}.`);
        })
        .catch(() => get().flash('Could not update the company — check your access.'));
    },
    removeCompany: (companyId) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      const scope = currentScope();
      gateway
        .removeCompany(companyId)
        .then(() => {
          if (!scopeStillCurrent(scope)) return;
          set((s) => { s.companies = s.companies.filter((x) => x.id !== companyId); });
          get().flash('Company removed.');
        })
        .catch(() => get().flash('Could not remove the company — check your access.'));
    },
    issueDecision: (input) => {
      if (!gateway) {
        get().flash('Issuing decisions needs the server.');
        if (input.publish) emitGuideOutcome('decision-publish-failed');
        return;
      }
      const gw = gateway;
      const scope = currentScope();
      // The in-app guide's Publish step waits while ANY publish of its run is on its way: a second
      // publish's quick failure must not end the wait for one still pending. Each publish carries the
      // guide run it was sent under, so a late reply cannot finish a later run (a replay), and is counted
      // per scope and run, so a publish left pending in a project the person has left cannot hold back
      // the current project's failure. A reply that lands after the project or person changed is not
      // about the guide now on screen.
      const guideRun = guideRunToken();
      const pendingKey = `${scope.projectId}:${scope.generation}:${guideRun}`;
      const inFlight = () => decisionPublishesInFlight.get(pendingKey) ?? 0;
      if (input.publish) decisionPublishesInFlight.set(pendingKey, inFlight() + 1);
      const reportPublish = (ok: boolean) => {
        if (!input.publish) return;
        const left = inFlight() - 1;
        if (left > 0) decisionPublishesInFlight.set(pendingKey, left);
        else decisionPublishesInFlight.delete(pendingKey);
        if (!scopeStillCurrent(scope)) return;
        if (ok) emitGuideOutcome('decision-published', null, guideRun);
        else if (left <= 0) emitGuideOutcome('decision-publish-failed', null, guideRun);
      };
      // Upload any captured option photos first, then create with their urls.
      void (async () => {
        try {
          const options = await Promise.all(
            input.options.map(async ({ photo, ...o }) => {
              if (!photo) return o;
              const up = await gw.uploadMedia({ kind: 'decision', mime: photo.mime, data: photo.data });
              return { ...o, photoUrl: up.url };
            }),
          );
          const lease = beginSnapshotLease(scope); // gate round 11: before the create request
          // Phase 6 task 4b — the decider designation travels with the create; omitted fields
          // keep the server default ('client'), byte-identical legacy behaviour.
          const snap = await gw.createDecision(
            {
              title: input.title,
              nodeId: input.nodeId,
              room: input.room,
              options,
              publish: input.publish,
              ...(input.deciderKind ? { deciderKind: input.deciderKind } : {}),
              ...(input.deciderMembershipId ? { deciderMembershipId: input.deciderMembershipId } : {}),
            },
            newIdempotencyKey(),
          );
          const record = input.deciderKind === 'none';
          // `superseded` is returned before the project check, so a wrong-project reply a newer pull
          // overtook is still not a published decision
          const accepted = acceptSnapshot(snap, lease);
          const result = accepted === 'superseded' && snap.project.id !== lease.scope.projectId ? 'invalid-project' : accepted;
          consumeSnapshotResult(
            result,
            input.publish
              ? record
                ? `Issue recorded: ${input.title} — filed for the team; no approval is required.`
                : !input.deciderKind || input.deciderKind === 'client'
                  ? `Decision issued: ${input.title} — the client has been asked to choose.`
                  : `Decision issued: ${input.title} — the decider has been asked to choose.`
              : `Draft saved: ${input.title} — visible only to you until you publish it.`,
            lease.scope,
          );
          // the guide teaches putting choices to a decider: a record-only issue is not that task
          reportPublish(!record && (result === 'applied' || result === 'superseded'));
        } catch {
          reportPublish(false);
          // gate round 12: a failure that lands after a project switch must not toast
          // into the new project (the same stale-toast rule as the success path).
          if (scopeStillCurrent(scope)) get().flash(input.publish ? 'Could not issue the decision — check your access and try again.' : 'Could not save the draft — check your access and try again.');
        }
      })();
    },
    updateDecisionDraft: (decisionId, input) => {
      const d = get().decisions.find((x) => x.id === decisionId);
      if (!d?.draft) return Promise.resolve(false);
      if (!gateway) {
        get().flash('Editing drafts needs the server.');
        return Promise.resolve(false);
      }
      return runRemote(
        () => gateway!.updateDecisionDraft(decisionId, input, newIdempotencyKey()),
        input.deciderKind === 'none'
          ? `Draft converted to a record: ${d.title} — no approval will be required.`
          : `Draft updated: ${d.title}.`,
      );
    },
    publishDecision: (decisionId) => {
      const d = get().decisions.find((x) => x.id === decisionId);
      if (!d) return;
      // API mode: the server flips publishedAt, notifies the decider, and returns a fresh snapshot.
      if (gateway) {
        const publishedMsg =
          d.deciderKind === 'none'
            ? `Published: ${d.title} — recorded for the team; no approval required.`
            : d.deciderKind && d.deciderKind !== 'client'
              ? `Published: ${d.title} — the decider has been asked to choose.`
              : `Published: ${d.title} — the client has been asked to choose.`;
        runRemote(() => gateway!.publishDecision(decisionId, newIdempotencyKey()), publishedMsg);
        return;
      }
      // Demo (no server): flip the draft live locally and raise the client's notification,
      // so the whole "hold then publish" flow is demoable offline.
      set((s) => {
        const row = s.decisions.find((x) => x.id === decisionId);
        if (!row || !row.draft) return;
        row.draft = false;
        s.notifications.unshift({ text: `Decision awaiting approval: ${row.title}`, time: 'just now', color: '#C08A2D', decisionId: row.id });
      });
      get().flash(`Published: ${d.title} — the client has been asked to choose.`);
    },
    addLocationNode: async (input) => {
      if (!gateway) {
        get().flash(LOC.needsServer[get().lang]);
        return null;
      }
      const before = new Set(get().nodes.map((n) => n.id));
      const scope = currentScope();
      // #704 redesign — exactly-once across tabs and reloads is the server's (#705: a name already held
      // under the parent names that place, whatever the key); this tab only keeps its unsettled creates'
      // keys in memory (`nodeCreatePending`). The create is sent through the gateway live when the
      // action started, and the reply is bound to the user and project that sent it: a reply landing
      // after either changed is dropped, never toasted or returned.
      const body = { name: input.name.trim(), kind: input.kind, parentId: input.parentId ?? null, publish: input.publish ?? true };
      const identity = `${sessionSub()}|${get().sessionUserId ?? ''}`;
      const sentBySameUser = () => `${sessionSub()}|${get().sessionUserId ?? ''}` === identity;
      const gw = gateway;
      // one key per user and exact body, kept in this project's data (`nodeCreatePending`, torn down on
      // a switch or sign-out): a retry after a lost reply replays on the server (#700's ledger) instead
      // of adding a sibling. In memory only.
      const intent = JSON.stringify([identity, body.parentId, body.kind, body.name, body.publish]);
      // #704 Codex 4178462360 — overlapping sends of one intent share the key, which is kept until the
      // LAST of them settles. It is retired only when the create is CONFIRMED in this tab's tree: an
      // applied reply, or (for a reply that was superseded or dropped) a later read that shows the place
      // the server named (shadow on 441bb0c; the labour-onboarding rule). A failed send keeps it, as
      // its outcome is unknown: the retry replays under it (Codex 4178318908 for the rest).
      const sameNamed = () => get().nodes.filter((n) => n.parentId === body.parentId && n.kind === body.kind && n.name === body.name).length;
      const held = get().nodeCreatePending[intent];
      const confirmed = held && held.inflight === 0 && held.awaiting !== null && (
        held.awaiting
          ? get().nodes.some((n) => n.id === held.awaiting)
          // #704 Codex 4178633896 — no place was named (a server before #703): a read showing more places
          // of this name and kind under the parent than before the send confirms it
          : sameNamed() > held.sameNamedBefore
      );
      if (confirmed) set((s) => { delete s.nodeCreatePending[intent]; }); // the earlier create is confirmed: a new one
      const key = get().nodeCreatePending[intent]?.key ?? newIdempotencyKey();
      set((s) => {
        const p = s.nodeCreatePending[intent];
        if (p && p.key === key) p.inflight += 1;
        else s.nodeCreatePending[intent] = { key, inflight: 1, failed: false, awaiting: null, sameNamedBefore: sameNamed() };
      });
      const settle = (outcome: 'confirmed' | 'unconfirmed' | 'failed', placeId?: string) => set((s) => {
        const p = s.nodeCreatePending[intent];
        if (!p || p.key !== key) return; // torn down with the scope, or a newer intent's
        p.inflight -= 1;
        if (outcome === 'failed') p.failed = true;
        if (outcome === 'unconfirmed') p.awaiting = placeId ?? p.awaiting ?? '';
        if (outcome === 'confirmed') p.awaiting = null;
        if (p.inflight > 0) return;
        if (p.failed || p.awaiting !== null) p.failed = false; // kept: the retry replays under it
        else delete s.nodeCreatePending[intent];
      });
      try {
        const lease = beginSnapshotLease(scope); // gate round 11: before the create request
        let snap: NodeCreatedSnapshot;
        try {
          snap = await gw.createNode(body, key);
        } catch (e) {
          settle('failed');
          throw e;
        }
        if (!sentBySameUser()) { settle('unconfirmed', snap.createdNodeId); return null; }
        const result = acceptSnapshot(snap, lease);
        settle(result === 'applied' ? 'confirmed' : 'unconfirmed', snap.createdNodeId);
        if (result !== 'applied') {
          // a newer refresh owns the tree (superseded) or the payload was wrong-project;
          // don't claim success or return a node id the current tree may not reflect.
          // gate round 12/13: on superseded the node WAS created — record a command
          // reconcile requirement so it lands (or exposes Retry) even if the newer
          // refresh fails; on wrong-project, recover.
          if (result === 'superseded') scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq });
          else if (result === 'invalid-project') void requestFreshSnapshot();
          return null;
        }
        get().flash(LOC.added(body.kind, body.name, get().lang));
        // the server names the place (#703) — the one it made, or (#705) the one already holding the
        // name, which was in the tree before: never pick it by name or by what is new. A server without
        // the field: the node that was not in the tree before.
        const nodes = get().nodes;
        if (snap.createdNodeId) return nodes.some((n) => n.id === snap.createdNodeId) ? snap.createdNodeId : null;
        return nodes.find((n) => !before.has(n.id) && n.name === body.name && n.kind === body.kind)?.id ?? null;
      } catch {
        // gate round 12: a failure landing after a switch (of project or of user) must not toast.
        if (scopeStillCurrent(scope) && sentBySameUser()) get().flash(LOC.failed[get().lang]);
        return null;
      }
    },
    renameNode: (nodeId, name) => {
      if (!gateway) {
        get().flash(LOC.needsServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.renameNode(nodeId, name), () => PLT.renamed(name, get().lang), undefined, () => DTX.unreachable[get().lang]);
    },
    publishNode: (nodeId) => {
      const node = get().nodes.find((n) => n.id === nodeId);
      if (!node || !node.draft) return;
      // API mode: the server flips the whole branch (subtree + draft ancestors) live and
      // returns a fresh snapshot — the location becomes visible to every role at once.
      if (gateway) {
        runRemote(() => gateway!.publishNode(nodeId), `Published location: ${node.name} — now visible to the team.`);
        return;
      }
      // Demo (no server): flip the branch live locally so the draft→publish flow is demoable.
      // Matches the server's cascade — the node, everything below it, and any draft ancestor
      // (so no published child is ever left hanging off a still-hidden parent).
      set((s) => {
        const branch = new Set<string>([...subtreeIds(s.nodes, nodeId), ...ancestorIds(s.nodes, nodeId)]);
        for (const n of s.nodes) if (branch.has(n.id) && n.draft) n.draft = false;
        s.notifications.unshift({ text: `New location added: ${node.name}`, time: 'just now', color: '#C08A2D' });
      });
      get().flash(`Published location: ${node.name} — now visible to the team.`);
    },
    deleteNode: (nodeId) => {
      if (!gateway) {
        get().flash(LOC.needsServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.deleteNode(nodeId), () => PLT.removed[get().lang], (why) => PLT.deleteRefused(why, get().lang), () => DTX.unreachable[get().lang]);
    },
    createActivity: (input) => {
      if (!gateway) {
        get().flash(SCT.planningNeedsServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.createActivity(input, newIdempotencyKey()), () => SCX.planned(input.name, get().lang), undefined, () => DTX.unreachable[get().lang]);
    },
    updateActivity: (activityId, input) => {
      if (!gateway) {
        get().flash(SCT.planningNeedsServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.updateActivity(activityId, input, newIdempotencyKey()), () => SCT.updated[get().lang], undefined, () => DTX.unreachable[get().lang]);
    },
    deleteActivity: (activityId) => {
      if (!gateway) {
        get().flash(SCT.planningNeedsServer[get().lang]);
        return Promise.resolve(false);
      }
      return runRemote(() => gateway!.deleteActivity(activityId, newIdempotencyKey()), () => SCT.removed[get().lang], (why) => SCX.deleteRefused(why, get().lang), () => DTX.unreachable[get().lang]);
    },
    // Task 6: a manual readiness exception — attributable, reasoned, expiring (server records it)
    overrideGate: (activityId, input) => {
      if (!gateway) {
        get().flash(SCT.overridesNeedServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.overrideGate(activityId, input, newIdempotencyKey()), () => SCT.overrideRecorded[get().lang], undefined, () => DTX.unreachable[get().lang]);
    },
    revokeOverride: (activityId, overrideId) => {
      if (!gateway) {
        get().flash(SCT.overridesNeedServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.revokeOverride(activityId, overrideId, newIdempotencyKey()), () => SCT.overrideRevoked[get().lang], undefined, () => DTX.unreachable[get().lang]);
    },
    createPhase: (name) => {
      if (!gateway) {
        get().flash(SCT.planningNeedsServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.createPhase({ name }, newIdempotencyKey()), () => SCX.phaseAdded(name, get().lang), undefined, () => DTX.unreachable[get().lang]);
    },
    deletePhase: (phaseId) => {
      if (!gateway) {
        get().flash(SCT.planningNeedsServer[get().lang]);
        return;
      }
      runRemote(() => gateway!.deletePhase(phaseId, newIdempotencyKey()), () => SCT.phaseRemoved[get().lang], (why) => SCX.phaseRefused(why, get().lang), () => DTX.unreachable[get().lang]);
    },
    issueChecklist: (input) => {
      if (!gateway) {
        get().flash('Issuing checklists needs the server.');
        emitGuideOutcome('checklist-issue-failed');
        return;
      }
      // not `runRemote`: the guide needs the snapshot's verdict, and an `invalid-project` answer is not
      // an issued checklist (the same handling as `runRemote` otherwise)
      const lease = beginSnapshotLease(currentScope());
      gateway
        .createInspection(input)
        .then((snap) => {
          // `superseded` is returned before the project check, so a delayed wrong-project reply that a
          // newer pull overtook is still not an issued checklist
          const accepted = acceptSnapshot(snap, lease);
          const result = accepted === 'superseded' && snap.project.id !== lease.scope.projectId ? 'invalid-project' : accepted;
          consumeSnapshotResult(result, `Checklist issued: ${input.title} — the engineer has been notified.`, lease.scope);
          // a reply that lands after the project or person changed is not about the guide now on screen
          if (scopeStillCurrent(lease.scope)) emitGuideOutcome(result === 'applied' || result === 'superseded' ? 'checklist-issued' : 'checklist-issue-failed');
        })
        .catch(() => {
          if (!scopeStillCurrent(lease.scope)) return;
          emitGuideOutcome('checklist-issue-failed');
          get().flash('Could not reach the server — please try again.');
        });
    },
    startDailyLog: () => {
      if (!gateway) {
        get().flash(DLT.startNeedsServer[get().lang]);
        return;
      }
      // a start already on its way (queued, or committed but not yet read back) is never queued twice
      if (dailyLogCommandInFlight(get())) {
        get().flash(DLT.startInFlight[get().lang]);
        return;
      }
      // Task 10 correction round 2 (finding 1): WRITE-AHEAD — the op + its key are persisted to the
      // durable outbox before the network call (online or offline), so a lost/uncertain response never
      // strands the command without its key; a retry or reload replays the SAME op under the SAME key.
      const key = newIdempotencyKey();
      const lang = get().lang;
      runWriteAhead({ t: 'startDailyLog', idempotencyKey: key }, DLC.start.en, () => DLT.started[get().lang], DLX.savedOffline(DLC.start[lang], lang));
    },
    addSiteMaterial: (input) => {
      if (!gateway) {
        get().flash(DLT.materialNeedsServer[get().lang]);
        return;
      }
      const key = newIdempotencyKey();
      const lang = get().lang;
      runWriteAhead({ t: 'addSiteMaterial', input, idempotencyKey: key }, DLC.material.en, () => DLX.materialRecorded(input.name, get().lang), DLX.savedOffline(DLC.material[lang], lang));
    },
    loadTeam: () => {
      if (!gateway) return Promise.resolve(false);
      // capture the SCOPE this request is FOR — an id-only pin would wrongly apply
      // an A-scoped reply after switching A→B→A; the generation catches that too
      const scope = currentScope();
      return gateway
        .listMembers()
        .then((m) => { set((s) => {
          if (!isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope)) return;
          s.members = m;
        }); return true; })
        .catch(() => false);
    },
    // Phase 6 task 4d-ii-b / B6 — the three member commands go through `dispatchMemberAct`: one request per
    // act in flight; the act's key minted on the first attempt and reused on the user's retry after a lost
    // response, so the server's ledger runs it once; a confirmed success or a terminal refusal settles
    // exactly the key that was sent, so the next identical act is a NEW act under a NEW key. A distinct act
    // (another member, another role, another project) always has its own key. The act is bound to the FULL
    // scope of the attempt (project + generation), never read again when the response arrives, so a later
    // identity on the same project is neither blocked by nor touched by this one's requests.
    addMember: (input) => {
      const g = gateway;
      // #482 step 3c — the team guide's Add ends on this add's own answer (the run it was pressed under)
      const guideRun = guideRunToken();
      const reportAdd = (ok: boolean) => emitGuideOutcome(ok ? 'member-added' : 'member-add-failed', null, guideRun);
      if (!g) {
        get().flash('Managing the team needs the server.');
        reportAdd(false);
        return;
      }
      const boundAdd = memberAct(currentScope(), addMemberAct(input));
      const sent = dispatchMemberAct(
        addMemberAct(input),
        'Adding ' + input.name,
        (key) => {
          addRunsInFlight.set(boundAdd, guideRun);
          return g.addMember(input, key).finally(() => { if (addRunsInFlight.get(boundAdd) === guideRun) addRunsInFlight.delete(boundAdd); });
        },
        () => { get().loadTeam(); get().flash(input.name + ' added to the team.'); reportAdd(true); },
        () => {
          get().flash('Could not add the member — check the details / your access.');
          // another add pressed in this run is still on its way (this one's entry is already cleared): its answer decides
          if (![...addRunsInFlight.values()].includes(guideRun)) reportAdd(false);
        },
      );
      // the same add already on its way: pressed in this run, its own answer tells the guide; pressed before it, that
      // answer is not this run's
      if (!sent && addRunsInFlight.get(boundAdd) !== guideRun) reportAdd(false);
    },
    updateMemberRole: (userId, role, discipline) => {
      const g = gateway;
      if (!g) return;
      dispatchMemberAct(
        `role:${userId}:${role}:${discipline ?? ''}`,
        'Changing the role',
        (key) => g.updateMemberRole(userId, role, discipline, key),
        () => { get().loadTeam(); },
        () => { get().flash('Could not change the role.'); },
      );
    },
    removeMember: (userId) => {
      const g = gateway;
      if (!g) return;
      dispatchMemberAct(
        `remove:${userId}`,
        'Removing the member',
        (key) => g.removeMember(userId, key),
        () => { get().loadTeam(); get().flash('Member removed.'); },
        () => { get().flash('Could not remove the member.'); },
      );
    },
    loadOrgMembers: (orgId) => {
      if (!gateway) return;
      const tok = get().sessionToken; // session-scoped: drop replies after sign-out / re-auth
      gateway.listOrgMembers(orgId).then((m) => set((s) => { if (s.sessionToken === tok) s.orgMembers = m; })).catch(() => set((s) => { s.orgMembers = []; }));
    },
    loadOrgModules: (orgId) => {
      if (!gateway) return;
      const tok = get().sessionToken;
      gateway.listModules(orgId).then((m) => set((s) => { if (s.sessionToken === tok) s.orgModules = m; })).catch(() => set((s) => { s.orgModules = []; }));
    },
    loadOrgTemplates: (orgId) => {
      if (!gateway) return;
      const tok = get().sessionToken;
      gateway.listTemplates(orgId).then((t) => set((s) => { if (s.sessionToken === tok) s.orgTemplates = t; })).catch(() => set((s) => { s.orgTemplates = []; }));
    },
    saveProjectAsTemplate: (name) => {
      const orgId = get().memberships.find((m) => m.projectId === get().activeProjectId)?.orgId ?? get().myOrgs[0]?.id;
      if (!gateway || !orgId) {
        get().flash('Saving templates needs the server.');
        return;
      }
      gateway
        .createTemplate(orgId, { name, fromProject: get().activeProjectId })
        .then((t) => {
          set((s) => { s.orgTemplates = [...s.orgTemplates.filter((x) => x.id !== t.id), t]; });
          get().flash(`Saved template "${name}" — pick it under Start from when creating your next project.`);
        })
        .catch(() => get().flash('Could not save the template — check your access and try again.'));
    },
    saveZoneAsModule: (zoneId, zoneName) => {
      // the module lands in the org library — resolve the active project's org
      const orgId = get().memberships.find((m) => m.projectId === get().activeProjectId)?.orgId ?? get().myOrgs[0]?.id;
      if (!gateway || !orgId) {
        get().flash('Saving modules needs the server.');
        return;
      }
      gateway
        .createModule(orgId, { name: zoneName, category: 'space', fromProject: get().activeProjectId, fromNodeId: zoneId })
        .then((m) => {
          set((s) => { s.orgModules = [...s.orgModules.filter((x) => x.id !== m.id), m]; });
          get().flash(`Saved "${zoneName}" as a module — pick it when creating your next project.`);
        })
        .catch(() => get().flash('Could not save the module — check your access and try again.'));
    },
    addOrgMember: (orgId, input) => {
      if (!gateway) {
        get().flash('Managing the org roster needs the server.');
        return;
      }
      gateway
        .addOrgMember(orgId, input)
        .then(() => { get().loadOrgMembers(orgId); get().flash(input.name + ' added as org ' + input.role + '.'); })
        .catch(() => get().flash('Could not add to the roster — check the details / your access.'));
    },
    updateOrgMemberRole: (orgId, userId, role) => {
      if (!gateway) return;
      gateway
        .updateOrgMemberRole(orgId, userId, role)
        .then(() => { get().loadOrgMembers(orgId); get().flash('Org role changed to ' + role + '.'); })
        .catch(() => get().flash('Could not change the role — the org must keep at least one owner.'));
    },
    correctInvitationEmail: (orgId, userId, email) => {
      if (!gateway) return;
      const normalized = email.trim().toLowerCase();
      gateway
        .correctInvitationEmail(orgId, userId, normalized)
        .then(() => { get().loadOrgMembers(orgId); get().flash('Invitation email corrected.'); })
        .catch(() => get().flash('Could not correct the email — it may already be active or in use.'));
    },
    removeOrgMember: (orgId, userId) => {
      if (!gateway) return;
      gateway
        .removeOrgMember(orgId, userId)
        .then(() => { get().loadOrgMembers(orgId); get().flash('Removed from the org roster.'); })
        .catch(() => get().flash('Could not remove — you can’t remove yourself or the last owner.'));
    },

    // ---- schedule ----
    startActivity: (id) => {
      // Task 10 (Module 4): one key for the online call AND the queued op — a lost-response retry or
      // an offline replay reaches the ledger under the SAME key, so the start applies exactly once.
      const startKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'startActivity', activityId: id, idempotencyKey: startKey }, 'Start ' + id, () => gateway!.startActivity(id, startKey), () => SCT.started[get().lang], DLX.savedOffline(SCX.startCommand(id, get().lang), get().lang))) return;
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'in-progress';
          a.as = s.todayDay;
        }
      });
      get().flash(SCT.started[get().lang]);
    },
    completeActivity: (id) => {
      // Task 5: completion is a CLAIM — the activity parks in awaiting-signoff and
      // only the PMC's approval of the linked closing inspection makes it done
      const completeKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'completeActivity', activityId: id, idempotencyKey: completeKey }, 'Complete ' + id, () => gateway!.completeActivity(id, completeKey), () => SCT.claimed[get().lang], DLX.savedOffline(SCX.completeCommand(id, get().lang), get().lang))) return;
      const act = get().activities.find((a) => a.id === id);
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'awaiting-signoff';
          a.ae = s.todayDay;
        }
        // demo parity with the server: a LINKED, item-bearing closing review appears
        // in the PMC queue; approving it (below) is what completes the activity
        const nums = s.reviews.map((r) => Number(/^INSP-(\d+)$/.exec(r.id)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
        const closingId = `INSP-${(nums.length ? Math.max(...nums) : 21) + 1}`;
        s.reviews.push({
          id: closingId,
          title: 'Closing inspection: ' + (act ? act.name : id),
          zone: act?.zone ?? '',
          // the closing review inherits the activity's FILED location, not just its free-text
          // zone — otherwise every generated closing inspection reads as unplaced on the
          // review screen even when the activity it closes sits on the location tree
          ...(act?.nodeId ? { nodeId: act.nodeId } : {}),
          by: 'You (demo)',
          date: 'today',
          decided: false,
          closing: true,
          activityId: id,
          activityName: act?.name,
          items: [{ name: 'Work complete and acceptable', result: 'PASS', swatch: 'concrete', note: '', rejected: false }],
        });
        s.notifications.unshift({ text: 'Sign-off requested: ' + (act ? act.name : id), time: 'just now', color: '#C08A2D' });
      });
      get().flash(SCT.claimed[get().lang]);
    },

    // ---- daily log (phone = attendance device) ----
    checkIn: () => {
      if (!get().dailyLog) {
        get().flash(DLT.noLog[get().lang]);
        return;
      }
      // #482 D13 — the real time of the tap, on the project's clock (it was a fixed "8:12 AM")
      const checkinTime = checkinClock(get().timeZone);
      set((s) => {
        if (!s.dailyLog) return;
        s.dailyLog.checkedIn = true;
        s.dailyLog.checkinTime = checkinTime;
        recordDailyLogDraft(s, (d) => { d.checkIn = { checkedIn: true, checkinTime }; });
      });
      persistDailyLogDraft();
      get().record('Check-in ' + checkinTime);
      // the site named in the toast is the LIVE project's, never seeded copy (Phase 0 Task 7)
      get().flash(get().online ? DLX.checkedIn(get().location || get().short, get().lang) : DLT.checkedInOffline[get().lang]);
    },
    checkOut: () => {
      set((s) => {
        if (!s.dailyLog) return;
        s.dailyLog.checkedIn = false;
        s.dailyLog.checkinTime = null;
        recordDailyLogDraft(s, (d) => { d.checkIn = { checkedIn: false, checkinTime: null }; });
      });
      persistDailyLogDraft();
      get().flash(DLT.checkedOut[get().lang]);
    },
    scanWorker: () => {
      // demo action tied to the seeded Helper row — a project with an empty crew has no row 4
      const helper = get().dailyLog?.crew[4];
      if (!helper) {
        get().flash(DLT.noCrewRows[get().lang]);
        return;
      }
      set((s) => {
        const c = s.dailyLog?.crew[4];
        if (!c) return;
        c.count += 1;
        recordDraftCrew(s, 4, c.count);
      });
      persistDailyLogDraft();
      get().record('QR check-in · Helper');
      get().flash(DLT.qrScanned[get().lang]);
    },
    confirmCrew: () => {
      set((s) => {
        recordDailyLogDraft(s, (d) => { d.crewConfirmed = true; });
      });
      persistDailyLogDraft();
    },
    adoptLegacyDailyLogDraft: () => {
      set((s) => {
        // never while a start or send is on its way: the log on screen predates it
        if (dailyLogCommandInFlight(s)) return;
        const adopted = adoptLegacyDraft(s.legacyDailyLogDraft, s.dailyLogDraft, s.dailyLog, s.activeProjectId);
        if (!adopted || !s.dailyLog) return;
        // the log on screen already carries the current draft: lay only what the legacy draft adds
        const mine = draftAppliesTo(s.dailyLogDraft, s.dailyLog, s.activeProjectId) ? s.dailyLogDraft : null;
        const extras = legacyDraftExtras(s.legacyDailyLogDraft!, mine, s.dailyLog);
        s.dailyLog = overlayDailyLogDraft(s.dailyLog, extras, s.activeProjectId).log;
        s.dailyLogDraft = adopted;
        s.legacyDailyLogDraft = null;
        // a server that counts the day's photos counts only photos filed on the log; kept-aside ones never were
        recountDailyLogPhotos(s);
      });
      persistDailyLogDraft();
    },
    discardLegacyDailyLogDraft: () => {
      set((s) => { s.legacyDailyLogDraft = null; });
      persistDailyLogDraft();
    },
    crewStep: (idx, delta) => {
      set((s) => {
        const c = s.dailyLog?.crew[idx];
        if (!c) return; // no log, or a stale index against a replaced crew list
        c.count = Math.max(0, c.count + delta);
        recordDraftCrew(s, idx, c.count);
      });
      persistDailyLogDraft();
    },
    addProgress: () => {
      set((s) => {
        if (!s.dailyLog) return;
        s.dailyLog.progress += 1;
        recordDraftPhoto(s);
      });
      persistDailyLogDraft();
      get().record('Progress photo');
    },
    addProgressPhoto: (dataUrl, nodeId, stamp, pickedIn, pickedForLog, pickedInRun) => {
      // The file was chosen BEFORE the read that produced this data URL, and a project switch
      // (or sign-out, or re-auth) in between makes this photo — and its `photoNode` — belong
      // to a project we have left. Uploading it through whichever gateway is installed now
      // would file A's evidence under B. Same silent drop as every other scope guard here.
      if (pickedIn && !scopeStillCurrent(pickedIn)) return;
      // #482 in-app guide: the run this photo was chosen under, so a late read or reply cannot finish a later run
      const guideRun = pickedInRun ?? guideRunToken();
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) {
        emitGuideOutcome('site-photo-add-failed', null, guideRun);
        get().flash(DLT.photoUnreadable[get().lang]);
        return;
      }
      const [, mime, base64] = m;
      // The day's log this photo was taken for (#482): fixed when it was picked, filed on it, and shown only in
      // THAT log. A replay that lands after the log was sent, or after a refresh brought the next log, still
      // belongs to it, and never adds to the count of a log the server did not file it on.
      const dailyLogId = pickedForLog === undefined ? (get().dailyLog?.id ?? null) : pickedForLog;
      const onPickedLog = (s: AppState): DailyLog | null =>
        s.dailyLog && (s.dailyLog.id ?? null) === dailyLogId ? s.dailyLog : null;
      // what the PHOTO recorded — shared by the server and local-demo paths below, so the
      // demo store mirrors what the server would hold rather than dropping it
      const stamped = stamp ?? {};
      if (gateway) {
        // Location spine: tag the photo with the place it shows, if one was chosen.
        //
        // The stamp is whatever the photo's own EXIF recorded — computed by the caller from
        // bytes it had already read, so nothing async sits between accepting this photo and
        // durably queueing it below. A file that carries no capture metadata contributes no
        // keys here, and the media contract stores nothing rather than something invented.
        //
        // One key per pick (#482): the server stores one photo per (project, key), so a queued upload replayed
        // after its first attempt committed but its reply was lost is the same photo, not a second one.
        const clientKey = newIdempotencyKey();
        const pickSeq = ++photoPickSeq;
        // #482 in-app guide: a live refresh that shows this photo before the upload's answer also finishes the guide
        recordGuidedPhotoPick(guideRun, clientKey);
        const input = {
          kind: 'progress' as const, mime, data: base64, clientKey, ...stamped,
          ...(nodeId ? { nodeId } : {}), ...(dailyLogId ? { dailyLogId } : {}),
        };
        // Phase 8 media offline queue: when offline, show the photo optimistically
        // (local data URL) and queue the upload for replay on reconnect — instead
        // of losing it. Mirrors runRemoteOrQueue for the JSON mutations.
        if (!get().online) {
          const upload: OutboxOp = { t: 'uploadMedia', input };
          set((s) => {
            s.outbox.push(upload);
            s.syncQueue.push('Progress photo');
            const log = onPickedLog(s);
            if (log) {
              log.photos.unshift({ url: dataUrl, clientKey });
              if (log.photoCount === undefined) log.progress += 1;
              else recountDailyLogPhotos(s);
              recordDraftPhoto(s);
            }
          });
          persistDailyLogDraft();
          // the photo's bytes live only in this act: said once it is written, and the guide's step is done only then. One
          // not kept on this phone is still sent from memory but lost on a reload: the guide ends unfinished (offered again
          // later) rather than asking for the same photo twice
          flashSaved(DLT.photoOffline[get().lang], [upload], (stored) => emitGuideOutcome(stored ? 'site-photo-added' : 'site-photo-not-kept', null, guideRun));
          return;
        }
        // raw-DTO reconcile: pin the reply to the scope that uploaded it — a late
        // reply must never land on ANOTHER project's daily log (finding 3)
        const scope = currentScope();
        // counted from the pick until the server's count is seen to hold it, whichever lands first (#482 unit 3)
        if (dailyLogId) set((s) => { s.photoUploadsInFlight.push({ clientKey, dailyLogId, settled: false }); recountDailyLogPhotos(s); });
        const settle = (s: AppState, landed: boolean): void => {
          const at = s.photoUploadsInFlight.findIndex((u) => u.clientKey === clientKey);
          if (at < 0) return;
          if (landed) Object.assign(s.photoUploadsInFlight[at]!, { settled: true, after: snapshotSeq });
          else s.photoUploadsInFlight.splice(at, 1);
          recountDailyLogPhotos(s);
        };
        // sent from this tab and not yet answered: its photo offers no Delete until the answer (Codex 4322715807)
        set((s) => { s.photoUploadsSending.push(clientKey); });
        // #917: the upload is kept on this phone before it is sent, so an answer that is lost is sent again from the row
        // under this same key, and the server stores one photo. A flush does not give the row its op while this tab's
        // send is unanswered. A write that fails or passes its bound is no row: the send goes ahead as before
        const sendGateway = gateway;
        const rowScope = visitPhotoScope(get().sessionToken, get().sessionUserId);
        const rowProject = sendGateway.project;
        sitePhotoSendsDirect.add(clientKey);
        const send = (saved: boolean, release: () => void): void => {
          // refused, or sent with no row kept: the row goes (a row that landed after its bound would send a photo the
          // person was told to pick again). Taken: the row becomes a "sent" marker, so a copy of its op another tab holds
          // settles quietly. Either runs after the put it follows. The send stays this tab's, and its lock held, until
          // that has settled, so no flush in any tab reads the row in between and sends a photo the server already answered
          // A change the phone could not write leaves the row as it was, with the photo's bytes: the send stays this tab's
          // and its lock held, so no flush here or in another tab sends again a photo the server already answered, and the
          // change is made again on the site photo retry until it lands. A tab closed before then leaves the row to be sent
          // again under its key after a reload, and the server answers it the same way (the same photo, or the same
          // refusal, which then settles the row) (Codex 4389428586, Stage 1 r3)
          let rowChange: (() => Promise<void>) | null = null;
          let rowGone: Promise<boolean> = Promise.resolve(true);
          const changeRow = (make: () => Promise<void>): void => { rowChange = make; rowGone = make().then(() => true, () => false); };
          const letRowGo = (): void => changeRow(() => deleteSitePhotoRow(rowScope, rowProject, clientKey));
          const rowSent = (): void => changeRow(() => (sitePhotoStorageAvailable() ? markSitePhotoSent(rowScope, rowProject, clientKey) : Promise.resolve()));
          void sendGateway
            .uploadMedia(input)
            .then((res) => {
              rowSent();
              if (!scopeStillCurrent(scope)) { set((s) => settle(s, true)); return; }
              set((s) => {
                settle(s, true);
                // deleted here before this answer came (a pull had already listed it): it is not listed again
                if (deletedPhotoIds.has(res.id)) return;
                // #482 site photos: the photo list (the Dashboard's and the Site Map's) shows it at once, newest first.
                // A refresh that landed before this reply may already hold it, in the list, the log, or only one of
                // them when the log's read failed; each gets it once.
                // its pick order is recorded even when a refresh already brought it in, so an earlier pick whose reply
                // comes after still goes in behind it (#984)
                photoPickedAt.set(res.id, pickSeq);
                if (!s.photos.some((p) => p.id === res.id) && !s.myDeletablePhotos.some((p) => p.id === res.id)) {
                  // after any photo this device picked later whose reply came back first
                  const at = s.photos.findIndex((p) => (photoPickedAt.get(p.id) ?? 0) < pickSeq);
                  s.photos.splice(at < 0 ? s.photos.length : at, 0, { id: res.id, url: resolveMediaUrl(res.url), kind: 'progress', ...stamped, ...(nodeId ? { nodeId } : {}),
                    // who and when (#482): this viewer, at the time the server recorded it. No role yet: the role the
                    // viewer acts in can come through the org rather than a project membership, and the next snapshot
                    // says the project role, so nothing is claimed here that the server would not say.
                    ...(s.userName ? { by: s.userName } : {}), ...(res.at ? { at: res.at } : {}),
                    // no Delete yet: whether it is the viewer's to delete (the log it went on may be sent by now) is the
                    // server's to say, on the refresh asked for below (Codex 4317884803)
                  });
                  // the snapshot's window is the newest SNAPSHOT_SITE_PHOTO_LIMIT photos, and a new one keeps it exactly that
                  // size (Codex 4322976249). One it drops that the viewer may still delete in their hour moves to their own
                  // list, as the server would send it (Codex 4322459282); a photo deleted here, or one whose upload is
                  // still on its way, is never moved there
                  if (s.photos.length > SNAPSHOT_SITE_PHOTO_LIMIT) {
                    const now = Date.now();
                    const kept = s.photos.slice(SNAPSHOT_SITE_PHOTO_LIMIT).filter((p) => p.deletableUntil !== undefined && sitePhotoDeletable(p, now)
                      && !deletedPhotoIds.has(p.id) && !(p.clientKey && s.photoUploadsSending.includes(p.clientKey)));
                    s.photos.length = SNAPSHOT_SITE_PHOTO_LIMIT;
                    s.myDeletablePhotos = [...kept, ...s.myDeletablePhotos.filter((p) => !kept.some((k) => k.id === p.id))];
                  }
                }
                // another log on screen now: the server holds the photo on its own log, and the next snapshot shows it
                const log = onPickedLog(s);
                // #1167: sent, in its log's draft by its key, so a later sight of it (its marker) adds nothing; kept for
                // that log when another is on show
                if (!log) { if (dailyLogId) confirmSitePhoto(s, clientKey, dailyLogId, rowProject); return; }
                if (log.photos.some((p) => p.id === res.id)) return;
                log.photos.unshift({ id: res.id, url: resolveMediaUrl(res.url) });
                recordDraftSentPhoto(s, clientKey);
                if (log.photoCount === undefined) log.progress += 1;
                recountDailyLogPhotos(s);
              });
              persistDailyLogDraft();
              emitGuideOutcome('site-photo-added', null, guideRun);
              // #482 site photos: the snapshot says until when the new photo is the viewer's to delete
              void requestFreshSnapshot(scope);
              // say what the photo actually carried, not what the feature is called
              get().flash(
                hasStamp(stamped) ? DLT.photoUploadedStamped[get().lang] : DLT.photoUploaded[get().lang],
              );
            }, (err: unknown) => {
              // the upload's own answer only: a fault in handling a yes is never taken for a lost answer
              // #1228: the server's 410 for a photo deleted since an earlier send of this key landed (another tab's replay
              // of this row, in a browser without Web Locks) is settled as a queued photo's 410 is: its row goes, every
              // copy a pull brought in leaves at once, and the server's word on the day is read after this answer
              if (isDeletedPhoto(err)) {
                letRowGo();
                set((s) => settle(s, false));
                if (scopeStillCurrent(scope)) {
                  beginSnapshotLease(scope);
                  set((s) => {
                    if (s.dailyLog) s.dailyLogPhotoCountAfter = snapshotSeq;
                    for (const id of [...s.photos, ...s.myDeletablePhotos].filter((p) => p.clientKey === clientKey).map((p) => p.id)) dropDeletedPhoto(s, id);
                    if (s.dailyLog) s.dailyLog.photos = s.dailyLog.photos.filter((p) => p.clientKey !== clientKey);
                  });
                  scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq });
                }
                emitGuideOutcome('site-photo-added', null, guideRun);
                return;
              }
              // #917: no answer, and the photo is kept on this phone: it is queued by its key, shown and counted from the
              // phone as an offline pick is, and sent again from its row. For a project no longer on screen the row stays,
              // and that project's next flush gives it its op; the person is told it is kept all the same
              if (saved && !isTerminalOutboxError(err)) {
                if (!scopeStillCurrent(scope)) {
                  set((s) => settle(s, false));
                  get().flash(DLT.photoOffline[get().lang]);
                  return;
                }
                set((s) => {
                  s.outbox.push({ t: 'uploadSitePhoto', scope: rowScope, clientKey });
                  s.syncQueue.push('Progress photo');
                  s.sitePhotosKept.push(keptFrom(input));
                  // counted from now on as queued, by its row's log, until the server's count holds it or the queue lets
                  // it go (settle recounts)
                  settle(s, false);
                  const log = onPickedLog(s);
                  // a refresh that landed before this may already show the server's copy (its key in the log's own
                  // list, or on the log's gallery copy): it is not shown or counted again (Codex 4389428620, #1187), as a
                  // yes finding it in the gallery adds nothing. One the photo list alone shows is counted all the same: a
                  // server before the day's count does not count it on the log, as a yes counts it (#1242 r1,
                  // 4410673630); only its data URL is not laid in the gallery beside the server's copy (#1187)
                  const held = log?.myPhotoKeys?.includes(clientKey) || log?.photos.some((p) => p.clientKey === clientKey);
                  if (log && !held && ![...s.photos, ...s.myDeletablePhotos].some((p) => p.clientKey === clientKey)) log.photos.unshift({ url: dataUrl, clientKey });
                  // counted by the queue, as every queued photo is (#1167): never in the draft until its send is confirmed
                  recountDailyLogPhotos(s);
                });
                // (its op is never stored: the row is its record on this phone, written before the send)
                // kept on this phone, as a stored offline pick is: the guide's step is done
                emitGuideOutcome('site-photo-added', null, guideRun);
                get().flash(DLT.photoOffline[get().lang]);
                // sent again from its row on the site photo retry, not left for an unrelated write while the app
                // stays online (Codex 4391469520)
                retrySitePhotos();
                return;
              }
              letRowGo();
              set((s) => settle(s, false));
              emitGuideOutcome('site-photo-add-failed', null, guideRun);
              get().flash(DLT.photoUploadFailed[get().lang]);
            })
            .finally(() => {
              void rowGone.then((done) => {
                const letGo = (): void => { sitePhotoSendsDirect.delete(clientKey); sitePhotoSettles += 1; release(); };
                const make = rowChange;
                // a row never written needs no change: the one try made is enough, and a phone whose database is failing
                // is not asked again for the tab's life (Codex 4391469488)
                if (done || !make || !saved) { letGo(); return; }
                sitePhotoRowChanges.set(clientKey, () => make().then(() => { sitePhotoRowChanges.delete(clientKey); letGo(); }, () => {}));
                retrySitePhotos();
              });
              set((s) => { s.photoUploadsSending = s.photoUploadsSending.filter((k) => k !== clientKey); });
            });
        };
        // with no database on this phone there is nothing to wait for: sent at once, as before. Otherwise the row's lock is
        // taken first, so no other tab gives the row an op while this send is out
        if (!sitePhotoStorageAvailable()) send(false, () => {});
        else {
          // #1201: the person or the project moved while the photo was being kept: nothing is sent with the gateway of a
          // scope left (a departed person's token would still create it). A kept row stays for its own scope, whose next
          // load or flush gives it its op; one not kept is lost, and the person is told to try again
          // A write answered "not kept" may still have landed after its bound: its row goes under the lock, as send(false)'s
          // does, so a photo the person is told to pick again is never sent later too. A kept row is read again once its
          // lock is let go: the scope now current may be its own again (a failed switch, the same person back), whose load
          // skipped it while this tab held the lock (Stage 1 gap-check)
          // A removal the phone could not make keeps the lock, and is made again on the site photo retry until it lands, as a
          // direct send's row change is (#1242 r1, 4410673618)
          const leave = (saved: boolean, release: () => void): void => {
            const letGo = (): void => {
              sitePhotoSendsDirect.delete(clientKey);
              sitePhotoSettles += 1;
              release();
              if (saved) reconcileSitePhotos();
            };
            if (saved) letGo();
            else {
              const drop = (): Promise<void> => deleteSitePhotoRow(rowScope, rowProject, clientKey);
              void drop().then(letGo, () => {
                sitePhotoRowChanges.set(clientKey, () => drop().then(() => { sitePhotoRowChanges.delete(clientKey); letGo(); }, () => {}));
                retrySitePhotos();
              });
            }
            set((s) => { settle(s, false); s.photoUploadsSending = s.photoUploadsSending.filter((k) => k !== clientKey); });
            get().flash(saved ? DLT.photoOffline[get().lang] : DLT.photoUploadFailed[get().lang]);
          };
          void holdSitePhotoLock(rowScope, rowProject, clientKey).then((release) =>
            putSitePhotoRow(rowScope, rowProject, input).then(() => true, () => false).then((saved) => {
              if (scopeStillCurrent(scope) && gateway === sendGateway) send(saved, release);
              else leave(saved, release);
            }));
        }
        return;
      }
      // local demo: keep the data URL as the image source; also place it on the tree
      // (with the chosen node) so the Place view reflects it without a server. The stamp
      // travels here too — the demo is a supported mode, and a record that drops what the
      // photo carried while the UI says it was stamped is the same false claim on a
      // different path.
      set((s) => {
        if (s.dailyLog) {
          s.dailyLog.photos.unshift({ url: dataUrl, ...stamped });
          s.dailyLog.progress += 1;
          recordDraftPhoto(s);
        }
        s.photos.unshift({
          id: `demo-photo-${s.photos.length + 1}`,
          url: dataUrl,
          nodeId: nodeId ?? undefined,
          kind: 'progress',
          ...stamped,
        });
      });
      persistDailyLogDraft();
      get().record('Progress photo');
      emitGuideOutcome('site-photo-added', null, guideRun);
      if (!get().online) {
        get().flash(DLT.photoOffline[get().lang]);
      } else {
        get().flash(
          hasStamp(stamped) ? DLT.photoAddedStamped[get().lang] : DLT.photoAdded[get().lang],
        );
      }
    },
    submitDailyLog: () => {
      // #482: how the send went, for the guide, told by the flush that settles it (as the advice guide's); a send this
      // refuses before it starts is told as failed, so the guide does not wait on it
      const guideRun = guideRunToken();
      const reportSend = (result: ActReport) =>
        emitGuideOutcome(result === 'sent' || result === 'queued' ? 'daily-log-sent' : result === 'failed' ? 'daily-log-send-failed' : 'daily-log-not-kept', null, guideRun);
      const dl = get().dailyLog;
      if (!dl) {
        get().flash(DLT.noLog[get().lang]);
        reportSend('failed');
        return;
      }
      if (!dl.checkedIn) {
        get().flash(DLT.submitNeedsCheckIn[get().lang]);
        reportSend('failed');
        return;
      }
      // a log already sent is never sent again: each send mints a fresh idempotency key, so the
      // server would take a second tap as a second, independent submission
      if (dl.submitted) {
        get().flash(DLT.alreadySent[get().lang]);
        return;
      }
      // a send already on its way (queued, or committed but not yet read back) is never queued twice
      if (dailyLogCommandInFlight(get())) {
        get().flash(DLT.alreadyOnItsWay[get().lang]);
        return;
      }
      // a server that counts the day's photos is sent its own count: photos still uploading or queued are only
      // shown, and count once they land filed on this log, so one that never lands is never stored (#482 unit 3)
      const logPayload = { checkedIn: dl.checkedIn, checkinTime: dl.checkinTime, progress: dl.photoCount ?? dl.progress, crew: dl.crew };
      // Task 10 correction round 2 (finding 1): WRITE-AHEAD — the op + its key are persisted before the
      // network call (online too), so a lost response is retried under the SAME key, submitting once.
      const submitKey = newIdempotencyKey();
      const lang = get().lang;
      if (runWriteAhead({ t: 'submitDailyLog', log: logPayload, idempotencyKey: submitKey }, DLC.submit.en, () => DLT.sent[get().lang], DLX.savedOffline(DLC.submit[lang], lang), [], reportSend)) return;
      set((s) => {
        if (!s.dailyLog) return;
        s.dailyLog.submitted = true;
        s.dailyLogDraft = null; // sent: the log now holds the work the draft carried
      });
      persistDailyLogDraft();
      get().record('Daily log submit');
      get().flash(get().online ? DLT.sent[lang] : DLT.sentOffline[lang]);
      // the demo (no server) records the log sent here, so the guide's step is done
      reportSend('sent');
    },
    flagMismatch: (idx) => {
      const mat = get().dailyLog?.materials[idx];
      if (!mat) return; // no log, or a stale index against a replaced materials list
      const flagKey = newIdempotencyKey();
      // finding 1: WRITE-AHEAD — persist the op + key before the call; a lost response replays the SAME
      // key, flagging exactly once.
      const lang = get().lang;
      if (runWriteAhead({ t: 'flagMismatch', decisionId: mat.decisionId, idempotencyKey: flagKey }, 'Flag ' + mat.decisionId, () => DLT.flagged[get().lang], DLX.savedOffline(`${DLC.flag[lang]} ${mat.decisionId}`, lang))) return;
      set((s) => {
        const m = s.dailyLog?.materials[idx];
        if (m) m.matched = false;
        s.activities.forEach((a) => {
          if (a.decisionId === mat.decisionId) {
            a.gm = 'fail';
            a.status = a.status === 'done' ? a.status : 'blocked';
            a.block = 'Material ≠ approved';
          }
        });
        s.notifications.unshift({ text: 'Material mismatch: ' + mat.name + ' ≠ approved ' + mat.decisionId, time: 'just now', color: '#B23A34' });
      });
      get().record('Material mismatch flag');
      get().flash(DLT.flagged[lang]);
    },
    record: (label) => {
      if (!get().online) set((s) => { s.syncQueue.push(label); });
    },
    toggleOnline: () => {
      const goingOnline = !get().online;
      set((s) => { s.online = goingOnline; });
      if (!goingOnline) {
        // #482 — a write-ahead act the guide waits on now waits for the signal: kept on this phone or not, as offline. One
        // the running flush has taken is told by that flush: its request is out, and the server may still refuse it
        // the same for one still being written: the flush called once it is written sends it and tells it
        for (const [k, watch] of [...actWatches]) if (!flushingKeys.has(k) && !writingKeys.has(k)) watch('pending');
        get().flash(DLT.signalLost[get().lang]);
        return;
      }
      // back online: replay queued API mutations (Phase 8 outbox); else clear demo labels
      if (get().outbox.length) {
        get().flushOutbox();
        return;
      }
      // #917: a site photo kept on this phone has no op until its row is read (Codex 4389428598)
      reconcileSitePhotos();
      if (get().syncQueue.length) {
        const n = get().syncQueue.length;
        set((s) => { s.syncQueue = []; });
        get().flash(DLX.synced(n, get().lang));
      }
    },
    // a photo is queued only once its row holds it and the start it needs (`keepAndQueue`)
    queueSiteVisitAct: (op, offlineMsg) => runWriteAhead(op, 'Site visit', '', offlineMsg, op.t === 'siteVisitAddFile'
      ? [op, ...get().outbox.filter((o) => o.t === 'siteVisitStart' && o.body.id === op.visitId)] : []),
    // the screen's own reads: a sent photo not listed yet, or its kept photos not read. A retry holds nothing: the flush
    // it runs holds only the visits a kept photo may be on
    retrySiteVisits: () => { if (get().online) retryVisitPhotos(); },
    sendSiteVisitAnyway: (visitId) => {
      const key = releaseKey(visitPhotoScope(get().sessionToken, get().sessionUserId), get().activeProjectId, visitId);
      if (!get().siteVisitsSentAnyway.includes(key)) set({ siteVisitsSentAnyway: [...get().siteVisitsSentAnyway, key] });
      void get().flushOutbox();
    },
    flushOutbox: async (opts) => {
      // A flush that did not actually process this call's ops (no gateway, coalesced, or empty) reports
      // `ran:false`/empty so a caller confirming its own ops never mistakes "not run" for "succeeded".
      const notRun = (): OutboxFlushResult => ({ ran: false, scopeMoved: false, succeededKeys: [], droppedKeys: [], pendingKeys: [] });
      if (!gateway) return notRun();
      // a site visit act's word is the Site Visits screen's, never a line here, and it is not in the batch count either
      const own = opts?.ownWord ? new Set(opts.ownWord) : null;
      const okKey = opts?.act && !isSiteVisitOp(opts.act) && 'idempotencyKey' in opts.act ? opts.act.idempotencyKey : undefined;
      if (opts?.okMsg && okKey && !okWaiting.some((w) => w.key === okKey)) okWaiting.push({ okMsg: opts.okMsg, key: okKey, queue: outboxKey() });
      // finding 1 — serialize flushes: a write-ahead command fires a flush per command, so one may be
      // in flight already. Coalesce (mark + return); the in-flight flush re-runs once after it settles,
      // so a command persisted mid-flush is still sent. Idempotency keys make an overlap harmless.
      if (outboxFlushing) { outboxFlushQueued = true; return notRun(); }
      outboxFlushing = true;
      let replayingDecisions = 0;
      let replayScope = '';
      // #482 — what this flush may send: the queue as it starts (narrowed to what it takes once it takes it)
      flushingKeys = new Set(get().outbox.flatMap((o) => ('idempotencyKey' in o && o.idempotencyKey ? [o.idempotencyKey] : [])));
      try {
      // SV2: every kept visit photo's act is put back first, from the phone's own record of it, so a close can never
      // overtake its photo. When that record could not be read (a failed or too slow read), the rest of the queue
      // still goes, but the acts of a visit a photo may still be kept on do not: they wait, in order, for a read that
      // succeeds (Codex 4320690147, 4321084738). Which visits those are comes from the keys kept beside the rows, so a
      // phone keeping no photo holds nothing, and a key left behind holds its own visit alone (Codex 4322430052,
      // 4322700480)
      let holdVisits: ReadonlySet<string> | 'all' | null = null;
      const keptBy = visitPhotoScope(get().sessionToken, get().sessionUserId);
      const keptFor = get().activeProjectId;
      if (storageAvailable()) {
        const readScope = currentScope();
        const readKey = outboxKey();
        const readGateway = gateway;
        const readToken = get().sessionToken;
        let late = false;
        const read = listVisitPhotos(keptBy, keptFor).then(
          (rows) => {
            // a read that came too late, or for a queue no longer on show, puts nothing back: the next flush reads again
            if (late || !scopeStillCurrent(readScope) || outboxKey() !== readKey) return false;
            putBackVisitPhotos(rows);
            return true;
          },
          () => false,
        );
        let timer: ClampedTimer | undefined;
        const waited = new Promise<false>((r) => { timer = setClampedTimeout(() => r(false), VISIT_PHOTO_WAIT_MS); });
        if (!(await Promise.race([read, waited]))) {
          const held = visitsHeldByPhotos(keptBy, keptFor);
          if (held === 'all' || held.size > 0) holdVisits = held;
        }
        timer?.clear();
        late = true;
        // the project, sign-in or queue changed during the read: this call's queue is no longer the one on show, and
        // nothing was taken from it. It stays stored for its own scope (as a flush whose scope moves before its first
        // act leaves it), and the queue now on show is sent by its own flush: this one must not take that queue, nor
        // a snapshot lease for its scope
        if (!scopeStillCurrent(readScope) || outboxKey() !== readKey || gateway !== readGateway || get().sessionToken !== readToken) return notRun();
      }
      // not read: a photo may be waiting whether or not any act is queued, so this is tried again (Codex 4321558423)
      if (holdVisits) retryVisitPhotos();
      // #917: every site photo kept on this phone has its op (rebuilt when the page closed during the send), and the rows
      // are what the Dashboard shows as queued. Read beside this flush, never ahead of it: an op rebuilt here is sent by
      // the flush it asks for
      reconcileSitePhotos();
      // step B2f-1 (#1113 r2 root cause, Codex 4367436925): this flush sends only the acts queued before it waits for
      // their writes, and only once each of those writes has run: the writes running now, then one later attempt for an
      // act none of them stored, sent from memory if that does not store it either (its ask's made record on this phone,
      // #1099 r1 4358186328, #1113 r1 re-check). An act queued during the wait is neither sent early nor held: it is left
      // in the queue for the drain pass this flush runs when it settles, which waits for that act's write the same way
      // The acts are pinned as the objects in the queue (two keyless acts can be alike): one changed during the wait is
      // a new object, and waits for the drain pass too
      let waited: ReadonlySet<OutboxOp> | null = null;
      if (aheadWrites.size > 0 || aheadUnsaved.size > 0) {
        const before = new Set(get().outbox);
        waited = before;
        const here = madeHere();
        const waitGateway = gateway;
        await Promise.all([...aheadWrites]);
        if ([...before].some((o) => aheadUnsaved.has(aheadId(o)))) await writeAhead([]);
        // a scope move meanwhile leaves this flush's queue to its own scope
        if (!here() || gateway !== waitGateway) return notRun();
      }
      const heldVisits: OutboxOp[] = [];
      // taken: the queue's head up to the first act queued during the wait (the rest go to the drain pass)
      const queued = get().outbox;
      const lateAt = waited ? queued.findIndex((o) => !waited.has(o)) : -1;
      if (lateAt >= 0) outboxFlushQueued = true;
      const ops = lateAt >= 0 ? queued.slice(0, lateAt) : queued.slice();
      flushingKeys = new Set(ops.flatMap((o) => ('idempotencyKey' in o && o.idempotencyKey ? [o.idempotencyKey] : [])));
      // #482 (Codex 4403818412) — a review decision this flush replays is on its way until the flush ends: its row leaves
      // the queue before the flush's snapshot is taken, and the review guide must not point at that review meanwhile
      replayingDecisions = ops.filter((o) => o.t === 'decideReview').length;
      replayScope = reviewSendingScope(get());
      if (replayingDecisions > 0) set((s) => { for (let k = 0; k < replayingDecisions; k++) s.reviewDecisionsSending.push(replayScope); });
      // how many ops this flush took from the outbox: the prefix replaced below (a refused site visit start may
      // take its own acts out of `ops` as it goes)
      const taken = ops.length;
      // the acts this flush took, as taken: a scope move writes each stored lane without them, by identity (a visit
      // photo's act is in neither stored lane, Codex 4321998480)
      const flushed = ops.slice();
      // the visits whose photo's row this flush could not read or update while sending it: held from then on, like the
      // visits a failed read holds, and never a stall of the rest of the queue (coordinator, sv2-unit-h)
      const stuck = new Set<string>();
      const sentAnyway = (op: OutboxOp): boolean => isSiteVisitOp(op) && get().siteVisitsSentAnyway.includes(releaseKey(keptBy, keptFor, siteVisitOf(op)));
      const heldFor = (op: OutboxOp): boolean => isSiteVisitOp(op)
        && ((!!holdVisits && (holdVisits === 'all' || holdVisits.has(siteVisitOf(op)))) || stuck.has(siteVisitOf(op)));
      // Send anyway releases a held visit's other acts, never its photos: a photo's act is sent only from its row, which
      // could not be read, so releasing it would only fail again
      const holds = (op: OutboxOp): boolean => heldFor(op) && (op.t === 'siteVisitAddFile' || !sentAnyway(op));
      // what this flush holds, for the screen to say so and offer to send anyway: a visit already sent anyway is not
      // offered again (its photo still waits, and shows as waiting)
      const offered = (list: OutboxOp[]): string[] => [...new Set(list.flatMap((o) => (isSiteVisitOp(o) && heldFor(o) && !sentAnyway(o) ? [siteVisitOf(o)] : [])))];
      const heldNow = offered(ops);
      if (heldNow.length > 0 || get().siteVisitsHeld) {
        set({ siteVisitsHeld: heldNow.length > 0 ? { project: keptFor, generation: get().projectScopeGeneration, visits: heldNow } : null });
      }
      if (ops.length === 0) return { ran: true, scopeMoved: false, succeededKeys: [], droppedKeys: [], pendingKeys: [] };
      // gate round-2 finding 2: the flush is about to change the durable truth
      // (confirmed uploads delete rows, terminal failures dead-letter them) — any
      // reconciliation already in flight read the PRE-flush world and must not apply
      invalidateEvidenceReconciles();
      visitPhotoEpoch += 1; visitPhotoFlushes += 1; // and a visit photo reconciliation read before it (SV2)
      // Pin EVERYTHING this flush uses to the moment it started (Codex gate
      // finding 1): the gateway instance, the (project, generation) scope, the
      // session, and the storage key the queue belongs to. The module-level
      // `gateway` is swapped on a project switch — reading it live mid-loop
      // would replay project A's remaining operations INTO project B.
      const flushGateway = gateway;
      const flushedBy = get().sessionUserId; // whose queued work this flush replays (the outbox is scoped to them)
      const flushScope = currentScope();
      const flushToken = get().sessionToken;
      const flushKey = outboxKey();
      // whose queue this is: a keyless act of an earlier release is sent under a key made from it and them (legacyActKey)
      const flushPerson = queueKeyScopes.get(flushKey)?.visitPhoto ?? 'anon';
      // gate round 11: take the ordering lease NOW, before replaying the first op.
      // The reconcile snapshot below is applied through the coordinator against this
      // lease, so if a newer socket/mutation lease begins while a replay is in flight
      // the flush's (older) snapshot is `superseded` and discarded instead of stomping
      // the newer checklist. This is the reviewer's manifestation #1 — the core bug.
      // A batch of site visit acts alone reads no snapshot (each answer goes to its own screen), so it takes no
      // lease: one taken and never used would discard a snapshot already in flight as superseded.
      // A pull already on its way when the lease is taken lands superseded: if this flush then applies no snapshot of its
      // own (its first act fails for now, before any snapshot came back), that pull is asked for again, or the project
      // could stay loading with nothing coming (Codex 4278908026, #908)
      const pullSuperseded = coordinatorFor(flushScope).refreshInFlight;
      const flushLease = ops.some((o) => !isSiteVisitOp(o)) ? beginSnapshotLease(flushScope) : null;

      // Replay in order, one at a time, committing progress as we go so a later failure
      // never re-runs an op that already succeeded. A permanently-rejected op (terminal
      // 4xx) is dropped instead of wedging the queue forever; a transient failure stops
      // the flush and keeps that op (and everything after it) for the next reconnect.
      // Track each op's OUTCOME by idempotency key (when it has one) so the caller can classify its own
      // commands: queue absence alone can't tell a succeeded op from a terminally-dropped 4xx.
      const keyOf = (op: OutboxOp): string | undefined => ('idempotencyKey' in op ? op.idempotencyKey : undefined);
      const chainActLabel = (op: OutboxOp & { decisionId: string }): string =>
        ({ forwardDecision: 'Forward', countersignDecision: 'Countersign', disagreeDecision: 'Disagree', resolveStrandedCountersign: 'Resolve' } as Record<string, string>)[op.t] + ' ' + op.decisionId;
      const succeededKeys: string[] = [];
      const droppedKeys: string[] = [];
      // Phase 3 Task 7 (correction 2/3) — the RESOLVED pilot-materials COALESCE keys (succeeded OR
      // terminally dropped, i.e. the op LEFT the outbox) are cleared from `materialsPending` (unblock the
      // button); a still-pending transient-failed op keeps its coalesceKey (button stays disabled while it
      // retries). `materialsAttempted` (correction 3, finding 3) is true whenever ANY materials op was
      // ATTEMPTED — succeeded, dropped, OR transient-failed — so a lost/uncertain response still refreshes
      // the materials TRUTH (reserve/issue/consume return route JSON, not the snapshot, so the base
      // reconcile below never carries the new stock).
      const resolvedMaterialsCoalesceKeys: string[] = [];
      let materialsAttempted = false;
      // Phase 4 Task 6 (§J) — the labour twin: resolved labour coalesce keys unblock their buttons;
      // ANY attempted labour op (succeeded, dropped, or transient) re-derives the labour truth.
      const resolvedLabourCoalesceKeys: string[] = [];
      let labourAttempted = false;
      // Phase 5 Task 7B-iii-a (§M) — the commercial twin. No `resolved…CoalesceKeys` list, and
      // that is the labour design not an omission: a resolved key is NOT cleared here (see the
      // reconcile hook below for why), so there is nothing to collect.
      let commercialAttempted = false;
      let lastSnap: ApiSnapshot | null = null;
      // a site visit write answers on its own screen, with no snapshot: a snapshot an earlier act returned was taken before
      // it, so it would put the project back without what that write changed (its notice in the bell). It is not applied;
      // a snapshot asked for after the write is (Codex 4278908038, #908)
      let lastSnapStale = false;
      // #482: a site photo settled by its 410: a pull is owed once the flush is done
      let photoSettledGone = false;
      // the LAST daily-log command this flush committed: the log will next read back as its result
      let dailyLogCommitted: 'start' | 'send' | null = null;
      let synced = 0;
      let dropped = 0;
      // Phase 6 task 4d-ii-b / B5a — a countersign-chain act the server REFUSED (terminal 4xx: the 409 while
      // the doors stand, an ineligible state, a lesser client under an active chain) is reported as the
      // server's own words, one line per act, instead of joining the anonymous "discarded" count.
      const chainRefusals: string[] = [];
      // Site Visits (#792, F53): the moves made for refused starts, applied to acts queued during this flush too
      // (to null: the refused start's acts went with it)
      const visitMoves: [string, string | null][] = [];
      const remapVisits = (list: OutboxOp[]): OutboxOp[] => visitMoves.reduce(
        (l, [from, to]) => (to ? moveSiteVisitOps(l, from, to) : l.filter((o) => !(isSiteVisitOp(o) && o.t !== 'siteVisitStart' && o.visitId === from))),
        list,
      );
      let stoppedAt = -1;
      let scopeMoved = false;
      // step B1a: an act the server now has, or refused for good, is marked so at once, before the flush goes on: a page
      // closed before this flush writes its key without it never sends it again
      let markStore: Storage | null = null;
      try { markStore = globalThis.localStorage ?? null; } catch { markStore = null; }
      const laneOf = (o: OutboxOp): string => (isSiteVisitOp(o) ? siteVisitKeyOf(flushKey) : flushKey);
      // a site photo's op is in no key: its row's marker is its record, so it leaves no settled mark here (a mark named
      // for an act no key holds would outlive a tab closed before the end write tidies it, #917 gap-check)
      const settle = (o: OutboxOp, refused = false): void => { if (o.t !== 'uploadSitePhoto') queueKeys.settled(markStore, laneOf(o), o, refused); };
      /** An act the server accepted, by this flush's send or, with no snapshot, by another tab's (its done fact): every
       *  effect of the success that does not read the server's answer, one function for both (xtab-drain U2 r1 root
       *  cause: a copy of these effects drifted, 4384591499/4384591507/4384591508). The 410 of an upload is read only by
       *  the send's own answer, so an upload is never settled by its fact. The start's photo clear is returned to wait on */
      // `gone`: a site photo settled by the 410 was not sent: it is never put in the draft, and `forgetQueuedSitePhoto`
      // takes it out of the queue after this (Codex 4410673603)
      const afterSent = (o: OutboxOp, snap: ApiSnapshot | null, gone = false): Promise<unknown> | null => {
        settle(o);
        if (snap) { lastSnap = snap; lastSnapStale = false; } else if (lastSnap && isSiteVisitOp(o)) lastSnapStale = true;
        // an evidence send settled with its refresh failed (its bytes are gone, so it is never sent again): the pull it
        // owes is asked for once the flush is done, as a 410's is (#482)
        // so is a site photo's: settled by its answer, its queued copy leaves the Dashboard, and the server's must come
        // back (Codex 4389428615)
        if (!snap && (o.t === 'uploadEvidence' || o.t === 'uploadSitePhoto')) photoSettledGone = true;
        // a site photo settled leaves the copy of its bytes this tab showed while it was queued (Codex 4391469504)
        // and, sent (here, or by another tab whose marker settled this copy), it moves from the queue into its log's
        // draft in the same update, by its key, once (#1167); kept for its log when another is on show (Codex 4411296873)
        if (o.t === 'uploadSitePhoto' && !gone) {
          const key = o.clientKey;
          set((s) => {
            // #1195: the day's count keeps it, as an online upload answered here is kept, until a read shows the server's
            // count holding it: a module-owned daily-log read is not carried by this answer's snapshot and lands later
            const kept = s.sitePhotosKept.find((k) => k.clientKey === key);
            if (kept?.dailyLogId && !s.photoUploadsInFlight.some((u) => u.clientKey === key)) s.photoUploadsInFlight.push({ clientKey: key, dailyLogId: kept.dailyLogId, settled: true, after: snapshotSeq });
            s.sitePhotosKept = s.sitePhotosKept.filter((k) => k.clientKey !== key);
            confirmSitePhoto(s, key, kept?.dailyLogId, flushGateway.project);
            recountDailyLogPhotos(s);
          });
          persistDailyLogDraft();
        }
        // a site visit's answer shows on its own screen, so it is not counted in the "synced" line; one that went
        // through starts the visit photo retry's wait over
        if (!isSiteVisitOp(o)) synced += 1;
        else visitPhotoRetryMs = VISIT_PHOTO_WAIT_MS;
        if (o.t === 'decideReview') refreshBriefAfterReview(flushedBy);
        if (o.t === 'startDailyLog') dailyLogCommitted = 'start';
        else if (o.t === 'submitDailyLog') dailyLogCommitted = 'send';
        const k = keyOf(o); if (k) succeededKeys.push(k);
        if (isMaterialsOp(o)) { materialsAttempted = true; const ck = coalesceKeyOf(o); if (ck) resolvedMaterialsCoalesceKeys.push(ck); }
        if (isLabourOp(o)) { labourAttempted = true; const ck = coalesceKeyOf(o); if (ck) resolvedLabourCoalesceKeys.push(ck); }
        if (isCommercialOp(o)) { commercialAttempted = true; commercialWritesSettled += 1; }
        // SV2: a visit started: its kept photos stop carrying the start, so it is not put back and sent again. Not
        // written (the phone's database failed): the start may be sent again ahead of them, and the server answers
        // that replay with the same visit, so nothing is lost or doubled. Bounded, as every write of the rows in a
        // flush is: one that fails or never answers keeps the rows' start, lets the flush go on, and is made again by
        // the next flush (Codex 4324453897)
        return o.t === 'siteVisitStart'
          ? withinWait(() => clearVisitPhotoStart(visitPhotoScope(flushToken, flushedBy), flushGateway.project, o.body.id)).catch(() => retryVisitPhotos())
          : null;
      };
      // xtab-drain redesign U2 (plan rev 3 §2.2): an act another tab's flush sent (its done fact) is not sent. It leaves
      // through `afterSent`, as if this tab had sent it, with no snapshot: the read after it is asked for once the flush
      // is done (`doneElsewhere`; a visit act's screen reads again, `visitDoneElsewhere`), and a daily-log start or send
      // keeps the log read-only until that read lands. Only a success has a fact (r1, 4384591505): a refusal is sent
      // again, so its path runs here with the server's words, and so is an act whose success reads the server's answer
      // (a visit photo's row, an upload's 410)
      let doneElsewhere = false;
      let dailyLogDoneElsewhere = false;
      let visitDoneElsewhere = false;
      /** the bounded clears of the kept photos of starts settled here, waited for once the queue is settled */
      const doneWaits: Promise<unknown>[] = [];
      const settleDone = (o: OutboxOp): boolean => {
        if (o.t === 'siteVisitAddFile' || o.t === 'uploadMedia') return false;
        if (!markStore || !isDone(markStore, laneOf(o), o)) return false;
        const clear = afterSent(o, null);
        if (clear) doneWaits.push(clear);
        if (o.t === 'startDailyLog' || o.t === 'submitDailyLog') dailyLogDoneElsewhere = true;
        if (isSiteVisitOp(o)) visitDoneElsewhere = true; else doneElsewhere = true;
        return true;
      };
      const withheldVisits = new Set<string>();
      let generalWithheld = false;
      const withheldNow = (op: OutboxOp): boolean => {
        const visit = isSiteVisitOp(op);
        if (visit ? withheldVisits.has(siteVisitOf(op)) : generalWithheld) return true;
        if (!queueKeys.withholds(visit ? siteVisitKeyOf(flushKey) : flushKey, op)) return false;
        if (visit) withheldVisits.add(siteVisitOf(op)); else generalWithheld = true;
        return true;
      };
      for (let i = 0; i < ops.length; i++) {
        // live check BEFORE each replay: if the project or session changed while a
        // previous op was in flight, the rest of this queue belongs to the OLD
        // scope — stop, and leave it persisted there for that scope's next flush.
        if (!scopeStillCurrent(flushScope) || get().sessionToken !== flushToken) {
          stoppedAt = i;
          scopeMoved = true;
          break;
        }
        // U3 (Codex 4353751507): an act its key withholds (another tab made the key unreadable) stays here, unsent, and
        // so does every later act that may depend on it: the rest of its visit, or the rest of the general queue (a
        // later act sent alone would be refused for good and dropped: Stage 1 gap check of 3302f45, gap 1). It is asked
        // first, so an act the photo hold also holds still latches its visit (#1122 r2, 4370280911)
        const withheldHere = withheldNow(ops[i]);
        const photoHeld = holds(ops[i]);
        // U3b (4370280911): a visit act the photo hold holds latches its visit for the rest of this flush, so Send anyway
        // tapped during a later await sends none of its later acts ahead of it; it takes effect at the next flush. A
        // photo's own act latches nothing: only its row sends it, and Send anyway is for the visit's other acts
        const visitAct = ops[i];
        if (photoHeld && isSiteVisitOp(visitAct) && visitAct.t !== 'siteVisitAddFile') withheldVisits.add(siteVisitOf(visitAct));
        if (photoHeld || withheldHere) { heldVisits.push(ops[i]); continue; }
        if (settleDone(ops[i])) {
          // #482 — another tab sent it: the server has it, so a guide waiting on it is told so
          const k = keyOf(ops[i]); if (k) actWatches.get(k)?.('sent');
          continue;
        }
        const mat = isMaterialsOp(ops[i]);
        const lab = isLabourOp(ops[i]);
        const com = isCommercialOp(ops[i]);
        try {
          let photoGone = false;
          let goneEvidence: { url: string; inspectionId?: string; inspectionItemId?: string } | undefined;
          const snap = await replayOutboxOp(flushGateway, ops[i], flushScope.generation, (local) => { photoGone = true; goneEvidence = local; }, flushPerson);
          const startCleared = afterSent(ops[i], snap, photoGone);
          // #482: a photo settled by the server's 410 is settled as a delete is (settleDeleted). Its local copies leave at
          // once, matched by the send's own key: one an earlier pull recorded is never shown past the server's word (Codex
          // 4340333337), and a pull begun before this answer, which may still hold it, is superseded. The day's count on
          // screen may still hold it, so none is shown until a pull begun after this answer gives the server's. The
          // refresh after the 410 never counts, whether it failed (Codex 4339094809), or carried no daily-log slice because
          // a module read owns it (Codex 4339777229), or is applied under the flush's older lease. An answer that comes
          // after the project or the person changed touches nothing on screen
          const settledUpload = ops[i];
          if (photoGone) {
            photoSettledGone = true;
            const goneKey = settledUpload.t === 'uploadMedia' ? settledUpload.input.clientKey : settledUpload.t === 'uploadEvidence' || settledUpload.t === 'uploadSitePhoto' ? settledUpload.clientKey : undefined;
            if (scopeStillCurrent(flushScope) && get().sessionToken === flushToken) {
              beginSnapshotLease(flushScope);
              set((s) => {
                // a site photo shown from its kept copy leaves its count and draft photo too, as a refused or rowless one does
                if (settledUpload.t === 'uploadSitePhoto') forgetQueuedSitePhoto(s, settledUpload.clientKey);
                if (((settledUpload.t === 'uploadMedia' && settledUpload.input.kind === 'progress') || settledUpload.t === 'uploadSitePhoto') && s.dailyLog) s.dailyLogPhotoCountAfter = snapshotSeq;
                const ids = goneKey ? [...s.photos, ...s.myDeletablePhotos].filter((p) => p.clientKey === goneKey).map((p) => p.id) : [];
                for (const id of ids) dropDeletedPhoto(s, id);
                // and the copies this device showed while the send was queued: a site photo's data URL in the log's gallery
                // (carrying the send's key), an evidence photo's on the item it was captured on (its own bytes)
                if (goneKey && s.dailyLog) s.dailyLog.photos = s.dailyLog.photos.filter((p) => p.clientKey !== goneKey);
                const ev = goneEvidence;
                if (ev) {
                  for (const c of [s.checklist, ...s.openChecklists]) {
                    const it = c && c.id === ev.inspectionId ? c.items.find((x) => x.id === ev.inspectionItemId) : undefined;
                    const at = it?.evidence?.indexOf(ev.url) ?? -1;
                    if (!it || at < 0) continue;
                    it.evidence = it.evidence!.filter((_, j) => j !== at);
                    it.photos = Math.max(0, it.photos - 1);
                  }
                }
              });
              if (settledUpload.t === 'uploadSitePhoto') persistDailyLogDraft();
            }
          }
          if (startCleared) await startCleared;
        } catch (err) {
          // the photo's own row could not be read or updated in time: not the server's answer. The act and its visit's
          // later acts are held, the rest of the queue goes on, and the flush is tried again
          const unread = ops[i];
          if (err instanceof VisitPhotoUnreadable && isSiteVisitOp(unread)) {
            stuck.add(siteVisitOf(unread));
            heldVisits.push(unread);
            retryVisitPhotos();
            continue;
          }
          // #917: a site photo's row could not be read or removed in time, or another tab is sending it: kept, and sent (or
          // settled by that tab's marker) at the next flush; the rest of the queue goes on
          if ((err instanceof SitePhotoUnreadable || err instanceof SitePhotoBusy) && unread.t === 'uploadSitePhoto') {
            heldVisits.push(unread);
            // not left for a later write that may never come while the app stays online (Codex 4389428598)
            if (get().online) retrySitePhotos();
            continue;
          }
          // #917: no row left for it: a "sent" or "refused" marker past its keep, or the site's data cleared. Nothing is
          // left to send: dropped quietly, counted neither as sent nor as discarded
          // Its copy on screen goes, and the server's word on the photo is read once the flush is done (Codex 4389716748)
          if (err instanceof SitePhotoGone && unread.t === 'uploadSitePhoto') {
            photoSettledGone = true;
            if (scopeStillCurrent(flushScope) && get().sessionToken === flushToken) {
              const key = unread.clientKey;
              set((s) => forgetQueuedSitePhoto(s, key));
              persistDailyLogDraft();
            }
            continue;
          }
          if (isTerminalOutboxError(err)) {
            const op = ops[i];
            if (isCountersignChainOp(op)) {
              chainRefusals.push(`${chainActLabel(op)} refused — ${refusalMessage(err) ?? 'the server did not say why'}.`);
            } else if (isSiteVisitOp(op)) {
              // F53: a start refused because the visitor already has a visit open hands its queued acts to that
              // visit; any other refused start takes its queued acts with it. A refusal is told to the Site Visits
              // screen in the server's words (or counted as discarded when no screen is on show)
              let open: SiteVisit | null = null;
              const before = droppedKeys.length;
              if (op.t === 'siteVisitStart' && isOpenVisitConflict(err) && flushedBy) {
                try {
                  open = await ownOpenVisit(flushGateway, flushedBy);
                } catch {
                  stoppedAt = i; // the open visit could not be read: the start and its acts replay next time
                  break;
                }
                // no open visit by now (another device ended it after the refusal): the refused start changed
                // nothing, so the same start, under the same key, is sent again next time with its acts
                if (!open) { stoppedAt = i; break; }
              }
              if (op.t === 'siteVisitStart') {
                const rest = ops.slice(i + 1);
                const onIt = rest.filter((o) => isSiteVisitOp(o) && o.t !== 'siteVisitStart' && o.visitId === op.body.id);
                // SV2: the start's photos are kept with their acts in `visitPhotoStore`; they follow the acts there too
                const photos = visitPhotoScope(flushToken, flushedBy);
                // the rows are the photos' only record: a move or mark the phone could not make leaves the start and its
                // acts queued, to be refused and settled again next time, never rows with no act (Codex 4320404431)
                const reason = refusalMessage(err);
                // bounded, as every write of the rows in a flush is (Codex 4324836535): one that fails or never answers
                // stops here with the start and its acts queued, and the retry sends the start again. It is refused the
                // same way, and the move or mark is made again; both touch only rows still queued on the refused start,
                // so one that committed late leaves nothing to move or mark twice
                const settled = await withinWait(() => (open
                  ? moveVisitPhotos(photos, flushGateway.project, op.body.id, open.id).then((): string[] => [])
                  : failVisitPhotosOn(photos, flushGateway.project, op.body.id, reason))).then((failed) => failed, () => null);
                if (!settled) { stoppedAt = i; retryVisitPhotos(); break; }
                // each photo marked failed is told as committed (State rules)
                for (const clientKey of settled) {
                  tellSiteVisits({ kind: 'photo', project: flushGateway.project, generation: flushScope.generation, visitId: op.body.id, clientKey, state: 'failed', reason });
                }
                if (open) {
                  ops.splice(i + 1, rest.length, ...moveSiteVisitOps(rest, op.body.id, open.id));
                  tellSiteVisits({ kind: 'moved', project: flushGateway.project, generation: flushScope.generation, to: open.id, count: onIt.length });
                } else {
                  // not sent, and kept with the server's words, so the screen says which photos and why
                  ops.splice(i + 1, rest.length, ...rest.filter((o) => !onIt.includes(o)));
                  for (const o of onIt) { settle(o, true); const k = keyOf(o); if (k) droppedKeys.push(k); }
                }
                visitMoves.push([op.body.id, open?.id ?? null]);
              }
              if (!open) {
                if (siteVisitListeners.size > 0) tellSiteVisits({ kind: 'refused', project: flushGateway.project, generation: flushScope.generation, message: refusalMessage(err) });
                else dropped += 1 + (op.t === 'siteVisitStart' ? droppedKeys.length - before : 0);
              }
            } else {
              dropped += 1; // server will never accept this one — discard and keep going
              if (op.t === 'uploadSitePhoto' && scopeStillCurrent(flushScope) && get().sessionToken === flushToken) {
                const key = op.clientKey;
                set((s) => forgetQueuedSitePhoto(s, key));
                persistDailyLogDraft();
              }
            }
            settle(ops[i], true);
            const k = keyOf(ops[i]); if (k) droppedKeys.push(k);
            if (mat) { materialsAttempted = true; const ck = coalesceKeyOf(ops[i]); if (ck) resolvedMaterialsCoalesceKeys.push(ck); }
            if (lab) { labourAttempted = true; const ck = coalesceKeyOf(ops[i]); if (ck) resolvedLabourCoalesceKeys.push(ck); }
            if (com) { commercialAttempted = true; commercialWritesSettled += 1; }
            continue;
          }
          stoppedAt = i; // transient — retry this op and the rest on the next reconnect
          // a visit act whose answer is lost may have been written: a snapshot taken before it is not put on screen
          // (#908 check gap 1, the same as 4278908038)
          if (lastSnap && isSiteVisitOp(ops[i])) lastSnapStale = true;
          // SV2: a visit act (a photo above all) is not left for a reconnect that may never come while the socket
          // stays up: no answer, a busy or failing server is tried again, after the server's own wait when it gives
          // one (Codex 4321558432)
          // #917: a site photo's replay that failed for now is tried again the same way (Codex 4391469520)
          if (ops[i].t === 'uploadSitePhoto' && get().online) retrySitePhotos();
          if (isSiteVisitOp(ops[i]) && get().online) {
            const after = (err as { retryAfter?: unknown } | null)?.retryAfter;
            retryVisitPhotos(typeof after === 'number' && Number.isFinite(after) && after > 0 ? Math.min(after * 1000, VISIT_PHOTO_RETRY_AFTER_MAX_MS) : 0);
          }
          if (mat) materialsAttempted = true; // correction 3 finding 3: still refresh truth, keep the op + its coalesceKey
          if (lab) labourAttempted = true; // same for labour: refresh truth, keep the op + its coalesceKey
          if (com) commercialAttempted = true; // and commercial: an uncertain response still refreshes the money
          break;
        }
      }

      // Re-check AFTER the loop too (round 2): a switch that lands while the FINAL
      // op is in flight never hits the pre-iteration guard — without this, the
      // normal reconcile below would replace and persist the NEW scope's queue
      // with this flush's (empty) result, silently dropping that scope's work.
      if (!scopeMoved && (!scopeStillCurrent(flushScope) || get().sessionToken !== flushToken)) {
        scopeMoved = true;
      }

      // a visit held only once its photo could not be read is said too, so the person can send its other acts anyway
      if (stuck.size > 0 && !scopeMoved) {
        const heldAfter = offered(heldVisits);
        if (heldAfter.length > 0) set({ siteVisitsHeld: { project: keptFor, generation: flushScope.generation, visits: heldAfter } });
      }
      // the held site visit acts came before the stop, so they stay ahead of everything after it, in order
      // U2: an act left for later whose done fact is here now leaves, so it is neither pending nor counted
      const unsent = [...heldVisits, ...(stoppedAt >= 0 ? ops.slice(stoppedAt) : [])];
      const remaining = scopeMoved ? unsent : unsent.filter((o) => !settleDone(o));
      await Promise.all(doneWaits);
      const pendingKeys = remaining.map(keyOf).filter((k): k is string => !!k);
      if (scopeMoved) {
        // The in-memory outbox now belongs to the NEW scope (hydrateOutbox swapped
        // it) — don't touch it. Persist the un-replayed remainder (plus anything the
        // old scope queued during the flush) under the ORIGINAL key so it replays
        // there on that scope's next reconnect, and skip the reconcile snapshot.
        // this flush's acts leave each stored list by identity, its unsent ones go first, and every other act stays; a key
        // this release cannot read is never written over (step A). Unsent acts that can be neither written nor copied
        // aside (no storage to be had included) are held stranded for the old scope, never dropped (Codex 4345664670)
        let storage: Storage | null = null;
        try { storage = globalThis.localStorage ?? null; } catch { storage = null; }
        await keepUnsentLocked(queueKeys, storage, flushKey, remaining.filter(isStoredGenericOp), flushed.filter(isStoredGenericOp), (l) => l, isStoredGenericOp);
        // acts queued meanwhile for a refused start get the same move or drop as the normal path's (Codex 4278754334)
        await keepUnsentLocked(queueKeys, storage, siteVisitKeyOf(flushKey), remaining.filter(isStoredVisitOp), flushed.filter(isStoredVisitOp), (l) => remapVisits(l).filter(isStoredVisitOp), isStoredVisitOp);
        // a guide waiting on one of these acts belonged to the scope left behind
        for (const o of [...ops, ...remaining]) { const k = keyOf(o); if (k) actWatches.delete(k); }
        return { ran: true, scopeMoved: true, succeededKeys, droppedKeys, pendingKeys };
      }

      // Preserve anything queued while we were awaiting (shouldn't happen once online, but
      // never drop a write): the original ops were the outbox prefix, so slice past them.
      const appended = remapVisits(get().outbox.slice(taken));
      visitPhotoEpoch += 1; visitPhotoFlushes += 1; // a visit photo reconciliation read before this flush settled would re-queue a sent photo
      sitePhotoSettles += 1; // and a site photo one (#1170)
      set((s) => {
        s.outbox = [...remaining, ...appended];
        // a photo upload dropped for good (terminal rejection) stops counting on screen in the same update
        recountDailyLogPhotos(s);
        // under module ownership the command's own snapshot carries no daily-log slice, so the log
        // on screen predates the committed start/submit until the reconcile's module read lands —
        // flag it in the SAME update that drops the op, leaving no window to act on the stale log
        if (dailyLogCommitted && (dailyLogReadMode() === 'moduleQuery' || dailyLogDoneElsewhere)) {
          s.dailyLogReconcileAfter = snapshotSeq;
          s.dailyLogReconcileKind = dailyLogCommitted;
        }
        s.syncQueue = []; // local-only labels (check-in, QR) are considered synced on reconnect
        // gate round 8: the queue changed — a queued submit may have replayed or
        // been dropped (terminal 4xx). Re-derive the freeze so a dropped submit
        // UNLOCKS the checklist (a successful replay lands `submitted` via the
        // snapshot below, which reconciles it to read-only).
        reconcileSubmission(s);
      });
      // step B2f-1: the flush goes on only once its locked end write has run (#1099 r2, review-body P1): its word and
      // its reconcile come after. Until then each sent act's settled mark keeps a reload from sending it again (B1a).
      // Its lines are said only in the scope it ran in; the reconciles below carry their own scope guards
      const endHere = madeHere();
      await persistOutbox();
      // an act this flush settled is no longer one to write again
      const left = new Set(get().outbox.map(aheadId));
      for (const o of [...aheadUnsaved]) if (!left.has(o)) aheadUnsaved.delete(o);
      // finding 1 — a write-ahead command passes its own success toast (`okMsg`); the reconcile
      // announces it on `applied`. In that case suppress the batch "N synced" line below (the okMsg
      // already reported success), but still surface the error parts (dropped / still-pending).
      // a command's line is said only by the flush the server accepted its act in, whichever call it came with (#1133).
      // An act refused for good leaves the queue too, and says the refused line instead. A line whose act is still in this
      // queue waits for a later flush (#1134 r1 4376641813); one whose act left it, sent or refused, is done
      const succeeded = new Set(succeededKeys);
      const stillQueued = new Set(get().outbox.flatMap((o) => keyOf(o) ?? []));
      for (const k of succeededKeys) actWatches.get(k)?.('sent');
      for (const k of droppedKeys) actWatches.get(k)?.('failed');
      for (const k of pendingKeys) actWatches.get(k)?.('pending');
      const said = okWaiting.filter((w) => succeeded.has(w.key));
      okWaiting = okWaiting.filter((w) => w.queue !== flushKey || stillQueued.has(w.key));
      // #1134 r2 (4377928188, root-cause audit in notes/site-visits/web-02-U3/u3b/r2/fix.md): a flush sends 0..N commands'
      // acts, each with its own outcome. Each command whose act this flush sent says its line once, in the order sent, in
      // this flush's one line; past two, the first is said and the rest are counted. The count covers every sent act
      // without a line (every waiting act was counted as sent: no site visit act waits for a line)
      const sentOrder = (k: string) => succeededKeys.indexOf(k);
      // (every outbox act is keyed, so a line comes only with its act: `okWaiting`)
      const lined = said.sort((a, b) => sentOrder(a.key) - sentOrder(b.key)).map((w) => w.okMsg);
      const told = lined.length > 2 ? lined.slice(0, 1) : lined;
      const flushOk = told.map((m) => (typeof m === 'function' ? m() : m)).join(' ') || undefined;
      // the caller that says its own acts' word has them in none of the counts (#1134 residual: the drawing publish)
      const ownOf = (keys: string[]) => (own ? keys.filter((k) => own.has(k)).length : 0);
      const unlined = synced - told.length - ownOf(succeededKeys);
      const unsaid = dropped - ownOf(droppedKeys);
      const waiting = remaining.length - ownOf(pendingKeys);
      const parts: string[] = [];
      const lang = get().lang;
      if (unlined > 0) parts.push(SYNC.synced(unlined, lang));
      if (unsaid > 0) parts.push(SYNC.dropped(unsaid, lang));
      if (waiting > 0) parts.push(SYNC.pending(waiting, lang));
      // the chain refusals carry the server's words, so they are not folded into the count, but they are said in the same
      // line: the command's line and everything else this flush did are one line, so none hides another (#1134 r1
      // 4376641802, Stage 1 re-check of 62c8d1e)
      const rest = [...(parts.length ? [SYNC.join(parts, lang)] : []), ...chainRefusals].join(' ');
      // the caller says this flush's word with its own only if it can say it now; otherwise the flush says it, as main did
      const handing = !!own && (opts?.saysNow?.() ?? true);
      let toldWith: string | undefined;
      if (lastSnap && flushLease) {
        // a stale snapshot is handled as a superseded one is: the command's word is said, and a reconcile asked after it
        const result = lastSnapStale ? 'superseded' : acceptSnapshot(lastSnap, flushLease);
        if (flushOk && (rest || handing) && (result === 'applied' || result === 'superseded')) toldWith = flushOk;
        consumeSnapshotResult(result, toldWith ? undefined : flushOk, flushLease.scope);
      } else if (flushLease && pullSuperseded) {
        // (a flush whose project changed has returned above: the scope here is still the flush's)
        void requestFreshSnapshot(flushLease.scope);
      }
      // ...asked for here, as the 404 path's reconcile is (settleDeleted): it begins after the 410's answer, so it clears
      // the count's "updating" and takes the photo out of the log, and one that fails shows the Retry
      if (photoSettledGone && flushLease) scheduleReconcile(flushLease.scope, { kind: 'command', createdAfterSequence: snapshotSeq });
      // U2: an act another tab sent brought no snapshot here; the read after it is owed, as a 410's is
      if (doneElsewhere && flushLease) scheduleReconcile(flushLease.scope, { kind: 'command', createdAfterSequence: snapshotSeq });
      // ...and a visit act another tab sent brought this tab's Site Visits screen no answer: it reads again, as the photo
      // retry has it do, so it never falls back to the visit as it was before the act (r1 gap-check of a6a03e1f, C7)
      if (visitDoneElsewhere && scopeStillCurrent(flushScope)) tellSiteVisits({ kind: 'retry', project: flushGateway.project, generation: flushScope.generation });

      // one flash per flush: a caller that says its own acts' word says this flush's with it, in one line
      const handBack = handing && endHere() ? [toldWith, rest].filter(Boolean).join(' ') || undefined : undefined;
      if (!handing && rest && endHere()) get().flash(toldWith ? `${toldWith} ${rest}` : rest);
      // evidence reconcile: uploaded bytes were cleaned up; terminal rejections moved
      // to FAILED; an op kept alive by a failed dead-letter write stays covered
      void reconcileEvidence();
      // Phase 3 Task 7 (correction 2/3) — the MATERIALS reconcile hook. A resolved (succeeded OR
      // terminally-dropped) materials command's COALESCE key is cleared from `materialsPending` (unblock
      // the button); a still-pending transient-failed op keeps its coalesceKey (stays disabled while it
      // retries — no success toast, since consumeSnapshotResult only announces okMsg on an APPLIED
      // snapshot). If ANY materials command was ATTEMPTED (incl. a transient/uncertain failure — finding
      // 3), re-derive the materials TRUTH by reloading the bundle + every OPEN reservation plan (the
      // server may have committed despite the lost response), scope-guarded so a switch mid-flush touches
      // nothing here (the new scope owns empty state).
      if (materialsAttempted) {
        const resolved = new Set(resolvedMaterialsCoalesceKeys);
        if (resolved.size > 0) set((s) => { s.materialsPending = s.materialsPending.filter((k) => !resolved.has(k)); });
        if (scopeStillCurrent(flushScope) && get().capabilities.includes('materials')) {
          get().loadMaterials();
          for (const activityId of Object.keys(get().reservationPlans)) get().loadReservationPlan(activityId);
        }
      }
      // Phase 4 Task 6 (§J) — the LABOUR reconcile hook. Codex round 8: a RESOLVED op's coalesce
      // key is NOT cleared here — between this flush and the labour reload the screen still
      // renders the OLD bundle (no committed allocation visible), so clearing the key in that
      // gap re-enables the action and a second worker can be queued against demand the first
      // command already filled. The keys stay in `labourPending` (buttons disabled, honest
      // "…ing" labels) until `loadLabour()` APPLIES the fresh bundle, which rebuilds
      // `labourPending` from the live outbox (a transient-failed op is still queued → its key
      // survives; a resolved/dropped op is gone → its key clears WITH the new truth on screen).
      if (labourAttempted) {
        if (scopeStillCurrent(flushScope) && get().capabilities.includes('labour')) {
          get().loadLabour();
        }
      }
      // Phase 5 Task 7B-iii-a (§M) — the COMMERCIAL reconcile hook, cloned from labour rather
      // than from materials, deliberately. Materials clears a resolved op's coalesce key HERE;
      // labour's round 8 found that wrong and commercial inherits the correction: between this
      // flush and the reload the screen still renders the OLD money position, so clearing the key
      // in that gap re-enables the button while the pre-command figure is on screen — and a
      // second set writes a second revision of a budget the first command already changed.
      // The keys stay in `commercialPending` until `loadCommercial()` APPLIES the fresh bundle,
      // which rebuilds the set from the live outbox (a transient-failed op is still queued so its
      // key survives; a resolved one is gone so its key clears WITH the new truth on screen).
      //
      // `commercialAttempted` is true for a succeeded, dropped OR transient-failed op (PR #208
      // finding 4): an uncertain response must still re-read the money, because the server may
      // have committed despite losing the reply.
      if (commercialAttempted) {
        if (scopeStillCurrent(flushScope) && get().capabilities.includes('commercial')) {
          get().loadCommercial();
          // Codex M1 — 7B-iii-a's ops changed the MONEY POSITION, so reloading it was the whole
          // reconcile. 7B-iii-b's ops change a CLAIM: a measurement, a correction, a lifecycle
          // transition. Reloading only the money left `loadCommercial()` clearing
          // `commercialPending` while the register on screen was still pre-command and the form
          // still filled — so a second Measure sent a FRESH idempotency key and appended the same
          // measurement twice, overstating measured work. The labour round-8 gap, on the resources
          // this unit actually touches: refresh the claim list and every open claim too.
          get().loadCommercialBills();
          // …and the ADVANCES (7B-vi). Same lesson as the claim reads above, on the one resource
          // no claim read covers: without this the advance key had no post-write read to settle
          // it, so the button either stuck in "Working…" or — worse for an append-only row with
          // no server ceiling — a pre-write read in flight cleared the key over a list that did
          // not yet show the payment, and the operator could pay a second advance believing the
          // first had not landed.
          // …only when there is something to reconcile: the tab has the list open, OR an advance
          // key is still pending and needs the read that settles it. A blanket re-read would fetch
          // a resource nobody is looking at on every commercial write, and conditioning it on the
          // OPEN tab alone would strand a key queued while the tab was closed.
          if (get().commercialAdvancesLoad !== 'idle'
            || get().commercialPending.some((k) => k.startsWith('com:advance:'))) {
            get().loadCommercialAdvances();
          }
          for (const billId of new Set([
            ...Object.keys(get().commercialClaims),
            ...Object.keys(get().commercialClaimLoad),
          ])) get().loadCommercialClaim(billId);
          // …and every LINE register on screen: that is the read a measurement becomes visible in,
          // and — since Q-a — the only read that may release its key, because it starts here,
          // AFTER the write settled.
          for (const lineId of new Set([
            ...Object.keys(get().commercialLineRegisters),
            ...Object.keys(get().commercialLineRegisterLoad),
          ])) get().loadCommercialLineRegister(lineId);
        }
      }
      return { ran: true, scopeMoved: false, succeededKeys, droppedKeys, pendingKeys, word: handBack };
      } finally {
        outboxFlushing = false;
        flushingKeys = new Set();
        if (replayingDecisions > 0) { const n = replayingDecisions; set((s) => { for (let k = 0; k < n; k++) dropOne(s.reviewDecisionsSending, replayScope); }); }
        // #482 — offline, no rerun follows: an act the guide waits on that this flush did not settle (taken after it began,
        // or left out of it) waits for the signal, as going offline says
        if (!get().online) for (const [k, watch] of [...actWatches]) if (!writingKeys.has(k)) watch('pending');
        // a visit photo reconciliation this flush overtook reads again now, against the settled queue (SV2)
        if (visitPhotoRecheck) {
          visitPhotoRecheck = false;
          void reconcileVisitPhotos();
        }
        // a command persisted DURING this flush was not replayed here — flush it now (plain: a command's line still
        // waiting is said by the flush that sends its act, #1133). Bounded: the rerun fires at most once per settle.
        // It runs on an empty queue too: a visit photo kept meanwhile whose act this flush let go (its visit's
        // start was refused) has it put back there and settled (SV2, Codex 4321084743)
        if (outboxFlushQueued) {
          outboxFlushQueued = false;
          if (get().online) void get().flushOutbox();
        }
      }
    },
    // L2b: it runs under every listed key's lock; done once its writes (or put-backs) have run
    setAsideUnreadableQueue: () => strip.setAside(),
    reloadForNewerQueue: () => strip.reload(),
    hydrateOutbox: () => {
      resetQueueScope(); // before any storage access: a storage that throws below leaves no other scope's list
      // this scope's evidence rows are read again below: until then an own evidence photo's Delete waits (#482)
      set((s) => { s.pendingEvidenceKeys = null; });
      try {
        const storage = globalThis.localStorage;
        if (storage) {
          // one-time migration: adopt the old unscoped queue into the current scope
          const legacy = storage.getItem(LEGACY_OUTBOX_KEY);
          /** L2b (coordinator ruling on gap check 9): the old queue's acts this scope adopts. They join memory after the
           *  key's own and are stored by the locked write below, through the ledger, like every queue-key write; the old
           *  key goes only once that write has landed */
          let adopted: OutboxOp[] = [];
          if (legacy) {
            // #1085 r2 audit: removed only once its bytes are kept, so a write that fails never loses them. When the
            // scoped key already holds other acts, the old bytes are copied aside beside it, never left for another
            // user's or project's load to adopt and replay. Only a scope with no other queue key on this phone adopts
            // them: once another scope keeps one, bytes a failed write left behind may be that scope's, so they are
            // copied aside, never sent here
            try {
              const scoped = outboxKey();
              const lane = scoped.replace(/^vitan\.outbox\./, 'vitan.siteVisitQueue.');
              let another = false;
              for (let i = 0; i < storage.length; i += 1) {
                const k = storage.key(i);
                if (k !== null && k !== scoped && k !== lane && (k.startsWith('vitan.outbox.') || k.startsWith('vitan.siteVisitQueue.'))) another = true;
                // L2b: a made record (an earlier adoption's write that waits or did not land keeps one) loads its acts
                // with the key, so these bytes are copied aside, never adopted a second time
                if (k !== null && k.startsWith('vitan.made.')) another = true;
              }
              // only an absent key: one holding any bytes, even '' (unreadable), is never written over (Codex 4351662034).
              // Its acts are adopted only when this release reads them all; else they are copied aside
              // A load again, in this tab or another, while the adoption's write waits adopts them again: their
              // occurrences are named from the old bytes (`adoptLegacy`), so every adoption names the same ones and the
              // key holds each once (probes "gap check 9: two loads ..." and "two tabs adopt ...")
              const read = storage.getItem(scoped) === null && !another ? readLedgerQueue(legacy, queueKeyScopes.get(scoped)) : null;
              if (read && 'acts' in read) { adopted = read.acts; queueKeys.adoptLegacy(legacy, adopted); }
              else {
                // a copy name holding other bytes (an earlier legacy queue copied aside) is never written over: the next free name
                let aside = `vitan.unreadable.${LEGACY_OUTBOX_KEY}.${scoped}`;
                for (let n = 1; storage.getItem(aside) !== null && storage.getItem(aside) !== legacy && n <= 100; n += 1) aside = `vitan.unreadable.${LEGACY_OUTBOX_KEY}.${scoped}.${n}`;
                if (storage.getItem(aside) === null) storage.setItem(aside, legacy);
                if (storage.getItem(aside) === legacy) storage.removeItem(LEGACY_OUTBOX_KEY);
              }
            } catch { /* kept under the old key: this scope's load retries it */ }
          }
          // REPLACE the in-memory queue with this scope's persisted one (WEB-02) —
          // called again on every sign-in / project switch, so ops queued under a
          // different user or project never leak into the current context.
          const loadedOps: unknown = queueKeys.load(storage, outboxKey()); // step A: a key this release cannot read loads none
          const parsed: unknown = Array.isArray(loadedOps) ? [...(loadedOps as OutboxOp[]), ...adopted] : loadedOps;
          // Phase 3 Task 7 (correction 4) — a materials op persisted by PR #207 carries only
          // `idempotencyKey` (no `coalesceKey`); PR #208 keys coalescing on `coalesceKey`, so without this
          // a legacy queued op would not coalesce and could execute a SECOND time (double reserve). Derive
          // `coalesceKey` from the legacy `idempotencyKey` (same business-coordinate format), preserve the
          // `idempotencyKey` byte-for-byte (replay stays exactly-once), and drop malformed materials ops.
          const materialsNorm = normalizeMaterialsOutbox(Array.isArray(parsed) ? (parsed as OutboxOp[]) : []);
          // Phase 4 Task 6 (§J) — labour ops were born two-keyed, so this only DROPS malformed rows
          // (a labour op missing either key must never replay or leak `undefined` into labourPending).
          const labourNorm = normalizeLabourOutbox(materialsNorm.ops);
          // Phase 5 Task 7B-iii-a (§M) — commercial ops were likewise born two-keyed and no
          // earlier format was ever persisted, so this is a GUARD (drop a malformed row), not a
          // migration: there is no legacy key to derive one from, and inventing an identity for a
          // command whose exactly-once guarantee rests on it would be worse than dropping it.
          const commercialNorm = normalizeCommercialOutbox(labourNorm.ops);
          // #482 — a photo queued by an earlier release carries no key, so a replay whose reply was lost would
          // store it twice. It gets one key now, persisted below, so every later replay is the same photo.
          const photosNorm = keyQueuedPhotoUploads(commercialNorm.ops, outboxKey());
          // step B2f-1: the made record a write kept while it waited for its lock holds a photo under the key it got here,
          // while the stored queue may still hold it with none (that write not yet run): once keyed, the same act is
          // taken once (#1099 r2)
          const keyedOnce = new Set<string>();
          // L2b: only an identity no other act shares is one act; two identical unkeyed acts are two occurrences (the ledger's)
          photosNorm.ops = photosNorm.ops.filter((o) => { const i = queueActIdent(o); if (i.startsWith('json:')) return true; if (keyedOnce.has(i)) { queueKeys.merge(outboxKey(), o); return false; } keyedOnce.add(i); return true; });
          const changed = materialsNorm.changed || labourNorm.changed || commercialNorm.changed || photosNorm.changed;
          // persist the migrated queue back to the SAME scoped key so the one-time normalization is durable;
          // a write that fails (storage full) keeps the queue in memory, and the next load derives the same keys
          if (changed || adopted.length > 0) {
            void writeQueueKey(queueKeys, storage, outboxKey(), photosNorm.ops).then((kept) => {
              // the old queue's bytes go once the scoped key holds its acts (a write that did not land leaves them, and
              // the next load copies them aside beside the key that now exists)
              try { if (kept && adopted.length > 0 && storage.getItem(LEGACY_OUTBOX_KEY) === legacy) storage.removeItem(LEGACY_OUTBOX_KEY); } catch { /* kept under the old key */ }
            });
          }
          // the site visit acts, from their own key (malformed → none); a visit photo's act comes from its row (SV2)
          let visitOps: OutboxOp[] = [];
          try {
            const rawVisits: unknown = queueKeys.load(storage, siteVisitKeyOf(outboxKey()));
            visitOps = Array.isArray(rawVisits) ? (rawVisits as OutboxOp[]).filter((o) => o && isStoredVisitOp(o)) : [];
          } catch {
            visitOps = [];
          }
          const ops = [...photosNorm.ops.filter(isStoredGenericOp), ...visitOps];
          // #669 — the engineer's unsent daily-log work for THIS scope comes back with its queue, so a
          // reload (or a return to this project) keeps the day where they left it; the next apply lays
          // it over the server's log (or drops it if that log has moved on). Malformed → none.
          let draft: DailyLogDraft | null = null;
          try {
            const rawDraft = storage.getItem(dailyLogDraftKey());
            draft = rawDraft ? parseDailyLogDraft(JSON.parse(rawDraft) as unknown) : null;
          } catch {
            draft = null;
          }
          if (draft && draft.projectId !== get().activeProjectId) draft = null; // never another project's
          // the kept-aside legacy draft (owner ruling, #692) comes back with it, until confirmed or discarded
          let keptAside: DailyLogDraft | null = null;
          try {
            const rawKept = storage.getItem(legacyDailyLogDraftKey());
            keptAside = rawKept ? parseDailyLogDraft(JSON.parse(rawKept) as unknown) : null;
          } catch {
            keptAside = null;
          }
          if (keptAside && keptAside.projectId !== get().activeProjectId) keptAside = null;
          set((s) => {
            s.outbox = ops;
            s.dailyLogDraft = draft;
            s.legacyDailyLogDraft = keptAside;
            // gate round 8: rebuild an offline submit's freeze from the durable
            // outbox, so a reload keeps the checklist frozen until the queued
            // submit replays (also covered from the snapshot side by applySnapshot).
            reconcileSubmission(s);
            // Phase 3 Task 7 (correction 3 finding 1 / correction 4) — reconstruct the pending materials
            // COALESCE keys from the (normalized) persisted ops, so a reload keeps an equivalent still-queued
            // action coalesced (and its button disabled) until it replays. Never admit a `undefined` pending
            // entry: only a materials op that actually carries a string coalesce key contributes.
            s.materialsPending = s.outbox.flatMap((o) => {
              const ck = coalesceKeyOf(o);
              return isMaterialsOp(o) && typeof ck === 'string' ? [ck] : [];
            });
            // Phase 4 Task 6 (§J) — same reconstruction for the labour pending coalesce keys, so a
            // reload keeps an equivalent still-queued labour action coalesced (button disabled).
            s.labourPending = s.outbox.flatMap((o) => {
              const ck = coalesceKeyOf(o);
              return isLabourOp(o) && typeof ck === 'string' ? [ck] : [];
            });
            // Codex round 13 — rebuild the retained-input register from the STILL-QUEUED allocate
            // ops (their durable rows carry the full input, incl. `capacityCommitmentId`). A key
            // retained for an op that resolved before this reload has no row to rebuild from —
            // the screen's key-parser fallback covers it, exactly as before this round.
            // Task 7B-iii-a — and the same reconstruction for commercial, so a reload keeps an
            // equivalent still-queued write coalesced and its button disabled.
            s.commercialPending = s.outbox.flatMap((o) => {
              const ck = coalesceKeyOf(o);
              return isCommercialOp(o) && typeof ck === 'string' ? [ck] : [];
            });
            // …and their cap RESERVATIONS, by the same rule that wrote them. Round 4 keyed the
            // reservation to its coalesce key so the two share a lifecycle; hydration rebuilt the
            // keys and not the reservations, which is that lifecycle broken at the one moment it
            // is reconstructed from scratch. A correction queued offline then survived a reload
            // with its button disabled and its authority silently freed.
            s.commercialPendingQty = Object.fromEntries(
              s.outbox.flatMap((o) => {
                const ck = coalesceKeyOf(o);
                const reservation = capReservationOf(o);
                return typeof ck === 'string' && reservation ? [[ck, reservation] as const] : [];
              }),
            );
            s.labourPendingInputs = Object.fromEntries(
              s.outbox.flatMap((o) => (o.t === 'allocateLabour' && typeof o.coalesceKey === 'string' ? [[o.coalesceKey, o.input] as const] : [])),
            );
          });
        }
      } catch {
        /* ignore malformed storage */
      }
      // gate finding 2: localStorage is only a CACHE of the queue — the durable
      // evidence rows are canonical. Merge every pending row back into replay
      // (reconstructing ops a failed/absent setItem lost) and refresh the UI
      // mirrors — this runs even when localStorage is unavailable entirely.
      void reconcileEvidence();
      // and the same for queued visit photos (SV2)
      void reconcileVisitPhotos();
      // and for site photos whose answer was lost (#917): their ops are never stored, so they come back from their rows
      reconcileSitePhotos();
    },

    // ---- team access / login ----
    accWho: (who) =>
      set((s) => {
        // Top 10 #1 (#769): the trade and worker paths are prototype-only; a live build never enters them
        if (API_BASE && who !== 'team') return;
        s.access.who = who;
        // team → phone+OTP; trade → pick trade first; worker → tap-photo badge
        s.access.step = who === 'worker' ? 'badge' : who === 'trade' ? 'trade' : 'phone';
        s.access.otp = '';
        s.access.errorKey = null; s.access.error = null;
        s.access.devCode = null;
      }),
    accTrade: (t) =>
      set((s) => {
        s.access.trade = t;
        s.access.step = 'phone';
        s.access.otp = '';
        s.access.errorKey = null; s.access.error = null;
        s.access.devCode = null;
      }),
    accSetPhone: (v) =>
      set((s) => {
        s.access.phone = v.replace(/\D/g, '').slice(0, 10);
        s.access.errorKey = null; s.access.error = null;
      }),
    accGoLogin: () =>
      set((s) => {
        s.access.generation += 1;
        s.access.step = 'login';
        s.access.errorKey = null; s.access.error = null;
        s.access.sending = false;
        s.access.passwordRequestId = null;
        s.access.passwordSetupToken = null;
      }),
    login: (email, password) => {
      const em = email.trim().toLowerCase();
      if (!em || !password) {
        set((s) => { failAccess(s, { key: 'enterEmailPassword' }); });
        return;
      }
      if (gateway) {
        set((s) => { s.access.sending = true; s.access.errorKey = null; s.access.error = null; });
        gateway
          .login(em, password)
          .then((res) => applyAuthResult(res))
          .catch((err: unknown) => set((s) => { s.access.sending = false; failAccess(s, signInFailure(err)); }));
        return;
      }
      // local demo: map the seeded demo emails to their role (any password)
      const role = em.startsWith('pmc@') ? 'pmc' : em.startsWith('client@') ? 'client' : em.startsWith('contractor@') ? 'contractor' : null;
      if (!role) {
        set((s) => { failAccess(s, { key: 'demoEmails' }); });
        return;
      }
      set((s) => {
        s.role = role;
        s.screen = screensFor(role)[0]?.key ?? 'inbox';
        s.access = freshAccess(s.access.generation + 1);
      });
      get().flash('Signed in as ' + role + ' (demo).');
    },
    accSetEmail: (v) =>
      set((s) => { s.access.email = v; s.access.errorKey = null; s.access.error = null; }),
    accGoPasswordSetup: () =>
      set((s) => {
        s.access.generation += 1;
        s.access.step = 'password-email';
        s.access.otp = '';
        s.access.errorKey = null; s.access.error = null;
        s.access.sending = false;
        s.access.passwordRequestId = null;
        s.access.passwordSetupToken = null;
      }),
    requestPasswordSetup: () => {
      const email = get().access.email.trim().toLowerCase();
      if (get().access.sending) return;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        set((s) => { failAccess(s, { key: 'invalidInvitedEmail' }); });
        return;
      }
      if (!gateway) {
        set((s) => { failAccess(s, { key: 'setupNeedsServer' }); });
        return;
      }
      let generation = 0;
      set((s) => {
        s.access.generation += 1;
        generation = s.access.generation;
        s.access.sending = true;
        s.access.errorKey = null; s.access.error = null;
        s.access.passwordRequestId = null;
        s.access.passwordSetupToken = null;
      });
      gateway.passwordCredentialRequest(email)
        .then((result) => {
          if (get().access.generation !== generation) return;
          set((s) => {
            s.access.sending = false;
            s.access.step = 'password-code';
            s.access.otp = '';
            s.access.passwordRequestId = result.requestId;
          });
        })
        .catch((err: unknown) => {
          if (get().access.generation !== generation) return;
          set((s) => {
            s.access.sending = false;
            failAccess(s, httpStatusOf(err) === 429 ? { key: 'tooManyCodes', seconds: throttleSeconds(err) } : { key: 'codeSendFailed' });
          });
        });
    },
    verifyPasswordSetup: () => {
      const access = get().access;
      if (!gateway || !access.passwordRequestId || access.otp.length !== 6 || access.sending) return;
      let generation = 0;
      const requestId = access.passwordRequestId;
      const code = access.otp;
      set((s) => {
        s.access.generation += 1;
        generation = s.access.generation;
        s.access.sending = true;
        s.access.errorKey = null; s.access.error = null;
      });
      gateway.passwordCredentialVerify(requestId, code)
        .then((result) => {
          if (get().access.generation !== generation) return;
          set((s) => {
            s.access.sending = false;
            s.access.step = 'password-create';
            s.access.otp = '';
            s.access.passwordSetupToken = result.setupToken;
          });
        })
        .catch(() => {
          if (get().access.generation !== generation) return;
          set((s) => { s.access.sending = false; s.access.otp = ''; failAccess(s, { key: 'setupWrongCode' }); });
        });
    },
    completePasswordSetup: (password, confirmation) => {
      const access = get().access;
      if (access.sending) return;
      if (password !== confirmation) {
        set((s) => { failAccess(s, { key: 'passwordMismatch' }); });
        return;
      }
      if (password.length < 12 || password.length > 128) {
        set((s) => { failAccess(s, { key: 'passwordLength' }); });
        return;
      }
      if (!gateway || !access.passwordSetupToken) {
        set((s) => { failAccess(s, { key: 'setupExpired' }); });
        return;
      }
      const setupToken = access.passwordSetupToken;
      let generation = 0;
      set((s) => {
        s.access.generation += 1;
        generation = s.access.generation;
        s.access.sending = true;
        s.access.errorKey = null; s.access.error = null;
      });
      gateway.passwordCredentialComplete(setupToken, password)
        .then((result) => {
          if (get().access.generation !== generation) return;
          applyAuthResult(result, { msg: signInText.passwordSaved(get().lang) });
        })
        .catch(() => {
          if (get().access.generation !== generation) return;
          set((s) => { s.access.sending = false; failAccess(s, { key: 'passwordSaveFailed' }); });
        });
    },
    accGoEmailOtp: () =>
      set((s) => {
        s.access.generation += 1;
        s.access.step = 'emailentry';
        s.access.otp = '';
        s.access.errorKey = null; s.access.error = null;
        s.access.devCode = null;
        s.access.sending = false;
      }),
    requestEmailOtp: () => {
      const email = get().access.email.trim().toLowerCase();
      if (get().access.sending) return;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        set((s) => { failAccess(s, { key: 'invalidEmail' }); });
        return;
      }
      if (!gateway) {
        set((s) => { s.access.step = 'emailcode'; s.access.otp = ''; s.access.errorKey = null; s.access.error = null; s.access.devCode = null; });
        return;
      }
      set((s) => { s.access.sending = true; s.access.errorKey = null; s.access.error = null; });
      gateway
        .emailOtpRequest(email)
        .then((r) => {
          set((s) => {
            s.access.sending = false;
            s.access.step = 'emailcode';
            s.access.otp = '';
            s.access.devCode = r.devCode ?? null;
          });
        })
        .catch(() => set((s) => { s.access.sending = false; failAccess(s, { key: 'emailSendFailed' }); }));
    },
    accSetCode: (v) =>
      set((s) => { s.access.otp = v.replace(/\D/g, '').slice(0, 6); s.access.errorKey = null; s.access.error = null; }),
    emailOtpVerify: () => {
      const { email, otp, sending } = get().access;
      if (otp.length < 4 || sending) return;
      if (!gateway) {
        localEmailSignIn(email.trim().toLowerCase());
        return;
      }
      set((s) => { s.access.sending = true; s.access.errorKey = null; s.access.error = null; });
      gateway
        .emailOtpVerify(email.trim().toLowerCase(), otp)
        .then((res) => applyAuthResult(res))
        .catch(() => set((s) => { s.access.sending = false; s.access.otp = ''; failAccess(s, { key: 'emailWrongCode' }); }));
    },
    requestOtp: () => {
      const { phone, sending } = get().access;
      if (sending) return;
      if (phone.length < 10) {
        set((s) => { failAccess(s, { key: 'enterMobile' }); });
        return;
      }
      // local demo (no API): skip straight to the code screen
      if (!gateway) {
        set((s) => {
          s.access.step = 'otp';
          s.access.otp = '';
          s.access.errorKey = null; s.access.error = null;
          s.access.devCode = null;
          s.access.channel = null;
          s.access.codeLength = 4;
        });
        return;
      }
      // round-2 Codex — "Sign in with email" stays tappable while this is in flight; a late answer must not
      // pull the person back from the email sign-in (the same generation guard as the password flows)
      const generation = get().access.generation;
      set((s) => { s.access.sending = true; s.access.errorKey = null; s.access.error = null; });
      gateway
        .requestOtp(phone)
        .then((r) => {
          if (get().access.generation !== generation) return;
          // a code sent for a number the person has since changed is not the code screen for the number shown
          if (get().access.phone !== phone) {
            set((s) => { s.access.sending = false; });
            return;
          }
          set((s) => {
            s.access.sending = false;
            s.access.step = 'otp';
            s.access.otp = '';
            s.access.devCode = r.devCode ?? null;
            // #827 one-screen sign-in: until SMS is live the code arrives by email, 4 digits long (the server says so in `codeLength`)
            s.access.channel = r.channel ?? null;
            s.access.codeLength = r.codeLength ?? 4;
          });
        })
        .catch((e: unknown) => {
          if (get().access.generation !== generation) return;
          // a failure for a number the person has since changed says nothing about the number shown
          const failure = get().access.phone === phone ? accessError(otpRequestFailure(e), get().lang) : null;
          set((s) => {
            s.access.sending = false;
            if (failure) {
              s.access.error = failure.text;
              s.access.errorKey = failure;
            }
          });
        });
    },
    otpPress: (d) => {
      const cur = get().access.otp;
      if (get().access.sending) return;
      if (d === 'del') {
        set((s) => { s.access.otp = cur.slice(0, -1); s.access.errorKey = null; s.access.error = null; });
        return;
      }
      const length = get().access.codeLength ?? 4;
      if (cur.length >= length) return;
      const otp = cur + d;
      set((s) => { s.access.otp = otp; s.access.errorKey = null; s.access.error = null; });
      if (otp.length === length) {
        // the short pause lets the last digit show; if the person leaves, deletes or retypes in it, nothing is sent
        const generation = get().access.generation;
        setTimeout(() => {
          const now = get().access;
          if (now.generation === generation && now.step === 'otp' && now.otp === otp) get().otpVerify();
        }, 250);
      }
    },
    otpVerify: () => {
      const a = get().access;
      if (a.otp.length < (a.codeLength ?? 4) || a.sending) return;

      // team → sign in with the REAL role the server returns (a phone can belong to
      // any provisioned member — client / contractor / pmc / engineer), not always
      // engineer; trade → local scoped mistri view. The demo (no server) defaults to
      // engineer, the on-site onboarding persona.
      const signIn = (name: string | null, token: string | null, role: Role, projectId?: string): void => {
        if (a.who === 'team') {
          if (token) {
            // real session: adopt token + role + the token's project identity
            applyAuthResult({ role, token, name: name ?? undefined, projectId }, { msg: 'Verified ✓ — signed in as ' + (name ?? role) + '.' });
            return;
          }
          // local demo: persona sign-in, no token/project change
          set((s) => {
            s.role = role;
            s.screen = screensFor(role)[0]?.key ?? 'inbox';
            s.sessionToken = null;
            s.userName = name;
            s.access = freshAccess(s.access.generation + 1);
          });
          get().flash('Verified ✓ — signed in as ' + (name ?? role) + '.');
        } else {
          set((s) => { s.access.step = 'tradehome'; s.access.sending = false; });
          get().flash('Verified ✓ — ' + (a.trade ?? '') + ' in-charge signed in.');
        }
      };

      // local demo (no API): any 4-digit code signs in as the demo engineer
      if (!gateway) {
        signIn(null, null, 'engineer');
        return;
      }

      // round-2 Codex — a verify answer that lands after the person left for the email sign-in signs nothing in
      const generation = a.generation;
      // #886: a check of a code that already met "could not check" may find it used by that first check
      const retry = a.errorKey?.key === 'checkFailed';
      set((s) => { s.access.sending = true; s.access.errorKey = null; s.access.error = null; });
      gateway
        .verifyOtp(a.phone, a.otp)
        .then((res) => {
          if (get().access.generation !== generation) return;
          signIn(res.name ?? null, res.token, res.role, res.projectId);
        })
        .catch((e: unknown) => {
          if (get().access.generation !== generation) return;
          const failure = accessError(otpVerifyFailure(e, retry), get().lang);
          set((s) => {
            s.access.sending = false;
            // #886: only a code the server judged is cleared; one that could not be checked, or a check that was
            // throttled before the code was looked at, stays for another try
            if (failure.key === 'wrongCode' || failure.key === 'retryRefused') s.access.otp = '';
            s.access.error = failure.text;
            s.access.errorKey = failure;
          });
        });
    },
    pickWorker: (w) => {
      // best-effort: register the device server-side (proves the endpoint); the
      // job card is a self-contained local view either way.
      if (gateway) gateway.workerToken(w.name, w.trade).catch(() => {});
      set((s) => {
        s.access.worker = w;
        s.access.step = 'jobcard';
      });
    },
    accReset: () => set((s) => { s.access = freshAccess(s.access.generation + 1); }),
    speakJob: () => {
      const langName = { en: 'English', hi: 'Hindi', gu: 'Gujarati' }[get().lang];
      get().flash('🔊 Reading the job aloud in ' + langName + '…');
    },
    workerDone: () => {
      const w = get().access.worker;
      get().flash('✓ ' + (w ? w.name : 'Worker') + ' marked today’s work done — sent to engineer.');
      get().accReset();
    },
    };
  }),
);
