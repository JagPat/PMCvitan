import { useState } from 'react';
import { useStore } from '@/store/store';
import { canAdoptLegacyDraft, legacyDraftSummary } from '@/store/dailyLogDraft';
import { dailyLogCommandInFlight } from '@/store/dailyLogPending';
import { engineerLegacyDraftFor, engineerLegacyDraftLabels as L, engineerLegacyDraftSummary, type Lang } from '@vitan/shared';
import styles from './LegacyDraftCard.module.css';

const LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN' };

/**
 * Owner ruling (#692): unsent work this device saved before the log carried its own id. Nothing in
 * it proves which log of its day it was for, so it is never added to a log on its own. It is kept
 * aside and shown here: the engineer adds it to this log (an unsent log of the same day only) or
 * discards it, and a discard asks once more.
 */
export function LegacyDraftCard() {
  const lang = useStore((s) => s.lang);
  const legacy = useStore((s) => s.legacyDailyLogDraft);
  const canAdd = useStore((s) => canAdoptLegacyDraft(s.legacyDailyLogDraft, s.dailyLog, s.activeProjectId) && !dailyLogCommandInFlight(s));
  const adopt = useStore((s) => s.adoptLegacyDailyLogDraft);
  const discard = useStore((s) => s.discardLegacyDailyLogDraft);
  const [confirming, setConfirming] = useState(false);
  if (!legacy) return null;

  const summary = engineerLegacyDraftSummary(legacyDraftSummary(legacy), lang);
  const day = legacy.logKey.startsWith('civil:') ? formatDay(LOCALE[lang], legacy.logKey.slice(6)) : legacy.logKey.replace(/^date:/u, '');
  return (
    <div className={styles.card} role="region" aria-label={L.title[lang]} data-testid="legacy-draft">
      <div className={styles.title}>{L.title[lang]}</div>
      <div className={styles.meta}>{engineerLegacyDraftFor(day, lang)}</div>
      {summary && <div className={styles.summary} data-testid="legacy-draft-summary">{summary}</div>}
      <div className={styles.note}>{canAdd ? L.check[lang] : L.otherDay[lang]}</div>
      {confirming ? (
        <div className={styles.actions}>
          <span className={styles.sure}>{L.discardSure[lang]}</span>
          <button className={styles.danger} onClick={discard} data-testid="legacy-draft-discard-yes">{L.discardYes[lang]}</button>
          <button className={styles.secondary} onClick={() => setConfirming(false)} data-testid="legacy-draft-keep">{L.keep[lang]}</button>
        </div>
      ) : (
        <div className={styles.actions}>
          {canAdd && <button className={styles.primary} onClick={adopt} data-testid="legacy-draft-add">{L.add[lang]}</button>}
          <button className={styles.secondary} onClick={() => setConfirming(true)} data-testid="legacy-draft-discard">{L.discard[lang]}</button>
        </div>
      )}
    </div>
  );
}

/** A civil date (ISO), as "2 October" in the reader's language — formatted as-is (UTC). */
function formatDay(locale: string, iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
}
