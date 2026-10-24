import type { OutboxOp } from '@/data/apiGateway';

/**
 * A queued act's identity, shared by the queue key guard and the occurrence ledger. A leaf: it imports only a type, so
 * neither queue module reaches the other through it (#1109 r2, Codex 4366140122).
 */

/** an act's identity: its idempotency key, else a photo's client key, else its bytes */
export const queueActIdent = (o: OutboxOp): string => {
  const key = (o as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof key === 'string') return `k:${key}`;
  const clientKey = (o as { input?: { clientKey?: unknown } }).input?.clientKey;
  if (o.t === 'uploadMedia' && typeof clientKey === 'string') return `photo:${clientKey}`;
  return `json:${JSON.stringify(o)}`;
};
