import { useEffect, useRef, useState } from 'react';
import type { SiteVisit } from '@/data/apiGateway';
import { emitGuideOutcome, guidedPhotoPicksOf } from './outcomes';
import { useGuideState } from './guideState';
import { noteOwnOpenVisit } from './visitFacts';

/**
 * #482 — the visit guide's reports, from what the Site visits screen shows (its visits are the screen's own read).
 *
 * - Start visit: once a start made under the run shows as the viewer's open visit (sent, or waiting to send), it is
 *   `visit-started`; a start not taken at all (`started(false)`) is `visit-start-failed`.
 * - Add photo: a photo picked under the run is `visit-photo-added` once the server has it on the viewer's own visit: the
 *   server lists it there (`read`, even while its send still waits, its answer lost: Codex 4401864958), or it shows there
 *   and is no longer waiting to send. It is `visit-photo-add-failed` once it is listed as not sent (refused). One still
 *   waiting that the server does not list says nothing yet.
 *
 * `listed`: whether the screen's read of the visits has come back, so "no visit open" is known, not assumed.
 */
export function useVisitGuideReports(
  visits: readonly SiteVisit[], read: readonly SiteVisit[], waiting: ReadonlySet<string>, notSent: readonly { key: string }[], me: string | null, listed: boolean,
): { started: (ok: boolean, run: number) => void } {
  const mineOpen = visits.some((v) => v.visitorId === me && v.status === 'open');
  useEffect(() => { if (listed) noteOwnOpenVisit(mineOpen); }, [listed, mineOpen]);

  const [startRun, setStartRun] = useState<number | null>(null);
  useEffect(() => {
    if (startRun === null || !mineOpen) return;
    emitGuideOutcome('visit-started', null, startRun);
    setStartRun(null);
  }, [startRun, mineOpen]);

  const run = useGuideState((s) => s.run?.id ?? null);
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (run === null) return;
    for (const key of guidedPhotoPicksOf(run)) {
      if (told.current.has(key)) continue;
      if (notSent.some((p) => p.key === key)) {
        told.current.add(key);
        emitGuideOutcome('visit-photo-add-failed', null, run);
        continue;
      }
      // on the viewer's own visit, the one the guide started (a photo on a visit they are present on is not this task)
      const on = (list: readonly SiteVisit[]) =>
        list.some((v) => v.visitorId === me && (v.files ?? []).some((f) => f.clientKey === key || f.mediaId === key));
      if (on(read) || (on(visits) && !waiting.has(key))) {
        told.current.add(key);
        emitGuideOutcome('visit-photo-added', null, run);
      }
    }
  }, [run, visits, read, waiting, notSent, me]);

  return {
    started: (ok, startedUnder) => {
      if (ok) setStartRun(startedUnder);
      else emitGuideOutcome('visit-start-failed', null, startedUnder);
    },
  };
}
