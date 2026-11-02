/**
 * Redbracket ID A3 — structural pin: a read made while an interactive transaction is open goes through that
 * transaction's client, never the root one. The root client needs a second pool connection while the transaction holds
 * the first; with the pool full (many break-glass tries in an issuer outage, many phone codes) no connection comes
 * back and the sign-in stalls until a timeout. Codex round 3 on #1306 found the break-glass session's retirement check
 * on the root client; the audit (the replacement PR's body) found the phone-code redeem's sign-in rule doing the same.
 * Checked file-wide, with no hand-kept list: every `$transaction` callback, every function or callback anywhere in the
 * file that is handed a client (a `tx`/`db` parameter, or one typed as a client), and every member of the class those
 * call, all the way down.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
/** A source file with its comments blanked (same length), so prose in them is never read as code. */
const read = (path: string) =>
  readFileSync(join(SRC, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])(\/\/[^\n]*)/gm, (_, lead: string, c: string) => lead + ' '.repeat(c.length));

/** The source of every `$transaction(...)` call in `text`: from the call to its matching closing parenthesis. */
function transactions(text: string): string[] {
  const blocks: string[] = [];
  for (let at = text.indexOf('$transaction('); at >= 0; at = text.indexOf('$transaction(', at + 1)) {
    let depth = 0;
    let end = at + '$transaction'.length;
    do {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')') depth -= 1;
      end += 1;
    } while (depth > 0 && end < text.length);
    blocks.push(text.slice(at, end));
  }
  return blocks;
}

/** The body of the member declared by `declaration`: from it to the next member at the same indent. */
function body(text: string, declaration: RegExp): string {
  const start = text.search(declaration);
  expect(start, String(declaration)).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:private |async |public |readonly |\/\*\*|[a-zA-Z]+\()/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** `this.prisma` uses other than as a parameter default (`= this.prisma`) or the opening of a transaction. */
const rootUses = (text: string) =>
  text.replace(/= this\.prisma\b/g, '').replace(/this\.prisma\.\$transaction\(/g, '').match(/this\.prisma\b/g) ?? [];

/** The index just past the bracket that closes the one opened at `open`. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[text[open]!]!];
  let at = open + 1;
  while (stack.length && at < text.length) {
    const c = text[at]!;
    if (c === "'" || c === '"' || c === '`') {
      for (at += 1; at < text.length && text[at] !== c; at += text[at] === '\\' ? 2 : 1);
    } else if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) stack.pop();
    at += 1;
  }
  return at;
}

/** The parameters of a list, split at its top-level commas. */
function topLevel(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < params.length; at += 1) {
    const c = params[at]!;
    if ('({[<'.includes(c)) depth += 1;
    else if (')}]'.includes(c) || (c === '>' && params[at - 1] !== '=')) depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(params.slice(from, at)); from = at + 1; }
  }
  return [...parts, params.slice(from)].map((part) => part.trim()).filter(Boolean);
}

/** Whether a parameter list hands its function a database client: a parameter named `tx` or `db`, or typed as one
 *  (a parameter that is itself a function taking a client does not count: the function it names is checked where it
 *  is written). */
const takesClient = (params: string) =>
  topLevel(params).some((param) => {
    const [name, type = ''] = param.split(/:(.*)/s).map((part) => part.trim());
    if (/^(?:tx|db)\b/.test(name!)) return true;
    return !type.includes('=>') && /^(?:Prisma\.TransactionClient|Db)\b/.test(type);
  });

/**
 * Every place in `text` that runs with a client in hand: each `$transaction(...)` callback, and each function or arrow
 * (anywhere in the file, at any depth) whose parameters include a client. Returns their source.
 */
