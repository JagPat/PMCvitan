import { useMemo, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, drawingMutationsBlocked } from '@/store/store';
import { resolveDrawingUrl, drawingsReadMode, type IssueDrawingInput } from '@/data/apiGateway';
import { Eyebrow, Button, Modal } from '@/components';
import { LocationPicker } from '@/components/LocationPicker';
import { pathOf } from '@/lib/locationTree';
import { Download, FileText, History, ChevronRight, X, Plus, Lock, Check, HardHat, MapPin, WifiOff, RefreshCw } from '@/lib/icons';
import { can, drawingDisciplineFor, type Discipline, type Drawing, type DrawingRevision } from '@vitan/shared';
import styles from './responsive.module.css';

const DISCIPLINES: { key: Discipline; label: string }[] = [
  { key: 'architectural', label: 'Architectural' },
  { key: 'structural', label: 'Structural' },
  { key: 'mep', label: 'MEP' },
  { key: 'other', label: 'Sketches & References' },
];

function statusMeta(status: string): { label: string; bg: string; fg: string; border: string } {
  if (status === 'for_construction') return { label: 'FOR CONSTRUCTION', bg: 'var(--green-chip, #E7F0E9)', fg: 'var(--green-text, #2F6B44)', border: '#BFD8C6' };
  if (status === 'for_review') return { label: 'FOR REVIEW', bg: 'var(--amber-chip)', fg: 'var(--amber-text)', border: 'var(--amber-border)' };
  return { label: 'SUPERSEDED', bg: 'rgba(35,33,28,.06)', fg: 'var(--faint)', border: 'var(--hairline)' };
}

/** How a revision file previews: PDF inline, image inline, DWG/other download-only. */
function previewKind(mime: string): 'image' | 'pdf' | 'download' {
  if (mime.startsWith('image/') && mime !== 'image/vnd.dwg') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'download';
}

