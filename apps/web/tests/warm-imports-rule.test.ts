import { describe, it, expect } from 'vitest';
import { configDefaults } from 'vitest/config';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { createFilter } from 'vite';

/**
 * A test file warms every app module it imports dynamically (`warm-imports.ts`), so no test's 5 s is spent on the
 * worker's first import of it. Read from the files themselves: no clock, no load.
 *
 * The rule fails closed: it credits only the forms it positively recognises and treats everything else as a gap. Every
 * round of review found one more form the rule did not model, because it credited what it did not recognise; and while
 * the rule had to detect resets, every way of reaching `vi.resetModules` was one more such form. It no longer asks
 * whether a file resets modules: a module loaded at collection is warm whether the file resets or not. So:
 * - in every test file Vitest collects, every dynamic load of an app module is a gap until a top-level
 *   `await warmImports(...)` of the real helper names it with the same plain string, or a top-level static import (not
 *   one only of types) loads the same specifier. An import is an app import unless its specifier is a package (bare, and
 *   no alias of vite.config.ts);
 * - a load that cannot be named is always a gap: an `import(...)` whose argument is not one plain string; `importActual`
 *   or `importMock` named in code; any use of the names `vi` or `vitest` other than to read a member named literally
 *   (`vi.fn`, `vi['fn']`), as an unaliased named import or in a type (`typeof vi.fn`), since any other use (a computed
 *   key, a cast, an alias, `Reflect.get`) could reach a loader unseen; a member named `vi` or `vitest` on any other
 *   object (`globalThis.vi`); any import of 'vitest' that is not named (a namespace, a default, `require`, `import()`, a
 *   re-export), where any re-export or `require` of it is a gap even when it carries only types, while a type-only
 *   import (`import type * as T`, `import type V`) is clear; and any `import.meta.glob…` or `import.meta[...]`. The rule
 *   reads names: a route to Vitest's object that uses neither name nor imports 'vitest' (`globalThis` read by a
 *   computed key) is not read;
 * - a warm-up credits only an import its loader necessarily runs: the loader's direct return, or a direct element of a
 *   directly returned `Promise.all([...])`;
 * - the files read are the files Vitest collects: every file under the web app's folder (node_modules aside) that
 *   vite.config.ts's include and exclude select, matched by Vite's own filter on paths relative to the folder. A setting
 *   the rule does not model, another config file, a symlinked folder, or an exclude that would collect node_modules stops it.
 * Anything left over goes in `UNWARMED`, with a reason, or the rule fails.
 */
const ROOT = resolve(__dirname, '..');
const HELPER = resolve(ROOT, 'tests/warm-imports');

/** Vitest's collection settings and the aliases, read from a vite config by the parser. A setting the rule does not model
 *  (a spread, a computed key, a value that is not a literal, `root`, `dir`, `includeSource`, `projects`, `workspace`) is
 *  never guessed at: the rule stops with that setting named. */
const readConfig = (src: string) => {
  const file = ts.createSourceFile('vite.config.ts', src, ts.ScriptTarget.Latest, true);
  const stop = (what: string): never => { throw new Error(`vite.config.ts: the warm-imports rule cannot read ${what}`); };
  const exported = file.statements.find(ts.isExportAssignment)?.expression;
  const config = exported && ts.isCallExpression(exported) && ts.isIdentifier(exported.expression)
    && exported.expression.text === 'defineConfig' && exported.arguments.length === 1 ? exported.arguments[0] : undefined;
  if (!config || !ts.isObjectLiteralExpression(config)) return stop('its export: it is not `defineConfig({ ... })`');
  const fields = (obj: ts.ObjectLiteralExpression, where: string) => new Map(obj.properties.map((p) => {
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return stop(`${where}: ${p.getText(file)}`);
    return [p.name.text, p.initializer] as const;
  }));
  const object = (node: ts.Expression | undefined, where: string) => (node === undefined ? new Map<string, ts.Expression>()
    : ts.isObjectLiteralExpression(node) ? fields(node, where) : stop(where));
  const strings = (node: ts.Expression, where: string) => (ts.isArrayLiteralExpression(node)
    ? node.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : stop(`${where}: ${e.getText(file)}`))) : stop(where));
  const top = fields(config, 'the config');
  if (top.has('root')) stop('root');
  const test = object(top.get('test'), 'test');
  for (const key of ['root', 'dir', 'includeSource', 'projects', 'workspace']) if (test.has(key)) stop(`test.${key}`);
  const alias = top.get('resolve') ? object(object(top.get('resolve'), 'resolve').get('alias'), 'resolve.alias') : new Map();
  return {
    include: test.has('include') ? strings(test.get('include')!, 'test.include') : configDefaults.include,
    exclude: test.has('exclude') ? strings(test.get('exclude')!, 'test.exclude') : configDefaults.exclude,
    aliases: [...alias.keys()],
  };
};
/** The files under `root` that Vitest collects with `config`'s include and exclude, matched by Vite's own filter as Vitest
 *  does (dot paths included), on paths relative to `root`, so no folder above it (a `dist`, a `node_modules`) decides
 *  anything. Read by a plain walk, which runs on every Node the repo supports. What the walk cannot match to Vitest is
 *  refused: a second config file Vitest would read, a symlinked folder, or an exclude that leaves a node_modules folder
 *  (which the walk skips), at the top or nested, to be collected. A symlink that cannot be followed (to nothing, as an
 *  editor's lock file is; through a file; or in a loop) is no file and is skipped, as Vitest skips it. */
