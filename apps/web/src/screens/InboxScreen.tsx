import { useMemo, type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { selectActionItems, type ActionItem } from '@/store/selectors';
import { ROLE_LABEL } from '@/lib/screens';
import { Eyebrow, Button } from '@/components';
import { ArrowRight, CircleCheck } from '@/lib/icons';
import styles from './responsive.module.css';

type Tone = ActionItem['tone'];
const TONE: Record<Tone, { accent: string; chip: string; border: string }> = {
  amber: { accent: 'var(--amber-solid)', chip: 'var(--amber-chip)', border: 'var(--amber-border)' },
  red: { accent: 'var(--red-solid)', chip: 'var(--red-chip)', border: 'var(--red-border)' },
  green: { accent: 'var(--green-solid)', chip: 'var(--green-chip)', border: 'var(--green-border)' },
  ink: { accent: 'var(--muted)', chip: 'var(--panel)', border: 'var(--hairline)' },
};

/**
 * "For You" — the per-role home. One cross-cutting to-do list built live from the same
 * decisions, drawings, inspections, daily log and schedule the rest of the app reads, so
 * everyone opens to exactly what needs *them* — and each item disappears the moment it's
 * acted on. Every card is a one-tap jump to the screen where you do the thing. The list is
 * a pure function of state (nothing stored), which is what keeps it honest.
 */
export function InboxScreen() {
  // selectActionItems builds fresh view-model objects each call, so it can't be a live
  // useStore selector (getSnapshot would never stabilise → infinite loop). Subscribe to the
  // whole (stable) state ref and derive the list with useMemo instead — recomputed only when
  // the state object actually changes, which is exactly when the queue can change.
  const state = useStore((s) => s);
  const items = useMemo(() => selectActionItems(state), [state]);
  const role = useStore((s) => s.role);
  const short = useStore((s) => s.short); // this queue is scoped to the active project
  const setScreen = useStore((s) => s.setScreen);

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>FOR YOU · {ROLE_LABEL[role].toUpperCase()}</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>
        {items.length ? `${items.length} thing${items.length === 1 ? ' needs' : 's need'} you` : 'You’re all caught up'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 560 }}>
        Everything waiting on you in <b>{short}</b> — decisions, drawings, inspections and the site log — in one place. Tap a card to go straight there. Switch projects in the left rail to see another.
      </div>

      {items.length === 0 ? (
        <div
          data-testid="inbox-empty"
          style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '34px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}
        >
          <CircleCheck size={28} color="var(--green-solid)" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>Nothing needs you right now</div>
          <div style={{ marginTop: 4 }}>When a decision, drawing or inspection is waiting on you, it’ll show up here.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 22 }}>
          {items.map((it) => {
            const t = TONE[it.tone];
            return (
              <div key={it.key} data-testid={`inbox-item-${it.key}`} style={{ ...card, borderColor: t.border }}>
                <span aria-hidden style={{ ...rail, background: t.accent }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.3 }}>{it.title}</div>
                  {it.detail && (
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {it.detail}
                    </div>
                  )}
                </div>
                <Button
                  variant={it.tone === 'red' ? 'danger' : it.tone === 'amber' ? 'accent' : 'ink'}
                  onClick={() => setScreen(it.screen)}
                  data-testid={`inbox-cta-${it.key}`}
                  style={{ flex: 'none', padding: '9px 13px', fontSize: 13 }}
                >
                  {it.cta} <ArrowRight size={15} />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const card: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 13,
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: '13px 15px 13px 18px',
  overflow: 'hidden',
};

const rail: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 4,
};
