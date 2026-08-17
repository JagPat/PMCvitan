import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SEED_ACTIVITIES,
  SEED_DECISIONS,
  SEED_INSPECTIONS,
  SEED_LOG_MATERIALS,
  SEED_NODES,
  SEED_PHASES,
  STARTER_MODULES,
} from '../../src/domain/seed-data';

const LOCK_KEY = 'vitan-pmc-destructive-seed';
const apiRoot = join(__dirname, '../..');
const prismaBin = join(apiRoot, 'node_modules/.bin/prisma');
const tsxBin = join(apiRoot, 'node_modules/.bin/tsx');

const EXPECTED_NOTIFICATIONS = [
  'Client approved Master Bath CP Fittings — Kohler',
  'New decision issued for approval: Living Room Flooring',
  'Re-inspection due: Waterproofing, Terrace',
];

const EXPECTED_STARTER_MODULES = STARTER_MODULES.map(({ name }) => name).sort();
const SEED_USER_IDENTITIES = [
  { email: { in: ['pmc@vitan.in', 'client@vitan.in', 'contractor@vitan.in', 'test-pmc@vitan.in', 'test-client-b@vitan.in', 'test-eng@vitan.in', 'test-removed@vitan.in'] } },
  { phone: '9876543210' },
];

const SEED_LOCK_COUNT_SQL = `
  SELECT COUNT(*)::int AS c
    FROM pg_locks l
   WHERE l.locktype = 'advisory'
     AND l.granted = $1
     AND l.objsubid = 1
     AND l.pid <> pg_backend_pid()
     AND l.classid::bigint = ((hashtext('${LOCK_KEY}')::bigint >> 32) & 4294967295)
     AND l.objid::bigint   =  (hashtext('${LOCK_KEY}')::bigint       & 4294967295)`;

const TEMPLATE_WAITERS_SQL = `
  SELECT COUNT(*)::int AS c
    FROM pg_locks
   WHERE locktype = 'transactionid'
     AND granted = false`;

type SpawnedSeed = {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

const runCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: apiRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  child.once('error', reject);
  child.once('exit', (code) => resolve({ code, output }));
});

