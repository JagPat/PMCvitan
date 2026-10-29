import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';
import { Public } from '../../common/roles';
import { Throttle, ThrottleGuard } from '../../common/throttle';
import { ZodPipe } from '../../common/zod.pipe';
import { SWITCHABLE_CAPABILITIES } from '../capabilities.service';
import { disableCapability, enableCapability, ProjectNotOperableError } from '../capability-switch';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import { OpsTokenGuard } from './ops-token.guard';

export const switchSchema = z.object({
  operator: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(3).max(500),
});
export type SwitchInput = z.infer<typeof switchSchema>;

export interface OpsProjectRow {
  id: string;
  name: string;
  capabilities: string[];
  lastActivity: string | null;
}

/** Recorded on the audit row of a switch made through this door, beside the operator and reason. */
export const OPS_VIA = 'ops-api';

/**
 * #482 operator door (Jagrut's go, 19 Oct 2026) — the operator commands the Board ran by hand from the
 * Coolify terminal, as HTTP routes an operator (or Claude, holding `OPS_TOKEN`) can call:
 *
 *  - `GET  /ops/projects`: every live project with its switched-on capabilities and last activity (reads only).
 *  - `GET  /ops/people`: each company's owners and admins, and each live project's active members with their
 *    role (reads only), so "who can manage this project" is answered without a terminal paste.
 *  - `POST /ops/orgs/:orgId/qa-only`: mark a company QA-only, in {@link OpsQaController}.
 *  - `GET  /ops/compat/state-pins?since=<ISO>`: seen-state pin counts per pinned act, in {@link OpsCompatController}.
 *  - `GET  /ops/compat/client-keys?since=<ISO>`: keyless and legacy-keyed request counts on five routes (Idempotency-Key
 *    2a), in {@link OpsCompatController}.
 *  - `POST /ops/projects/:projectId/capabilities/:capability/enable|disable`: the same `capability-switch`
 *    functions the `capability:enable` / `capability:disable` CLIs call, limited to `SWITCHABLE_CAPABILITIES`
 *    (presentation only, no data touched). Each change writes the usual audit row on the project's trail
 *    with the operator, the reason and `via: "ops-api"`; a repeat is a no-op reporting `changed: false`.
 *
 * Nothing here runs SQL a caller supplies, and nothing reaches data beyond these switches. Every route is
 * behind {@link OpsTokenGuard} (closed without a strong `OPS_TOKEN`) and a per-IP limit. The door guard runs BEFORE
 * the limiter, as on `OpsQaController` and `AuthOpsController`: a closed door is 404 however often it is called, and
 * calls without the token are refused before they are counted, so they never spend the operator's limit. Wrong
 * tokens are counted in the guard's own window instead (429 over it), which a correct token never reads.
 */
@Controller('ops')
@UseGuards(OpsTokenGuard, ThrottleGuard)
@Throttle(30, 60_000)
export class OpsController {
  constructor(private readonly prisma: PrismaService, private readonly orgs: OrgsParticipant) {}

  @Public()
  @Get('projects')
  async projects(): Promise<{ projects: OpsProjectRow[] }> {
    // the operable population is the orgs owner's answer; capabilities and activity are platform-owned
    const projects = await this.orgs.operableProjects(this.prisma);
    const ids = projects.map((p) => p.id);
    const [capabilities, activity] = await Promise.all([
      this.prisma.projectCapability.findMany({ where: { projectId: { in: ids } }, select: { projectId: true, capability: true }, orderBy: { capability: 'asc' } }),
      this.prisma.auditLog.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _max: { at: true } }),
    ]);
    const switched = new Map<string, string[]>();
    for (const c of capabilities) switched.set(c.projectId, [...(switched.get(c.projectId) ?? []), c.capability]);
    const last = new Map(activity.map((a) => [a.projectId, a._max.at]));
    const rows = projects.map((p) => ({
      id: p.id,
      name: p.name,
      capabilities: switched.get(p.id) ?? [],
      lastActivity: last.get(p.id)?.toISOString() ?? null,
    }));
    // most recently used first; never-used projects last, in id order
    rows.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.id.localeCompare(b.id));
    return { projects: rows };
  }

  @Public()
  @Get('people')
  async people(): Promise<Awaited<ReturnType<OrgsParticipant['operatorRoster']>>> {
    return this.orgs.operatorRoster(this.prisma);
  }

  @Public()
  @Post('projects/:projectId/capabilities/:capability/enable')
  @HttpCode(200)
  async enable(
    @Param('projectId') projectId: string,
    @Param('capability') capability: string,
    @Body(new ZodPipe(switchSchema)) body: SwitchInput,
  ): Promise<{ ok: true; projectId: string; capability: string; changed: boolean }> {
    assertSwitchable(capability);
    const { changed } = await this.withProject(() =>
      enableCapability(this.prisma, { projectId, capability, operator: body.operator, reason: body.reason, via: OPS_VIA }));
    return { ok: true, projectId, capability, changed };
  }

  @Public()
  @Post('projects/:projectId/capabilities/:capability/disable')
  @HttpCode(200)
  async disable(
    @Param('projectId') projectId: string,
    @Param('capability') capability: string,
    @Body(new ZodPipe(switchSchema)) body: SwitchInput,
  ): Promise<{ ok: true; projectId: string; capability: string; changed: boolean }> {
    assertSwitchable(capability);
    const { changed } = await this.withProject(() =>
      disableCapability(this.prisma, { projectId, capability, operator: body.operator, reason: body.reason, via: OPS_VIA }));
    return { ok: true, projectId, capability, changed };
  }

  /** An unknown or archived project is the caller's mistake (400), not a server fault. */
  private async withProject<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ProjectNotOperableError) throw new BadRequestException('no such project, or it is archived');
      throw e;
    }
  }
}

function assertSwitchable(capability: string): void {
  if (!SWITCHABLE_CAPABILITIES.includes(capability)) {
    throw new BadRequestException(`only ${SWITCHABLE_CAPABILITIES.join(', ')} can be switched here`);
  }
}
