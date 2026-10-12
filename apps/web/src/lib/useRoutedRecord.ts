import type { ScreenKey } from '@vitan/shared';
import { useStore } from '@/store/store';
import { useUrlItem } from './useUrlItem';

/**
 * Top 10 #3 gap 12 (#798) — what a hub screen shows under its URL when that URL may name ONE record
 * (`/materials/<activityId>`, `/labour/<activityId>`). The rules the schedule's record route settled (#777):
 *
 * - `opening` / `returning`: RouteBridge adopts the URL's item in an effect, so until the store names what the
 *   URL names (a cold load, Back/Forward), or has cleared it after Back to the bare hub, nothing actionable is
 *   shown under that URL;
 * - `loading` / `unavailable`: a routed record waits for a SETTLED slice. A retained or in-flight bundle is not
 *   authoritative, so its live controls stay hidden and the record is never judged missing meanwhile;
 * - `missing`: the settled slice does not hold it, and the screen says so (`ItemNotFound`);
 * - `record`: the one record, shown on its own.
 */
export type RoutedRecord =
  | { state: 'list' }
  | { state: 'opening'; id: string }
  | { state: 'returning' }
  | { state: 'loading'; id: string }
  | { state: 'unavailable'; id: string }
  | { state: 'missing'; id: string }
  | { state: 'record'; id: string };

export interface RecordSlice {
  /** the slice has landed and nothing it shows is retained from a failed or superseded read */
  settled: boolean;
  /** the latest read of the slice failed (a last-good copy may still be on screen) */
  failed: boolean;
  /** the settled slice holds this record */
  holds: (id: string) => boolean;
}

/** The pure judgement. `urlItem` is `undefined` outside a router (or under another screen's URL), where only the
 *  store's item counts. */
export function routedRecordState(urlItem: string | null | undefined, routeItem: string | null, slice: RecordSlice): RoutedRecord {
  if (typeof urlItem === 'string' && urlItem !== routeItem) return { state: 'opening', id: urlItem };
  if (urlItem === null && routeItem !== null) return { state: 'returning' };
  if (routeItem === null) return { state: 'list' };
  if (!slice.settled) return slice.failed ? { state: 'unavailable', id: routeItem } : { state: 'loading', id: routeItem };
  return slice.holds(routeItem) ? { state: 'record', id: routeItem } : { state: 'missing', id: routeItem };
}

export function useRoutedRecord(screen: ScreenKey, slice: RecordSlice): RoutedRecord {
  const urlItem = useUrlItem(screen);
  const routeItem = useStore((s) => s.routeItem);
  return routedRecordState(urlItem, routeItem, slice);
}
