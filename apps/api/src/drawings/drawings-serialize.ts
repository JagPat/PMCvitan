import { Prisma } from '@prisma/client';
import type { Discipline, Drawing, DrawingRevision, DrawingStatus } from '@vitan/shared';
import { ddMmmYyyy } from '../domain/dates';

/**
 * Phase 2 Task 10 — the ONE canonical drawings-register read serializer, shared by the live snapshot
 * slice ({@link DrawingsQueryService.snapshotSlice}) AND the rebuildable projection consumer, so the
 * projection-served register is byte-identical to the live one by construction.
 *
 * Two stages, split for a reason unique to drawings among the extracted modules:
 *  1. {@link computeDrawingsBase} reads CANONICAL state into a viewer-INDEPENDENT, signer-INDEPENDENT
 *     base. This is what the projection stores — it must not embed anything per-viewer or time-limited.
 *  2. {@link bakeDrawings} turns that base into the per-viewer {@link Drawing} register: it filters
 *     drafts to their author, mints each revision's FRESH short-lived signed `url` (a stored token would
 *     expire — so the url is NEVER in the base), picks the governing `current` revision, and computes
 *     the viewer's `ackedByMe`/`recipientOfCurrent`. Both the live read and the projection read bake
 *     through this one function, so the two are identical.
 */

/** A revision on the register WITHOUT its short-lived signed `url` (baked at read time from the
 *  revision `id`), so a projection can store the base and every read mints a fresh, unexpired token. */
export interface DrawingRevisionBase {
  id: string;
  rev: string;
  status: string;
  mime: string;
  sizeBytes: number;
  note: string;
  issuedBy: string;
  issuedAt: string;
  acks: { userName: string; role: string; at: string }[];
  recipientsFrozenAt: string | null;
  recipients: { userName: string; role: string; acked: boolean }[];
}

/** One register entry as the projection stores it: viewer-INDEPENDENT and signer-INDEPENDENT. The
 *  per-viewer fields (`draft` visibility, `ackedByMe`, `recipientOfCurrent`) and the signed `url` are
 *  baked at read time from `authorId`, `governing` and each revision `id`, so the same stored base
 *  serves every viewer and never bakes a stale token. */
export interface DrawingBaseEntry {
  id: string;
  number: string;
  title: string;
  discipline: string;
  zone: string | null;
  activityId: string | null;
  decisionId: string | null;
  nodeId: string | null;
  /** publishedAt === null → a private, unpublished DRAFT (author-only). */
  draft: boolean;
  /** the draft author, the draft-visibility bake key (never sent to a client). */
  authorId: string | null;
  /** the GOVERNING revision's frozen-distribution facts, for the per-viewer ack/recipient bake; null
   *  when the drawing has no governing (for_construction) revision. `*UserIds` are internal — the
   *  public register exposes only display names, never user ids. */
  governing: { revId: string; frozen: boolean; ackUserIds: string[]; recipientUserIds: string[] } | null;
  revisions: DrawingRevisionBase[]; // newest first, WITHOUT url
}

export interface DrawingsBase {
  drawings: DrawingBaseEntry[];
}

/**
 * Read + serialize the viewer-independent drawings base from CANONICAL state through ANY Prisma client:
 * the injected service for a live read, or a projection apply/rebuild transaction. The register (each
 * drawing with its full revision history newest-first + the governing revision's distribution facts).
 * Moved verbatim from the pre-projection snapshot read minus the two per-viewer/signed fields, which
 * {@link bakeDrawings} adds — so the baked register is unchanged.
 */
