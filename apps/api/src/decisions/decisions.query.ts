import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { OrgsParticipant } from '../orgs/orgs.participant';
import type { DecisionStatus } from '../domain/transitions';
import type { DeciderKind } from '@vitan/shared';
import type { Role } from '../common/auth';
import type { DecisionDto } from '../snapshot/types';
import { serializeDecision, decisionVisibleToViewer, hydrateStoredDecisionDto } from './decision-serialize';
import { kindedDecisionNoticeServed, kindedNoticeRevisionId, renderKindedDecisionNotice, type ApprovalRevisionFacts, type KindedNoticeEvent } from './decision-notice';
import { DECISIONS_PROJECTION } from './decisions.projection';
import { consultationOpen } from './consultation-open';
import { RoleStandingQuery, type KernelReadClient } from '../platform/role-standing.query';
import { readServableGeneration, stillServableAfterRead } from '../platform/projections/generation';

/**
 * Phase 2 Task 8 — the decisions module's PUBLIC READ boundary (its query contract).
 *
 * The first backend extraction: no other module reads `decision`/`decisionOption`/`decisionEvent`/
 * `changeRequest` persistence directly. Every cross-module read a consumer needs is a narrow,
 * same-transaction-safe query answered HERE, so the module owns its private repository and is reachable
 * only via its contract (commands + these queries) + its events. The boundary CI check
 * (module-registry) enforces that the decision models are read-encapsulated — a stray `prisma.decision`
 * read in another module is a `cross-module-read` finding.
 *
 * Each method is a plain read on the injected client; none mutates. They map exactly onto the reads the
 * consumers performed before extraction — the snapshot serialization (moved here verbatim so the
 * snapshot shape is byte-identical), the existence/tenant checks, and the two counts — so the observable
 * behavior is unchanged.
 */
