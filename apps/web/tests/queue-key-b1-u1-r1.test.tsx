import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';

/**
 * #1106 round 1 (Codex review 5632601078): three places matched two identical unkeyed acts as one.
 * - 4362814041: a marked occurrence was matched to memory's later identical act, so [U, A, U] with the first U sent and
 *   A failed was stored [U, A], not [A, U].
 * - 4362814051: a load let go of every stranded act whose identity the key held, so two stranded U beside one in the key
 *   came back as one.
 * - 4362814059: a stored occurrence memory answered used up no known count, so another tab's appended U was dropped.
 * Each forced probe is red at 440fa77 (probes/r1/at-440fa77.txt). The matrix runs every small queue through a partial
 * flush, another tab's append and a new act here, and checks the key against the one right answer.
 */
const key = 'vitan.outbox.dev:u-pmc.p-1';
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const keyed = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const A = keyed('a');
const stored = () => JSON.parse(localStorage.getItem(key) ?? 'null') as OutboxOp[] | null;
const marks = () => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.settled.${key}.`));
/** which occurrence of its identity each act is, in order */
const nth = (acts: OutboxOp[], at: number) => acts.slice(0, at + 1).filter((o) => JSON.stringify(o) === JSON.stringify(acts[at])).length;

afterEach(() => { localStorage.clear(); });

describe('#1106 r1: forced probes', () => {
  it('forced probe (4362814041): [U, A, U], the first U sent and A failed; the end write stores [A, U]', () => {
    localStorage.setItem(key, JSON.stringify([U, A, U]));
    const g = createQueueKeyGuard();
    const [u1, a, u2] = g.load(localStorage, key);
    expect(g.settled(localStorage, key, u1, 1)).toBe(true);
    expect(g.write(localStorage, key, [a, u2])).toBe(true);
    expect(stored()).toEqual([A, U]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([A, U]);
  });

  it('forced probe (4362814041, during the flush): memory still holds the sent U; a write stores [A, U]', () => {
    localStorage.setItem(key, JSON.stringify([U, A, U]));
    const g = createQueueKeyGuard();
    const loaded = g.load(localStorage, key);
    expect(g.settled(localStorage, key, loaded[0], 1)).toBe(true);
    expect(g.write(localStorage, key, loaded)).toBe(true);
    expect(stored()).toEqual([A, U]);
  });

  it('forced probe (4362814051): two stranded U beside one U in the key both come back', () => {
    localStorage.setItem(key, JSON.stringify([U]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    // the scope moved with storage out of reach: both unsent acts are held stranded
    expect(g.keepUnsent(null, key, [{ ...U }, { ...U }], [], (l) => l)).toBe(false);
    expect(g.load(localStorage, key)).toEqual([U, U]);
  });

  it('forced probe (4362814059): another tab appends an identical U after this tab loaded one; this tab’s write keeps both', () => {
    localStorage.setItem(key, JSON.stringify([U]));
    const g = createQueueKeyGuard();
    const mine = g.load(localStorage, key);
    localStorage.setItem(key, JSON.stringify([U, U]));
    expect(g.write(localStorage, key, mine)).toBe(true);
    expect(stored()).toEqual([U, U]);
  });

  it('root-cause pass: another tab sent the first of two identical acts this tab also holds; this tab’s write leaves one in the key', () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    const g = createQueueKeyGuard();
    const mine = g.load(localStorage, key);
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(other.settled(localStorage, key, theirs[0], 1)).toBe(true);
    expect(g.write(localStorage, key, mine)).toBe(true);
    expect(stored()).toEqual([U]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
  });

  it('root-cause pass: the flush’s scope-moved write takes out another tab’s marked identical act with its own, and no mark is left', () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    const g = createQueueKeyGuard();
    const [mine] = g.load(localStorage, key);
    // another tab sent the second and marked it; this tab's flush sent the first, then the scope moved
    expect(createQueueKeyGuard().settled(localStorage, key, { ...U }, 2)).toBe(true);
    expect(g.keepUnsent(localStorage, key, [], [mine], (l) => l)).toBe(true);
    expect(stored()).toEqual([]);
    expect(marks()).toEqual([]);
  });
});

/** every queue of up to four acts, each an unkeyed U or a unique keyed act */
function queues(): OutboxOp[][] {
  const out: OutboxOp[][] = [];
  for (let len = 1; len <= 4; len++) {
    for (let bits = 0; bits < 1 << len; bits++) {
      out.push(Array.from({ length: len }, (_, n) => ((bits >> n) & 1 ? { ...U } : keyed(`q${n}`))));
    }
  }
  return out;
}
const others: [string, OutboxOp[]][] = [['none', []], ['U', [U]], ['keyed', [keyed('other')]]];
const news: [string, OutboxOp[]][] = [['none', []], ['U', [U]], ['keyed', [keyed('new')]]];

describe('#1106 r1: the merge matrix (stored order, duplicates, marked occurrences, another tab’s append, a new act)', () => {
  const cases: { name: string; queue: OutboxOp[]; sent: number; other: OutboxOp[]; made: OutboxOp[]; during: boolean }[] = [];
  for (const queue of queues()) {
    for (let sent = 0; sent <= queue.length; sent++) {
      for (const [on, other] of others) {
        for (const [nn, made] of news) {
          for (const during of [false, true]) {
            const shape = queue.map((o) => ('idempotencyKey' in o ? 'K' : 'U')).join('');
            cases.push({ name: `${shape} sent ${sent} other ${on} new ${nn} ${during ? 'during' : 'after'} the flush`, queue, sent, other, made, during });
          }
        }
      }
    }
  }

  it.each(cases)('$name', ({ queue, sent, other, made, during }) => {
    localStorage.setItem(key, JSON.stringify(queue));
    const g = createQueueKeyGuard();
    const loaded = g.load(localStorage, key);
    for (let n = 0; n < sent; n++) expect(g.settled(localStorage, key, loaded[n], nth(loaded, n))).toBe(true);
    // another tab of this release appends its act after this tab loaded
    localStorage.setItem(key, JSON.stringify([...queue, ...other]));
    const owed = [...queue.slice(sent), ...other];
    // a page opened now owes exactly the unsent acts and the other tab's
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual(owed);
    const mine = [...(during ? loaded : loaded.slice(sent)), ...made.map((o) => ({ ...o }))];
    expect(g.write(localStorage, key, mine)).toBe(true);
    expect(stored()).toEqual([...owed, ...made]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([...owed, ...made]);
    expect(marks()).toEqual([]);
  });
});

describe('#1106 r1: the stranded matrix', () => {
  const cases: { n: number; inKey: number; keyedToo: boolean }[] = [];
  for (let n = 1; n <= 3; n++) for (let inKey = 0; inKey <= n; inKey++) for (const keyedToo of [false, true]) cases.push({ n, inKey, keyedToo });

  it.each(cases)('$n unsent U stranded, $inKey of them in the key, keyed act too: $keyedToo', ({ n, inKey, keyedToo }) => {
    const rest = [...(keyedToo ? [keyed('s')] : []), ...Array.from({ length: n }, () => ({ ...U }))];
    const inStore = [...(keyedToo ? [A] : []), ...Array.from({ length: inKey }, () => U)];
    localStorage.setItem(key, JSON.stringify(inStore));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    expect(g.keepUnsent(null, key, rest, [], (l) => l)).toBe(false);
    const back = g.load(localStorage, key);
    expect(back.filter((o) => JSON.stringify(o) === JSON.stringify(U))).toHaveLength(n);
    expect(back.filter((o) => 'idempotencyKey' in o)).toHaveLength(keyedToo ? 2 : 0);
    expect(g.strandedCount()).toBe(n - inKey + (keyedToo ? 1 : 0));
  });
});

describe('#1106 r1b: the leave question counts identical acts not kept', () => {
  it('forced probe: two identical unkeyed acts a full key cannot store are two not kept, and none is counted twice', () => {
    localStorage.setItem(key, '[]');
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    const full = {
      getItem: (n: string) => localStorage.getItem(n),
      setItem: (n: string, v: string) => { if (n === key || n.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError'); localStorage.setItem(n, v); },
      removeItem: (n: string) => localStorage.removeItem(n),
    };
    expect(g.write(full, key, [{ ...U }, { ...U }])).toBe(false);
    expect(g.notKeptCount()).toBe(2);
    expect(g.notKept(key)).toHaveLength(2);
    // held stranded too (no copy could be made), and counted once, as not kept
    expect(g.notKeptCount() + g.strandedCount()).toBe(2);
  });
});
