import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';
import { Public } from '../../common/roles';
import { Throttle, ThrottleGuard } from '../../common/throttle';
import { ZodPipe } from '../../common/zod.pipe';
import { SWITCHABLE_CAPABILITIES } from '../capabilities.service';
import { disableCapability, enableCapability, ProjectNotOperableError } from '../capability-switch';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import { InspectionParticipant } from '../../inspections/inspection.participant';
import { ActivityParticipant } from '../../activities/activity.participant';
import { DecisionsParticipant } from '../../decisions/decisions.participant';
import { DrawingParticipant } from '../../drawings/drawing.participant';
import { SiteVisitsParticipant } from '../../site-visits/site-visits.participant';
import type { OpenWorkCounts } from '../../common/open-work';
import { OpsTokenGuard } from './ops-token.guard';
import { retirements } from '../identity-retirement.query';
import { recordAudit } from '../audit';
import { systemActor } from '../../common/actor';
import { randomUUID } from 'node:crypto';

export const switchSchema = z.object({
  operator: z.string().trim().min(3).max(200),
  reason: z.string().trim().min(3).max(500),
});
export type SwitchInput = z.infer<typeof switchSchema>;

/** Redbracket ID A4c — the operator owner re-seat: who, why, and the retired account whose owner seat is put back. */
export const ownerReseatSchema = switchSchema.extend({
  retiredUserId: z.string().trim().min(1).max(200),
});
export type OwnerReseatInput = z.infer<typeof ownerReseatSchema>;

export interface OpsProjectRow {
  id: string;
  name: string;
  capabilities: string[];
  lastActivity: string | null;
}

/** A retired account (Redbracket ID) that still holds seats or open work; `email` is the address it was retired from,
 *  which the person's new linked account now holds, so the re-seat adds that address. `name` is the address when the
 *  account holds no seat (the seat read is what names it). */
export interface OpsRetiredRow {
  userId: string;
  name: string;
  email: string;
  retiredAt: string;
  projects: Array<{ id: string; name: string; role: string; status: string; approvalLimit: string | null; discipline: string | null }>;
  companies: Array<{ id: string; name: string; role: string }>;
  /** Redbracket ID A4b-2 — open work still named on the account, per live project (only projects with some) */
  openWork: OpsOpenWork[];
}

/** Open work named on a retired account in one live project, each kind answered by its owning module. */
export interface OpsOpenWork {
  projectId: string;
  projectName: string;
  inspections: number;
  requirements: number;
  /** published open decisions naming one of the account's memberships as decider */
  decisions: number;
  consultations: number;
  drawings: number;
  /** open site visits only the account (their visitor) can end */
  siteVisits: number;
}

/** Recorded on the audit row of a switch made through this door, beside the operator and reason. */
export const OPS_VIA = 'ops-api';