@Injectable()
export class DecisionsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    // round-3 Codex F2 — the decider push family's claim-time predicate asks the ORGS-owned
    // project-operability question through the declared participant edge (decisions already
    // lists `orgs` in `workflowParticipants`; the models stay read-encapsulated).
    private readonly orgsParticipant: OrgsParticipant,
  ) {}

  /**
   * The decisions slice of the project snapshot: the role-filtered `DecisionDto[]` the store hydrates,
   * PLUS an unfiltered `id → status` map the activities readiness derivation consults (readiness must
   * see the true decision status regardless of a role's visibility). One query serves both.
   */
  async snapshotSlice(
    projectId: string,
    role: Role,
    userId?: string,
    /** 4d-ii-a / A4c — the snapshot passes its REPEATABLE READ transaction, so the slice and the
     *  notification feed judged against it are one snapshot. */
    client: Pick<Prisma.TransactionClient, 'decision'> & KernelReadClient = this.prisma,
  ): Promise<{ decisions: DecisionDto[]; statuses: Map<string, DecisionStatus>; drafts: Set<string>; deciders: Map<string, DeciderKind> }> {
    const rows = await client.decision.findMany({
      where: { projectId },
      // the OPEN change request travels with a reopened decision (Phase 1 Task 2)
      // Phase 6 unit 4c-ii — the LIVE slice reads exactly what the projection's `DECISION_INCLUDE`
      // reads, because both hand the SAME `serializeDecision` its row: a live/projection drift in
      // the consultation thread would otherwise be invisible until a rebuild.
      include: {
        options: { orderBy: { order: 'asc' } },
        changeRequests: { where: { status: 'open' }, take: 1 },
        deciderMembership: { select: { userId: true } },
        consultations: { include: { response: true } },
        approvalRevisions: { select: { version: true, finalized: true } },
      },
      orderBy: { id: 'desc' },
    });

    const statuses = new Map<string, DecisionStatus>(rows.map((d) => [d.id, d.status as DecisionStatus]));
    // Phase 6 task 4b (§A.2) — the UNFILTERED draft-id set beside the status map: the readiness
    // bake's recorded arm gates a DRAFT record `wait` (a private record must not unblock work).
    const drafts = new Set<string>(rows.filter((d) => d.publishedAt === null).map((d) => d.id));
    // Replacement round (Codex R2-F3) — WHO holds each decision, beside the status map: the
    // readiness bake names the ACTUAL decider in the gate's waiting text.
    const deciders = new Map<string, DeciderKind>(rows.map((d) => [d.id, d.deciderKind as DeciderKind]));

    // The serialization + the per-viewer filter are the SAME functions the decisions projection uses
    // (decision-serialize.ts), so the projection-served slice is byte-identical to this live slice.
    const decisions: DecisionDto[] = rows
      .filter((d) =>
        decisionVisibleToViewer(
          // the RESOLVED decider user rides the membership join — the predicate compares users
          { ...d, deciderUserId: d.deciderMembership?.userId ?? null },
          role,
          userId,
        ),
      )
      .map(serializeDecision);

    return { decisions: await this.overlayCountersign(client, projectId, decisions), statuses, drafts, deciders };
  }

  /**
   * Phase 6 task 4d (§A.2) — the `countersignRequired` overlay, applied by BOTH read paths at read
   * time (it is never stored in the projection, so no fold needs refreshing when the standing
   * changes): one keyed lookup per response through the kernel register the approve CAS and the seals
   * judge the chain by. Serialized only when true, so a project with no active architect is served
   * exactly the DTO it was served before.
   */
  private async overlayCountersign(client: KernelReadClient, projectId: string, decisions: DecisionDto[]): Promise<DecisionDto[]> {
    if (decisions.length === 0) return decisions;
    if ((await RoleStandingQuery.activeCount(client, projectId, 'architect')) === 0) return decisions;
    return decisions.map((d) => ({ ...d, countersignRequired: true as const }));
  }

  /**
   * Phase 6 task 4d-ii-a / A4c — a KINDED decision notice as this viewer is served it: rendered from
   * its kind and bound event, or `null` when it is hidden (its decision is not in the viewer's slice,
   * it is an actionable kind of a withdrawn decision, or a pending demand for someone who does not
   * decide) or this release has no renderer arm for its kind. `decision` is the viewer's visible DTO
   * from {@link snapshotSlice}, read in the same snapshot as the notice. See `decision-notice.ts`.
   */
  renderKindedNotice(
    kind: string,
    event: KindedNoticeEvent,
    decision: DecisionDto | undefined,
    role: Role,
    userId?: string,
    /** 4d-ii-a / A7a — the revisions the feed's events name, from {@link kindedNoticeRevisions}. */
    revisions?: ReadonlyMap<string, ApprovalRevisionFacts>,
  ): { text: string; color: string } | null {
    if (!decision || !kindedDecisionNoticeServed(kind, event, decision, role, userId)) return null;
    return renderKindedDecisionNotice(kind, event, revisions, decision.id);
  }

  /**
   * Phase 6 task 4d-ii-a / A7a — the approval revisions the feed's kinded events NAME
   * (`payload.revisionId` on `decision.approved`/`reapproved`), by id: the approved option's material
   * and the on-behalf fact the green notice renders. A decisions-owned read (the revision register is
   * this module's), run by the snapshot on the SAME REPEATABLE READ transaction as the feed and the
   * decision slice, so a notice, its decision and its revision are one snapshot. An event naming a
   * revision this project does not hold gets none, and its notice renders nothing; one naming another
   * decision's revision is refused by the renderer (the facts carry `decisionId`), as the database's
   * revision claimant refuses it at commit (#665's review round 1).
   */
  async kindedNoticeRevisions(
    client: Pick<Prisma.TransactionClient, 'decisionApprovalRevision'>,
    projectId: string,
    events: ReadonlyMap<string, KindedNoticeEvent>,
  ): Promise<Map<string, ApprovalRevisionFacts>> {
    const ids = new Set<string>();
    for (const event of events.values()) {
      const id = kindedNoticeRevisionId(event.eventType, event);
      if (id) ids.add(id);
    }
    if (ids.size === 0) return new Map();
    const rows = await client.decisionApprovalRevision.findMany({
      where: { projectId, id: { in: [...ids] } },
      select: { id: true, decisionId: true, onBehalfOf: true, option: { select: { material: true } } },
    });
    return new Map(rows.map((r) => [r.id, { decisionId: r.decisionId, material: r.option.material, onBehalfOf: r.onBehalfOf }]));
  }

  /**
   * Phase 2 Task 10 — the UNFILTERED `id → status` map alone (no DTO serialization). The activities
   * module bakes each activity's readiness from this at read time (readiness must see the true decision
   * status regardless of a role's visibility); the snapshot instead passes the `statuses` it already got
   * from {@link snapshotSlice} so it never reads twice.
   */
  async statusMap(projectId: string): Promise<Map<string, DecisionStatus>> {
    const rows = await this.prisma.decision.findMany({ where: { projectId }, select: { id: true, status: true } });
    return new Map(rows.map((d) => [d.id, d.status as DecisionStatus]));
  }

  /** Phase 6 task 4b (§A.2) — `statusMap` plus the UNFILTERED draft-id set, for readiness bakes
   *  that must gate a linked DRAFT record `wait` (the recorded arm consults the draft flag). */
  async statusAndDraftMap(projectId: string): Promise<{ statuses: Map<string, DecisionStatus>; drafts: Set<string>; deciders: Map<string, DeciderKind> }> {
    const rows = await this.prisma.decision.findMany({ where: { projectId }, select: { id: true, status: true, publishedAt: true, deciderKind: true } });
    return {
      statuses: new Map(rows.map((d) => [d.id, d.status as DecisionStatus])),
      drafts: new Set(rows.filter((d) => d.publishedAt === null).map((d) => d.id)),
      deciders: new Map(rows.map((d) => [d.id, d.deciderKind as DeciderKind])),
    };
  }

  /**
   * Phase 4 Task 1 (correction F1) — the status of ONE linked decision, read on the GIVEN client so
   * the activity `start` command can consult it INSIDE its readiness-locked transaction (a concurrent
   * approval serializes) WITHOUT a cross-module `activity.decision` Prisma include. Returns null when
   * the decision is not in this project (a cross-project link is not this project's decision).
   */
  async statusOf(projectId: string, decisionId: string, db: Prisma.TransactionClient = this.prisma): Promise<DecisionStatus | null> {
    const row = await db.decision.findFirst({ where: { id: decisionId, projectId }, select: { status: true } });
    return row ? (row.status as DecisionStatus) : null;
  }

  /** Phase 6 task 4b (§A.2) — `statusOf` plus the DRAFT flag, for the in-tx `activities.start`
   *  gate: a linked draft RECORD must refuse the start (`wait`) until its author publishes it. */
  async statusAndDraftOf(
    projectId: string,
    decisionId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ status: DecisionStatus; draft: boolean; deciderKind: DeciderKind } | null> {
    const row = await db.decision.findFirst({ where: { id: decisionId, projectId }, select: { status: true, publishedAt: true, deciderKind: true } });
    return row ? { status: row.status as DecisionStatus, draft: row.publishedAt === null, deciderKind: row.deciderKind as DeciderKind } : null;
  }

  /**
   * Phase 2 Task 9 — the decisions slice served from the REBUILDABLE PROJECTION (`decisions.inbox`)
   * instead of the live join. Reads the project's ACTIVE generation's `DecisionProjection` rows (the
   * pre-serialized `DecisionDto`s the projection consumer refreshed from canonical) and applies the
   * SAME per-viewer authz filter as {@link snapshotSlice} (via `decisionVisibleToViewer`) — so a
   * projection read is never an RBAC bypass, and the result is byte-identical to the live slice.
   *
   * `generation` is the served generation number — null when there is no generation SAFE to serve.
   * Task 10 finalization: this read now applies the same {@link readServableGeneration} currency
   * discipline as every other module (daily-log/drawings/inspections/activities) — a generation that
   * is blocked, merely bootstrapped, or whose checkpoint lags the committed stream head returns
   * `generation: null`, so the caller falls back to the always-current live slice instead of serving
   * a stale-but-active generation as authoritative.
   */
  async projectionSlice(
    projectId: string,
    role: Role,
    userId?: string,
  ): Promise<{ decisions: DecisionDto[]; statuses: Map<string, DecisionStatus>; generation: number | null }> {
    const gen = await readServableGeneration(this.prisma, DECISIONS_PROJECTION, projectId);
    if (!gen) return { decisions: [], statuses: new Map(), generation: null };

    const rows = await this.prisma.decisionProjection.findMany({
      where: { generationId: gen.id },
      // the snapshot slice orders decisions by id descending — mirror it so the served array matches
      orderBy: { decisionId: 'desc' },
    });
    // …AND ASK THE FENCE AGAIN, now that the rows are in hand (Codex on `de9fa3b7`). The gate above
    // and this fetch are separate READ COMMITTED statements, so a previous-release relay can commit
    // its rewrite and the fence's stamp in between: the gate would see an unfenced, caught-up
    // generation and the fetch would return the very rows the fence exists to keep off the wire.
    // The stamp is append-only, so NULL before and NULL after means nothing undeclared entered this
    // generation across the window; anything else falls back to the canonical live read.
    if (!(await stillServableAfterRead(this.prisma, gen.id))) {
      return { decisions: [], statuses: new Map(), generation: null };
    }
    // The per-decision-row analogue of the composite modules' row-exists check: a generation that
    // only NOOP deliveries advanced (bootstrapped over pre-stream rows, no decision event applied
    // yet) is caught-up but HOLLOW — zero rows while canonical decisions exist. Serving it would
    // hide the whole register; fall back to live instead. A genuinely decision-less project serves
    // projection-empty (the cheap existence probe confirms it).
    if (rows.length === 0) {
      const any = await this.prisma.decision.findFirst({ where: { projectId }, select: { id: true } });
      if (any) return { decisions: [], statuses: new Map(), generation: null };
    }
    // the readiness map is UNFILTERED (every decision's true status), exactly like snapshotSlice
    const statuses = new Map<string, DecisionStatus>(rows.map((r) => [r.decisionId, r.status as DecisionStatus]));
    // Phase 6 task 4b (§A.3) — the projection ROW carries the decider designation inside its
    // stored dto (kind + the resolved decider USER, derived by the ONE fold `serializeDecision`
    // so live == projection == rebuild by construction); the read-path filter narrows on it, so
    // a projection read can tell the named decider from a same-role non-decider — no leak, no
    // hidden action item.
    // A projection row WRITTEN BEFORE 4b stores a dto without the decider fields. Its semantic is
    // exactly the column backfill's: every legacy decision is `client`-held. Normalize at the read
    // (the PR-#209 hydration pattern) so a legacy generation neither hides a pending decision from
    // the client nor serves a dto the web's shared predicate cannot judge; the next applied event
    // or rebuild re-serializes the row with the fields stored.
    const decisions = rows
      .map((r) => ({ row: r, dto: hydrateStoredDecisionDto(r.dto as unknown as DecisionDto) }))
      .filter(({ row, dto }) =>
        decisionVisibleToViewer(
          {
            publishedAt: row.publishedAt,
            authorId: row.authorId,
            status: row.status,
            deciderKind: dto.deciderKind,
            deciderUserId: dto.deciderUserId ?? null,
            // Phase 6 unit 4c-ii — the widened audience is judged from the SAME stored dto the
            // live path derives, so a projection read admits exactly the consultees a live read
            // admits and no more.
            consultations: dto.consultations,
            approvalCycle: dto.approvalCycle,
          },
          role,
          userId,
        ),
      )
      .map(({ dto }) => dto);
    return { decisions: await this.overlayCountersign(this.prisma, projectId, decisions), statuses, generation: gen.generation };
  }

  /**
   * Phase 2 Task 9 — the MODULE-OWNED decision read the frontend calls (the `GET …/decisions`
   * endpoint). Serves from the rebuildable projection when it has an active generation; otherwise
   * falls back to the live slice (a project whose decision events the relay has not applied yet, or a
   * legacy project never rebuilt) — additive and correct, never empty during warm-up. `source` tells
   * the client which path served it (observability; the DTOs are byte-identical either way).
   */
  async moduleDecisions(
    projectId: string,
    role: Role,
    userId?: string,
  ): Promise<{ decisions: DecisionDto[]; source: 'projection' | 'live'; generation: number | null }> {
    const proj = await this.projectionSlice(projectId, role, userId);
    if (proj.generation !== null) return { decisions: proj.decisions, source: 'projection', generation: proj.generation };
    const live = await this.snapshotSlice(projectId, role, userId);
    return { decisions: live.decisions, source: 'live', generation: null };
  }

  /**
   * Phase 6 task 4b (§A.3, class round-5 obligations) — the DECIDER push family's claim-time
   * predicate: is a queued "decide this" push STILL ACTIONABLE, and for whom? Re-judged at claim
   * from the decision's CURRENT row, so a change committed between enqueue and claim re-targets
   * the delivery to the current holder or drops it:
   *   - the decision must still exist, be published, and its status still DEMAND a decision
   *     (`pending`/`change`) — an approved/withdrawn/recorded subject drops;
   *   - a role-held decision targets its role;
   *   - a member-held decision targets the named member's USER — and the STANDING arm: a
   *     membership no longer active drops the push (never a "decide this" demand to a revoked
   *     target);
   *   - round-3 Codex F2 — the PROJECT itself must still be operable: archival keeps the
   *     decision pending and its memberships intact, but `ProjectAccessService.authorize`
   *     refuses every request against an archived project, so a delivered demand could not be
   *     opened or satisfied. The owning module answers (participant edge); not-operable drops.
   *     Round-5 Codex F1 — operability and the decision state are judged in ONE transaction:
   *     `isProjectOperable` takes the project row FOR UPDATE, and holding that lock to commit
   *     covers the decision read, so an archival committing mid-predicate either happened
   *     before (seen — dropped) or waits for this claim's commit — the operable answer can
   *     never go stale between the check and the decision it authorises.
   */
  async deciderPushTarget(
    projectId: string,
    decisionId: string,
  ): Promise<{ actionable: false } | { actionable: true; roles?: string[]; targetUserId?: string }> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.orgsParticipant.isProjectOperable(tx, projectId))) return { actionable: false };
      // 4d-ii-a / A7b (plan §A.4, "the decider push follows the forward AT CLAIM") — the delivered
      // read was a plain `findFirst`, correct while the holder could not move after publication. A
      // forward (A8a) moves it, so the holder is read UNDER THE DECISION ROW LOCK, in the canonical 4c
      // order: this unlocked lookup chooses WHICH membership to lock (it decides nothing), the
      // membership is locked FIRST (`decisions.approve` locks the named decider's membership before
      // the decision row, so a decision-first claim would complete an AB-BA cycle against it), then
      // the decision `FOR SHARE`, and every fact the verdict rests on is read under that lock.
      const peek = await tx.decision.findFirst({ where: { id: decisionId, projectId }, select: { deciderKind: true, deciderMembershipId: true } });
      if (!peek) return { actionable: false };
      const member = peek.deciderKind === 'member' && peek.deciderMembershipId
        ? await this.orgsParticipant.lockActiveMembershipById(tx, projectId, peek.deciderMembershipId)
        : null;
      const rows = await tx.$queryRaw<Array<{ status: string; publishedAt: Date | null; deciderKind: string; deciderMembershipId: string | null }>>`
        SELECT "status"::text AS status, "publishedAt", "deciderKind"::text AS "deciderKind", "deciderMembershipId"
          FROM "Decision" WHERE "projectId" = ${projectId} AND "id" = ${decisionId}
           FOR SHARE`;
      const d = rows[0];
      if (!d || d.publishedAt === null) return { actionable: false };
      if (d.status !== 'pending' && d.status !== 'change') return { actionable: false };
      if (d.deciderKind === 'client') return { actionable: true, roles: ['client'] };
      if (d.deciderKind === 'pmc') return { actionable: true, roles: ['pmc'] };
      if (d.deciderKind === 'member') {
        if (d.deciderMembershipId !== peek.deciderMembershipId) {
          // the holder moved between the lookup and the lock (a forward landed): locking the new
          // holder's membership HERE would take it after the decision row — the AB-BA order — so the
          // claim is refused as contended and the relay retries it, re-judging in the canonical order
          throw new Error(`decider push claim for ${decisionId} contended: the holder moved during the claim — retried`);
        }
        // the STANDING arm: the named member's membership must still be ACTIVE (a "decide this"
        // demand never reaches a revoked target); `lockActiveMembershipById` answers null otherwise
        if (!member) return { actionable: false };
        return { actionable: true, targetUserId: member.userId };
      }
      return { actionable: false };
    });
  }

  /**
   * Phase 6 unit 4c-ii (§B P38c) — the `decision.consultation_requested` family's claim-time
   * predicate: is a queued "you were asked" push still worth sending to THIS user?
   *
   * The target is the consultee, so the question is answered from the decision plus that user:
   * does a consultation on this decision still STAND for them? Every arm below is a state that
   * can change between enqueue and claim, and each one would otherwise deliver decision content
   * to someone who must not receive it, or invite an action the server now refuses.
   *
   * The lock order is the canonical 4c one — `Project` first, then `Decision` — for the reason
   * §A gives: `decisions.approve` locks a membership before the decision row, so a
   * decision-first claim would complete an AB-BA cycle against it.
   */
  async consultationRequestedPushTarget(
    projectId: string,
    decisionId: string,
    targetUserId: string | null,
  ): Promise<{ actionable: false } | { actionable: true; roles?: string[]; targetUserId?: string }> {
    return this.prisma.$transaction(async (tx) => {
      // (1) PROJECT OPERABILITY FIRST. A push queued before the project was archived would
      // otherwise still deliver decision content after project authorization refuses access: the
      // decision stays open, the consultation stands, and memberships can stay active, so no
      // other arm catches it.
      if (!(await this.orgsParticipant.isProjectOperable(tx, projectId))) return { actionable: false };
      if (!targetUserId) return { actionable: false };

      // (2) MEMBERSHIP BEFORE DECISION — the canonical 4c order, and the reason it exists.
      // `decisions.approve` takes the readiness key, then the named decider's membership, and
      // only then updates the `Decision` row. When the push target IS that decider — ordinary,
      // since the person best placed to advise is often the one deciding — a claim holding
      // `Decision` and waiting for `Membership` completes an AB-BA cycle against a concurrent
      // approval holding `Membership` and waiting for `Decision`, and PostgreSQL aborts one of
      // them: either the approval or this delivery fails.
      //
      // The unlocked lookup below chooses WHICH membership to lock; it decides nothing. Every
      // predicate the verdict rests on is re-read under the decision lock in (4).
      //
      // ONE row is enough, and that is a schema fact rather than an assumption: `Membership` is
      // `@@unique([projectId, userId])`, so a user holds at most one membership per project for
      // its whole life — a removal and re-add flips `status` on the SAME row. Every consultation
      // naming this user on this decision therefore names the same `consulteeMembershipId`, and
      // there is no second row a `findFirst` could pick wrongly.
      const candidate = await tx.decisionConsultation.findFirst({
        where: { projectId, decisionId, consulteeUserId: targetUserId },
        select: { consulteeMembershipId: true },
      });
      if (!candidate) return { actionable: false };
      // the consultee's membership must still be ACTIVE at claim time: the intent names a USER,
      // and a membership removed between enqueue and claim would otherwise still deliver decision
      // content to that user's still-linked subscription after they lost standing
      const member = await this.orgsParticipant.lockActiveMembershipById(tx, projectId, candidate.consulteeMembershipId);
      if (!member || member.userId !== targetUserId) return { actionable: false };

      // (3) the DECISION row, locked BEFORE its status and cycle are judged. The project lock
      // serializes ARCHIVAL and nothing else, so a claim that then read the decision plainly could
      // see `pending`, lose the race to an approval committing on the `Decision` row, and still
      // send a request-to-respond push for a consultation that approval just closed.
      const rows = await tx.$queryRaw<Array<{ status: string; publishedAt: Date | null }>>`
        SELECT "status"::text AS status, "publishedAt" FROM "Decision"
         WHERE "projectId" = ${projectId} AND "id" = ${decisionId}
         FOR SHARE`;
      const d = rows[0];
      // The SAME published-and-open predicate the write path uses — not merely "not withdrawn".
      // An APPROVE committing between enqueue and claim leaves the project operable, the
      // membership active, the consultation unanswered and the decision un-withdrawn, so a
      // not-withdrawn test would send a request-to-respond push for a question the respond
      // command now answers with a 409: a push inviting an action the server refuses.
      if (!d || d.publishedAt === null || !consultationOpen(d.status)) return { actionable: false };

      // (4) …and NOW the standing consultation, re-read under that lock: the frozen cycle must
      // still be current (a `requestChange` reopen would otherwise resurrect a delivery the
      // approval cancelled), and the consultee who saw the in-app thread and ANSWERED before the
      // delivery was claimed must not be pushed to do what they have already done.
      // (4d-ii-a / A4a: the cycle counts FINALIZED approvals, as the request froze it)
      const cycle = await tx.decisionApprovalRevision.count({ where: { decisionId, finalized: true } });
      const standing = await tx.decisionConsultation.findFirst({
        where: {
          projectId, decisionId, consulteeUserId: targetUserId,
          consulteeMembershipId: candidate.consulteeMembershipId,
          openCycle: cycle,
          response: { is: null },
        },
        select: { id: true },
      });
      if (!standing) return { actionable: false };
      return { actionable: true, targetUserId };
    });
  }

  /**
   * Phase 6 unit 4c-ii (§B P40c) — the `decision.consultation_responded` family's claim-time
   * predicate: the answer went to whoever ASKED, and the push is still warranted only while that
   * person still holds the standing that let them ask.
   *
   * A requester may be an org-admin USER with no membership row on this project, which is why the
   * target is user-keyed and the standing question goes to the orgs-owned answer rather than to a
   * membership lookup.
   */
  async consultationRespondedPushTarget(
    projectId: string,
    decisionId: string,
    targetUserId: string | null,
  ): Promise<{ actionable: false } | { actionable: true; roles?: string[]; targetUserId?: string }> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.orgsParticipant.isProjectOperable(tx, projectId))) return { actionable: false };
      if (!targetUserId) return { actionable: false };

      // MEMBERSHIP BEFORE DECISION, for the same AB-BA reason as the requested family:
      // `hasProjectRoleStanding(forUpdate)` locks the requester's membership row, and a
      // concurrent approval holds a membership while waiting to update the decision. The
      // requester must STILL hold requesting standing — a demoted requester is dropped with the
      // recorded cancellation mark rather than told about advice they can no longer act on.
      // 4d-ii-a / A7b (plan §A.2, the consultation carve-out) — the requesting set is `pmc` OR the
      // ARCHITECT role (the kernel register, A5c's `consultationRequesterStanding` rule), because
      // an architect may ask; the PMC arm is remembered for the withdrawn-audience rule below.
      const pmcStanding = await this.orgsParticipant.hasProjectRoleStanding(tx, projectId, targetUserId, ['pmc'], { forUpdate: true });
      const standing = pmcStanding || (await RoleStandingQuery.holdsRole(tx, projectId, targetUserId, 'architect'));
      if (!standing) return { actionable: false };

      const rows = await tx.$queryRaw<Array<{ status: string; publishedAt: Date | null }>>`
        SELECT "status"::text AS status, "publishedAt" FROM "Decision"
         WHERE "projectId" = ${projectId} AND "id" = ${decisionId}
         FOR SHARE`;
      const d = rows[0];
      if (!d || d.publishedAt === null) return { actionable: false };
      // Deliberately NO open-status arm here, and the difference from the `requested` family is
      // the point. That family invites an ACTION, so a decision that has left the open set makes
      // the invitation false. This one reports that advice was GIVEN — which stays true after an
      // approval, and is exactly what the person who asked wants to know. What must still be
      // re-judged is whether this user may see decision content at all, which the standing arm
      // above covers for every status but one:
      // 4d-ii-a / A7b — THE WITHDRAWN-AUDIENCE ARM (plan §A.2). A withdrawn decision is pmc-only
      // (§A.3), so its response push reaches a requester only while they hold PMC standing: a PMC
      // requester keeps the delivered behaviour byte-for-byte, and any other requester (the
      // architect) is dropped with the recorded mark, since the decision's very title is content
      // they may no longer see.
      if (d.status === 'withdrawn' && !pmcStanding) return { actionable: false };
      const asked = await tx.decisionConsultation.findFirst({
        where: { projectId, decisionId, requestedById: targetUserId, response: { isNot: null } },
        select: { id: true },
      });
      if (!asked) return { actionable: false };
      return { actionable: true, targetUserId };
    });
  }

  /** Does decision `decisionId` exist in project `projectId`? The tenant-ownership check a consumer
   *  runs before storing a reference to it (activities' `assertRefs`, daily-log's material link). */
  async existsInProject(projectId: string, decisionId: string): Promise<boolean> {
    const row = await this.prisma.decision.findFirst({ where: { id: decisionId, projectId }, select: { id: true } });
    return row !== null;
  }

  /** Phase 6 task 4a round 9 (Codex): existence is not LINKABILITY — a WITHDRAWN decision is
   *  terminal, so new work must never pin itself to it (the gate would wait forever on a
   *  question nobody is being asked). The write-path twin of the web picker rule: the caller
   *  distinguishes the two refusals because `activity.manage` is a pmc authority and the
   *  honest withdrawn reason is the right answer there.
   *
   *  Round 10 (Codex): a plain read is UX only — the AUTHORITY is the tx-bearing form. Called
   *  inside the consumer's command transaction it takes `FOR SHARE` on the decision row, so it
   *  serializes with `decisions.withdraw` (whose CAS updates this row): a withdrawal committing
   *  between a stale pre-check and the link is seen by the re-check, and a link holding the
   *  share lock delays the withdrawal until the (legitimately pre-terminal) link commits. */
  async linkableInProject(projectId: string, decisionId: string, tx?: Prisma.TransactionClient): Promise<'linkable' | 'withdrawn' | 'missing'> {
    if (tx) {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS status FROM "Decision"
         WHERE "id" = ${decisionId} AND "projectId" = ${projectId}
         FOR SHARE`;
      if (rows.length === 0) return 'missing';
      return rows[0]!.status === 'withdrawn' ? 'withdrawn' : 'linkable';
    }
    const row = await this.prisma.decision.findFirst({ where: { id: decisionId, projectId }, select: { status: true } });
    if (!row) return 'missing';
    return (row.status as string) === 'withdrawn' ? 'withdrawn' : 'linkable';
  }

  /**
   * Resolve an OPTIONAL decision reference the same way `resolveProjectRef('decision', …)` did before
   * extraction: null/undefined pass through; a present id must belong to THIS project or the write is
   * rejected with a human-readable error (the composite `(projectId, id)` FK is the DB backstop).
   */
  async resolveRefInProject(projectId: string, id: string | null | undefined, field = 'decisionId'): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }

  /** How many decisions are filed under any of `nodeIds` — the guard a node delete runs before
   *  removing a location subtree. */
  countByNodeIds(nodeIds: string[]): Promise<number> {
    return this.prisma.decision.count({ where: { nodeId: { in: nodeIds } } });
  }

  /** How many of a project's PUBLISHED pending decisions await THIS VIEWER — the portfolio tile
   *  count. Task 10 finalization: a DRAFT (`publishedAt` null) is weightless — it is not awaiting
   *  anyone, and counting it here leaked an author-private draft into portfolio rollups.
   *  Phase 6 task 4b (§A.3) — the count FOLLOWS the decider: pmc sees every pending decision
   *  (they manage the register); every other viewer counts only the decisions THEY decide — the
   *  `client`-held rows for a client, the rows NAMING them for a member-decider — so a named
   *  engineer-decider's portfolio card reports their obligation and a same-role non-decider's
   *  reports zero.
   *  Phase 6 task 4d (§A.1) — the count ALSO serves the project shell's badge (`shellSummary`), so the
   *  badge and the Portfolio tile agree; it gains the `architect` role arm (an architect counts the
   *  pending decisions designated to the role) and the viewer's COUNTERSIGN obligations: every
   *  decision awaiting countersign is an architect's, and while the chain is INACTIVE (no active
   *  architect) each one is STRANDED and is the PMC's to resolve. */
  async countPending(projectId: string, viewer: { role: Role; userId?: string }): Promise<number> {
    const published = { projectId, publishedAt: { not: null } };
    const base: Prisma.DecisionWhereInput = { ...published, status: 'pending' };
    const awaiting: Prisma.DecisionWhereInput = { ...published, status: 'awaiting_countersign' };
    if (viewer.role === 'pmc') {
      const [pending, stranded] = await Promise.all([
        this.prisma.decision.count({ where: base }),
        this.countStranded(projectId, awaiting),
      ]);
      return pending + stranded;
    }
    const decides: Prisma.DecisionWhereInput[] = [];
    if (viewer.role === 'client') decides.push({ deciderKind: 'client' });
    if (viewer.role === 'architect') decides.push({ deciderKind: 'architect' });
    if (viewer.userId) decides.push({ deciderKind: 'member', deciderMembership: { userId: viewer.userId } });
    const [pending, countersigns] = await Promise.all([
      decides.length === 0 ? Promise.resolve(0) : this.prisma.decision.count({ where: { ...base, OR: decides } }),
      viewer.role === 'architect' ? this.prisma.decision.count({ where: awaiting }) : Promise.resolve(0),
    ]);
    return pending + countersigns;
  }

  /** The decisions awaiting a countersign no active architect can give: all of them while the chain
   *  is inactive (the kernel register reads no architect), none while it is active. */
  private async countStranded(projectId: string, awaiting: Prisma.DecisionWhereInput): Promise<number> {
    if ((await RoleStandingQuery.activeCount(this.prisma, projectId, 'architect')) > 0) return 0;
    return this.prisma.decision.count({ where: awaiting });
  }
  /**
   * Phase 3 Task 1 correction round 2 (finding 2) — the AUTHORITATIVE, immutable decision
   * approval reference a material requirement pins as provenance. SERVER-resolved, never
   * caller-authored, and never derived:
   *   • the decision must be PUBLISHED and status `approved` (a pending, draft or reopened
   *     `change` decision cannot anchor procurement provenance — refused with a readable 400);
   *   • `decisionVersion` and `optionKey` come SOLELY from the head row of the decision's
   *     IMMUTABLE `DecisionApprovalRevision` register — written in the same transaction as
   *     each approve/reapprove. There is NO label fallback and NO event-count derivation: an
   *     approved decision with no register row (an ambiguous legacy approval the migration
   *     could not provably backfill) REFUSES until an operator repairs it.
   * Runs on the caller's transaction client when provided (same-tx validation, spec §6) —
   * the provenance a requirement pins is transactionally the register head.
   *
   * Phase 6 task 4d-ii-a / A4b (§A.2 "The finality key, stated exactly") — the head must also be
   * FINAL. Under the chain an approval is provisional until the architect countersigns it, and a
   * demand derived from it would be a commitment made on a decision nobody has finished making. An
   * unfinalized head is REFUSED, and the reference carries the head's `finalized` as
   * `revisionFinalized`, which every spec writer states: the specs' provenance FK targets the
   * register's widened key `(…, finalized)`, and 4d-iii drops the column's default, so a writer
   * that does not state it fails there.
   */
  async approvedRef(
    projectId: string,
    decisionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ decisionId: string; decisionVersion: number; optionKey: string; revisionFinalized: true }> {
    const client = tx ?? this.prisma;
    const d = await client.decision.findFirst({
      where: { id: decisionId, projectId },
      select: { id: true, publishedAt: true, status: true },
    });
    if (!d) throw new BadRequestException('decisionId does not belong to this project');
    if (d.publishedAt === null) throw new BadRequestException('A draft decision cannot anchor requirement provenance');
    if (d.status !== 'approved') {
      throw new BadRequestException(`Only an approved decision can anchor requirement provenance (status is '${d.status}')`);
    }
    const head = await client.decisionApprovalRevision.findFirst({
      where: { decisionId },
      orderBy: { version: 'desc' },
      select: { version: true, optionKey: true, finalized: true },
    });
    if (!head) {
      throw new BadRequestException('The approved decision has no immutable approval revision on record — operator repair is required before it can anchor requirement provenance');
    }
    if (!head.finalized) {
      throw new BadRequestException('The decision\'s approval is provisional until the architect countersigns it — it cannot anchor requirement provenance yet');
    }
    return { decisionId: d.id, decisionVersion: head.version, optionKey: head.optionKey, revisionFinalized: true };
  }

}
