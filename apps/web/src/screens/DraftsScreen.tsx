import { type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectDraftDecisions } from '@/store/selectors';
import { Eyebrow, Button, Swatch } from '@/components';
import { Lock, ArrowUpRight, FileEdit } from '@/lib/icons';
import { type SwatchKey } from '@vitan/shared';
import styles from './responsive.module.css';

/**
 * Drafts — a private staging area. A decision you save as a draft lands here and is visible
 * ONLY to you (never on the client's screen, the Decision Log, or the pending count) while you
 * keep working on it. When it's ready, Publish issues it to the client and the app starts
 * acting on it. This is the "hold your data, then publish" workspace: nothing is shared until
 * you say so. (Server-enforced — the snapshot delivers a draft only to its author.)
 */
export function DraftsScreen() {
  const drafts = useStore(useShallow(selectDraftDecisions));
  const publishDecision = useStore((s) => s.publishDecision);

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>DRAFTS · PRIVATE TO YOU</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>Drafts</div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', marginTop: 8, maxWidth: 560 }}>
        <Lock size={13} /> Work in progress, visible only to you. Keep feeding data — nothing reaches the client or the team until you <b>Publish</b>.
      </div>

      {drafts.length === 0 ? (
        <div style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '34px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          <FileEdit size={26} color="#b8b2a6" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>No drafts yet</div>
          <div style={{ marginTop: 4 }}>When you save a decision as a draft instead of issuing it, it waits here — private — until you publish it.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
          {drafts.map((d) => {
            const ready = d.options.length >= 2;
            return (
              <div key={d.id} data-testid={`draft-${d.id}`} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                  <span style={{ fontWeight: 700, fontSize: 15.5 }}>{d.title}</span>
                  <span style={draftChip}>DRAFT</span>
                  <span style={{ fontSize: 11.5, color: 'var(--faint)', marginLeft: 'auto' }}>{d.room}</span>
                </div>

                {/* the options being shortlisted */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  {d.options.map((o) => (
                    <div key={o.key} style={optionPill}>
                      <Swatch swatch={o.swatch as SwatchKey} size={22} radius={5} />
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{o.material}</span>
                      {o.recommended && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, color: 'var(--accent)' }}>REC</span>}
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11.5, color: ready ? 'var(--green-text)' : 'var(--amber-text)' }}>
                    {ready ? 'Ready to publish' : `Add at least ${2 - d.options.length} more option before publishing`}
                  </span>
                  <Button
                    variant="accent"
                    disabled={!ready}
                    onClick={() => publishDecision(d.id)}
                    data-testid={`publish-${d.id}`}
                    style={{ marginLeft: 'auto', padding: '9px 14px', fontSize: 13, opacity: ready ? 1 : 0.5 }}
                  >
                    Publish to client <ArrowUpRight size={15} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const card: CSSProperties = {
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: 15,
};

const draftChip: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: '.08em',
  padding: '2px 7px',
  borderRadius: 5,
  color: 'var(--muted)',
  background: 'var(--panel)',
  border: '1px solid var(--hairline)',
};

const optionPill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  background: 'var(--panel)',
  border: '1px solid var(--hairline)',
  borderRadius: 9,
  padding: '5px 9px',
};
