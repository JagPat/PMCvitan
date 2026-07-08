import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import {
  selectPending,
  selectFailedCount,
  selectReviewPending,
  selectActiveReview,
  selectSchToday,
  gateDStateFor,
  activityReady,
  selectTotalWorkers,
  phaseRollup,
  activitiesInPhase,
} from '@/store/selectors';

const s = () => useStore.getState();
const act = (id: string) => s().activities.find((a) => a.id === id)!;

beforeEach(() => {
  useStore.setState(getInitialState());
});

describe('core decision loop: approve → lock → dashboard + gate', () => {
  it('locks the decision, decrements pending, adds a notification, and flips the linked gate', () => {
    expect(selectPending(s()).length).toBe(2);
    // ACT-31 is linked to DL-014 (pending) → Decision gate is "waiting"
    expect(gateDStateFor(s(), act('ACT-31'))).toBe('wait');
    const notifBefore = s().notifications.length;

    s().openApprove('DL-014', 1); // approve Option B (Italian Marble)
    s().confirmApprove();

    const dl014 = s().decisions.find((d) => d.id === 'DL-014')!;
    expect(dl014.status).toBe('approved');
    expect(dl014.approvedOption).toBe('Option B');
    expect(dl014.material).toBe('Italian Marble (Botticino)');
    expect(dl014.approver).toBe('Mr. Shah');
    expect(dl014.cost).toBe(140000);

    // pending count decremented 2 → 1
    expect(selectPending(s()).length).toBe(1);
    // a notification was prepended
    expect(s().notifications.length).toBe(notifBefore + 1);
    expect(s().notifications[0].text).toContain('Italian Marble');
    // the schedule Decision gate for ACT-31 is now green
    expect(gateDStateFor(s(), act('ACT-31'))).toBe('ok');
  });
});

describe('material mismatch blocks the linked activity', () => {
  it('flips the Material gate to fail and blocks ACT-31', () => {
    expect(act('ACT-31').status).toBe('not-started');
    expect(selectSchToday(s()).blocked).toBe(1); // ACT-28 seeded blocked

    // material index 0 = Italian Marble → DL-014 → ACT-31
    s().flagMismatch(0);

    expect(act('ACT-31').gm).toBe('fail');
    expect(act('ACT-31').status).toBe('blocked');
    expect(selectSchToday(s()).blocked).toBe(2);
    expect(s().notifications[0].text).toContain('Material mismatch');
  });
});

describe('activity gates gate the Start action', () => {
  it('ACT-31 becomes ready to start only after its decision is approved', () => {
    // seeded: gm/gt/gi all "wait" → not ready even ignoring decision
    expect(activityReady(s(), act('ACT-31'))).toBe(false);
  });
  it('completing an in-progress activity records the actual end and a closing-inspection notice', () => {
    s().startActivity('ACT-31');
    expect(act('ACT-31').status).toBe('in-progress');
    expect(act('ACT-31').as).toBe(s().todayDay);
    s().completeActivity('ACT-31');
    expect(act('ACT-31').status).toBe('done');
    expect(act('ACT-31').ae).toBe(s().todayDay);
    expect(s().notifications[0].text).toContain('Closing inspection auto-created');
  });
});

describe('inspection review → re-inspection', () => {
  it('failed count reflects rejected items after sending re-inspection', () => {
    // one seeded FAIL item
    expect(selectFailedCount(s())).toBe(1);
    expect(selectReviewPending(s())).toBe(1);
    // reject a PASS item too
    s().toggleReject(0);
    s().sendReinspection();
    expect(s().reinspectionCreated).toBe(true);
    expect(selectReviewPending(s())).toBe(0);
    // now counts FAIL || rejected = 2
    expect(selectFailedCount(s())).toBe(2);
  });
});

describe('checklist → review queue wiring', () => {
  it('a submitted checklist joins the PMC review queue and can be decided there', () => {
    // seeded: one pending review (the waterproofing review)
    expect(selectReviewPending(s())).toBe(1);
    const seededReviewId = s().reviews[0].id;

    // engineer marks every item pass, then submits the checklist
    s().checklist.items.forEach((_, i) => s().setItem(i, 'pass'));
    s().submitInspection();
    expect(s().checklist.submitted).toBe(true);

    // it now appears as a second pending review, its pass/fail mapped to PASS/FAIL
    expect(selectReviewPending(s())).toBe(2);
    const checklistId = s().checklist.id;
    const queued = s().reviews.find((r) => r.id === checklistId)!;
    expect(queued).toBeTruthy();
    expect(queued.items.every((it) => it.result === 'PASS')).toBe(true);

    // active defaults to the first pending (seeded); the PMC can switch to the checklist one
    expect(selectActiveReview(s())!.id).toBe(seededReviewId);
    s().setActiveReview(checklistId);
    expect(selectActiveReview(s())!.id).toBe(checklistId);

    // approving the checklist-derived review clears it from the queue
    s().approveInspection();
    expect(s().reviews.find((r) => r.id === checklistId)!.decided).toBe(true);
    expect(selectReviewPending(s())).toBe(1); // only the seeded review still pending
  });

  it('a failed checklist item maps to a FAIL result in the queued review', () => {
    s().checklist.items.forEach((_, i) => s().setItem(i, 'pass'));
    s().setItem(1, 'fail');
    s().addPhoto(1); // a failed item needs a photo to submit
    s().submitInspection();
    const queued = s().reviews.find((r) => r.id === s().checklist.id)!;
    expect(queued.items[1].result).toBe('FAIL');
  });
});

