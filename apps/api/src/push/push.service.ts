import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma.service';

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/**
 * Web Push (VAPID), dev-stub-first. With VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
 * set, project notifications fan out to every stored browser subscription;
 * with no keys the send path is a no-op (subscriptions are still stored, so
 * enabling keys later "just works"). Expired endpoints (404/410) are pruned.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('PushService');
  private ready = false;

  constructor(private readonly prisma: PrismaService) {
    if (this.configured) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@vitan.in',
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!,
      );
      this.ready = true;
    }
  }

  get configured(): boolean {
    return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  /** The VAPID public key the browser needs to subscribe (empty when unconfigured). */
  get publicKey(): string {
    return process.env.VAPID_PUBLIC_KEY || '';
  }

  /** Store (or refresh) a browser subscription for a project. */
  async subscribe(projectId: string, sub: BrowserSubscription, role?: string): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { projectId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, role },
      update: { projectId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, role },
    });
  }

  /** Fan a notification out to every subscription on the project (no-op without VAPID). */
  async notifyProject(projectId: string, payload: PushPayload): Promise<void> {
    if (!this.ready) return;
    const subs = await this.prisma.pushSubscription.findMany({ where: { projectId } });
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sc) => {
        try {
          await webpush.sendNotification({ endpoint: sc.endpoint, keys: { p256dh: sc.p256dh, auth: sc.auth } }, body);
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await this.prisma.pushSubscription.delete({ where: { endpoint: sc.endpoint } }).catch(() => {});
          } else {
            this.log.warn(`push send failed (${code ?? 'unknown'}) for ${sc.endpoint.slice(0, 40)}…`);
          }
        }
      }),
    );
  }
}