const collect = (root: string, config: ReturnType<typeof readConfig>) => {
  const stop = (what: string): never => { throw new Error(`${what}: the warm-imports rule cannot match Vitest's own file list`); };
  const others = readdirSync(root).filter((n) => /^vitest\.(config|workspace)\./.test(n) || (/^vite\.config\./.test(n) && n !== 'vite.config.ts'));
  if (others.length > 0) stop(others.join(', '));
  const collected = createFilter(config.include, config.exclude, { resolve: false });
  for (const probe of ['node_modules/p/a.test.ts', 'x/node_modules/p/a.test.ts'])
    if (collected(probe)) stop(`an exclude that collects ${probe}`);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const n = dir ? `${dir}/${e.name}` : e.name;
      let st: ReturnType<typeof statSync> | undefined;
      if (e.isSymbolicLink()) { try { st = statSync(join(root, n)); } catch { continue; } }
      if (st?.isDirectory()) stop(`${n} (a symlinked folder)`);
      if (e.isDirectory()) walk(n);
      else files.push(n);
    }
  };
  walk('');
  return files.filter((n) => collected(n)).sort();
};
const CONFIG = readConfig(readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8'));

/** A package specifier (`react`, `node:fs`, `@testing-library/react`) is left alone; anything else is the app's own code:
 *  an alias of vite.config.ts (`@/…`, `@vitan/shared`), a relative path or an absolute one. */
const isApp = (spec: string, aliases: string[]) =>
  spec.startsWith('.') || spec.startsWith('/') || aliases.some((a) => spec === a || spec.startsWith(`${a}/`));
const isImport = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
const bare = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) ? bare(node.expression) : node;
/** The imports a loader necessarily runs: its direct return, or each direct element of a directly returned
 *  `Promise.all([...])`. Anything nested, deferred or conditional is run only maybe, so it earns no credit. */
const loaded = (arg: ts.Expression): ts.CallExpression[] => {
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return [];
  const body = arg.body;
  const only = ts.isBlock(body) ? body.statements : undefined;
  const result = only === undefined ? (body as ts.Expression)
    : only.length === 1 && ts.isReturnStatement(only[0]!) && only[0].expression ? only[0].expression : undefined;
  if (!result) return [];
  const e = bare(result);
  if (isImport(e)) return [e];
  const all = ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)
    && e.expression.expression.text === 'Promise' && e.expression.name.text === 'all' && e.arguments.length === 1
    && ts.isArrayLiteralExpression(e.arguments[0]!) ? e.arguments[0].elements : [];
  return all.map(bare).filter(isImport);
};
/** Vitest's loaders that take a module by name, and the names of Vitest's object, by patterns so this file names none
 *  of them in code. */
const LOADERS = /^import(Actual|Mock)$/;
const VITEST = /^vi(test)?$/;
/** Whether a node is part of a type, which runs nothing. An instantiation expression (`f<T>`) and a class's `extends`
 *  are `ExpressionWithTypeArguments`, which TypeScript counts as a type node, but their expression runs. */
const inType = (node: ts.Node): boolean => !ts.isSourceFile(node)
  && ((ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) || inType(node.parent));
