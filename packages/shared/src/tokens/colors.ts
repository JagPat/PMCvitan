/**
 * Design tokens — colours.
 *
 * TS constants are the authoritative source for anything referenced from JS
 * (status chips, gate dots, timeline bar colours). The same values are mirrored
 * as CSS custom properties in apps/web/src/styles/tokens.css for static styling.
 */

export const color = {
  canvas: '#E9E4D8', // paper / app background
  panel: '#F4F1EA', // card surface
  paper: '#FFFFFF', // elevated card
  ink: '#23211C', // text, sidebar background
  sidebarText: '#EDE7DA',
  muted: '#6B665C',
  faint: '#8A857A', // mono meta text
  hairline: 'rgba(35,33,28,0.12)',
  hairlineStrong: 'rgba(35,33,28,0.16)',
  grid: 'rgba(35,33,28,0.035)', // 26px drawing grid
  accent: '#B4462E', // terracotta — primary actions / status
} as const;

/** Four status families (amber / green / red / ink-blue). */
export const status = {
  amber: { solid: '#C08A2D', text: '#8A6216', chip: '#F6ECD6', border: '#E4CE9C' },
  green: { solid: '#3F7A54', text: '#2F6B44', chip: '#E1EEE4', border: '#C3DDCB' },
  red: { solid: '#B23A34', text: '#B23A34', chip: '#F7E1DF', border: '#E7C4C0' },
  blue: { solid: '#31567F', text: '#31567F', chip: '#E6ECF3', border: '#C4D3E4' },
} as const;

/** Decision lifecycle -> chip colours + rail colour + label. */
export const decisionChip = {
  pending: { bg: '#F6ECD6', color: '#8A6216', border: '#E4CE9C' },
  approved: { bg: '#E1EEE4', color: '#2F6B44', border: '#C3DDCB' },
  change: { bg: '#E6ECF3', color: '#31567F', border: '#C4D3E4' },
} as const;

export const decisionChipLabel = {
  pending: 'PENDING',
  approved: 'APPROVED & LOCKED',
  change: 'CHANGE REQUESTED',
} as const;

export const decisionRail = {
  pending: '#C08A2D',
  approved: '#3F7A54',
  change: '#31567F',
} as const;

/** Readiness-gate colours. `na` renders as a hollow inset ring (transparent fill). */
export const gateColor = {
  ok: '#3F7A54',
  wait: '#C08A2D',
  fail: '#B23A34',
  na: 'rgba(35,33,28,0.2)',
} as const;

/** Activity status -> schedule chip colours + label. */
export const activityChip = {
  done: { bg: '#E1EEE4', color: '#2F6B44', border: '#C3DDCB' },
  'in-progress': { bg: '#EFE7D6', color: '#8A6216', border: '#E0CFA6' },
  // a completion CLAIM awaiting the PMC's closing sign-off (Phase 1 Task 5) —
  // ink-blue, like a reopened decision: something is with the reviewer
  'awaiting-signoff': { bg: '#E6ECF3', color: '#31567F', border: '#C4D3E4' },
  'not-started': { bg: '#EAE5DA', color: '#6B665C', border: 'rgba(35,33,28,0.15)' },
  blocked: { bg: '#F7E1DF', color: '#B23A34', border: '#E7C4C0' },
} as const;

export const activityLabel = {
  done: 'DONE',
  'in-progress': 'IN PROGRESS',
  'awaiting-signoff': 'AWAITING SIGN-OFF',
  'not-started': 'NOT STARTED',
  blocked: 'BLOCKED',
} as const;

/** Inspection result -> chip colours. */
export const resultChip = {
  PASS: { bg: '#E1EEE4', color: '#2F6B44' },
  FAIL: { bg: '#F7E1DF', color: '#B23A34' },
} as const;

export const shadow = {
  subtle: '0 1px 3px rgba(35,33,28,.06)',
  card: '0 2px 10px -6px rgba(35,33,28,.30)',
  modal: '0 30px 70px -15px rgba(0,0,0,.5)',
} as const;
