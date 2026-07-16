import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';

/**
 * Realtime signalling. Clients join a per-project room; after any mutation the socket-invalidation
 * outbox consumer calls {@link emitChanged}, emitting a lightweight `changed` event to that room.
 * Each client then refetches its own RBAC-filtered snapshot — so we never broadcast one role's view
 * to another.
 *
 * PR C Task 2 — the in-request `notifyChanged` (socket + push) is GONE. External effects (socket
 * invalidation + Web Push) are now sent EXCLUSIVELY through the outbox consumers, invoked by the
 * single {@link ExternalEffectDispatcher} (legacy/shadow) or the background relay (outbox). This
 * gateway only owns the raw socket emit its consumer calls.
 */
@Injectable()
@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway {
  @WebSocketServer() server!: Server;

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { projectId?: string }, @ConnectedSocket() client: Socket): { ok: boolean } {
    if (data?.projectId) client.join(`project:${data.projectId}`);
    return { ok: true };
  }

  /** Socket-only invalidation — the provider op the `socket.invalidation` outbox consumer calls. */
  emitChanged(projectId: string): void {
    this.server?.to(`project:${projectId}`).emit('changed', { projectId });
  }
}
