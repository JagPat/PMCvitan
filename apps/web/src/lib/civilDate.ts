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
