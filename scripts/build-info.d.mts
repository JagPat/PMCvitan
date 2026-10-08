export declare const UNKNOWN: 'unknown';
export interface BuildInfo { commit: string; commitShort: string; builtAt: string }
export declare function buildInfo(env?: Record<string, string | undefined>, now?: Date): BuildInfo;
