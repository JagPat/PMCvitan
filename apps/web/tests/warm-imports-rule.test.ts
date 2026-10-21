import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/**
 * A test file that resets modules and imports the app anew warms every app module it imports (`warm-imports.ts`), so no
 * test's 5 s is spent on the worker's first import of it. Read from the files themselves: no clock, no load.
 */
/** Every dynamic `import(...)` call in a file, read by TypeScript's own parser, not a pattern: the syntax decides what an
 *  import is, so no spacing, line break, comment or quote form hides one. The file is parsed as what its name says
 *  (`.ts` or `.tsx`), so a `.ts` file's `<T>` is never read as JSX. `typeof import(...)` is a type, not a call, and is
 *  not read. A call whose only argument is one plain string (any quote, a template with no `${`) is keyed by that
 *  module; any other (a substituting template, a concatenation, a variable, a second argument) cannot be warmed by name,
 *  so it is keyed by its text as written and is always a gap unless `UNWARMED` allows it. A call is warm only inside an
 *  `await warmImports(...)` statement at the file's top level, which runs while vitest collects the file: a warm-up in
 *  a test or a hook would spend that test's own time. */
const parsed = new Map<string, { resets: boolean; found: Array<{ key: string; warm: boolean }>; readable: boolean }>();
const parse = (src: string, name: string) => {
  const seen = parsed.get(`${name}\0${src}`);
  if (seen) return seen;
  const file = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
  // the parser's own syntax errors for this file, read through a program that holds only this file
  const host = ts.createCompilerHost({});
  host.getSourceFile = (n) => (n === name ? file : undefined);
  const readable = ts.createProgram([name], { noLib: true, noResolve: true, types: [] }, host).getSyntacticDiagnostics(file).length === 0;
  const found: Array<{ key: string; warm: boolean }> = [];
  let resets = false;
  const visit = (node: ts.Node, warm: boolean) => {
    // `vi.resetModules` however it is spaced or split across lines, or `vi['resetModules']`: called, or handed to a
    // hook as `beforeEach(vi.resetModules)`
    const target = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : null;
    const member = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
    if (member === 'resetModules' && target && ts.isIdentifier(target) && target.text === 'vi') resets = true;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg, ...more] = node.arguments;
      const named = arg !== undefined && more.length === 0 && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
      if (!named || arg.text.startsWith('@/')) found.push({ key: named ? arg.text : node.getText(file), warm });
    }
    const warmUp = ts.isExpressionStatement(node) && ts.isSourceFile(node.parent) && ts.isAwaitExpression(node.expression)
      && ts.isCallExpression(node.expression.expression) && ts.isIdentifier(node.expression.expression.expression)
      && node.expression.expression.expression.text === 'warmImports';
    ts.forEachChild(node, (child) => visit(child, warm || warmUp));
  };
  visit(file, false);
  const result = { resets, found, readable };
  parsed.set(`${name}\0${src}`, result);
  return result;
};
const calls = (src: string, name = 'fixture.ts') => parse(src, name).found;
/** Whether the file resets modules (`vi.resetModules`), read by the parser too, so no spacing or line break hides it. */
const resetsModules = (src: string, name = 'fixture.ts') => parse(src, name).resets;
const imported = (src: string, name = 'fixture.ts') => new Set(calls(src, name).filter((c) => !c.warm).map((c) => c.key));
/** Only a module named by one plain string can be warmed: a warm-up of any other call covers nothing. */
const warmed = (src: string, name = 'fixture.ts') => new Set(calls(src, name).filter((c) => c.warm && c.key.startsWith('@/')).map((c) => c.key));
/** A file's gaps: every app module it imports and does not warm, and every import that cannot be warmed by name. */
const gapsOf = (src: string, name = 'fixture.ts') => {
  const have = warmed(src, name);
  return [...imported(src, name)].filter((m) => !have.has(m));
};
/** An `UNWARMED` entry (`file: module`) is still needed while its file resets modules and still has that gap. The file
 *  name ends at the first ': '; the module may hold more (a template with a ternary, a second argument). */
