import { useEffect, type CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { unkeptCount } from '@/store/queueUnkept';
import { ConfirmDialog } from '@/components';
import { QW } from '@/lib/queueWords';

/** WEB-02 (#792): a project switch, persona switch, sign-in, sign-out, archive of the open project, or the unreadable
 *  strip's Reload (#1037 r1 re-check N1) the person asked for, held while acts this phone did not keep would be lost
 *  by it. Cancel stays; Continue goes on and the acts are
 *  lost. A reload or closing the tab is asked by the browser where it asks (`UnkeptStay` says it on screen too). */
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
      // a reload the person already agreed to in the app is not asked again, while what is not kept is only what they
      // agreed to lose (#1037 r1 re-check 2 and 3, G1)
      const st = useStore.getState();
      const agreed = st.reloadAgreed;
      // the agreement covers one reload: the first leave after it uses it up, so a reload that did not happen (the page
      // stayed) leaves the next leave asked (#1037 r2, Codex 4335234372)
      if (agreed !== null) useStore.setState({ reloadAgreed: null });
      if (unkeptCount(st) === 0 || (agreed !== null && st.queueUnkept.every((id) => agreed.includes(id)))) return;
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

/** WEB-02 (#792): while any act is not kept, the screen says so and asks the person to keep the page open, since a
 *  browser may close or reload it without asking (#1028 r2 check G6). It goes once each act is sent or stored. */
export function UnkeptStay() {
  const n = useStore((s) => unkeptCount(s));
  const lang = useStore((s) => s.lang);
  if (n === 0) return null;
  return (
    <div role="status" style={strip} data-testid="unkept-stay">
      {n === 1 ? QW.unkeptStayOne[lang] : QW.unkeptStay[lang].replace('{n}', String(n))}
    </div>
  );
}

const strip: CSSProperties = {
  marginBottom: 8,
  padding: '8px 10px',
  border: '1px solid var(--hairline-strong)',
  borderRadius: 8,
  background: 'var(--paper)',
  color: 'var(--ink)',
  fontSize: 13,
};
