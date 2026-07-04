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
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import { resolveMediaUrl } from '@/data/apiGateway';

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
  // real session (set by a phone-OTP sign-in; null = passwordless dev auth)
  sessionToken: string | null;
  userName: string | null;
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
  addProgressPhoto: (dataUrl: string) => void;
  submitDailyLog: () => void;
  flagMismatch: (idx: number) => void;
  record: (label: string) => void;
  toggleOnline: () => void;
  // team access
  accWho: (who: Exclude<AccessWho, null>) => void;
  accTrade: (t: string) => void;
  accSetPhone: (v: string) => void;
  accGoLogin: () => void;
  login: (email: string, password: string) => void;
  requestOtp: () => void;
  otpPress: (d: string) => void;
  otpVerify: () => void;
  pickWorker: (w: Worker) => void;
  accReset: () => void;
  speakJob: () => void;
  workerDone: () => void;
  // API bridge (Phase 7b) — injected by useApiSync when VITE_API_URL is set
  _setGateway: (g: ApiGateway | null) => void;
  applySnapshot: (snap: ApiSnapshot) => void;
}

export type Store = AppState & AppActions;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A pristine access-flow state (used to init and to reset after sign-out). */
function freshAccess(): AccessState {
  return { step: 'who', who: null, trade: null, phone: '', otp: '', worker: null, sending: false, error: null, devCode: null };
}

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
    access: freshAccess(),
    activities: structuredClone(SEED_ACTIVITIES),
    dailyLog: structuredClone(SEED_DAILY_LOG),
    notifications: structuredClone(SEED_NOTIFICATIONS),
    sessionToken: null,
    userName: null,
    projStart: PROJECT.projStart,
    projEnd: PROJECT.projEnd,
    elapsedPct: PROJECT.elapsedPct,
    todayDay: PROJECT.todayDay,
    milestonePct: PROJECT.milestonePct,
  };
}