describe('drawings register', () => {
  it('issues a new drawing, then a new rev supersedes the prior', () => {
    const before = s().drawings.length;
    s().issueDrawing({ number: 'M-501', title: 'HVAC Layout', discipline: 'mep', rev: 'A', mime: 'application/pdf', data: btoa('%PDF-A') });
    expect(s().drawings.length).toBe(before + 1);
    expect(s().drawings.find((d) => d.number === 'M-501')!.current!.rev).toBe('A');

    s().issueDrawing({ number: 'M-501', title: 'HVAC Layout', discipline: 'mep', rev: 'B', mime: 'application/pdf', data: btoa('%PDF-B') });
    const d = s().drawings.find((x) => x.number === 'M-501')!;
    expect(d.current!.rev).toBe('B');
    expect(d.current!.status).toBe('for_construction');
    expect(d.revisions).toHaveLength(2);
    expect(d.revisions.find((r) => r.rev === 'A')!.status).toBe('superseded');
    expect(s().drawings.filter((x) => x.number === 'M-501')).toHaveLength(1); // same register entry
  });
});

describe('guarded inspection submit', () => {
  it('does not submit until all items are marked', () => {
    s().submitInspection();
    expect(s().checklist.submitted).toBe(false);
    expect(s().toast).toContain('mark all');
  });
  it('a failed item requires a photo before submit', () => {
    s().checklist.items.forEach((_, i) => s().setItem(i, 'pass'));
    s().setItem(2, 'fail');
    s().submitInspection();
    expect(s().checklist.submitted).toBe(false);
    expect(s().toast).toContain('photo');
    s().addPhoto(2);
    s().submitInspection();
    expect(s().checklist.submitted).toBe(true);
  });
});

describe('offline-first outbox', () => {
  it('queues mutations while offline and flushes them on reconnect', () => {
    s().toggleOnline(); // go offline
    expect(s().online).toBe(false);
    s().checkIn();
    s().addProgress();
    expect(s().syncQueue.length).toBe(2);
    s().toggleOnline(); // back online
    expect(s().online).toBe(true);
    expect(s().syncQueue.length).toBe(0);
    expect(s().toast).toContain('synced');
  });
});

describe('crew total feeds the live counts', () => {
  it('sums the crew and updates when stepped', () => {
    expect(selectTotalWorkers(s())).toBe(10);
    s().crewStep(2, 1); // electrician 0 → 1
    expect(selectTotalWorkers(s())).toBe(11);
  });
});

describe('phase monitoring (Orgs Slice 3)', () => {
  it('rolls up activities per phase from the seeded state', () => {
    const acts = s().activities;
    // Services & Waterproofing: ACT-22 done + ACT-28 blocked
    const services = phaseRollup(acts, 'PH-services');
    expect(services).toMatchObject({ activityTotal: 2, done: 1, blocked: 1, donePct: 50 });
    // Finishing: 3 activities, none started yet
    const finishing = phaseRollup(acts, 'PH-finishing');
    expect(finishing).toMatchObject({ activityTotal: 3, done: 0, notStarted: 3, donePct: 0 });
  });

  it('the rollup moves live when an activity is started/completed', () => {
    // approve DL-014 so ACT-31 (Finishing) can start, then complete it
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    s().startActivity('ACT-31');
    expect(phaseRollup(s().activities, 'PH-finishing')).toMatchObject({ inProgress: 1, done: 0 });
    s().completeActivity('ACT-31');
    expect(phaseRollup(s().activities, 'PH-finishing')).toMatchObject({ done: 1, donePct: 33 });
  });

  it('groups activities by phase and gathers the unphased remainder', () => {
    const { activities, phases } = s();
    expect(activitiesInPhase(activities, phases, 'PH-services').map((a) => a.id)).toEqual(['ACT-22', 'ACT-28']);
    // every seeded activity belongs to a phase, so the unphased bucket is empty
    expect(activitiesInPhase(activities, phases, null)).toHaveLength(0);
  });
});
