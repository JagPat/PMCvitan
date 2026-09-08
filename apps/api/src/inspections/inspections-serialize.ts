import { Prisma } from '@prisma/client';
import type {
  Checklist, ChecklistItem, InspectionResult, ItemState, PlacedInspection, Review, ReviewItem, SwatchKey,
} from '@vitan/shared';

/**
 * Phase 2 Task 10 (Module 3) — the ONE canonical inspections read serializer, shared by the live snapshot
 * slices ({@link InspectionsQueryService.snapshotSlice}) AND the rebuildable projection consumer, so the
 * projection-served slices are byte-identical to the live ones by construction.
 *
 * Two stages (mirroring drawings/daily-log):
 *  1. {@link computeInspectionsBase} reads CANONICAL state into a viewer-INDEPENDENT, signer-INDEPENDENT
 *     base — every inspection with its items, the media-evidence LINKAGE (row ids per item, NOT signed
 *     paths), and the activity name a closing inspection is labelled with. This is what the projection
 *     stores; it embeds nothing per-viewer or time-limited.
 *  2. {@link bakeInspections} turns that base into the five per-viewer/role slices the snapshot carries:
 *     `checklist` (the engineer's field view — all roles), `reviews`/`review`/`reinspectionCreated` (the
 *     PMC review queue — PMC only), and `placedInspections` (the Site-Map placement — pmc/engineer only).
 *     Each item's `evidence` is minted as FRESH short-lived signed serve paths at read time (a stored path
 *     would expire — so paths are NEVER in the base). Both the live read and the projection read bake
 *     through this one function, so the two are identical.
 */

/** One inspection as the projection stores it: viewer-INDEPENDENT and signer-INDEPENDENT. The evidence
 *  media ids per item are baked into signed serve paths at read time (never stored as paths). */
export interface InspectionBaseEntry {
  id: string;
  kind: string; // 'checklist' | 'review'
  title: string;
  zone: string;
  nodeId: string | null;
  by: string | null;
  date: string;
  submitted: boolean;
  decided: boolean;
  closing: boolean;
  activityId: string | null;
  activityName: string | null;
  reinspectionOfId: string | null;
  /** Whose corrective work this is, when it is anybody's in particular. A re-inspection ALWAYS has
   *  one (it defaults to whoever submitted the rejected inspection); an issued checklist may not.
   *  Carried so the read boundary can keep one engineer's assigned work off another's field view. */
  assigneeId: string | null;
  items: {
    id: string;
    name: string;
    order: number;
    state: string | null;
    photos: number;
    note: string;
    result: string | null;
    swatch: string | null;
    rejected: boolean;
    /** linked Media evidence row ids for this item (baked into signed paths at read). */
    mediaIds: string[];
  }[];
}

export interface InspectionsBase {
  inspections: InspectionBaseEntry[];
}

/** The per-viewer/role inspection slices the snapshot's inspection keys carry. */
export interface InspectionsSlices {
  checklist: Checklist | null;
  /** EVERY open (issued, unsubmitted) checklist, oldest id first. `checklist` is one of these —
   *  the single row the field view opens by default — and carrying only that one was a defect:
   *  a second issued checklist hid the first, and the PMC who issued them saw none of them
   *  (`reviews` carries SUBMITTED inspections only). Same visibility as `checklist`. */
  openChecklists: Checklist[];
  reviews: Review[];
  review: Review | null;
  reinspectionCreated: boolean;
  placedInspections: PlacedInspection[];
}

/**
 * Read + serialize the viewer-independent inspections base from CANONICAL state through ANY Prisma client:
 * the injected service for a live read, or a projection apply/rebuild transaction. Moved verbatim from the
 * pre-extraction snapshot read minus the per-viewer/role gating and the signed evidence paths (which
 * {@link bakeInspections} adds), so the baked slices are unchanged.
 */
