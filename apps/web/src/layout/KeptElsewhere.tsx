import { useEffect, useId, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Lang } from '@vitan/shared';
import { useStore } from '@/store/store';
import { ConfirmDialog, Modal } from '@/components';
import { QW, qwFill } from '@/lib/queueWords';
import type { KeptKind, KeptProject } from '@/store/keptElsewhere';
import type { KeptDiscard } from '@/store/store';

/**
 * #1388 (unit 1, read only): the changes this device keeps for projects the person no longer holds, opened from the
 * line at the foot of the project switcher (the rail's and the phone's). Each project shows its name as this device last
 * saw it, how many changes it keeps and what each is about. Nothing here sends, moves or discards a change: they are
 * sent if the person's access returns and they open the project here.
 *
 * Unit 2: the person may discard one line, or all of a project's changes, after a confirm. The store checks their
 * access afresh first and discards nothing on a stale or failed answer. A project with changes this version cannot
 * read offers only "Discard all" (its lines cannot all be named), and none when all it keeps is a newer release's.
 */

const KIND: Record<KeptKind, keyof typeof QW> = {
  decision: 'keptKindDecision', drawing: 'keptKindDrawing', inspection: 'keptKindInspection', activity: 'keptKindActivity',
  dailyLog: 'keptKindDailyLog', siteVisit: 'keptKindSiteVisit', photo: 'keptKindPhoto', materials: 'keptKindMaterials',
  labour: 'keptKindLabour', commercial: 'keptKindCommercial', budget: 'keptKindBudget',
};
const LOCALE: Record<Lang, string> = { en: 'en-GB', hi: 'hi-IN', gu: 'gu-IN' };

const countLine = (n: number, lang: Lang): string => (n === 1 ? QW.keptCountOne[lang] : qwFill(QW.keptCount, lang, { n }));
type Ask = { projectId: string; item: string | null; n: number; name: string; unread: boolean };
/** what a discard says: nothing when all of it went, else each thing the person should know */
function saidOf(r: KeptDiscard, name: string, lang: Lang): string {
  if (r.outcome === 'held') return qwFill(QW.keptBack, lang, { project: name });
  if (r.outcome === 'unknown') return QW.keptNoCheck[lang];
  const said = [r.outcome === 'failed' ? QW.keptNotDiscarded[lang] : QW.keptDiscarded[lang]];
  if (r.busy) said.push(QW.keptBusy[lang]);
  if (r.unchecked) said.push(QW.keptVisitUnchecked[lang]);
  return said.join(' ');
}
const canDiscardAll = (p: KeptProject): boolean => p.total > 0 || p.unreadable === 'damaged';

