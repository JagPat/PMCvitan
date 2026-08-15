import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type OpenerAnchor = {
  ancestor: HTMLElement;
  /** The child of `ancestor` the opener lived under (the opener itself at depth 0). */
  branch: Element | null;
  /** `branch`'s siblings at dialog-open time, nearest first. */
  following: Element[];
  preceding: Element[];
};

/** Dialog focus discipline (Wave 0 / F-1a): focus moves into the dialog on
 *  open, Tab cycles inside while open, and focus returns to the opener on
 *  close. Esc stays the dialog's own binding — every dialog already closes on
 *  Escape. Wrap-only interception: mid-list Tab keeps native order; only the
 *  boundary keydown is prevented and redirected, so the trap never fights the
 *  browser's own focus sequencing. When the OPENER itself is gone at close
 *  (the dialog's action removed it — approve dismisses the pending card), the
 *  fallback preserves RELATIVE POSITION: at each still-connected ancestor of
 *  where the opener lived, the nearest FOLLOWING sibling with a focusable
 *  wins, then the opener's own branch, then a PRECEDING sibling only as a
 *  last resort — so keyboard flow continues to the next item instead of
 *  jumping backward across surviving content, and an emptied ancestor yields
 *  to the next one out instead of stranding focus on body. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Per-ancestor POSITION anchors, captured NOW — sibling lists are frozen
    // at open time because a removed node loses its live sibling links, so
    // they cannot be walked after the fact.
    const anchors: OpenerAnchor[] = [];
    {
      let branch: Element | null = opener;
      for (let node = opener?.parentElement ?? null; node; node = node.parentElement) {
        const following: Element[] = [];
        for (let sib = branch?.nextElementSibling ?? null; sib; sib = sib.nextElementSibling) {
          following.push(sib);
        }
        const preceding: Element[] = [];
        for (let sib = branch?.previousElementSibling ?? null; sib; sib = sib.previousElementSibling) {
          preceding.push(sib);
        }
        anchors.push({ ancestor: node, branch, following, preceding });
        branch = node;
      }
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

    // Focus the root itself if it is focusable, else its first focusable
    // descendant. Returns whether focus was placed.
    const focusIn = (root: Element): boolean => {
      const target =
        root instanceof HTMLElement && root.matches(FOCUSABLE)
          ? root
          : root.querySelector<HTMLElement>(FOCUSABLE);
      if (!target) return false;
      target.focus();
      return true;
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      // Walk the captured chain outward until focus is successfully placed.
      // At each connected ancestor, relative position decides: following
      // siblings (nearest first), then the branch's own survivors, then
      // preceding siblings, then anything the ancestor gained since open.
      for (const { ancestor, branch, following, preceding } of anchors) {
        if (!ancestor.isConnected) continue;
        for (const sib of following) {
          if (sib.isConnected && focusIn(sib)) return;
        }
        if (branch?.isConnected && focusIn(branch)) return;
        for (const sib of preceding) {
          if (sib.isConnected && focusIn(sib)) return;
        }
        const gained = ancestor.querySelector<HTMLElement>(FOCUSABLE);
        if (gained) {
          gained.focus();
          return;
        }
      }
    };
  }, [ref, active]);
}