export async function computeInspectionsBase(
  client: Prisma.TransactionClient,
  projectId: string,
): Promise<InspectionsBase> {
  // Task 10 (Module 3) correction — read ONLY inspection-owned facts. `activityName` is the inspection's
  // OWN column (was a live `Activity.name` read); item evidence is the inspection-owned `InspectionEvidence`
  // link (was a read of the Media table). Neither the `activity` nor the `media` relation is included here,
  // so every serialized field is owned by this module and refreshed by an `inspection.*` event — the
  // boundary source-scan test enforces their absence.
  const inspections = await client.inspection.findMany({
    where: { projectId },
    include: { items: { orderBy: { order: 'asc' } } },
  });
  // Inspection-owned evidence links (createdAt asc — the same stable order the Media read used), grouped
  // per item so bake mints one signed path per linked media row.
  const evidence = await client.inspectionEvidence.findMany({
    where: { projectId },
    select: { inspectionItemId: true, mediaId: true },
    orderBy: { createdAt: 'asc' },
  });
  const mediaIdsByItem = new Map<string, string[]>();
  for (const e of evidence) {
    const list = mediaIdsByItem.get(e.inspectionItemId);
    if (list) list.push(e.mediaId);
    else mediaIdsByItem.set(e.inspectionItemId, [e.mediaId]);
  }
  return {
    inspections: inspections.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      zone: i.zone,
      nodeId: i.nodeId,
      by: i.by,
      date: i.date,
      submitted: i.submitted,
      decided: i.decided,
      closing: i.closing,
      activityId: i.activityId,
      activityName: i.activityName, // inspection-owned label (Task 10 Module 3 correction)
      reinspectionOfId: i.reinspectionOfId,
      assigneeId: i.assigneeId,
      items: i.items.map((it) => ({
        id: it.id,
        name: it.name,
        order: it.order,
        state: it.state,
        photos: it.photos,
        note: it.note,
        result: it.result,
        swatch: it.swatch,
        rejected: it.rejected,
        // inspection-owned evidence linkage in canonical (createdAt asc) order — signed at read time.
        mediaIds: mediaIdsByItem.get(it.id) ?? [],
      })),
    })),
  };
}

/**
 * Order two inspection ids the way a human reads them: by the numeric suffix, not by its characters.
 *
 * The two id producers disagree about padding. `nextSeqId('INSP-', …)` mints three-digit ids
 * (`INSP-023`); the seeded rows carry unpadded ones (`INSP-18`, `INSP-21`, `INSP-22`), and both
 * shapes live in the same project. Under a plain `localeCompare` the padded id sorts FIRST —
 * `'INSP-023' < 'INSP-22'` because `'0' < '2'` — so the newest checklist would be the one the
 * field view opens by default and the outstanding list would read newest-first for part of its
 * range and oldest-first for the rest. Comparing the suffix as a number orders them by issue
 * sequence regardless of padding; ids whose suffix is not a number (or whose prefix differs) fall
 * back to the string order, which is still total and still reproducible.
 */
export function compareInspectionIds(a: string, b: string): number {
  const split = (id: string): { prefix: string; n: number | null } => {
    const m = /^(.*?)(\d+)$/u.exec(id);
    return m ? { prefix: m[1], n: Number(m[2]) } : { prefix: id, n: null };
  };
  const x = split(a);
  const y = split(b);
  if (x.n !== null && y.n !== null && x.prefix === y.prefix && x.n !== y.n) return x.n - y.n;
  return a.localeCompare(b);
}

/**
 * Bake the stored base into the five per-viewer/role slices the snapshot and the module read both emit.
 * A pure function of (base, viewer role, signer), so projection-served and live-served slices are
 * identical whenever the base is. `evidencePath` mints each item's fresh signed serve paths.
 */
