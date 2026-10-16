/**
 * Phase 4 Task 6 correction (Codex F3) — civil "today" in the PROJECT's timezone, not the
 * browser's. The server evaluates execution readiness against `clock.today(project.timeZone)`
 * (most projects default to Asia/Kolkata), so a muster or presence read stamped with the
 * viewer's LOCAL date can land on the wrong civil day (a US browser at 20:30 on the 28th is
 * already the 29th on site). The snapshot serves `project.timeZone`; when it is unknown (local
 * demo, pre-snapshot) we fall back to the browser's local date — the pre-correction behaviour.
 */
export function todayCivil(timeZone: string | null | undefined, now: Date = new Date()): string {
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD — exactly the ISO civil date the API expects.
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch {
      /* unknown IANA zone — fall through to the browser-local date */
    }
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * #482 (Board decision D13, 16 Oct 2026) — the wall-clock time of a check-in on site, in the PROJECT's
 * timezone, as the daily log stores it ("8:12 AM"). It replaces a hard-coded "8:12 AM" that every sent log
 * carried whatever the real time was. Taken at the tap, so a check-in made with no signal keeps its own
 * time when the log is sent later. Same fallback as `todayCivil`: the browser's local clock when the
 * zone is unknown or invalid.
 */
export function checkinClock(timeZone: string | null | undefined, now: Date = new Date()): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  // newer ICU puts a narrow no-break space before AM/PM; the stored value keeps a plain space
  const plain = (t: string) => t.replace(/\s/g, ' ');
  if (timeZone) {
    try {
      return plain(new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(now));
    } catch {
      /* unknown IANA zone — fall through to the browser-local clock */
    }
  }
  return plain(new Intl.DateTimeFormat('en-US', opts).format(now));
}
