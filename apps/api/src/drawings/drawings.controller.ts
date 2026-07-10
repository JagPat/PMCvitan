import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DrawingsService } from './drawings.service';
import { SignedUrlService } from '../media/signed-url.service';
import { ZodPipe } from '../common/zod.pipe';
import { issueDrawingSchema, presignDrawingSchema, type IssueDrawingInput, type PresignDrawingInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Public, Roles, RolesGuard } from '../common/roles';

@Controller()
export class DrawingsController {
  constructor(
    private readonly drawings: DrawingsService,
    private readonly signed: SignedUrlService,
  ) {}

  /** Issue a drawing (new register entry, or a new revision that supersedes the prior).
   *  PMC only — issuing controlled drawings is the architect's authority. */
  @Post('projects/:projectId/drawings')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc')
  issue(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(issueDrawingSchema)) body: IssueDrawingInput,
  ) {
    return this.drawings.issue(projectId, user.sub, body);
  }

  /** Presigned direct-to-bucket upload target for a large drawing (PMC only, Slice 3). */
  @Post('projects/:projectId/drawings/presign')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc')
  presign(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(presignDrawingSchema)) body: PresignDrawingInput,
  ) {
    return this.drawings.presign(projectId, body.mime);
  }

  /** Acknowledge building to a revision (contractor / engineer / pmc — not client, not
   *  worker device tokens). The service also rejects `client`; the role gate keeps
   *  anonymously-minted worker tokens off the drawing-ack register. */
  @Post('projects/:projectId/drawings/rev/:revId/ack')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc', 'engineer', 'contractor')
  acknowledge(
    @Param('projectId') projectId: string,
    @Param('revId') revId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drawings.acknowledge(projectId, revId, user);
  }

  /**
   * Serve a revision's file. Private: requires a short-lived `?t=` token minted by the
   * authorized snapshot (403 otherwise). Dev stub returns inline bytes; S3/R2 returns a
   * 302 to a short-lived presigned GET (private bucket). @Public at the route level
   * because an iframe/img `src` can't send a bearer — the token IS the authorization.
   */
  @Public()
  @Get('drawings/rev/:id')
  async serve(@Param('id') id: string, @Query('t') token: string | undefined, @Res() res: Response): Promise<void> {
    if (!this.signed.verify('drawing', id, token)) throw new ForbiddenException('Invalid or expired file link');
    const out = await this.drawings.fetchRevision(id);
    if (!out) throw new NotFoundException('Drawing revision not found');
    if ('redirect' in out) {
      res.redirect(302, out.redirect);
      return;
    }
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Cache-Control', `private, max-age=${this.signed.cacheMaxAge()}`);
    res.send(out.bytes);
  }

  /** Delete a drawing (all revisions), scoped to the caller's project; PMC only —
   *  the architect controls the drawing register, matching PMC-only issue. */
  @Delete('drawings/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('pmc')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ ok: boolean }> {
    const ok = await this.drawings.remove(id, user.projectId);
    if (!ok) throw new NotFoundException('Drawing not found');
    return { ok: true };
  }
}