const stillNeeded = (gap: string, read: (name: string) => string) => {
  const i = gap.indexOf(': ');
  const n = gap.slice(0, i);
  const m = gap.slice(i + 2);
  const src = read(n);
  return resetsModules(src, n) && gapsOf(src, n).includes(m);
};
/** The scan of one test file, parsed as what its name says. A file the parser cannot read cleanly as that kind is
 *  reported, never read on a guess: a `.tsx` file read as `.ts`, or a `.ts` file read as TSX, is a misread. */
const scan = (n: string, read: (name: string) => string) => {
  const src = read(n);
  if (!parse(src, n).readable) return [`${n}: cannot be read as ${n.endsWith('.tsx') ? 'TSX' : 'TypeScript'}`];
  if (!resetsModules(src, n)) return [];
  return gapsOf(src, n).map((m) => `${n}: ${m}`);
};

/** `file: module` pairs a file may import without warming, each with its reason. None today. */
const UNWARMED: Record<string, string> = {};

describe('the rule reads a dynamic import whichever way it is written (#792, Codex 4331287109)', () => {
  it.each([
    ['single quotes', "await import('@/store/store');"],
    ['double quotes', 'await import("@/store/store");'],
    ['a template with no substitution', 'await import(`@/store/store`);'],
  ])('finds an import in %s, and a warm-up written the same way covers it', (_form, line) => {
    expect([...imported(line)]).toEqual(['@/store/store']);
    expect(gapsOf(`await warmImports(() => ${line.slice('await '.length, -1)});\n${line}`)).toEqual([]);
  });

  it.each([
    ['a space', "await import ('@/store/store');"],
    ['a line break', "await import\n('@/store/store');"],
    ['a comment', "await import /* a note */ ('@/store/store');"],
  ])('finds an import with %s before its parenthesis (Codex 4331621460)', (_form, line) => {
    expect([...imported(line)]).toEqual(['@/store/store']);
    expect(gapsOf(line)).toEqual(['@/store/store']);
  });

  it('keeps a template that substitutes as written, so it is a gap no warm-up can name', () => {
    const src = "await warmImports(() => import('@/screens/SiteVisitsScreen'));\nawait import(`@/screens/${name}`);";
    expect(gapsOf(src)).toEqual(['import(`@/screens/${name}`)']);
  });

  it('reports an import it cannot read by name, such as a concatenation, as a gap no warm-up can name', () => {
    const src = "await warmImports(() => import('@/screens/SiteVisitsScreen'));\nawait import('@/screens/' + name);";
    expect(gapsOf(src)).toEqual(["import('@/screens/' + name)"]);
  });

  it('reads a comment inside the call, a second argument, and a warm-up over several lines', () => {
    expect([...imported("await import(/* @vite-ignore */ '@/store/store');")]).toEqual(['@/store/store']);
    expect(gapsOf("await import('@/store/store', { with: { type: 'json' } });")).toEqual(["import('@/store/store', { with: { type: 'json' } })"]);
    expect(gapsOf("await warmImports(\n  () => import('@/store/store'),\n);\nawait import('@/store/store');")).toEqual([]);
  });

  it.each([
    ['as written', 'vi.resetModules();'],
    ['with a space before its parenthesis', 'vi.resetModules ();'],
    ['split across lines', 'vi\n  .resetModules\n  ();'],
    ['by its name in brackets', "vi['resetModules']();"],
  ])('finds a file that resets modules %s (Codex 4331726371)', (_form, line) => {
    expect(resetsModules(line)).toBe(true);
  });

  it('finds a file that hands vi.resetModules to a hook', () => {
    expect(resetsModules('beforeEach(vi.resetModules);')).toBe(true);
  });

  it('does not take a mention of resetModules in a comment or a string', () => {
    expect(resetsModules("// vi.resetModules() is not called here\nconst s = 'vi.resetModules()';")).toBe(false);
  });

  it('counts a warm-up only at the top level, where it runs while the file is collected, not in a test or a hook', () => {
    for (const where of [
      "it('x', async () => { await warmImports(() => import('@/store/store')); });",
      "beforeAll(async () => { await warmImports(() => import('@/store/store')); });",
      "void warmImports(() => import('@/store/store'));",
      "if (false) await warmImports(() => import('@/store/store'));",
      "warmImports(() => import('@/store/store'));",
    ]) expect(gapsOf(`${where}\nawait import('@/store/store');`), where).toEqual(['@/store/store']);
  });

  it('reads a .ts file as TypeScript, so a generic arrow or a cast does not hide what follows', () => {
    const src = "const id = <T,>(x: T) => x;\nconst n = <number>id(1);\nvi.resetModules();\nawait import('@/store/store');";
    expect(resetsModules(src, 'a.test.ts')).toBe(true);
    expect(gapsOf(src, 'a.test.ts')).toEqual(['@/store/store']);
    const plain = "const id = <T>(x: T) => x;\nvi.resetModules();\nawait import('@/store/store');";
    expect(resetsModules(plain, 'a.test.ts')).toBe(true);
    expect(gapsOf(plain, 'a.test.ts')).toEqual(['@/store/store']);
  });

  it('never takes a warm-up of a call it cannot name as covering the same call', () => {
    expect(gapsOf('await warmImports(() => import(name));\nawait import(name);')).toEqual(['import(name)']);
  });

  it('keeps an UNWARMED entry only while its file resets modules and still has that gap, whatever the module holds', () => {
    const files: Record<string, string> = {
      'resets.test.ts': "vi.resetModules();\nawait import(`@/screens/${role === 'pmc' ? 'Pmc' : 'Eng'}Screen`);",
      'stopped.test.ts': "await import(`@/screens/${role === 'pmc' ? 'Pmc' : 'Eng'}Screen`);",
    };
    const read = (n: string) => files[n]!;
    const key = "import(`@/screens/${role === 'pmc' ? 'Pmc' : 'Eng'}Screen`)";
    expect(stillNeeded(`resets.test.ts: ${key}`, read)).toBe(true);
    expect(stillNeeded(`stopped.test.ts: ${key}`, read)).toBe(false);
    expect(stillNeeded("resets.test.ts: @/store/store", read)).toBe(false);
  });

  it('reads each test file as what its name says, and reports one it cannot read that way', () => {
    const files: Record<string, string> = {
      'a.test.tsx': "const el = <div title={'a'}>{'x'}</div>;\nvi.resetModules();\nawait import('@/store/store');",
      'b.test.ts': "const id = <T>(x: T) => x;\nvi.resetModules();\nawait import('@/store/store');",
      'c.test.ts': "const el = <div>{'x'}</div>;\nvi.resetModules();\nawait import('@/store/store');",
    };
    const read = (n: string) => files[n]!;
    expect(scan('a.test.tsx', read)).toEqual(['a.test.tsx: @/store/store']);
    expect(scan('b.test.ts', read)).toEqual(['b.test.ts: @/store/store']);
    expect(scan('c.test.ts', read)).toEqual(['c.test.ts: cannot be read as TypeScript']);
  });

  it('leaves type-only imports and package imports alone', () => {
    expect([...imported("type S = typeof import('@/store/store');\nawait import('react');")]).toEqual([]);
  });
});

describe('every test file that resets modules warms what it imports (#792)', () => {
  const files = readdirSync(__dirname).filter((n) => /\.test\.tsx?$/.test(n));

  const read = (n: string) => readFileSync(resolve(__dirname, n), 'utf8');
  // every file is read and parsed here, while vitest collects this file, so no test's 5 s is spent on it
  const resetting = files.filter((n) => resetsModules(read(n), n));
  const gaps = files.flatMap((n) => scan(n, read));

  it('finds the files it checks', () => {
    expect(resetting.length).toBeGreaterThan(0);
  });

  it('each one calls warmImports with every app module it imports', () => {
    expect(gaps.filter((gap) => !(gap in UNWARMED))).toEqual([]);
  });

  it('each allowed exception names a reason and is still needed', () => {
    for (const [gap, reason] of Object.entries(UNWARMED)) {
      expect(reason.trim(), gap).not.toBe('');
      expect(stillNeeded(gap, read), gap).toBe(true);
    }
  });
});
