import { useEffect, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type IssueDecisionPayload } from '@/store/store';
import { Button, Modal, InheritedContext, MoreDetails } from '@/components';
import { X } from '@/lib/icons';
import { swatch as swatchGradient, SW, type SwatchKey } from '@vitan/shared';
import { inheritsLocation, type CaptureContext } from '@/lib/captureContext';

/**
 * PMC issues a new decision: a place, a title, and 2–4 options for the client to choose.
 *
 * The two options are NOT UI padding and are not folded away: the server contract is
 * `options.min(2).max(4)`, and a decision with one option is not a decision. Only a
 * mandatory domain rule may block a save, and this is one — hiding it would offer a
 * Publish button the API would refuse.
 *
 * Everything else an option carries — the price delta, the swatch, the sample photo, the
 * recommendation — is optional and blocks nothing, so each option opens as the one field
 * that DOES block: its material. The rest folds, per option rather than form-wide, so
 * opening one option's details does not unfold the others.
 */
export function IssueDecisionModal({ context, onClose }: { context?: CaptureContext; onClose: () => void }) {
  const issueDecision = useStore((s) => s.issueDecision);
  const inherited = inheritsLocation(context);
  const [title, setTitle] = useState('');
  const [nodeId, setNodeId] = useState<string | null>(context?.nodeId ?? null);
  // lazy, so the two starting options are built once rather than on every render
  const [options, setOptions] = useState<OptionDraft[]>(() => [blankOption(), blankOption()]);
  // Phase 6 task 4b (§A.1/§A.2) — WHO decides: the client (default, byte-identical legacy
  // behaviour), the practice itself (pmc), a NAMED project member, or nobody (`none` — a
  // record-only issue with exactly zero options, born terminal `recorded`).
  const [deciderKind, setDeciderKind] = useState<'client' | 'pmc' | 'member' | 'none'>('client');
  const [deciderMembershipId, setDeciderMembershipId] = useState('');
  const members = useStore(useShallow((s) => s.members));
  const loadTeam = useStore((s) => s.loadTeam);
  useEffect(() => {
    // candidates for the named-member picker (the roster read the Team screen already uses)
    if (!members.length) void loadTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const memberCandidates = members.filter((m) => m.status === 'active' && m.membershipId);
  const record = deciderKind === 'none';

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

  // A RECORD (`none`) carries exactly ZERO options (an optioned record is a category error);
  // every deciding kind keeps the 2–4 option contract. A named member decider needs its member.
  const ready = Boolean(
    title.trim() &&
      nodeId &&
      (record || options.every((o) => o.material.trim())) &&
      (deciderKind !== 'member' || deciderMembershipId),
  );
  const save = (publish: boolean) => {
    if (!ready) return;
    const payload: IssueDecisionPayload = {
      title: title.trim(),
      nodeId: nodeId ?? undefined,
      publish,
      options: record
        ? []
        : options.map((o) => ({
            material: o.material.trim(),
            delta: parseInt(o.delta.replace(/[^\d-]/g, ''), 10) || 0,
            swatch: o.swatch,
            recommended: o.recommended,
            ...(o.photo ? { photo: { mime: o.photo.mime, data: o.photo.data } } : {}),
          })),
      ...(deciderKind !== 'client' ? { deciderKind } : {}),
      ...(deciderKind === 'member' ? { deciderMembershipId } : {}),
    };
    issueDecision(payload);
    onClose();
  };

  return (
    <Modal onClose={onClose} maxWidth={560} labelledBy="issue-dec-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="issue-dec-title" style={{ fontWeight: 700, fontSize: 17 }}>New decision</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          What is being decided, and between which options. A price delta, a swatch and a sample
          photo sit under each option's <b>More details</b>. <b>Save as draft</b> to keep working
          privately, or <b>Publish</b> to send it to the client to choose.
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Veneer finish, Lock & hardware)" style={{ ...fldD, marginTop: 14, width: '100%' }} data-testid="dec-title" />

        <div style={{ marginTop: 12 }}>
          <InheritedContext value={nodeId} onChange={setNodeId} inherited={inherited} idPrefix="dec-loc" testId="dec-place" />
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)' }}>WHO DECIDES</span>
          <select value={deciderKind} onChange={(e) => setDeciderKind(e.target.value as typeof deciderKind)} style={{ ...fldD, flex: '0 0 180px' }} aria-label="Who decides" data-testid="dec-decider-kind">
            <option value="client">The client</option>
            <option value="pmc">The practice (PMC)</option>
            <option value="member">A named member</option>
            <option value="none">Nobody — record only</option>
          </select>
          {deciderKind === 'member' && (
            <select value={deciderMembershipId} onChange={(e) => setDeciderMembershipId(e.target.value)} style={{ ...fldD, flex: '1 1 160px' }} aria-label="Named decider" data-testid="dec-decider-member">
              <option value="">Choose a member…</option>
              {memberCandidates.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>{m.name} · {m.role}</option>
              ))}
            </select>
          )}
        </div>
        {record && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)' }} data-testid="dec-record-note">
            A record files the issue for the team — no options, and nobody is asked to approve it.
          </div>
        )}

        {!record && options.map((o, i) => (
          // keyed by the option's OWN id, never its slot: `MoreDetails` holds its open
          // state locally, so an index key would hand a removed option's disclosure to
          // whichever option slid into the slot — collapsing the one the user opened and
          // opening its neighbour under the label of the one they were editing.
          <div key={o.id} style={{ marginTop: 14, padding: 12, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--panel)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.1em', color: 'var(--muted)' }}>OPTION {String.fromCharCode(65 + i)}</span>
              {options.length > 2 && (
                <button onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}>
                  <X size={15} />
                </button>
              )}
            </div>
            <input value={o.material} onChange={(e) => setOpt(i, { material: e.target.value })} placeholder="Material (e.g. Italian Marble)" style={{ ...fldD, width: '100%' }} data-testid={`dec-opt-${i}`} />

            <MoreDetails testId={`dec-opt-${i}-more`}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input value={o.delta} onChange={(e) => setOpt(i, { delta: e.target.value })} placeholder="₹ delta (0 = base)" style={{ ...fldD, flex: '0 0 130px' }} />
                <select value={o.swatch} onChange={(e) => setOpt(i, { swatch: e.target.value as SwatchKey })} style={{ ...fldD, flex: '0 0 120px' }} aria-label="Swatch">
                  {SWATCH_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <span style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--hairline)', background: o.photo ? `center/cover url(${o.photo.preview})` : swatchGradient(o.swatch) }} />
                <label style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>
                  {o.photo ? 'Change photo' : 'Add sample photo'}
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pickPhoto(i, e.target.files?.[0] ?? null)} />
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                  <input type="radio" name="recommended" checked={o.recommended} onChange={() => setOpt(i, { recommended: true })} /> Recommended
                </label>
              </div>
            </MoreDetails>
          </div>
        ))}

        {!record && options.length < 4 && (
          <button onClick={() => setOptions((prev) => [...prev, blankOption()])} style={{ marginTop: 12, background: 'transparent', border: '1px dashed rgba(35,33,28,.3)', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, cursor: 'pointer', color: 'var(--muted)', width: '100%' }}>
            + Add another option
          </button>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <Button variant="outline" onClick={onClose} style={{ flex: '0 0 auto', padding: '12px 16px' }}>Cancel</Button>
          <Button variant="light" onClick={() => save(false)} disabled={!ready} data-testid="save-draft" style={{ flex: 1, padding: 12 }}>Save as draft</Button>
          <Button variant="ink" onClick={() => save(true)} disabled={!ready} data-testid="save-decision" style={{ flex: 1, padding: 12 }}>{record ? 'Publish record' : deciderKind === 'client' ? 'Publish to client' : 'Publish to decider'}</Button>
        </div>
      </div>
    </Modal>
  );
}

interface OptionDraft {
  /** Stable across reordering and removal — see the `key` on the option row. */
  id: string;
  material: string;
  delta: string; // rupee delta as typed
  swatch: SwatchKey;
  recommended: boolean;
  photo?: { mime: string; data: string; preview: string };
}

const SWATCH_KEYS = Object.keys(SW) as SwatchKey[];
// A counter rather than a random id: unique within a form is all `key` needs, and a
// deterministic sequence keeps the probes readable.
let optionSeq = 0;
const blankOption = (): OptionDraft => ({ id: `opt-${(optionSeq += 1)}`, material: '', delta: '0', swatch: 'tile', recommended: false });

const fldD: CSSProperties = { height: 42, padding: '0 12px', borderRadius: 10, border: '1px solid rgba(35,33,28,.18)', background: '#fff', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--ink)', outline: 'none' };