export function DrawingsScreen() {
  // drafts are private WIP — the register shows only published drawings
  const drawings = useStore(useShallow((s) => s.drawings.filter((d) => !d.draft)));
  const nodes = useStore(useShallow((s) => s.nodes));
  const role = useStore((s) => s.role);
  const memberships = useStore(useShallow((s) => s.memberships));
  const activeProjectId = useStore((s) => s.activeProjectId);
  // Phase 2 Task 10 (Module 2 — Drawings; finding 4): under module read-ownership the drawing register
  // is a SEPARATE async surface from the project snapshot, with its own honest load state. Never claim
  // "No drawings issued yet" until a read has actually SUCCEEDED empty; while it loads show a loading
  // line; on failure show an unavailable/Retry boundary (or a stale banner + paused actions when
  // last-good drawings are retained). In snapshot mode `drawingsLoad` stays 'idle' — gates never fire.
  const drawingsLoad = useStore((s) => s.drawingsLoad);
  const requestFreshSnapshot = useStore((s) => s.requestFreshSnapshot);
  const moduleOwned = drawingsReadMode() === 'moduleQuery';
  const reading = moduleOwned && (drawingsLoad === 'idle' || drawingsLoad === 'loading'); // display: loading boundary
  const unavailable = moduleOwned && drawingsLoad === 'error'; // display: unavailable/stale boundary
  // the SINGLE mutation-readiness predicate (Task 10 correction, C3): the same guard the store's actions
  // defensively enforce — Issue/Acknowledge are disabled while the module read is unsettled.
  const actionsLocked = useStore(drawingMutationsBlocked);
  // hold the open drawing by id so the viewer always reflects live store state
  // (e.g. an acknowledgement) rather than a stale snapshot captured on click.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? drawings.find((d) => d.id === openId) ?? null : null;
  const [issuing, setIssuing] = useState(false);

  // Discipline-scoped default: a consultant lands on THEIR discipline's drawings (e.g. a
  // lighting consultant → the MEP set), with a one-tap escape to the whole register. Their
  // discipline comes from the active membership (live API); the demo persona has no
  // membership, so a consultant there falls back to a representative discipline.
  const myMembership = memberships.find((m) => m.projectId === activeProjectId);
  const myDiscipline = myMembership?.discipline ?? (role === 'consultant' && memberships.length === 0 ? 'structural' : undefined);
  const scopeKey = role === 'consultant' && myDiscipline ? drawingDisciplineFor(myDiscipline) : null;
  const [scoped, setScoped] = useState(true); // consultants default to their discipline

  const groups = useMemo(() => {
    const all = DISCIPLINES.map((d) => ({ ...d, items: drawings.filter((dr) => dr.discipline === d.key) })).filter((g) => g.items.length);
    return scopeKey && scoped ? all.filter((g) => g.key === scopeKey) : all;
  }, [drawings, scopeKey, scoped]);
  const scopeLabel = scopeKey ? DISCIPLINES.find((d) => d.key === scopeKey)?.label ?? scopeKey : '';

  return (
    <div className={`${styles.screen} ${styles.mid}`}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Eyebrow>DRAWINGS · REGISTER</Eyebrow>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, maxWidth: 520 }}>
            The current issue the team builds from. New revisions supersede the old — the field always sees the latest <b>For Construction</b> set. Drawings you open are cached for <b>offline</b> viewing on site.
          </div>
        </div>
        {can('drawing.issue', role) && (
          <Button variant="ink" onClick={() => setIssuing(true)} disabled={actionsLocked} data-testid="issue-drawing" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '11px 15px', fontSize: 13, cursor: actionsLocked ? 'not-allowed' : 'pointer', opacity: actionsLocked ? 0.6 : 1 }}>
            <Plus size={16} /> Issue drawing
          </Button>
        )}
      </div>

      {/* finding 4 — the module read FAILED but last-good drawings are retained: show an explicit
          stale/unavailable warning + Retry (never silent stale data with a live Issue button). Retry
          re-runs the scope-guarded module read; on success it applies fresh data, clears
          drawingsLoad→ready and re-enables the paused actions. Only shows when there IS a register to
          keep — an empty failed read falls to the unavailable boundary below. */}
      {unavailable && drawings.length > 0 && (
        <div data-testid="drawings-stale-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 11, padding: '9px 12px', marginTop: 14 }}>
          <WifiOff size={15} color="var(--amber-text)" style={{ flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--amber-text)' }}>
            Showing the last-known register — the latest couldn't load. Actions are paused until it refreshes.
          </span>
          <button onClick={() => requestFreshSnapshot()} data-testid="drawings-retry" style={{ background: 'transparent', border: '1px solid var(--amber-border)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--amber-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {/* consultant discipline scope — their set by default, one tap to see everything */}
      {scopeKey && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 2px', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', color: 'var(--faint)' }}>SHOWING</span>
          <div style={{ display: 'inline-flex', background: 'var(--panel)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 2 }}>
            <button onClick={() => setScoped(true)} data-testid="scope-mine" style={scopeBtn(scoped)}>My discipline · {scopeLabel}</button>
            <button onClick={() => setScoped(false)} data-testid="scope-all" style={scopeBtn(!scoped)}>All disciplines</button>
          </div>
        </div>
      )}

      {/* finding 4 — under module read-ownership the register is a SEPARATE async surface: never claim
          "No drawings issued yet" until a read has SUCCEEDED empty. While it loads show a loading line;
          on failure with no last-good register show an unavailable/Retry boundary. In snapshot mode
          `reading`/`unavailable` are false and only the honest-empty branch renders. */}
      {reading && drawings.length === 0 && (
        <div data-testid="drawings-loading" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Loading the drawing register…</div>
      )}
      {unavailable && drawings.length === 0 && (
        <div data-testid="drawings-unavailable" style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><WifiOff size={18} /> Drawing register unavailable.</div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Check your connection and access, then retry.</div>
          <div style={{ marginTop: 14 }}>
            <Button variant="ink" onClick={() => requestFreshSnapshot()} data-testid="drawings-retry-empty" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={15} /> Retry
            </Button>
          </div>
        </div>
      )}
      {!reading && !unavailable && drawings.length === 0 && (
        <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>No drawings issued yet.</div>
      )}

      {scopeKey && scoped && groups.length === 0 && drawings.length > 0 && (
        <div style={{ marginTop: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
          No {scopeLabel} drawings filed yet —{' '}
          <button onClick={() => setScoped(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 13.5, padding: 0 }}>show all disciplines</button>.
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key} style={{ marginTop: 26 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.18em', color: 'var(--faint)', marginBottom: 10 }}>{g.label.toUpperCase()}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {g.items.map((d) => {
              const cur = d.current;
              // No governing construction set (Phase 1 Task 3): a drawing whose only
              // live revisions are review copies is labeled, never built from.
              const inReviewOnly = !cur && d.revisions.some((r) => r.status === 'for_review');
              const sm = inReviewOnly
                ? { ...statusMeta('for_review'), label: 'IN REVIEW — NOT FOR CONSTRUCTION' }
                : statusMeta(cur?.status ?? 'superseded');
              const place = pathOf(nodes, d.nodeId).join(' › ');
              return (
                <button key={d.id} onClick={() => setOpenId(d.id)} data-testid={`drawing-${d.number}`} style={cardStyle}>
                  <div style={{ width: 46, height: 60, flex: 'none', borderRadius: 6, border: '1px solid var(--hairline)', background: cur ? `center/cover no-repeat url("${resolveDrawingUrl(cur.url)}"), var(--panel)` : 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {!cur && <FileText size={18} color="#b8b2a6" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13 }}>{d.number}</span>
                      {cur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700, color: 'var(--accent)' }}>Rev {cur.rev}</span>}
                      <span style={{ ...chip, background: sm.bg, color: sm.fg, borderColor: sm.border }}>{sm.label}</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14.5, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {place ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent)' }}><MapPin size={11} /> {place}</span>
                      ) : (
                        <span>{d.zone ?? '—'}</span>
                      )}
                      {d.activityId ? ` · governs ${d.activityId}` : ''}
                      {d.revisions.length > 1 ? ` · ${d.revisions.length} revisions` : ''}
                    </div>
                  </div>
                  <ChevronRight size={18} color="#b8b2a6" />
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {open && <DrawingViewer drawing={open} onClose={() => setOpenId(null)} />}
      {issuing && <IssueDrawingModal onClose={() => setIssuing(false)} />}
    </div>
  );
}

const ROLE_SHORT: Record<string, string> = { pmc: 'PMC', client: 'Client', engineer: 'Engineer', contractor: 'Contractor', worker: 'Worker' };

/** The build-acknowledgement block for the current revision (Slice 2). Contractor/
 *  engineer confirm they're building to it; the PMC/everyone sees who has. Reads
 *  the live current revision so a fresh ack shows immediately. */
function AckBlock({ drawing }: { drawing: Drawing }) {
  const role = useStore((s) => s.role);
  const acknowledgeDrawing = useStore((s) => s.acknowledgeDrawing);
  // finding 4 / Task 10 correction (C3) — the ack is a mutating command; don't record it against a
  // register whose module read hasn't settled. The SINGLE shared predicate the store also enforces.
  const ackLocked = useStore(drawingMutationsBlocked);
  const rev = drawing.current;
  // Reads the shared policy so the button appears for exactly the roles the API accepts
  // (pmc/engineer/contractor) — previously omitted pmc, who the server allows.
  const canAck = can('drawing.acknowledge', role);
  const acks = rev?.acks ?? [];
  if (!rev) return null;

  return (
    <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 9 }}>
        <HardHat size={13} /> BUILDING TO REV {rev.rev}
      </div>
      {acks.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: canAck ? 12 : 0 }}>
          {acks.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <Check size={14} color="#2F6B44" />
              <span style={{ fontWeight: 600 }}>{a.userName}</span>
              <span style={{ ...chip, background: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--hairline)' }}>{ROLE_SHORT[a.role] ?? a.role}</span>
              <span style={{ fontSize: 11, color: 'var(--faint)', marginLeft: 'auto' }}>{a.at}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: canAck ? 12 : 0 }}>No one has acknowledged this revision yet.</div>
      )}
      {/* the frozen distribution (Phase 1 Task 3): who this revision was ISSUED to and hasn't confirmed yet */}
      {(rev.recipients ?? []).some((r) => !r.acked) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: canAck ? 12 : 0 }} data-testid="ack-outstanding">
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.14em', color: 'var(--faint)' }}>ISSUED TO — NOT YET CONFIRMED</div>
          {(rev.recipients ?? []).filter((r) => !r.acked).map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
              <span style={{ fontWeight: 600 }}>{r.userName}</span>
              <span style={{ ...chip, background: 'var(--panel)', color: 'var(--muted)', borderColor: 'var(--hairline)' }}>{ROLE_SHORT[r.role] ?? r.role}</span>
            </div>
          ))}
        </div>
      )}
      {canAck && (
        drawing.ackedByMe ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--green-text, #2F6B44)' }}>
            <Check size={16} /> You’re building to Rev {rev.rev}
          </div>
        ) : (
          <Button variant="ink" onClick={() => acknowledgeDrawing(drawing.id)} disabled={ackLocked} data-testid="ack-drawing" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', fontSize: 13, cursor: ackLocked ? 'not-allowed' : 'pointer', opacity: ackLocked ? 0.6 : 1 }}>
            <HardHat size={15} /> I’m building to Rev {rev.rev}
          </Button>
        )
      )}
    </div>
  );
}

