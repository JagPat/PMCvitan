import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { NodesService } from '../../src/nodes/nodes.service';
import { treeLockKey } from '../../src/common/tree-lock';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 task 2 — nested locations, §A probes (P1–P3, P6–P8, P10, P14, P15, P17).
 *
 * The location tree's middle level stops being mandatory: a room may sit under a room
 * (to 5 levels) and an element directly under a zone. §A names four defects that the
 * fixed 3-level map used to mask, and each probe here is one of them:
 *
 *   - the cycle guard ran OUTSIDE the write transaction (P1),
 *   - no depth logic existed anywhere — not the plain create (P10), not the plain
 *     move (P3), not their races (P2, P14),
 *   - `move`/`publish` never enforced the visibility invariant `create` does (P15,
 *     and its race pair P17),
 *   - the tree reads were not project-scoped (P6).
 *
 * REPRODUCE-FIRST, staged per the plan's §D note: the base commit REFUSES the nested
 * fixtures at `requireParentForKind` before any race can reach the guards, so a red
 * there would be the wrong failure. The honest baseline is the intermediate commit
 * that legalizes the nested edges with serialization still absent — these probes are
 * run and SEEN RED there, and the serialization commit turns them green.
 *
 * Determinism: every race rides a held raw-session transaction that takes the project
 * tree advisory lock AND (where useful) a FOR UPDATE on the first operation's target
 * row. At the red baseline the advisory lock is uncontested (the service does not take
 * it yet) and the row lock forces the exact interleaving; after the fix the service's
 * first in-transaction statement blocks on the advisory lock, the interleaving is
 * impossible, and the operations serialize in dispatch order.
 */

type Outcome = { ok: true } | { ok: false; message: string };

