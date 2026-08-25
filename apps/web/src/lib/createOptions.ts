import { can, type PolicyAction, type TokenRole } from '@vitan/shared';
import { ClipboardCheck, Package, ClipboardList, type LucideIcon } from 'lucide-react';

/** What a user can start creating, named the way a person would say it. */
export type CreateKind = 'inspection' | 'material' | 'decision';

export interface CreateOption {
  kind: CreateKind;
  /** what the user is DOING, never which module owns the result */
  label: string;
  detail: string;
  action: PolicyAction;
  icon: LucideIcon;
}

/**
 * The Add menu's options.
 *
 * Worded as things that happen on a building site, because a user should not have to know
 * which backend module owns a record before they can enter one. "Check something here" is
 * the question they are answering; that it becomes an inspection the PMC reviews is the
 * system's business, not theirs.
 *
 * Each option names the permission that already governs it, so the menu can never offer an
 * action the server would refuse — the existing policy stays the single authority.
 */
const OPTIONS: readonly CreateOption[] = [
  { kind: 'inspection', label: 'Check something here', detail: 'Issue a checklist for the site engineer to fill in', action: 'inspection.create', icon: ClipboardCheck },
  { kind: 'material', label: 'Material delivered here', detail: 'Record what arrived and how much', action: 'dailyLog.addMaterial', icon: Package },
  { kind: 'decision', label: 'Something to decide here', detail: 'Put options to the client to choose between', action: 'decision.create', icon: ClipboardList },
];

/** The options this role may actually author — the existing policy decides, nothing else. */
export function createOptionsFor(role: TokenRole): readonly CreateOption[] {
  return OPTIONS.filter((o) => can(o.action, role));
}
