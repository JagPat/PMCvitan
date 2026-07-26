import { Body, Controller, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { WorkerDevicesService } from './worker-devices.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { bindWorkerDeviceSchema, type BindWorkerDeviceInput } from '../contracts';

/**
 * Phase 4 Task 3 — the ORGS-owned `WorkerDevice` binding route (plan §H). `WorkerDevice` is an
 * orgs-owned model, so its write surface lives in the owning module even though the workflow it
 * serves (trusted attendance evidence) is Labour's. Capability-gated + `labour.manage` authority.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class WorkerDevicesController {
  constructor(private readonly devices: WorkerDevicesService) {}

  @Post('worker-devices/:deviceId/bind')
  @RolesFor('labour.manage')
  bind(
    @Param('projectId') projectId: string,
    @Param('deviceId') deviceId: string,
    @Body(new ZodPipe(bindWorkerDeviceSchema)) body: BindWorkerDeviceInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.devices.bind(projectId, deviceId, body, user, idempotencyKey);
  }
}
