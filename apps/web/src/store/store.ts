/**
 * The Vitan PMC application store.
 *
 * A faithful port of the prototype's single `DCLogic` class: one shared state
 * object plus actions that mirror its methods. Cross-slice flows (approve→lock,
 * material-mismatch→block, offline queue→flush) are expressed directly, exactly
 * as the prototype does. This store is the current "local gateway"; when the API
 * lands (Phase 7) these actions move behind the `DataGateway` and TanStack Query.
 *
 * Derived values (counts, filtered lists, timeline geometry) are NOT stored here
 * — they live in ./selectors and are recomputed from this state, so the
 * interconnected flows stay consistent by construction.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  SEED_ACTIVITIES,
  SEED_CHECKLIST,
  SEED_DAILY_LOG,
  SEED_DECISIONS,
  SEED_NOTIFICATIONS,
  SEED_REVIEW,
  PROJECT,
  type AccessState,
  type AccessWho,
  type Activity,
  type AppNotification,
  type Checklist,
  type DailyLog,
  type Decision,
  type ItemState,
  type Lang,
  type ModalState,
  type Review,
  type Role,
  type ScreenKey,
  type Worker,
} from '@vitan/shared';
import { screensFor } from '@/lib/screens';

export interface AppState {
  role: Role;
  screen: ScreenKey;
  lang: Lang;
  notifOpen: boolean;
  toast: string | null;
  modal: ModalState;
  decisions: Decision[];
  checklist: Checklist;
  review: Review;
  reinspectionCreated: boolean;
  online: boolean;
  syncQueue: string[];
  access: AccessState;
  activities: Activity[];
  dailyLog: DailyLog;
  notifications: AppNotification[];
  // project constants
  projStart: string;
  projEnd: string;
  elapsedPct: number;
  todayDay: number;
  milestonePct: number;
}

export interface AppActions {
  // shell
  setRole: (role: Role) => void;
  setScreen: (k: ScreenKey) => void;
  setLang: (l: Lang) => void;
  toggleNotif: () => void;
  flash: (msg: string) => void;
  openQr: () => void;
  closeModal: () => void;
  // decisions
  openApprove: (decId: string, optIdx: number) => void;
  confirmApprove: () => void;
  openChange: (decId: string) => void;
  submitChange: () => void;
  setChangeText: (v: string) => void;
  setChangeCost: (v: string) => void;
  setChangeTime: (v: string) => void;
  // inspection (engineer checklist)
  setItem: (idx: number, val: Exclude<ItemState, null>) => void;
  addPhoto: (idx: number) => void;
  setNote: (idx: number, txt: string) => void;
  submitInspection: () => void;
  // inspection (pmc review)
  toggleReject: (idx: number) => void;
  approveInspection: () => void;
  sendReinspection: () => void;
  // schedule
  startActivity: (id: string) => void;
  completeActivity: (id: string) => void;
  // daily log
  checkIn: () => void;
  checkOut: () => void;
  scanWorker: () => void;
  crewStep: (idx: number, delta: number) => void;
  addProgress: () => void;
  submitDailyLog: () => void;
  flagMismatch: (idx: number) => void;
  record: (label: string) => void;
  toggleOnline: () => void;
  // team access
  accWho: (who: Exclude<AccessWho, null>) => void;
  accTrade: (t: string) => void;
  otpPress: (d: string) => void;
  otpVerify: () => void;
  pickWorker: (w: Worker) => void;
  accReset: () => void;
  speakJob: () => void;
  workerDone: () => void;
}

export type Store = AppState & AppActions;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A fresh copy of the seeded initial state (deep-cloned so resets never share references). */
export function getInitialState(): AppState {
  return {
    role: 'client',
    screen: 'client-decisions',
    lang: 'en',
    notifOpen: false,
    toast: null,
    modal: { type: null },
    decisions: structuredClone(SEED_DECISIONS),
    checklist: structuredClone(SEED_CHECKLIST),
    review: structuredClone(SEED_REVIEW),
    reinspectionCreated: false,
    online: true,
    syncQueue: [],
    access: { step: 'who', who: null, trade: null, otp: '', worker: null },
    activities: structuredClone(SEED_ACTIVITIES),
    dailyLog: structuredClone(SEED_DAILY_LOG),
    notifications: structuredClone(SEED_NOTIFICATIONS),
    projStart: PROJECT.projStart,
    projEnd: PROJECT.projEnd,
    elapsedPct: PROJECT.elapsedPct,
    todayDay: PROJECT.todayDay,
    milestonePct: PROJECT.milestonePct,
  };
}

