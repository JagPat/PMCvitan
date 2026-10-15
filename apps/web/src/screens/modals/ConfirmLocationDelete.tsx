import { locationDeleteText, placeStructureLabels, placeStructureText } from '@vitan/shared';
import { useStore } from '@/store/store';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { describeLocationDelete, locationDeleteBlocked, locationDeleteSettled, visibleDecisionsUnder} from '@/lib/locationDelete';

/** Audit B4 — "Delete Ground Floor?", stating what the server does when a location goes, from the
 *  Site Map or the Locations editor alike. A decision the viewer can see below it offers only Close;
 *  so does a decisions slice that has not loaded (#699 review: the rule, never an unvouched count). */
export function ConfirmLocationDelete({ nodeId, onClose, onDeleted }: { nodeId: string; onClose: () => void; onDeleted?: () => void }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const visibleDecisions = useStore((s) => visibleDecisionsUnder(s.nodes, nodeId, s.decisions));
  const settled = useStore((s) => locationDeleteSettled(s));
  const deleteNode = useStore((s) => s.deleteNode);
  const lang = useStore((s) => s.lang);
  if (!node) return null;
  return (
    <ConfirmDialog
      title={placeStructureText.deleteTitle(node.name, lang)}
      confirmLabel={placeStructureLabels.delete[lang]}
      blocked={settled ? (locationDeleteBlocked(visibleDecisions, lang) ?? undefined) : locationDeleteText.unsettled[lang]}
      onConfirm={() => { deleteNode(nodeId); onDeleted?.(); }}
      onCancel={onClose}
      testId="confirm-location-delete"
      lang={lang}
    >
      {settled ? describeLocationDelete(node.kind, lang) : null}
    </ConfirmDialog>
  );
}