describe('Cloud Agent seed consistency', () => {
  const children = new Set<ChildProcess>();
  let admin: PrismaClient;
  let observer: PrismaClient;
  let blocker: PrismaClient;
  let databaseName: string;
  let databaseUrl: string;
  let releaseTemplateLock: (() => void) | undefined;
  let templateLockTask: Promise<void> | undefined;

  const spawnSeed = (seedIfComplete = true): SpawnedSeed => {
    const child = spawn(tsxBin, ['prisma/seed.ts'], {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        CLOUD_AGENT_SEED_IF_COMPLETE: seedIfComplete ? 'true' : 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let text = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      });
    });
    return { child, output: () => text, exited };
  };

  const countLocks = async (sql: string, granted?: boolean): Promise<number> => {
    const rows = granted === undefined
      ? await observer.$queryRawUnsafe<Array<{ c: number }>>(sql)
      : await observer.$queryRawUnsafe<Array<{ c: number }>>(sql, granted);
    return Number(rows[0]!.c);
  };

  const waitFor = async (label: string, probe: () => Promise<boolean>, seeds: SpawnedSeed[]): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await probe()) return;
      for (const seed of seeds) {
        if (seed.child.exitCode !== null || seed.child.signalCode !== null) {
          throw new Error(`${label}: seed exited before the barrier:\n${seed.output()}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label}: barrier timed out`);
  };

  const holdProjectTemplate = async (): Promise<void> => {
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTemplateLock = resolve;
    });
    templateLockTask = blocker.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "ProjectTemplate" WHERE "name" = 'G+2 Residence' FOR UPDATE`,
      );
      if (rows.length !== 1) throw new Error('expected one G+2 Residence row to lock');
      locked();
      await release;
    }, { timeout: 180_000, maxWait: 10_000 });
    await lockReady;
  };

  const releaseProjectTemplate = async (): Promise<void> => {
    releaseTemplateLock?.();
    await templateLockTask;
    releaseTemplateLock = undefined;
    templateLockTask = undefined;
  };

  const prepareIncompleteFixture = async (): Promise<void> => {
    await observer.activity.delete({ where: { id: 'ACT-31' } });
    expect(await observer.activity.count({ where: { id: 'ACT-31' } })).toBe(0);
  };

  const expectCompleteFixture = async (): Promise<void> => {
    const decisionIds = SEED_DECISIONS.map(({ id }) => id);
    const inspectionIds = SEED_INSPECTIONS.map(({ id }) => id);
    const materialNames = SEED_LOG_MATERIALS.map(({ name }) => name).sort();
    const [
      orgs, projects, users, memberships, orgMemberships, nodes, decisions, decisionOptions,
      changeRequests, phases, activities, inspections, inspectionItems, dailyLogs, crewRows,
      materials, drawings, revisions, media, notifications, modules, templates, auditSentinels,
    ] = await Promise.all([
      observer.org.count({ where: { slug: 'vitan' } }),
      observer.project.findMany({ where: { id: { in: ['ambli', 'test-empty-site'] } }, select: { id: true }, orderBy: { id: 'asc' } }),
      observer.user.count({ where: { OR: SEED_USER_IDENTITIES } }),
      observer.membership.count({ where: { projectId: { in: ['ambli', 'test-empty-site'] }, status: 'active', user: { OR: SEED_USER_IDENTITIES } } }),
      observer.orgMembership.count({ where: { org: { slug: 'vitan' }, user: { OR: SEED_USER_IDENTITIES } } }),
      observer.projectNode.count({ where: { projectId: 'ambli', id: { in: SEED_NODES.map(({ id }) => id) } } }),
      observer.decision.count({ where: { projectId: 'ambli', id: { in: decisionIds } } }),
      observer.decisionOption.count({ where: { decisionId: { in: decisionIds } } }),
      observer.changeRequest.count({ where: { decisionId: 'DL-003', status: 'open' } }),
      observer.phase.count({ where: { projectId: 'ambli', id: { in: SEED_PHASES.map(({ id }) => id) } } }),
      observer.activity.count({ where: { projectId: 'ambli', id: { in: SEED_ACTIVITIES.map(({ id }) => id) } } }),
      observer.inspection.count({ where: { projectId: 'ambli', id: { in: inspectionIds } } }),
      observer.inspectionItem.count({ where: { inspectionId: { in: inspectionIds } } }),
      observer.dailyLog.count({ where: { projectId: 'ambli' } }),
      observer.crewRow.count({ where: { dailyLog: { projectId: 'ambli' } } }),
      observer.siteMaterial.findMany({ where: { projectId: 'ambli', name: { in: materialNames } }, select: { name: true }, orderBy: { name: 'asc' } }),
      observer.drawing.count({ where: { id: 'test-drawing-a', projectId: 'ambli' } }),
      observer.drawingRevision.count({ where: { id: 'test-drawing-a-rev1', drawingId: 'test-drawing-a' } }),
      observer.media.count({ where: { id: 'test-photo-a', projectId: 'ambli' } }),
      observer.notification.findMany({ where: { projectId: 'ambli', text: { in: EXPECTED_NOTIFICATIONS } }, select: { text: true }, orderBy: { text: 'asc' } }),
      observer.templateModule.findMany({ where: { name: { in: EXPECTED_STARTER_MODULES } }, select: { name: true }, orderBy: { name: 'asc' } }),
      observer.projectTemplate.count({ where: { name: 'G+2 Residence' } }),
      observer.auditLog.count({ where: { OR: [{ id: 'cloud-agent-seed-complete' }, { action: 'cloud-agent-seed-complete' }] } }),
    ]);

    expect(orgs).toBe(1);
    expect(projects.map(({ id }) => id)).toEqual(['ambli', 'test-empty-site']);
    expect(users).toBe(8);
    expect(memberships).toBe(9);
    expect(orgMemberships).toBe(8);
    expect(nodes).toBe(SEED_NODES.length);
    expect(decisions).toBe(SEED_DECISIONS.length);
    expect(decisionOptions).toBe(SEED_DECISIONS.reduce((total, decision) => total + decision.options.length, 0));
    expect(changeRequests).toBe(1);
    expect(phases).toBe(SEED_PHASES.length);
    expect(activities).toBe(SEED_ACTIVITIES.length);
    expect(inspections).toBe(SEED_INSPECTIONS.length);
    expect(inspectionItems).toBe(SEED_INSPECTIONS.reduce((total, inspection) => total + inspection.items.length, 0));
    expect(dailyLogs).toBe(1);
    expect(crewRows).toBe(5);
    expect(materials.map(({ name }) => name)).toEqual(materialNames);
    expect(drawings).toBe(1);
    expect(revisions).toBe(1);
    expect(media).toBe(1);
    expect(notifications.map(({ text }) => text)).toEqual(EXPECTED_NOTIFICATIONS);
    expect(modules.map(({ name }) => name)).toEqual(EXPECTED_STARTER_MODULES);
    expect(templates).toBe(1);
    expect(auditSentinels).toBe(0);
  };

  const waitForSeedHoldingTransactionLock = (seed: SpawnedSeed): Promise<void> =>
    waitFor('first seed holds transaction advisory lock', async () => (await countLocks(SEED_LOCK_COUNT_SQL, true)) >= 1, [seed]);

  const waitForSeedAtLateFixtureBarrier = (seed: SpawnedSeed): Promise<void> =>
    waitFor('first seed reaches the locked ProjectTemplate wipe after earlier destructive writes', async () => (await countLocks(TEMPLATE_WAITERS_SQL)) >= 1, [seed]);

  const waitForSecondSeedOnTransactionLock = (first: SpawnedSeed, second: SpawnedSeed): Promise<void> =>
    waitFor('second seed waits on transaction advisory lock', async () => (await countLocks(SEED_LOCK_COUNT_SQL, false)) >= 1, [first, second]);

  beforeAll(async () => {
    const baseDatabaseUrl = process.env.DATABASE_URL;
    if (!baseDatabaseUrl?.includes('test')) {
      throw new Error('Refusing to run integration tests: DATABASE_URL must point at a disposable *test* database');
    }

    databaseName = `pmcvitan_cloud_seed_test_${process.pid}_${Date.now()}`;
    const isolated = new URL(baseDatabaseUrl);
    isolated.pathname = `/${databaseName}`;
    isolated.searchParams.set('schema', 'public');
    databaseUrl = isolated.toString();

    const adminDatabase = new URL(baseDatabaseUrl);
    adminDatabase.pathname = '/postgres';
    adminDatabase.searchParams.delete('schema');
    admin = new PrismaClient({ datasources: { db: { url: adminDatabase.toString() } } });
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);

    const migration = await runCommand(
      prismaBin,
      ['migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { ...process.env, DATABASE_URL: databaseUrl },
    );
    if (migration.code !== 0) throw new Error(`isolated database migration failed:\n${migration.output}`);

    observer = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    blocker = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await Promise.all([observer.$connect(), blocker.$connect()]);
    const initial = spawnSeed(false);
    const result = await initial.exited;
    if (result.code !== 0) throw new Error(`initial seed failed:\n${initial.output()}`);
  }, 180_000);

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL');
    releaseTemplateLock?.();
    await templateLockTask?.catch(() => undefined);
    releaseTemplateLock = undefined;
    templateLockTask = undefined;
  });

  afterAll(async () => {
    await Promise.all([observer?.$disconnect(), blocker?.$disconnect()]);
    if (admin && databaseName) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  }, 180_000);

  it('rebuilds when a non-sentinel fixture table is incomplete', async () => {
    await prepareIncompleteFixture();
    const rebuild = spawnSeed();
    const result = await rebuild.exited;
    expect(result, rebuild.output()).toEqual({ code: 0, signal: null });
    expect(rebuild.output()).not.toContain('Seed fixture already complete; skipping destructive rebuild');
    await expectCompleteFixture();
  }, 180_000);

  it('checks completion under the same lock so overlapping starts rebuild exactly once', async () => {
    await prepareIncompleteFixture();
    await holdProjectTemplate();

    const first = spawnSeed();
    await waitForSeedHoldingTransactionLock(first);
    await waitForSeedAtLateFixtureBarrier(first);
    const second = spawnSeed();
    await waitForSecondSeedOnTransactionLock(first, second);

    await releaseProjectTemplate();
    const [firstExit, secondExit] = await Promise.all([first.exited, second.exited]);
    expect(firstExit, first.output()).toEqual({ code: 0, signal: null });
    expect(secondExit, second.output()).toEqual({ code: 0, signal: null });
    expect(`${first.output()}\n${second.output()}`).toContain('Seed fixture already complete; skipping destructive rebuild');
    await expectCompleteFixture();
  }, 180_000);

  it('rolls back a killed late seed and lets the serialized waiter restore the complete fixture', async () => {
    await prepareIncompleteFixture();
    await holdProjectTemplate();

    const first = spawnSeed();
    await waitForSeedHoldingTransactionLock(first);
    await waitForSeedAtLateFixtureBarrier(first);
    const second = spawnSeed();
    await waitForSecondSeedOnTransactionLock(first, second);

    first.child.kill('SIGKILL');
    const firstExit = await first.exited;
    expect(firstExit.signal).toBe('SIGKILL');
    await releaseProjectTemplate();

    const secondExit = await second.exited;
    expect(secondExit, second.output()).toEqual({ code: 0, signal: null });
    await expectCompleteFixture();
  }, 180_000);
});
