import { useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type IssueDecisionPayload } from '@/store/store';
import { selectLogDecisions } from '@/store/selectors';
import { Eyebrow, DecisionChip, Button, Modal } from '@/components';
import { Lock, Plus, X } from '@/lib/icons';
import { signed, swatch as swatchGradient, decisionRail, can, SW, type SwatchKey } from '@vitan/shared';
import styles from './responsive.module.css';

export function DecisionLogScreen() {
  const rows = useStore(useShallow(selectLogDecisions));
  const openChange = useStore((s) => s.openChange);
  const role = useStore((s) => s.role);
  const [issuing, setIssuing] = useState(false);

  return (
    <div className={`${styles.screen} ${styles.narrow}`}>
      <Eyebrow>CLIENT DECISION LOG</Eyebrow>
      <div className={styles.headRule} style={{ margin: '6px 0 8px' }}>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.01em' }}>Decision Register</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>{rows.length} DECISIONS</div>
          {can('decision.create', role) && (
            <Button variant="ink" onClick={() => setIssuing(true)} data-testid="issue-decision" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5 }}>
              <Plus size={15} /> Issue decision
            </Button>
          )}
        </div>
      </div>
      {issuing && <IssueDecisionModal onClose={() => setIssuing(false)} />}
      <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '10px 0 22px' }}>
        Single source of truth. Once approved, a decision is locked — any change must go through a formal Change Request.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map((d) => {
          const locked = d.status === 'approved';
          const attribution = d.approver
            ? `Approved by ${d.approver} · ${d.date}`
            : `Ageing ${d.ageDays} days · awaiting client`;
          const approvedLine =
            d.status === 'pending' ? `${d.options.length} options presented` : `${d.approvedOption} — ${d.material}`;
          const costStr =
            d.status === 'pending'
              ? 'up to ' + signed(Math.max(...d.options.map((o) => o.delta)))
              : signed(d.cost ?? 0);
          const photoLabel = d.status === 'pending' ? 'OPTIONS' : 'APPROVED';

          return (
            <div
              key={d.id}
              data-testid={`log-row-${d.id}`}
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--hairline)',
                borderLeft: `4px solid ${decisionRail[d.status]}`,
                borderRadius: 12,
                overflow: 'hidden',
                animation: 'vpop .3s',
              }}
            >
              <div className={styles.logRow}>
                <div className={styles.logPhoto} style={{ background: swatchGradient(d.photoSwatch), position: 'relative', flex: 'none' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 8,
                      bottom: 8,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8,
                      color: 'rgba(255,255,255,.9)',
                      background: 'rgba(0,0,0,.4)',
                      padding: '1px 6px',
                      borderRadius: 3,
                    }}
                  >
                    {photoLabel}
                  </span>
                </div>
                <div style={{ flex: 1, padding: '16px 20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>{d.id}</span>
                        <span style={{ fontWeight: 600, fontSize: 16 }}>{d.title}</span>
                        {locked && <Lock size={13} data-testid={`lock-${d.id}`} />}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{d.room}</div>
                    </div>
                    <DecisionChip status={d.status} />
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-end',
                      marginTop: 14,
                      paddingTop: 12,
                      borderTop: '1px solid rgba(35,33,28,.1)',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{approvedLine}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 3 }}>{attribution}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 13,
                          fontWeight: 600,
                          color: (d.cost ?? 0) > 0 ? 'var(--ink)' : 'var(--muted)',
                        }}
                      >
                        {costStr}
                      </div>
                      {locked && (
                        <Button
                          variant="outline"
                          onClick={() => openChange(d.id)}
                          style={{ marginTop: 7, padding: '6px 12px', fontSize: 11.5, fontWeight: 500 }}
                        >
                          Request Change
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface OptionDraft {
  material: string;
  delta: string; // rupee delta as typed
  swatch: SwatchKey;
  recommended: boolean;
  photo?: { mime: string; data: string; preview: string };
}

const SWATCH_KEYS = Object.keys(SW) as SwatchKey[];
const blankOption = (): OptionDraft => ({ material: '', delta: '0', swatch: 'tile', recommended: false });

/** PMC issues a new decision: title/room + 2–4 options (material, ₹ delta, swatch or a
 *  sample photo, one recommended). Publishes as pending on the client's screen. */
function IssueDecisionModal({ onClose }: { onClose: () => void }) {
  const issueDecision = useStore((s) => s.issueDecision);
  const [title, setTitle] = useState('');
  const [room, setRoom] = useState('');
  const [options, setOptions] = useState<OptionDraft[]>([blankOption(), blankOption()]);

  const setOpt = (i: number, patch: Partial<OptionDraft>) =>
    setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : patch.recommended ? { ...o, recommended: false } : o)));

  const pickPhoto = (i: number, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const [head, data] = dataUrl.split(',');
      const mime = head.match(/data:(.*?);/)?.[1] ?? 'image/jpeg';
      setOpt(i, { photo: { mime, data, preview: dataUrl } });
    };
    reader.readAsDataURL(file);
  };

  const ready = title.trim() && room.trim() && options.every((o) => o.material.trim());
  const save = () => {
    if (!ready) return;
    const payload: IssueDecisionPayload = {
      title: title.trim(),
      room: room.trim(),
      options: options.map((o) => ({
        material: o.material.trim(),
        delta: parseInt(o.delta.replace(/[^\d-]/g, ''), 10) || 0,
        swatch: o.swatch,
        recommended: o.recommended,
        ...(o.photo ? { photo: { mime: o.photo.mime, data: o.photo.data } } : {}),
      })),
    };
    issueDecision(payload);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={560} labelledBy="issue-dec-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="issue-dec-title" style={{ fontWeight: 700, fontSize: 17 }}>Issue decision</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Present 2–4 options; the client picks one and it locks. Mark your recommendation.
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Master Bath Flooring)" style={{ ...fldD, marginTop: 14, width: '100%' }} data-testid="dec-title" />
        <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Room / zone" style={{ ...fldD, marginTop: 10, width: '100%' }} />

        {options.map((o, i) => (
          <div key={i} style={{ marginTop: 14, padding: 12, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--panel)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)' }}>OPTION {String.fromCharCode(65 + i)}</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, marginLeft: 'auto' }}>
                <input type="radio" name="recommended" checked={o.recommended} onChange={() => setOpt(i, { recommended: true })} /> Recommended
              </label>
              {options.length > 2 && (
                <button onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                  <X size={15} />
                </button>
              )}
            </div>
            <input value={o.material} onChange={(e) => setOpt(i, { material: e.target.value })} placeholder="Material (e.g. Italian Marble)" style={{ ...fldD, width: '100%' }} data-testid={`dec-opt-${i}`} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={o.delta} onChange={(e) => setOpt(i, { delta: e.target.value })} placeholder="₹ delta (0 = base)" style={{ ...fldD, flex: '0 0 130px' }} />
              <select value={o.swatch} onChange={(e) => setOpt(i, { swatch: e.target.value as SwatchKey })} style={{ ...fldD, flex: '0 0 120px' }} aria-label="Swatch">
                {SWATCH_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <span style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--hairline)', background: o.photo ? `center/cover url(${o.photo.preview})` : swatchGradient(o.swatch) }} />
              <label style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>
                {o.photo ? 'Change photo' : 'Add sample photo'}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pickPhoto(i, e.target.files?.[0] ?? null)} />
              </label>
            </div>
          </div>
        ))}

        {options.length < 4 && (
          <button onClick={() => setOptions((prev) => [...prev, blankOption()])} style={{ marginTop: 12, background: 'transparent', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, cursor: 'pointer', color: 'var(--muted)', width: '100%' }}>
            + Add another option
          </button>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!ready} data-testid="save-decision" style={{ flex: 1, padding: 12 }}>Issue to client</Button>
        </div>
      </div>
    </Modal>
  );
}

const fldD: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
