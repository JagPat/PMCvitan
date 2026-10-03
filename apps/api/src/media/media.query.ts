import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * The media module's read contract for other modules: a foreign reader asks here instead of reading
 * the media-owned `Media` table directly, so media can change its read model without silently breaking
 * a rollup elsewhere.
 */
@Injectable()
export class MediaQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** U3a — how many progress photos a project gained at or after `since` (the PMC brief's figure). */
  progressPhotoCountSince(projectId: string, since: Date): Promise<number> {
    return this.prisma.media.count({ where: { projectId, kind: 'progress', createdAt: { gte: since } } });
  }
}
