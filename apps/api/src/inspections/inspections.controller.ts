import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import { InspectionsQueryService } from './inspections.query';
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
  constructor(
    private readonly inspections: InspectionsService,
    private readonly inspectionsQuery: InspectionsQueryService,
  ) {}

  /** Phase 2 Task 10 (Module 3) — the MODULE-OWNED inspections read (XOR read-ownership): the frontend
   *  fetches the inspection slices HERE (from the rebuildable projection, else the live fallback) instead
   *  of the snapshot slice when `VITE_INSPECTIONS_READ=moduleQuery`. Role-gated at bake time (PMC-only
   *  review queue, pmc/engineer placement) exactly as the snapshot slice, so it is never an RBAC bypass. */
  @Get()
  @RolesFor('project.read')
  read(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.inspectionsQuery.moduleInspections(projectId, user.role);
  }

  /** Issue a stage checklist — the PMC/architect defines what gets inspected. */
  @Post()
  @RolesFor('inspection.create')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createInspectionSchema)) body: CreateInspectionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inspections.create(projectId, body, user, idempotencyKey);
  }

  /** Submit an inspection's photo checklist — the site engineer (or PMC). */
  @Post(':inspectionId/submit')
  @RolesFor('inspection.submit')
  submit(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(submitInspectionSchema)) body: SubmitInspectionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inspections.submit(projectId, inspectionId, body, user, idempotencyKey);
  }

  /** Approve or reject a submitted inspection — the PMC/architect only. */
  @Post(':inspectionId/decide')
  @RolesFor('inspection.decide')
  decide(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(decideReviewSchema)) body: DecideReviewInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inspections.decide(projectId, inspectionId, body, user, idempotencyKey);
  }
}
