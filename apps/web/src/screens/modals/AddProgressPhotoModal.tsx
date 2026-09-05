import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { can } from '@vitan/shared';
import { Button, InheritedContext, Modal } from '@/components';
import { useStore } from '@/store/store';
import { isCurrentProjectScope, projectDataUsable, projectScopeOf } from '@/store/projectScope';
import { inheritsLocation, type CaptureContext } from '@/lib/captureContext';
import { captureStamp } from '@/lib/captureStamp';
import { Camera } from '@/lib/icons';

/** Progress is project media; starting or submitting a daily log is not a prerequisite. */
export function AddProgressPhotoModal({ context, onClose }: { context: CaptureContext; onClose: () => void }) {
  const role = useStore((s) => s.role);
  const projectId = useStore((s) => s.activeProjectId);
  const generation = useStore((s) => s.projectScopeGeneration);
  const loadState = useStore((s) => s.projectLoadState);
  // Pin before even opening the native picker: a project switch can happen while it is open.
  const [openedIn] = useState(() => projectScopeOf(useStore.getState()));
  const [nodeId, setNodeId] = useState(context.nodeId);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const allowed = can('media.upload', role) && projectDataUsable(loadState)
    && context.projectId === projectId && isCurrentProjectScope(projectId, generation, openedIn);

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || reading || !allowed) return;
    setReading(true);
    setError(null);
    const reader = new FileReader();
    const failed = () => {
      if (!active.current) return;
      setReading(false);
      setError('Could not read that photo. Please choose it again.');
    };
    reader.onerror = failed;
    reader.onabort = failed;
    reader.onload = () => {
      if (!active.current) return;
      if (typeof reader.result !== 'string') { failed(); return; }
      const state = useStore.getState();
      if (!can('media.upload', state.role) || !projectDataUsable(state.projectLoadState)
        || !isCurrentProjectScope(state.activeProjectId, state.projectScopeGeneration, openedIn)) return;
      // Preserve the Daily Log's one-read capture path and its scope guard. The existing store
      // reports upload success/failure or an offline queue; dispatch alone is never called saved.
      state.addProgressPhoto(reader.result, nodeId, captureStamp(reader.result), openedIn);
      onClose();
    };
    reader.readAsDataURL(file);
  };

  if (!allowed) return null;

  return (
    <Modal onClose={onClose} maxWidth={440} labelledBy="quick-photo-title">
      <div style={{ padding: '18px 20px', maxHeight: '80vh', overflowY: 'auto' }}>
        <div id="quick-photo-title" style={{ fontWeight: 700, fontSize: 17 }}>Add progress photo</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 16px' }}>
          Show what happened on site. No daily log needed.
        </p>
        <fieldset disabled={reading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <InheritedContext value={nodeId} onChange={setNodeId} inherited={inheritsLocation(context)} idPrefix="quick-photo-loc" testId="quick-photo-place" />
        </fieldset>
        {!nodeId && <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>Location is optional. Leave it blank for a project-wide photo.</p>}
        <input ref={camera} type="file" accept="image/*" capture="environment" onChange={pick} data-testid="quick-photo-camera" style={{ display: 'none' }} />
        <input ref={library} type="file" accept="image/*" onChange={pick} data-testid="quick-photo-library" style={{ display: 'none' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
          <Button variant="ink" disabled={reading} onClick={() => camera.current?.click()} style={{ minHeight: 48 }}>
            <Camera size={16} /> Take photo
          </Button>
          <Button variant="outline" disabled={reading} onClick={() => library.current?.click()} style={{ minHeight: 48 }}>Choose photo</Button>
          {reading && <div role="status" style={{ fontSize: 13, color: 'var(--muted)' }}>Reading photo…</div>}
          {error && <div role="alert" style={{ fontSize: 13, color: 'var(--red-solid)' }}>{error}</div>}
          <Button variant="outline" onClick={onClose} style={{ minHeight: 44 }}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
