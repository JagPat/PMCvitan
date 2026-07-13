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
