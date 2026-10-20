import type { OutboxOp } from '@/data/apiGateway';

/**
 * WEB-02 (#792): the acts held in memory that no write stored on this phone ("not kept"). They are sent while this
 * scope stays loaded in this page, and lost if it does not; the person is asked before a switch or sign-out drops them.
 */
export const queueActIdent = (o: OutboxOp): string => {
  const key = (o as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof key === 'string') return `k:${key}`;
  if (o.t === 'uploadMedia' && o.input.clientKey) return `photo:${o.input.clientKey}`;
  return `json:${JSON.stringify(o)}`;
};

type UnkeptInputs = { outbox: OutboxOp[]; queueUnkept: string[] };

/** a day-log draft no write stored (its key could not be read, or the write failed) is "not kept" too, under these
 *  marks: no act's identity starts with `draft:` */
export const DRAFT_UNKEPT = { current: 'draft:current', legacy: 'draft:legacy' } as const;

/** how many updates held in memory would be lost by leaving: the acts never stored, and each draft never stored */
export function unkeptCount(s: UnkeptInputs & { dailyLogDraft: unknown; legacyDailyLogDraft: unknown }): number {
  const drafts = (s.dailyLogDraft && s.queueUnkept.includes(DRAFT_UNKEPT.current) ? 1 : 0)
    + (s.legacyDailyLogDraft && s.queueUnkept.includes(DRAFT_UNKEPT.legacy) ? 1 : 0);
  return unkeptActs(s).length + drafts;
}

/** the acts in the queue now that were never stored */
export function unkeptActs(s: UnkeptInputs): OutboxOp[] {
  if (s.queueUnkept.length === 0) return [];
  const unkept = new Set(s.queueUnkept);
  return s.outbox.filter((o) => unkept.has(queueActIdent(o)));
}

/** whether the day log's queued start or send is one that was never stored */
export function dailyLogActUnkept(s: UnkeptInputs): boolean {
  return unkeptActs(s).some((o) => o.t === 'startDailyLog' || o.t === 'submitDailyLog');
}
