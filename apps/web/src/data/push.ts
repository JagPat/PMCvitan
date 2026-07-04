import type { ApiGateway } from './apiGateway';

/** VAPID keys are base64url; the Push API wants a Uint8Array over a real ArrayBuffer. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Subscribe this browser to Web Push (Phase 8) and register it with the API.
 * Safe to call opportunistically: it no-ops unless the environment supports
 * push, the server has VAPID configured, and notification permission is
 * already granted (call `requestPushPermission` from a user gesture to prompt).
 */
export async function subscribeToPush(gw: ApiGateway): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted') return;

    const { key } = await gw.pushPublicKey();
    if (!key) return; // server-side push disabled (no VAPID)

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }));
    await gw.pushSubscribe(sub.toJSON());
  } catch {
    /* push is best-effort — the app works without it */
  }
}

/** Request notification permission (call from a user gesture), then subscribe. */
export async function requestPushPermission(gw: ApiGateway): Promise<boolean> {
  if (!('Notification' in window)) return false;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  await subscribeToPush(gw);
  return true;
}
