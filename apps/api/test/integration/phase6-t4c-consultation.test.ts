import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Phase 6 unit 4c-i — the DARK consultation migration, probed at the DATABASE.
 *
 * There is no caller, no contract and no route in this unit, so every arm below writes SQL
 * directly. That is the point rather than a limitation: these two tables are APPEND-ONLY, a
 * forgery that lands is permanent, and there is no later act to catch it. A seal that only the
 * service path exercises is a seal that has never been tested against the writer it exists to
 * refuse.
 *
 * **No invariant this migration installs is probed later than the PR that installs it** (plan §D,
 * review round 2). A DB invariant whose first probe waits for 4c-ii can merge wrong and become
 * immutable history before anything detects it.
 *
 * Two arms deliberately do NOT live here, and saying so is part of the evidence:
 *
 *  - the `DecisionApprovalRevision.sourceCommandId` ENFORCEMENT arm (a direct revision insert
 *    against a live `pending` decision, refused). 4c-i adds that column NULLABLE and enforces
 *    nothing — `DecisionsService.approve` writes no receipt and the previous release must keep
 *    running against this schema — so there is nothing here to make red. What 4c-i CAN prove is
 *    the compatibility direction, and it does (`a previous-release approval still succeeds`), plus
 *    the register's TRUNCATE seal, which is 4c-i's own. The refusal arm lands in 4c-ii with the
 *    trigger that performs it.
 *  - the SERVICE-level 409s and the push/projection effects. Those are 4c-ii's, red-anchored
 *    against a base that already carries this migration.
 */