/** Whether the name `vi` or `vitest`, as an identifier or a key, is used in a way the rule cannot follow to the member it
 *  reaches: anything but the receiver of a member named literally, an unaliased named import, a declared name, or a
 *  type. A member of that name on any other object, by name or by key, is Vitest's object too (`globalThis.vi`); and so
 *  is 'vitest' imported other than by name (a namespace, a default, `require`, `import()`, a re-export). */
const reachesVitest = (node: ts.Node) => {
  if (!(ts.isIdentifier(node) || ts.isStringLiteralLike(node)) || !VITEST.test(node.text) || inType(node)) return false;
  const p = node.parent;
  if (ts.isStringLiteralLike(node)) {
    if (!ts.isImportDeclaration(p)) return true;
    const c = p.importClause;
    return /^vitest$/.test(node.text) && c !== undefined && !c.isTypeOnly
      && (c.name !== undefined || (c.namedBindings !== undefined && ts.isNamespaceImport(c.namedBindings)));
  }
  if (ts.isPropertyAccessExpression(p)) return p.name === node;
  if (ts.isElementAccessExpression(p) && p.expression === node) return !ts.isStringLiteralLike(p.argumentExpression);
  if (ts.isImportSpecifier(p)) return p.propertyName !== undefined;
  if (ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  return !((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isPropertyAssignment(p)
    || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node);
};
/** The text a load the rule cannot name is keyed by: the call or the declaration it is part of, whichever is nearer, or
 *  else the expression that holds it. */
const keyOf = (node: ts.Node, file: ts.SourceFile) => {
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent)
    if (ts.isCallExpression(n) || ts.isVariableDeclaration(n)) return n.getText(file);
  return node.parent.getText(file);
};

/** One file read by TypeScript's own parser, as what its name says (`.ts` or `.tsx`), not a pattern: the syntax decides
 *  what an import and a warm-up are, so no spacing, line break, comment or quote form hides one, and
 *  `typeof import(...)` is a type, not a call. An app import named by one plain string (any quote, a template with no
 *  `${`) is keyed by that string; any other app import (a substituting template, a concatenation, a variable, a second
 *  argument) is keyed by its text and can never be warmed. Names are relative to the web app's folder. */
const parsed = new Map<string, { found: Array<{ key: string; warm: boolean }>; statics: Set<string>; readable: boolean }>();
const parse = (src: string, name: string, aliases = CONFIG.aliases) => {
  const seen = parsed.get(`${name}\0${src}`);
  if (seen) return seen;
  const file = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true);
  // the parser's own syntax errors for this file, read through a program that holds only this file
  const host = ts.createCompilerHost({});
  host.getSourceFile = (n) => (n === name ? file : undefined);
  const readable = ts.createProgram([name], { noLib: true, noResolve: true, types: [] }, host).getSyntacticDiagnostics(file).length === 0;
  // the real helper, under its own name: a local function of that name may not run what it is handed
  const helper = file.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
    && s.moduleSpecifier.text.startsWith('.') && !s.importClause?.isTypeOnly
    && resolve(ROOT, dirname(name), s.moduleSpecifier.text).replace(/\.[cm]?[jt]sx?$/, '') === HELPER
    && s.importClause?.namedBindings !== undefined && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some((e) => !e.propertyName && e.name.text === 'warmImports' && !e.isTypeOnly));
  const credited = new Set<ts.Node>();
  if (helper) for (const s of file.statements) {
    const call = ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression) ? s.expression.expression : undefined;
    if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'warmImports') {
      for (const arg of call.arguments) for (const i of loaded(arg)) credited.add(i);
    }
  }
  // what a top-level static import loads while the file is collected: not one only of types
  const statics = new Set<string>();
  for (const s of file.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.importClause?.isTypeOnly) continue;
    const c = s.importClause;
    const named = c?.namedBindings;
    const runs = !c || c.name !== undefined || (named !== undefined && (ts.isNamespaceImport(named) || named.elements.some((e) => !e.isTypeOnly)));
    if (runs) statics.add(s.moduleSpecifier.text);
  }
  const found: Array<{ key: string; warm: boolean }> = [];
  const visit = (node: ts.Node) => {
    // loads the rule cannot name, each a gap keyed by its text: `importActual` or `importMock` named in code (a member, a
    // key in brackets, a destructured name); the names `vi` and `vitest` used other than to read a member named
    // literally, and 'vitest' imported other than by name, which could reach either unseen; and `import.meta` used other
    // than to read a member not named glob…
    if (((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && LOADERS.test(node.text)) || reachesVitest(node)) {
      found.push({ key: keyOf(node, file), warm: false });
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && !node.parent.name.text.startsWith('glob'))) {
      found.push({ key: keyOf(node, file), warm: false });
    }
    if (isImport(node)) {
      const [arg, ...more] = node.arguments;
      const named = arg !== undefined && more.length === 0 && ts.isStringLiteralLike(arg);
      if (!named) found.push({ key: node.getText(file), warm: false });
      else if (isApp(arg.text, aliases)) found.push({ key: arg.text, warm: credited.has(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const result = { found, statics, readable };
  parsed.set(`${name}\0${src}`, result);
  return result;
};
const FIXTURE = 'tests/fixture.ts';
const imported = (src: string, name = FIXTURE) => new Set(parse(src, name).found.filter((c) => !c.warm).map((c) => c.key));
const warmed = (src: string, name = FIXTURE) => new Set(parse(src, name).found.filter((c) => c.warm).map((c) => c.key));
/** A file's gaps: every app load that neither a warm-up nor a top-level static import of the same specifier covers, and
 *  every load that cannot be named. */
const gapsOf = (src: string, name = FIXTURE) => {
  const { statics } = parse(src, name);
  const have = warmed(src, name);
  return [...imported(src, name)].filter((m) => !have.has(m) && !statics.has(m));
};
/** The scan of one test file, parsed as what its name says. A file the parser cannot read cleanly as that kind is
 *  reported, never read on a guess: a `.tsx` file read as `.ts`, or a `.ts` file read as TSX, is a misread. */
const scan = (n: string, read: (name: string) => string) => {
  const src = read(n);
  if (!parse(src, n).readable) return [`${n}: cannot be read as ${n.endsWith('.tsx') ? 'TSX' : 'TypeScript'}`];
  return gapsOf(src, n).map((m) => `${n}: ${m}`);
};
/** An `UNWARMED` entry (`file: module`) is still needed while the scan of its file still reports it. The file name ends
 *  at the first ': '; the module may hold more (a template with a ternary, a second argument). */
const stillNeeded = (gap: string, read: (name: string) => string) => scan(gap.slice(0, gap.indexOf(': ')), read).includes(gap);

/** `file: module` pairs a file may import without warming, each with its reason. None today. */
const UNWARMED: Record<string, string> = {};

/** The real helper, imported as the files import it, for fixtures that warm. */
const WARM = "import { warmImports } from './warm-imports';\n";

describe('the rule reads a dynamic import whichever way it is written (#792, Codex 4331287109)', () => {
  it.each([
    ['single quotes', "await import('@/store/store');"],
    ['double quotes', 'await import("@/store/store");'],
    ['a template with no substitution', 'await import(`@/store/store`);'],
  ])('finds an import in %s, and a warm-up written the same way covers it', (_form, line) => {
    expect([...imported(line)]).toEqual(['@/store/store']);
    expect(gapsOf(`${WARM}await warmImports(() => ${line.slice('await '.length, -1)});\n${line}`)).toEqual([]);
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
    const src = `${WARM}await warmImports(() => import('@/screens/SiteVisitsScreen'));\nawait import(\`@/screens/\${name}\`);`;
    expect(gapsOf(src)).toEqual(['import(`@/screens/${name}`)']);
  });

  it('reports an import it cannot read by name, such as a concatenation, as a gap no warm-up can name', () => {
    const src = `${WARM}await warmImports(() => import('@/screens/SiteVisitsScreen'));\nawait import('@/screens/' + name);`;
    expect(gapsOf(src)).toEqual(["import('@/screens/' + name)"]);
  });

  it('reads a comment inside the call, a second argument, and a warm-up over several lines', () => {
    expect([...imported("await import(/* @vite-ignore */ '@/store/store');")]).toEqual(['@/store/store']);
    expect(gapsOf("await import('@/store/store', { with: { type: 'json' } });")).toEqual(["import('@/store/store', { with: { type: 'json' } })"]);
    expect(gapsOf(`${WARM}await warmImports(\n  () => import('@/store/store'),\n);\nawait import('@/store/store');`)).toEqual([]);
  });

  it('counts a warm-up only at the top level, where it runs while the file is collected, not in a test or a hook', () => {
    for (const where of [
      "it('x', async () => { await warmImports(() => import('@/store/store')); });",
      "beforeAll(async () => { await warmImports(() => import('@/store/store')); });",
      "void warmImports(() => import('@/store/store'));",
      "if (false) await warmImports(() => import('@/store/store'));",
      "warmImports(() => import('@/store/store'));",
    ]) expect(gapsOf(`${WARM}${where}\nawait import('@/store/store');`), where).toEqual(['@/store/store']);
  });

  it('reads a .ts file as TypeScript, so a generic arrow or a cast does not hide what follows', () => {
    const src = "const id = <T,>(x: T) => x;\nconst n = <number>id(1);\nawait import('@/store/store');";
    expect(gapsOf(src, 'tests/a.test.ts')).toEqual(['@/store/store']);
    const plain = "const id = <T>(x: T) => x;\nawait import('@/store/store');";
    expect(gapsOf(plain, 'tests/a.test.ts')).toEqual(['@/store/store']);
  });

  it('never takes a warm-up of a call it cannot name as covering the same call', () => {
    expect(gapsOf(`${WARM}await warmImports(() => import(name));\nawait import(name);`)).toEqual(['import(name)']);
  });

  it('keeps an UNWARMED entry only while the scan of its file still reports that gap, whatever the module holds', () => {
    const files: Record<string, string> = {
      'tests/kept.test.ts': "await import(`@/screens/${role === 'pmc' ? 'Pmc' : 'Eng'}Screen`);",
      'tests/gone.test.ts': "await import('@/screens/PmcScreen');",
    };
    const read = (n: string) => files[n]!;
    const key = "import(`@/screens/${role === 'pmc' ? 'Pmc' : 'Eng'}Screen`)";
    expect(stillNeeded(`tests/kept.test.ts: ${key}`, read)).toBe(true);
    expect(stillNeeded(`tests/gone.test.ts: ${key}`, read)).toBe(false);
    expect(stillNeeded('tests/kept.test.ts: @/store/store', read)).toBe(false);
  });

  it('reads each test file as what its name says, and reports one it cannot read that way', () => {
    const files: Record<string, string> = {
      'tests/a.test.tsx': "const el = <div title={'a'}>{'x'}</div>;\nawait import('@/store/store');",
      'tests/b.test.ts': "const id = <T>(x: T) => x;\nawait import('@/store/store');",
      'tests/c.test.ts': "const el = <div>{'x'}</div>;\nawait import('@/store/store');",
    };
    const read = (n: string) => files[n]!;
    expect(scan('tests/a.test.tsx', read)).toEqual(['tests/a.test.tsx: @/store/store']);
    expect(scan('tests/b.test.ts', read)).toEqual(['tests/b.test.ts: @/store/store']);
    expect(scan('tests/c.test.ts', read)).toEqual(['tests/c.test.ts: cannot be read as TypeScript']);
  });

  it('leaves type-only imports and package imports alone', () => {
    expect([...imported("type S = typeof import('@/store/store');\nawait import('react');\nawait import('@testing-library/react');")]).toEqual([]);
  });
});

describe('the rule fails closed: it credits only what it recognises (#792, Codex round 4)', () => {
  it('takes any import that is not a package as the app\'s own, and a gap until warmed by the same string (Codex 4332084240)', () => {
    for (const spec of ['../src/store/store', './helpers', '/src/store/store', '@vitan/shared', '@vitan/shared/i18n'])
      expect(gapsOf(`await import('${spec}');`), spec).toEqual([spec]);
    expect(gapsOf(`${WARM}await warmImports(() => import('../src/store/store'));\nawait import('../src/store/store');`)).toEqual([]);
    // the aliases are vite.config.ts's own
    expect(CONFIG.aliases).toEqual(expect.arrayContaining(['@', '@vitan/shared']));
    expect(gapsOf("await import('~/x');", FIXTURE)).toEqual([]);
    expect(parse("await import('~/x');", 'tests/other.ts', ['~']).found).toEqual([{ key: '~/x', warm: false }]);
  });

  it('credits a warm-up only for an import its loader necessarily runs (Codex 4332084248)', () => {
    const use = "\nawait import('@/store/store');";
    for (const loader of [
      "async () => { const deferred = () => import('@/store/store'); }",
      "() => { if (ready) return import('@/store/store'); }",
      "() => ready && import('@/store/store')",
      "() => [import('@/store/store')]",
      "() => import('@/store/store').then((m) => m)",
      "() => Promise.all([later(() => import('@/store/store'))])",
      "() => Promise.race([import('@/store/store')])",
      "(load = () => import('@/store/store')) => load",
    ]) expect(gapsOf(`${WARM}await warmImports(${loader});${use}`), loader).toEqual(['@/store/store']);
    for (const loader of [
      "() => import('@/store/store')",
      "async () => await import('@/store/store')",
      "() => (import('@/store/store'))",
      "async () => { return import('@/store/store'); }",
      "function () { return import('@/store/store'); }",
      "() => Promise.all([import('@/store/store'), import('@/a')])",
    ]) expect(gapsOf(`${WARM}await warmImports(${loader});${use}`), loader).toEqual([]);
    // only the real helper warms: a local function of that name, or one imported from elsewhere, may not run its loaders
    expect(gapsOf(`const warmImports = async (..._l: unknown[]) => {};\nawait warmImports(() => import('@/store/store'));${use}`)).toEqual(['@/store/store']);
    expect(gapsOf(`import type { warmImports } from './warm-imports';\nawait warmImports(() => import('@/store/store'));${use}`)).toEqual(['@/store/store']);
    expect(gapsOf(`import { type warmImports } from './warm-imports';\nawait warmImports(() => import('@/store/store'));${use}`)).toEqual(['@/store/store']);
    expect(gapsOf(`import { warmImports } from './elsewhere';\nawait warmImports(() => import('@/store/store'));${use}`)).toEqual(['@/store/store']);
    expect(gapsOf(`import { warmImports } from '../warm-imports';\nawait warmImports(() => import('@/store/store'));${use}`, 'tests/nested/a.test.ts')).toEqual([]);
  });

  it('checks every file the same way, however it reaches vi.resetModules, so no spelling of a reset can exempt one (Codex 4332084259)', () => {
    for (const reset of [
      '',
      'vi.resetModules();',
      "vi['resetModules']();",
      'beforeEach(vi.resetModules);',
      "import { vitest } from 'vitest';\nvitest.resetModules();",
    ]) {
      expect(gapsOf(`${reset}\nawait import('@/store/store');`), reset).toEqual(['@/store/store']);
      expect(gapsOf(`${WARM}await warmImports(() => import('@/store/store'));\n${reset}\nawait import('@/store/store');`), reset).toEqual([]);
    }
    // a reset the rule cannot follow is no exemption either: Vitest's object reached that way is a gap of its own
    for (const [reset, ...keys] of [
      ["import * as V from 'vitest';\nV.vi.resetModules();", "import * as V from 'vitest';", 'V.vi.resetModules()'],
      ['const { resetModules } = vi;\nresetModules();', '{ resetModules } = vi'],
      ['(globalThis as any).vi[k]();', '(globalThis as any).vi[k]()'],
    ]) expect(gapsOf(`${WARM}await warmImports(() => import('@/store/store'));\n${reset}\nawait import('@/store/store');`), reset).toEqual(keys);
  });

  it('reads the files Vitest collects from the config\'s own include and exclude, nested and named .spec too (Codex 4332084261)', () => {
    const root = mkdtempSync(join(tmpdir(), 'warm-imports-rule-'));
    try {
      const put = (n: string, src = '') => { mkdirSync(dirname(join(root, n)), { recursive: true }); writeFileSync(join(root, n), src); };
      for (const n of ['tests/a.test.tsx', 'tests/nested/x.spec.tsx', 'src/b.test.mts', 'tests/e2e/c.spec.ts', 'node_modules/p/d.test.ts', 'tests/helper.ts'])
        put(n);
      const config = readConfig("export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/tests/e2e/**'] } });");
      expect(collect(root, config)).toEqual(['src/b.test.mts', 'tests/a.test.tsx', 'tests/nested/x.spec.tsx']);
      const only = readConfig("export default defineConfig({ test: { include: ['tests/**/*.spec.tsx'] } });");
      expect(collect(root, only)).toEqual(['tests/nested/x.spec.tsx']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(readConfig('export default defineConfig({});').include).toEqual(configDefaults.include);
    expect(readConfig('export default defineConfig({});').exclude).toEqual(configDefaults.exclude);
    for (const unread of [
      'export default { test: {} };',
      'export default defineConfig({ ...base });',
      'export default defineConfig({ test: { include: patterns } });',
      "export default defineConfig({ test: { includeSource: ['src/**/*.ts'] } });",
      "export default defineConfig({ test: { dir: 'src' } });",
      'export default defineConfig({ test: { projects: [] } });',
      "export default defineConfig({ test: { root: 'src' } });",
      'export default defineConfig({ test: { workspace: [] } });',
      "export default defineConfig({ root: 'web' });",
    ]) expect(() => readConfig(unread), unread).toThrow(/cannot read/);
  });
});

describe('the rule matches Vitest and reads every load (#792, gap checks on round 4 and head 5)', () => {
  const tree = (files: Record<string, string>, run: (root: string) => void, under = '') => {
    const base = mkdtempSync(join(tmpdir(), 'warm-imports-rule-'));
    const root = join(base, under);
    try {
      mkdirSync(root, { recursive: true });
      for (const [n, src] of Object.entries(files)) { mkdirSync(dirname(join(root, n)), { recursive: true }); writeFileSync(join(root, n), src); }
      run(root);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
  const config = readConfig("export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**'] } });");

  it('collects dot paths as Vitest does, and refuses what it cannot match: another config, a symlinked folder, node_modules', () => {
    tree({ '.c.test.ts': '', 'tests/.hidden/b.test.ts': '', 'tests/a.test.ts': '' }, (root) => {
      expect(collect(root, config)).toEqual(['.c.test.ts', 'tests/.hidden/b.test.ts', 'tests/a.test.ts']);
    });
    for (const other of ['vitest.config.ts', 'vitest.workspace.ts', 'vite.config.mts'])
      tree({ [other]: '', 'tests/a.test.ts': '' }, (root) => expect(() => collect(root, config), other).toThrow(/cannot match/));
    tree({ 'elsewhere/s.test.ts': '', 'tests/a.test.ts': '' }, (root) => {
      symlinkSync(join(root, 'elsewhere'), join(root, 'tests/link'), 'dir');
      expect(() => collect(root, config)).toThrow(/tests\/link \(a symlinked folder\)/);
    });
    for (const exclude of ["['**/tests/e2e/**']", "['node_modules/**']"]) tree({ 'tests/a.test.ts': '' }, (root) => {
      expect(() => collect(root, readConfig(`export default defineConfig({ test: { exclude: ${exclude} } });`)), exclude).toThrow(/node_modules/);
    });
  });

  it('matches paths relative to the web folder, so a folder above it named dist decides nothing, and skips a symlink it cannot follow', () => {
    tree({ 'tests/a.test.ts': '', '.d.test.ts': '', 'dist/x.test.ts': '' }, (root) => {
      expect(collect(root, config)).toEqual(['.d.test.ts', 'tests/a.test.ts']);
    }, 'dist/proj');
    tree({ 'tests/a.test.ts': '' }, (root) => {
      symlinkSync(join(root, 'tests/gone'), join(root, 'tests/.#notes.md'));
      symlinkSync(join(root, 'tests/gone'), join(root, 'tests/.#x.test.ts'));
      symlinkSync('.#loop.test.ts', join(root, 'tests/.#loop.test.ts'));
      symlinkSync('a.test.ts/x', join(root, 'tests/.#nd.test.ts'));
      expect(collect(root, config)).toEqual(['tests/a.test.ts']);
    });
  });

  it('credits a top-level static import of the same specifier in every file, but not one only of types', () => {
    for (const statics of ["import { useStore } from '@/store/store';", "import '@/store/store';", "import * as S from '@/store/store';"]) {
      expect(scan('tests/a.test.tsx', () => `${statics}\nawait import('@/store/store');`), statics).toEqual([]);
      expect(scan('tests/a.test.tsx', () => `${statics}\nvi.resetModules();\nawait import('@/store/store');`), statics).toEqual([]);
    }
    for (const types of ["import type { S } from '@/store/store';", "import { type S } from '@/store/store';", "import { useStore } from '@/store/store/index';"])
      expect(scan('tests/a.test.tsx', () => `${types}\nawait import('@/store/store');`), types).toEqual(['tests/a.test.tsx: @/store/store']);
  });

  it('reads importActual and importMock named in code, the names vi and vitest used other than to read a member named literally, any import of vitest not by name, and import.meta.glob, as loads no warm-up can name', () => {
    expect(gapsOf("await vi.importActual('@/store/store');")).toEqual(["vi.importActual('@/store/store')"]);
    expect(gapsOf("await vi.importMock('@/store/store');")).toEqual(["vi.importMock('@/store/store')"]);
    expect(gapsOf("await vi['importActual']('@/store/store');")).toEqual(["vi['importActual']('@/store/store')"]);
    expect(gapsOf("const { importActual } = vi;\nawait importActual('@/store/store');")).toEqual(['{ importActual } = vi', "importActual('@/store/store')"]);
    expect(gapsOf("vi.mock('@/x', async () => ({ ...(await vi.importActual('@/x')) }));")).toEqual(["vi.importActual('@/x')"]);
    expect(gapsOf("await vi[`import${'Actual'}`]('@/store/store');")).toEqual(["vi[`import${'Actual'}`]('@/store/store')"]);
    expect(gapsOf("await vi['import' + 'Actual']('@/store/store');")).toEqual(["vi['import' + 'Actual']('@/store/store')"]);
    expect(gapsOf("await vitest[key]('@/store/store');")).toEqual(["vitest[key]('@/store/store')"]);
    expect(gapsOf("await Reflect.get(vi, key)('@/store/store');")).toEqual(['Reflect.get(vi, key)']);
    // Vitest's object behind a cast, an alias, another binding or another receiver (head-5 confirm, G1)
    for (const [src, key] of [
      ["void (vi as any)[k]('@/x');", "(vi as any)[k]('@/x')"],
      ["void vi![k]('@/x');", "vi![k]('@/x')"],
      ["void (vi)[k]('@/x');", "(vi)[k]('@/x')"],
      ["void Reflect.get(vi as any, k)('@/x');", 'Reflect.get(vi as any, k)'],
      ["const v: any = vi;\nvoid v[k]('@/x');", 'v: any = vi'],
      ["import { vi as v } from 'vitest';\nvoid (v as any)[k]('@/x');", 'vi as v'],
      ["void (globalThis as any).vi[k]('@/x');", "(globalThis as any).vi[k]('@/x')"],
      ["void Reflect.get(globalThis, 'vi')[k]('@/x');", "Reflect.get(globalThis, 'vi')"],
      ["const { vi: w } = globalThis as any;", '{ vi: w } = globalThis as any'],
      ["const load = Object.entries(vi).find(([n]) => n === k)![1];", 'Object.entries(vi)'],
      // code inside an instantiation expression or a class's extends runs, though TypeScript counts the node a type (r8 re-check, G1)
      ["void (vi as unknown as Record<string, () => unknown>)[k]<unknown>;", 'vi as unknown'],
      ["class X extends ((vi as any)[k]('@/x'), Object) {}", "(vi as any)[k]('@/x')"],
      // 'vitest' imported other than by name (r8 re-check, G2)
      ["import * as V from 'vitest';", "import * as V from 'vitest';"],
      ["import V from 'vitest';", "import V from 'vitest';"],
      ["import V = require('vitest');", "require('vitest')"],
      ["const V = await import('vitest');", "import('vitest')"],
      ["export * from 'vitest';", "export * from 'vitest';"],
    ] as const) expect(gapsOf(src), src).toEqual([key]);
    // a member named literally, an unaliased import binding, a type, a declared name, and Reflect.get on anything else, read nothing
    expect(gapsOf("import { vi, vitest } from 'vitest';\nimport type * as T from 'vitest';\nvi['fn']();\nvitest.fn();\nconst m: typeof vi.fn = vi.fn;\nconst o = { vi: 1 };\nReflect.get(window, key);")).toEqual([]);
    expect(gapsOf("const all = import.meta.glob('../src/store/*.ts');")).toEqual(["import.meta.glob('../src/store/*.ts')"]);
    expect(gapsOf("const all = import.meta['glob']('../src/store/*.ts');")).toEqual(["import.meta['glob']('../src/store/*.ts')"]);
    expect(gapsOf('const { glob } = import.meta;')).toEqual(['{ glob } = import.meta']);
    // reading a member that is not a glob loads nothing
    expect(gapsOf("const mode = import.meta.env.MODE;\nconst url = new URL('a', import.meta.url);")).toEqual([]);
  });
});

describe('every test file warms what it imports (#792)', () => {
  const read = (n: string) => readFileSync(resolve(ROOT, n), 'utf8');
  // every file is found, read and parsed here, while vitest collects this file, so no test's 5 s is spent on it
  const tests = collect(ROOT, CONFIG);
  const gaps = tests.flatMap((n) => scan(n, read));

  it('finds the files it checks: this one, decisions-language, and well over a hundred in all', () => {
    expect(tests).toContain('tests/warm-imports-rule.test.ts');
    expect(tests).toContain('tests/decisions-language.test.tsx');
    expect(tests.length).toBeGreaterThan(150);
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
