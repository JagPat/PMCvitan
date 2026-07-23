import type { StockLotDto } from '@vitan/shared';
import { decAdd, decSub, decIsPositive } from './decimal';

/** One activity's ACTIVE reserved quantity of a lot. */
export interface ActivityReservation {
  readonly lotId: string;
  readonly material: string;
  readonly activityId: string;
  readonly qty: string; // base UOM, EXACT decimal (numeric(18,6))
  readonly baseUom: string;
}

/**
 * Fold the §C ledger into each activity's ACTIVE reserved quantity per lot (correction finding 5).
 *
 * The reserved amount is the NET of the 'reserved' bucket: Σ(rows INTO 'reserved') − Σ(rows OUT of
 * 'reserved'), keyed by activity. Keying on the bucket movement (`fromBucket`/`toBucket`) — NOT the
 * transaction TYPE — means a `reversal` of a reservation (which moves OUT of 'reserved') and an `issue`
 * (whose same-command `reservation_release` moves OUT) both correctly REDUCE the reserved pool, so a
 * reversed reservation no longer shows as active. Arithmetic is exact (never lossy `Number`).
 */
export function foldActivityReservations(lots: readonly StockLotDto[]): ActivityReservation[] {
  const out: ActivityReservation[] = [];
  for (const lot of lots) {
    const byActivity = new Map<string, string>();
    for (const t of lot.transactions) {
      if (!t.activityId) continue;
      if (t.toBucket === 'reserved') byActivity.set(t.activityId, decAdd(byActivity.get(t.activityId) ?? '0', t.qty));
      if (t.fromBucket === 'reserved') byActivity.set(t.activityId, decSub(byActivity.get(t.activityId) ?? '0', t.qty));
    }
    const material = [lot.materialCategory, lot.make, lot.grade].filter(Boolean).join(' · ');
    for (const [activityId, qty] of byActivity) {
      if (decIsPositive(qty)) out.push({ lotId: lot.id, material, activityId, qty, baseUom: lot.baseUom });
    }
  }
  return out;
}
