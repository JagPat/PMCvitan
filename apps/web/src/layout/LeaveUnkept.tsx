import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { unkeptCount } from '@/store/queueUnkept';
import { ConfirmDialog } from '@/components';
import { QW } from '@/lib/queueWords';

/** WEB-02 (#792): a project switch, persona switch or sign-out the person asked for, held while acts this phone did not keep would be
 *  lost by it. Cancel stays; Continue goes on and the acts are lost. A reload or closing the tab is asked by the browser. */
export function LeaveUnkept() {
  const held = useStore((s) => s.leaveConfirm);
  const n = useStore((s) => unkeptCount(s));
  const confirmLeave = useStore((s) => s.confirmLeave);
  const cancelLeave = useStore((s) => s.cancelLeave);
  const lang = useStore((s) => s.lang);
  // a reload or a closed tab is a leave too: the browser asks first, in its own words, while acts are not kept (#1028
  // r2 audit: every leave path asks)
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => {
      if (unkeptCount(useStore.getState()) === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, []);
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
