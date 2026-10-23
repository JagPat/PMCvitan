import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { SERVER_SCHEMA_OF } from '@/data/storedActs';

/**
 * #1088 r1 (Codex 4349463894): the web read the server's request contracts by importing `apps/api/src/contracts.ts`,
 * so its build depended on API source and resolved `zod` through the API. It now has its own copy
 * (`src/data/queueContracts.ts`). This test reads both files as text and fails when any copied statement differs from
 * the server's, when the copy leaves out a statement one of its own uses, or when the web's source imports API source.
 */

const API = resolve(__dirname, '../../api/src');
const server = readFileSync(resolve(API, 'contracts.ts'), 'utf8');
const copy = readFileSync(resolve(__dirname, '../src/data/queueContracts.ts'), 'utf8');

type Parsed = { statements: Map<string, string>; imports: Map<string, string>; uses: Set<string> };
/** each top-level statement's text (with its own comments) by the names it declares, and each imported name's source */
function parse(text: string): Parsed {
  const sf = ts.createSourceFile('f.ts', text, ts.ScriptTarget.Latest, true);
  const statements = new Map<string, string>();
  const imports = new Map<string, string>();
  const uses = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const from = (st.moduleSpecifier as ts.StringLiteral).text;
      const bound = st.importClause?.namedBindings;
      if (bound && ts.isNamedImports(bound)) for (const e of bound.elements) imports.set(e.name.text, from);
      continue;
    }
    const names = ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText(sf))
      : 'name' in st && st.name && ts.isIdentifier(st.name as ts.Node) ? [(st.name as ts.Identifier).text] : [];
    // the statement's text from the end of the one before it, so a comment above it is compared too
    const own = st.getFullText(sf).replace(/^\s+/u, '');
    for (const name of names) statements.set(name, own);
    const visit = (n: ts.Node): void => { if (ts.isIdentifier(n)) uses.add(n.text); ts.forEachChild(n, visit); };
    visit(st);
  }
  return { statements, imports, uses };
}
/** the copied statements that differ from the server's, by name */
const drift = (from: Parsed, to: Parsed): string[] => [...to.statements].filter(([name, text]) => from.statements.get(name) !== text).map(([name]) => name);

describe('#1088 r1: the web’s copy of the queue contracts is the server’s, byte for byte', () => {
  const ours = parse(copy);
  const theirs = parse(server);

  it('every copied statement is the same-named server statement, comments included', () => {
    expect(ours.statements.size).toBeGreaterThan(0);
    expect(drift(theirs, ours)).toEqual([]);
  });

  it('the copy leaves out no server statement its own statements use', () => {
    const missing = [...ours.uses].filter((u) => theirs.statements.has(u) && !ours.statements.has(u));
    expect(missing).toEqual([]);
  });

  it('every name the copy imports is what the server file imports under that name', () => {
    for (const [name, from] of ours.imports) {
      const at = theirs.imports.get(name);
      if (name === 'parseCivilDate') {
        // the server takes it from its civil-date module, which re-exports the shared one
        expect(at).toBe('./common/civil-date');
        expect(readFileSync(resolve(API, 'common/civil-date.ts'), 'utf8')).toMatch(/export \{ parseCivilDate[^}]*\} from '@vitan\/shared';/u);
        expect(from).toBe('@vitan/shared');
      } else expect([name, from]).toEqual([name, at]);
    }
  });

  it('every schema the stored queue check names is in the copy', () => {
    const named = [...new Set(Object.values(SERVER_SCHEMA_OF).filter((x): x is NonNullable<typeof x> => x !== null)), 'siteVisitIdSchema'];
    expect(named.filter((x) => !ours.statements.has(x))).toEqual([]);
  });

  it('guard: one changed character in a server statement is found', () => {
    const changed = server.replace('export const approveSchema', 'export const approveSchema ');
    expect(changed).not.toBe(server);
    expect(drift(parse(changed), ours)).toEqual(['approveSchema']);
  });

  it('the web’s source imports no API source', () => {
    const root = resolve(__dirname, '../src');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(?:ts|tsx)$/u.test(f));
    const sideways = files.filter((f) => /(?:from\s+|import\s*\(\s*|import\s+)['"](?:\.\.\/)+api\//u.test(readFileSync(resolve(root, f), 'utf8')));
    expect(sideways).toEqual([]);
  });
});
