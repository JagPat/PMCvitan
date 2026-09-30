import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { ApiGateway, type ApiGateway as Gateway } from '@/data/apiGateway';

/**
 * Phase 6 task 4d-ii-b / B6 — the client `Idempotency-Key` on the three member commands (the plan, lines
 * 3108–3116: "the client key ships in the CLIENT unit 4d-ii-b"). 4d-ii-a / A3b made `members.add`,
 * `members.updateRole` and `members.remove` ledger commands and let the server synthesize a key for a
 * tab that sends none; a KEYED call is deduplicated, so the user's retry after a lost response runs once.
 *
 * The rule under test: one key per ACT, reused on the retry of the same act, settled by a confirmed
 * success or a terminal refusal so the next identical act is a new act under a new key; a distinct act
 * (another member, another role, another project) has its own key; and the gateway puts the key on the
 * wire as the `Idempotency-Key` header of the right route.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const refused = (status: number) => Object.assign(new Error(`refused ${status}`), { status });
const UUIDISH = /^[0-9a-f-]{20,}$/i;

const COMMANDS = [
  { label: 'addMember', method: 'addMember', keyIndex: 1,
    invoke: () => s().addMember({ name: 'Nilesh', role: 'contractor', email: 'N@vitan.in ' }),
    other: () => s().addMember({ name: 'Priya', role: 'engineer', email: 'p@vitan.in' }) },
  { label: 'updateMemberRole', method: 'updateMemberRole', keyIndex: 3,
    invoke: () => s().updateMemberRole('u-1', 'consultant', 'structural'),
    other: () => s().updateMemberRole('u-1', 'engineer') },
  { label: 'removeMember', method: 'removeMember', keyIndex: 1,
    invoke: () => s().removeMember('u-1'),
    other: () => s().removeMember('u-2') },
] as const;
const keyOf = (cmd: (typeof COMMANDS)[number], call: unknown[]) => call[cmd.keyIndex] as string;

describe('B6 — one idempotency key per member act, reused on the retry', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState({ activeProjectId: 'ambli', projectScopeGeneration: 1 });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  for (const cmd of COMMANDS) {
    it(`${cmd.label}: the first attempt mints a key; the retry after a lost response sends the SAME key`, async () => {
      const method = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({});
      s()._setGateway({ [cmd.method]: method, listMembers: vi.fn().mockResolvedValue([]) } as unknown as Gateway);
      cmd.invoke();
      await flush();
      const key1 = keyOf(cmd, method.mock.calls[0]);
      expect(key1).toMatch(UUIDISH);
      // the user tries again — the same act, the same key
      cmd.invoke();
      await flush(); await flush();
      expect(method).toHaveBeenCalledTimes(2);
      expect(keyOf(cmd, method.mock.calls[1])).toBe(key1);
    });

    it(`${cmd.label}: a confirmed success settles the act — the next identical act is a NEW key; a distinct act has its own`, async () => {
      const method = vi.fn().mockResolvedValue({});
      s()._setGateway({ [cmd.method]: method, listMembers: vi.fn().mockResolvedValue([]) } as unknown as Gateway);
      cmd.invoke();
      await flush(); await flush();
      const key1 = keyOf(cmd, method.mock.calls[0]);
      cmd.invoke();
      await flush(); await flush();
      const key2 = keyOf(cmd, method.mock.calls[1]);
      expect(key2).toMatch(UUIDISH);
      expect(key2).not.toBe(key1);
      cmd.other();
      await flush();
      const key3 = keyOf(cmd, method.mock.calls[2]);
      expect(key3).not.toBe(key2);
      expect(key3).not.toBe(key1);
    });

    it(`${cmd.label}: a terminal refusal settles the act too — the corrected retry is a new act; a transient failure keeps the key`, async () => {
      const method = vi.fn()
        .mockRejectedValueOnce(refused(400))
        .mockRejectedValueOnce(refused(503))
        .mockResolvedValue({});
      s()._setGateway({ [cmd.method]: method, listMembers: vi.fn().mockResolvedValue([]) } as unknown as Gateway);
      cmd.invoke();
      await flush();
      const refusedKey = keyOf(cmd, method.mock.calls[0]);
      cmd.invoke(); // after a 400 the act is settled: a new key
      await flush();
      const key2 = keyOf(cmd, method.mock.calls[1]);
      expect(key2).not.toBe(refusedKey);
      cmd.invoke(); // after a 503 (transient) the act is NOT settled: the same key again
      await flush();
      expect(keyOf(cmd, method.mock.calls[2])).toBe(key2);
    });

    it(`${cmd.label}: the key is scoped to the project — the same act on another project is another act`, async () => {
      const method = vi.fn().mockRejectedValue(new Error('offline'));
      s()._setGateway({ [cmd.method]: method, listMembers: vi.fn().mockResolvedValue([]) } as unknown as Gateway);
      cmd.invoke();
      await flush();
      useStore.setState({ activeProjectId: 'project-b', projectScopeGeneration: 2 });
      cmd.invoke();
      await flush();
      expect(keyOf(cmd, method.mock.calls[1])).not.toBe(keyOf(cmd, method.mock.calls[0]));
    });

    it(`${cmd.label}: a settle names the project the act was MINTED on — switching projects while the request is in flight neither strands the key nor settles another project's act`, async () => {
      // the finding on this unit's first head: the settle re-read the active project at response time, so
      // a switch mid-flight left the succeeded key in place and the next identical act replayed the ledger
      // row (200, nothing run) instead of running a new act.
      let finish: (v: unknown) => void = () => {};
      const method = vi.fn().mockImplementationOnce(() => new Promise((r) => { finish = r; })).mockRejectedValue(new Error('offline'));
      s()._setGateway({ [cmd.method]: method, listMembers: vi.fn().mockResolvedValue([]) } as unknown as Gateway);
      cmd.invoke(); // minted under ambli, response pending
      await flush();
      const ambliKey = keyOf(cmd, method.mock.calls[0]);
      useStore.setState({ activeProjectId: 'project-b', projectScopeGeneration: 2 });
      cmd.invoke(); // the same act on project B: its own key, and the (offline) failure keeps it
      await flush();
      const bKey = keyOf(cmd, method.mock.calls[1]);
      expect(bKey).not.toBe(ambliKey);
      finish({}); // ambli's response arrives while B is active
      await flush(); await flush();
      cmd.invoke(); // B's act was not settled by ambli's success: the retry reuses B's key
      await flush();
      expect(keyOf(cmd, method.mock.calls[2])).toBe(bKey);
      useStore.setState({ activeProjectId: 'ambli', projectScopeGeneration: 3 });
      cmd.invoke(); // back on ambli, the identical act is a NEW act: the succeeded key was settled
      await flush();
      const nextAmbliKey = keyOf(cmd, method.mock.calls[3]);
      expect(nextAmbliKey).toMatch(UUIDISH);
      expect(nextAmbliKey).not.toBe(ambliKey);
      expect(nextAmbliKey).not.toBe(bKey);
    });
  }

  it('the add act is the request as the server hashes it: the same email in another case is the same act; a corrected name, role, discipline or phone is a NEW act', async () => {
    // round-1 Codex P2 (4150008570): the server hashes name, role, email (lower-cased), phone and the
    // consultant's discipline under the key and 409s a same-key/different-hash replay — so a re-entry
    // that corrects a field must not reuse the key the lost request was sent under.
    const method = vi.fn().mockRejectedValue(new Error('offline'));
    s()._setGateway({ addMember: method, listMembers: vi.fn() } as unknown as Gateway);
    s().addMember({ name: 'Nilesh', role: 'contractor', email: 'N@vitan.in' });
    await flush();
    s().addMember({ name: 'Nilesh', role: 'contractor', email: 'n@vitan.in' }); // the server lower-cases the email: the same hash
    await flush();
    const key = method.mock.calls[0][1];
    expect(method.mock.calls[1][1]).toBe(key);
    s().addMember({ name: 'Nilesh K.', role: 'contractor', email: 'n@vitan.in' }); // a corrected name: another request
    await flush();
    expect(method.mock.calls[2][1]).not.toBe(key);
    s().addMember({ name: 'Nilesh', role: 'engineer', email: 'n@vitan.in' }); // another role
    await flush();
    expect(method.mock.calls[3][1]).not.toBe(key);
    s().addMember({ name: 'Nilesh', role: 'consultant', discipline: 'structural', email: 'n@vitan.in' });
    await flush();
    s().addMember({ name: 'Nilesh', role: 'consultant', discipline: 'mep', email: 'n@vitan.in' }); // another discipline
    await flush();
    expect(method.mock.calls[5][1]).not.toBe(method.mock.calls[4][1]);
    // a discipline on a non-consultant is dropped by the server's hash, so it is the same act here too
    s().addMember({ name: 'Nilesh', role: 'contractor', email: 'n@vitan.in', discipline: 'structural' });
    await flush();
    expect(method.mock.calls[6][1]).toBe(key);
    // a phone contact is its own identity
    s().addMember({ name: 'Ramesh', role: 'engineer', phone: '9898989898' });
    await flush();
    expect(method.mock.calls[7][1]).not.toBe(key);
  });

  it('without the server nothing is minted and nothing is sent', async () => {
    s().addMember({ name: 'X', role: 'engineer', email: 'x@vitan.in' });
    s().updateMemberRole('u-1', 'engineer');
    s().removeMember('u-1');
    await flush();
    expect(s().toast).toBe('Managing the team needs the server.');
  });
});

describe('B6 — the gateway puts the key on the wire, on the right route', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function captureFetch() {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      calls.push({ url, method: init?.method ?? 'GET', headers });
      return { ok: true, status: 200, json: async () => ({}) };
    }) as never);
    return calls;
  }

  it('POST / PATCH / DELETE each carry the Idempotency-Key beside the contract header and the token', async () => {
    const calls = captureFetch();
    const gw = new ApiGateway('http://api.test', 'ambli');
    gw.setToken('h.e30.s');
    await gw.addMember({ name: 'N', role: 'engineer', email: 'n@vitan.in' }, 'key-add');
    await gw.updateMemberRole('u-1', 'consultant', 'structural', 'key-role');
    await gw.removeMember('u-1', 'key-remove');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'http://api.test/projects/ambli/members'],
      ['PATCH', 'http://api.test/projects/ambli/members/u-1'],
      ['DELETE', 'http://api.test/projects/ambli/members/u-1'],
    ]);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-add', 'key-role', 'key-remove']);
    for (const c of calls) {
      expect(c.headers['x-vitan-decisions-contract']).toBe('countersign-v1');
      expect(c.headers.authorization).toBe('Bearer h.e30.s');
    }
  });

  it('a keyless call (the signature keeps the key optional) sends no header — the server synthesizes one, as it did for every tab before this unit', async () => {
    const calls = captureFetch();
    const gw = new ApiGateway('http://api.test', 'ambli');
    await gw.removeMember('u-1');
    expect(calls[0].headers['idempotency-key']).toBeUndefined();
  });
});
