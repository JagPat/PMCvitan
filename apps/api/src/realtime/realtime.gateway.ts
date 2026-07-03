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
 * Realtime signalling. Clients join a per-project room; after any mutation the
 * services call `notifyChanged`, which emits a lightweight `changed` event to
 * that room. Each client then refetches its own RBAC-filtered snapshot — so we
 * never broadcast one role's view to another.
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

  notifyChanged(projectId: string): void {
    this.server?.to(`project:${projectId}`).emit('changed', { projectId });
  }
}
