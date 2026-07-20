import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { VendorsService } from './vendors.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { AllowAnyRole, RolesFor, RolesGuard } from '../common/roles';

const VENDOR_ORG_AUTHZ = 'VendorsService enforces org owner/admin authority for this route (§H — vendor CRUD is org-level, not a project role)';
import {
  createVendorSchema, bindVendorSchema,
  type CreateVendorInput, type BindVendorInput,
} from '../contracts';

/**
 * Phase 3 Task 2 — the vendor registry (§H). The ORG surface is org-admin authority
 * (org membership owner/admin — checked in the service; no project role applies, which is
 * exactly the separation the §H probe demands). The PROJECT surface (binding + listing) is
 * project-role-gated AND capability-gated in the service (404 off-pilot).
 */
@Controller()
@UseGuards(JwtGuard, RolesGuard)
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Post('orgs/:orgId/vendors')
  @AllowAnyRole(VENDOR_ORG_AUTHZ)
  createVendor(
    @Param('orgId') orgId: string,
    @Body(new ZodPipe(createVendorSchema)) body: CreateVendorInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.vendors.create(orgId, body, user, idempotencyKey);
  }

  @Get('orgs/:orgId/vendors')
  @AllowAnyRole(VENDOR_ORG_AUTHZ)
  listOrgVendors(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser) {
    return this.vendors.listForOrg(orgId, user);
  }

  @Post('projects/:projectId/vendors')
  @RolesFor('procurement.manage')
  bind(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(bindVendorSchema)) body: BindVendorInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.vendors.bind(projectId, body, user, idempotencyKey);
  }

  @Get('projects/:projectId/vendors')
  @RolesFor('procurement.read')
  listProjectVendors(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.vendors.listForProject(projectId, user);
  }
}
