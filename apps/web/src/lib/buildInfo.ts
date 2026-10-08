/** The deployed build (owner direction 2026-10-08), stamped by vite.config.ts at build time; the same
 *  object is served as /version.json. */
export interface BuildInfo { commit: string; commitShort: string; builtAt: string }

declare const __BUILD_INFO__: BuildInfo | undefined;

export const BUILD_INFO: BuildInfo = typeof __BUILD_INFO__ !== 'undefined'
  ? __BUILD_INFO__
  : { commit: 'unknown', commitShort: 'unknown', builtAt: 'unknown' };
