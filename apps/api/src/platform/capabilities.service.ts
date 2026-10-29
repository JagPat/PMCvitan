import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Phase 3 Task 1 — project-scoped capability activation (plan §D).
 *
 * A Phase-3 surface exists for a project ONLY when its `ProjectCapability` row exists. The
 * gate REFUSES with 404 — to a non-pilot project the feature does not exist: no route, no
 * navigation, no event, no behavioral difference from today (the two-projects-one-org
 * inertness proof pins this byte-for-byte). Enabling is an attributable operator/administrator
 * action (`capability:enable` CLI) recorded with identity — never a deploy-wide default.
 */
export const MATERIALS_CAPABILITY = 'materials';
// Phase 4 Task 1 — the labour pilot capability (plan §D). Same mechanism as materials: a
// per-project `ProjectCapability` row (enabled by the SAME `capability:enable` CLI), gating the
// labour surface. A `type='labour'` requirement asserts THIS capability; a non-pilot project is
// byte-for-byte unchanged (no labour route, no labour rows, the Team gate stays the stored stub).
export const LABOUR_CAPABILITY = 'labour';
// Phase 5 Task 1 — the commercial pilot capability (plan §L). Same mechanism again, with ONE
// difference that is the whole point of §L: enabling `commercial` is NOT a no-op on a project
// that already holds live purchase orders. See `CommercialActivationService`.
export const COMMERCIAL_CAPABILITY = 'commercial';

/** Phase 6 unit 4c-ii (§D) — the CONSULTATION pilot gate. Read by the two write commands, by the
 *  emitter, and by the CLIENT through the shell's `capabilities` — all three, deliberately: a
 *  gate on the server alone would leave the upgraded bundle rendering request/respond controls
 *  during the whole window in which every project is still gate-off, and controls whose every
 *  request 404s are a visibly broken state, not a byte-identical inert one. All three reads
 *  retire together in 4c-iv. Until 4c-iii the capability is RESERVED at the database — the
 *  4c-i migration refuses any row naming it — so this constant is the name of a gate that
 *  cannot yet be opened. */
export const CONSULTATION_CAPABILITY = 'consultation';

/** Stage 1 redesign (Rev 3.1, #482) — the per-project HOME AND NAVIGATION switch. Unlike the pilot
 *  capabilities above it gates no route, write, job or notification: the shell reports it and the web
 *  shows the redesigned bar and Dashboard only where it is on. Off (no row) is today's app exactly.
 *  Because it is presentation only, it is the one capability an operator may also turn OFF
 *  (`capability:disable`) — the server-side rollback the Board asked for instead of a web revert. */
export const HOME_NAV_CAPABILITY = 'home-nav';

/** #1177 VT2 — the per-project VOICE NOTE TO TEXT switch (AI item 1). Off (no row), every transcript route answers not
 *  found and nothing is written; text already stored stays stored, unshown, and returns if the switch comes back on.
 *  Each write asks it again under the project's row lock, which turning it off also takes first, so no write lands
 *  after it is off. The step that sends a note to the provider (VT2-C2, not yet built) will hold the same switch
 *  across its one exchange, so that off also stops every exchange in flight (#1229); until then nothing sends a
 *  note anywhere. Nothing else depends on it, so it may be turned off as freely as `home-nav` (#1177 H5). */
export const VOICE_TEXT_CAPABILITY = 'voice-text';

/** The capabilities `capability:disable` accepts. Each must be one whose OFF strands nothing: no queued work or
 *  command depends on it being on (`voice-text` keeps its stored text, unshown, for when it is back on). A pilot hub never belongs here —
 *  turning `materials`, `labour` or `commercial` off under live records would strand them. */
export const SWITCHABLE_CAPABILITIES: readonly string[] = [HOME_NAV_CAPABILITY, VOICE_TEXT_CAPABILITY];

@Injectable()
export class CapabilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client to read the capability under the caller's lock (Task 6: the
   *  start command evaluates material coverage in-tx and needs the gate on the same client). */
  async isEnabled(projectId: string, capability: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const db = tx ?? this.prisma;
    const row = await db.projectCapability.findUnique({
      where: { projectId_capability: { projectId, capability } },
      select: { projectId: true },
    });
    return row !== null;
  }

  /** Route/service gate: behave as if the feature does not exist for a non-pilot project. */
  async assertEnabled(projectId: string, capability: string): Promise<void> {
    if (!(await this.isEnabled(projectId, capability))) throw new NotFoundException('Not found');
  }

  /** Idempotently enable a capability for ONE project, attributably. */
  async enable(projectId: string, capability: string, enabledById: string): Promise<void> {
    await this.prisma.projectCapability.upsert({
      where: { projectId_capability: { projectId, capability } },
      create: { projectId, capability, enabledById },
      update: {},
    });
  }
}
