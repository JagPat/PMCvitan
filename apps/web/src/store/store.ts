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
  SEED_DRAWINGS,
  SEED_PHASES,
  PROJECT,
  type AccessState,
  type AccessWho,
  type Activity,
  type AppNotification,
  type Checklist,
  type DailyLog,
  type Decision,
  type Drawing,
  type MembershipSummary,
  type OrgSummary,
  type Phase,
  type PortfolioProject,
  type ProjectMember,
  type ItemState,
  type Lang,
  type ModalState,
  type Review,
  type Role,
  type ScreenKey,
  type Worker,
} from '@vitan/shared';
import { screensFor } from '@/lib/screens';
import type { ApiGateway, ApiSnapshot, OutboxOp, IssueDrawingInput, AddMemberInput, NewProjectInput } from '@/data/apiGateway';
import { resolveMediaUrl, replayOutboxOp, PROJECT_ID } from '@/data/apiGateway';

export interface AppState {
  role: Role;
  screen: ScreenKey;
  lang: Lang;
  notifOpen: boolean;
  toast: string | null;
  modal: ModalState;
  decisions: Decision[];
  checklist: Checklist;
  reviews: Review[]; // the PMC review queue (submitted, undecided inspections)
  activeReviewId: string | null; // which queued review the PMC is looking at (null ⇒ first pending)
  reinspectionCreated: boolean;
  drawings: Drawing[]; // the drawings register (Slice 1)
  phases: Phase[]; // project phases with rollups (Orgs Slice 3)
  // multi-project (Orgs Slice 2)
  activeProjectId: string; // the project the session is scoped to
  memberships: MembershipSummary[]; // projects the user can switch between
  myOrgs: OrgSummary[]; // orgs the user administers/belongs to
  members: ProjectMember[]; // the active project's team (Team screen)
  portfolio: PortfolioProject[]; // cross-project monitoring rollup (Orgs Slice 3)
  online: boolean;
  syncQueue: string[];
  outbox: OutboxOp[];
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
  signOut: () => void;
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
  setActiveReview: (id: string) => void;
  toggleReject: (idx: number) => void;
  approveInspection: () => void;
  sendReinspection: () => void;
  // drawings register
  issueDrawing: (input: IssueDrawingInput) => void;
  // multi-project + team
  loadOrgData: () => void;
  loadPortfolio: () => void;
  switchProject: (projectId: string) => void;
  createProject: (orgId: string, input: NewProjectInput) => void;
  loadTeam: () => void;
  addMember: (input: AddMemberInput) => void;
  updateMemberRole: (userId: string, role: Role) => void;
  removeMember: (userId: string) => void;
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
  flushOutbox: () => void;
  hydrateOutbox: () => void;
  // team access
  accWho: (who: Exclude<AccessWho, null>) => void;
  accTrade: (t: string) => void;
  accSetPhone: (v: string) => void;
  accGoLogin: () => void;
  login: (email: string, password: string) => void;
  accSetEmail: (v: string) => void;
  accGoEmailOtp: () => void;
  requestEmailOtp: () => void;
  accSetCode: (v: string) => void;
  emailOtpVerify: () => void;
  googleSignIn: (idToken: string) => void;
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
  return { step: 'who', who: null, trade: null, phone: '', email: '', otp: '', worker: null, sending: false, error: null, devCode: null };
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
    reviews: [structuredClone(SEED_REVIEW)],
    activeReviewId: null,
    reinspectionCreated: false,
    drawings: structuredClone(SEED_DRAWINGS),
    phases: structuredClone(SEED_PHASES),
    activeProjectId: PROJECT_ID,
    memberships: [],
    myOrgs: [],
    members: [],
    portfolio: [],
    online: true,
    syncQueue: [],
    outbox: [],
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
        s.reviews = snap.reviews ?? (snap.review ? [snap.review] : []);
        if (s.activeReviewId && !s.reviews.some((r) => r.id === s.activeReviewId)) s.activeReviewId = null;
        s.reinspectionCreated = snap.reinspectionCreated;
        if (snap.drawings) s.drawings = snap.drawings;
        if (snap.phases) s.phases = snap.phases;
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

