import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectLogDecisions } from '@/store/selectors';
import { viewerIsDecider, noticeText, notificationPanelLabels as L, navLabels } from '@vitan/shared';
import { notificationLink, noticeTime, projectSnapshotSettled, decisionsSliceSettled, inspectionsSliceSettled, type NotificationLink, type NotificationRecords } from '@/lib/notifications';
import { inspectionsReadMode } from '@/data/apiGateway';
import { SCREEN_META } from '@/lib/screens';
import { ChevronRight } from '@/lib/icons';
import styles from './NotificationPanel.module.css';

export function NotificationPanel() {
  const open = useStore((s) => s.notifOpen);
  // #784 Codex 4240225580 — an empty list is only "all caught up" once the project's feed has landed: a load in
  // flight, a project or identity switch, or a failed snapshot resets it to [] while the bell stays reachable
  const projectLoadState = useStore((s) => s.projectLoadState);
  const feedSettled = projectSnapshotSettled(projectLoadState);
  // #784 Codex 4240346214 — the relative times re-read the clock while the panel is open (a backgrounded tab, a
  // panel left open), so "just now" does not freeze again; the clock is reset each time the panel opens
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [open]);
  const notifications = useStore((s) => s.notifications);
  const lang = useStore((s) => s.lang);
  const toggleNotif = useStore((s) => s.toggleNotif);
  const role = useStore((s) => s.role);
  const enabledModules = useStore((s) => s.enabledModules);
  // openItem also closes the panel (it clears notifOpen), so a notification tap is one call.
  const openItem = useStore((s) => s.openItem);
  // Codex 4206188363 — the rows the Decision Log shows this viewer (no drafts, no withdrawn or open-demand
  // rows outside their audience), so a notice never resolves to a decision its destination hides
  const decisions = useStore(useShallow(selectLogDecisions));
  const sessionUserId = useStore((s) => s.sessionUserId);
  // a decision is judged absent (or awaiting) only against a SETTLED slice: never while its read is in
  // flight or after it failed (a module read can fail while the snapshot that carried the notice
  // succeeds), nor while a committed command's reconcile is owed
  const decisionsSettled = useStore(decisionsSliceSettled);
  // Live bug 1b-3 — the inspections the viewer's inspection screens hold (the PMC's review queue, the
  // outstanding checklists and the checklist in the slot), judged by the same settled predicate those screens use; under module
  // read-ownership a read that has not yet landed is not settled either
  const reviews = useStore(useShallow((s) => s.reviews));
  const openChecklists = useStore(useShallow((s) => s.openChecklists));
  const checklist = useStore((s) => s.checklist);
  const inspectionsLoad = useStore((s) => s.inspectionsLoad);
  const inspectionsSettled = useStore(inspectionsSliceSettled)
    && !(inspectionsReadMode() === 'moduleQuery' && (inspectionsLoad === 'idle' || inspectionsLoad === 'loading'));
  // Live bug 1 — the notice whose record could not be found, explained in place (by row index).
  const [explained, setExplained] = useState<number | null>(null);
  // a row index means nothing once the panel closes, or once the list itself changes (Codex
  // 4203960936: a realtime refresh can prepend or drop notices while the panel is open), so the
  // explanation is withdrawn rather than left under a different notice
  useEffect(() => {
    setExplained(null);
  }, [open, notifications]);

  // the decisions a notice may name, from the viewer's own slice only
  const records = useMemo<NotificationRecords>(
    () => ({
      decisions: decisions.map((d) => ({
        id: d.id,
        title: d.title,
        awaitsViewer: (d.status === 'pending' || d.status === 'change') && viewerIsDecider(d, role, sessionUserId),
      })),
      decisionsSettled,
      // Codex 4218186510 — exactly what each destination resolves: the review screen opens a queued review
      // or an outstanding checklist; the checklist screen opens an outstanding checklist, or the one in the
      // slot only while it is unsubmitted (a submitted one is history, never a routed item)
      inspections: {
        'inspect-review': [...reviews, ...openChecklists].map((i) => ({ id: i.id })),
        'engineer-check': [...openChecklists, ...(checklist && !checklist.submitted ? [checklist] : [])].map((i) => ({ id: i.id })),
      },
      inspectionsSettled,
    }),
    [decisions, role, sessionUserId, decisionsSettled, reviews, openChecklists, checklist, inspectionsSettled],
  );

  if (!open) return null;

  const follow = (i: number, link: NotificationLink) => {
    if (link.missing || link.loading) setExplained(explained === i ? null : i);
    else openItem(link.screen, link.item);
  };

  return (
    <>
      <div className={styles.scrim} onClick={toggleNotif} />
      <div className={styles.panel} role="dialog" aria-label={L.dialog[lang]}>
        <div className={styles.label}>{L.title[lang]}</div>
        <div className={styles.list}>
          {/* Top 10 #4a (#778) — an empty bell says so, rather than opening onto a blank panel */}
          {notifications.length === 0 && !feedSettled && (
            <div className={styles.item} data-testid={projectLoadState === 'error' ? 'notif-unavailable' : 'notif-loading-feed'} role="status">
              <div style={{ flex: 1 }}>
                <div className={styles.text}>{projectLoadState === 'error' ? L.loadFailed[lang] : L.loading[lang]}</div>
                {projectLoadState === 'error' && <div className={styles.time}>{L.checkConnection[lang]}</div>}
              </div>
            </div>
          )}
          {notifications.length === 0 && feedSettled && (
            <div className={styles.item} data-testid="notif-empty" role="status">
              <div style={{ flex: 1 }}>
                <div className={styles.text}>{L.caughtUp[lang]}</div>
                <div className={styles.time}>{L.caughtUpDetail[lang]}</div>
              </div>
            </div>
          )}
          {notifications.map((n, i) => {
            const link = notificationLink(n, role, records, enabledModules);
            const body = (
              <>
                <span className={styles.dot} style={{ background: n.color }} />
                <div style={{ flex: 1 }}>
                  <div className={styles.text}>{noticeText(n.text, lang, { decision: n.decisionId !== undefined, inspection: n.inspectionId !== undefined, facts: n.facts })}</div>
                  <div className={styles.time}>{noticeTime(n, now, lang)}</div>
                </div>
                {link && <ChevronRight size={15} style={{ alignSelf: 'center', opacity: 0.5, flex: 'none' }} />}
              </>
            );
            // A notification about a record opens THAT record (live bug 1); one about a screen the
            // role can reach opens the screen. Others render as plain, non-interactive rows.
            if (!link) return <div className={styles.item} key={n.id ?? i}>{body}</div>;
            return (
              <div key={n.id ?? i}>
                <button
                  className={styles.item}
                  data-testid="notif-item"
                  aria-expanded={link.missing || link.loading ? explained === i : undefined}
                  onClick={() => follow(i, link)}
                  style={{ background: 'transparent', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
                >
                  {body}
                </button>
                {(link.missing || link.loading) && explained === i && (
                  // the record is gone or out of reach, or its list has not loaded: say which, and offer
                  // the screen it lives on
                  <div role="status" data-testid={link.missing ? 'notif-missing' : 'notif-loading'} className={styles.time} style={{ display: 'grid', gap: 8, padding: '0 14px 12px 32px' }}>
                    <span>
                      {link.missing ? L.missing[lang] : L.notLoaded[lang]}
                    </span>
                    <button
                      data-testid="notif-missing-open"
                      onClick={() => openItem(link.screen, null)}
                      style={{ justifySelf: 'start', minHeight: 44, padding: '0 12px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {lang === 'en' ? `Open ${SCREEN_META[link.screen].label}` : `${navLabels[link.screen][lang]} ${L.open[lang]}`}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
