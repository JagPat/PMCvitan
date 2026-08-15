import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog focus discipline (Wave 0 / F-1a): focus moves into the dialog on
 *  open, Tab cycles inside while open, and focus returns to the opener on
 *  close. Esc stays the dialog's own binding — every dialog already closes on
 *  Escape. Wrap-only interception: mid-list Tab keeps native order; only the
 *  boundary keydown is prevented and redirected, so the trap never fights the
 *  browser's own focus sequencing. When the OPENER itself is gone at close
 *  (the dialog's action removed it — approve dismisses the pending card), the
 *  fallback is the first focusable inside the nearest still-connected
 *  ancestor of where the opener lived, so keyboard flow resumes beside the
 *  vanished control instead of restarting at the shell. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The opener's ancestor chain, captured NOW — if the opener is removed
    // while the dialog is open, the closest surviving ancestor anchors the
    // focus fallback.
    const openerChain: HTMLElement[] = [];
    for (let node = opener?.parentElement ?? null; node; node = node.parentElement) {
      openerChain.push(node);
    }
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));

    (focusables()[0] ?? container).focus();

    // DOCUMENT-level, not container-level: when the dialog's own dynamic
    // content removes the focused element (an option row deleted while the
    // modal stays open), focus falls to body and the next Tab never bubbles
    // through the container — only a document listener can recapture it.
    // With stacked overlays the LAST-mounted trap's listener runs last and
    // its focus() wins, which matches the topmost surface.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      } else if (!(current instanceof HTMLElement) || !container.contains(current)) {
        // Focus escaped or was stranded on body — bring it back to the top.
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      // Walk the WHOLE captured chain, not just the nearest survivor: the
      // nearest connected ancestor may be an emptied container (the last
      // pending card approved away), and stopping there strands focus on
      // body. Each successive ancestor widens the search until something
      // focusable exists.
      for (const node of openerChain) {
        if (!node.isConnected) continue;
        const target = node.querySelector<HTMLElement>(FOCUSABLE);
        if (target) {
          target.focus();
          return;
        }
      }
    };
  }, [ref, active]);
}
