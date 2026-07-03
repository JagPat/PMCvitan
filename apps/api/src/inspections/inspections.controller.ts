import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { decideReviewSchema, submitInspectionSchema, type DecideReviewInput, type SubmitInspectionInput } from '../contracts';

@Controller('projects/:projectId/inspections/:inspectionId')
@UseGuards(JwtGuard)
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  @Post('submit')
  submit(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(submitInspectionSchema)) body: SubmitInspectionInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.submit(projectId, inspectionId, body, user);
  }

  @Post('decide')
  decide(
    @Param('projectId') projectId: string,
    @Param('inspectionId') inspectionId: string,
    @Body(new ZodPipe(decideReviewSchema)) body: DecideReviewInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inspections.decide(projectId, inspectionId, body, user);
  }
}