export const useStore = create<Store>()(
  immer((set, get) => {
    // API bridge (Phase 7b): injected by useApiSync when VITE_API_URL is set.
    // When present, mutating actions persist through the API and reconcile from
    // the returned snapshot; when null, they mutate the seeded local store.
    let gateway: ApiGateway | null = null;

    const applySnapshot = (snap: ApiSnapshot): void => {
      set((s) => {
        s.decisions = snap.decisions;
        s.activities = snap.activities;
        if (snap.checklist) s.checklist = snap.checklist;
        if (snap.review) s.review = snap.review;
        s.reinspectionCreated = snap.reinspectionCreated;
        if (snap.dailyLog) s.dailyLog = snap.dailyLog;
        s.notifications = snap.notifications;
        s.projStart = snap.project.projStart;
        s.projEnd = snap.project.projEnd;
        s.elapsedPct = snap.project.elapsedPct;
        s.todayDay = snap.project.todayDay;
        s.milestonePct = snap.project.milestonePct;
      });
    };

    const runRemote = (call: () => Promise<ApiSnapshot>, okMsg: string): void => {
      call()
        .then((snap) => {
          applySnapshot(snap);
          get().flash(okMsg);
        })
        .catch(() => get().flash('Could not reach the server — please try again.'));
    };

    return {
    ...getInitialState(),
    _setGateway: (g) => {
      gateway = g;
    },
    applySnapshot,

    // ---- shell ----
    setRole: (role) => {
      const first = screensFor(role)[0].key;
      set((s) => {
        s.role = role;
        s.screen = first;
        s.notifOpen = false;
        s.modal = { type: null };
        // an explicit persona switch is dev auth — drop any real OTP session
        s.sessionToken = null;
        s.userName = null;
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
      if (gateway) {
        set((s) => { s.modal = { type: null }; });
        runRemote(() => gateway!.approveDecision(decId, optIdx), 'Approved & locked — saved to the server.');
        return;
      }
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
      const { decId, changeText, changeCost, changeTime } = get().modal;
      if (decId == null) return;
      if (gateway) {
        const reason = changeText?.trim() || 'Change requested';
        const costImpact = parseInt(String(changeCost ?? '').replace(/[^\d-]/g, ''), 10) || 0;
        const timeImpactDays = parseInt(String(changeTime ?? '').replace(/[^\d-]/g, ''), 10) || 0;
        set((s) => { s.modal = { type: null }; });
        runRemote(() => gateway!.requestChange(decId, reason, costImpact, timeImpactDays), 'Change Request submitted for client re-approval.');
        return;
      }
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
      if (gateway) {
        runRemote(() => gateway!.submitInspection(c.id, c.items), 'Inspection submitted to the architect for review.');
        return;
      }
      set((s) => { s.checklist.submitted = true; });
      get().flash('Inspection submitted to the architect for review.');
    },

    // ---- pmc review ----
    toggleReject: (idx) => set((s) => { s.review.items[idx].rejected = !s.review.items[idx].rejected; }),
    approveInspection: () => {
      if (gateway) {
        runRemote(() => gateway!.decideReview(get().review.id, true, []), 'Inspection approved. Contractor and client notified.');
        return;
      }
      set((s) => { s.review.decided = true; });
      get().flash('Inspection approved. Contractor and client notified.');
    },
    sendReinspection: () => {
      const n = get().review.items.filter((it) => it.rejected || it.result === 'FAIL').length;
      if (n === 0) {
        get().flash('No items rejected. Use Approve Inspection instead.');
        return;
      }
      if (gateway) {
        const rejectedNames = get().review.items.filter((it) => it.rejected).map((it) => it.name);
        runRemote(() => gateway!.decideReview(get().review.id, false, rejectedNames), n + ' re-inspection task(s) created with due dates.');
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
      if (gateway) {
        runRemote(() => gateway!.startActivity(id), 'Activity started — planned dates now tracking against actual.');
        return;
      }
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
      if (gateway) {
        runRemote(() => gateway!.completeActivity(id), 'Marked complete — a closing inspection was auto-created for sign-off.');
        return;
      }
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
    addProgressPhoto: (dataUrl) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) {
        get().flash('Could not read that photo — please try again.');
        return;
      }
      const [, mime, base64] = m;
      if (gateway) {
        gateway
          .uploadMedia({ kind: 'progress', mime, data: base64 })
          .then((res) => {
            set((s) => {
              s.dailyLog.photos.unshift({ id: res.id, url: resolveMediaUrl(res.url) });
              s.dailyLog.progress += 1;
            });
            get().flash('Progress photo uploaded — geo + time stamped, visible to PMC.');
          })
          .catch(() => get().flash('Could not upload the photo — please try again.'));
        return;
      }
      // local demo: keep the data URL as the image source
      set((s) => {
        s.dailyLog.photos.unshift({ url: dataUrl });
        s.dailyLog.progress += 1;
      });
      get().record('Progress photo');
      get().flash(get().online ? 'Progress photo added — geo + time stamped.' : 'Photo saved offline — will upload when signal returns.');
    },
    submitDailyLog: () => {
      if (!get().dailyLog.checkedIn) {
        get().flash('Please check in at site before submitting the daily log.');
        return;
      }
      if (gateway) {
        const dl = get().dailyLog;
        runRemote(() => gateway!.submitDailyLog({ checkedIn: dl.checkedIn, checkinTime: dl.checkinTime, progress: dl.progress, crew: dl.crew }), 'Daily site log sent to PMC — attendance, materials & photos attached.');
        return;
      }
      set((s) => { s.dailyLog.submitted = true; });
      get().record('Daily log submit');
      get().flash(get().online ? 'Daily site log sent to PMC — attendance, materials & photos attached.' : 'Saved offline — log will upload to PMC when signal returns.');
    },
    flagMismatch: (idx) => {
      const mat = get().dailyLog.materials[idx];
      if (gateway) {
        runRemote(() => gateway!.flagMismatch(mat.decisionId), 'Mismatch flagged — PMC alerted and the linked activity is now blocked.');
        return;
      }
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
        // team → phone+OTP; trade → pick trade first; worker → tap-photo badge
        s.access.step = who === 'worker' ? 'badge' : who === 'trade' ? 'trade' : 'phone';
        s.access.otp = '';
        s.access.error = null;
        s.access.devCode = null;
      }),
    accTrade: (t) =>
      set((s) => {
        s.access.trade = t;
        s.access.step = 'phone';
        s.access.otp = '';
        s.access.error = null;
        s.access.devCode = null;
      }),
    accSetPhone: (v) =>
      set((s) => {
        s.access.phone = v.replace(/\D/g, '').slice(0, 10);
        s.access.error = null;
      }),
    accGoLogin: () =>
      set((s) => {
        s.access.step = 'login';
        s.access.error = null;
        s.access.sending = false;
      }),
    login: (email, password) => {
      const em = email.trim().toLowerCase();
      if (!em || !password) {
        set((s) => { s.access.error = 'Enter your email and password.'; });
        return;
      }
      if (gateway) {
        set((s) => { s.access.sending = true; s.access.error = null; });
        gateway
          .login(em, password)
          .then((res) => {
            set((s) => {
              s.role = res.role;
              s.screen = screensFor(res.role)[0].key;
              s.sessionToken = res.token;
              s.userName = res.name ?? null;
              s.access = freshAccess();
            });
            get().flash('Signed in as ' + (res.name ?? res.role) + '.');
          })
          .catch(() => set((s) => { s.access.sending = false; s.access.error = 'Wrong email or password.'; }));
        return;
      }
      // local demo: map the seeded demo emails to their role (any password)
      const role = em.startsWith('pmc@') ? 'pmc' : em.startsWith('client@') ? 'client' : em.startsWith('contractor@') ? 'contractor' : null;
      if (!role) {
        set((s) => { s.access.error = 'Demo: use pmc@ / client@ / contractor@vitan.in.'; });
        return;
      }
      set((s) => {
        s.role = role;
        s.screen = screensFor(role)[0].key;
        s.access = freshAccess();
      });
      get().flash('Signed in as ' + role + ' (demo).');
    },
    requestOtp: () => {
      const { phone, sending } = get().access;
      if (sending) return;
      if (phone.length < 10) {
        set((s) => { s.access.error = 'Enter a 10-digit mobile number.'; });
        return;
      }
      // local demo (no API): skip straight to the code screen
      if (!gateway) {
        set((s) => {
          s.access.step = 'otp';
          s.access.otp = '';
          s.access.error = null;
          s.access.devCode = null;
        });
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .requestOtp(phone)
        .then((r) => {
          set((s) => {
            s.access.sending = false;
            s.access.step = 'otp';
            s.access.otp = '';
            s.access.devCode = r.devCode ?? null;
          });
        })
        .catch(() => {
          set((s) => {
            s.access.sending = false;
            s.access.error = 'Could not send the code — please try again.';
          });
        });
    },
    otpPress: (d) => {
      const cur = get().access.otp;
      if (get().access.sending) return;
      if (d === 'del') {
        set((s) => { s.access.otp = cur.slice(0, -1); s.access.error = null; });
        return;
      }
      if (cur.length >= 4) return;
      const otp = cur + d;
      set((s) => { s.access.otp = otp; s.access.error = null; });
      if (otp.length === 4) setTimeout(() => get().otpVerify(), 250);
    },
    otpVerify: () => {
      const a = get().access;
      if (a.otp.length < 4 || a.sending) return;

      // team → real engineer session; trade → local scoped mistri view
      const signIn = (name: string | null, token: string | null): void => {
        if (a.who === 'team') {
          set((s) => {
            s.role = 'engineer';
            s.screen = 'daily-log';
            s.sessionToken = token;
            s.userName = name;
            s.access = freshAccess();
          });
          get().flash('Verified ✓ — signed in as Site Engineer.');
        } else {
          set((s) => { s.access.step = 'tradehome'; s.access.sending = false; });
          get().flash('Verified ✓ — ' + (a.trade ?? '') + ' in-charge signed in.');
        }
      };

      // local demo (no API): any 4-digit code signs in
      if (!gateway) {
        signIn(null, null);
        return;
      }

      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .verifyOtp(a.phone, a.otp)
        .then((res) => signIn(res.name ?? null, res.token))
        .catch(() => {
          set((s) => {
            s.access.sending = false;
            s.access.otp = '';
            s.access.error = 'Wrong or expired code — try again.';
          });
        });
    },
    pickWorker: (w) => {
      // best-effort: register the device server-side (proves the endpoint); the
      // job card is a self-contained local view either way.
      if (gateway) gateway.workerToken(w.name, w.trade).catch(() => {});
      set((s) => {
        s.access.worker = w;
        s.access.step = 'jobcard';
      });
    },
    accReset: () => set((s) => { s.access = freshAccess(); }),
    speakJob: () => {
      const langName = { en: 'English', hi: 'Hindi', gu: 'Gujarati' }[get().lang];
      get().flash('🔊 Reading the job aloud in ' + langName + '…');
    },
    workerDone: () => {
      const w = get().access.worker;
      get().flash('✓ ' + (w ? w.name : 'Worker') + ' marked today’s work done — sent to engineer.');
      get().accReset();
    },
    };
  }),
);