export function DrawingViewer({ drawing, onClose }: { drawing: Drawing; onClose: () => void }) {
  const [rev, setRev] = useState<DrawingRevision>(drawing.current ?? drawing.revisions[0]);
  const src = resolveDrawingUrl(rev.url);
  const kind = previewKind(rev.mime);
  const sm = statusMeta(rev.status);
  const isCurrent = drawing.current?.id === rev.id;

  return (
    <Modal onClose={onClose} maxWidth={760} labelledBy="dwg-title">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--hairline)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="dwg-title" style={{ fontWeight: 700, fontSize: 16 }}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{drawing.number}</span> · {drawing.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Rev {rev.rev} · issued by {rev.issuedBy} · {rev.issuedAt}
          </div>
        </div>
        <span style={{ ...chip, background: sm.bg, color: sm.fg, borderColor: sm.border }}>{sm.label}</span>
        <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
          <X size={20} />
        </button>
      </div>

      <div style={{ background: '#e9e4d8', maxHeight: '58vh', overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
        {kind === 'image' && <img src={src} alt={`${drawing.number} Rev ${rev.rev}`} style={{ maxWidth: '100%', display: 'block' }} />}
        {kind === 'pdf' && <iframe src={src} title={`${drawing.number} Rev ${rev.rev}`} style={{ width: '100%', height: '58vh', border: 'none', background: '#fff' }} />}
        {kind === 'download' && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <FileText size={40} color="#b8b2a6" />
            <div style={{ fontSize: 13.5, color: 'var(--muted)', margin: '12px 0 16px', maxWidth: 320 }}>
              {rev.mime.includes('dwg') || rev.mime.includes('dxf') ? 'CAD source (DWG) — not previewable in the browser. Download it, or view the issued PDF.' : 'This file type can’t be previewed. Download to open it.'}
            </div>
            <a href={src} download={`${drawing.number}-Rev${rev.rev}`} style={{ ...dlBtn }}>
              <Download size={16} /> Download
            </a>
          </div>
        )}
      </div>

      {rev.note && <div style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--muted)', borderTop: '1px solid var(--hairline)' }}>{rev.note}</div>}

      <DrawingLocationBlock drawing={drawing} />

      {isCurrent && rev.status !== 'superseded' && <AckBlock drawing={drawing} />}

      <div style={{ padding: '12px 18px 16px', borderTop: '1px solid var(--hairline)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 8 }}>
          <History size={13} /> REVISION HISTORY
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {drawing.revisions.map((r) => {
            const on = r.id === rev.id;
            const s = statusMeta(r.status);
            return (
              <button key={r.id} onClick={() => setRev(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '9px 11px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${on ? 'var(--ink)' : 'var(--hairline)'}`, background: on ? 'rgba(35,33,28,.04)' : '#fff' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 12, width: 42 }}>Rev {r.rev}</span>
                <span style={{ ...chip, background: s.bg, color: s.fg, borderColor: s.border }}>{s.label}</span>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>{r.issuedAt} · {r.issuedBy}</span>
                {r.status !== 'superseded' && <Lock size={12} color="#2F6B44" />}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/** Location of a drawing on the spine + a PMC re-file control. Everyone sees where the
 *  drawing sits; the PMC (drawing.file) can move it, and rooms below inherit it. */
function DrawingLocationBlock({ drawing }: { drawing: Drawing }) {
  const nodes = useStore(useShallow((s) => s.nodes));
  const role = useStore((s) => s.role);
  const fileDrawing = useStore((s) => s.fileDrawing);
  const canFile = can('drawing.file', role);
  // Task 10 correction (C2b) — re-file / unfile are drawing MUTATIONS: never run them against a register
  // whose module read hasn't settled. The SINGLE shared predicate the store also defensively enforces;
  // it's reactive, so if the register goes idle/loading/error while the location editor is OPEN, the
  // picker + Unfile disable immediately and every location mutation command is prevented until 'ready'.
  const locked = useStore(drawingMutationsBlocked);
  const place = pathOf(nodes, drawing.nodeId).join(' › ');
  const [editing, setEditing] = useState(false);

  return (
    <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--hairline)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.16em', color: 'var(--faint)', marginBottom: 9 }}>
        <MapPin size={13} /> LOCATION
      </div>
      {!editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: place ? 600 : 400, color: place ? 'var(--ink)' : 'var(--muted)' }}>
            {place || 'Not filed to a location (project-wide)'}
          </span>
          {canFile && (
            <button onClick={() => { if (!locked) setEditing(true); }} disabled={locked} data-testid="drawing-refile" style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--hairline)', borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.5 : 1, color: 'var(--accent)' }}>
              {place ? 'Move' : 'File to a location'}
            </button>
          )}
        </div>
      )}
      {editing && canFile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {locked && (
            <div data-testid="drawing-location-paused" style={{ fontSize: 12, color: 'var(--amber-text)', background: 'var(--amber-chip)', border: '1px solid var(--amber-border)', borderRadius: 9, padding: '7px 10px' }}>
              The drawing register is still loading — location changes are paused until it refreshes.
            </div>
          )}
          {/* the picker is inert while locked: pointer-events off + a guarded onChange (belt-and-braces
              with the store's own defensive fileDrawing guard) */}
          <div style={{ pointerEvents: locked ? 'none' : 'auto', opacity: locked ? 0.5 : 1 }} aria-disabled={locked}>
            <LocationPicker value={drawing.nodeId ?? null} onChange={(id) => { if (locked) return; fileDrawing(drawing.id, id); }} idPrefix="dwg-refile" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {drawing.nodeId && (
              <Button variant="outline" disabled={locked} onClick={() => { if (locked) return; fileDrawing(drawing.id, null); setEditing(false); }} data-testid="drawing-unfile" style={{ padding: '7px 12px', fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.5 : 1 }}>Unfile</Button>
            )}
            <Button variant="ink" onClick={() => setEditing(false)} style={{ padding: '7px 12px', fontSize: 12, marginLeft: 'auto' }}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const DISCIPLINE_OPTS: Discipline[] = ['architectural', 'structural', 'mep', 'other'];

function IssueDrawingModal({ onClose }: { onClose: () => void }) {
  const issueDrawing = useStore((s) => s.issueDrawing);
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [discipline, setDiscipline] = useState<Discipline>('architectural');
  const [rev, setRev] = useState('A');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [file, setFile] = useState<{ mime: string; data: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const onPick = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const comma = res.indexOf(',');
      setFile({ mime: f.type || 'application/octet-stream', data: res.slice(comma + 1), name: f.name });
    };
    reader.readAsDataURL(f);
  };

  const ready = number.trim() && title.trim() && rev.trim() && file && !busy;
  const submit = (publish: boolean) => {
    if (!ready || !file) return;
    setBusy(true);
    const input: IssueDrawingInput = { number: number.trim(), title: title.trim(), discipline, rev: rev.trim(), mime: file.mime, data: file.data, status: 'for_construction', publish, ...(nodeId ? { nodeId } : {}) };
    issueDrawing(input);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={440} labelledBy="issue-title">
      <div style={{ padding: '18px 20px' }}>
        <div id="issue-title" style={{ fontWeight: 700, fontSize: 17 }}>New drawing</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>A matching number adds a revision and supersedes the prior. <b>Save as draft</b> to prepare it privately, or <b>Publish</b> to issue it to the build team.</div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Number (A-201)" style={{ ...fld, flex: 1 }} />
          <input value={rev} onChange={(e) => setRev(e.target.value)} placeholder="Rev" style={{ ...fld, width: 70 }} />
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={{ ...fld, marginTop: 10 }} />
        <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)} style={{ ...fld, marginTop: 10 }}>
          {DISCIPLINE_OPTS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '14px 0 7px' }}>LOCATION (OPTIONAL)</div>
        <div style={{ fontSize: 11.5, color: 'var(--faint)', marginBottom: 7 }}>File it at its level — a floor plan on the zone, a detail on the object. Rooms below inherit it.</div>
        <LocationPicker value={nodeId} onChange={setNodeId} idPrefix="dwg-loc" />

        <label style={{ display: 'block', marginTop: 10 }}>
          <input type="file" accept=".pdf,.dwg,.dxf,image/*,application/pdf" onChange={(e) => onPick(e.target.files?.[0])} style={{ fontSize: 13 }} />
        </label>
        {file && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{file.name}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: '0 0 auto', padding: '12px 16px' }}>Cancel</Button>
          <Button variant="light" onClick={() => submit(false)} disabled={!ready} data-testid="save-draft-drawing" style={{ flex: 1, padding: 12 }}>Save as draft</Button>
          <Button variant="ink" onClick={() => submit(true)} disabled={!ready} data-testid="publish-drawing" style={{ flex: 1, padding: 12 }}>Publish</Button>
        </div>
      </div>
    </Modal>
  );
}

const scopeBtn = (active: boolean): CSSProperties => ({
  padding: '6px 11px',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  fontWeight: 600,
  background: active ? 'var(--ink)' : 'transparent',
  color: active ? '#fff' : 'var(--muted)',
});

const cardStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 13,
  textAlign: 'left',
  width: '100%',
  background: '#fff',
  border: '1px solid var(--hairline)',
  borderRadius: 13,
  padding: '12px 14px',
  cursor: 'pointer',
};

const chip: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '.08em',
  padding: '3px 7px',
  borderRadius: 5,
  border: '1px solid',
};

const fld: CSSProperties = {
  height: 44,
  padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(35,33,28,.18)',
  background: '#fff',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--ink)',
  outline: 'none',
};

const dlBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 18px',
  borderRadius: 11,
  background: 'var(--ink)',
  color: '#fff',
  fontFamily: 'var(--font-sans)',
  fontWeight: 700,
  fontSize: 14,
  textDecoration: 'none',
};
