import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { PushService } from '../push/push.service';
import { legacyPathSends } from '../platform/outbox/registry';

/**
 * Realtime signalling. Clients join a per-project room; after any mutation the
 * services call `notifyChanged`, which emits a lightweight `changed` event to
 * that room. Each client then refetches its own RBAC-filtered snapshot — so we
 * never broadcast one role's view to another. When a change also carries a
 * human-facing message, it is fanned out as a Web Push notification too.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('RealtimeGateway');

  constructor(private readonly push: PushService) {}

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { projectId?: string }, @ConnectedSocket() client: Socket): { ok: boolean } {
    if (data?.projectId) client.join(`project:${data.projectId}`);
    return { ok: true };
  }

  /**
   * Signal the project room to refetch; `pushBody` also sends a push notification.
   * `roles` targets the push to specific roles (e.g. an approval to PMC/contractor,
   * a re-inspection to the engineer); omit it to push to everyone on the project.
   */
  notifyChanged(projectId: string, pushBody?: string, roles?: string[]): void {
    // Phase 2 Task 6 — the in-request path is the ACTIVE sender in every mode except `outbox`
    // (where the socket/push outbox consumers send instead). Exactly one sender at all times.
    if (!legacyPathSends()) return;
    this.server?.to(`project:${projectId}`).emit('changed', { projectId });
    if (pushBody) {
      void this.push.notifyProject(projectId, { title: 'Vitan PMC', body: pushBody }, roles);
    }
  }

  /** Socket-only invalidation, used by the `socket.invalidation` outbox consumer at cutover. */
  emitChanged(projectId: string): void {
    this.server?.to(`project:${projectId}`).emit('changed', { projectId });
  }

  /** Shadow mode: record (never send) what a consumer WOULD have dispatched, for cutover compare. */
  recordShadowIntent(kind: 'socket' | 'push', projectId: string): void {
    this.log.debug(`[outbox shadow] ${kind} invalidation for project ${projectId} (not sent — legacy path active)`);
  }
}
