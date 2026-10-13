import type { RoutedRecord } from '@/lib/useRoutedRecord';
import { Button } from './Button';
import { ItemNotFound } from './ItemNotFound';
import { recordBoundaryText as T, type Lang } from '@vitan/shared';

const note = { marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 } as const;

/**
 * Top 10 #3 gap 12 (#798) — what a hub shows under a record URL while that record cannot be shown: opening it,
 * returning to the whole hub, waiting for a settled slice (with Retry when its read failed), or saying the record
 * is not there. Renders nothing for the hub's list or the record itself.
 */
export function RecordBoundary({ record, prefix, what, loadingText, unavailableText, showAllLabel, onShowAll, onRetry, lang = 'en' }: {
  record: RoutedRecord;
  /** test-id prefix, e.g. `materials` */
  prefix: string;
  /** the record's noun for "not found", e.g. `Activity` */
  what: string;
  loadingText: string;
  unavailableText: string;
  showAllLabel: string;
  onShowAll: () => void;
  onRetry: () => void;
  /** the language of the boundary's own words. The caller sets it with the words it passes, so a
   *  screen not yet translated never shows a sentence that is half one language and half another. */
  lang?: Lang;
}) {
  switch (record.state) {
    case 'list':
    case 'record':
      return null;
    case 'opening':
      return <div data-testid={`${prefix}-record-opening`} style={note}>{T.opening(record.id, lang)}</div>;
    case 'returning':
      return <div data-testid={`${prefix}-record-returning`} style={note}>{T.returning[lang]}</div>;
    case 'loading':
      return <div data-testid={`${prefix}-record-loading`} style={note}>{loadingText}</div>;
    case 'unavailable':
      return (
        <div data-testid={`${prefix}-record-unavailable`} style={{ ...note, display: 'grid', gap: 12, justifyItems: 'center' }}>
          <span>{unavailableText}</span>
          <Button data-testid={`${prefix}-record-retry`} onClick={onRetry}>{T.retry[lang]}</Button>
        </div>
      );
    case 'missing':
      return <ItemNotFound what={what} id={record.id} onShowAll={onShowAll} showAllLabel={showAllLabel} lang={lang} />;
  }
}