/**
 * #482 operator door (Jagrut's go, 19 Oct 2026) — the operator commands the Board ran by hand from the
 * Coolify terminal, as HTTP routes an operator (or Claude, holding `OPS_TOKEN`) can call:
 *
 *  - `GET  /ops/projects`: every live project with its switched-on capabilities and last activity (reads only).
 *  - `GET  /ops/people`: each company's owners and admins, and each live project's active members with their
 *    role (reads only), so "who can manage this project" is answered without a terminal paste; and (Redbracket ID
 *    A4b) `retired`: each account a first Redbracket ID sign-in set aside that still holds a seat or (A4b-2) open work.
 *  - `POST /ops/orgs/:orgId/qa-only`: mark a company QA-only, in {@link OpsQaController}.
 *  - `GET  /ops/compat/state-pins?since=<ISO>`: seen-state pin counts per pinned act, in {@link OpsCompatController}.
 *  - `GET  /ops/compat/client-keys?since=<ISO>`: keyless and legacy-keyed request counts on five routes (Idempotency-Key
 *    2a), in {@link OpsCompatController}.
 *  - `POST /ops/orgs/:orgId/owner-reseat` (Redbracket ID A4c): when every owner seat of a company is held by an account
 *    a first Redbracket ID sign-in set aside, seat as owner the new account made for one of those owners
 *    (`retiredUserId`), so that person can re-seat the rest through the team commands (RUNBOOK). Refused while any
 *    owner of the company can sign in. Audited on every live project's trail and on the person's security trail.
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrgsParticipant,
    // Redbracket ID A4b-2 — the open work named on a retired account, each kind asked of its owning module through its
    // participant (platform.workflowParticipants declares the edges); this door never reads their tables.
    private readonly inspections: InspectionParticipant,
    private readonly activities: ActivityParticipant,
    private readonly decisions: DecisionsParticipant,
    private readonly drawings: DrawingParticipant,
    private readonly siteVisits: SiteVisitsParticipant,
  ) {}

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
  async people(): Promise<Awaited<ReturnType<OrgsParticipant['operatorRoster']>> & { retired: OpsRetiredRow[] }> {
    const roster = await this.orgs.operatorRoster(this.prisma);
    return { ...roster, retired: await this.retiredWithSeats() };
  }

  /**
   * Redbracket ID A4b — every account a first Redbracket ID sign-in set aside that still holds a seat, oldest first.
   * Retirement writes no seats: the project's PMC or a company owner re-seats the person by adding them by email (which
   * lands on their new linked account) and then removing the retired row, through the normal team commands
   * (docs/RUNBOOK.md, "Redbracket ID re-seat"). A4b-2: an account also stays listed while open work in a live project
   * still names it (inspections, requirements, decisions, consultations, drawings and site visits waiting on it), which the re-seat moves by hand;
   * it leaves the list only when its seats and its open work are both zero. The pilot widens only when this list is empty.
   */
  private async retiredWithSeats(): Promise<OpsRetiredRow[]> {
    const retired = await retirements(this.prisma);
    const ids = retired.map((r) => r.userId);
    const [seats, live, inspections, requirements, decisions, consultations, drawings, siteVisits] = await Promise.all([
      this.orgs.seatsOf(this.prisma, ids),
      this.orgs.operableProjects(this.prisma),
      this.inspections.openWorkOf(this.prisma, ids),
      this.activities.openWorkOf(this.prisma, ids),
      this.decisions.openDecisionsOf(this.prisma, ids),
      this.decisions.openWorkOf(this.prisma, ids),
      this.drawings.openWorkOf(this.prisma, ids),
      this.siteVisits.openWorkOf(this.prisma, ids),
    ]);
    const projectName = new Map(live.map((p) => [p.id, p.name] as const));
    const kinds: Array<[keyof Omit<OpsOpenWork, 'projectId' | 'projectName'>, OpenWorkCounts]> = [
      ['inspections', inspections], ['requirements', requirements], ['decisions', decisions],
      ['consultations', consultations], ['drawings', drawings], ['siteVisits', siteVisits],
    ];
    return retired.flatMap((r) => {
      const held = seats.get(r.userId);
      const work = new Map<string, OpsOpenWork>();
      for (const [kind, counts] of kinds) {
        for (const [projectId, n] of counts.get(r.userId) ?? []) {
          const name = projectName.get(projectId);
          if (name === undefined || n === 0) continue; // an archived project's work is frozen with it
          const row = work.get(projectId) ?? { projectId, projectName: name, inspections: 0, requirements: 0, decisions: 0, consultations: 0, drawings: 0, siteVisits: 0 };
          row[kind] += n;
          work.set(projectId, row);
        }
      }
      if (!held && work.size === 0) return [];
      return [{
        userId: r.userId,
        name: held?.name ?? r.email,
        email: r.email,
        retiredAt: r.retiredAt.toISOString(),
        projects: held?.projects ?? [],
        companies: held?.companies ?? [],
        openWork: [...work.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
      }];
    });
  }

  /**
   * Redbracket ID A4c — put back one owner of a company whose every owner seat is held by a retired account
   * (`OrgsParticipant.operatorOwnerReseat`, which judges and writes under the company's key). A repeat changes nothing.
   * A live call is an operator-door write: it needs Jagrut's yes naming the company and the person (RUNBOOK step 0).
   */
  @Public()
  @Post('orgs/:orgId/owner-reseat')
  @HttpCode(200)
  async ownerReseat(
    @Param('orgId') orgId: string,
    @Body(new ZodPipe(ownerReseatSchema)) body: OwnerReseatInput,
  ): Promise<{ ok: true; orgId: string; userId: string; changed: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const reseat = await this.orgs.operatorOwnerReseat(tx, orgId, body.retiredUserId);
      if (reseat.changed) {
        const payload = { reason: body.reason, via: OPS_VIA, retiredUserId: body.retiredUserId, userId: reseat.userId };
        for (const projectId of reseat.projectIds.length ? reseat.projectIds : [null]) {
          await recordAudit(tx, {
            projectId,
            actor: systemActor(body.operator, body.operator, 'operator'),
            action: 'org.ownerReseated',
            entity: 'Org',
            entityId: orgId,
            payload,
          });
        }
        // the person's own security trail names the grant, as the retirement that preceded it is named there
        await tx.securityAuditEvent.create({
          data: {
            action: 'auth.operator_owner_reseat',
            targetUserId: reseat.userId,
            actorUserId: null,
            actorKind: 'operator',
            correlationId: randomUUID(),
            payload: { orgId, retiredUserId: body.retiredUserId, operator: body.operator, reason: body.reason, via: OPS_VIA },
          },
        });
      }
      return reseat;
    });
    return { ok: true, orgId, userId: result.userId, changed: result.changed };
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
