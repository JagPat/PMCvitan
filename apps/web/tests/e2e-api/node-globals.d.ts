/**
 * Playwright runs the e2e-api specs under Node, but the app tsconfig
 * deliberately excludes @types/node (the browser bundle must never lean on
 * Node globals). Declare the minimal Buffer surface these specs use.
 */
declare interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
}
declare const Buffer: {
  from(data: string, encoding?: string): Buffer;
  alloc(size: number, fill?: number): Buffer;
};
// The daily-log module-query spec reads the runner's read-mode flag off the environment.
declare const process: { env: Record<string, string | undefined> };
// The materials-pilot spec enables the pilot capability via the operator CLI (the sole §D enable
// path) — the minimal child_process surface it uses, without pulling @types/node into the bundle.
declare module 'node:child_process' {
  export function execSync(command: string, options?: { stdio?: 'pipe' | 'inherit' | 'ignore' }): Buffer;
}
// The commercial-pilot spec writes a §L activation plan to a temp file — `commercial` is the one
// capability whose activation takes INPUT. Same minimal-surface rule as above.
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
