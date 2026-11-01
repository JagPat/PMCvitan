import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MediaService } from './media.service';
import { SignedUrlService } from './signed-url.service';
import { VoiceTranscriptService } from './voice-transcript.service';
import { ZodPipe } from '../common/zod.pipe';
import { addPosterSchema, correctTranscriptSchema, createMediaSchema, removeVisitFileSchema, setNodeSchema, type AddPosterInput, type CorrectTranscriptInput, type CreateMediaInput, type RemoveVisitFileInput, type SetNodeInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Public, RolesFor, RolesGuard } from '../common/roles';
import { MEDIA_NOT_FOUND_MESSAGE } from '@vitan/shared';

@Controller()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly signed: SignedUrlService,
    private readonly transcripts: VoiceTranscriptService,
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

  /** #1177 VT2 — a voice note's written-out words, where the project's `voice-text` switch is on (404 elsewhere).
   *  Every member who can see the note reads them. */
  @Get('projects/:projectId/media/:mediaId/transcript')
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('project.read')
  transcript(@Param('projectId') projectId: string, @Param('mediaId') mediaId: string, @CurrentUser() user: AuthUser) {
    return this.transcripts.get(projectId, mediaId, user);
  }

  /** #1177 VT2 — "Try again" once after the words could not be written out. The note's recorder, the PMC or the engineer:
   *  the route lets every reader through and the service decides, so a recorder whose role has changed since is not
   *  turned away here. */
  @Post('projects/:projectId/media/:mediaId/transcript/retry')
  @HttpCode(200)
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('project.read')
  retryTranscript(@Param('projectId') projectId: string, @Param('mediaId') mediaId: string, @CurrentUser() user: AuthUser) {
    return this.transcripts.retry(projectId, mediaId, user);
  }

  /** #1177 VT2 — correct a voice note's words (or take the correction back with `null`). The note's recorder, the PMC or
   *  the engineer (decided by the service, as for "Try again"); each correction is added as its own row, and the words
   *  heard stay stored beside them (H7, VT1b). */
  @Post('projects/:projectId/media/:mediaId/transcript/correction')
  @HttpCode(200)
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('project.read')
  correctTranscript(
    @Param('projectId') projectId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(correctTranscriptSchema)) body: CorrectTranscriptInput,
  ) {
    return this.transcripts.correct(projectId, mediaId, user, body.text, body.basedOn);
  }

  /** #995 V1b — serve a clip's still frame, on its own `?t=` token (a clip's token does not open it): a 302 to a
   *  short-lived presigned GET, as for every stored file. */
  @Public()
  @Get('media/:id/poster')
  async servePoster(@Param('id') id: string, @Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
   * because `<img>` can't send a bearer — the token IS the authorization. Every answer, errors and redirects
   * included, says `nosniff`: a browser takes the stored file as its checked type, never as a page (#995).
   */
  @Public()
  @Get('media/:id')
  async serve(@Param('id') id: string, @Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
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

  /** #1179 — take a file off its site visit and delete it: the person who added it within the hour while the visit is
   *  open, or the PMC at any time with a reason. The visit keeps a line saying who removed it, when and why. */
  @Post('projects/:projectId/media/:mediaId/visit-removal')
  @HttpCode(200)
  @UseGuards(JwtGuard, RolesGuard)
  @RolesFor('media.delete')
  async removeFromVisit(
    @Param('projectId') projectId: string,
    @Param('mediaId') mediaId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(removeVisitFileSchema)) body: RemoveVisitFileInput,
  ): Promise<{ ok: true }> {
    await this.media.removeFromVisit(projectId, mediaId, user, body.reason ?? null);
    return { ok: true };
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
