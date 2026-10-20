import { useStore } from '@/store/store';
import { unkeptCount } from '@/store/queueUnkept';
import { ConfirmDialog } from '@/components';
import { QW } from '@/lib/queueWords';

/** WEB-02 (#792): a project switch or sign-out the person asked for, held while acts this phone did not keep would be
 *  lost by it. Cancel stays; Continue goes on and the acts are lost. */
export function LeaveUnkept() {
  const held = useStore((s) => s.leaveConfirm);
  const n = useStore((s) => unkeptCount(s));
  const confirmLeave = useStore((s) => s.confirmLeave);
  const cancelLeave = useStore((s) => s.cancelLeave);
  const lang = useStore((s) => s.lang);
  if (!held) return null;
  return (
    <ConfirmDialog
      title={QW.leaveTitle[lang].replace('{n}', String(n))}
      confirmLabel={QW.leaveContinue[lang]}
      onConfirm={confirmLeave}
      onCancel={cancelLeave}
      testId="leave-unkept"
      lang={lang}
    />
  );
}
