import { describe, it, expect, beforeEach } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import * as stored from '@/data/storedActs';
import { readLedgerQueue, readStoredQueue } from '@/data/storedActs';
import { TOKEN_KIND, owedOf, planWrite, recordBytes, type Snapshot } from '@/store/queueLedger';

/**
 * WEB-02 L2a (plan r3 v4): the ledger's reader. A ledger write puts its write token first in the key, in the same write
 * as its acts. `readLedgerQueue` reads that token as the key's token, never as an act; a token anywhere else, or one
 * malformed, makes the key damaged, so it is never written over. `readStoredQueue`, which main's guard and its made
 * records read through, still takes a tokened key as a newer release's (#1117 r1, Codex 4368845658; the guard rows are
 * in `queue-guard-ledger-shapes.test.ts`). Nothing writes a token yet (L2b does), so this changes no stored shape. The
 * reader's forced probes need `readLedgerQueue`, which main has not got (`probes/at-main.txt`).
 */

const key = 'vitan.outbox.dev:u-pmc.p-1';
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const N = '0123456789abcdef0123456789abcdef';
const token = (n: unknown = N) => ({ t: 'vitan.writeToken', n });

beforeEach(() => { localStorage.clear(); });

describe('L2a: the reader takes a first-entry write token as the key’s token, never an act', () => {
  it('forced probe: a tokened key reads its acts, and the token apart from them', () => {
    expect(readLedgerQueue(JSON.stringify([token(), approve('k-1')]))).toEqual({ acts: [approve('k-1')], token: N });
    expect(readLedgerQueue(JSON.stringify([token()]))).toEqual({ acts: [], token: N });
  });

  it('a key with no token reads as before, with no token', () => {
    expect(readLedgerQueue(JSON.stringify([approve('k-1')]))).toEqual({ acts: [approve('k-1')], token: null });
    expect(readLedgerQueue(null)).toEqual({ acts: [], token: null });
  });

  it('forced probe: a token after the first entry makes the key damaged', () => {
    expect(readLedgerQueue(JSON.stringify([approve('k-1'), token()]))).toEqual({ unreadable: 'damaged' });
    expect(readLedgerQueue(JSON.stringify([token(), approve('k-1'), token('ffff')]))).toEqual({ unreadable: 'damaged' });
  });

  it('forced probe: a malformed first token makes the key damaged', () => {
    for (const bad of [token(''), token(7), token(null), { ...token(), x: 1 }, { t: 'vitan.writeToken' }]) {
      expect(readLedgerQueue(JSON.stringify([bad, approve('k-1')])), JSON.stringify(bad)).toEqual({ unreadable: 'damaged' });
    }
  });

  it('the queue reader main’s guard reads through still takes a tokened key as a newer release’s (red at 6701e90)', () => {
    expect(readStoredQueue(JSON.stringify([token(), approve('k-1')]))).toEqual({ unreadable: 'newer' });
    expect(readStoredQueue(JSON.stringify([approve('k-1')]))).toEqual({ acts: [approve('k-1')] });
  });

  it('a newer release’s act after the token still reads as newer', () => {
    expect(readLedgerQueue(JSON.stringify([token(), { t: 'someLaterKind', x: 1 }]))).toEqual({ unreadable: 'newer' });
  });

  it('forced probe: the reader’s token is the ledger’s: what a ledger write stores reads back with its nonce', () => {
    expect(stored.WRITE_TOKEN_KIND).toBe(TOKEN_KIND);
    const s: Snapshot = { key, raw: null, acts: [], sidecar: null, marks: { ids: new Set(), legacy: new Set() }, records: [], recordsUnread: false, fence: true, token: null };
    const occ = { oid: 'n:1', act: approve('k-1') };
    const plan = planWrite(s, { mine: [occ], known: new Set(), sent: new Set() }, () => true, N)!;
    expect(readLedgerQueue(plan.raw)).toEqual({ acts: [approve('k-1')], token: N });
    expect(owedOf({ ...s, raw: plan.raw, acts: [approve('k-1')], sidecar: plan.commit, token: N }).frame.exact).toBe(true);
  });

  it('a made record the ledger writes (`recordBytes`) reads back here with its acts and its nonce', () => {
    expect(readLedgerQueue(recordBytes([approve('k-1')], 'm1'))).toEqual({ acts: [approve('k-1')], token: 'm1' });
  });
});
