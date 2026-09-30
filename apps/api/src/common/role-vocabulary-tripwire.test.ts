import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TOKEN_ROLES, type Role as SharedRole, type TokenRole } from '@vitan/shared';
import type { Role as ApiRole } from './auth';
import type { PushRole } from '../platform/external-effects';
import { ROLE_LABEL } from './actor';
import { KNOWN_ROLES } from '../platform/module-registry/registry';
import { decisionsManifest } from '../decisions/decisions.manifest';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5a — the ROLE VOCABULARY tripwire (§A.1, "EVERY mirror of it").
 *
 * `architect` joins `TokenRole` and every mirror of it, delivered DARK: 4d-i's reservation doors refuse
 * any `Membership` or `User` row carrying the role until 4d-iii, so no token can carry it and nothing
 * here is reachable yet. The tripwire keeps the vocabulary whole as the role is fanned out unit by unit:
 *
 * - the TYPE mirrors (the API's `Role`, the shared `Role`, `PushRole`) equal the shared `TokenRole`,
 *   checked at compile time;
 * - the RUNTIME mirrors (the registry's `KNOWN_ROLES`, the audit `ROLE_LABEL`, the decisions manifest's
 *   permissions) name every role;
 * - a SCAN finds every hard-coded role list, union or role-keyed map in shared, API and web that names
 *   at least four of the delivered member roles — a vocabulary, or a ceiling that could be one — and
 *   each is registered with a verdict the literal must bear out: `answered` names `architect`;
 *   `excludes: <why>` must not; `owed by <unit>: <what>` names the unit that answers it; `not a
 *   role: <what>` names the other axis (a firm's kind).
 *
 * The web offers the persona and the designation only as the shell's `rollout.phase6_4d` admits them
 * (4d-ii-b / B2): `RESERVED_ROLES` in `apps/web/src/lib/screens.ts` names the roles hidden while the
 * doors stand, `rolesFor(rollout)` is the ONE list every switcher and picker reads (through the store's
 * `selectRoles`), and the decider pickers offer `architect` under the same read. The pins below hold
 * that shape: no static persona list may return.
 */
const REPO = join(__dirname, '..', '..', '..', '..');

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const apiRoleIsTokenRole: Equal<ApiRole, TokenRole> = true;
const sharedRoleIsMemberVocabulary: Equal<SharedRole, Exclude<TokenRole, 'worker'>> = true;
const pushRoleIsMemberVocabulary: Equal<PushRole, Exclude<TokenRole, 'worker'>> = true;

const MEMBER_ROLES = TOKEN_ROLES.filter((r) => r !== 'worker');
const DELIVERED_MEMBER_ROLES = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];

describe('the role vocabulary tripwire (4d-ii-a / A5a)', () => {
  it('the type mirrors equal the shared TokenRole (compile-time)', () => {
    expect([apiRoleIsTokenRole, sharedRoleIsMemberVocabulary, pushRoleIsMemberVocabulary]).toEqual([true, true, true]);
  });

  it('the runtime mirrors name every role', () => {
    expect(TOKEN_ROLES.filter((r) => !KNOWN_ROLES.has(r)), 'the registry’s KNOWN_ROLES').toEqual([]);
    expect(TOKEN_ROLES.filter((r) => !(r in ROLE_LABEL)), 'the audit ROLE_LABEL').toEqual([]);
    expect([...decisionsManifest.permissions].sort(), 'the decisions manifest’s permissions').toEqual([...MEMBER_ROLES].sort());
  });

  /** Source with its comments blanked (line numbers kept), so a list quoted in a comment is not code. */
  const code = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));

  /** The name a literal is bound to: the key or variable just before it, or `''`. */
  const boundName = (src: string, at: number): string =>
    src.slice(Math.max(0, at - 120), at).match(/(['"]?[\w.$]+['"]?)\s*(?::[^=\n]*?)?[:=]\s*(?:z\.enum\(|new Set\()?\s*$/)?.[1]?.replace(/['"]/g, '') ?? '';

  /** The top-level text of the object literal opening at `open`, nested braces emptied. */
  const topLevel = (src: string, open: number): string => {
    let depth = 0;
    let out = '';
    for (let i = open; i < Math.min(src.length, open + 6000); i++) {
      const c = src[i]!;
      if (c === '{') { depth++; if (depth === 1) continue; }
      if (c === '}') { depth--; if (depth === 0) return out; }
      if (depth === 1) out += c;
    }
    return '';
  };

  type Verdict = 'answered' | `excludes: ${string}` | `owed by ${string}` | `not a role: ${string}`;
  const ROLE_LISTS: Record<string, Verdict> = {
    // shared
    'packages/shared/src/domain/types.ts :: union TokenRole': 'answered',
    'packages/shared/src/domain/types.ts :: list TOKEN_ROLES': 'answered',
    'packages/shared/src/domain/policy.ts :: list decision.approve': 'answered',
    // 4d-ii-a / A8a — forward authority is the holder + pmc + architect: every holder-capable role at the route
    'packages/shared/src/domain/policy.ts :: list decision.forward': 'answered',
    'packages/shared/src/domain/policy.ts :: list decision.updateDraft': 'answered',
    'packages/shared/src/domain/policy.ts :: list decision.change': 'excludes: the architect’s change path is the countersign disagreement, never a standard change request (§A.1)',
    'packages/shared/src/domain/policy.ts :: list decision.withdrawChange': 'answered',
    'packages/shared/src/domain/policy.ts :: list consultation.respond': 'answered',
    'packages/shared/src/domain/policy.ts :: list org.create': 'excludes: creating an organization is never the architect’s (§A.1, deliberately NOT)',
    'packages/shared/src/domain/policy.ts :: list project.read': 'answered',
    'packages/shared/src/domain/policy.ts :: list members.read': 'answered',
    'packages/shared/src/domain/policy.ts :: list companies.read': 'answered',
    // API
    'apps/api/src/common/auth.ts :: union Role': 'answered',
    'apps/api/src/common/actor.ts :: map ROLE_LABEL': 'answered',
    'apps/api/src/decisions/decisions.manifest.ts :: list permissions': 'answered',
    'apps/api/src/platform/external-effects.ts :: union PushRole': 'answered',
    'apps/api/src/contracts.ts :: list role': 'answered',
    'apps/api/src/contracts.ts :: list projectRole': 'answered',
    // 4d-ii-a / A7d — the targeted ceilings, widened with the catalog generation
    'apps/api/src/platform/external-effects.ts :: list decision.published': 'answered',
    'apps/api/src/platform/external-effects.ts :: list decision.consultation_requested': 'answered',
    'apps/api/src/platform/external-effects.ts :: list decision.forwarded': 'answered',
    // web
    'apps/web/src/lib/screens.ts :: map keys': 'answered',
    'apps/web/src/lib/screens.ts :: map ROLE_LABEL': 'answered',
    'apps/web/src/lib/screens.ts :: map ROLE_SUBTITLE': 'answered',
    // 4d-ii-b / B2 — the Team screen's list and label map are gone: its pickers read the store's
    // rollout-aware `selectRoles` and the shared `ROLE_LABEL` (registered above), so nothing there is a
    // hand-written vocabulary any more
    'apps/web/src/screens/PortfolioScreen.tsx :: map ROLE_LABEL': 'answered',
    'apps/web/src/screens/DrawingsScreen.tsx :: map ROLE_SHORT': 'answered',
    'apps/web/src/screens/TeamScreen.tsx :: map COMPANY_KIND_LABEL': 'not a role: a firm’s kind, a different axis that already spells `architect` (§A.1, untouched)',
  };

  it('every role list, union and role-keyed map naming the member vocabulary is registered with a verdict it bears out', () => {
    const found: Array<{ id: string; names: string[] }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const src = code(readFileSync(full, 'utf8'));
        const file = relative(REPO, full).split('\\').join('/');
        const seen = new Map<string, number>();
        const add = (kind: string, name: string, names: string[]) => {
          if (DELIVERED_MEMBER_ROLES.filter((r) => names.includes(r)).length < 4) return;
          const base = `${file} :: ${kind} ${name}`;
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          found.push({ id: n > 1 ? `${base} #${n}` : base, names });
        };
        // a list: an array literal made only of role names
        for (const m of src.matchAll(/\[([^[\]]*)\]/g)) {
          const items = m[1]!.replace(/\s+as\s+[^,\]]+/g, '').split(',').map((x) => x.trim()).filter(Boolean);
          const lits = items.map((x) => /^'([a-z_]+)'$/.exec(x)?.[1]);
          if (lits.length && lits.every((l): l is string => !!l && (TOKEN_ROLES as readonly string[]).includes(l))) add('list', boundName(src, m.index!), lits as string[]);
        }
        // a union type made only of role names
        for (const m of src.matchAll(/type\s+(\w+)\s*=\s*((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+')/g)) {
          const lits = [...m[2]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
          if (lits.every((l) => (TOKEN_ROLES as readonly string[]).includes(l))) add('union', m[1]!, lits);
        }
        // a role-keyed map: an object literal whose top-level keys include the member roles
        for (const m of src.matchAll(/(\w+)\s*(?::[^=\n]*?)?=\s*\{|(\w+)\s*:\s*\{/g)) {
          const keys = [...topLevel(src, m.index! + m[0].length - 1).matchAll(/(?:^|[\s,])'?(\w+)'?\s*:/g)].map((k) => k[1]!);
          add('map', m[1] ?? m[2]!, keys);
        }
      }
    };
    for (const root of ['packages/shared/src', 'apps/api/src', 'apps/web/src']) walk(join(REPO, root));

    expect(found.map((f) => f.id).filter((id) => !(id in ROLE_LISTS)), 'register every role vocabulary here, with its verdict').toEqual([]);
    for (const f of found) {
      const verdict = ROLE_LISTS[f.id]!;
      if (verdict === 'answered') expect(f.names, `${f.id} is ANSWERED only if it names the role`).toContain('architect');
      if (verdict.startsWith('excludes:')) expect(f.names, `${f.id} EXCLUDES the role, so it must not name it`).not.toContain('architect');
    }
    // and no registration outlives its literal
    expect(Object.keys(ROLE_LISTS).filter((id) => !found.some((f) => f.id === id))).toEqual([]);
  });

  it('the web offers the persona only as the rollout admits it: one reserved list, one rollout-aware selector, no static persona list', () => {
    const web = (rel: string) => readFileSync(join(REPO, 'apps/web/src', rel), 'utf8');
    const screens = web('lib/screens.ts');
    // 4d-ii-b / B2 — the reserved roles and the ONE list every switcher and picker reads
    expect(screens).toMatch(/export const RESERVED_ROLES: readonly Role\[\] = \['architect'\];/);
    expect(screens).toMatch(/const UNRESERVED_ROLES: readonly Role\[\] = ALL_ROLES\.filter\(\(r\) => !RESERVED_ROLES\.includes\(r\)\);/);
    expect(screens).toMatch(/export function rolesFor\(rollout: Phase6_4dRollout\): readonly Role\[\] \{\s*return rollout === 'open' \? ALL_ROLES : UNRESERVED_ROLES;/);
    expect(screens).not.toMatch(/export const ROLES\b/); // the static persona list may not return
    expect(screens).not.toMatch(/PERSONAS_OWED/);
    // every switcher and picker reads the store's selector, never a list of its own
    for (const rel of ['layout/RolePicker.tsx', 'layout/TopBar.tsx', 'screens/TeamScreen.tsx']) {
      expect(web(rel), `${rel} reads the rollout-aware selectRoles`).toMatch(/selectRoles/);
      expect(web(rel), `${rel} imports no static ROLES`).not.toMatch(/\bROLES\b/);
    }
    // the decider pickers offer the architect designation under the same read
    for (const rel of ['screens/modals/IssueDecisionModal.tsx', 'screens/DraftsScreen.tsx']) {
      expect(web(rel), `${rel} gates the architect designation on the rollout`).toMatch(/\{chainOpen && <option value="architect">/);
      expect(web(rel)).toMatch(/selectPhase6_4dOpen/);
    }
  });
});