export function bakeInspections(
  base: InspectionsBase,
  // `role` is the viewer's role as a string (the API `Role` includes 'worker', wider than the shared
  // `Role`) — the AUTH-02 gating is a plain equality check, so a string keeps both sides compatible.
  opts: {
    role: string;
    evidencePath: (mediaId: string) => string;
    viewerId?: string;
    /** The assignees whose assignments still BIND, from `bindingAssigneeIds` — the ONE statement of
     *  that rule, resolved by the caller because it is a live membership fact and this function is
     *  pure over the stored base (a base that embedded it would go stale the moment a membership
     *  changed, with no `inspection.*` event to refresh it). REQUIRED, not defaulted: a caller that
     *  forgot it would silently serve the pre-round-7 behaviour, which is the defect itself. */
    bindingAssignees: ReadonlySet<string>;
  },
): InspectionsSlices {
  const { role, evidencePath, viewerId, bindingAssignees } = opts;
  const isPmc = role === 'pmc';
  const canSeeInspections = role === 'pmc' || role === 'engineer';
  const all = base.inspections;

  // Issued checklists. `computeInspectionsBase` reads them with no `orderBy`, so row order is
  // whatever the planner returns: every choice made here sorts first, or it is not reproducible.
  // Sorted by id like the review queue below, so the two slices order consistently.
  const byId = (a: InspectionBaseEntry, b: InspectionBaseEntry) => compareInspectionIds(a.id, b.id);
  const toChecklist = (row: InspectionBaseEntry): Checklist => ({
    id: row.id,
    title: row.title,
    zone: row.zone,
    nodeId: row.nodeId ?? undefined, // location spine
    date: row.date,
    submitted: row.submitted,
    items: row.items.map(
      (it): ChecklistItem => ({
        id: it.id, // the capture flow links evidence uploads to THIS item (Task 4)
        name: it.name,
        state: it.state as ItemState,
        photos: it.photos,
        note: it.note,
        evidence: it.mediaIds.map(evidencePath),
      }),
    ),
  });

  // EVERY open checklist, not one of them. Issuing a second checklist used to hide the first:
  // the field view asked `find` for a single row, so the other was issued work that no surface
  // showed — and the PMC who issued it could not see it either, because `reviews` carries only
  // SUBMITTED inspections. (Not role-gated — this is the field view, same visibility as below.)
  //
  // ASSIGNED work stays with its assignee. A rejected inspection creates a re-inspection assigned to
  // whoever submitted the original — that is somebody's named corrective work, not the site's. The
  // field view is ungated by ROLE on purpose, but showing engineer B engineer A's assigned
  // re-inspection is a different thing: B could fill it, submit it, and be recorded as the person
  // who did A's remedial work. An UNASSIGNED checklist is still everybody's, which is the common
  // case and unchanged. The PMC sees all of it — they issue this work and must see what is
  // outstanding, which is the whole point of the list.
  //
  // AND IT STOPS BEING THEIRS WHEN THEY CAN NO LONGER DO IT. `submit` accepts a replacement engineer
  // the moment the named assignee stops holding an active corrective membership — removed, re-roled,
  // or a PMC who took the work by naming themselves and has no checklist screen to fill it on. Read
  // and write must answer that with the SAME predicate: a checklist `submit` will take from engineer
  // B is a checklist B has to be able to find and open, and filtering here on the stored id alone
  // left the only eligible callers unable to reach the work at all (#571 round 7, finding 1). So the
  // filter asks whether the assignment BINDS, not whether the column is set — `bindingAssignees` is
  // the same `bindingAssigneeIds` answer the submit guard takes, resolved once per read.
  const mine = (i: InspectionBaseEntry): boolean =>
    isPmc || i.assigneeId === null || i.assigneeId === viewerId || !bindingAssignees.has(i.assigneeId);
  const openRows = all.filter((i) => i.kind === 'checklist' && !i.submitted && mine(i)).sort(byId);
  const openChecklists: Checklist[] = openRows.map(toChecklist);

  // The one the field view opens by default: the oldest open checklist, else the oldest submitted
  // one so a finished checklist stays readable. Chosen from a SORTED list — `find` over the
  // unordered read returned a planner-dependent row, so two runs could disagree.
  const checklistRow = openRows[0] ?? all.filter((i) => i.kind === 'checklist' && mine(i)).sort(byId)[0];
  const checklist: Checklist | null = checklistRow ? toChecklist(checklistRow) : null;

  // The review queue: any submitted-but-undecided inspection, sorted by id. AUTH-02: PMC-only.
  const reviews: Review[] = all
    .filter((i) => i.submitted && !i.decided)
    .sort((a, b) => compareInspectionIds(a.id, b.id))
    .map(
      (i): Review => ({
        id: i.id,
        title: i.title,
        zone: i.zone,
        nodeId: i.nodeId ?? undefined, // location spine
        by: i.by ?? '',
        date: i.date,
        decided: i.decided,
        // Task 4: a reinspection is labelled by its predecessor in the review queue.
        reinspectionOfId: i.reinspectionOfId ?? undefined,
        // Task 5: a CLOSING inspection is labelled with the activity it signs off.
        ...(i.closing ? { closing: true, activityId: i.activityId ?? undefined, activityName: i.activityName ?? undefined } : {}),
        items: i.items.map(
          (it): ReviewItem => ({
            id: it.id, // gate finding 3: rejection addresses THIS row, labels are not unique
            name: it.name,
            result: (it.result ?? (it.state === 'fail' ? 'FAIL' : 'PASS')) as InspectionResult,
            swatch: (it.swatch ?? 'concrete') as SwatchKey,
            note: it.note,
            rejected: it.rejected,
            evidence: it.mediaIds.map(evidencePath),
          }),
        ),
      }),
    );

  // any inspection already decided with a rejected/failed item ⇒ re-inspection exists.
  const reinspectionCreated = all.some((i) => i.decided && i.items.some((it) => it.rejected || it.result === 'FAIL'));

  // Location spine: every inspection with its place, for the Site-Map's "inspections here". pmc/engineer.
  const placedInspections: PlacedInspection[] = canSeeInspections
    ? all.map(
        (i): PlacedInspection => ({
          id: i.id,
          title: i.title,
          zone: i.zone,
          nodeId: i.nodeId ?? undefined,
          kind: i.kind,
          submitted: i.submitted,
          decided: i.decided,
          failedItems: i.items.filter((it) => it.rejected || it.result === 'FAIL').length,
        }),
      )
    : [];

  return {
    checklist,
    openChecklists,
    reviews: isPmc ? reviews : [],
    review: isPmc ? (reviews[0] ?? null) : null, // deprecated single (first pending) — back-compat
    reinspectionCreated: isPmc ? reinspectionCreated : false,
    placedInspections,
  };
}
