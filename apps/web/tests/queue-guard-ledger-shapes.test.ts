import { describe, it, expect, beforeEach } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { queueActIdent } from '@/store/queueActIdent';
import { createQueueKeyGuard, type KeyRead } from '@/store/queueKeyGuard';
import { TOKEN_KIND, markName, recordBytes, recordName, sidecarName } from '@/store/queueLedger';
import { storedQueue } from './queueWrites';

/**
 * #1117 r1 root-cause audit (Codex 4368845658, gap-check G1) carried into L2b: until L2b, main's guard read every shape
 * the ledger writes as a newer release's (`probes/at-main.txt` in web-02-L2a). L2b's guard is the ledger's writer, so it
 * reads each shape by occurrence: a tokened key and a tokened made record are this release's, two identical keyless
 * acts are two occurrences, an oid settled mark settles only the occurrence it names, and the sidecar is the ledger's.
 */

const key = 'vitan.outbox.dev:u-pmc.p-1';
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const token = { t: TOKEN_KIND, n: '0123456789abcdef0123456789abcdef' };

beforeEach(() => { localStorage.clear(); });

describe('L2b’s guard beside what the ledger writes', () => {
  it('forced probe (Codex 4368845658): a tokened key with two identical keyless acts and a mark naming neither loses neither', () => {
    localStorage.setItem(key, JSON.stringify([token, U, U]));
    const mark = markName(key, U, 'n:1');
    localStorage.setItem(mark, queueActIdent(U));
    const reads: KeyRead[] = [];
    const guard = createQueueKeyGuard((_k, read) => { reads.push(read); });
    const loaded = guard.load(localStorage, key);
    expect(loaded, 'both occurrences load').toEqual([U, U]);
    expect(guard.write(localStorage, key, loaded), 'the key is written').toBe(true);
    expect(storedQueue(localStorage.getItem(key)), 'both occurrences stay').toEqual([U, U]);
    expect(new Set(reads), 'every read of the key is this release’s').toEqual(new Set(['ok']));
    expect(createQueueKeyGuard().load(localStorage, key), 'a reload takes both').toEqual([U, U]);
  });

  it('a tokened key reads as this release’s to every guard read: load, heard and write', () => {
    localStorage.setItem(key, JSON.stringify([token, approve('k-1')]));
    const reads: KeyRead[] = [];
    const guard = createQueueKeyGuard((_k, read) => { reads.push(read); });
    guard.heard(localStorage, key);
    expect(guard.load(localStorage, key)).toEqual([approve('k-1')]);
    expect(reads).toEqual(['ok', 'ok']);
    expect(guard.write(localStorage, key, [approve('k-1'), approve('k-2')])).toBe(true);
    expect(storedQueue(localStorage.getItem(key))).toEqual([approve('k-1'), approve('k-2')]);
  });

  it('forced probe (G1): a tokened made record beside the same keyless act in the key is another occurrence, owed until a write stores it', () => {
    const raw = recordBytes([U], 'm1');
    const name = recordName(key, [], raw, 'm1');
    localStorage.setItem(name, raw);
    localStorage.setItem(key, JSON.stringify([U]));
    const guard = createQueueKeyGuard();
    const loaded = guard.load(localStorage, key);
    expect(loaded, 'the key’s and the record’s').toEqual([U, U]);
    expect(localStorage.getItem(name), 'a load leaves the record').toBe(raw);
    expect(guard.write(localStorage, key, loaded)).toBe(true);
    expect(storedQueue(localStorage.getItem(key))).toEqual([U, U]);
    expect(localStorage.getItem(name), 'once the key holds it, the record goes').toBeNull();
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U, U]);
  });

  it('a sidecar this release cannot read names nothing, and the write replaces it with its own', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    localStorage.setItem(sidecarName(key), '{"v":1}');
    const guard = createQueueKeyGuard();
    expect(guard.load(localStorage, key)).toEqual([approve('k-1')]);
    expect(guard.write(localStorage, key, [approve('k-1'), approve('k-2')])).toBe(true);
    expect(storedQueue(localStorage.getItem(key))).toEqual([approve('k-1'), approve('k-2')]);
    expect(localStorage.getItem(sidecarName(key))).not.toBe('{"v":1}');
  });
});
