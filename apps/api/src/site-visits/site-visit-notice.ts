/**
 * Site Visits SV1-b (#792, F50) — the three visit notices, and how the feed reads them.
 *
 * Start, end and close each write one KINDED notice bound to their event (SV1-a, V6). Like every kinded notice, it
 * is never served from its stored text: {@link renderSiteVisitNotice} renders it from the kind and the event's
 * frozen facts (the actor envelope's name, and the place or visitor named in the payload), so the bell shows the
 * act as it happened. Every member of the project sees a visit (D1: it shows in the project's history), so every
 * role is served these notices.
 *
 * The texts are "PREFIX: rest" templates, so the bell translates the label and shows the names as written
 * (`noticeText` in `@vitan/shared`).
 */

export const SITE_VISIT_NOTICE_COLOR = '#31567F';

export function siteVisitStartedNotice(visitorName: string, placeName: string | null): string {
  return placeName ? `Site visit started: ${visitorName} — ${placeName}` : `Site visit started: ${visitorName}`;
}

export function siteVisitEndedNotice(visitorName: string): string {
  return `Site visit ended: ${visitorName}`;
}

export function siteVisitClosedNotice(visitorName: string): string {
  return `Site visit closed by the PMC: ${visitorName}`;
}

/** The kinds this module renders. */
export const SITE_VISIT_NOTICE_KINDS: ReadonlySet<string> = new Set(['sitevisit.started', 'sitevisit.ended', 'sitevisit.closed']);

/** The parts of a feed event a site-visit notice reads. */
export interface SiteVisitNoticeEvent {
  readonly eventType: string;
  readonly actorName: string | null;
  readonly payload: unknown;
}

const text = (payload: unknown, key: string): string | null => {
  const v = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

/**
 * kind + event → text and colour, or null (the row is then omitted, never served from its cache). The kind must be
 * the event's own type (the binding seal already requires it) and the event must carry the name the notice says.
 */
export function renderSiteVisitNotice(kind: string, event: SiteVisitNoticeEvent): { text: string; color: string } | null {
  if (!SITE_VISIT_NOTICE_KINDS.has(kind) || event.eventType !== kind) return null;
  if (kind === 'sitevisit.closed') {
    const visitor = text(event.payload, 'visitorName');
    return visitor ? { text: siteVisitClosedNotice(visitor), color: SITE_VISIT_NOTICE_COLOR } : null;
  }
  const actor = event.actorName && event.actorName.trim() !== '' ? event.actorName : null;
  if (!actor) return null;
  return kind === 'sitevisit.started'
    ? { text: siteVisitStartedNotice(actor, text(event.payload, 'placeName')), color: SITE_VISIT_NOTICE_COLOR }
    : { text: siteVisitEndedNotice(actor), color: SITE_VISIT_NOTICE_COLOR };
}
