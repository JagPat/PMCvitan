import { useEffect, useId, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Lang } from '@vitan/shared';
import { useStore } from '@/store/store';
import { Modal } from '@/components';
import { QW, qwFill } from '@/lib/queueWords';
import type { KeptKind } from '@/store/keptElsewhere';

/**
 * #1388 (unit 1, read only): the changes this device keeps for projects the person no longer holds, opened from the
 * line at the foot of the project switcher (the rail's and the phone's). Each project shows its name as this device last
 * saw it, how many changes it keeps and what each is about. Nothing here sends, moves or discards a change: they are
 * sent if the person's access returns and they open the project here (unit 2 adds the discard).
 */

const KIND: Record<KeptKind, keyof typeof QW> = {
  decision: 'keptKindDecision', drawing: 'keptKindDrawing', inspection: 'keptKindInspection', activity: 'keptKindActivity',
  dailyLog: 'keptKindDailyLog', siteVisit: 'keptKindSiteVisit', photo: 'keptKindPhoto', materials: 'keptKindMaterials',
  labour: 'keptKindLabour', commercial: 'keptKindCommercial', budget: 'keptKindBudget',
};
const LOCALE: Record<Lang, string> = { en: 'en-GB', hi: 'hi-IN', gu: 'gu-IN' };

const countLine = (n: number, lang: Lang): string => (n === 1 ? QW.keptCountOne[lang] : qwFill(QW.keptCount, lang, { n }));

export function KeptElsewhereModal({ onClose }: { onClose: () => void }) {
  const kept = useStore(useShallow((s) => s.keptElsewhere));
  const lang = useStore((s) => s.lang);
  const load = useStore((s) => s.loadKeptElsewhere);
  const titleId = useId();
  // the list is read on open (the switcher's line comes from a keys-only check: Stage 1 G10), and again on each open, as
  // another tab may have sent, or kept, changes since
  useEffect(() => { void load(); }, [load]);
  const saved = (at: number) => qwFill(QW.keptSaved, lang, { date: new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(at) });
  return (
    <Modal onClose={onClose} labelledBy={titleId} maxWidth={480}>
      <div style={{ padding: 20 }} data-testid="kept-elsewhere">
        <h2 id={titleId} style={title}>{QW.keptTitle[lang]}</h2>
        <p style={note}>{QW.keptIntro[lang]}</p>
        {kept !== null && kept.length === 0 && <p style={note} data-testid="kept-none">{QW.keptNone[lang]}</p>}
        {(kept ?? []).map((p) => (
          <section key={p.projectId} style={project} data-testid={`kept-project-${p.projectId}`}>
            <div style={head}>
              <span style={{ fontWeight: 700 }}>{p.name ?? QW.keptUnknownProject[lang]}</span>
              {p.total > 0 && <span style={muted}>{countLine(p.total, lang)}</span>}
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
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button type="button" onClick={onClose} style={button}>{QW.keptClose[lang]}</button>
      </div>
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
const button: CSSProperties = {
  minHeight: 44, marginTop: 8, padding: '6px 14px', border: '1px solid var(--hairline-strong)', borderRadius: 8,
  background: 'var(--paper)', color: 'var(--ink)', cursor: 'pointer',
};
