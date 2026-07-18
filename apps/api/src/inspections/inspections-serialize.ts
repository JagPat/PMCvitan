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

/** The five per-viewer/role inspection slices the snapshot's inspection keys carry. */
export interface InspectionsSlices {
  checklist: Checklist | null;
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
  const inspections = await client.inspection.findMany({
    where: { projectId },
    include: {
      items: { orderBy: { order: 'asc' } },
      // linked evidence rows (Task 4) — id + item, so bake can mint a signed path per row.
      media: { select: { id: true, inspectionItemId: true }, orderBy: { createdAt: 'asc' } },
      // the activity a CLOSING inspection signs off (Task 5) — labels the review queue.
      activity: { select: { name: true } },
    },
  });
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
      activityName: i.activity?.name ?? null,
      reinspectionOfId: i.reinspectionOfId,
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
        // evidence linkage in canonical (createdAt asc) order — signed at read time.
        mediaIds: i.media.filter((m) => m.inspectionItemId === it.id).map((m) => m.id),
      })),
    })),
  };
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
  opts: { role: string; evidencePath: (mediaId: string) => string },
): InspectionsSlices {
  const { role, evidencePath } = opts;
  const isPmc = role === 'pmc';
  const canSeeInspections = role === 'pmc' || role === 'engineer';
  const all = base.inspections;

  // The engineer's CURRENT checklist: prefer an open (unsubmitted) one — a freshly issued checklist
  // supersedes an already-submitted earlier one in the field view. (Not role-gated — the field view.)
  const checklistRow = all.find((i) => i.kind === 'checklist' && !i.submitted) ?? all.find((i) => i.kind === 'checklist');
  const checklist: Checklist | null = checklistRow
    ? {
        id: checklistRow.id,
        title: checklistRow.title,
        zone: checklistRow.zone,
        nodeId: checklistRow.nodeId ?? undefined, // location spine
        date: checklistRow.date,
        submitted: checklistRow.submitted,
        items: checklistRow.items.map(
          (it): ChecklistItem => ({
            id: it.id, // the capture flow links evidence uploads to THIS item (Task 4)
            name: it.name,
            state: it.state as ItemState,
            photos: it.photos,
            note: it.note,
            evidence: it.mediaIds.map(evidencePath),
          }),
        ),
      }
    : null;

  // The review queue: any submitted-but-undecided inspection, sorted by id. AUTH-02: PMC-only.
  const reviews: Review[] = all
    .filter((i) => i.submitted && !i.decided)
    .sort((a, b) => a.id.localeCompare(b.id))
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
    reviews: isPmc ? reviews : [],
    review: isPmc ? (reviews[0] ?? null) : null, // deprecated single (first pending) — back-compat
    reinspectionCreated: isPmc ? reinspectionCreated : false,
    placedInspections,
  };
}
