/**
 * Redbracket ID A3 — structural pin: an account a first Redbracket ID sign-in set aside never gets a session or a new
 * credential again, because every place that could give it one asks the ONE predicate (`isRetired`). Codex round 1
 * on #1306 found doors that did not (phone code, project switch, a reset code sent before retirement); the fix moved
 * the question to the shared points, and this test keeps it there: a new door that signs a token or opens a credential
 * without going through them fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [relative(SRC, path)] : [];
  });
}

/** The text of `name`'s body in `text`: from its declaration to the next member at the same indent. */
function body(text: string, declaration: RegExp): string {
  const start = text.search(declaration);
  expect(start, String(declaration)).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const end = rest.slice(1).search(/\n {2}(?:private |async |public |readonly |\/\*\*|[a-zA-Z]+\()/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('retirement gate (structural)', () => {
  const auth = read('auth/auth.service.ts');

  it('a JWT is signed in exactly one place, and a named account only through issueNamedUser, which asks isRetired', () => {
    const signers = sources(SRC).filter((path) => /\bjwt\.sign(Async)?\(/.test(read(path)));
    expect(signers).toEqual(['auth/auth.service.ts']);
    // whatever the signer is called: a file that can reach a JWT library and calls any `.sign(` / `.signAsync(` is
    // this one (an HMAC `.sign` elsewhere, e.g. media's signed URLs, has no JWT library to sign a session with)
    const jwtCapable = sources(SRC).filter((path) => /@nestjs\/jwt|jsonwebtoken|from 'jose'|JwtService/.test(read(path)));
    const anySigner = jwtCapable.filter((path) => /\.sign(Async)?\(/.test(read(path)));
    expect(anySigner).toEqual(['auth/auth.service.ts']);
    expect(auth.match(/\.sign(Async)?\(/g)).toHaveLength(1);
    expect(auth.match(/this\.jwt\.sign\(/g)).toHaveLength(1);
    expect(body(auth, /\n {2}private issue\(/)).toContain('this.jwt.sign(');
    // the only other callers of issue() are the two account-less tokens: the synthetic dev persona and a worker device
    const issues = [...auth.matchAll(/this\.issue\(([^,]+),/g)].map((m) => m[1]!.trim());
    expect(issues).toEqual(['user.id', '`dev-${input.role}`', '`worker-${device.id}`']);
    const named = body(auth, /\n {2}private async issueNamedUser\(/);
    expect(named).toContain('this.issue(user.id');
    expect(named).toMatch(/if \(await isRetired\(db, user\.id\)\) throw new UnauthorizedException\(RETIRED\)/);
    expect(named).toMatch(/db: Prisma\.TransactionClient = this\.prisma,/);
  });

  it('the sign-in access rule (which also decides whether a phone code is sent) asks isRetired first', () => {
    const access = body(auth, /\n {2}private async signInAccess\(/);
    expect(access.indexOf('isRetired(')).toBeGreaterThan(0);
    expect(access.indexOf('isRetired(')).toBeLessThan(access.indexOf('signInLanding('));
  });

  it('the project switch signs with the version the caller\'s own token carried', () => {
    const swap = body(auth, /\n {2}async switchProject\(/);
    expect(swap).toMatch(/issueNamedUser\(\{ id: user\.id, credentialVersion: callerVersion \}/);
    expect(read('auth/auth.controller.ts')).toContain('this.auth.switchProject(user.sub, body.projectId, user.credentialVersion ?? 0)');
  });

  it('every password-credential account read goes through withRetirement, which asks isRetired', () => {
    const passwords = read('auth/password-credentials.service.ts');
    const reads = passwords.match(/this\.orgs\.credentialAccount\(/g) ?? [];
    const wrapped = passwords.match(/this\.withRetirement\(db, await this\.orgs\.credentialAccount\(/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect(wrapped).toHaveLength(reads.length);
    expect(body(passwords, /\n {2}private async withRetirement</)).toContain('isRetired(db, account.id)');
    // and nothing else in the api reads credential eligibility around it
    expect(sources(SRC).filter((path) => read(path).includes('.credentialAccount(') && !path.startsWith('orgs/'))).toEqual(['auth/password-credentials.service.ts']);
  });

  it('isRetired is asked exactly where this file says, and nowhere answers it another way', () => {
    const callers = sources(SRC).filter((path) => /\bisRetired\(/.test(read(path))).sort();
    // the ONE predicate is defined with the record's platform owner (A4b r1, Codex 4451627330), which auth and orgs both ask
    expect(callers).toEqual(['auth/auth.service.ts', 'auth/password-credentials.service.ts', 'orgs/live-standing.ts', 'orgs/members.service.ts', 'orgs/operator-owner-reseat.ts', 'orgs/orgs.service.ts', 'platform/identity-retirement.query.ts']);
    const others = sources(SRC).filter((path) => /identityRetirement\.(count|findFirst|findUnique|findMany)\(/.test(read(path)));
    // every read of the platform-owned record is the platform's own (A4b r2, Codex 4452016253): auth and the operator door ask it
    expect(others).toEqual(['platform/identity-retirement.query.ts']);
    expect(read('platform/identity-retirement.query.ts').match(/identityRetirement\.\w+\(/g)).toEqual(['identityRetirement.count(', 'identityRetirement.findMany(', 'identityRetirement.findFirst(', 'identityRetirement.findUnique(']);
    // and no platform file reaches into the auth module for it
    expect(sources(SRC).filter((path) => path.startsWith('platform/') && /from '(\.\.\/)+auth\/identity\//.test(read(path)))).toEqual([]);
    // no orgs file reaches into the auth module for it
    expect(sources(SRC).filter((path) => path.startsWith('orgs/') && /from '\.\.\/auth\/identity\//.test(read(path)))).toEqual([]);
  });
});
