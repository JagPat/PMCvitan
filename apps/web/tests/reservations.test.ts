import { describe, it, expect } from 'vitest';
import { foldActivityReservations } from '@/lib/reservations';
import type { StockLotDto, StockTransactionDto } from '@vitan/shared';

/**
 * Phase 3 Task 7 correction — finding 5 (reproduce-first). The Reservations pool is folded from the §C
 * ledger's `fromBucket`/`toBucket` movements, reversals INCLUDED, with EXACT decimal arithmetic. At
 * c642da3 the fold summed only `reservation`/`reservation_release` TYPES with lossy `Number`, so a
 * reversed reservation stayed visible and large/fractional quantities lost precision.
 */

const tx = (over: Partial<StockTransactionDto>): StockTransactionDto => ({
  id: 't', lotId: 'LOT-1', storeLocation: 'main', type: 'reservation', qty: '0',
  fromBucket: null, toBucket: null, poLineId: null, commitmentId: null, activityId: null, issueId: null,
  toStoreLocation: null, reversedTxId: null, qualityResult: null, evidenceMediaId: null, reason: null,
  sourceCommandId: null, recordedAt: '2026-08-01T00:00:00Z', recordedById: 'u1', ...over,
});

const lot = (transactions: StockTransactionDto[]): StockLotDto => ({
  id: 'LOT-1', poLineId: 'POL-1', commitmentId: 'C-1', requirementId: 'REQ-1', revision: 1,
  materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', normalizedAttributes: 'grey', baseUom: 'bag',
  specFingerprint: 'fp-1', decisionId: null, decisionVersion: null, optionKey: null,
  receivedAt: '2026-08-01T00:00:00Z', receivedById: 'u1', locations: [], transactions,
});

describe('foldActivityReservations (finding 5)', () => {
  it('a reservation REVERSED shows NO active reservation', () => {
    const lots = [lot([
      tx({ type: 'reservation', activityId: 'ACT-1', qty: '60', fromBucket: 'acceptedOnHand', toBucket: 'reserved' }),
      tx({ type: 'reversal', activityId: 'ACT-1', qty: '60', fromBucket: 'reserved', toBucket: 'acceptedOnHand', reversedTxId: 't1' }),
    ])];
    // RED at c642da3 (only the `reservation` TYPE counted → net 60, still shown). GREEN: reversal folds OUT.
    expect(foldActivityReservations(lots)).toHaveLength(0);
  });

  it('an issue (its reservation_release out of reserved) leaves no active reservation', () => {
    const lots = [lot([
      tx({ type: 'reservation', activityId: 'ACT-1', qty: '60', fromBucket: 'acceptedOnHand', toBucket: 'reserved' }),
      tx({ type: 'reservation_release', activityId: 'ACT-1', qty: '60', fromBucket: 'reserved', toBucket: 'acceptedOnHand' }),
      tx({ type: 'issue', activityId: 'ACT-1', qty: '60', fromBucket: 'acceptedOnHand', toBucket: 'issuedToActivity', issueId: 'ISS-1' }),
    ])];
    expect(foldActivityReservations(lots)).toHaveLength(0);
  });

  it('an active reservation is shown, and a partial release reduces it — with EXACT decimal arithmetic', () => {
    const lots = [lot([
      tx({ type: 'reservation', activityId: 'ACT-1', qty: '100', fromBucket: 'acceptedOnHand', toBucket: 'reserved' }),
      tx({ type: 'reservation_release', activityId: 'ACT-1', qty: '40', fromBucket: 'reserved', toBucket: 'acceptedOnHand' }),
    ])];
    const r = foldActivityReservations(lots);
    expect(r).toHaveLength(1);
    expect(r[0]!).toMatchObject({ lotId: 'LOT-1', activityId: 'ACT-1', qty: '60', baseUom: 'bag', material: 'Cement · UltraTech · OPC 53' });
  });

  it('folds a lossy-precision quantity EXACTLY (Number() would corrupt it)', () => {
    const lots = [lot([tx({ type: 'reservation', activityId: 'ACT-1', qty: '123456789012.345678', fromBucket: 'acceptedOnHand', toBucket: 'reserved' })])];
    const r = foldActivityReservations(lots);
    expect(r).toHaveLength(1);
    expect(r[0]!.qty).toBe('123456789012.345678'); // Number('123456789012.345678') !== 123456789012.345678
    expect(String(Number('123456789012.345678'))).not.toBe('123456789012.345678'); // the lossy path the fix avoids
  });

  it('reservations for DIFFERENT activities on one lot are kept separate', () => {
    const lots = [lot([
      tx({ type: 'reservation', activityId: 'ACT-1', qty: '30', fromBucket: 'acceptedOnHand', toBucket: 'reserved' }),
      tx({ type: 'reservation', activityId: 'ACT-2', qty: '20', fromBucket: 'acceptedOnHand', toBucket: 'reserved' }),
    ])];
    const r = foldActivityReservations(lots);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.activityId === 'ACT-1')!.qty).toBe('30');
    expect(r.find((x) => x.activityId === 'ACT-2')!.qty).toBe('20');
  });
});