describe('phase-6-task-2 — nested locations (§A, live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let nodes: NodesService;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    nodes = t.app.get(NodesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor" CASCADE');
    await f?.cleanup();
    await t?.close();
  });

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  /** Direct row create for fixtures (published unless stated) — probes drive the SERVICE for the act under test. */
  const seed = async (kind: string, parentId: string | null, opts: { draft?: boolean; name?: string } = {}): Promise<string> => {
    const created = await t.prisma.projectNode.create({
      data: {
        projectId: f.projectA.id,
        parentId,
        name: opts.name ?? `${kind}-${seq++}`,
        kind,
        order: seq,
        authorId: f.memberUser.id,
        publishedAt: opts.draft ? null : new Date(),
      },
    });
    return created.id;
  };

  /** Rows of the test's own branch (scoped so one probe's red debris never fails another). */
  const rowsOf = async (ids: string[]): Promise<{ id: string; parentId: string | null; publishedAt: Date | null }[]> =>
    t.prisma.projectNode.findMany({ where: { id: { in: ids } }, select: { id: true, parentId: true, publishedAt: true } });

  const hasCycle = (rows: { id: string; parentId: string | null }[]): boolean => {
    const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
    for (const r of rows) {
      const path = new Set<string>();
      let cur: string | null = r.id;
      while (cur) {
        if (path.has(cur)) return true;
        path.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }
    return false;
  };

  /** Deepest 1-based level among `ids`, measured over the FULL project tree (ancestors included). */
  const deepestLevel = async (ids: string[]): Promise<number> => {
    const all = await t.prisma.projectNode.findMany({ where: { projectId: f.projectA.id }, select: { id: true, parentId: true } });
    const parentOf = new Map(all.map((r) => [r.id, r.parentId]));
    let deepest = 0;
    for (const id of ids) {
      let depth = 0;
      const seen = new Set<string>();
      let cur: string | null = id;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        depth += 1;
        cur = parentOf.get(cur) ?? null;
      }
      deepest = Math.max(deepest, depth);
    }
    return deepest;
  };

  /** True when some PUBLISHED row in `ids` has a DRAFT ancestor (the orphan §A forbids). */
  const publishedUnderDraft = async (ids: string[]): Promise<boolean> => {
    const all = await t.prisma.projectNode.findMany({ where: { projectId: f.projectA.id }, select: { id: true, parentId: true, publishedAt: true } });
    const byId = new Map(all.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row?.publishedAt) continue;
      const seen = new Set<string>();
      let cur = row.parentId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const parent = byId.get(cur);
        if (!parent) break;
        if (!parent.publishedAt) return true;
        cur = parent.parentId;
      }
    }
    return false;
  };

  const capture = (p: Promise<unknown>): Promise<Outcome> =>
    p.then(() => ({ ok: true as const })).catch((e: { message?: string }) => ({ ok: false as const, message: String(e?.message ?? e) }));

  const refusal = async (p: Promise<unknown>): Promise<string> => {
    const outcome = await capture(p);
    if (outcome.ok) throw new Error('expected the write to be REFUSED, and it was accepted');
    return outcome.message;
  };

  const ungrantedLocks = async (): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
    return rows[0]?.n ?? 0;
  };

  /** Wait (condition-based, never a fixed sleep) until `p` settles or a NEW ungranted lock appears. */
  const blockedOrSettled = async (p: Promise<Outcome>, baseline: number): Promise<void> => {
    const settled = { done: false };
    void p.finally(() => { settled.done = true; });
    const deadline = Date.now() + 8000;
    for (;;) {
      if (settled.done) return;
      if ((await ungrantedLocks()) > baseline) return;
      if (Date.now() > deadline) throw new Error('neither blocked nor settled within 8s — the harness lost the race shape');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /**
   * The deterministic pair harness. A held raw-session transaction takes the tree
   * advisory lock and (optionally) FOR UPDATE on `holdRowId`. `first` is dispatched
   * and awaited to blocked-or-settled, then `second` the same, then the holder
   * releases and both outcomes are returned.
   */
  const runPair = async (
    holdRowId: string | null,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ): Promise<[Outcome, Outcome]> => {
    const other = new PrismaClient();
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const heldArrived = new Promise<void>((resolve) => { held = resolve; });
      const holder = other.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', treeLockKey(f.projectA.id));
        if (holdRowId) await tx.$queryRawUnsafe('SELECT id FROM "ProjectNode" WHERE id = $1 FOR UPDATE', holdRowId);
        held();
        await released;
      }, { timeout: 30_000 });
      await heldArrived;

      const baseline1 = await ungrantedLocks();
      const p1 = capture(first());
      await blockedOrSettled(p1, baseline1);
      const baseline2 = await ungrantedLocks();
      const p2 = capture(second());
      await blockedOrSettled(p2, baseline2);

      release();
      await holder;
      return [await p1, await p2];
    } finally {
      await other.$disconnect();
    }
  };

  // ── P7 / P8 — the decision's two new legal shapes, through the endpoint ────────────────────

  it('P7 — an element created directly under a zone is accepted', async () => {
    const zone = await seed('zone', null);
    await nodes.create(f.projectA.id, { name: 'Site Gate', kind: 'element', parentId: zone, publish: true }, pmc());
    const gate = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Site Gate' } });
    expect(gate.kind).toBe('element');
    expect(gate.parentId).toBe(zone);
  });

  it('P8 — a room created under another room is accepted', async () => {
    const zone = await seed('zone', null);
    const wing = await seed('room', zone);
    await nodes.create(f.projectA.id, { name: 'Pour 2', kind: 'room', parentId: wing, publish: true }, pmc());
    const pour = await t.prisma.projectNode.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Pour 2' } });
    expect(pour.kind).toBe('room');
    expect(pour.parentId).toBe(wing);
  });

  it('an element stays a LEAF — nothing may sit under it', async () => {
    const zone = await seed('zone', null);
    const door = await seed('element', zone);
    const message = await refusal(
      nodes.create(f.projectA.id, { name: 'Sub', kind: 'element', parentId: door, publish: true }, pmc()),
    );
    expect(message).toMatch(/must sit under/i);
  });

  // ── P10 — the PLAIN depth refusal (before the race; a green race over a missing plain check is a hole) ──

  it('P10 — a plain create under a node already at level 5 is refused, with the depth stated', async () => {
    const z = await seed('zone', null);
    const r1 = await seed('room', z);
    const r2 = await seed('room', r1);
    const r3 = await seed('room', r2);
    const r4 = await seed('room', r3); // level 5
    const message = await refusal(
      nodes.create(f.projectA.id, { name: 'Too Deep', kind: 'room', parentId: r4, publish: true }, pmc()),
    );
    expect(message).toMatch(/level|5 levels/i);
  });

  // ── P3 — the plain move counts the SUBTREE's height, not the moved node alone ────────────────

  it('P3 — moving a 3-deep subtree under a 3-deep chain is refused, with the depth stated', async () => {
    const zDest = await seed('zone', null);
    const ra = await seed('room', zDest);
    const rb = await seed('room', ra); // destination at level 3
    const zSrc = await seed('zone', null);
    const s1 = await seed('room', zSrc);
    const s2 = await seed('room', s1);
    const s3 = await seed('room', s2); // subtree s1>s2>s3, height 3
    void s3;
    const message = await refusal(nodes.move(f.projectA.id, s1, { parentId: rb }, pmc()));
    expect(message).toMatch(/level|5 levels/i);
    const after = await rowsOf([s1]);
    expect(after[0]!.parentId).toBe(zSrc); // the refused move changed nothing
  });

  // ── P15 — the visibility invariant holds for move (create already refuses it) ────────────────

  it('P15 — moving a PUBLISHED subtree under a DRAFT zone is refused', async () => {
    const zPub = await seed('zone', null);
    const room = await seed('room', zPub); // published
    const zDraft = await seed('zone', null, { draft: true });
    const message = await refusal(nodes.move(f.projectA.id, room, { parentId: zDraft }, pmc()));
    expect(message).toMatch(/draft|publish/i);
    const after = await rowsOf([room]);
    expect(after[0]!.parentId).toBe(zPub);
  });

  // ── P1 — concurrent move(A under B) ∥ move(B under A): exactly one commits, no cycle ─────────

  for (const ordering of ['A-under-B first', 'B-under-A first'] as const) {
    it(`P1 — the cycle pair serializes (${ordering})`, async () => {
      const z = await seed('zone', null);
      const a = await seed('room', z);
      const b = await seed('room', z);
      const moveAB = () => nodes.move(f.projectA.id, a, { parentId: b }, pmc());
      const moveBA = () => nodes.move(f.projectA.id, b, { parentId: a }, pmc());
      const [first, second, holdRow] = ordering === 'A-under-B first' ? [moveAB, moveBA, a] : [moveBA, moveAB, b];
      const [o1, o2] = await runPair(holdRow, first, second);
      const rows = await rowsOf([a, b]);
      expect(hasCycle(rows), `A.parent=${rows.find((r) => r.id === a)?.parentId} B.parent=${rows.find((r) => r.id === b)?.parentId} (${JSON.stringify([o1, o2])}) — both moves committed and the tree loops`).toBe(false);
    });
  }

  // ── P2 — concurrent create-under-P ∥ move(P to depth 4): the tree never exceeds 5 levels ─────

  for (const ordering of ['move first', 'create first'] as const) {
    it(`P2 — create ∥ move never exceeds 5 levels (${ordering})`, async () => {
      const z = await seed('zone', null);
      const ra = await seed('room', z);
      const rb = await seed('room', ra);
      const rc = await seed('room', rb); // destination at level 4
      const p = await seed('room', z, { name: `p2-target-${seq++}` }); // level 2, height 1
      const childName = `p2-child-${seq++}`;
      const create = () => nodes.create(f.projectA.id, { name: childName, kind: 'room', parentId: p, publish: true }, pmc());
      const move = () => nodes.move(f.projectA.id, p, { parentId: rc }, pmc());
      const [o1, o2] = ordering === 'move first'
        ? await runPair(p, move, create)
        : await runPair(null, create, move);
      const child = await t.prisma.projectNode.findFirst({ where: { projectId: f.projectA.id, name: childName }, select: { id: true } });
      const level = await deepestLevel([p, ...(child ? [child.id] : [])]);
      expect(level, `deepest level ${level} (${JSON.stringify([o1, o2])}) — the cap is a property of the tree, and it broke`).toBeLessThanOrEqual(5);
    });
  }

  // ── P14 — move ∥ move: the same stale-depth interleaving with no create involved ─────────────

  for (const ordering of ['leaf move first', 'parent move first'] as const) {
    it(`P14 — move ∥ move never exceeds 5 levels (${ordering})`, async () => {
      const z = await seed('zone', null);
      const da = await seed('room', z);
      const db = await seed('room', da);
      const dc = await seed('room', db); // destination chain at level 4
      const p = await seed('room', z); // level 2
      const c = await seed('room', z); // level 2, will move under p
      const moveLeaf = () => nodes.move(f.projectA.id, c, { parentId: p }, pmc());
      const moveParent = () => nodes.move(f.projectA.id, p, { parentId: dc }, pmc());
      const [first, second, holdRow] = ordering === 'leaf move first' ? [moveLeaf, moveParent, c] : [moveParent, moveLeaf, p];
      const [o1, o2] = await runPair(holdRow, first, second);
      const level = await deepestLevel([p, c]);
      expect(level, `deepest level ${level} (${JSON.stringify([o1, o2])})`).toBeLessThanOrEqual(5);
    });
  }

  // ── P17 — publish ∥ move: the visibility rule survives its race, not only its sequential checks ──

  for (const ordering of ['publish first', 'move first'] as const) {
    it(`P17 — publish ∥ move leaves no published node beneath a draft ancestor (${ordering})`, async () => {
      const z = await seed('zone', null);
      const c = await seed('room', z, { draft: true });
      const d = await seed('zone', null, { draft: true });
      const publish = () => nodes.publish(f.projectA.id, c, pmc());
      const move = () => nodes.move(f.projectA.id, c, { parentId: d }, pmc());
      const [first, second] = ordering === 'publish first' ? [publish, move] : [move, publish];
      const [o1, o2] = await runPair(c, first, second);
      expect(
        await publishedUnderDraft([z, c, d]),
        `a published node sits beneath a draft ancestor (${JSON.stringify([o1, o2])}) — the orphan §A forbids`,
      ).toBe(false);
    });
  }

  // ── P6 — the tree reads are PROJECT-SCOPED (the unscoped findMany loaded every project's rows) ──

  it('P6 — the service tree read carries the projectId filter', async () => {
    const sentinel = new Error('captured');
    const captured: { where?: { projectId?: string } }[] = [];
    const nodeRow = { id: 'n1', projectId: 'p1', parentId: null, name: 'Z', kind: 'zone', order: 0, publishedAt: new Date(), authorId: 'u1', createdAt: new Date() };
    const stub: Record<string, unknown> = {
      user: { findUnique: async () => ({ name: 'probe' }) },
      projectNode: {
        findUnique: async () => nodeRow,
        findMany: async (args: { where?: { projectId?: string } }) => {
          captured.push(args ?? {});
          throw sentinel;
        },
      },
      $executeRaw: async () => 0,
      $queryRaw: async () => [],
    };
    (stub as { $transaction?: unknown }).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(stub);
    const bare = new NodesService(
      stub as never, null as never, null as never, null as never,
      null as never, null as never, null as never, null as never,
    );
    const outcome = await capture(bare.publish('p1', 'n1', { sub: 'u1', role: 'pmc', projectId: 'p1' } as AuthUser));
    expect(outcome.ok).toBe(false); // the sentinel stopped the write after the first tree read
    expect(captured.length).toBeGreaterThan(0);
    expect(
      captured[0]?.where?.projectId,
      `the first tree read's args were ${JSON.stringify(captured[0])} — an unscoped read loads every project's rows on a path nesting makes hotter`,
    ).toBe('p1');
  });
});
