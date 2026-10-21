import { Body, Controller, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Public } from '../../common/roles';
import { Throttle, ThrottleGuard } from '../../common/throttle';
import { ZodPipe } from '../../common/zod.pipe';
import { OrgsParticipant } from '../../orgs/orgs.participant';
import { recordAudit } from '../audit';
import { systemActor } from '../../common/actor';
import { OpsTokenGuard } from './ops-token.guard';
import { OPS_VIA, switchSchema, type SwitchInput } from './ops.controller';

/**
 * #482 operator door — `POST /ops/orgs/:orgId/qa-only` marks a company QA-only ("Rebuild it" on the QA door, 20 Oct
 * 2026), so its QA accounts can be signed in at `POST /auth/ops/qa-sign-in`. The database refuses the mark (409) while
 * the company holds anyone who is not a QA account, and never unmarks it; no route here unmarks. Each mark writes an
 * `org.qaOnly` audit row on every live project of the company (one company-level row when it has none), with the
 * operator, reason and `via: "ops-api"`.
 *
 * Its own controller so the door guard runs BEFORE the rate limiter (Codex P2 on #1020), as `AuthOpsController` does
 * for the QA sign-in: Nest runs a class's guards in the order given, and `OpsController` throttles first, so there
 * thirty unauthenticated calls from one address would spend the limit and lock out the operator behind it. Here a
 * caller without the token is refused (404 closed, 401 wrong token) and never spends the operator's limit; wrong
 * tokens are counted in the guard's own window (429 over it).
 */
@Controller('ops')
@UseGuards(OpsTokenGuard, ThrottleGuard)
@Throttle(30, 60_000)
export class OpsQaController {
  constructor(private readonly prisma: PrismaService, private readonly orgs: OrgsParticipant) {}

  @Public()
  @Post('orgs/:orgId/qa-only')
  @HttpCode(200)
  async markQaOnly(
    @Param('orgId') orgId: string,
    @Body(new ZodPipe(switchSchema)) body: SwitchInput,
  ): Promise<{ ok: true; orgId: string; changed: boolean }> {
    const { changed } = await this.prisma.$transaction(async (tx) => {
      const marked = await this.orgs.markQaOnly(tx, orgId);
      if (!marked.found) throw new NotFoundException('no such company');
      if (marked.changed) {
        // one row on each live project's trail; a company with none still records its mark once, at company level
        for (const projectId of marked.projectIds.length ? marked.projectIds : [null]) {
          await recordAudit(tx, {
            projectId,
            actor: systemActor(body.operator, body.operator, 'operator'),
            action: 'org.qaOnly',
            entity: 'Org',
            entityId: orgId,
            payload: { reason: body.reason, via: OPS_VIA },
          });
        }
      }
      return marked;
    });
    return { ok: true, orgId, changed };
  }
}
