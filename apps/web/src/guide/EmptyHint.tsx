import { can, type PolicyAction } from '@vitan/shared';
import { useStore } from '@/store/store';
import { EMPTY_HINTS, type EmptyHintTask } from './words';

/** the permission behind each task's button: the line shows only where that button does */
const ACTION: Record<EmptyHintTask, PolicyAction> = {
  checklist: 'inspection.create',
  decision: 'decision.create',
  photo: 'media.upload',
};

/**
 * #482 — one line on an empty screen pointing at the button that starts the work, in the person's
 * language. Nothing for a role that has no such button (the policy decides, as it does for the button).
 */
export function EmptyHint({ task }: { task: EmptyHintTask }) {
  const lang = useStore((s) => s.lang);
  const role = useStore((s) => s.role);
  if (!can(ACTION[task], role)) return null;
  return (
    <div data-testid="empty-hint" data-hint={task} style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>
      {EMPTY_HINTS[task][lang]}
    </div>
  );
}
