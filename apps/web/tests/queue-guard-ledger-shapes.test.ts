import { describe, it, expect, beforeEach } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { queueActIdent } from '@/store/queueActIdent';
import { madeActs, releaseMade } from '@/store/queueActRecord';
import { createQueueKeyGuard, type KeyRead } from '@/store/queueKeyGuard';
import { TOKEN_KIND, markName, recordBytes, recordName, sidecarName } from '@/store/queueLedger';

/**
 * #1117 r1 root-cause audit (Codex 4368845658, gap-check G1): main's guard matches acts by identity, and every shape the
 * ledger writes can hold occurrences that identity cannot tell apart. So, until L2b routes writes through the ledger,
 * main's guard treats each shape exactly as at main 8ee9de9: a tokened key and a tokened made record read as a newer
 * release's (never loaded, removed or written over), and an oid settled mark and the sidecar are left as they are.
 * Only main's own exports are used, so each row runs at 8ee9de9 too, where all are green (`probes/at-main.txt`); the
 * ones naming 6701e90 or d84e27f were red there by assertion (`probes/at-6701e90.txt`, `probes/at-d84e27f.txt`).
 */

const key = 'vitan.outbox.dev:u-pmc.p-1';
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const token = { t: TOKEN_KIND, n: '0123456789abcdef0123456789abcdef' };

beforeEach(() => { localStorage.clear(); });

describe('main’s guard beside what the ledger writes (as at 8ee9de9, until L2b)', () => {
  it('forced probe (Codex 4368845658, red at 6701e90): a tokened key with two identical keyless acts and one occurrence’s mark loses neither', () => {
    const raw = JSON.stringify([token, U, U]);
    localStorage.setItem(key, raw);
    const mark = markName(key, U, 'n:1');
    localStorage.setItem(mark, queueActIdent(U));
    const reads: KeyRead[] = [];
    const guard = createQueueKeyGuard((_k, read) => { reads.push(read); });
    const loaded = guard.load(localStorage, key);
    const wrote = guard.write(localStorage, key, loaded);
    expect(localStorage.getItem(key), 'both occurrences stay').toBe(raw);
    expect(wrote, 'the key is not written over').toBe(false);
    expect(loaded, 'none of its acts is loaded').toEqual([]);
    expect(new Set(reads), 'every read of the key is a newer release’s').toEqual(new Set(['newer']));
    expect(localStorage.getItem(mark), 'the mark stays').toBe(queueActIdent(U));
  });

  it('a tokened key reads as a newer release’s to every guard read: load, heard and write', () => {
    const raw = JSON.stringify([token, approve('k-1')]);
    localStorage.setItem(key, raw);
    const reads: KeyRead[] = [];
    const guard = createQueueKeyGuard((_k, read) => { reads.push(read); });
    guard.heard(localStorage, key);
    expect(guard.load(localStorage, key)).toEqual([]);
    expect(reads).toEqual(['newer', 'newer']);
    expect(guard.write(localStorage, key, [approve('k-1'), approve('k-2')])).toBe(false);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('forced probe (G1, red at d84e27f): a tokened made record is neither loaded nor removed, beside the same keyless act in the key', () => {
    const raw = recordBytes([U], 'm1');
    const name = recordName(key, [], raw, 'm1');
    localStorage.setItem(name, raw);
    localStorage.setItem(key, JSON.stringify([U]));
    expect(madeActs(localStorage, key, undefined)).toEqual([]);
    expect(releaseMade(localStorage, key, () => true, queueActIdent, undefined), 'every mark of the key stays').toBeNull();
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
    expect(localStorage.getItem(name), 'the record stays').toBe(raw);
  });

  it('the sidecar is left as it is by a load and a write', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    localStorage.setItem(sidecarName(key), '{"v":1}');
    const guard = createQueueKeyGuard();
    expect(guard.load(localStorage, key)).toEqual([approve('k-1')]);
    expect(guard.write(localStorage, key, [approve('k-1'), approve('k-2')])).toBe(true);
    expect(localStorage.getItem(sidecarName(key))).toBe('{"v":1}');
  });
});
