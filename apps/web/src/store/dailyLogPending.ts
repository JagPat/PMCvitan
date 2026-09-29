import type { OutboxOp } from '@/data/apiGateway';

/**
 * Is a daily-log start / send already on its way? True while the op waits in this project's
 * durable outbox (offline, or awaiting the server), and — under module read ownership — after the
 * server commits it until the reconcile's module read lands (`dailyLogReconcileAfter`), because
 * until then the log on screen predates the command. ONE rule for every writer: the store's own
 * commands refuse to queue a duplicate while it holds, and every screen that offers the command
 * (Today, the Site screen) shows it as on its way instead. A second tap would otherwise send a
 * second command under a fresh idempotency key.
 */
type PendingInputs = { outbox: readonly OutboxOp[]; dailyLogReconcileAfter: number | null };

export function dailyLogStartPending(s: PendingInputs): boolean {
  return s.dailyLogReconcileAfter !== null || s.outbox.some((o) => o.t === 'startDailyLog');
}

export function dailyLogSendPending(s: PendingInputs): boolean {
  return s.dailyLogReconcileAfter !== null || s.outbox.some((o) => o.t === 'submitDailyLog');
}
