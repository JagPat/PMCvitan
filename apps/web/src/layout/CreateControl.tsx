import { useState, useEffect } from 'react';
import { useStore } from '@/store/store';
import { CreateMenu } from '@/components';
import { captureGlobal } from '@/lib/captureContext';
import type { CreateKind } from '@/lib/createOptions';
import { IssueChecklistModal } from '@/screens/modals/IssueChecklistModal';
import { AddMaterialModal } from '@/screens/modals/AddMaterialModal';
import { AddProgressPhotoModal } from '@/screens/modals/AddProgressPhotoModal';
import { IssueDecisionModal } from '@/screens/modals/IssueDecisionModal';
import { Plus } from '@/lib/icons';
import { useCanCreateNow } from './useCanCreateNow';
import styles from './CreateControl.module.css';

/**
 * The universal create control (Unit C1) — the mobile trigger and the WHOLE create flow.
 *
 * Mounted once in `AppShell`, beside the other shell surfaces. Its desktop twin is the trigger
 * in `LeftRail`; both open the same `createOpen` flag, so there is one flow and one state
 * rather than a copy per shell.
 *
 * Its context is `captureGlobal`: a `+` pressed from nowhere in particular inherits nothing, and
 * the form asks. That is the honest answer — the alternative is inventing a location the user
 * never chose. `PlacesScreen`'s own mount keeps `captureAtPlace`, because there the screen DOES
 * imply one.
 *
 * ## Why this component owns the gate as well as the trigger
 *
 * Every shell mount renders OUTSIDE `ProjectLoadBoundary` — `AppShell` wraps only
 * `<ScreenView />` — so nothing unmounts this during a project transition. `switchProject`
 * empties every project-owned field BEFORE its auth request goes out, while `activeProjectId`
 * and the gateway keep addressing the OLD project until `applyAuthResult` lands; a failed switch
 * deliberately keeps that old identity too.
 *
 * Gating the TRIGGER alone would not close that window. A user can open the menu — or a create
 * modal — while the project is ready, then press Back or Forward to another project's URL, which
 * `RouteBridge` turns into a `switchProject`. No create modal reads `projectLoadState`, so the
 * form would still be standing, and submitting it would file the record against the project being
 * left. So the gate wraps the FLOW, not the button:
 *
 *  • the render gate below drops the menu and any open modal in the SAME render as the state
 *    change, so there is nothing left to submit;
 *  • the effect clears the flow's own state, so it does not spring back when the new project
 *    becomes ready — the user would otherwise land in a form they opened against a different
 *    project.
 */
export function CreateControl() {
  const canCreate = useCanCreateNow();
  const open = useStore((s) => s.createOpen);
  const openCreate = useStore((s) => s.openCreate);
  const closeCreate = useStore((s) => s.closeCreate);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [kind, setKind] = useState<CreateKind | null>(null);

  // The flow must not survive the project leaving `ready`. The render gate below already stops
  // it being submittable; this stops it reappearing afterwards.
  useEffect(() => {
    if (!canCreate) {
      setKind(null);
      closeCreate();
    }
  }, [canCreate, closeCreate]);

  if (!canCreate) return null;

  return (
    <>
      <button
        className={styles.fab}
        onClick={openCreate}
        data-testid="create-fab"
        aria-label="Add"
      >
        <Plus size={22} />
      </button>

      {open && (
        <CreateMenu
          title="Add"
          subtitle="Recorded against this project"
          onPick={(k) => { closeCreate(); setKind(k); }}
          onClose={closeCreate}
        />
      )}

      {kind === 'photo' && (
        <AddProgressPhotoModal context={captureGlobal(activeProjectId)} onClose={() => setKind(null)} />
      )}
      {kind === 'inspection' && (
        <IssueChecklistModal context={captureGlobal(activeProjectId)} onClose={() => setKind(null)} />
      )}
      {kind === 'material' && (
        <AddMaterialModal context={captureGlobal(activeProjectId)} onClose={() => setKind(null)} />
      )}
      {kind === 'decision' && (
        <IssueDecisionModal context={captureGlobal(activeProjectId)} onClose={() => setKind(null)} />
      )}
    </>
  );
}

/** The desktop trigger, rendered by `LeftRail`. Same flag, same gate — only the shell differs. */
export function CreateRailButton() {
  const canCreate = useCanCreateNow();
  const openCreate = useStore((s) => s.openCreate);
  if (!canCreate) return null;
  return (
    <button className={styles.railButton} onClick={openCreate} data-testid="create-rail">
      <Plus size={15} /> Add
    </button>
  );
}