describe('Phase 6 unit 4c-i — consultation, deployed dark (live PG)', () => {
  let db: PrismaClient;
  /** A second connection, for the genuine two-session overlaps. Never used for setup. */
  let other: PrismaClient;

  let orgId: string;
  let projectId: string;
  let otherProjectId: string;
  let pmcUserId: string;
  let consulteeUserId: string;
  let consulteeMembershipId: string;
  let strangerUserId: string;
  let strangerMembershipId: string;
  let otherProjectUserId: string;
  let otherProjectMembershipId: string;

  let seq = 0;
  /** Run-scoped: these ids appear in APPEND-ONLY tables, so a collision with a previous run's
   *  leftovers would fail a probe for a reason that has nothing to do with the seal under test. */
  let runToken = '';
  const nextId = (label: string): string => `it-t4c-${label}-${runToken}-${seq++}`;

  const url = process.env.DATABASE_URL;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    other = new PrismaClient({ datasources: { db: { url } } });
    await Promise.all([db.$connect(), other.$connect()]);

    const run = randomUUID().slice(0, 8);
    runToken = run;
    orgId = `it-t4c-org-${run}`;
    projectId = `it-t4c-project-${run}`;
    otherProjectId = `it-t4c-other-${run}`;
    await db.org.create({ data: { id: orgId, name: `T4C Org ${run}`, slug: orgId } });
    for (const [id, short] of [[projectId, 'T4C'], [otherProjectId, 'T4CO']] as const) {
      await db.project.create({
        data: {
          id, orgId, name: `T4C ${short} ${run}`, short, descriptor: '', stage: 'Planning',
          siteCode: `${short}${run}`.slice(0, 8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
          elapsedPct: 0, todayDay: 0, milestonePct: 0,
        },
      });
    }

    const member = async (project: string, suffix: string, role: string): Promise<[string, string]> => {
      const userId = `it-t4c-user-${suffix}-${run}`;
      await db.user.create({
        data: { id: userId, projectId: project, role, name: `T4C ${suffix}`, email: `${suffix}-${run}@t4c.test` },
      });
      const m = await db.membership.create({ data: { projectId: project, userId, role, status: 'active' } });
      return [userId, m.id];
    };

    [pmcUserId] = await member(projectId, 'pmc', 'pmc');
    // the decisions seeded below are `client`-held, and the delivered 4b publication seal refuses
    // to birth a published decision no active holder can decide
    await member(projectId, 'client', 'client');
    await member(otherProjectId, 'farclient', 'client');
    [consulteeUserId, consulteeMembershipId] = await member(projectId, 'consultee', 'engineer');
    [strangerUserId, strangerMembershipId] = await member(projectId, 'stranger', 'engineer');
    [otherProjectUserId, otherProjectMembershipId] = await member(otherProjectId, 'far', 'pmc');
  });

  afterAll(async () => {
    await cleanupConsultations();
    await cleanupDecisions();
    await db?.commandExecution.deleteMany({ where: { organizationId: orgId } });
    await db?.membership.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
    await db?.user.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
    await db?.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await db?.org.deleteMany({ where: { id: orgId } });
    await Promise.all([db?.$disconnect(), other?.$disconnect()]);
  });

  afterEach(async () => {
    await cleanupConsultations();
    await cleanupDecisions();
    await db.projectCapability.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
    await db.project.updateMany({
      where: { id: { in: [projectId, otherProjectId] } },
      data: { archivedAt: null },
    });
  });

  /** The consultation tables are append-only by trigger; a test teardown is the sanctioned reset
   *  shape — disable the named seals for exactly this wipe, in ONE transaction so a throw rolls
   *  the disable back with it. */
  const cleanupConsultations = async (): Promise<void> => {
    if (!db) return;
    const toggle = (action: 'DISABLE' | 'ENABLE'): string => `DO $do$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionConsultationResponse_t4c_append_only') THEN
        ALTER TABLE "DecisionConsultationResponse" ${action} TRIGGER "DecisionConsultationResponse_t4c_append_only";
      END IF;
      IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionConsultation_t4c_append_only') THEN
        ALTER TABLE "DecisionConsultation" ${action} TRIGGER "DecisionConsultation_t4c_append_only";
      END IF;
    END $do$`;
    await db.$transaction([
      db.$executeRawUnsafe(toggle('DISABLE')),
      db.decisionConsultationResponse.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }),
      db.decisionConsultation.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }),
      db.$executeRawUnsafe(toggle('ENABLE')),
    ]);
  };

  const cleanupDecisions = async (): Promise<void> => {
    if (!db) return;
    const names = [
      ['Decision', 'Decision_t4a_d_no_delete'],
      ['Decision', 'Decision_t4b_evidence_no_delete'],
      ['Decision', 'Decision_t4b2_record_no_delete'],
      ['DecisionOption', 'DecisionOption_t4a_frozen'],
      ['DecisionApprovalRevision', 'DecisionApprovalRevision_append_only'],
    ] as const;
    const toggle = (action: 'DISABLE' | 'ENABLE'): string => `DO $do$ BEGIN ${names
      .map(([table, trigger]) => `IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${trigger}') THEN ALTER TABLE "${table}" ${action} TRIGGER "${trigger}"; END IF;`)
      .join(' ')} END $do$`;
    const where = { decision: { projectId: { in: [projectId, otherProjectId] } } };
    await db.$transaction([
      db.$executeRawUnsafe(toggle('DISABLE')),
      db.decisionApprovalRevision.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }),
      db.decisionEvent.deleteMany({ where }),
      db.decisionOption.deleteMany({ where }),
      db.decision.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }),
      db.$executeRawUnsafe(toggle('ENABLE')),
    ]);
  };

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────

  interface SeededDecision { id: string; optionIds: string[] }

  const seedDecision = async (
    over: { project?: string; status?: string; published?: boolean } = {},
  ): Promise<SeededDecision> => {
    const project = over.project ?? projectId;
    const id = nextId('decision');
    const optionIds = [nextId('opt'), nextId('opt')];
    // published in the SAME transaction as its options: the delivered deferred option floor
    // refuses a published-and-optionless birth.
    await db.$transaction(async (tx) => {
      await tx.decision.create({
        data: {
          id, projectId: project, title: `Consultation subject ${id}`, room: 'Office',
          status: over.status ?? 'pending', ageDays: 0, photoSwatch: 'blue',
          authorId: project === projectId ? pmcUserId : otherProjectUserId,
          publishedAt: null, deciderKind: 'client',
          options: {
            create: [
              { id: optionIds[0], label: 'Option A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw-a', order: 0 },
              { id: optionIds[1], label: 'Option B', optionKey: 'b', material: 'Walnut', delta: 100, swatch: 'sw-b', order: 1 },
            ],
          },
        },
      });
      if (over.published !== false) {
        await tx.decision.update({ where: { id }, data: { publishedAt: new Date() } });
      }
    });
    return { id, optionIds };
  };

  /** A `recorded` decision, born terminal: `deciderKind = 'none'`, no options, no swatch. */
  const seedRecord = async (): Promise<SeededDecision> => {
    const id = nextId('record');
    await db.$executeRawUnsafe(
      `INSERT INTO "Decision" ("id","projectId","title","room","status","ageDays","photoSwatch",
         "authorId","publishedAt","deciderKind")
       VALUES ($1,$2,$3,'Office','recorded'::"DecisionStatus",0,NULL,$4,now(),'none'::"DeciderKind")`,
      id, projectId, `Recorded elsewhere ${id}`, pmcUserId,
    );
    return { id, optionIds: [] };
  };

  /** Append one approval revision — the cycle evidence `openCycle` is counted against. */
  const advanceCycle = async (decision: SeededDecision, version: number): Promise<void> => {
    await db.decisionApprovalRevision.create({
      data: {
        id: nextId('rev'), projectId, decisionId: decision.id, version, optionKey: 'a',
        approvedAt: new Date(), approvedById: pmcUserId,
      },
    });
  };

  const currentCycle = async (decisionId: string): Promise<number> =>
    db.decisionApprovalRevision.count({ where: { decisionId } });

  /**
   * The delivered `executeCommand` shape, reproduced exactly: RESERVE the receipt, RUN the
   * mutation, then COMPLETE the receipt with its `resultRef` — all in ONE transaction. Both
   * provenance arms are written against this shape, so a probe that departs from it is departing
   * deliberately and says which arm it is testing.
   */
  const commandPath = async <T>(
    opts: {
      commandType: string;
      actorId: string;
      resultRef: string;
      project?: string | null;
      complete?: 'succeeded' | 'failed' | 'leave-reserved';
      client?: PrismaClient;
    },
    run: (tx: Prisma.TransactionClient, commandId: string) => Promise<T>,
  ): Promise<T> => {
    const client = opts.client ?? db;
    const commandId = nextId('cmd');
    return client.$transaction(async (tx) => {
      await tx.commandExecution.create({
        data: {
          id: commandId, scopeKind: 'project', organizationId: orgId,
          projectId: opts.project === undefined ? projectId : opts.project,
          actorId: opts.actorId, commandType: opts.commandType,
          idempotencyKey: commandId, requestHash: commandId, status: 'reserved',
        },
      });
      const out = await run(tx, commandId);
      if (opts.complete !== 'leave-reserved') {
        await tx.commandExecution.update({
          where: { id: commandId },
          data: {
            status: opts.complete ?? 'succeeded',
            resultRef: opts.resultRef,
            completedAt: new Date(),
          },
        });
      }
      return out;
    });
  };

  type ConsultationOverrides = Partial<{
    id: string; projectId: string; decisionId: string; requestedById: string;
    consulteeMembershipId: string; consulteeUserId: string; openCycle: number;
    question: string | null; sourceCommandId: string;
  }>;

  /** Insert a consultation through the command shape, with any field overridden for a hostile
   *  arm. Returns the row id so the caller can assert on it. */
  const requestConsultation = async (
    decision: SeededDecision,
    over: ConsultationOverrides = {},
    commandOver: Partial<{ commandType: string; actorId: string; resultRef: string; project: string | null; complete: 'succeeded' | 'failed' | 'leave-reserved' }> = {},
  ): Promise<string> => {
    const id = over.id ?? nextId('consultation');
    await commandPath(
      {
        commandType: commandOver.commandType ?? 'consultations.request',
        actorId: commandOver.actorId ?? over.requestedById ?? pmcUserId,
        resultRef: commandOver.resultRef ?? id,
        project: commandOver.project,
        complete: commandOver.complete,
      },
      async (tx, commandId) => {
        const cycle = over.openCycle ?? (await currentCycle(over.decisionId ?? decision.id));
        await tx.$executeRaw`
          INSERT INTO "DecisionConsultation"
            ("id", "projectId", "decisionId", "requestedById", "consulteeMembershipId",
             "consulteeUserId", "openCycle", "question", "requestedAt", "sourceCommandId")
          VALUES (${id}, ${over.projectId ?? projectId}, ${over.decisionId ?? decision.id},
                  ${over.requestedById ?? pmcUserId}, ${over.consulteeMembershipId ?? consulteeMembershipId},
                  ${over.consulteeUserId ?? consulteeUserId}, ${cycle},
                  ${over.question === undefined ? 'Which finish holds up in this humidity?' : over.question},
                  ${new Date()}, ${over.sourceCommandId ?? commandId})`;
      },
    );
    return id;
  };

  type ResponseOverrides = Partial<{
    id: string; projectId: string; consultationId: string; decisionId: string;
    respondedById: string; response: string | null; recommendedOptionId: string | null;
    sourceCommandId: string;
  }>;

  const respond = async (
    consultationId: string,
    decision: SeededDecision,
    over: ResponseOverrides = {},
    commandOver: Partial<{ commandType: string; actorId: string; resultRef: string; complete: 'succeeded' | 'failed' | 'leave-reserved' }> = {},
  ): Promise<string> => {
    const id = over.id ?? nextId('response');
    await commandPath(
      {
        commandType: commandOver.commandType ?? 'consultations.respond',
        actorId: commandOver.actorId ?? over.respondedById ?? consulteeUserId,
        resultRef: commandOver.resultRef ?? id,
        complete: commandOver.complete,
      },
      async (tx, commandId) => {
        await tx.$executeRaw`
          INSERT INTO "DecisionConsultationResponse"
            ("id", "projectId", "consultationId", "decisionId", "respondedById", "response",
             "recommendedOptionId", "respondedAt", "sourceCommandId")
          VALUES (${id}, ${over.projectId ?? projectId}, ${over.consultationId ?? consultationId},
                  ${over.decisionId ?? decision.id}, ${over.respondedById ?? consulteeUserId},
                  ${over.response === undefined ? 'Walnut. The teak cups in this humidity.' : over.response},
                  ${over.recommendedOptionId === undefined ? decision.optionIds[1] : over.recommendedOptionId},
                  ${new Date()}, ${over.sourceCommandId ?? commandId})`;
      },
    );
    return id;
  };

  /** Run `body` with the two INSERT seals off, so an arm can prove a FOREIGN KEY participates
   *  rather than merely that "something refused". Used ONLY by the P27 containment arms, where the
   *  seal's own lookup would fail first and hide which layer did the work. */
  const withInsertSealsOff = async (body: () => Promise<void>): Promise<void> => {
    const toggle = async (action: 'DISABLE' | 'ENABLE'): Promise<void> => {
      // one statement per call: a prepared statement cannot carry two
      await db.$executeRawUnsafe(`ALTER TABLE "DecisionConsultation" ${action} TRIGGER "DecisionConsultation_t4c_insert_seal"`);
      await db.$executeRawUnsafe(`ALTER TABLE "DecisionConsultationResponse" ${action} TRIGGER "DecisionConsultationResponse_t4c_insert_seal"`);
    };
    await toggle('DISABLE');
    try {
      await body();
    } finally {
      await toggle('ENABLE');
    }
  };

  // ═══ PRECISION — the seals accept the shape the command path actually produces ═══════════════
  // A seal that refuses everything is not a seal, it is an outage. Every refusal below is only
  // meaningful because this passes first.

  it('accepts a coherent command-path request and its consultee response', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    const responseId = await respond(consultationId, decision);

    const stored = await db.decisionConsultation.findUnique({
      where: { id: consultationId },
      include: { response: true },
    });
    expect(stored?.consulteeUserId).toBe(consulteeUserId);
    expect(stored?.openCycle).toBe(0);
    expect(stored?.response?.id).toBe(responseId);
    expect(stored?.response?.recommendedOptionId).toBe(decision.optionIds[1]);
  });

  it('accepts a request on a decision reopened by requestChange, in its NEW cycle', async () => {
    // the mirror of the reopened-cycle refusal below: a reopen does not close consultation, it
    // starts a cycle that a NEW consultation may be asked in.
    const decision = await seedDecision();
    await advanceCycle(decision, 1);
    await db.decision.update({ where: { id: decision.id }, data: { status: 'change' } });
    const consultationId = await requestConsultation(decision);
    expect((await db.decisionConsultation.findUnique({ where: { id: consultationId } }))?.openCycle).toBe(1);
    await expect(respond(consultationId, decision)).resolves.toBeTruthy();
  });

  // ═══ P25 — the request eligibility seal ══════════════════════════════════════════════════════

  it('refuses a consultation naming a membership that no longer stands', async () => {
    const decision = await seedDecision();
    await db.membership.update({ where: { id: strangerMembershipId }, data: { status: 'removed' } });
    try {
      await expect(
        requestConsultation(decision, {
          consulteeMembershipId: strangerMembershipId,
          consulteeUserId: strangerUserId,
        }),
      ).rejects.toThrow(/does not currently stand as ACTIVE/);
    } finally {
      await db.membership.update({ where: { id: strangerMembershipId }, data: { status: 'active' } });
    }
    expect(await db.decisionConsultation.count({ where: { projectId } })).toBe(0);
  });

  it('refuses a FORGED audience — a consulteeUserId that is not the membership\'s user', async () => {
    // The canonical audience column is a permanent READ GRANT. It cannot drift (identity is frozen
    // by Membership_t4b_identity_frozen), but a raw writer can forge it, and a forged audience
    // hands a decision to someone nobody consulted.
    const decision = await seedDecision();
    await expect(
      requestConsultation(decision, { consulteeUserId: strangerUserId }),
    ).rejects.toThrow(/is not the user membership .* resolves to/);
    expect(await db.decisionConsultation.count({ where: { projectId } })).toBe(0);
  });

  it('refuses a requester who does not hold decision authority', async () => {
    const decision = await seedDecision();
    await expect(
      requestConsultation(decision, { requestedById: strangerUserId }, { actorId: strangerUserId }),
    ).rejects.toThrow(/CURRENT decision authority/);
  });

  it('refuses a consultation on an UNPUBLISHED draft whose status is pending', async () => {
    // status alone would admit it: an author-private draft is `pending` and has no consultees.
    const decision = await seedDecision({ published: false });
    await expect(requestConsultation(decision)).rejects.toThrow(/is not published/);
  });

  it('refuses a consultation on an APPROVED decision', async () => {
    const decision = await seedDecision();
    await db.decision.update({ where: { id: decision.id }, data: { status: 'approved' } });
    await expect(requestConsultation(decision)).rejects.toThrow(
      /may be requested only while the question is still open/,
    );
  });

  it('refuses a consultation on a WITHDRAWN decision', async () => {
    // The leak this closes: a withdrawn decision's title and reason are pmc-only, so a
    // consultation there would hand the consultee exactly what 4a hides. The withdrawal is written
    // in its delivered shape — the 4a seal refuses a bare status write with no evidence.
    const decision = await seedDecision();
    await db.decision.update({
      where: { id: decision.id },
      data: {
        status: 'withdrawn', withdrawnAt: new Date(), withdrawnById: pmcUserId,
        withdrawnByName: 'T4C pmc', withdrawReason: 'Superseded by a revised brief.',
      },
    });
    await expect(requestConsultation(decision)).rejects.toThrow(
      /may be requested only while the question is still open/,
    );
  });

  it('refuses a consultation on a RECORD', async () => {
    // A record is BORN recorded — "records are born, not laundered" — so this one is seeded, not
    // transitioned. There is nothing left to inform: the decision was taken elsewhere and this is
    // the register's note of it.
    const record = await seedRecord();
    await expect(requestConsultation(record)).rejects.toThrow(
      /may be requested only while the question is still open/,
    );
  });

  it('refuses a frozen openCycle one BELOW the decision\'s current cycle', async () => {
    const decision = await seedDecision();
    await advanceCycle(decision, 1);
    await db.decision.update({ where: { id: decision.id }, data: { status: 'change' } });
    await expect(requestConsultation(decision, { openCycle: 0 })).rejects.toThrow(
      /is not the decision's current cycle/,
    );
  });

  it('refuses a frozen openCycle one ABOVE the decision\'s current cycle', async () => {
    // The one a "compare at response time" design would miss entirely: a command bug storing
    // `current + 1` mints a consultation that is unanswerable NOW and becomes answerable after one
    // approve-and-reopen — the exact revival openCycle exists to prevent, via a legitimate writer.
    const decision = await seedDecision();
    await expect(requestConsultation(decision, { openCycle: 1 })).rejects.toThrow(
      /is not the decision's current cycle/,
    );
  });

  it('refuses a consultation on an ARCHIVED project', async () => {
    const decision = await seedDecision();
    await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    await expect(requestConsultation(decision)).rejects.toThrow(/is archived or absent/);
  });

  // ═══ P25d — the response eligibility seal ════════════════════════════════════════════════════

  it('refuses advice from anyone but the NAMED consultee', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await expect(
      respond(consultationId, decision, { respondedById: strangerUserId }, { actorId: strangerUserId }),
    ).rejects.toThrow(/only the named consultee may answer/);
    expect(await db.decisionConsultationResponse.count({ where: { projectId } })).toBe(0);
  });

  it('refuses advice once the consultee membership has been removed', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await db.membership.update({ where: { id: consulteeMembershipId }, data: { status: 'removed' } });
    try {
      await expect(respond(consultationId, decision)).rejects.toThrow(/no longer stands as ACTIVE/);
    } finally {
      await db.membership.update({ where: { id: consulteeMembershipId }, data: { status: 'active' } });
    }
  });

  it('refuses a LATE response after the decision is withdrawn', async () => {
    // A request made while `pending` outlives the decision. Without this arm a stale response
    // appends evidence — and, in 4c-ii, a push — against a row the consultee must no longer see.
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await db.decision.update({
      where: { id: decision.id },
      data: {
        status: 'withdrawn', withdrawnAt: new Date(), withdrawnById: pmcUserId,
        withdrawnByName: 'T4C pmc', withdrawReason: 'The brief moved on.',
      },
    });
    await expect(respond(consultationId, decision)).rejects.toThrow(/no longer open for consultation/);
  });

  it('refuses a response from a CLOSED cycle after approve-then-reopen', async () => {
    // request (cycle 0) → approve → requestChange returns the decision to `change`. A status-only
    // guard would accept this: the decision is open again. It is open on a DIFFERENT question.
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await advanceCycle(decision, 1);
    await db.decision.update({ where: { id: decision.id }, data: { status: 'change' } });

    await expect(respond(consultationId, decision)).rejects.toThrow(
      /was asked in cycle 0 but the decision is now in cycle 1/,
    );
    expect(await db.decisionConsultationResponse.count({ where: { projectId } })).toBe(0);
  });

  it('refuses a response on an ARCHIVED project', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    await expect(respond(consultationId, decision)).rejects.toThrow(/is archived or absent/);
  });

  // ═══ P27 — every project-scoped composite FK, proven by hostile insert ═══════════════════════
  // These run with the INSERT seals OFF. That is deliberate and it is what makes them worth
  // running: with the seals on, the seal's own lookup fails first and the probe would pass without
  // the FK existing at all — which is exactly how a migration that accidentally created SCALAR
  // foreign keys becomes immutable history.

  it('P27: a consultation cannot pair one project with another project\'s decision', async () => {
    const foreign = await seedDecision({ project: otherProjectId });
    await withInsertSealsOff(async () => {
      await expect(
        requestConsultation(foreign, { decisionId: foreign.id }),
      ).rejects.toThrow(/23503|is not present in table/i);
    });
  });

  it('P27: a consultation cannot name another project\'s consultee membership', async () => {
    const decision = await seedDecision();
    await withInsertSealsOff(async () => {
      await expect(
        requestConsultation(decision, {
          consulteeMembershipId: otherProjectMembershipId,
          consulteeUserId: otherProjectUserId,
        }),
      ).rejects.toThrow(/23503|is not present in table/i);
    });
  });

  it('P27: a response cannot disagree with its consultation\'s project', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await withInsertSealsOff(async () => {
      await expect(
        respond(consultationId, decision, { projectId: otherProjectId }),
      ).rejects.toThrow(/23503|is not present in table/i);
    });
  });

  it('P27: a response cannot attach a consultation to a DIFFERENT same-project decision', async () => {
    // The arm that proves the parent key's THIRD column participates. Every other containment arm
    // passes even if the response→consultation FK omits `decisionId`: the cross-project arm is
    // caught by `projectId`, and the option arm by the same-decision option FK. Only a SAME-PROJECT
    // writer pairing consultation A with decision B — and B's own option, so the option FK is
    // satisfied — reaches it. Without the third column that response is accepted, and a
    // recommendation is permanently attached to a decision nobody was consulted on.
    const decision = await seedDecision();
    const sibling = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await withInsertSealsOff(async () => {
      await expect(
        respond(consultationId, sibling, {
          decisionId: sibling.id,
          recommendedOptionId: sibling.optionIds[0],
        }),
      ).rejects.toThrow(/23503|is not present in table/i);
    });
  });

  it('P27: a response cannot recommend another decision\'s option', async () => {
    // No seal is disabled here: the eligibility seal passes this row, and the `(decisionId, id)`
    // composite FK is the only thing standing between it and a permanent recommendation pointing
    // at an option of some other decision.
    const decision = await seedDecision();
    const sibling = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await expect(
      respond(consultationId, decision, { recommendedOptionId: sibling.optionIds[0] }),
    ).rejects.toThrow(/23503|is not present in table/i);
  });

  // ═══ §C rule-ii — command provenance, on BOTH tables ═════════════════════════════════════════

  it.each([
    ['consultation', 'request'],
    ['response', 'respond'],
  ] as const)('provenance: a %s citing a FABRICATED receipt is refused', async (kind) => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    const fabricated = nextId('ghost');
    const attempt = kind === 'consultation'
      ? requestConsultation(decision, { sourceCommandId: fabricated })
      : respond(consultationId, decision, { sourceCommandId: fabricated });
    await expect(attempt).rejects.toThrow(/does not exist in project/);
  });

  it('provenance: a consultation citing another PROJECT\'s receipt is refused', async () => {
    const decision = await seedDecision();
    // a genuine receipt, reserved and completed in its own project
    const foreignCommandId = nextId('cmd-far');
    await db.$transaction(async (tx) => {
      await tx.commandExecution.create({
        data: {
          id: foreignCommandId, scopeKind: 'project', organizationId: orgId, projectId: otherProjectId,
          actorId: otherProjectUserId, commandType: 'consultations.request',
          idempotencyKey: foreignCommandId, requestHash: foreignCommandId, status: 'reserved',
        },
      });
      await tx.commandExecution.update({
        where: { id: foreignCommandId },
        data: { status: 'succeeded', resultRef: 'something-else', completedAt: new Date() },
      });
    });
    await expect(
      requestConsultation(decision, { sourceCommandId: foreignCommandId }),
    ).rejects.toThrow(/does not exist in project/);
  });

  it('provenance: a receipt already SPENT by another consultation is refused', async () => {
    const decision = await seedDecision();
    const first = await requestConsultation(decision);
    const spent = (await db.decisionConsultation.findUnique({ where: { id: first } }))!.sourceCommandId;
    await expect(
      requestConsultation(decision, { sourceCommandId: spent }),
    ).rejects.toThrow(/only the receipt of the command CURRENTLY executing|23505/i);
  });

  it('provenance: a receipt that is already SUCCEEDED is refused', async () => {
    // Every PAST consultation command is `succeeded`, which is what makes "still reserved" the
    // right test at INSERT: it means the command CURRENTLY EXECUTING, and nothing else.
    const decision = await seedDecision();
    const done = nextId('cmd-done');
    await db.$transaction(async (tx) => {
      await tx.commandExecution.create({
        data: {
          id: done, scopeKind: 'project', organizationId: orgId, projectId,
          actorId: pmcUserId, commandType: 'consultations.request',
          idempotencyKey: done, requestHash: done, status: 'reserved',
        },
      });
      await tx.commandExecution.update({
        where: { id: done }, data: { status: 'succeeded', resultRef: 'unrelated', completedAt: new Date() },
      });
    });
    await expect(
      requestConsultation(decision, { sourceCommandId: done }),
    ).rejects.toThrow(/is succeeded — a consultation may cite only the receipt/);
  });

  it.each([
    ['consultation', 'decisions.approve'],
    ['response', 'consultations.request'],
  ] as const)('provenance: a %s citing a WRONG-TYPE receipt is refused', async (kind, commandType) => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    const attempt = kind === 'consultation'
      ? requestConsultation(decision, {}, { commandType })
      : respond(consultationId, decision, {}, { commandType });
    await expect(attempt).rejects.toThrow(/receipt, not consultations\./);
  });

  it.each([
    ['consultation', 'requester'],
    ['response', 'responder'],
  ] as const)('provenance: a %s whose receipt names a DIFFERENT actor is refused', async (kind) => {
    // Without this arm the receipt constrains project, type, state, reuse and result identity but
    // says nothing about WHO acted. On the response path it is worse: a writer could record the
    // named consultee as the responder while a different actor executed the command — precisely
    // the forgery `respondedById` exists to prevent.
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    const attempt = kind === 'consultation'
      ? requestConsultation(decision, {}, { actorId: strangerUserId })
      : respond(consultationId, decision, {}, { actorId: strangerUserId });
    await expect(attempt).rejects.toThrow(/was executed by .* but the (consultation|response) records/);
  });

  it.each(['consultation', 'response'] as const)(
    'provenance at COMMIT: a %s whose command never succeeds is refused',
    async (kind) => {
      // The arm the INSERT check cannot reach. `executeCommand` reserves, runs, then completes —
      // so a BEFORE INSERT trigger can never see `succeeded`, and a writer that simply never
      // completes its receipt would commit a row with NO event behind it, leaving the projection's
      // active generation classified as caught up while it serves a pre-insert DTO.
      const decision = await seedDecision();
      const consultationId = await requestConsultation(decision);
      const attempt = kind === 'consultation'
        ? requestConsultation(decision, {}, { complete: 'leave-reserved' })
        : respond(consultationId, decision, {}, { complete: 'leave-reserved' });
      await expect(attempt).rejects.toThrow(/which is reserved at commit/);
    },
  );

  it.each(['consultation', 'response'] as const)(
    'provenance at COMMIT: a %s whose command result names another row is refused',
    async (kind) => {
      const decision = await seedDecision();
      const consultationId = await requestConsultation(decision);
      const attempt = kind === 'consultation'
        ? requestConsultation(decision, {}, { resultRef: 'some-other-entity' })
        : respond(consultationId, decision, {}, { resultRef: 'some-other-entity' });
      await expect(attempt).rejects.toThrow(/committed with resultRef some-other-entity/);
    },
  );

  // ═══ P23 — the evidence and uniqueness invariants at the database ════════════════════════════

  it.each([
    ['consultation question', '   \t\n  '],
    ['response text', '  \r\n '],
  ] as const)('refuses a whitespace-only %s', async (which, blank) => {
    const decision = await seedDecision();
    const consultationId = which === 'consultation question'
      ? null
      : await requestConsultation(decision);
    const attempt = which === 'consultation question'
      ? requestConsultation(decision, { question: blank })
      : respond(consultationId!, decision, { response: blank });
    await expect(attempt).rejects.toThrow(/non_blank/);
  });

  it.each([
    ['consultation question'],
    ['response text'],
  ] as const)('refuses a NULL %s', async (which) => {
    // A CHECK over NULL evaluates to UNKNOWN and PASSES, so the btrim guard alone would let a
    // direct insert commit an append-only fact with no evidence text at all. NOT NULL is the arm
    // that closes it, and it is only checkable by writing SQL.
    const decision = await seedDecision();
    const consultationId = which === 'consultation question'
      ? null
      : await requestConsultation(decision);
    const attempt = which === 'consultation question'
      ? requestConsultation(decision, { question: null })
      : respond(consultationId!, decision, { response: null });
    await expect(attempt).rejects.toThrow(/23502|Failing row contains/i);
  });

  it('refuses a SECOND response to one consultation', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await respond(consultationId, decision);
    await expect(respond(consultationId, decision)).rejects.toThrow(
      /23505|Key \("consultationId"\)/i,
    );
    expect(await db.decisionConsultationResponse.count({ where: { consultationId } })).toBe(1);
  });

  // ═══ APPEND-ONLY — update, delete, AND truncate ══════════════════════════════════════════════

  it.each(['DecisionConsultation', 'DecisionConsultationResponse'] as const)(
    '%s refuses UPDATE and DELETE',
    async (table) => {
      const decision = await seedDecision();
      const consultationId = await requestConsultation(decision);
      const responseId = await respond(consultationId, decision);
      const id = table === 'DecisionConsultation' ? consultationId : responseId;
      const column = table === 'DecisionConsultation' ? 'question' : 'response';

      await expect(
        db.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = 'rewritten' WHERE "id" = $1`, id),
      ).rejects.toThrow(/append-only/);
      await expect(
        db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, id),
      ).rejects.toThrow(/append-only/);
    },
  );

  // HOSTILE TRUNCATE PROBES. These issue raw TRUNCATE on purpose and must NEVER be routed through
  // `sanctionedReset` — that helper DISABLES these very seals, which would leave the assertion
  // vacuous while keeping it green. They are registered as probes in
  // `src/platform/module-registry/sanctioned-reset-coverage.test.ts`.

  it('refuses TRUNCATE of the consultation register while a consultation stands', async () => {
    const decision = await seedDecision();
    await requestConsultation(decision);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "DecisionConsultation" CASCADE'),
    ).rejects.toThrow(/would erase the consultation register/);
  });

  it('refuses TRUNCATE of recorded advice while a response stands', async () => {
    const decision = await seedDecision();
    const consultationId = await requestConsultation(decision);
    await respond(consultationId, decision);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "DecisionConsultationResponse"'),
    ).rejects.toThrow(/would erase recorded consultation advice/);
  });

  it('refuses TRUNCATE of the approval register, which is the cycle evidence', async () => {
    // Reached by ERASING the evidence instead of forging it: returning every decision to cycle 0
    // makes the response seal accept a stale cycle-0 consultation in a REOPENED cycle — the exact
    // revival `openCycle` exists to prevent. The register's delivered append-only trigger is
    // ROW-level, and row triggers never fire for TRUNCATE.
    const decision = await seedDecision();
    await advanceCycle(decision, 1);
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "DecisionApprovalRevision" CASCADE'),
    ).rejects.toThrow(/would erase the approval revision register/);
  });

  it.each(['DecisionConsultationResponse', 'DecisionConsultation', 'DecisionApprovalRevision'])(
    'PERMITS truncating %s when it is genuinely empty, WITHOUT the sanctioned bypass',
    async (table) => {
      // The precision half, and it is not optional: a seal that refused unconditionally would be
      // indistinguishable from a broken table, and the whole reset contract rests on these seals
      // being conditional on CONTENT. Note what is NOT done here — `sanctionedReset` is not called.
      // That helper DISABLES these triggers, so routing this through it would assert nothing while
      // staying green.
      //
      // The integration database is shared with every other suite, so "empty" is established
      // inside a transaction and then rolled back: the rows other suites depend on are untouched,
      // and the TRUNCATE is judged by the live trigger exactly as it would be in production.
      const sentinel = new Error('rollback');
      await expect(
        db.$transaction(async (tx) => {
          for (const t of ['DecisionConsultationResponse', 'DecisionConsultation', 'DecisionApprovalRevision']) {
            await tx.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
            await tx.$executeRawUnsafe(`DELETE FROM "${t}"`);
            await tx.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
          }
          await tx.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
          throw sentinel;
        }),
      ).rejects.toBe(sentinel);
    },
  );

  // ═══ THE CAPABILITY RESERVATION ══════════════════════════════════════════════════════════════

  it('refuses ENABLING the reserved `consultation` capability, by INSERT', async () => {
    await expect(
      db.projectCapability.create({
        data: { projectId, capability: 'consultation', enabledById: pmcUserId },
      }),
    ).rejects.toThrow(/`consultation` capability is RESERVED/);
  });

  it('refuses RE-KEYING an existing capability row into `consultation`', async () => {
    // `capability` is a mutable key with no freeze trigger, so an INSERT-only guard would leave
    // `UPDATE … SET "capability" = 'consultation'` wide open — the same gate-open state by another
    // route.
    await db.projectCapability.create({
      data: { projectId, capability: 'materials', enabledById: pmcUserId },
    });
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'consultation' WHERE "projectId" = $1 AND "capability" = 'materials'`,
        projectId,
      ),
    ).rejects.toThrow(/`consultation` capability is RESERVED/);
  });

  it('leaves every OTHER capability name writable during the dark window', async () => {
    // The Board settled this on PR #480: NO CHECK constraint on the column. Restricting an
    // existing free-text column would break the previous release's generic `capability:enable`
    // writer during exactly the window this unit must survive.
    await expect(
      db.projectCapability.create({ data: { projectId, capability: 'labour', enabledById: pmcUserId } }),
    ).resolves.toBeTruthy();
    await expect(
      db.projectCapability.create({ data: { projectId, capability: 'commercial', enabledById: pmcUserId } }),
    ).resolves.toBeTruthy();
  });

  // ═══ PREVIOUS-RELEASE COMPATIBILITY ══════════════════════════════════════════════════════════

  it('a PREVIOUS-RELEASE approval still succeeds against the migrated schema', async () => {
    // 4c-i stages `DecisionApprovalRevision.sourceCommandId` NULLABLE and enforces NOTHING. The
    // delivered `DecisionsService.approve` writes no receipt, and this is the DARK unit the
    // previous release must keep running against: requiring provenance here would reject every
    // approval performed by a still-serving 4b instance — a live workflow broken by a migration
    // whose whole premise is that nothing else changes. The enforcement lands in 4c-ii, after the
    // drain-first cutover.
    const decision = await seedDecision();
    const revision = await db.decisionApprovalRevision.create({
      data: {
        id: nextId('legacy-rev'), projectId, decisionId: decision.id, version: 1, optionKey: 'a',
        approvedAt: new Date(), approvedById: pmcUserId,
      },
    });
    expect(revision.sourceCommandId).toBeNull();
  });

  it('the previous release can still write decisions, options and memberships unchanged', async () => {
    // The dark-window claim in one probe: 4c-i adds tables nothing reads or writes, one nullable
    // column, and a reservation on a capability name that does not yet exist. Everything the
    // running release does must be untouched.
    const decision = await seedDecision();
    await expect(
      db.decision.update({ where: { id: decision.id }, data: { status: 'change' } }),
    ).resolves.toBeTruthy();
    await expect(
      db.membership.update({ where: { id: strangerMembershipId }, data: { role: 'contractor' } }),
    ).resolves.toBeTruthy();
    await db.membership.update({ where: { id: strangerMembershipId }, data: { role: 'engineer' } });
  });
});
