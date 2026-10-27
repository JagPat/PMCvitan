/**
 * #1118 U3 — reads a Hub webhook body (already signature-checked) into what the receiver judges. Pure: no I/O.
 *
 * Hub sends `{"type", "timestamp", "data"}` (Hub `docs/hub-api.md`, "Events and webhooks"). A drawing event's `data`
 * carries the drawing (`fileId`, `fileNo`, `versionId`, `toStage`, …) and its Hub project with that project's links to
 * other apps, `data.project.links` = `[{ "app": "pmc", "externalId": "<PMC project id>", "url" }]` ("Site apps").
 *
 * PMC subscribes to {@link HUB_SUBSCRIBED_EVENTS}. Anything else Hub sends (a `webhook.test`, an office-wide event) is
 * ignored. A `drawing.status_changed` into work in progress has no stage (`toStage` null) and is ignored too: work in
 * progress never reaches the site. What the reader can't make sense of is refused; the receiver records both and answers
 * 2xx, so Hub doesn't retry a delivery that would read the same way every time.
 */

export const HUB_SUBSCRIBED_EVENTS = ['drawing.issued', 'drawing.superseded', 'drawing.status_changed'] as const;
export type HubSubscribedEvent = (typeof HUB_SUBSCRIBED_EVENTS)[number];
/** Hub's stages for a drawing version outside work in progress (`toStage`). */
export const HUB_STAGES = ['SHARED', 'ISSUED', 'CONSTRUCTION', 'RECORD', 'SUPERSEDED'] as const;

/** Recorded as the event type of a body with no readable `type`. Parentheses never appear in a Hub type. */
export const HUB_UNREADABLE_TYPE = '(unreadable)';
/** A Hub id or type longer than this is not one PMC stores. */
export const HUB_FIELD_MAX = 256;

export type HubEventReading =
  /** not JSON, not an object, or no usable `type` */
  | { kind: 'unreadable' }
  | { kind: 'ignored'; type: string; why: 'not_subscribed' | 'work_in_progress' }
  /** a subscribed type whose `data` doesn't hold what the receiver needs */
  | { kind: 'malformed'; type: HubSubscribedEvent; versionId: string | null }
  | { kind: 'event'; type: HubSubscribedEvent; versionId: string | null; hubProjectId: string; pmcProjectIds: string[] };

const TYPE = /^[a-z][a-z0-9_.]*$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Hub id: a non-blank string of visible ASCII, or a whole number (Hub's project ids are numbers in JSON). */
function hubId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string' || value.length > HUB_FIELD_MAX) return null;
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}

export function readHubEvent(body: Buffer): HubEventReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { kind: 'unreadable' };
  }
  if (!isObject(parsed)) return { kind: 'unreadable' };
  const type = parsed.type;
  if (typeof type !== 'string' || type.length > HUB_FIELD_MAX || !TYPE.test(type)) return { kind: 'unreadable' };
  if (!(HUB_SUBSCRIBED_EVENTS as readonly string[]).includes(type)) return { kind: 'ignored', type, why: 'not_subscribed' };
  const subscribed = type as HubSubscribedEvent;

  const data = parsed.data;
  if (!isObject(data)) return { kind: 'malformed', type: subscribed, versionId: null };
  const versionId = data.versionId === undefined || data.versionId === null ? null : hubId(data.versionId);
  const malformed = { kind: 'malformed', type: subscribed, versionId } as const;
  if (data.versionId !== undefined && data.versionId !== null && versionId === null) return malformed;

  const stage = data.toStage;
  if (stage !== null && stage !== undefined && !(HUB_STAGES as readonly unknown[]).includes(stage)) return malformed;
  if (stage === null || stage === undefined) {
    if (subscribed === 'drawing.status_changed') return { kind: 'ignored', type, why: 'work_in_progress' };
    return malformed;
  }

  const project = data.project;
  if (!isObject(project)) return malformed;
  const hubProjectId = hubId(project.id);
  if (hubProjectId === null || !Array.isArray(project.links)) return malformed;
  const pmcProjectIds: string[] = [];
  for (const link of project.links) {
    if (!isObject(link)) return malformed;
    if (link.app !== 'pmc') continue;
    const externalId = hubId(link.externalId);
    if (externalId === null) return malformed;
    if (!pmcProjectIds.includes(externalId)) pmcProjectIds.push(externalId);
  }
  return { kind: 'event', type: subscribed, versionId, hubProjectId, pmcProjectIds };
}
