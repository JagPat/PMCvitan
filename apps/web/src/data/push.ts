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

/**
 * Phase 6 task 4b (§A.3 round 13) — sign-out UNLINKS this browser's subscription from the
 * departing user: a shared site tablet must not keep receiving decider-targeted content after
 * they walk away. Best-effort like every push call (the server also treats a stale credential
 * version or the token's own expiry as unlinked); role-level pushes continue for the device.
 */
export async function unlinkPushOnSignOut(gw: ApiGateway): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub?.endpoint) return;
    await gw.pushUnlink(sub.endpoint);
  } catch {
    /* best-effort — credential-version + expiry checks still sever a stale link server-side */
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