    const OUTBOX_KEY = 'vitan.outbox';
    const persistOutbox = (): void => {
      try {
        globalThis.localStorage?.setItem(OUTBOX_KEY, JSON.stringify(get().outbox));
      } catch {
        /* storage unavailable — the in-session outbox still works */
      }
    };

    /**
     * Route a mutation through the gateway when online, or queue it (Phase 8
     * offline outbox) when offline. Returns true when the action was handled
     * here (remote or queued); false means "no gateway — do the local mutation".
     */
    const runRemoteOrQueue = (
      op: OutboxOp,
      label: string,
      call: () => Promise<ApiSnapshot>,
      okMsg: string,
    ): boolean => {
      if (!gateway) return false;
      if (get().online) {
        runRemote(call, okMsg);
        return true;
      }
      set((s) => {
        s.outbox.push(op);
        s.syncQueue.push(label);
      });
      persistOutbox();
      get().flash(label + ' — saved offline, will sync when you reconnect.');
      return true;
    };

    /** Adopt a server auth result as the real session (used by email-OTP + Google). */
    const applyAuthResult = (res: { role: Role; token: string; name?: string }): void => {
      set((s) => {
        s.role = res.role;
        s.screen = screensFor(res.role)[0].key;
        s.sessionToken = res.token;
        s.userName = res.name ?? null;
        s.access = freshAccess();
      });
      get().flash('Signed in as ' + (res.name ?? res.role) + '.');
    };

    /** Local-demo passwordless sign-in: map an email to a role (else engineer). */
    const localEmailSignIn = (em: string): void => {
      const role: Role = em.startsWith('pmc@') ? 'pmc' : em.startsWith('client@') ? 'client' : em.startsWith('contractor@') ? 'contractor' : 'engineer';
      set((s) => {
        s.role = role;
        s.screen = screensFor(role)[0].key;
        s.access = freshAccess();
      });
      get().flash('Signed in as ' + role + ' (demo).');
    };

    /** Index in `reviews` of the review the PMC is acting on: the explicitly
     *  selected one, else the first pending, else the first. -1 when the queue is empty. */
    const activeReviewIdx = (): number => {
      const st = get();
      if (!st.reviews.length) return -1;
      const byId = st.activeReviewId ? st.reviews.findIndex((r) => r.id === st.activeReviewId) : -1;
      if (byId >= 0) return byId;
      const pending = st.reviews.findIndex((r) => !r.decided);
      return pending >= 0 ? pending : 0;
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
    /**
     * End the real session and return to the sign-in screen. Clears the token,
     * resets the access flow to 'who', and drops back to a neutral role/screen.
     * With dev auth off, the AppShell auth-gate then shows the sign-in screen.
     */
    signOut: () =>
      set((s) => {
        s.sessionToken = null;
        s.userName = null;
        s.access = freshAccess();
        s.role = 'client';
        s.screen = screensFor('client')[0].key;
        s.notifOpen = false;
        s.modal = { type: null };
      }),
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
      set((s) => { s.modal = { type: null }; });
      if (runRemoteOrQueue({ t: 'approve', decisionId: decId, optionIndex: optIdx }, 'Approve ' + decId, () => gateway!.approveDecision(decId, optIdx), 'Approved & locked — saved to the server.')) return;
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
      const reason = changeText?.trim() || 'Change requested';
      const costImpact = parseInt(String(changeCost ?? '').replace(/[^\d-]/g, ''), 10) || 0;
      const timeImpactDays = parseInt(String(changeTime ?? '').replace(/[^\d-]/g, ''), 10) || 0;
      set((s) => { s.modal = { type: null }; });
      if (runRemoteOrQueue({ t: 'change', decisionId: decId, reason, costImpact, timeImpactDays }, 'Change ' + decId, () => gateway!.requestChange(decId, reason, costImpact, timeImpactDays), 'Change Request submitted for client re-approval.')) return;
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
      if (runRemoteOrQueue({ t: 'submitInspection', inspectionId: c.id, items: c.items }, 'Submit inspection', () => gateway!.submitInspection(c.id, c.items), 'Inspection submitted to the architect for review.')) return;
      set((s) => {
        s.checklist.submitted = true;
        // demo (no API): the submitted checklist enters the PMC review queue,
        // mapping each item's pass/fail state to a PASS/FAIL result.
        if (!s.reviews.some((r) => r.id === s.checklist.id)) {
          s.reviews.push({
            id: s.checklist.id,
            title: s.checklist.title,
            zone: s.checklist.zone,
            by: 'Site Engineer',
            date: s.checklist.date,
            decided: false,
            items: s.checklist.items.map((it) => ({
              name: it.name,
              result: it.state === 'fail' ? 'FAIL' : 'PASS',
              swatch: 'concrete',
              note: it.note,
              rejected: false,
            })),
          });
        }
      });
      get().flash('Inspection submitted to the architect for review.');
    },