function clientScopes(text: string): string[] {
  const scopes = transactions(text).map((block) => block.slice('$transaction('.length));
  for (let at = text.indexOf('('); at >= 0; at = text.indexOf('(', at + 1)) {
    const end = closing(text, at);
    const params = text.slice(at, end);
    if (!takesClient(params.slice(1, -1))) continue;
    // a function head: the parameters are followed, after an optional return type (which may hold `<{ ... }>`), by
    // `=>` or a body `{`; anything else (a call's arguments) is not one
    let next = end;
    while (/\s/.test(text[next] ?? '')) next += 1;
    if (text[next] === ':') {
      let depth = 0;
      for (next += 1; next < text.length; next += 1) {
        const c = text[next]!;
        if (depth === 0 && (c === '{' || (c === '=' && text[next + 1] === '>') || c === ';' || c === ',' || c === ')')) break;
        if ('<({['.includes(c)) depth += 1;
        else if (')}]'.includes(c) || (c === '>' && text[next - 1] !== '=')) depth -= 1;
      }
    }
    while (/\s/.test(text[next] ?? '')) next += 1;
    const before = text.slice(Math.max(0, at - 60), at);
    if (text[next] === '=' && text[next + 1] === '>') {
      let start = next + 2;
      while (/\s/.test(text[start] ?? '')) start += 1;
      scopes.push(text[start] === '{' ? text.slice(start, closing(text, start)) : text.slice(start, start + 400).split(/[;\n]/)[0]!);
    } else if (text[next] === '{' && /\w\s*(?:<[^>]*>)?\s*$/.test(before) && !/\b(?:if|for|while|switch|catch|return|await|new|function)\s*$/.test(before)) {
      scopes.push(text.slice(next, closing(text, next)));
    }
  }
  return scopes;
}

/** The class members of `text` by name, with their source. */
function members(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of text.matchAll(/\n {2}(?:private |public |protected )?(?:readonly )?(?:static )?(?:async )?(\w+)\s*(?=\(|<|=\s*async)/g)) {
    found.set(m[1]!, body(text.slice(m.index!), /\n {2}/));
  }
  return found;
}

const FILES = [
  'auth/auth.service.ts',
  'auth/identity/identity-sign-in.service.ts',
  'auth/password-credentials.service.ts',
  'auth/phone-sign-in.service.ts',
];

describe('transaction client gate (structural)', () => {
  it('nothing that runs with a client in hand reads through the root client, nor calls a member of its class that does', () => {
    let scopesSeen = 0;
    for (const file of FILES) {
      const text = read(file);
      const own = members(text);
      for (const scope of clientScopes(text)) {
        scopesSeen += 1;
        expect(rootUses(scope), `${file}: ${scope.slice(0, 160)}`).toEqual([]);
        // a member it calls, and every member that one calls, all the way down
        const seen = new Set<string>();
        const queue = [...scope.matchAll(/this\.(\w+)\s*\(/g)].map((m) => m[1]!);
        while (queue.length) {
          const name = queue.shift()!;
          if (seen.has(name) || !own.has(name)) continue;
          seen.add(name);
          const member = own.get(name)!;
          expect(rootUses(member), `${file}: ${name}, called with a client in hand from ${scope.slice(0, 120)}`).toEqual([]);
          queue.push(...[...member.matchAll(/this\.(\w+)\s*\(/g)].map((m) => m[1]!));
        }
      }
    }
    // every transaction callback (11) and every client-taking helper and callback is found
    expect(scopesSeen).toBeGreaterThanOrEqual(25);
  });

  it('the shared readers take their client as an argument and hold none of their own', () => {
    expect(rootUses(read('auth/identity/identity-accounts.ts'))).toEqual([]);
    expect(rootUses(read('orgs/orgs.participant.ts'))).toEqual([]);
  });

  it('the sign-in rule and the signer use the client they are handed, and the transactions hand theirs over', () => {
    const auth = read('auth/auth.service.ts');
    const access = body(auth, /\n {2}private async signInAccess\(/);
    expect(access).toContain('isRetired(db, user.id)');
    expect(access).toContain('this.orgs.signInLanding(db, user)');
    const can = body(auth, /\n {2}private readonly canSignIn = /);
    expect(can).toContain('this.orgs.accountById(db, userId)');
    expect(can).toContain('this.signInAccess(user, db)');
    expect(body(auth, /\n {2}private async issueNamedUser\(/)).toContain('isRetired(db, user.id)');
    expect(body(auth, /\n {2}private async breakGlassSession\(/)).toContain('this.issueNamedUser(user, landing.role, landing.projectId, tx)');
    const phone = read('auth/phone-sign-in.service.ts');
    expect(phone).toContain('export type SignInEligible = (db: Prisma.TransactionClient, userId: string) => Promise<boolean>;');
    const redeem = transactions(phone).find((block) => block.includes('eligible('));
    expect(redeem).toContain('eligible(tx, owner.id)');
  });
});
