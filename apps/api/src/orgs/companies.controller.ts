import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { ZodPipe } from '../common/zod.pipe';
import { addCompanySchema, updateCompanySchema, type AddCompanyInput, type UpdateCompanyInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { AllowAnyRole, Roles, RolesGuard } from '../common/roles';

const COMPANIES_AUTHZ = 'CompaniesService.canManage() enforces project-PMC / org owner-admin authority';

/** Companies & consultants for a project. Project-scoped, so the JwtGuard tenancy check
 *  limits the caller to their token's project; mutations are further gated in the service.
 *  RolesGuard is in the chain so the read route can name its allowed roles. */
@Controller('projects/:projectId/companies')
@UseGuards(JwtGuard, RolesGuard)
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  /** Consultant/company contacts & notes — interactive session roles only; never the
   *  anonymously-minted `worker` device token (P1-2). */
  @Get()
  @Roles('pmc', 'client', 'engineer', 'contractor')
  list(@Param('projectId') projectId: string) {
    return this.companies.list(projectId);
  }

  @Post()
  @AllowAnyRole(COMPANIES_AUTHZ)
  add(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(addCompanySchema)) body: AddCompanyInput) {
    return this.companies.add(projectId, user, body);
  }

  @Patch(':companyId')
  @AllowAnyRole(COMPANIES_AUTHZ)
  update(
    @Param('projectId') projectId: string,
    @Param('companyId') companyId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(updateCompanySchema)) body: UpdateCompanyInput,
  ) {
    return this.companies.update(projectId, user, companyId, body);
  }

  @Delete(':companyId')
  @AllowAnyRole(COMPANIES_AUTHZ)
  remove(@Param('projectId') projectId: string, @Param('companyId') companyId: string, @CurrentUser() user: AuthUser) {
    return this.companies.remove(projectId, user, companyId);
  }
}
