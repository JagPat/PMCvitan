import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InspectionsModuleResult, ReadinessInspection, RecordingKind } from '@vitan/shared';
import { recordingKindOf } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { SignedUrlService } from '../media/signed-url.service';
import { bakeInspections, computeInspectionsBase, fieldViewMediaIds, type InspectionsBase, type InspectionsSlices } from './inspections-serialize';
import { bindingAssigneeIds } from './assignment-eligibility';
import { heldNamings } from './responsible-member';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { MediaParticipant } from '../media/media.participant';
import { INSPECTIONS_PROJECTION } from './inspections.projection';
import { readServableGeneration } from '../platform/projections/generation';
import { nextSeqId } from '../domain/ids';
import { isFailedItem } from './failed-item';
import { lineageApproval } from './inspection-lineage';
import { AuditQuery } from '../platform/audit.query';
import type { InspectionItemSpec } from '../contracts';
import { specFromItemRow } from './guided-item';

/** The CHECKLIST-definition structure a project-copy/module-extract reads from a source project through
 *  the inspections boundary: title + place + ordered item names (never results — reviews aren't structure). */
export interface InspectionChecklistStructure {
  title: string;
  zone: string;
  nodeId: string | null;
  /** Guided site inspections (step 2a) — the kind of work it checks, or null. */
  workType: string | null;
  /** Each item as a template carries it: a plain name, or a guided item with its guidance. */
  items: InspectionItemSpec[];
}

/**
 * Phase 2 Task 10 (Module 3) — the INSPECTIONS module's PUBLIC READ boundary (its query contract).
 *
 * A fully-extracted backend module: no other module reads `inspection`/`inspectionItem`/
 * `inspectionsProjection` persistence directly. Every cross-module read a consumer needs is a narrow
 * query answered HERE — the snapshot's five role-gated inspection slices (from the ONE canonical
 * serializer so the snapshot stays byte-identical), the inspection-gate READINESS input the activity-start
 * command evaluates under its project lock, and the tenant-ownership check a media evidence upload runs
 * before storing an `inspectionId`. Per-viewer/role visibility and each item's fresh signed evidence paths
 * are baked at read time ({@link bakeInspections}); the boundary CI check enforces the encapsulation.
 */
/**
 * Is this stored projection base the shape THIS release's serializer produces? Every entry of a current
 * base carries `assigneeId`, `dueDate` and `workType` (each a value or an explicit `null`); a v1 entry has neither key,
 * and an entry written before the #771 read contract has no `dueDate`. Checked by key presence rather than
 * truthiness, because `null` is a legitimate current value (unassigned / no due date). An older row is
 * refused and the read falls back to the canonical live slice, so a re-inspection that HAS a due date is
 * never served as having none; the row becomes servable again the next time an `inspection.*` event
 * refreshes it, or on a rebuild.
 */
const CURRENT_BASE_KEYS = ['assigneeId', 'dueDate', 'workType'] as const;
/** Guided site inspections (step 2a) — each item of a current base carries `guide` (null for an item issued by name
 *  only). A base written before it has no such key on its items, and is refused the same way, so a guided item is never
 *  served as a plain one. */
const CURRENT_ITEM_KEYS = ['guide'] as const;
function isCurrentInspectionsBase(base: InspectionsBase): boolean {
  const entries = (base as unknown as { inspections?: unknown[] }).inspections;
  if (!Array.isArray(entries)) return false;
  const hasKeys = (v: unknown, keys: readonly string[]): boolean => v !== null && typeof v === 'object' && keys.every((k) => k in (v as object));
  return entries.every((e) => {
    if (!hasKeys(e, CURRENT_BASE_KEYS)) return false;
    const items = (e as { items?: unknown }).items;
    return Array.isArray(items) && items.every((it) => hasKeys(it, CURRENT_ITEM_KEYS));
  });
}

/** The evidence photos the caller says this viewer may not see (#884). A photo filed on someone else's private
 *  draft place (before #881) is as private as the place, so it gets no signed path. The set is an INPUT: the
 *  read side that serves the viewer composes it (`snapshot/hidden-media.ts`), so this module never reads the
 *  media-owned table. Both served reads pass it; the empty default is for the projection/parity tests. */
const NONE_HIDDEN: ReadonlySet<string> = new Set();

