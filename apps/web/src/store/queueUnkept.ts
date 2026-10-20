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
