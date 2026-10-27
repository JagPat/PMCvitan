import type { NextFunction, Request, Response } from 'express';
import { readHubConfig } from './hub-config';

/** Where Hub delivers webhooks; the raw-body reader below applies under this prefix only. */
export const HUB_WEBHOOK_PREFIX = '/integrations/hub';
/** The largest Hub webhook body read. Hub's drawing events are a few KiB. */
export const HUB_BODY_MAX_BYTES = 256 * 1024;

/**
 * #1118 U3 — keeps a Hub webhook's body as the exact bytes Hub signed. Mounted on {@link HUB_WEBHOOK_PREFIX} BEFORE the
 * global JSON parser (`configureApp`): it reads an `application/json` body into a Buffer on `req.body`, and the JSON
 * parser then skips the request because its body is already read.
 *
 * While the integration is closed it does nothing, so the path answers exactly as an unrouted one does (the global
 * parsers, then Nest's 404). A body over {@link HUB_BODY_MAX_BYTES}, by `Content-Length` or as it arrives, is refused
 * with 413 and the connection is closed; a compressed body is left alone, so it never reaches the verifier as a Buffer.
 */
export function hubRawBody(req: Request, res: Response, next: NextFunction): void {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  if (type !== 'application/json' || encoding !== 'identity' || !readHubConfig().open) return next();

  let settled = false;
  const refuse = (status: number): void => {
    if (settled) return;
    settled = true;
    res.on('finish', () => req.destroy());
    res.status(status).set('Connection', 'close').end();
  };
  if (Number(req.headers['content-length'] ?? 0) > HUB_BODY_MAX_BYTES) return refuse(413);

  const chunks: Buffer[] = [];
  let length = 0;
  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    length += chunk.length;
    if (length > HUB_BODY_MAX_BYTES) return refuse(413);
    chunks.push(chunk);
  });
  req.on('error', () => refuse(400));
  req.on('end', () => {
    if (settled) return;
    settled = true;
    req.body = Buffer.concat(chunks, length);
    next();
  });
}
