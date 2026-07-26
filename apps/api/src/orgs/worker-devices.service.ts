import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ROLE_POLICY } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../platform/capabilities.service';
import { recordAudit } from '../platform/audit';
import { executeCommand, hashRequest } from '../platform/commands';
import { LabourRequirementQuery } from '../labour/labour.query';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { BindWorkerDeviceInput } from '../contracts';

/**
 * Phase 4 Task 3 — the `WorkerDevice` → `Worker` BINDING command (plan §H, F5).
 *
 * Task 1 laid the structural foundation: the nullable same-project `(projectId, workerId)`
 * composite FK on `WorkerDevice`, so a device can never reference a worker in another project.
 * The binding COMMAND lives HERE because `WorkerDevice` is an ORGS-owned model — Labour must not
 * write another module's table (read-encapsulation), so the owner exposes the command and Labour
 * merely relies on the resulting FK when a muster cites a device as evidence (§C.3).
 *
 * A device starts UNBOUND (anonymous QR/tap onboarding is unchanged and still works byte-for-byte);
 * binding is a one-way trusted-identity assertion under `labour.manage` (pmc) authority, and it is
 * capability-gated like every other labour surface (404 off-pilot). Re-binding a device to a
 * DIFFERENT worker is refused — a device already stands as evidence for its worker's musters, so
 * re-pointing it would retroactively re-attribute presence.
 */
@Injectable()
export class WorkerDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly labourQuery: LabourRequirementQuery,
  ) {}

  async bind(projectId: string, deviceId: string, input: BindWorkerDeviceInput, user: AuthUser, idempotencyKey?: string): Promise<{ deviceId: string; workerId: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    if (!(ROLE_POLICY['labour.manage'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Binding a device to a worker is a pmc surface');
    }
    const actor = await resolveActor(this.prisma, user);
    await executeCommand(this.prisma, {
      scope: { scopeKind: 'project', projectId }, actor, commandType: 'orgs.workerDevice.bind',
      idempotencyKey, requestHash: hashRequest({ deviceId, ...input }),
      run: async (tx) => {
        const device = await tx.workerDevice.findFirst({ where: { id: deviceId, projectId }, select: { id: true, workerId: true } });
        if (!device) throw new NotFoundException('Worker device not found in this project');
        if (device.workerId === input.workerId) throw new ConflictException('Device is already bound to this worker');
        if (device.workerId) throw new ConflictException('Device is already bound to a different worker — its past musters are attributed to that worker');
        // `Worker` is LABOUR-owned and read-encapsulated, so this goes through Labour's query
        // contract (the orgs → labour read edge), never a direct Prisma read. The same-project
        // composite FK is the containment backstop; this supplies a truthful message + the
        // revocation check an FK cannot express.
        const worker = await this.labourQuery.workerLifecycle(projectId, input.workerId, tx);
        if (!worker) throw new BadRequestException('workerId does not name a worker in this project');
        if (worker.revoked) throw new BadRequestException('Worker is revoked and cannot be bound to a device');
        // CAS on the still-unbound row: two concurrent binds have exactly one winner
        const { count } = await tx.workerDevice.updateMany({
          where: { id: deviceId, projectId, workerId: null },
          data: { workerId: input.workerId },
        });
        if (count === 0) throw new ConflictException('Device was concurrently bound — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'orgs.workerDevice.bind', entity: 'WorkerDevice', entityId: deviceId });
        return { resultRef: deviceId, events: [] };
      },
    });
    return { deviceId, workerId: input.workerId };
  }
}
