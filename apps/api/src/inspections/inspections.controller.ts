import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  createInspectionSchema,
  decideReviewSchema,
  submitInspectionSchema,
  type CreateInspectionInput,
  type DecideReviewInput,
  type SubmitInspectionInput,
} from '../contracts';

@Controller('projects/:projectId/inspections')
@UseGuards(JwtGuard, RolesGuard)
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  /** Issue a stage checklist — the PMC/architect defines what gets inspected. */
  @Post()
  @RolesFor('inspection.create')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createInspectionSchema)) body: CreateInspectionInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.create(projectId, body, user);
  }

  /** Submit an inspection's photo checklist — the site engineer (or PMC). */
  @Post(':inspectionId/submit')
  @RolesFor('inspection.submit')
  submit(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(submitInspectionSchema)) body: SubmitInspectionInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.submit(projectId, inspectionId, body, user);
  }

  /** Approve or reject a submitted inspection — the PMC/architect only. */
  @Post(':inspectionId/decide')
  @RolesFor('inspection.decide')
  decide(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(decideReviewSchema)) body: DecideReviewInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.decide(projectId, inspectionId, body, user);
  }
}
