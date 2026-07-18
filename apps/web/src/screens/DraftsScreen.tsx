import { type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, drawingMutationsBlocked } from '@/store/store';
import { selectDraftDecisions, selectDraftDrawings } from '@/store/selectors';
import { resolveDrawingUrl, drawingsReadMode } from '@/data/apiGateway';
import { Eyebrow, Button, Swatch } from '@/components';
import { Lock, ArrowUpRight, FileEdit, FileText, WifiOff, RefreshCw } from '@/lib/icons';
import { type SwatchKey } from '@vitan/shared';
import styles from './responsive.module.css';

/**
 * Drafts — a private staging area, unified across entity types (decisions + drawings). A thing
 * you save as a draft lands here and is visible ONLY to you (never on the shared surfaces or the
 * counts) while you keep working on it. When it's ready, Publish issues it and the app starts
 * acting on it. "Hold your data, then publish": nothing is shared until you say so. (Server-
 * enforced — the snapshot delivers a draft only to its author.)
 */
export function DraftsScreen() {
  const decisions = useStore(useShallow(selectDraftDecisions));
  const drawings = useStore(useShallow(selectDraftDrawings));
  const publishDecision = useStore((s) => s.publishDecision);
  const publishDrawing = useStore((s) => s.publishDrawing);
  const publishAllDrafts = useStore((s) => s.publishAllDrafts);
  const total = decisions.length + drawings.length;
  const empty = total === 0;
  // Task 10 correction (C3) — under module read-ownership the draft DRAWINGS come from the module-owned
  // register; never publish from it while its read hasn't settled. Expose an honest loading/stale state
  // and disable publishing (both per-drawing and Publish-all when drawings are in the batch) — the SAME
  // shared predicate the store defensively enforces. In snapshot mode this is always false.
  const drawingsBlocked = useStore(drawingMutationsBlocked);
  const drawingsLoad = useStore((s) => s.drawingsLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = drawingsReadMode() === 'moduleQuery';
  const drawingsReading = moduleOwned && (drawingsLoad === 'idle' || drawingsLoad === 'loading');
  const drawingsUnavailable = moduleOwned && drawingsLoad === 'error';

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <Eyebrow>DRAFTS · PRIVATE TO YOU</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em', marginTop: 4 }}>Drafts</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
          <Lock size={13} /> Work in progress, visible only to you. Keep feeding data — nothing reaches the client or the team until you <b>Publish</b>.
        </div>
        {total >= 2 && (
          <Button variant="ink" onClick={publishAllDrafts} disabled={drawings.length > 0 && drawingsBlocked} data-testid="publish-all" style={{ marginLeft: 'auto', flex: 'none', padding: '9px 14px', fontSize: 13, cursor: drawings.length > 0 && drawingsBlocked ? 'not-allowed' : 'pointer', opacity: drawings.length > 0 && drawingsBlocked ? 0.6 : 1 }}>
            Publish all {total} <ArrowUpRight size={15} />
          </Button>
        )}
      </div>

      {empty ? (
        <div style={{ marginTop: 34, textAlign: 'center', color: 'var(--muted)', fontSize: 14, padding: '34px 16px', border: '1px dashed var(--hairline)', borderRadius: 14 }}>
          <FileEdit size={26} color="#b8b2a6" />
          <div style={{ marginTop: 10, fontWeight: 600, color: 'var(--ink)' }}>No drafts yet</div>
          <div style={{ marginTop: 4 }}>When you save a decision or a drawing as a draft instead of issuing it, it waits here — private — until you publish it.</div>
        </div>
      ) : (
        <>
          {decisions.length > 0 && (
            <Group label="Decisions">
              {decisions.map((d) => {
                const ready = d.options.length >= 2;
                return (
                  <div key={d.id} data-testid={`draft-${d.id}`} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <span style={mono}>{d.id}</span>
                      <span style={{ fontWeight: 700, fontSize: 15.5 }}>{d.title}</span>
                      <span style={draftChip}>DRAFT</span>
                      <span style={placeCap}>{d.room}</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                      {d.options.map((o) => (
                        <div key={o.key} style={optionPill}>
                          <Swatch swatch={o.swatch as SwatchKey} size={22} radius={5} />
                          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{o.material}</span>
                          {o.recommended && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 700, color: 'var(--accent)' }}>REC</span>}
                        </div>
                      ))}
                    </div>
                    <Foot
                      ready={ready}
                      readyLabel="Ready to publish"
                      notReadyLabel={`Add at least ${2 - d.options.length} more option before publishing`}
                      cta="Publish to client"
                      testid={`publish-${d.id}`}
                      onPublish={() => publishDecision(d.id)}
                    />
                  </div>
                );
              })}
            </Group>
          )}

          {(drawings.length > 0 || drawingsReading || drawingsUnavailable) && (
            <Group label="Drawings">
              {/* Task 10 correction (C3) — honest register state: never let the user publish drawing drafts
                  read off an unsettled module read. While it loads, say so; on failure show a stale/Retry
                  banner and pause publishing (the per-draft buttons + Publish-all are disabled). */}
              {drawingsReading && (
                <div data-testid="drafts-drawings-loading" style={{ fontSize: 12.5, color: 'var(--muted)', padding: '10px 12px', border: '1px dashed var(--hairline)', borderRadius: 11 }}>
                  Loading the drawing register…
                </div>
              )}
              {drawingsUnavailable && (
                <div data-testid="drafts-drawings-stale" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px' }}>
                  <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>
                    The drawing register couldn’t load — showing the last-known drafts. Publishing is paused until it refreshes.
                  </span>
                  <button onClick={() => requestFreshSnapshot()} data-testid="drafts-drawings-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <RefreshCw size={12} /> Retry
                  </button>
                </div>
              )}
              {drawings.map((d) => {
                const cur = d.current;
                const ready = Boolean(cur);
                return (
                  <div key={d.id} data-testid={`draft-${d.id}`} style={card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <div style={{ width: 40, height: 52, flex: 'none', borderRadius: 6, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {!cur && <FileText size={16} color="#b8b2a6" />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12.5 }}>{d.number}</span>
                          {cur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>Rev {cur.rev}</span>}
                          <span style={draftChip}>DRAFT</span>
                          <span style={{ ...placeCap, marginLeft: 0 }}>{d.discipline}</span>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 14, marginTop: 3 }}>{d.title}</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <Foot
                        ready={ready && !drawingsBlocked}
                        readyLabel="Ready to issue"
                        notReadyLabel={drawingsBlocked ? 'Register still loading — publishing paused' : 'Attach a file before issuing'}
                        cta="Publish to team"
                        testid={`publish-${d.id}`}
                        onPublish={() => publishDrawing(d.id)}
                      />
                    </div>
                  </div>
                );
              })}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em', color: 'var(--faint)', margin: '4px 0 10px' }}>{label.toUpperCase()}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function Foot({ ready, readyLabel, notReadyLabel, cta, testid, onPublish }: { ready: boolean; readyLabel: string; notReadyLabel: string; cta: string; testid: string; onPublish: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11.5, color: ready ? 'var(--green-text)' : 'var(--amber-text)' }}>{ready ? readyLabel : notReadyLabel}</span>
      <Button variant="accent" disabled={!ready} onClick={onPublish} data-testid={testid} style={{ marginLeft: 'auto', padding: '9px 14px', fontSize: 13, opacity: ready ? 1 : 0.5 }}>
        {cta} <ArrowUpRight size={15} />
      </Button>
    </div>
  );
}

const card: CSSProperties = {
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: 15,
};

const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' };
const placeCap: CSSProperties = { fontSize: 11.5, color: 'var(--faint)', marginLeft: 'auto' };

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
