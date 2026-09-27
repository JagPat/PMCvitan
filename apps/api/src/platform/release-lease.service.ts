import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { listConsumers } from './outbox/registry';

/**
 * Phase 6 task 4d unit 4d-ii-a — the `ReleaseLease` STARTUP WRITER (plan §D: "every serving process
 * writes its row at startup with the consumer-catalog version compiled into it … and renews
 * `leaseUntil` on an interval while it serves").
 *
 * One row per serving process, keyed by a fresh instance id: a restarted process is a new instance
 * and takes a new row, and the old row expires where it stands (4d-i's `ReleaseLease_t4d_frozen`
 * refuses DELETE and any move of `leaseUntil` backward, so nothing is ever deleted or shortened).
 * 4d-iii's drain preflight reads the register as in-database evidence: no LIVE lease at a catalog
 * version below the minimum.
 *
 * It is also the SERVING half of 4d-i's witness: `phase6_t4d_ii_installed()` is the declaration
 * (`platform_t4d_ii_writers_installed()`, installed with this writer by
 * `20271226000000_phase6_t4d_ii_release_lease_writer`) AND a lease. So 4d-i's replay audits stand
 * down only on a database a 4d-ii process has actually served from.
 *
 * Both timestamps come from the DATABASE clock (`now()`), never the process clock: the columns are
 * `TIMESTAMP(3)` compared against `CURRENT_TIMESTAMP` by the CHECK and by the preflight, and a
 * renewal computed on a skewed host could move `leaseUntil` backward, which the seal refuses.
 * Renewal takes `GREATEST`, so it only ever extends.
 *
 * Never under `NODE_ENV=test`: the integration suites boot the whole application, and a lease there
 * would be a permanent row in the shared test database that also switches 4d-i's replay audits off.
 * The probes drive {@link writeLease} directly, inside a transaction they roll back.
 */

/** How long one lease lasts without renewal. A stopped process stops looking live after this. */
export const RELEASE_LEASE_TTL_SECONDS = 600;
/** How often a serving process extends its lease; well inside the TTL so one missed pass is harmless. */
export const RELEASE_LEASE_RENEW_MS = 180_000;

/**
 * The consumer-catalog version this build compiles: the highest `catalogVersion` over the registered
 * consumers. Consumer versions only move up (`syncConsumerCatalog` refuses any drift), so the maximum
 * is monotone across releases; 4d-ii-a / A7's durable contract bumps raise it from 2 to 3.
 */
export function compiledCatalogVersion(): number {
  const versions = listConsumers().map((c) => c.catalogVersion);
  if (versions.length === 0) throw new Error('ReleaseLease: no outbox consumer is registered — the lease must be written after the catalog is synced');
  return Math.max(...versions);
}

/** The deployed release this process runs, as the drain evidence names it. */
export function releaseIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const release = [env.SOURCE_COMMIT, env.RELEASE_ID].map((v) => v?.trim()).find((v) => v);
  return release ?? 'unreleased';
}

/** A fresh identity per process start: host, pid and a random suffix. */
export function newInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomUUID()}`;
}

type LeaseDb = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** INSERT one process's lease. Both timestamps from the database clock. */
export async function writeLease(
  db: LeaseDb,
  lease: { instanceId: string; catalogVersion: number; release: string; ttlSeconds?: number },
): Promise<void> {
  const ttl = lease.ttlSeconds ?? RELEASE_LEASE_TTL_SECONDS;
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "ReleaseLease" ("instanceId", "catalogVersion", "release", "startedAt", "leaseUntil")
    VALUES (${lease.instanceId}, ${lease.catalogVersion}, ${lease.release},
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + make_interval(secs => ${ttl}))`);
}

/** Extend a lease; never shortens it (`GREATEST`), which is the only move the seal admits anyway. */
export async function renewLease(db: LeaseDb, instanceId: string, ttlSeconds = RELEASE_LEASE_TTL_SECONDS): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE "ReleaseLease"
       SET "leaseUntil" = GREATEST("leaseUntil", CURRENT_TIMESTAMP + make_interval(secs => ${ttlSeconds}))
     WHERE "instanceId" = ${instanceId}`);
}

@Injectable()
export class ReleaseLeaseService implements OnModuleDestroy {
  private readonly log = new Logger('ReleaseLease');
  private timer: ReturnType<typeof setInterval> | null = null;
  private instanceId: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register this process's lease and start renewing it. Called by the outbox bootstrap AFTER the
   * consumer catalog is synced and the sender gate has passed, so a process refused at boot never
   * claims one. A failed registration ABORTS boot, like a failed catalog sync: a serving process
   * with no lease is invisible to the drain it exists to evidence.
   */
  async register(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || this.instanceId) return;
    const lease = { instanceId: newInstanceId(), catalogVersion: compiledCatalogVersion(), release: releaseIdentity() };
    await writeLease(this.prisma, lease);
    this.instanceId = lease.instanceId;
    this.log.log(`lease ${lease.instanceId} registered for release ${lease.release} at catalog version ${lease.catalogVersion}`);
    this.timer = setInterval(() => {
      void renewLease(this.prisma, lease.instanceId)
        .catch((e) => this.log.warn(`lease renewal failed: ${(e as Error).message}`));
    }, RELEASE_LEASE_RENEW_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    // Nothing is deleted or shortened: the lease expires where it stands and stays as history.
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
