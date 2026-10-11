import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { ZodPipe } from '../common/zod.pipe';
import { notificationsSeenSchema, type NotificationsSeenInput } from '../contracts';
import { NotificationsSeenService } from './notifications-seen.service';

/**
 * Top 10 #4b unit C (#778) — the bell's "seen" mark. Gated exactly as the snapshot that serves the
 * feed (`project.read`, no new permission): a viewer marks only notices they can be served, and a
 * worker device, which is never served the feed, is refused here as it is there.
 */
@Controller('projects/:projectId/notifications')
@UseGuards(JwtGuard, RolesGuard)
export class NotificationsSeenController {
  constructor(private readonly seen: NotificationsSeenService) {}

  /** Record that the viewer saw these notices. `confirmed` lists the submitted ids that were served to
   *  the viewer and now hold a durable receipt; every other id is simply absent. */
  @Post('seen')
  @HttpCode(200)
  @RolesFor('project.read')
  markSeen(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(notificationsSeenSchema)) body: NotificationsSeenInput,
  ): Promise<{ confirmed: string[] }> {
    return this.seen.markSeen(projectId, user, body.ids);
  }
}
