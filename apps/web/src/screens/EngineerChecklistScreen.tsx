import type { CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { Eyebrow, StatTile } from '@/components';
import { Camera } from '@/lib/icons';
import type { ItemState } from '@vitan/shared';
import styles from './responsive.module.css';

const toggleBase: CSSProperties = {
  flex: 1,
  padding: '9px 0',
  borderRadius: 9,
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  fontSize: 12.5,
  cursor: 'pointer',
};

function toggleStyle(active: boolean, solid: string, text: string): CSSProperties {
  return active
    ? { ...toggleBase, border: `1px solid ${solid}`, background: solid, color: '#fff' }
    : { ...toggleBase, border: '1px solid rgba(35,33,28,.15)', background: '#fff', color: text };
}

export function EngineerChecklistScreen() {
  const checklist = useStore((s) => s.checklist);
  const setItem = useStore((s) => s.setItem);
  const addPhoto = useStore((s) => s.addPhoto);
  const setNote = useStore((s) => s.setNote);
  const submitInspection = useStore((s) => s.submitInspection);

  const doneCount = checklist.items.filter((it) => it.state).length;
  const photoCount = checklist.items.reduce((a, it) => a + it.photos, 0);

  const set = (i: number, v: Exclude<ItemState, null>) => () => setItem(i, v);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className={styles.mobileScreen} style={{ flex: 1, paddingBottom: 20 }}>
        <div style={{ padding: '10px 0 14px' }}>
          <Eyebrow size={9}>TODAY'S INSPECTION</Eyebrow>
          <div style={{ fontWeight: 700, fontSize: 21, marginTop: 4, lineHeight: 1.2 }}>{checklist.title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{checklist.zone} · {checklist.date}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <StatTile label="DONE" value={`${doneCount}/${checklist.items.length}`} />
            <StatTile label="PHOTOS" value={photoCount} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {checklist.items.map((it, i) => {
            const border = it.state === 'fail' ? '#E7CBC7' : it.state ? 'rgba(63,122,84,.35)' : 'rgba(35,33,28,.1)';
            return (
              <div key={it.name} style={{ background: '#fff', border: `1px solid ${border}`, borderRadius: 14, padding: '13px 14px' }}>
                <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.3 }}>{it.name}</div>
                <div style={{ display: 'flex', gap: 7, marginTop: 11 }}>
                  <button onClick={set(i, 'pass')} style={toggleStyle(it.state === 'pass', 'var(--green-solid)', 'var(--green-solid)')}>Pass</button>
                  <button onClick={set(i, 'fail')} style={toggleStyle(it.state === 'fail', 'var(--red-solid)', 'var(--red-solid)')}>Fail</button>
                  <button onClick={set(i, 'na')} style={toggleStyle(it.state === 'na', '#6b665c', '#6b665c')}>N.A.</button>
                  <button
                    onClick={() => addPhoto(i)}
                    aria-label="Add photo"
                    style={{
                      flex: 1,
                      padding: '9px 0',
                      borderRadius: 9,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      border: it.photos > 0 ? '1px solid var(--ink)' : '1px solid rgba(35,33,28,.15)',
                      background: it.photos > 0 ? 'var(--ink)' : '#fff',
                      color: it.photos > 0 ? 'var(--sidebar-text)' : 'var(--ink)',
                    }}
                  >
                    <Camera size={15} />
                    {it.photos > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{it.photos}</span>}
                  </button>
                </div>
                {it.state === 'fail' && (
                  <div style={{ marginTop: 10, background: '#FBF0EF', border: '1px solid #E7CBC7', borderRadius: 9, padding: '9px 11px' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--red-solid)', letterSpacing: '.1em' }}>FAIL REQUIRES NOTE + PHOTO</div>
                    <input
                      value={it.note}
                      onChange={(e) => setNote(i, e.target.value)}
                      placeholder="Describe the issue…"
                      style={{ width: '100%', marginTop: 7, border: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none', color: 'var(--ink)' }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.stickyFoot} style={{ padding: '12px 16px 20px', borderTop: '1px solid rgba(35,33,28,.1)', background: 'var(--panel)' }}>
        <button
          onClick={submitInspection}
          data-testid="submit-inspection"
          style={{
            width: '100%',
            maxWidth: 460,
            margin: '0 auto',
            display: 'block',
            padding: 15,
            borderRadius: 12,
            fontFamily: 'var(--font-sans)',
            fontWeight: 600,
            fontSize: 15,
            cursor: 'pointer',
            border: 'none',
            background: checklist.submitted ? 'var(--green-chip)' : 'var(--ink)',
            color: checklist.submitted ? 'var(--green-text)' : 'var(--sidebar-text)',
          }}
        >
          {checklist.submitted ? 'Submitted ✓ — awaiting architect' : 'Submit Inspection'}
        </button>
      </div>
    </div>
  );
}
