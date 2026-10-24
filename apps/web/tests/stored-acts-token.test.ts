import { describe, it, expect, beforeEach } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import * as stored from '@/data/storedActs';
import { readStoredQueue } from '@/data/storedActs';
import { queueActIdent } from '@/store/queueActIdent';
import { madeActs, releaseMade } from '@/store/queueActRecord';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { TOKEN_KIND, owedOf, planWrite, recordBytes, recordName, type Snapshot } from '@/store/queueLedger';

/**
 * WEB-02 L2a (plan r3 v4): the reader. A ledger write puts its write token first in the key, in the same write as its
 * acts. This release reads that token as the key's token, never as an act; a token anywhere else, or one malformed,
 * makes the key damaged, so it is never written over. Main's guard, which writes no token, reads such a key's acts and
 * writes them back without it, as plan r3 v4 says every other writer does. Its made records keep reading a token-led
 * record as a newer release's, as at main: the ledger reads its own records once L2b wires it (gap-check G1). Nothing writes a token yet (L2b does), so
 * this changes no stored shape. Each forced probe is red at main 8ee9de9 by assertion: main reads the token as a newer
 * release's act, so the key reads as 'newer' (`probes/at-main.txt`).
 */

const key = 'vitan.outbox.dev:u-pmc.p-1';
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const N = '0123456789abcdef0123456789abcdef';
const token = (n: unknown = N) => ({ t: 'vitan.writeToken', n });

beforeEach(() => { localStorage.clear(); });

describe('L2a: the reader takes a first-entry write token as the key’s token, never an act', () => {
  it('forced probe: a tokened key reads its acts, and the token apart from them', () => {
    expect(readStoredQueue(JSON.stringify([token(), approve('k-1')]))).toEqual({ acts: [approve('k-1')], token: N });
    expect(readStoredQueue(JSON.stringify([token()]))).toEqual({ acts: [], token: N });
  });

  it('a key with no token reads as before, with no token', () => {
    expect(readStoredQueue(JSON.stringify([approve('k-1')]))).toEqual({ acts: [approve('k-1')], token: null });
    expect(readStoredQueue(null)).toEqual({ acts: [], token: null });
  });

  it('forced probe: a token after the first entry makes the key damaged', () => {
    expect(readStoredQueue(JSON.stringify([approve('k-1'), token()]))).toEqual({ unreadable: 'damaged' });
    expect(readStoredQueue(JSON.stringify([token(), approve('k-1'), token('ffff')]))).toEqual({ unreadable: 'damaged' });
  });

  it('forced probe: a malformed first token makes the key damaged', () => {
    for (const bad of [token(''), token(7), token(null), { ...token(), x: 1 }, { t: 'vitan.writeToken' }]) {
      expect(readStoredQueue(JSON.stringify([bad, approve('k-1')])), JSON.stringify(bad)).toEqual({ unreadable: 'damaged' });
    }
  });

  it('a newer release’s act after the token still reads as newer', () => {
    expect(readStoredQueue(JSON.stringify([token(), { t: 'someLaterKind', x: 1 }]))).toEqual({ unreadable: 'newer' });
  });

  it('forced probe: the reader’s token is the ledger’s: what a ledger write stores reads back with its nonce', () => {
    expect(stored.WRITE_TOKEN_KIND).toBe(TOKEN_KIND);
    const s: Snapshot = { key, raw: null, acts: [], sidecar: null, marks: { ids: new Set(), legacy: new Set() }, records: [], recordsUnread: false, fence: true, token: null };
    const occ = { oid: 'n:1', act: approve('k-1') };
    const plan = planWrite(s, { mine: [occ], known: new Set(), sent: new Set() }, () => true, N)!;
    expect(readStoredQueue(plan.raw)).toEqual({ acts: [approve('k-1')], token: N });
    expect(owedOf({ ...s, raw: plan.raw, acts: [approve('k-1')], sidecar: plan.commit, token: N }).frame.exact).toBe(true);
  });
});

describe('L2a: main’s guard beside a tokened key (unfenced, until L2b)', () => {
  it('forced probe: its load takes the acts and reports the key readable; its write leaves the token out', () => {
    const reads: string[] = [];
    const guard = createQueueKeyGuard((_k, read) => { reads.push(read); });
    localStorage.setItem(key, JSON.stringify([token(), approve('k-1')]));
    expect(guard.load(localStorage, key)).toEqual([approve('k-1')]);
    expect(reads).toEqual(['ok']);
    expect(guard.write(localStorage, key, [approve('k-1'), approve('k-2')])).toBe(true);
    expect(localStorage.getItem(key)).toBe(JSON.stringify([approve('k-1'), approve('k-2')]));
  });

  it('a key with a misplaced token is never written over', () => {
    const raw = JSON.stringify([approve('k-1'), token()]);
    localStorage.setItem(key, raw);
    expect(createQueueKeyGuard().write(localStorage, key, [approve('k-2')])).toBe(false);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('forced probe: a made record the ledger writes (`recordBytes`) reads as a newer release’s here: its acts are not loaded, and it is kept', () => {
    // gap-check G1: the record's keyless act may be another occurrence than a byte-identical one in the key, so this
    // guard, which matches by identity, must neither load nor remove it (`releaseMade` keeps every mark: null)
    const raw = recordBytes([approve('k-1')], 'm1');
    const name = recordName(key, [], raw, 'm1');
    localStorage.setItem(name, raw);
    expect(madeActs(localStorage, key, undefined)).toEqual([]);
    expect(releaseMade(localStorage, key, () => true, queueActIdent, undefined)).toBeNull();
    expect(localStorage.getItem(name)).toBe(raw);
  });

  it('forced probe: a load beside a ledger record whose keyless act matches one in the key keeps the record', () => {
    const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
    const raw = recordBytes([U], 'm1');
    const name = recordName(key, [], raw, 'm1');
    localStorage.setItem(name, raw);
    localStorage.setItem(key, JSON.stringify([U]));
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
    expect(localStorage.getItem(name), 'the record stays').toBe(raw);
  });
});
