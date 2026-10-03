import { useMemo } from 'react';
import { useStore } from '@/store/store';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { describeLocationDelete, locationDeleteBlocked, locationDeleteImpact } from '@/lib/locationDelete';

/** Audit B4 — "Delete Ground Floor?", naming what goes with it and what is unfiled, from the
 *  Site Map or the Locations editor alike. A location with decisions on it offers only Close. */
export function ConfirmLocationDelete({ nodeId, onClose, onDeleted }: { nodeId: string; onClose: () => void; onDeleted?: () => void }) {
  const nodes = useStore((s) => s.nodes);
  const decisions = useStore((s) => s.decisions);
  const activities = useStore((s) => s.activities);
  const drawings = useStore((s) => s.drawings);
  const inspections = useStore((s) => s.placedInspections);
  const materials = useStore((s) => s.materials);
  const photos = useStore((s) => s.photos);
  const deleteNode = useStore((s) => s.deleteNode);
  const impact = useMemo(
    () => locationDeleteImpact(nodes, nodeId, { decisions, activities, drawings, inspections, materials, photos }),
    [nodes, nodeId, decisions, activities, drawings, inspections, materials, photos],
  );
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  return (
    <ConfirmDialog
      title={`Delete ${node.name}?`}
      confirmLabel="Delete"
      blocked={locationDeleteBlocked(impact) ?? undefined}
      onConfirm={() => { deleteNode(nodeId); onDeleted?.(); }}
      onCancel={onClose}
      testId="confirm-location-delete"
    >
      {describeLocationDelete(impact)}
    </ConfirmDialog>
  );
}
