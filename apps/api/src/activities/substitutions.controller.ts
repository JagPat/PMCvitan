import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { SubstitutionsService } from './substitutions.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  approveSubstitutionSchema, revokeSubstitutionSchema,
  type ApproveSubstitutionInput, type RevokeSubstitutionInput,
} from '../contracts';

/**
 * Phase 3 Task 6 — approved material substitutions (pmc authority, §B/§H). Both handlers are
 * CAPABILITY-GATED in the service (§D): a non-pilot project gets 404. Approve is per requirement;
 * revoke stamps (never deletes) a substitution by id.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class SubstitutionsController {
  constructor(private readonly substitutions: SubstitutionsService) {}

  @Post('requirements/:requirementId/substitutions')
  @RolesFor('substitution.manage')
  approve(
    @Param('projectId') projectId: string,
    @Param('requirementId') requirementId: string,
    @Body(new ZodPipe(approveSubstitutionSchema)) body: ApproveSubstitutionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.substitutions.approve(projectId, requirementId, body, user, idempotencyKey);
  }

  @Post('substitutions/:substitutionId/revoke')
  @RolesFor('substitution.manage')
  revoke(
    @Param('projectId') projectId: string,
    @Param('substitutionId') substitutionId: string,
    @Body(new ZodPipe(revokeSubstitutionSchema)) body: RevokeSubstitutionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.substitutions.revoke(projectId, substitutionId, body, user, idempotencyKey);
  }
}
