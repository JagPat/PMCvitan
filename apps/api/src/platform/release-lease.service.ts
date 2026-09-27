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
 * A LEASE THAT LAPSES FENCES ITS PROCESS (#646's review, finding 4114736200). The drain reads
 * "no live lease below the minimum" as "no such process serves". So a process whose lease has run
 * out must not be serving: if it cannot renew (the database unreachable, a stalled loop), it stops
 * itself BEFORE the lease can expire. The deadline is kept on the process's MONOTONIC clock from
 * the moment each successful write or renewal was SENT, which is never later than the database's
 * `CURRENT_TIMESTAMP` for that statement, so the local deadline always falls inside the database's
 * lease, with {@link RELEASE_LEASE_FENCE_MARGIN_MS} to spare. And a renewal never REVIVES a lease
 * that has already lapsed on the database clock: it matches only a live row, and zero rows fences
 * the process too. The container then starts a new process, which is a new instance with a new
 * lease.
 *
 * Never under `NODE_ENV=test`: the integration suites boot the whole application, and a lease there
 * would be a permanent row in the shared test database that also switches 4d-i's replay audits off.
 * The probes drive {@link writeLease} directly, inside a transaction they roll back. The API
 * acceptance harness boots the compiled server WITHOUT `NODE_ENV=test`, over a database its seed
 * wipes every run and cannot wipe this table (#646's review, finding 4114736203), so it opts out
 * with `RELEASE_LEASE_DISABLED=true`. That is honored ONLY outside production, like
 * `THROTTLE_DISABLED`: a production process always registers.
 */

/** How long one lease lasts without renewal. A stopped process stops looking live after this. */
export const RELEASE_LEASE_TTL_SECONDS = 600;
/** How often a serving process extends its lease; well inside the TTL so one missed pass is harmless. */
export const RELEASE_LEASE_RENEW_MS = 180_000;
/** After a FAILED renewal, how soon the next attempt runs. */
export const RELEASE_LEASE_RETRY_MS = 15_000;
/** How long before the lease could expire an unrenewed process stops itself. */
export const RELEASE_LEASE_FENCE_MARGIN_MS = 60_000;

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

/**
 * Extend a LIVE lease; never shortens it (`GREATEST`), which is the only move the seal admits anyway.
 * A lease that has already lapsed on the database clock is NOT revived: the row does not match and
 * the result is 0, because between its expiry and now the drain could already have read this
 * process as gone.
 */
export async function renewLease(db: LeaseDb, instanceId: string, ttlSeconds = RELEASE_LEASE_TTL_SECONDS): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    UPDATE "ReleaseLease"
       SET "leaseUntil" = GREATEST("leaseUntil", CURRENT_TIMESTAMP + make_interval(secs => ${ttlSeconds}))
     WHERE "instanceId" = ${instanceId} AND "leaseUntil" > CURRENT_TIMESTAMP`);
}

/** Whether this process may skip registration: under test, or the acceptance harness's opt-out. */
export function releaseLeaseDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') return true;
  return env.RELEASE_LEASE_DISABLED === 'true' && env.NODE_ENV !== 'production';
}

@Injectable()
export class ReleaseLeaseService implements OnModuleDestroy {
  private readonly log = new Logger('ReleaseLease');
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private fenceTimer: ReturnType<typeof setTimeout> | null = null;
  private instanceId: string | null = null;
  private stopped = false;

  /** The monotonic clock the fence deadline is kept on. Replaced only by the unit probe. */
  protected clock: () => number = () => performance.now();
  /** Stop serving. Replaced only by the unit probe; in a process, the container restarts it. */
  protected terminate: (reason: string) => void = () => process.exit(1);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register this process's lease and start renewing it. Called by the outbox bootstrap AFTER the
   * consumer catalog is synced and the sender gate has passed, so a process refused at boot never
   * claims one. A failed registration ABORTS boot, like a failed catalog sync: a serving process
   * with no lease is invisible to the drain it exists to evidence.
   */
  async register(): Promise<void> {
    if (releaseLeaseDisabled() || this.instanceId) return;
    const lease = { instanceId: newInstanceId(), catalogVersion: compiledCatalogVersion(), release: releaseIdentity() };
    const sentAt = this.clock();
    await writeLease(this.prisma, lease);
    this.instanceId = lease.instanceId;
    this.log.log(`lease ${lease.instanceId} registered for release ${lease.release} at catalog version ${lease.catalogVersion}`);
    this.armFence(sentAt);
    this.scheduleRenewal(RELEASE_LEASE_RENEW_MS);
  }

  /** The deadline is the lease's own length from when the covering statement was SENT, less the margin. */
  private armFence(sentAt: number): void {
    if (this.fenceTimer) clearTimeout(this.fenceTimer);
    const deadline = sentAt + RELEASE_LEASE_TTL_SECONDS * 1000 - RELEASE_LEASE_FENCE_MARGIN_MS;
    this.fenceTimer = setTimeout(
      () => this.fence(`no renewal succeeded within ${RELEASE_LEASE_TTL_SECONDS}s less the ${RELEASE_LEASE_FENCE_MARGIN_MS / 1000}s margin`),
      Math.max(0, deadline - this.clock()),
    );
    this.fenceTimer.unref?.();
  }

  private scheduleRenewal(delayMs: number): void {
    if (this.stopped) return;
    this.renewTimer = setTimeout(() => void this.renew(), delayMs);
    this.renewTimer.unref?.();
  }

  private async renew(): Promise<void> {
    const instanceId = this.instanceId;
    if (this.stopped || !instanceId) return;
    const sentAt = this.clock();
    let renewed: number;
    try {
      renewed = await renewLease(this.prisma, instanceId);
    } catch (e) {
      this.log.warn(`lease renewal failed, retrying in ${RELEASE_LEASE_RETRY_MS / 1000}s: ${(e as Error).message}`);
      this.scheduleRenewal(RELEASE_LEASE_RETRY_MS);
      return;
    }
    if (this.stopped) return;
    if (renewed !== 1) {
      this.fence(`lease ${instanceId} had already lapsed on the database clock when it was renewed`);
      return;
    }
    this.armFence(sentAt);
    this.scheduleRenewal(RELEASE_LEASE_RENEW_MS);
  }

  private fence(reason: string): void {
    if (this.stopped) return;
    this.halt();
    this.log.error(`FENCED — ${reason}. This process stops serving before the drain could read it as gone.`);
    this.terminate(reason);
  }

  private halt(): void {
    this.stopped = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.fenceTimer) clearTimeout(this.fenceTimer);
    this.renewTimer = null;
    this.fenceTimer = null;
  }

  onModuleDestroy(): void {
    // Nothing is deleted or shortened: the lease expires where it stands and stays as history.
    this.halt();
  }
}