export function KeptElsewhereModal({ onClose }: { onClose: () => void }) {
  const kept = useStore(useShallow((s) => s.keptElsewhere));
  const lang = useStore((s) => s.lang);
  const load = useStore((s) => s.loadKeptElsewhere);
  const token = useStore((s) => s.sessionToken);
  const memberships = useStore((s) => s.memberships);
  const active = useStore((s) => s.activeProjectId);
  const discard = useStore((s) => s.discardKeptChanges);
  const titleId = useId();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [working, setWorking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = (a: Ask): void => {
    setWorking(true);
    setSaid(null);
    void discard(a.projectId, a.item)
      .then((r) => { setSaid(saidOf(r, a.name, lang)); }, () => { setSaid(QW.keptNotDiscarded[lang]); })
      .finally(() => { setWorking(false); });
  };
  const confirmText = (a: Ask): string => {
    const first = a.n === 0 ? qwFill(QW.keptConfirmUnread, lang, { project: a.name })
      : a.n === 1 ? qwFill(QW.keptConfirmOne, lang, { project: a.name }) : qwFill(QW.keptConfirm, lang, { project: a.name, n: a.n });
    // "Discard all" says when it also removes changes this version cannot read
    return a.unread ? `${first} ${QW.keptConfirmUnreadIncluded[lang]}` : first;
  };
  // the list is read on open (the switcher's line comes from a keys-only check: Stage 1 G10), and again on each open, as
  // another tab may have sent, or kept, changes since
  // a read a memberships, project or session change made stale is dropped (its seq and scope); while the list is open
  // that same change reads it again (Codex 4498679826)
  useEffect(() => { void load(); }, [load, token, memberships, active]);
  const saved = (at: number) => qwFill(QW.keptSaved, lang, { date: new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(at) });
  return (
    <Modal onClose={onClose} labelledBy={titleId} maxWidth={480}>
      <div style={{ padding: 20 }} data-testid="kept-elsewhere">
        <h2 id={titleId} style={title}>{QW.keptTitle[lang]}</h2>
        <p style={note}>{QW.keptIntro[lang]}</p>
        {said !== null && <p style={note} role="status" data-testid="kept-said">{said}</p>}
        {kept !== null && kept.length === 0 && <p style={note} data-testid="kept-none">{QW.keptNone[lang]}</p>}
        {(kept ?? []).map((p) => (
          <section key={p.projectId} style={project} data-testid={`kept-project-${p.projectId}`}>
            <div style={head}>
              <span style={{ fontWeight: 700 }}>{p.name ?? QW.keptUnknownProject[lang]}</span>
              {p.total > 0 && <span style={muted}>{countLine(p.total, lang)}</span>}
              {canDiscardAll(p) && (
                <button type="button" style={small} disabled={working} data-testid="kept-discard-all"
                  onClick={() => setAsk({ projectId: p.projectId, item: null, n: p.total, name: p.name ?? QW.keptUnknownProject[lang], unread: p.unreadIncluded === true })}>
                  {QW.keptDiscardAll[lang]}
                </button>
              )}
            </div>
            {p.unreadable !== null && <p style={note} data-testid="kept-unreadable">{QW.keptUnreadable[lang]}</p>}
            <ul style={list} role="list">
              {p.items.map((i) => (
                <li key={i.id} style={item} data-testid="kept-item">
                  <span>
                    {QW[KIND[i.kind]][lang]}{i.count > 1 ? ` · ${countLine(i.count, lang)}` : ''}
                    {i.failed && <span style={{ ...muted, display: 'block', whiteSpace: 'normal' }} data-testid="kept-failed">{QW.keptFailed[lang]}</span>}
                  </span>
                  {i.at !== null && <span style={muted}>{saved(i.at)}</span>}
                  {p.unreadable === null && (
                    <button type="button" style={small} disabled={working} data-testid="kept-discard"
                      onClick={() => setAsk({ projectId: p.projectId, item: i.id, n: i.count, name: p.name ?? QW.keptUnknownProject[lang], unread: false })}>
                      {QW.keptDiscard[lang]}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button type="button" onClick={onClose} style={button}>{QW.keptClose[lang]}</button>
      </div>
      {ask !== null && (
        <ConfirmDialog title={QW.keptConfirmTitle[lang]} confirmLabel={ask.item === null ? QW.keptDiscardAll[lang] : QW.keptDiscard[lang]}
          lang={lang} testId="kept-confirm" onConfirm={() => run(ask)} onCancel={() => setAsk(null)}>
          {confirmText(ask)}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

const title: CSSProperties = { margin: '0 0 6px', fontSize: 17 };
const note: CSSProperties = { margin: '0 0 12px', fontSize: 13, color: 'var(--ink)' };
const project: CSSProperties = { borderTop: '1px solid var(--hairline-strong)', padding: '10px 0' };
const head: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14, marginBottom: 6 };
const muted: CSSProperties = { fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const item: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '4px 0' };
const small: CSSProperties = {
  minHeight: 44, padding: '4px 10px', border: '1px solid var(--hairline-strong)', borderRadius: 8, fontSize: 12,
  background: 'var(--paper)', color: 'var(--ink)', cursor: 'pointer', flexShrink: 0,
};
const button: CSSProperties = {
  minHeight: 44, marginTop: 8, padding: '6px 14px', border: '1px solid var(--hairline-strong)', borderRadius: 8,
  background: 'var(--paper)', color: 'var(--ink)', cursor: 'pointer',
};
