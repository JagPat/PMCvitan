import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { selectTotalWorkers } from '@/store/selectors';
import { Eyebrow, Swatch, PhotoViewer, Modal, Button } from '@/components';
import { LocationPicker } from '@/components/LocationPicker';
import { pathOf } from '@/lib/locationTree';
import { Crosshair, Camera, Plus, Minus, QrCode, TriangleAlert, Check, MapPin } from '@/lib/icons';
import { can, SW, type SwatchKey } from '@vitan/shared';
import styles from './responsive.module.css';

export function DailyLogScreen() {
  const dailyLog = useStore((s) => s.dailyLog);
  const photos = useStore(useShallow((s) => s.dailyLog.photos));
  const nodes = useStore(useShallow((s) => s.nodes));
  const online = useStore((s) => s.online);
  const queueCount = useStore((s) => s.syncQueue.length + s.outbox.length);
  const total = useStore(selectTotalWorkers);
  const toggleOnline = useStore((s) => s.toggleOnline);
  const checkIn = useStore((s) => s.checkIn);
  const checkOut = useStore((s) => s.checkOut);
  const crewStep = useStore((s) => s.crewStep);
  const openQr = useStore((s) => s.openQr);
  const flagMismatch = useStore((s) => s.flagMismatch);
  const addProgressPhoto = useStore((s) => s.addProgressPhoto);
  const submitDailyLog = useStore((s) => s.submitDailyLog);
  const role = useStore((s) => s.role);
  const startDailyLog = useStore((s) => s.startDailyLog);

  const fileRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [addingMaterial, setAddingMaterial] = useState(false);
  const [photoNode, setPhotoNode] = useState<string | null>(null); // location spine: place the next photo

  const onPickPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') addProgressPhoto(reader.result, photoNode);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = ''; // allow re-picking the same file
  };

  const conn = online
    ? { bg: 'var(--green-chip)', border: 'var(--green-border)', dot: 'var(--green-solid)', color: 'var(--green-text)', text: 'Online · all synced', toggle: 'Simulate offline' }
    : { bg: 'var(--amber-chip)', border: 'var(--amber-border)', dot: 'var(--amber-solid)', color: 'var(--amber-text)', text: `Offline · ${queueCount} update${queueCount === 1 ? '' : 's'} queued`, toggle: 'Back online' };

  const sectionLabel: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)', margin: '22px 0 10px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className={styles.mobileScreen} style={{ flex: 1, paddingBottom: 20 }}>
        <div style={{ padding: '10px 0 12px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <Eyebrow size={9}>DAILY SITE LOG</Eyebrow>
            <div style={{ fontWeight: 700, fontSize: 22, marginTop: 4 }}>Residence at Ambli</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{dailyLog.date}</div>
          </div>
          {dailyLog.submitted && can('dailyLog.start', role) && (
            <Button variant="outline" onClick={startDailyLog} data-testid="start-new-day" style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 13px', fontSize: 12.5, whiteSpace: 'nowrap' }}>
              <Plus size={15} /> Start new day
            </Button>
          )}
        </div>

        {/* connectivity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: conn.bg, border: `1px solid ${conn.border}`, borderRadius: 11, padding: '9px 12px', marginBottom: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: conn.dot, flex: 'none' }} />
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: conn.color }} data-testid="conn-text">{conn.text}</span>
          <button onClick={toggleOnline} data-testid="toggle-online" style={{ background: 'transparent', border: '1px solid rgba(35,33,28,.2)', borderRadius: 7, padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' }}>
            {conn.toggle}
          </button>
        </div>

        {/* check-in */}
        {dailyLog.checkedIn ? (
          <div style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', borderRadius: 15, padding: 15, display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: 'linear-gradient(135deg,#6b5a48,#3a2f26)', flex: 'none', position: 'relative' }}>
              <span style={{ position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: '50%', background: 'var(--green-solid)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Check size={10} color="#fff" strokeWidth={3} />
              </span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Checked in · {dailyLog.checkinTime}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'rgba(237,231,218,.55)', marginTop: 2 }}>Ambli site · within 60 m · GPS + selfie</div>
            </div>
            <button onClick={checkOut} style={{ background: 'transparent', border: '1px solid rgba(237,231,218,.3)', color: 'var(--sidebar-text)', padding: '8px 11px', borderRadius: 8, fontFamily: 'var(--font-sans)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
              Check out
            </button>
          </div>
        ) : (
          <>
            <button onClick={checkIn} data-testid="check-in" style={{ width: '100%', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 15, padding: 18, fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
              <Crosshair size={18} /> Check in at site
            </button>
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--faint)', marginTop: 7 }}>Uses this phone's GPS + a selfie as proof of presence</div>
          </>
        )}

        {/* crew */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '22px 0 10px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '.2em', color: 'var(--faint)' }}>CREW PRESENT TODAY</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }} data-testid="crew-total">{total} workers</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {dailyLog.crew.map((c, i) => (
            <div key={c.trade} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 12, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 11 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: c.count > 0 ? 'var(--green-solid)' : 'rgba(35,33,28,.18)' }} />
              <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{c.trade}</div>
              <button onClick={() => crewStep(i, -1)} aria-label={`Remove ${c.trade}`} style={stepBtn}>
                <Minus size={16} />
              </button>
              <div style={{ width: 26, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15 }}>{c.count}</div>
              <button onClick={() => crewStep(i, 1)} aria-label={`Add ${c.trade}`} style={stepBtn}>
                <Plus size={16} />
              </button>
            </div>
          ))}
        </div>
        <button onClick={openQr} style={{ width: '100%', marginTop: 10, background: '#fff', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 11, padding: 12, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, color: 'var(--ink)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <QrCode size={16} /> Worker self check-in (scan QR)
        </button>

        {/* materials */}
        <div style={sectionLabel}>MATERIAL ON SITE</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {dailyLog.materials.map((m, i) => (
            <div key={m.name} style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 12, display: 'flex', gap: 12 }}>
              <Swatch swatch={m.swatch} size={52} radius={10} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{m.name}</div>
                  {m.matched && (
                    <button onClick={() => flagMismatch(i)} data-testid={`flag-${m.decisionId}`} style={{ background: 'transparent', border: 'none', color: 'var(--red-solid)', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', padding: 0, display: 'flex', alignItems: 'center', gap: 3 }}>
                      <TriangleAlert size={11} /> Flag mismatch
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 2, color: m.matched ? 'var(--green-text)' : 'var(--red-solid)', fontWeight: m.matched ? 400 : 600 }}>
                  {m.matched ? `✓ Matches locked decision ${m.decisionId}` : `⚠ MISMATCH — not the approved ${m.decisionId}`}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)', marginTop: 3 }}>{m.qty} · {m.zone}</div>
              </div>
            </div>
          ))}
        </div>
        {can('dailyLog.addMaterial', role) && (
          <button onClick={() => setAddingMaterial(true)} data-testid="add-material" style={{ width: '100%', marginTop: 10, background: '#fff', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 11, padding: 12, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, color: 'var(--ink)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Plus size={16} /> Record material delivery
          </button>
        )}

        {/* progress */}
        <div style={sectionLabel}>TODAY'S PROGRESS</div>
        <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{dailyLog.progress} progress photos</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>Geo + time stamped, tied to activity</div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPickPhoto} data-testid="progress-file" style={{ display: 'none' }} />
          <button onClick={() => fileRef.current?.click()} data-testid="add-progress-photo" style={{ background: 'var(--ink)', color: 'var(--sidebar-text)', border: 'none', padding: '10px 14px', borderRadius: 9, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Camera size={14} /> Add
          </button>
        </div>
        {/* Location spine: place the next photo so it shows up at that zone/room/object. */}
        {nodes.length > 0 && (
          <div style={{ background: '#fff', border: '1px solid rgba(35,33,28,.1)', borderRadius: 13, padding: 12, marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em', color: 'var(--faint)', marginBottom: 8 }}>
              <MapPin size={12} /> PLACE THIS PHOTO {photoNode ? '' : '(OPTIONAL)'}
            </div>
            <LocationPicker value={photoNode} onChange={setPhotoNode} idPrefix="photo-loc" />
            {photoNode && (
              <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>Next photo → {pathOf(nodes, photoNode).join(' › ')}</div>
            )}
          </div>
        )}
        {photos.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto', paddingBottom: 4 }}>
            {photos.map((p, i) => (
              <button
                key={p.id ?? i}
                onClick={() => setZoom(p.url)}
                data-testid="progress-thumb"
                style={{ flex: 'none', width: 66, height: 66, borderRadius: 10, border: '1px solid rgba(35,33,28,.12)', padding: 0, overflow: 'hidden', cursor: 'zoom-in', background: '#000' }}
              >
                <img src={p.url} alt={`Progress photo ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </button>
            ))}
          </div>
        )}
      </div>

      {zoom && <PhotoViewer url={zoom} onClose={() => setZoom(null)} />}
      {addingMaterial && <AddMaterialModal onClose={() => setAddingMaterial(false)} />}

      <div className={styles.stickyFoot} style={{ padding: '12px 16px 20px', borderTop: '1px solid rgba(35,33,28,.1)', background: 'var(--panel)' }}>
        <button
          onClick={submitDailyLog}
          data-testid="submit-daily-log"
          style={{ width: '100%', maxWidth: 460, margin: '0 auto', display: 'block', padding: 15, borderRadius: 12, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, cursor: 'pointer', border: 'none', background: dailyLog.submitted ? 'var(--green-chip)' : 'var(--ink)', color: dailyLog.submitted ? 'var(--green-text)' : 'var(--sidebar-text)' }}
        >
          {dailyLog.submitted ? 'Submitted ✓ — sent to PMC' : 'Submit Daily Log to PMC'}
        </button>
      </div>
    </div>
  );
}

const stepBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '1px solid rgba(35,33,28,.18)',
  background: 'var(--panel)',
  cursor: 'pointer',
  color: 'var(--ink)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

/** Engineer/PMC affordance: record a material delivery on the open daily log,
 *  optionally linked to a locked decision so the PMC can confirm the match. */
function AddMaterialModal({ onClose }: { onClose: () => void }) {
  const addSiteMaterial = useStore((s) => s.addSiteMaterial);
  const decisions = useStore(useShallow((s) => s.decisions));
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [zone, setZone] = useState('');
  const [decisionId, setDecisionId] = useState('');
  const [swatch, setSwatch] = useState<SwatchKey>('tile');

  const ready = Boolean(name.trim() && qty.trim());
  const save = () => {
    if (!ready) return;
    addSiteMaterial({ name: name.trim(), qty: qty.trim(), zone: zone.trim(), decisionId: decisionId || undefined, swatch });
    onClose();
  };
  const swatchKeys = Object.keys(SW) as SwatchKey[];

  return (
    <Modal onClose={onClose} maxWidth={440} labelledBy="add-mat-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="add-mat-title" style={{ fontWeight: 700, fontSize: 17 }}>Record material delivery</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          Link it to a locked decision so the PMC can confirm the delivery matches what the client approved.
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Material (e.g. Italian Marble slabs)" style={{ ...fldM, marginTop: 14, width: '100%' }} data-testid="mat-name" />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty (e.g. 40 sqm)" style={{ ...fldM, flex: 1, minWidth: 0 }} data-testid="mat-qty" />
          <input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Zone" style={{ ...fldM, flex: 1, minWidth: 0 }} data-testid="mat-zone" />
        </div>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)', margin: '16px 0 6px' }}>LINK TO DECISION (optional)</div>
        <select value={decisionId} onChange={(e) => setDecisionId(e.target.value)} style={{ ...fldM, width: '100%' }} data-testid="mat-decision" aria-label="Link to decision">
          <option value="">— No linked decision —</option>
          {decisions.map((d) => (
            <option key={d.id} value={d.id}>{d.id} · {d.title}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
          <Swatch swatch={swatch} size={40} radius={9} />
          <select value={swatch} onChange={(e) => setSwatch(e.target.value as SwatchKey)} style={{ ...fldM, flex: 1, minWidth: 0 }} aria-label="Material swatch">
            {swatchKeys.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: 1, padding: 12 }}>Cancel</Button>
          <Button variant="ink" onClick={save} disabled={!ready} data-testid="save-material" style={{ flex: 1, padding: 12 }}>Record delivery</Button>
        </div>
      </div>
    </Modal>
  );
}

const fldM: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