export const useStore = create<Store>()(
  immer((set, get) => ({
    ...getInitialState(),

    // ---- shell ----
    setRole: (role) => {
      const first = screensFor(role)[0].key;
      set((s) => {
        s.role = role;
        s.screen = first;
        s.notifOpen = false;
        s.modal = { type: null };
      });
    },
    setScreen: (k) =>
      set((s) => {
        s.screen = k;
        s.notifOpen = false;
      }),
    setLang: (l) => set((s) => { s.lang = l; }),
    toggleNotif: () => set((s) => { s.notifOpen = !s.notifOpen; }),
    flash: (msg) => {
      set((s) => { s.toast = msg; });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set((s) => { s.toast = null; }), 3200);
    },
    openQr: () => set((s) => { s.modal = { type: 'qr' }; }),
    closeModal: () => set((s) => { s.modal = { type: null }; }),

    // ---- decisions ----
    openApprove: (decId, optIdx) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      const o = d.options[optIdx];
      set((s) => {
        s.modal = {
          type: 'approve',
          decId,
          optIdx,
          title: d.title,
          optionLabel: o.label,
          material: o.material,
          delta: o.delta,
          swatch: o.swatch,
        };
      });
    },
    confirmApprove: () => {
      const { decId, optIdx } = get().modal;
      if (decId == null || optIdx == null) return;
      const src = get().decisions.find((x) => x.id === decId);
      const material = src ? src.options[optIdx].material : '';
      const title = src ? src.title : '';
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) {
          const o = d.options[optIdx];
          d.status = 'approved';
          d.approvedOption = o.label;
          d.material = o.material;
          d.cost = o.delta;
          d.approver = 'Mr. Shah';
          d.date = '03 Jul 2026';
          d.photoSwatch = o.swatch;
        }
        s.notifications.unshift({ text: 'Client approved ' + title + ' — ' + material, time: 'just now', color: '#3F7A54' });
        s.modal = { type: null };
      });
      get().flash('Approved & locked — the Decision Log and PMC dashboard are updated.');
    },
    openChange: (decId) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      set((s) => {
        s.modal = { type: 'change', decId, title: d.title, changeText: '', changeCost: '', changeTime: '' };
      });
    },
    submitChange: () => {
      const { decId } = get().modal;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) d.status = 'change';
        s.modal = { type: null };
      });
      get().flash('Change Request submitted for client re-approval.');
    },
    setChangeText: (v) => set((s) => { s.modal.changeText = v; }),
    setChangeCost: (v) => set((s) => { s.modal.changeCost = v; }),
    setChangeTime: (v) => set((s) => { s.modal.changeTime = v; }),

    // ---- engineer checklist ----
    setItem: (idx, val) =>
      set((s) => {
        const it = s.checklist.items[idx];
        it.state = it.state === val ? null : val;
      }),
    addPhoto: (idx) => set((s) => { s.checklist.items[idx].photos += 1; }),
    setNote: (idx, txt) => set((s) => { s.checklist.items[idx].note = txt; }),
    submitInspection: () => {
      const c = get().checklist;
      const undone = c.items.filter((it) => !it.state).length;
      const failNoPhoto = c.items.filter((it) => it.state === 'fail' && it.photos === 0).length;
      if (undone > 0) {
        get().flash('Please mark all ' + c.items.length + ' items before submitting.');
        return;
      }
      if (failNoPhoto > 0) {
        get().flash('A failed item needs a photo before you can submit.');
        return;
      }
      set((s) => { s.checklist.submitted = true; });
      get().flash('Inspection submitted to the architect for review.');
    },

    // ---- pmc review ----
    toggleReject: (idx) => set((s) => { s.review.items[idx].rejected = !s.review.items[idx].rejected; }),
    approveInspection: () => {
      set((s) => { s.review.decided = true; });
      get().flash('Inspection approved. Contractor and client notified.');
    },
    sendReinspection: () => {
      const n = get().review.items.filter((it) => it.rejected || it.result === 'FAIL').length;
      if (n === 0) {
        get().flash('No items rejected. Use Approve Inspection instead.');
        return;
      }
      set((s) => {
        s.reinspectionCreated = true;
        s.review.decided = true;
      });
      get().flash(n + ' re-inspection task(s) created with due dates.');
    },

    // ---- schedule ----
    startActivity: (id) => {
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'in-progress';
          a.as = s.todayDay;
        }
      });
      get().flash('Activity started — planned dates now tracking against actual.');
    },
    completeActivity: (id) => {
      const act = get().activities.find((a) => a.id === id);
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'done';
          a.ae = s.todayDay;
        }
        s.notifications.unshift({ text: 'Closing inspection auto-created: ' + (act ? act.name : ''), time: 'just now', color: '#C08A2D' });
      });
      get().flash('Marked complete — a closing inspection was auto-created for sign-off.');
    },

    // ---- daily log (phone = attendance device) ----
    checkIn: () => {
      set((s) => {
        s.dailyLog.checkedIn = true;
        s.dailyLog.checkinTime = '8:12 AM';
      });
      get().record('Check-in 8:12 AM');
      get().flash(get().online ? 'Checked in at Ambli site · within 60 m · selfie + time stamped.' : 'Checked in offline — will sync when signal returns.');
    },
    checkOut: () => {
      set((s) => {
        s.dailyLog.checkedIn = false;
        s.dailyLog.checkinTime = null;
      });
      get().flash('Checked out. Shift hours logged.');
    },
    scanWorker: () => {
      set((s) => { s.dailyLog.crew[4].count += 1; });
      get().record('QR check-in · Helper');
      get().flash('Worker checked in via QR · Helper · 9:03 AM · face verified.');
    },
    crewStep: (idx, delta) =>
      set((s) => {
        const c = s.dailyLog.crew[idx];
        c.count = Math.max(0, c.count + delta);
      }),
    addProgress: () => {
      set((s) => { s.dailyLog.progress += 1; });
      get().record('Progress photo');
    },
    submitDailyLog: () => {
      if (!get().dailyLog.checkedIn) {
        get().flash('Please check in at site before submitting the daily log.');
        return;
      }
      set((s) => { s.dailyLog.submitted = true; });
      get().record('Daily log submit');
      get().flash(get().online ? 'Daily site log sent to PMC — attendance, materials & photos attached.' : 'Saved offline — log will upload to PMC when signal returns.');
    },
    flagMismatch: (idx) => {
      const mat = get().dailyLog.materials[idx];
      set((s) => {
        s.dailyLog.materials[idx].matched = false;
        s.activities.forEach((a) => {
          if (a.decisionId === mat.decisionId) {
            a.gm = 'fail';
            a.status = a.status === 'done' ? a.status : 'blocked';
            a.block = 'Material ≠ approved';
          }
        });
        s.notifications.unshift({ text: 'Material mismatch: ' + mat.name + ' ≠ approved ' + mat.decisionId, time: 'just now', color: '#B23A34' });
      });
      get().record('Material mismatch flag');
      get().flash('Mismatch flagged — PMC alerted and the linked activity is now blocked.');
    },
    record: (label) => {
      if (!get().online) set((s) => { s.syncQueue.push(label); });
    },
    toggleOnline: () => {
      const goingOnline = !get().online;
      if (goingOnline && get().syncQueue.length) {
        const n = get().syncQueue.length;
        set((s) => {
          s.online = true;
          s.syncQueue = [];
        });
        get().flash(n + ' offline update' + (n > 1 ? 's' : '') + ' synced to server.');
      } else {
        set((s) => { s.online = goingOnline; });
        if (!goingOnline) get().flash('Signal lost — the app keeps working, updates will queue.');
      }
    },

    // ---- team access / login ----
    accWho: (who) =>
      set((s) => {
        s.access.who = who;
        s.access.step = who === 'worker' ? 'badge' : who === 'trade' ? 'trade' : 'otp';
        if (who !== 'worker') s.access.otp = '';
      }),
    accTrade: (t) =>
      set((s) => {
        s.access.trade = t;
        s.access.step = 'otp';
        s.access.otp = '';
      }),
    otpPress: (d) => {
      const cur = get().access.otp;
      if (d === 'del') {
        set((s) => { s.access.otp = cur.slice(0, -1); });
        return;
      }
      if (cur.length >= 4) return;
      const otp = cur + d;
      set((s) => { s.access.otp = otp; });
      if (otp.length === 4) setTimeout(() => get().otpVerify(), 250);
    },
    otpVerify: () => {
      const a = get().access;
      if (a.otp.length < 4) {
        get().flash('Enter the 4-digit code.');
        return;
      }
      if (a.who === 'team') {
        set((s) => {
          s.role = 'engineer';
          s.screen = 'daily-log';
          s.access = { step: 'who', who: null, trade: null, otp: '', worker: null };
        });
        get().flash('Verified ✓ — signed in as Site Engineer.');
      } else {
        set((s) => { s.access.step = 'tradehome'; });
        get().flash('Verified ✓ — ' + a.trade + ' in-charge signed in.');
      }
    },
    pickWorker: (w) =>
      set((s) => {
        s.access.worker = w;
        s.access.step = 'jobcard';
      }),
    accReset: () => set((s) => { s.access = { step: 'who', who: null, trade: null, otp: '', worker: null }; }),
    speakJob: () => {
      const langName = { en: 'English', hi: 'Hindi', gu: 'Gujarati' }[get().lang];
      get().flash('🔊 Reading the job aloud in ' + langName + '…');
    },
    workerDone: () => {
      const w = get().access.worker;
      get().flash('✓ ' + (w ? w.name : 'Worker') + ' marked today’s work done — sent to engineer.');
      get().accReset();
    },
  })),
);
