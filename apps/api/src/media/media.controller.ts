import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MediaService } from './media.service';
import { SignedUrlService } from './signed-url.service';
import { ZodPipe } from '../common/zod.pipe';
import { createMediaSchema, setNodeSchema, type CreateMediaInput, type SetNodeInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Public, Roles, RolesGuard } from '../common/roles';

@Controller()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Upload a site photo (base64). Returns { id, url } — url is absolute (S3/R2) or /media/:id (dev stub).
   *  PMC or site engineer only — progress photos come from the engineer's daily-log flow; this keeps
   *  anonymously-minted worker tokens from writing arbitrary blobs, matching the DELETE gate below. */
  @Post('projects/:projectId/media')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc', 'engineer')
  upload(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(createMediaSchema)) body: CreateMediaInput,
  ) {
    return this.media.create(projectId, user.sub, body);
  }

  /** Re-file a photo onto a location-tree node (or null to unfile). PMC or site engineer —
   *  the same authority that uploads them. Returns the fresh snapshot. Location spine. */
  @Patch('projects/:projectId/media/:mediaId/node')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc', 'engineer')
  setNode(
    @Param('projectId') projectId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(setNodeSchema)) body: SetNodeInput,
  ) {
    return this.media.setNode(mediaId, projectId, body.nodeId, user);
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

  /** Delete a photo (bucket object + row). Scoped to the caller's project; PMC or site engineer only. */
  @Delete('media/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc', 'engineer')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ ok: boolean }> {
    const ok = await this.media.remove(id, user.projectId);
    if (!ok) throw new NotFoundException('Media not found');
    return { ok: true };
  }
}
