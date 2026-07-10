import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';
import { decideReviewSchema, submitInspectionSchema, type DecideReviewInput, type SubmitInspectionInput } from '../contracts';

@Controller('projects/:projectId/inspections/:inspectionId')
@UseGuards(JwtGuard, RolesGuard)
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  /** Submit an inspection's photo checklist — the site engineer (or PMC). */
  @Post('submit')
  @Roles('engineer', 'pmc')
  submit(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(submitInspectionSchema)) body: SubmitInspectionInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.submit(projectId, inspectionId, body, user);
  }

  /** Approve or reject a submitted inspection — the PMC/architect only. */
  @Post('decide')
  @Roles('pmc')
  decide(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(decideReviewSchema)) body: DecideReviewInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.decide(projectId, inspectionId, body, user);
  }
}
