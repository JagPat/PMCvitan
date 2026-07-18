import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Drawing, DrawingsModuleResult, ReadinessDrawing } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { SignedUrlService } from '../media/signed-url.service';
import { bakeDrawings, computeDrawingsBase, type DrawingsBase } from './drawings-serialize';
import { DRAWINGS_PROJECTION } from './drawings.projection';
import { readServableGeneration } from '../platform/projections/generation';

/**
 * Phase 2 Task 10 — the DRAWINGS module's PUBLIC READ boundary (its query contract).
 *
 * A fully-extracted backend module: no other module reads `drawing`/`drawingRevision`/
 * `drawingRecipient`/`drawingAck`/`drawingsProjection` persistence directly. Every cross-module read a
 * consumer needs is a narrow query answered HERE — the snapshot's drawings register (from the ONE
 * canonical serializer so the snapshot stays byte-identical) and the tenant-ownership check a media
 * upload runs before storing a `drawingId`. The register's per-viewer visibility (draft-author, the
 * viewer's ack/recipient state) and each revision's fresh signed `url` are baked at read time
 * ({@link bakeDrawings}); the boundary CI check enforces the encapsulation.
 */
@Injectable()
export class DrawingsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Bake a revision's short-lived signed serve path (minted per read — never stored). */
  private drawingUrl = (revisionId: string): string => this.signed.drawingPath(revisionId);

  /**
   * The drawings slice of the project snapshot: the register (each drawing with its revision history +
   * governing revision) baked for `userId` (draft-author visibility + the viewer's
   * `ackedByMe`/`recipientOfCurrent`). Served from LIVE canonical state.
   */
  async snapshotSlice(projectId: string, userId?: string): Promise<Drawing[]> {
    const base = await computeDrawingsBase(this.prisma, projectId);
    return bakeDrawings(base, { userId, drawingUrl: this.drawingUrl });
  }

  /**
   * The drawings register served from the REBUILDABLE PROJECTION (`drawings.inbox`) instead of the live
   * read. Like daily-log (one per-project composite row), the projection stores the viewer-INDEPENDENT
   * base; this reads the project's ACTIVE, servable generation row and bakes it for `userId` — so a
   * projection is never an RBAC bypass (the same visibility filter runs at read) and never serves a
   * stale signed url (each read mints a fresh token).
   *
   * `generation` is non-null ONLY when the projection is SAFE TO SERVE (finding 1): its active
   * generation is healthy (`cursorStatus='live'`) AND caught up to the committed stream head AND its row
   * exists. A no-op-bootstrapped (no row), lagging or blocked generation returns `generation: null` and
   * the caller falls back to the canonical live slice.
   */
  async projectionSlice(
    projectId: string,
    userId?: string,
  ): Promise<{ drawings: Drawing[]; generation: number | null }> {
    const gen = await readServableGeneration(this.prisma, DRAWINGS_PROJECTION, projectId);
    if (!gen) return { drawings: [], generation: null };

    const row = await this.prisma.drawingsProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } },
      select: { dto: true },
    });
    // A caught-up generation with NO row yet is not authoritative-empty data — fall back to canonical.
    if (!row) return { drawings: [], generation: null };
    const base = row.dto as unknown as DrawingsBase;
    return { drawings: bakeDrawings(base, { userId, drawingUrl: this.drawingUrl }), generation: gen.generation };
  }

  /**
   * Phase 2 Task 10 — the MODULE-OWNED drawings read the frontend calls (`GET …/drawings`). Serves from
   * the rebuildable projection when it has a safe active generation; otherwise falls back to the live
   * register (a project whose drawing events the relay has not applied yet, or a legacy project never
   * rebuilt) — additive and correct, never empty during warm-up. `source` tells the client which path
   * served it (the register is byte-identical either way).
   */
  async moduleDrawings(projectId: string, userId?: string): Promise<DrawingsModuleResult> {
    const proj = await this.projectionSlice(projectId, userId);
    if (proj.generation !== null) {
      return { drawings: proj.drawings, source: 'projection', generation: proj.generation };
    }
    const live = await this.snapshotSlice(projectId, userId);
    return { drawings: live, source: 'live', generation: null };
  }

  /**
   * The drawing-gate READINESS input for the shared truth table ({@link deriveDrawingGate}): each
   * (non-draft-aware) drawing's revisions with their frozen recipient ids + ack ids. The ONLY read of
   * drawing persistence a consumer needs for readiness — so the snapshot and the activity-start command
   * evaluate the drawing gate through this boundary instead of reading `prisma.drawing` directly
   * (read-encapsulation). `activityId` scopes it to one activity's drawings (the start command); `tx`
   * runs it inside the caller's transaction (the atomic readiness evaluation under the project lock).
   */
  async readinessSlice(
    projectId: string,
    opts: { activityId?: string; tx?: Prisma.TransactionClient } = {},
  ): Promise<ReadinessDrawing[]> {
    const db = opts.tx ?? this.prisma;
    const drawings = await db.drawing.findMany({
      where: { projectId, ...(opts.activityId ? { activityId: opts.activityId } : {}) },
      include: {
        revisions: { include: { recipients: { select: { userId: true } }, acks: { select: { userId: true } } } },
      },
    });
    return drawings.map((d) => ({
      number: d.number,
      activityId: d.activityId,
      draft: d.publishedAt === null,
      revisions: d.revisions.map((r) => ({
        status: r.status,
        recipientsFrozenAt: r.recipientsFrozenAt,
        recipientIds: r.recipients.map((x) => x.userId),
        ackedIds: r.acks.map((x) => x.userId),
      })),
    }));
  }

  /** Does drawing `drawingId` exist in project `projectId`? The tenant-ownership check a consumer (a
   *  media upload linking a `drawingId`) runs before storing a reference to it. */
  async existsInProject(projectId: string, drawingId: string): Promise<boolean> {
    const row = await this.prisma.drawing.findFirst({ where: { id: drawingId, projectId }, select: { id: true } });
    return row !== null;
  }

  /** Resolve an OPTIONAL drawing reference: null/undefined pass through; a present id must belong to
   *  THIS project. */
  async resolveRefInProject(
    projectId: string,
    id: string | null | undefined,
    field = 'drawingId',
  ): Promise<string | null> {
    if (!id) return null;
    if (!(await this.existsInProject(projectId, id))) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
    return id;
  }
}
