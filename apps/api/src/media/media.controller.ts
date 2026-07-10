import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MediaService } from './media.service';
import { ZodPipe } from '../common/zod.pipe';
import { createMediaSchema, type CreateMediaInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

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

  /** Serve a photo: inline bytes (dev stub) or a 302 to the bucket URL (S3/R2). Public (URLs are unguessable cuids). */
  @Get('media/:id')
  async serve(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const out = await this.media.fetch(id);
    if (!out) throw new NotFoundException('Media not found');
    if ('redirect' in out) {
      res.redirect(302, out.redirect);
      return;
    }
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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
