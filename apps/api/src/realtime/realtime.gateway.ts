import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { PushService } from '../push/push.service';

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

  constructor(private readonly push: PushService) {}

  @SubscribeMessage('join')
  handleJoin(@MessageBody() data: { projectId?: string }, @ConnectedSocket() client: Socket): { ok: boolean } {
    if (data?.projectId) client.join(`project:${data.projectId}`);
    return { ok: true };
  }

  /** Signal the project room to refetch; `pushBody` also sends a push notification. */
  notifyChanged(projectId: string, pushBody?: string): void {
    this.server?.to(`project:${projectId}`).emit('changed', { projectId });
    if (pushBody) {
      void this.push.notifyProject(projectId, { title: 'Vitan PMC', body: pushBody });
    }
  }
}