    // ---- pmc review (queue) ----
    setActiveReview: (id) => set((s) => { s.activeReviewId = id; }),
    toggleReject: (idx) =>
      set((s) => {
        const i = activeReviewIdx();
        if (i < 0) return;
        s.reviews[i].items[idx].rejected = !s.reviews[i].items[idx].rejected;
      }),
    approveInspection: () => {
      const i = activeReviewIdx();
      if (i < 0) return;
      const review = get().reviews[i];
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: true, rejectedItemNames: [] }, 'Approve inspection', () => gateway!.decideReview(review.id, true, []), 'Inspection approved. Contractor and client notified.')) return;
      set((s) => {
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) s.reviews[j].decided = true;
        s.activeReviewId = review.id; // keep the just-decided review on screen (REVIEWED)
      });
      get().flash('Inspection approved. Contractor and client notified.');
    },
    sendReinspection: () => {
      const i = activeReviewIdx();
      if (i < 0) return;
      const review = get().reviews[i];
      const n = review.items.filter((it) => it.rejected || it.result === 'FAIL').length;
      if (n === 0) {
        get().flash('No items rejected. Use Approve Inspection instead.');
        return;
      }
      const rejectedNames = review.items.filter((it) => it.rejected).map((it) => it.name);
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: false, rejectedItemNames: rejectedNames }, 'Send re-inspection', () => gateway!.decideReview(review.id, false, rejectedNames), n + ' re-inspection task(s) created with due dates.')) return;
      set((s) => {
        s.reinspectionCreated = true;
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) s.reviews[j].decided = true;
        s.activeReviewId = review.id;
      });
      get().flash(n + ' re-inspection task(s) created with due dates.');
    },

    // ---- drawings register ----
    issueDrawing: (input) => {
      if (gateway) {
        gateway
          .issueDrawing(input)
          .then(() => {
            get().flash(`Drawing issued: ${input.number} Rev ${input.rev} — team notified.`);
            gateway!.snapshot().then((snap) => applySnapshot(snap)).catch(() => {});
          })
          .catch(() => get().flash('Could not issue the drawing — please try again.'));
        return;
      }
      // local demo: add to the register (or add a rev + supersede the prior)
      set((s) => {
        const newRev = {
          id: `${input.number}-${input.rev}`,
          rev: input.rev,
          status: input.status ?? 'for_construction',
          mime: input.mime,
          url: `data:${input.mime};base64,${input.data}`,
          sizeBytes: Math.floor((input.data.length * 3) / 4),
          note: input.note ?? '',
          issuedBy: 'You (demo)',
          issuedAt: 'just now',
        };
        const existing = s.drawings.find((d) => d.number === input.number);
        if (existing) {
          existing.revisions.forEach((r) => { if (r.status !== 'superseded') r.status = 'superseded'; });
          existing.revisions.unshift(newRev);
          existing.current = newRev;
          existing.title = input.title;
          existing.discipline = input.discipline;
        } else {
          s.drawings.unshift({
            id: `DWG-${s.drawings.length + 1}`,
            number: input.number,
            title: input.title,
            discipline: input.discipline,
            zone: input.zone ?? null,
            activityId: input.activityId ?? null,
            decisionId: input.decisionId ?? null,
            current: newRev,
            revisions: [newRev],
          });
        }
      });
      get().flash(`Drawing issued: ${input.number} Rev ${input.rev} (demo).`);
    },

    // ---- multi-project + team (Orgs Slice 2) ----
    loadOrgData: () => {
      if (!gateway) return;
      gateway.listMemberships().then((ms) => set((s) => { s.memberships = ms; })).catch(() => {});
      gateway.myOrgs().then((os) => set((s) => { s.myOrgs = os; })).catch(() => {});
    },
    loadPortfolio: () => {
      if (!gateway) return;
      gateway.getPortfolio().then((p) => set((s) => { s.portfolio = p; })).catch(() => {});
    },
    switchProject: (projectId) => {
      if (!gateway || projectId === get().activeProjectId) return;
      const short = get().memberships.find((m) => m.projectId === projectId)?.short ?? 'project';
      gateway
        .switchProject(projectId)
        .then((res) => {
          // new token + project → useApiSync re-inits the gateway and refetches
          set((s) => {
            s.sessionToken = res.token;
            s.activeProjectId = projectId;
            s.role = res.role;
            s.screen = screensFor(res.role)[0].key;
            s.members = [];
          });
          get().flash('Switched to ' + short + '.');
        })
        .catch(() => get().flash('Could not switch project — please try again.'));
    },
    createProject: (orgId, input) => {
      if (!gateway) {
        get().flash('Creating projects needs the server.');
        return;
      }
      gateway
        .createProject(orgId, input)
        .then((p) => {
          get().flash('Project created: ' + p.short + '.');
          get().loadOrgData();
          get().switchProject(p.id);
        })
        .catch(() => get().flash('Could not create the project — check your access.'));
    },
    loadTeam: () => {
      if (!gateway) return;
      gateway.listMembers().then((m) => set((s) => { s.members = m; })).catch(() => {});
    },
    addMember: (input) => {
      if (!gateway) {
        get().flash('Managing the team needs the server.');
        return;
      }
      gateway
        .addMember(input)
        .then(() => { get().loadTeam(); get().flash(input.name + ' added to the team.'); })
        .catch(() => get().flash('Could not add the member — check the details / your access.'));
    },
    updateMemberRole: (userId, role) => {
      if (!gateway) return;
      gateway.updateMemberRole(userId, role).then(() => get().loadTeam()).catch(() => get().flash('Could not change the role.'));
    },
    removeMember: (userId) => {
      if (!gateway) return;
      gateway.removeMember(userId).then(() => { get().loadTeam(); get().flash('Member removed.'); }).catch(() => get().flash('Could not remove the member.'));
    },

    // ---- schedule ----
    startActivity: (id) => {
      if (runRemoteOrQueue({ t: 'startActivity', activityId: id }, 'Start ' + id, () => gateway!.startActivity(id), 'Activity started — planned dates now tracking against actual.')) return;
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
      if (runRemoteOrQueue({ t: 'completeActivity', activityId: id }, 'Complete ' + id, () => gateway!.completeActivity(id), 'Marked complete — a closing inspection was auto-created for sign-off.')) return;
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
        const input = { kind: 'progress' as const, mime, data: base64 };
        // Phase 8 media offline queue: when offline, show the photo optimistically
        // (local data URL) and queue the upload for replay on reconnect — instead
        // of losing it. Mirrors runRemoteOrQueue for the JSON mutations.
        if (!get().online) {
          set((s) => {
            s.outbox.push({ t: 'uploadMedia', input });
            s.syncQueue.push('Progress photo');
            s.dailyLog.photos.unshift({ url: dataUrl });
            s.dailyLog.progress += 1;
          });
          persistOutbox();
          get().flash('Photo saved offline — will upload when signal returns.');
          return;
        }
        gateway
          .uploadMedia(input)
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
      const dl = get().dailyLog;
      const logPayload = { checkedIn: dl.checkedIn, checkinTime: dl.checkinTime, progress: dl.progress, crew: dl.crew };
      if (runRemoteOrQueue({ t: 'submitDailyLog', log: logPayload }, 'Submit daily log', () => gateway!.submitDailyLog(logPayload), 'Daily site log sent to PMC — attendance, materials & photos attached.')) return;
      set((s) => { s.dailyLog.submitted = true; });
      get().record('Daily log submit');
      get().flash(get().online ? 'Daily site log sent to PMC — attendance, materials & photos attached.' : 'Saved offline — log will upload to PMC when signal returns.');
    },
    flagMismatch: (idx) => {
      const mat = get().dailyLog.materials[idx];
      if (runRemoteOrQueue({ t: 'flagMismatch', decisionId: mat.decisionId }, 'Flag ' + mat.decisionId, () => gateway!.flagMismatch(mat.decisionId), 'Mismatch flagged — PMC alerted and the linked activity is now blocked.')) return;
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
      set((s) => { s.online = goingOnline; });
      if (!goingOnline) {
        get().flash('Signal lost — the app keeps working, updates will queue.');
        return;
      }
      // back online: replay queued API mutations (Phase 8 outbox); else clear demo labels
      if (get().outbox.length) {
        get().flushOutbox();
        return;
      }
      if (get().syncQueue.length) {
        const n = get().syncQueue.length;
        set((s) => { s.syncQueue = []; });
        get().flash(n + ' offline update' + (n > 1 ? 's' : '') + ' synced to server.');
      }
    },
    flushOutbox: () => {
      const ops = get().outbox.slice();
      if (!gateway || ops.length === 0) return;
      const n = ops.length;
      ops
        .reduce<Promise<ApiSnapshot | null>>(
          (chain, op) => chain.then(() => replayOutboxOp(gateway!, op)),
          Promise.resolve<ApiSnapshot | null>(null),
        )
        .then((snap) => {
          set((s) => {
            s.outbox = [];
            s.syncQueue = [];
          });
          persistOutbox();
          if (snap) applySnapshot(snap);
          get().flash(n + ' offline update' + (n > 1 ? 's' : '') + ' synced to server.');
        })
        .catch(() => get().flash('Some offline updates could not sync yet — will retry when you reconnect.'));
    },
    hydrateOutbox: () => {
      try {
        const raw = globalThis.localStorage?.getItem(OUTBOX_KEY);
        if (!raw) return;
        const ops = JSON.parse(raw) as OutboxOp[];
        if (Array.isArray(ops) && ops.length) set((s) => { s.outbox = ops; });
      } catch {
        /* ignore malformed storage */
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
    accSetEmail: (v) =>
      set((s) => { s.access.email = v; s.access.error = null; }),
    accGoEmailOtp: () =>
      set((s) => {
        s.access.step = 'emailentry';
        s.access.otp = '';
        s.access.error = null;
        s.access.devCode = null;
        s.access.sending = false;
      }),
    requestEmailOtp: () => {
      const email = get().access.email.trim().toLowerCase();
      if (get().access.sending) return;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        set((s) => { s.access.error = 'Enter a valid email address.'; });
        return;
      }
      if (!gateway) {
        set((s) => { s.access.step = 'emailcode'; s.access.otp = ''; s.access.error = null; s.access.devCode = null; });
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .emailOtpRequest(email)
        .then((r) => {
          set((s) => {
            s.access.sending = false;
            s.access.step = 'emailcode';
            s.access.otp = '';
            s.access.devCode = r.devCode ?? null;
          });
        })
        .catch(() => set((s) => { s.access.sending = false; s.access.error = 'Could not send the code — please try again.'; }));
    },
    accSetCode: (v) =>
      set((s) => { s.access.otp = v.replace(/\D/g, '').slice(0, 6); s.access.error = null; }),
    emailOtpVerify: () => {
      const { email, otp, sending } = get().access;
      if (otp.length < 4 || sending) return;
      if (!gateway) {
        localEmailSignIn(email.trim().toLowerCase());
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .emailOtpVerify(email.trim().toLowerCase(), otp)
        .then((res) => applyAuthResult(res))
        .catch(() => set((s) => { s.access.sending = false; s.access.otp = ''; s.access.error = 'Wrong or expired code — try again.'; }));
    },
    googleSignIn: (idToken) => {
      if (!gateway) {
        get().flash('Google sign-in needs the server — not available in the local demo.');
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .googleSignIn(idToken)
        .then((res) => applyAuthResult(res))
        .catch(() => set((s) => { s.access.sending = false; s.access.error = 'Google sign-in failed — please try again.'; }));
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