export async function computeDrawingsBase(
  client: Prisma.TransactionClient,
  projectId: string,
): Promise<DrawingsBase> {
  const drawings = await client.drawing.findMany({
    where: { projectId },
    include: {
      revisions: {
        orderBy: { createdAt: 'desc' },
        include: {
          acks: { orderBy: { at: 'asc' } },
          // the frozen distribution (Phase 1 Task 3) + each recipient's display name
          recipients: { include: { membership: { include: { user: { select: { name: true } } } } } },
        },
      },
    },
    orderBy: [{ discipline: 'asc' }, { number: 'asc' }],
  });
  return {
    drawings: drawings.map((d) => {
      const revisions: DrawingRevisionBase[] = d.revisions.map((r) => ({
        id: r.id,
        rev: r.rev,
        status: r.status,
        mime: r.mime,
        sizeBytes: r.sizeBytes,
        note: r.note,
        issuedBy: r.issuedBy,
        issuedAt: r.issuedAt,
        acks: r.acks.map((a) => ({ userName: a.userName, role: a.role, at: ddMmmYyyy(a.at) })),
        recipientsFrozenAt: r.recipientsFrozenAt ? r.recipientsFrozenAt.toISOString() : null,
        recipients: r.recipients.map((rc) => ({
          userName: rc.membership.user.name,
          role: rc.roleAtIssue,
          acked: r.acks.some((a) => a.userId === rc.userId),
        })),
      }));
      // the GOVERNING revision: latest non-superseded for_construction, or null (a drawing whose only
      // revisions are review copies never governs the field).
      const governingRow = d.revisions.find((r) => r.status === 'for_construction') ?? null;
      return {
        id: d.id,
        number: d.number,
        title: d.title,
        discipline: d.discipline,
        zone: d.zone,
        activityId: d.activityId,
        decisionId: d.decisionId,
        nodeId: d.nodeId,
        draft: d.publishedAt === null,
        authorId: d.authorId,
        governing: governingRow
          ? {
              revId: governingRow.id,
              // null recipientsFrozenAt = legacy (predates snapshots) → the everyone-builds fallback.
              frozen: governingRow.recipientsFrozenAt !== null,
              ackUserIds: governingRow.acks.map((a) => a.userId),
              recipientUserIds: governingRow.recipients.map((rc) => rc.userId),
            }
          : null,
        revisions,
      };
    }),
  };
}

/**
 * Bake the stored base into the per-viewer register the snapshot slice and the module read both emit:
 * filter drafts to their author, mint each revision's fresh signed `url`, pick the governing `current`,
 * and compute the viewer's `ackedByMe`/`recipientOfCurrent`. A pure function of (base, viewer, signer),
 * so projection-served and live-served registers are identical whenever the base is.
 */
export function bakeDrawings(
  base: DrawingsBase,
  opts: { userId?: string; drawingUrl: (revisionId: string) => string },
): Drawing[] {
  const { userId, drawingUrl } = opts;
  return base.drawings
    // draft → publish: an unpublished drawing is author-private — only in its creator's register.
    .filter((d) => !d.draft || (Boolean(userId) && d.authorId === userId))
    .map((d) => {
      const revs: DrawingRevision[] = d.revisions.map((r) => ({
        id: r.id,
        rev: r.rev,
        status: r.status as DrawingStatus,
        mime: r.mime,
        // private delivery: short-lived signed serve path (never a public bucket URL), minted per read.
        url: drawingUrl(r.id),
        sizeBytes: r.sizeBytes,
        note: r.note,
        issuedBy: r.issuedBy,
        issuedAt: r.issuedAt,
        acks: r.acks.map((a) => ({ ...a })),
        recipientsFrozenAt: r.recipientsFrozenAt,
        recipients: r.recipients.map((rc) => ({ ...rc })),
      }));
      const current = revs.find((r) => r.status === 'for_construction') ?? null;
      const g = d.governing;
      return {
        id: d.id,
        number: d.number,
        title: d.title,
        discipline: d.discipline as Discipline,
        zone: d.zone,
        activityId: d.activityId,
        decisionId: d.decisionId,
        nodeId: d.nodeId ?? undefined, // location spine: the place this drawing governs
        draft: d.draft,
        current,
        ackedByMe: Boolean(userId) && g !== null && g.ackUserIds.includes(userId as string),
        // Emitted ONLY when the governing revision's distribution was actually frozen; a legacy
        // (unfrozen) governing revision OMITS the field so the client's everyone-builds fallback engages.
        ...(g && g.frozen
          ? { recipientOfCurrent: Boolean(userId) && g.recipientUserIds.includes(userId as string) }
          : {}),
        revisions: revs,
      };
    });
}
