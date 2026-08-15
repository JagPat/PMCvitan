import type { RefObject } from 'react';

/** Dialog focus discipline (Wave 0 / F-1a): focus moves into the dialog on
 *  open, Tab cycles inside while open, and focus returns to the opener on
 *  close. Esc stays the dialog's own binding — every dialog already closes on
 *  Escape. Shape commit: the behavior lands with the F-1a implementation. */
export function useFocusTrap(_ref: RefObject<HTMLElement | null>, _active = true): void {}