/** #482 proof photos, "Your open items" — one open inspection the viewer is named to fix (`openItems`). */
export interface OpenItemsInspection {
  inspectionId: string;
  title: string;
  zone: string;
  nodeId: string | null;
  status: 'issued' | 'in-review' | 'reinspection';
  failedItems: Array<{ itemId: string; name: string }>;
}

@Injectable()
export class InspectionsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signed: SignedUrlService,
    // #571 round 8, finding 3 — the assignee-standing question goes to the model's OWNER.
    private readonly orgs: OrgsParticipant,
    // Guided site inspections step 4a — each evidence file's type goes to the media module, its owner (as the submit's
    // evidence rule asks it), so the field view serves the kind of every evidence entry.
    private readonly media: MediaParticipant,
  ) {}

  /** The recording kind of every evidence file the field view serves (`fieldViewMediaIds`: open checklists and the
   *  submitted fallback, never the whole project's history; #1374), by the media module's answer, and the offline replay
   *  key of each of those files THIS viewer uploaded (unit 3a: the phone matches its own pending captures to them by
   *  identity). A file the module does not name (not in this project) is left out, and served as null. */
  private async evidenceFacts(
    projectId: string,
    base: InspectionsBase,
    viewerId: string | undefined,
  ): Promise<{ evidenceKinds: ReadonlyMap<string, RecordingKind | null>; evidenceOwnKeys: ReadonlyMap<string, string> }> {
    const facts = await this.media.evidenceFactsOf(this.prisma, { projectId, mediaIds: fieldViewMediaIds(base) });
    const evidenceKinds = new Map([...facts].map(([id, f]) => [id, recordingKindOf(f.mime)]));
    const evidenceOwnKeys = new Map<string, string>();
    if (viewerId) for (const [id, f] of facts) if (f.uploadedBy === viewerId && f.clientKey) evidenceOwnKeys.set(id, f.clientKey);
    return { evidenceKinds, evidenceOwnKeys };
  }

  /** Bake an evidence media row's short-lived signed serve path (minted per read — never stored). */
  private evidencePath = (mediaId: string): string => this.signed.mediaPath(mediaId);

  /**
   * The inspection slices of the project snapshot (checklist / reviews / review / reinspectionCreated /
   * placedInspections), baked for `role` (PMC-only review queue, pmc/engineer placement) with each item's
   * evidence as fresh signed serve paths. Served from LIVE canonical state.
   */
  async snapshotSlice(projectId: string, role: string, viewerId?: string, hiddenEvidence: ReadonlySet<string> = NONE_HIDDEN): Promise<InspectionsSlices> {
    const base = await computeInspectionsBase(this.prisma, projectId);
    return bakeInspections(base, { role, evidencePath: this.evidencePath, viewerId, bindingAssignees: await this.bindingAssignees(projectId, base), hiddenEvidence, ...(await this.evidenceFacts(projectId, base, viewerId)) });
  }

  /**
   * #482 proof photos, "Who fixes this?" — who is named to fix each inspection's failed work, for the PMC and the engineer
   * (the roles that name them); empty for every other role. Read live from "Inspection" (this module's own table), never
   * from the projection's stored base, so it is current on every read.
   *
   * A name is served only while its member has stood WITHOUT A BREAK since it was set: they stand now as an active
   * contractor or consultant, and their standing mark (orgs' count of their standing changes) is the one stored with the
   * name. A member who was removed or re-roled is no one responsible, and stays no one if they come back, until someone
   * names them again (Stage 1's RM-a gap-check, G1).
   *
   * Every PMC and engineer gets every inspection's naming, as `placedInspections` gives them every inspection (the "mine"
   * filter hides only another engineer's OPEN assigned checklist, and failed items sit on submitted inspections). The
   * PUT admits the same two roles on any inspection of the project, so the read and the write agree.
   */
  async responsibleMembers(projectId: string, role: string): Promise<Array<{ inspectionId: string; memberId: string }>> {
    if (role !== 'pmc' && role !== 'engineer') return [];
    const named = await this.prisma.inspection.findMany({
      where: { projectId, responsibleMemberId: { not: null } },
      orderBy: { id: 'asc' },
      select: { id: true, responsibleMemberId: true, responsibleStandingMark: true },
    });
    const held = await heldNamings(this.orgs, this.prisma, projectId,
      named.map((i) => ({ inspectionId: i.id, memberId: i.responsibleMemberId!, mark: i.responsibleStandingMark! })));
    return held.map(({ inspectionId, memberId }) => ({ inspectionId, memberId }));
  }

  /**
   * #482 proof photos, "Your open items" — the inspections a contractor or consultant is named to fix, still open, each
   * with its failed items (the items a proof photo goes on). Empty for every other role and for a viewer named nowhere.
   * Read live from "Inspection" and "InspectionItem" (this module's own tables), never from the projection's stored base,
   * which holds no responsible member (as `responsibleMembers`), so it is current on every read and the base is unchanged.
   *
   * A naming counts only while it HOLDS (`heldNamings`, the rule `responsibleMembers` serves to the PMC and engineer): a
   * member who was removed, or re-roled out of contractor and consultant, is named nowhere until someone names them again
   * (a move between those two roles keeps the naming, as RM-a's standing mark rules).
   *
   * OPEN: the inspection's lineage is not yet approved. Its latest inspection (following the one re-inspection a reject
   * creates, `reinspectionOfId`) is decided with no re-inspection of its own only when it was approved; anything else is
   * still being worked. `status` says where it stands: `issued` (with the engineer, not submitted), `in-review`
   * (submitted, waiting on the PMC) or `reinspection` (rejected; its re-inspection is under way).
   *
   * Failed items are listed only once the inspection is submitted (`isFailedItem`, the proof target's own rule): an
   * unsubmitted checklist's marks are the engineer's work in progress.
   */
  async openItems(projectId: string, role: string, viewerId?: string): Promise<OpenItemsInspection[]> {
    if ((role !== 'contractor' && role !== 'consultant') || !viewerId) return [];
    const named = await this.prisma.inspection.findMany({
      where: { projectId, responsibleMemberId: viewerId },
      orderBy: { id: 'asc' },
      select: { id: true, responsibleMemberId: true, responsibleStandingMark: true },
    });
    const held = await heldNamings(this.orgs, this.prisma, projectId,
      named.map((i) => ({ inspectionId: i.id, memberId: i.responsibleMemberId!, mark: i.responsibleStandingMark! })));
    if (held.length === 0) return [];
    // the project's lineage edges, to find each named inspection's latest re-inspection
    const lineage = await this.prisma.inspection.findMany({
      where: { projectId },
      select: { id: true, reinspectionOfId: true, decided: true },
    });
    const { childOf, approved } = lineageApproval(lineage);
    const open = held.map((h) => h.inspectionId).filter((id) => !approved(id));
    if (open.length === 0) return [];
    const rows = await this.prisma.inspection.findMany({
      where: { projectId, id: { in: open } },
      orderBy: { id: 'asc' },
      select: {
        id: true, title: true, zone: true, nodeId: true, submitted: true, decided: true,
        items: { orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { id: true, name: true, rejected: true, result: true, state: true } },
      },
    });
    return rows.map((i) => ({
      inspectionId: i.id,
      title: i.title,
      zone: i.zone,
      nodeId: i.nodeId ?? null,
      status: childOf.has(i.id) ? 'reinspection' : i.submitted ? 'in-review' : 'issued',
      failedItems: i.submitted ? i.items.filter((it) => isFailedItem(it)).map((it) => ({ itemId: it.id, name: it.name })) : [],
    }));
  }

  /**
   * Which of this base's named assignees still HOLD their work — the live half of the read.
   *
   * Resolved here, per read, rather than stored in the base, because the base is a rebuildable
   * PROJECTION refreshed by `inspection.*` events and this fact changes under `member.*` ones: a
   * stored copy would keep a removed engineer's checklist hidden from every eligible replacement
   * until something unrelated touched the inspection. Asking the membership table at read time makes
   * the projection-served and live-served slices identical for the same reason they already are —
   * the same function, the same argument — while keeping the stored bytes viewer-independent.
   *
   * One query per read, over the DISTINCT assignees actually present, and skipped entirely when the
   * project has none (the common case: an issued checklist is nobody's in particular).
   */
  private bindingAssignees(projectId: string, base: InspectionsBase): Promise<Set<string>> {
    const named = base.inspections.map((i) => i.assigneeId).filter((id): id is string => typeof id === 'string');
    return bindingAssigneeIds(this.orgs, this.prisma, projectId, named);
  }

  /**
   * The inspection slices served from the REBUILDABLE PROJECTION (`inspections.inbox`) instead of the live
   * read. Like daily-log/drawings (one per-project composite row), the projection stores the viewer-
   * INDEPENDENT base; this reads the project's ACTIVE, servable generation row and bakes it for `role` — so
   * a projection is never an RBAC bypass (the same role gate runs at read) and never serves a stale signed
   * path (each read mints fresh tokens).
   *
   * `generation` is non-null ONLY when the projection is SAFE TO SERVE (finding 1): its active generation
   * is healthy (`cursorStatus='live'`) AND caught up to the committed stream head AND its row exists. A
   * no-op-bootstrapped (no row), lagging or blocked generation returns `generation: null` and the caller
   * falls back to the canonical live slice.
   */
  async projectionSlice(projectId: string, role: string, viewerId?: string, hiddenEvidence: ReadonlySet<string> = NONE_HIDDEN): Promise<{ slices: InspectionsSlices; generation: number | null }> {
    const gen = await readServableGeneration(this.prisma, INSPECTIONS_PROJECTION, projectId);
    const empty: InspectionsSlices = { checklist: null, openChecklists: [], reviews: [], review: null, reinspectionCreated: false, placedInspections: [] };
    if (!gen) return { slices: empty, generation: null };

    const row = await this.prisma.inspectionsProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } },
      select: { dto: true },
    });
    // A caught-up generation with NO row yet is not authoritative-empty data — fall back to canonical.
    if (!row) return { slices: empty, generation: null };
    const base = row.dto as unknown as InspectionsBase;
    // A V1-SHAPED ROW INSIDE A V2 GENERATION IS NOT SERVABLE.
    //
    // `catalogVersion` fences the GENERATION, and that is not the same as fencing its ROWS. During a
    // rolling deploy a previous-release relay is still running; it re-syncs the consumer catalog only
    // at startup, so it can apply the next `inspection.*` event and rewrite this row with the v1
    // serializer AFTER a v2 generation is active. The generation stays stamped v2 and unfenced (the
    // writer fence installed by `20271126000000` covers `DecisionProjection` only), so the version
    // gate above lets it through — and every entry then lacks `assigneeId`, which `bakeInspections`
    // reads as "assigned to nobody I can name" and filters out, emptying the field view for every
    // non-PMC viewer.
    //
    // The stored bytes answer the question the stamp cannot, so ask them: a v2 base carries the key
    // on every entry. A row that does not is from an older writer whatever the generation says, and
    // the caller falls back to the canonical live read, which is always current. This is the read
    // half of the fence; the write half (an `InspectionsProjection` writer trigger mirroring the
    // decisions one) is a separate unit, and until it exists this is what keeps wrong data unserved.
    if (!isCurrentInspectionsBase(base)) return { slices: empty, generation: null };
    return { slices: bakeInspections(base, { role, evidencePath: this.evidencePath, viewerId, bindingAssignees: await this.bindingAssignees(projectId, base), hiddenEvidence, ...(await this.evidenceFacts(projectId, base, viewerId)) }), generation: gen.generation };
  }

  /**
   * Phase 2 Task 10 — the MODULE-OWNED inspections read the frontend calls (`GET …/inspections`). Serves
   * from the rebuildable projection when it has a safe active generation; otherwise falls back to the live
   * slices (a project whose inspection events the relay has not applied yet, or a legacy project never
   * rebuilt) — additive and correct, never empty during warm-up. `source` tells the client which path
   * served it (the slices are byte-identical either way).
   */
  async moduleInspections(projectId: string, role: string, viewerId?: string, hiddenEvidence: ReadonlySet<string> = NONE_HIDDEN): Promise<InspectionsModuleResult> {
    const proj = await this.projectionSlice(projectId, role, viewerId, hiddenEvidence);
    if (proj.generation !== null) {
      return { ...proj.slices, source: 'projection', generation: proj.generation };
    }
    const live = await this.snapshotSlice(projectId, role, viewerId, hiddenEvidence);
    return { ...live, source: 'live', generation: null };
  }

  /**
   * The inspection-gate READINESS input for the shared truth table ({@link deriveInspectionGate}): each
   * inspection's activity link + closing flag + submit/decide state + per-item rejected/result. The ONLY
   * read of inspection persistence a consumer needs for readiness — so the snapshot and the activity-start
   * command evaluate the inspection gate through this boundary instead of reading `prisma.inspection`
   * directly (read-encapsulation). `activityId` scopes it to one activity's inspections (the start
   * command); `tx` runs it inside the caller's transaction (the atomic readiness evaluation under the
   * project lock).
   */
  async readinessSlice(
    projectId: string,
    opts: { activityId?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<ReadinessInspection[]> {
    const db = opts.tx ?? this.prisma;
    const inspections = await db.inspection.findMany({
      where: { projectId, ...(opts.activityId ? { activityId: opts.activityId } : {}) },
      include: { items: { select: { rejected: true, result: true } } },
    });
    return inspections.map((i) => ({
      id: i.id,
      activityId: i.activityId,
      closing: i.closing,
      submitted: i.submitted,
      decided: i.decided,
      reinspectionOfId: i.reinspectionOfId,
      items: i.items.map((it) => ({ rejected: it.rejected, result: it.result })),
    }));
  }

  /**
   * Every existing inspection id across ALL projects (DATA-01: `INSP-N` ids are globally unique, so the
   * scan is global). Project initialization reads this ONCE to seed its id-minting cursor before it copies
   * a source's checklist definitions — it reads through THIS boundary instead of `prisma.inspection`
   * directly, so no other module scans inspection persistence.
   */
  async allIds(tx?: Prisma.TransactionClient): Promise<string[]> {
    const db = tx ?? this.prisma;
    const existing = await db.inspection.findMany({ select: { id: true } });
    return existing.map((i) => i.id);
  }

  /**
   * Mint the next globally-unique `INSP-N` id. The ONLY place another module needs to allocate an
   * inspection id is the activities `complete` workflow (edge 1, the closing inspection created THROUGH
   * this module's participant in the same transaction) — it allocates the id HERE instead of reading
   * `prisma.inspection` directly, keeping the read behind the module boundary.
   */
  async nextInspectionId(tx?: Prisma.TransactionClient): Promise<string> {
    return nextSeqId('INSP-', await this.allIds(tx));
  }

  /**
   * The CHECKLIST-definition structure a project-copy/module-extract reads from a SOURCE project (title +
   * place + item names, undecided by construction). Reviews and closing inspections are results, not
   * structure, so only `kind: 'checklist'` travels. `nodeIds` (when given) restricts to inspections placed
   * on those location-tree nodes — a spatial module extraction copies only the subtree it spans. The
   * project-initialization copy and the module-payload extractor both read source inspections through THIS
   * boundary instead of `prisma.inspection` directly.
   */
  async checklistStructures(
    projectId: string,
    opts: { nodeIds?: readonly string[]; tx?: Prisma.TransactionClient } = {},
  ): Promise<InspectionChecklistStructure[]> {
    const db = opts.tx ?? this.prisma;
    const rows = await db.inspection.findMany({
      where: { projectId, kind: 'checklist', ...(opts.nodeIds ? { nodeId: { in: [...opts.nodeIds] } } : {}) },
      include: { items: { orderBy: { order: 'asc' } } },
    });
    // Guided site inspections (step 2a) — an item travels with its guidance (a plain name when it has none), and the
    // checklist with its work type, so a project or module made from this one issues the same guided checklist.
    return rows.map((i) => ({ title: i.title, zone: i.zone, nodeId: i.nodeId, workType: i.workType, items: i.items.map(specFromItemRow) }));
  }

  /**
   * The portfolio's OPEN-inspection count for a project (submitted-but-undecided — the PMC review backlog).
   * The org portfolio rollup reads this through the boundary instead of `prisma.inspection.count` directly.
   */
  async openInspectionCount(projectId: string): Promise<number> {
    return this.prisma.inspection.count({ where: { projectId, submitted: true, decided: false } });
  }

  /** Top 10 #3 gap 13 (#799) — the inspections waiting for review, and the one waiting when exactly one does (null
   *  otherwise: the PMC brief's "reviews waiting" task then opens the review list). #803 Codex 4246569466 — the
   *  count and the id are ONE snapshot (REPEATABLE READ, read-only), so the id always names the inspection counted. */
  async openInspections(projectId: string): Promise<{ count: number; onlyId: string | null }> {
    const where = { projectId, submitted: true, decided: false };
    const [count, firstTwo] = await this.prisma.$transaction([
      this.prisma.inspection.count({ where }),
      this.prisma.inspection.findMany({ where, orderBy: { id: 'asc' }, take: 2, select: { id: true } }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { count, onlyId: count === 1 && firstTwo.length === 1 ? firstTwo[0].id : null };
  }

  /** U3a — how many inspections were REJECTED at or after `since` (the PMC brief's "checks failed").
   *  An inspection row keeps no decision instant, so this asks the platform's audit read
   *  (`AuditQuery`) for the reject this module records (`inspection.reject`), one per inspection
   *  however often it was rejected again. */
  rejectedSince(projectId: string, since: Date): Promise<number> {
    return AuditQuery.distinctEntitiesSince(this.prisma, projectId, 'inspection.reject', since);
  }

  /**
   * Validate a media evidence upload's inspection linkage before the media row stores it: the inspection
   * must belong to `projectId`, and (when present) `inspectionItemId` must belong to THAT inspection. The
   * tenant + integrity check a media upload runs at this boundary instead of reading `prisma.inspection` /
   * `prisma.inspectionItem` directly — the composite-FK chain + CHECK are the database backstop.
   */
  async assertEvidenceTarget(projectId: string, inspectionId: string, inspectionItemId?: string | null): Promise<void> {
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, select: { projectId: true } });
    if (!insp || insp.projectId !== projectId) throw new BadRequestException('Unknown inspection for this project');
    if (inspectionItemId) {
      const item = await this.prisma.inspectionItem.findUnique({ where: { id: inspectionItemId }, select: { inspectionId: true } });
      if (!item || item.inspectionId !== inspectionId) throw new BadRequestException('The item does not belong to that inspection');
    }
  }

  /** #482 site photos unit 4 — a proof photo goes only on an item of this project's inspection that is FAILED now.
   *  Inside a transaction (`db`) the item row is held FOR SHARE until it commits, so a write that clears the item
   *  waits for the proof, or the proof sees it cleared; outside one it is the early no before any byte is stored.
   *  The inspection row is taken first, FOR UPDATE, as a decide, a submit and an evidence upload's own check take it:
   *  an evidence upload holds the project's event stream before its inspection lock, so a proof holding the inspection
   *  only KEY SHARE (as its foreign key would) and then waiting on the stream would close a ring with it. FOR UPDATE
   *  conflicts with the evidence insert's key share, so the two meet at the inspection row before either holds the
   *  stream (U-4 gap-check, probe D1). Proofs on one inspection go one at a time. */
  async assertProofTarget(projectId: string, inspectionId: string, inspectionItemId: string, db?: Prisma.TransactionClient): Promise<void> {
    const client = db ?? this.prisma;
    if (db) await db.$executeRaw`SELECT 1 FROM "Inspection" WHERE "id" = ${inspectionId} AND "projectId" = ${projectId} FOR UPDATE`;
    const [item] = await client.$queryRaw<Array<{ rejected: boolean; result: string | null; state: string | null }>>(Prisma.sql`
      SELECT it."rejected", it."result"::text AS "result", it."state"
      FROM "InspectionItem" it
      WHERE it."id" = ${inspectionItemId} AND it."inspectionId" = ${inspectionId}
        AND EXISTS (SELECT 1 FROM "Inspection" i WHERE i."id" = it."inspectionId" AND i."projectId" = ${projectId})
      ${db ? Prisma.sql`FOR SHARE` : Prisma.empty}`);
    if (!item) throw new BadRequestException('The item does not belong to an inspection of this project');
    if (!isFailedItem(item)) throw new ConflictException('A proof photo goes on an item that has failed, and this one has not');
  }

  /** Does inspection `inspectionId` exist in project `projectId`? The tenant-ownership check a consumer
   *  (a media evidence upload linking an `inspectionId`) runs before storing a reference to it. */
  async existsInProject(projectId: string, inspectionId: string): Promise<boolean> {
    const row = await this.prisma.inspection.findFirst({ where: { id: inspectionId, projectId }, select: { id: true } });
    return row !== null;
  }

  /** Resolve an OPTIONAL inspection reference: null/undefined pass through; a present id must belong to
   *  THIS project. */
  async resolveRefInProject(
    projectId: string,
    id: string | null | undefined,
    field = 'inspectionId',
  ): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }
}
