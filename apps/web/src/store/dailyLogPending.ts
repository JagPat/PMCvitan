import type { OutboxOp } from '@/data/apiGateway';

/**
 * Is a daily-log start / send already on its way? True while the op waits in this project's
 * durable outbox (offline, or awaiting the server), and — under module read ownership — after the
 * server commits it until the reconcile's module read lands (`dailyLogReconcileAfter`, with
 * `dailyLogReconcileKind` naming the command), because until then the log on screen predates it.
 *
 * ONE rule for every writer. The store's own commands refuse to queue EITHER command while ANY is
 * in flight (`dailyLogCommandInFlight`): the log on screen is stale either way, and each command
 * mints a fresh idempotency key, so a second tap would really send twice. Screens name the one on
 * its way (`dailyLogStartPending` / `dailyLogSendPending`) — a committed send is never shown as a
 * start, nor a queued start hidden behind the previous log's "sent" state.
 */
type PendingInputs = {
  outbox: readonly OutboxOp[];
  dailyLogReconcileAfter: number | null;
  dailyLogReconcileKind: 'start' | 'send' | null;
};

export function dailyLogStartPending(s: PendingInputs): boolean {
  return s.dailyLogReconcileKind === 'start' || s.outbox.some((o) => o.t === 'startDailyLog');
}

export function dailyLogSendPending(s: PendingInputs): boolean {
  return s.dailyLogReconcileKind === 'send' || s.outbox.some((o) => o.t === 'submitDailyLog');
}

export function dailyLogCommandInFlight(s: PendingInputs): boolean {
  return s.dailyLogReconcileAfter !== null || dailyLogStartPending(s) || dailyLogSendPending(s);
}
