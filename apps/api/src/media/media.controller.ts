import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MediaService } from './media.service';
import { SignedUrlService } from './signed-url.service';
import { ZodPipe } from '../common/zod.pipe';
import { addPosterSchema, createMediaSchema, setNodeSchema, type AddPosterInput, type CreateMediaInput, type SetNodeInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Public, RolesFor, RolesGuard } from '../common/roles';
import { MEDIA_NOT_FOUND_MESSAGE } from '@vitan/shared';

@Controller()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Upload a site photo (base64). Returns { id, url } — url is absolute (S3/R2) or /media/:id (dev stub).
   *  Every project member (#482, Board 14 Oct 2026); the service keeps record-linked evidence to the PMC and
   *  the engineer. Anonymously-minted worker tokens hold no grant, so they cannot write arbitrary blobs. */
  @Post('projects/:projectId/media')
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('media.upload')
  upload(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(createMediaSchema)) body: CreateMediaInput,
  ) {
    return this.media.create(projectId, user, body);
  }

  /** Re-file a photo onto a location-tree node (or null to unfile). PMC or site engineer —
   *  the same authority that uploads them. Returns the fresh snapshot. Location spine. */
  @Patch('projects/:projectId/media/:mediaId/node')
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('media.file')
  setNode(
    @Param('projectId') projectId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(setNodeSchema)) body: SetNodeInput,
  ) {
    return this.media.setNode(mediaId, projectId, body.nodeId, user);
  }

  /** #995 V1b — give a video clip on a site visit its still frame. Only the member who recorded the clip; the first
   *  frame stays, and a replay or a later one is answered 200 with the stored frame's link. */
  @Post('projects/:projectId/media/:mediaId/poster')
  @HttpCode(200)
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('media.upload')
  addPoster(
    @Param('projectId') projectId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(addPosterSchema)) body: AddPosterInput,
  ) {
    return this.media.addPoster(projectId, mediaId, user, body);
  }

  /** #995 V1b — serve a clip's still frame, on its own `?t=` token (a clip's token does not open it): a 302 to a
   *  short-lived presigned GET, as for every stored file. */
  @Public()
  @Get('media/:id/poster')
  async servePoster(@Param('id') id: string, @Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    if (!this.signed.verify('poster', id, token)) throw new ForbiddenException('Invalid or expired file link');
    const out = await this.media.fetchPoster(id);
    if (!out) throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
    res.redirect(302, out.redirect);
  }

  /**
   * Serve a photo. Private: requires a short-lived `?t=` file token minted by the
   * authorized snapshot/upload (a bad or missing token is 403 — no more "public because
   * the cuid is unguessable"). Dev stub returns inline bytes; S3/R2 returns a 302 to a
   * short-lived presigned GET (bucket stays private). Marked @Public at the route level
   * because `<img>` can't send a bearer — the token IS the authorization.
   */
  @Public()
  @Get('media/:id')
  async serve(@Param('id') id: string, @Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    if (!this.signed.verify('media', id, token)) throw new ForbiddenException('Invalid or expired file link');
    const out = await this.media.fetch(id);
    if (!out) throw new NotFoundException('Media not found');
    if ('redirect' in out) {
      res.redirect(302, out.redirect);
      return;
    }
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Cache-Control', `private, max-age=${this.signed.cacheMaxAge()}`);
    res.send(out.bytes);
  }

  /** Delete a photo (bucket object + row). Scoped to the caller's project. The PMC and the site engineer delete
   *  any photo; every other member only a site photo they added, within the hour (#482, Board 14 Oct 2026). */
  @Delete('media/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('media.delete')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ ok: boolean; dailyLogId: string | null }> {
    const removed = await this.media.removeFiled(id, user);
    // the web reads this exact text as "already deleted" (shared, #991)
    if (!removed) throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
    // the day's log the photo was counted on, so a client can take it off that count at once (Codex 4317884791)
    return { ok: true, dailyLogId: removed.dailyLogId };
  }
}
