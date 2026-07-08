import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DrawingsService } from './drawings.service';
import { ZodPipe } from '../common/zod.pipe';
import { issueDrawingSchema, type IssueDrawingInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';

@Controller()
export class DrawingsController {
  constructor(private readonly drawings: DrawingsService) {}

  /** Issue a drawing (new register entry, or a new revision that supersedes the prior). */
  @Post('projects/:projectId/drawings')
  @UseGuards(JwtGuard)
  issue(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(issueDrawingSchema)) body: IssueDrawingInput,
  ) {
    return this.drawings.issue(projectId, user.sub, body);
  }

  /** Serve a revision's file: inline bytes (dev stub) or a 302 to the bucket URL (S3/R2). */
  @Get('drawings/rev/:id')
  async serve(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const out = await this.drawings.fetchRevision(id);
    if (!out) throw new NotFoundException('Drawing revision not found');
    if ('redirect' in out) {
      res.redirect(302, out.redirect);
      return;
    }
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(out.bytes);
  }

  /** Delete a drawing (all revisions), auth required, scoped to the caller's project. */
  @Delete('drawings/:id')
  @UseGuards(JwtGuard)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ ok: boolean }> {
    const ok = await this.drawings.remove(id, user.projectId);
    if (!ok) throw new NotFoundException('Drawing not found');
    return { ok: true };
  }
}
